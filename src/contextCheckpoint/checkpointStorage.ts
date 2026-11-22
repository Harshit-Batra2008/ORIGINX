/**
 * GitWhisper Context Checkpoint — Durable Repository Storage Engine
 * Manages Markdown + YAML Frontmatter files under <repoRoot>/.gitwhisper/checkpoints/
 * Hardened with cryptographic IDs, atomic writes, symlink protection, and path isolation.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { memoryDirectory, memoryRecordPath } from '../security/repositoryFiles';
import {
  CheckpointCommitReference,
  CheckpointRepositoryContext,
  ContextCheckpoint,
  SaveCheckpointInput
} from './checkpointTypes';
import { parseCheckpointFromMarkdown, serializeCheckpointToMarkdown } from './checkpointSerializer';
import {
  CheckpointValidationError,
  validateCheckpointId,
  validateCheckpointRecord
} from './checkpointValidator';

export class CheckpointStorageError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[ContextCheckpoint Storage] ${message}`);
    this.name = 'CheckpointStorageError';
  }
}

/**
 * Generates a collision-resistant unique Checkpoint ID using Node.js cryptographic randomness.
 * Format: CHK-YYYYMMDD-<16 hex chars (64 bits of entropy)>
 * Example: CHK-20261122-8A4F1C2B9D3E7F01
 */
export function generateCheckpointId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const datePrefix = `${year}${month}${day}`;

  const randomSuffix = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `CHK-${datePrefix}-${randomSuffix}`;
}

/**
 * Resolves and validates the .gitwhisper/checkpoints directory inside repoRoot.
 * Prevents directory escape through symlinks or junctions.
 */
export function getCheckpointsDir(repoRoot: string): string {
  return memoryDirectory(repoRoot, 'checkpoints', CheckpointStorageError);
}

export function getCheckpointFilePath(repoRoot: string, id: string): string {
  return memoryRecordPath(getCheckpointsDir(repoRoot), validateCheckpointId(id), CheckpointStorageError);
}

/**
 * Safely writes file contents atomically via a temporary file.
 */
function atomicWriteFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(targetPath)) {
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      throw new CheckpointStorageError(
        `Target path is an unsafe symbolic link: "${targetPath}"`,
        'UNSAFE_SYMLINK'
      );
    }
  }

  const tmpName = `.tmp-${path.basename(targetPath)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw new CheckpointStorageError(`Atomic write failed for "${targetPath}": ${err}`, 'WRITE_FAILED');
  }
}

export class CheckpointStorage {
  /**
   * Saves a new or updated ContextCheckpoint.
   */
  public async saveCheckpoint(
    repoRoot: string,
    input: SaveCheckpointInput,
    repository: CheckpointRepositoryContext,
    commits: CheckpointCommitReference[] = []
  ): Promise<ContextCheckpoint> {
    const id = input.id ? validateCheckpointId(input.id) : generateCheckpointId();
    const existing = input.id ? await this.getCheckpoint(repoRoot, id) : null;
    const now = new Date().toISOString();

    const completedWork = (input.completedWork || []).map((cw, idx) => ({
      id: `CW-${idx + 1}`,
      description: cw.description.trim(),
      confirmedByHuman: Boolean(cw.confirmedByHuman),
      completionNote: cw.completionNote?.trim() || undefined,
      timestamp: now
    }));

    const unfinishedTasks = (input.unfinishedTasks || []).map((ut, idx) => ({
      id: `TASK-${idx + 1}`,
      description: ut.description.trim(),
      priority: ut.priority || 'medium',
      notes: ut.notes?.trim() || undefined,
      blocker: ut.blocker?.trim() || undefined
    }));

    const knownConstraints = (input.knownConstraints || []).map((kc, idx) => ({
      id: `KCONST-${idx + 1}`,
      description: kc.description.trim(),
      source: kc.source || 'developer_note',
      decisionMemoryId: kc.decisionMemoryId
    }));

    const targetFiles = (input.targetFiles || []).map((tf) => ({
      filePath: tf.filePath.replace(/\\/g, '/').trim(),
      changeStatus: tf.changeStatus || 'modified'
    }));

    let developerIntent = undefined;
    if (input.goal || input.developerNote || input.author) {
      developerIntent = {
        goal: (input.goal || input.title).trim(),
        author: (input.author || 'Developer').trim(),
        note: input.developerNote?.trim() || undefined,
        isAiGenerated: false as const,
        recordedAt: now
      };
    }

    const record: ContextCheckpoint = {
      id,
      schemaVersion: '1.0.0',
      title: input.title.trim(),
      repository,
      developerIntent,
      completedWork,
      unfinishedTasks,
      knownConstraints,
      targetFiles,
      decisionMemoryReferences: input.decisionMemoryReferences || [],
      commitReferences: commits,
      tags: input.tags || [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    validateCheckpointRecord(record);

    const markdown = serializeCheckpointToMarkdown(record);
    atomicWriteFile(getCheckpointFilePath(repoRoot, id), markdown);

    return record;
  }

  /**
   * Retrieves a ContextCheckpoint by ID.
   */
  public async getCheckpoint(repoRoot: string, id: string): Promise<ContextCheckpoint | null> {
    const filePath = getCheckpointFilePath(repoRoot, id);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return parseCheckpointFromMarkdown(content, id);
    } catch (err) {
      if (err instanceof CheckpointValidationError) throw err;
      throw new CheckpointStorageError(`Failed to read checkpoint "${id}": ${err}`, 'READ_FAILED');
    }
  }

  /**
   * Lists all valid checkpoints stored under .gitwhisper/checkpoints/ sorted newest first.
   */
  public async listCheckpoints(repoRoot: string): Promise<ContextCheckpoint[]> {
    const dir = getCheckpointsDir(repoRoot);
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir, { withFileTypes: true });
    const records: ContextCheckpoint[] = [];

    for (const entry of files) {
      const file = entry.name;
      if (!entry.isFile() || !file.endsWith('.md') || file.startsWith('.tmp-')) {
        continue;
      }

      try {
        const record = await this.getCheckpoint(repoRoot, file.slice(0, -3));
        if (!record) continue;
        records.push(record);
      } catch (err) {
        console.warn(`[ContextCheckpoint] Skipping invalid checkpoint file "${file}"`);
      }
    }

    return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * Retrieves the most recent checkpoint for the repository.
   */
  public async getLatestCheckpoint(repoRoot: string): Promise<ContextCheckpoint | null> {
    const all = await this.listCheckpoints(repoRoot);
    return all.length > 0 ? all[0] : null;
  }
}
