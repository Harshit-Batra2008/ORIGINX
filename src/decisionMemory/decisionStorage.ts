/**
 * GitWhisper Decision Memory — Durable Repository Storage Engine
 * Manages Markdown + YAML Frontmatter files under <repoRoot>/.gitwhisper/decisions/
 * Hardened with cryptographic IDs, atomic writes, symlink protection, and optimistic concurrency.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { memoryDirectory, memoryRecordPath } from '../security/repositoryFiles';
import {
  CreateDecisionInput,
  DecisionMemoryRecord,
  DecisionSearchQuery,
  DecisionSearchResult,
  DecisionStatus,
  DisputeDecisionInput,
  UpdateDecisionInput,
  VerifyDecisionInput
} from './decisionTypes';
import { parseDecisionFromMarkdown, serializeDecisionToMarkdown } from './decisionSerializer';
import {
  DecisionValidationError,
  validateDecisionId,
  validateDecisionRecord,
  WINDOWS_RESERVED_NAMES
} from './decisionValidator';

export class DecisionStorageError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[DecisionMemory Storage] ${message}`);
    this.name = 'DecisionStorageError';
  }
}

/**
 * Generates a collision-resistant unique Decision ID using Node.js cryptographic randomness.
 * Format: DEC-YYYYMMDD-<16 hex chars (64 bits of entropy)>
 * Example: DEC-20261122-8A4F1C2B9D3E7F01
 */
export function generateDecisionId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const datePrefix = `${year}${month}${day}`;

  // 64 bits (8 bytes = 16 hex chars) of cryptographically secure random bytes
  const randomSuffix = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `DEC-${datePrefix}-${randomSuffix}`;
}

/**
 * Resolves and validates the .gitwhisper/decisions directory inside repoRoot.
 * Prevents directory escape through symlinks or junctions.
 */
export function getDecisionsDir(repoRoot: string): string {
  return memoryDirectory(repoRoot, 'decisions', DecisionStorageError);
}

export function getDecisionFilePath(repoRoot: string, id: string): string {
  return memoryRecordPath(getDecisionsDir(repoRoot), validateDecisionId(id), DecisionStorageError);
}

/**
 * Safely writes file contents atomically via a temporary file with optimistic concurrency validation.
 */
function atomicWriteFile(targetPath: string, content: string, expectedMtimeMs?: number): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Safety: If target already exists, verify it is a regular file
  if (fs.existsSync(targetPath)) {
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      throw new DecisionStorageError(
        `Target path is an unsafe symbolic link: "${targetPath}"`,
        'UNSAFE_SYMLINK'
      );
    }
    if (lstat.isDirectory()) {
      throw new DecisionStorageError(
        `Target path is an existing directory: "${targetPath}"`,
        'INVALID_TARGET'
      );
    }

    // Optimistic concurrency check: ensure file was not modified concurrently
    if (expectedMtimeMs !== undefined && Math.abs(lstat.mtimeMs - expectedMtimeMs) > 1) {
      throw new DecisionStorageError(
        `Concurrent modification detected: Decision file "${path.basename(targetPath)}" was updated on disk by another process since it was loaded.`,
        'CONCURRENT_MODIFICATION'
      );
    }
  }

  // Generate unique atomic temporary path
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${Date.now()}-${randomSuffix}`);

  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw err;
  }
}

export class DecisionStorage {
  /**
   * Creates a new DecisionMemoryRecord and saves it to disk.
   * Enforces that newly created records cannot be pre-verified; verification requires
   * the explicit verifyDecision() lifecycle API.
   */
  public async createDecision(
    repoRoot: string,
    input: CreateDecisionInput
  ): Promise<DecisionMemoryRecord> {
    // Prohibit pre-verified creation
    if ((input as any).status === 'verified') {
      throw new DecisionValidationError(
        'Decisions cannot be created directly in "verified" status. Create the record as "proposed", then use the explicit verifyDecision() API to record human review.',
        'status'
      );
    }

    let id: string;
    let filePath: string;

    if (input.id) {
      id = input.id.trim();
      filePath = getDecisionFilePath(repoRoot, id);
      if (fs.existsSync(filePath)) {
        throw new DecisionStorageError(`Decision record with ID "${id}" already exists`, 'ALREADY_EXISTS');
      }
    } else {
      // Cryptographically collision-resistant generation with retry check
      let attempts = 0;
      do {
        id = generateDecisionId();
        filePath = getDecisionFilePath(repoRoot, id);
        attempts++;
      } while (fs.existsSync(filePath) && attempts < 5);

      if (fs.existsSync(filePath)) {
        throw new DecisionStorageError(
          'Failed to generate unique decision ID after multiple attempts',
          'COLLISION'
        );
      }
    }

    const now = new Date().toISOString();

    // AI-created decisions strictly default to 'proposed'
    let status: DecisionStatus = input.status || 'proposed';
    if (input.createdBy.type === 'ai_assistant') {
      status = 'proposed';
    }

    // Default hasDirectGitEvidence based on evidence items if not explicitly specified
    const hasEvidence = input.hasDirectGitEvidence !== undefined
      ? input.hasDirectGitEvidence
      : Boolean(input.evidence && input.evidence.length > 0);

    const record: DecisionMemoryRecord = {
      id,
      schemaVersion: '1.0.0',
      title: input.title.trim(),
      rationale: input.rationale.trim(),
      primaryAnchor: {
        filePath: input.primaryAnchor.filePath.replace(/\\/g, '/').trim(),
        symbolName: input.primaryAnchor.symbolName,
        startLine: input.primaryAnchor.startLine,
        endLine: input.primaryAnchor.endLine,
        contentHash: input.primaryAnchor.contentHash,
        contextSnippet: input.primaryAnchor.contextSnippet
      },
      relatedFiles: input.relatedFiles || [],
      evidence: input.evidence || [],
      hasDirectGitEvidence: hasEvidence,
      constraints: input.constraints || [],
      status,
      freshness: input.freshness || 'current',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      tags: input.tags || []
    };

    validateDecisionRecord(record);

    const markdown = serializeDecisionToMarkdown(record);
    atomicWriteFile(filePath, markdown);

    return record;
  }

  /**
   * Retrieves a DecisionMemoryRecord by its ID. Returns null if not found.
   */
  public async getDecision(repoRoot: string, id: string): Promise<DecisionMemoryRecord | null> {
    const filePath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return parseDecisionFromMarkdown(content, id);
    } catch (err) {
      if (err instanceof DecisionValidationError) {
        throw err;
      }
      throw new DecisionStorageError(`Failed to read decision "${id}": ${err}`, 'READ_FAILED');
    }
  }

  /**
   * Lists all valid DecisionMemoryRecords stored in the repository.
   * Corrupted or unsupported files are skipped gracefully during listing.
   */
  public async listDecisions(
    repoRoot: string,
    filter?: {
      status?: DecisionStatus | DecisionStatus[];
      filePath?: string;
      tag?: string;
    }
  ): Promise<DecisionMemoryRecord[]> {
    const dir = getDecisionsDir(repoRoot);
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir, { withFileTypes: true });
    const records: DecisionMemoryRecord[] = [];

    for (const entry of files) {
      const file = entry.name;
      if (!entry.isFile() || !file.endsWith('.md') || file.startsWith('.tmp-')) {
        continue;
      }

      try {
        const record = await this.getDecision(repoRoot, file.slice(0, -3));
        if (!record) continue;

        // Apply filters
        if (filter?.status) {
          const allowed = Array.isArray(filter.status) ? filter.status : [filter.status];
          if (!allowed.includes(record.status)) continue;
        }

        if (filter?.filePath) {
          const target = filter.filePath.replace(/\\/g, '/').toLowerCase();
          const primaryMatches = record.primaryAnchor.filePath.toLowerCase() === target;
          const relatedMatches = record.relatedFiles.some((rf) => rf.filePath.toLowerCase() === target);
          if (!primaryMatches && !relatedMatches) continue;
        }

        if (filter?.tag) {
          const targetTag = filter.tag.toLowerCase();
          const tagMatches = record.tags.some((t) => t.toLowerCase() === targetTag);
          if (!tagMatches) continue;
        }

        records.push(record);
      } catch (err) {
        // Corrupted file ignored gracefully during list
        console.warn(`[DecisionMemory] Skipping invalid decision file "${file}"`);
      }
    }

    // Sort by createdAt descending (newest first)
    return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * Updates an existing decision with partial changes.
   * Prohibits directly impersonating verification; verifyDecision() must be used instead.
   */
  public async updateDecision(
    repoRoot: string,
    id: string,
    changes: UpdateDecisionInput
  ): Promise<DecisionMemoryRecord> {
    if ((changes as any).status === 'verified') {
      throw new DecisionStorageError(
        'Directly setting status to "verified" via updateDecision is prohibited. Use verifyDecision() to record human verification.',
        'VERIFICATION_API_REQUIRED'
      );
    }
    if ((changes as any).verifiedBy !== undefined) {
      throw new DecisionStorageError(
        'Directly modifying verifiedBy via updateDecision is prohibited. Use verifyDecision() to record human verification.',
        'VERIFICATION_API_REQUIRED'
      );
    }

    const targetPath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(targetPath)) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const fileStat = fs.lstatSync(targetPath);
    const existing = await this.getDecision(repoRoot, id);
    if (!existing) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const now = new Date().toISOString();

    const updated: DecisionMemoryRecord = {
      ...existing,
      title: changes.title !== undefined ? changes.title.trim() : existing.title,
      rationale: changes.rationale !== undefined ? changes.rationale.trim() : existing.rationale,
      primaryAnchor: {
        ...existing.primaryAnchor,
        ...(changes.primaryAnchor || {})
      },
      relatedFiles: changes.relatedFiles !== undefined ? changes.relatedFiles : existing.relatedFiles,
      evidence: changes.evidence !== undefined ? changes.evidence : existing.evidence,
      hasDirectGitEvidence: changes.hasDirectGitEvidence !== undefined ? changes.hasDirectGitEvidence : existing.hasDirectGitEvidence,
      constraints: changes.constraints !== undefined ? changes.constraints : existing.constraints,
      status: changes.status !== undefined ? changes.status : existing.status,
      freshness: changes.freshness !== undefined ? changes.freshness : existing.freshness,
      tags: changes.tags !== undefined ? changes.tags : existing.tags,
      supersededById: changes.supersededById !== undefined ? changes.supersededById : existing.supersededById,
      updatedAt: now
    };

    validateDecisionRecord(updated);

    const markdown = serializeDecisionToMarkdown(updated);
    atomicWriteFile(targetPath, markdown, fileStat.mtimeMs);

    return updated;
  }

  /**
   * Explicit human verification lifecycle operation.
   * Records human verifier attribution and verification timestamp.
   */
  public async verifyDecision(
    repoRoot: string,
    id: string,
    verifier: VerifyDecisionInput
  ): Promise<DecisionMemoryRecord> {
    if (!verifier || !verifier.verifierName || verifier.verifierName.trim().length === 0) {
      throw new DecisionValidationError('Verifier name is required to verify a decision', 'verifierName');
    }

    const targetPath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(targetPath)) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const fileStat = fs.lstatSync(targetPath);
    const existing = await this.getDecision(repoRoot, id);
    if (!existing) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    if (existing.status === 'retired') {
      throw new DecisionStorageError(`Cannot verify a retired decision "${id}"`, 'RETIRED');
    }

    const now = new Date().toISOString();
    const updated: DecisionMemoryRecord = {
      ...existing,
      status: 'verified',
      verifiedBy: {
        name: verifier.verifierName.trim(),
        email: verifier.verifierEmail ? verifier.verifierEmail.trim() : undefined,
        type: 'human'
      },
      verificationNote: verifier.verificationNote ? verifier.verificationNote.trim() : undefined,
      verifiedAt: now,
      updatedAt: now
    };

    validateDecisionRecord(updated);

    const markdown = serializeDecisionToMarkdown(updated);
    atomicWriteFile(targetPath, markdown, fileStat.mtimeMs);

    return updated;
  }

  /**
   * Explicit dispute lifecycle operation.
   * Transitions status to 'disputed' to flag obsolete or questionable decisions.
   */
  public async disputeDecision(
    repoRoot: string,
    id: string,
    disputer: DisputeDecisionInput
  ): Promise<DecisionMemoryRecord> {
    if (!disputer || !disputer.reason || disputer.reason.trim().length === 0) {
      throw new DecisionValidationError('Dispute reason is required', 'reason');
    }

    const targetPath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(targetPath)) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const fileStat = fs.lstatSync(targetPath);
    const existing = await this.getDecision(repoRoot, id);
    if (!existing) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const now = new Date().toISOString();
    const updated: DecisionMemoryRecord = {
      ...existing,
      status: 'disputed',
      updatedAt: now
    };

    validateDecisionRecord(updated);

    const markdown = serializeDecisionToMarkdown(updated);
    atomicWriteFile(targetPath, markdown, fileStat.mtimeMs);

    return updated;
  }

  /**
   * Retires a decision while strictly preserving its record history and rationale.
   */
  public async retireDecision(
    repoRoot: string,
    id: string,
    reason: string
  ): Promise<DecisionMemoryRecord> {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new DecisionStorageError('Retirement reason is required to retire a decision', 'REASON_REQUIRED');
    }

    const targetPath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(targetPath)) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const fileStat = fs.lstatSync(targetPath);
    const existing = await this.getDecision(repoRoot, id);
    if (!existing) {
      throw new DecisionStorageError(`Decision "${id}" not found`, 'NOT_FOUND');
    }

    const now = new Date().toISOString();
    const updated: DecisionMemoryRecord = {
      ...existing,
      status: 'retired',
      retiredAt: now,
      retirementReason: reason.trim(),
      updatedAt: now
    };

    validateDecisionRecord(updated);

    const markdown = serializeDecisionToMarkdown(updated);
    atomicWriteFile(targetPath, markdown, fileStat.mtimeMs);

    return updated;
  }

  /**
   * Permanently deletes a decision file. Requires explicit confirmDestructive flag.
   */
  public async deleteDecision(
    repoRoot: string,
    id: string,
    confirmDestructive: boolean = false
  ): Promise<boolean> {
    if (!confirmDestructive) {
      throw new DecisionStorageError(
        'Permanent deletion requires explicit confirmDestructive: true. For deprecating decisions, use retireDecision() instead.',
        'CONFIRMATION_REQUIRED'
      );
    }

    const targetPath = getDecisionFilePath(repoRoot, id);
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    // Safety: Verify file is not a symlink before unlinking
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      throw new DecisionStorageError(
        `Target file "${id}" is a symbolic link. Deletion refused for safety.`,
        'UNSAFE_SYMLINK'
      );
    }

    try {
      fs.unlinkSync(targetPath);
      return true;
    } catch (err) {
      throw new DecisionStorageError(`Failed to delete decision "${id}": ${err}`, 'DELETE_FAILED');
    }
  }

  /**
   * Searches decisions by text query, file path, status, freshness, and tags.
   */
  public async searchDecisions(
    repoRoot: string,
    query: DecisionSearchQuery
  ): Promise<DecisionSearchResult[]> {
    const all = await this.listDecisions(repoRoot);
    const results: DecisionSearchResult[] = [];

    const queryText = (query.text || '').trim().toLowerCase();
    const queryFilePath = (query.filePath || '').replace(/\\/g, '/').trim().toLowerCase();
    const queryTag = (query.tag || '').trim().toLowerCase();

    for (const record of all) {
      let score = 0;
      const matchedFields: string[] = [];

      // Status filter
      if (query.status) {
        const allowed = Array.isArray(query.status) ? query.status : [query.status];
        if (!allowed.includes(record.status)) continue;
      }

      // Freshness filter
      if (query.freshness) {
        const allowed = Array.isArray(query.freshness) ? query.freshness : [query.freshness];
        if (!allowed.includes(record.freshness)) continue;
      }

      // Evidence filter
      if (query.hasEvidence !== undefined) {
        if (record.hasDirectGitEvidence !== query.hasEvidence) continue;
      }

      // Tag filter
      if (queryTag) {
        const match = record.tags.some((t) => t.toLowerCase() === queryTag);
        if (!match) continue;
        score += 20;
        matchedFields.push('tag');
      }

      // File path filter
      if (queryFilePath) {
        let fileMatch = false;
        if (record.primaryAnchor.filePath.toLowerCase() === queryFilePath) {
          fileMatch = true;
          score += 30;
          matchedFields.push('primaryAnchor.filePath');
        } else if (record.relatedFiles.some((rf) => rf.filePath.toLowerCase() === queryFilePath)) {
          fileMatch = true;
          score += 15;
          matchedFields.push('relatedFiles.filePath');
        }
        if (!fileMatch) continue;
      }

      // Free text search
      if (queryText) {
        let textMatched = false;

        // Title match
        if (record.title.toLowerCase().includes(queryText)) {
          score += 25;
          matchedFields.push('title');
          textMatched = true;
        }

        // Rationale match
        if (record.rationale.toLowerCase().includes(queryText)) {
          score += 15;
          matchedFields.push('rationale');
          textMatched = true;
        }

        // Constraints match
        for (const c of record.constraints) {
          if (c.description.toLowerCase().includes(queryText) || c.reason.toLowerCase().includes(queryText)) {
            score += 10;
            matchedFields.push('constraints');
            textMatched = true;
            break;
          }
        }

        // Tags match
        if (record.tags.some((t) => t.toLowerCase().includes(queryText))) {
          score += 10;
          matchedFields.push('tags');
          textMatched = true;
        }

        // Anchor match
        if (record.primaryAnchor.filePath.toLowerCase().includes(queryText)) {
          score += 10;
          matchedFields.push('filePath');
          textMatched = true;
        }

        if (!textMatched) {
          continue;
        }
      }

      // Default baseline score if match filters passed without text query
      if (score === 0) {
        score = 10;
        matchedFields.push('filter');
      }

      results.push({ record, score, matchedFields });
    }

    // Sort by search relevance score descending
    return results.sort((a, b) => b.score - a.score);
  }
}
