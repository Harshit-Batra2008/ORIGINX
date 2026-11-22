/**
 * GitWhisper Decision Memory — Schema & Integrity Validation
 */

import * as path from 'path';
import { scanAndSanitize } from '../security/redactor';
import {
  CreateDecisionInput,
  DecisionAnchor,
  DecisionConstraint,
  DecisionMemoryRecord,
  DecisionStatus,
  FreshnessState,
  SupportingEvidence,
  UpdateDecisionInput
} from './decisionTypes';

export class DecisionValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(`[DecisionMemory Validation] ${message}`);
    this.name = 'DecisionValidationError';
  }
}

export class DecisionSecurityError extends Error {
  constructor(message: string, public readonly pattern?: string) {
    super(`[DecisionMemory Security] ${message}`);
    this.name = 'DecisionSecurityError';
  }
}

const VALID_STATUSES: DecisionStatus[] = ['proposed', 'verified', 'disputed', 'retired'];
const VALID_FRESHNESS: FreshnessState[] = ['current', 'needs-review', 'unknown'];
export const ID_REGEX = /^DEC-[A-Za-z0-9_-]{3,64}$/;
export const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Validates a Decision ID to ensure collision resistance, standard naming, and system device name safety.
 */
export function validateDecisionId(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new DecisionValidationError('Decision ID must be a non-empty string', 'id');
  }
  const clean = id.trim();
  if (!ID_REGEX.test(clean)) {
    throw new DecisionValidationError(
      `Invalid decision ID "${id}". Must match format "DEC-<alphanumeric>" (e.g. "DEC-0001", "DEC-20261122-8A4F1C2B")`,
      'id'
    );
  }
  const prefix = clean.replace(/^DEC-/i, '').split(/[-_.]/)[0];
  if (WINDOWS_RESERVED_NAMES.test(clean) || WINDOWS_RESERVED_NAMES.test(prefix)) {
    throw new DecisionValidationError(
      `Decision ID "${id}" conflicts with reserved system device name`,
      'id'
    );
  }
  return clean;
}

/**
 * Validates a repository-relative file path to prevent path traversal and ensure normalization.
 */
export function validateRelativeFilePath(filePath: string, fieldName = 'filePath'): string {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new DecisionValidationError(`"${fieldName}" must be a non-empty string`, fieldName);
  }

  // Normalize backslashes to forward slashes and strip redundant leading ./
  let normalized = filePath.replace(/\\/g, '/').trim();
  normalized = normalized.replace(/^\.\//, '');

  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new DecisionValidationError(
      `"${fieldName}" must be a repository-relative path, received absolute path: "${filePath}"`,
      fieldName
    );
  }

  const segments = normalized.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw new DecisionValidationError(
      `"${fieldName}" contains invalid path traversal segments: "${filePath}"`,
      fieldName
    );
  }

  // Block Windows reserved device names in any path segment
  for (const segment of segments) {
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      throw new DecisionValidationError(
        `"${fieldName}" segment "${segment}" conflicts with reserved system device name`,
        fieldName
      );
    }
  }

  return normalized;
}

/**
 * Validates that an ISO date string is well-formed.
 */
export function validateIsoDate(dateStr: string, fieldName: string): void {
  if (!dateStr || typeof dateStr !== 'string') {
    throw new DecisionValidationError(`"${fieldName}" must be a non-empty string`, fieldName);
  }
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) {
    throw new DecisionValidationError(`"${fieldName}" must be a valid ISO 8601 date string, got: "${dateStr}"`, fieldName);
  }
}

/**
 * Scans arbitrary text fields for credentials, tokens, or private keys.
 * 
 * NOTE ON SECURITY LIMITATIONS:
 * Pre-flight secret scanning acts as a defense-in-depth barrier against known critical credential
 * patterns (e.g. RSA/EC private keys, AWS access keys, GitHub tokens, Google API keys, Bearer tokens).
 * It is not an exhaustive guarantee that all possible bespoke or custom secret patterns will be detected.
 */
export function scanTextForSecrets(text: string, contextLabel: string): void {
  if (!text) return;
  const scanResult = scanAndSanitize(text);
  if (scanResult.isBlocked) {
    throw new DecisionSecurityError(
      `Field "${contextLabel}" contains sensitive credentials (${scanResult.blockReason || scanResult.detectedCriticalTypes.join(', ')})`,
      scanResult.detectedCriticalTypes[0]
    );
  }
}

/**
 * Validates a DecisionMemoryRecord before storage.
 */
export function validateDecisionRecord(record: DecisionMemoryRecord): void {
  if (!record || typeof record !== 'object') {
    throw new DecisionValidationError('Decision record must be a non-null object');
  }

  // 1. Schema version
  if (record.schemaVersion !== '1.0.0') {
    throw new DecisionValidationError(
      `Unsupported schema version "${(record as any).schemaVersion}". Expected "1.0.0"`,
      'schemaVersion'
    );
  }

  // 2. ID
  validateDecisionId(record.id);

  // 3. Title
  if (!record.title || typeof record.title !== 'string' || record.title.trim().length === 0) {
    throw new DecisionValidationError('Title is required and must not be empty', 'title');
  }
  scanTextForSecrets(record.title, 'title');

  // 4. Rationale
  if (!record.rationale || typeof record.rationale !== 'string' || record.rationale.trim().length === 0) {
    throw new DecisionValidationError('Rationale is required and must not be empty', 'rationale');
  }
  scanTextForSecrets(record.rationale, 'rationale');

  // 5. Status
  if (!VALID_STATUSES.includes(record.status)) {
    throw new DecisionValidationError(
      `Invalid status "${record.status}". Allowed values: ${VALID_STATUSES.join(', ')}`,
      'status'
    );
  }

  // 6. Freshness
  if (!VALID_FRESHNESS.includes(record.freshness)) {
    throw new DecisionValidationError(
      `Invalid freshness "${record.freshness}". Allowed values: ${VALID_FRESHNESS.join(', ')}`,
      'freshness'
    );
  }

  // 7. Human Verification Rules
  if (record.status === 'verified') {
    if (!record.verifiedBy) {
      throw new DecisionValidationError(
        'Verified decisions require a "verifiedBy" author metadata entry',
        'verifiedBy'
      );
    }
    if (record.verifiedBy.type !== 'human') {
      throw new DecisionValidationError(
        'Decisions can only be verified by a human developer. AI assistants cannot verify decisions',
        'verifiedBy'
      );
    }
    if (!record.verifiedBy.name || record.verifiedBy.name.trim().length === 0) {
      throw new DecisionValidationError('Verifier name must not be empty', 'verifiedBy.name');
    }
    if (!record.verifiedAt) {
      throw new DecisionValidationError('Verified decisions must have a "verifiedAt" timestamp', 'verifiedAt');
    }
    validateIsoDate(record.verifiedAt, 'verifiedAt');
    if (record.verificationNote) {
      scanTextForSecrets(record.verificationNote, 'verificationNote');
    }
  }

  // 8. Creator validation
  if (!record.createdBy || typeof record.createdBy !== 'object') {
    throw new DecisionValidationError('Record requires "createdBy" metadata', 'createdBy');
  }
  if (!['human', 'ai_assistant'].includes(record.createdBy.type)) {
    throw new DecisionValidationError(
      'Creator type must be either "human" or "ai_assistant"',
      'createdBy.type'
    );
  }
  if (!record.createdBy.name || record.createdBy.name.trim().length === 0) {
    throw new DecisionValidationError('Creator name is required', 'createdBy.name');
  }

  // 9. Primary Anchor validation
  if (!record.primaryAnchor || typeof record.primaryAnchor !== 'object') {
    throw new DecisionValidationError('Record requires a "primaryAnchor" object', 'primaryAnchor');
  }
  validateRelativeFilePath(record.primaryAnchor.filePath, 'primaryAnchor.filePath');

  if (record.primaryAnchor.startLine !== undefined) {
    if (typeof record.primaryAnchor.startLine !== 'number' || record.primaryAnchor.startLine < 1) {
      throw new DecisionValidationError('primaryAnchor.startLine must be a positive integer', 'primaryAnchor.startLine');
    }
  }
  if (record.primaryAnchor.endLine !== undefined) {
    if (typeof record.primaryAnchor.endLine !== 'number' || record.primaryAnchor.endLine < 1) {
      throw new DecisionValidationError('primaryAnchor.endLine must be a positive integer', 'primaryAnchor.endLine');
    }
    if (record.primaryAnchor.startLine !== undefined && record.primaryAnchor.endLine < record.primaryAnchor.startLine) {
      throw new DecisionValidationError('primaryAnchor.endLine cannot be less than startLine', 'primaryAnchor.endLine');
    }
  }
  if (record.primaryAnchor.contextSnippet) {
    scanTextForSecrets(record.primaryAnchor.contextSnippet, 'primaryAnchor.contextSnippet');
  }

  // 10. Related Files validation
  if (Array.isArray(record.relatedFiles)) {
    for (const rf of record.relatedFiles) {
      validateRelativeFilePath(rf.filePath, 'relatedFiles[].filePath');
      if (!rf.couplingReason || typeof rf.couplingReason !== 'string') {
        throw new DecisionValidationError('relatedFiles[].couplingReason must be a non-empty string', 'relatedFiles[].couplingReason');
      }
      scanTextForSecrets(rf.couplingReason, 'relatedFiles[].couplingReason');
    }
  } else {
    throw new DecisionValidationError('relatedFiles must be an array', 'relatedFiles');
  }

  // 11. Evidence validation
  if (Array.isArray(record.evidence)) {
    for (const ev of record.evidence) {
      if (!ev.commitHash || typeof ev.commitHash !== 'string' || ev.commitHash.length < 7) {
        throw new DecisionValidationError('Supporting evidence commitHash must be a valid commit SHA', 'evidence[].commitHash');
      }
      if (!ev.subject || typeof ev.subject !== 'string') {
        throw new DecisionValidationError('Supporting evidence subject must be a string', 'evidence[].subject');
      }
      scanTextForSecrets(ev.subject, 'evidence[].subject');
      if (ev.body) scanTextForSecrets(ev.body, 'evidence[].body');
      if (ev.diffHunk) scanTextForSecrets(ev.diffHunk, 'evidence[].diffHunk');
    }
  } else {
    throw new DecisionValidationError('evidence must be an array', 'evidence');
  }

  // 12. Explicit evidence check
  if (typeof record.hasDirectGitEvidence !== 'boolean') {
    throw new DecisionValidationError('hasDirectGitEvidence must be a boolean flag', 'hasDirectGitEvidence');
  }
  if (record.hasDirectGitEvidence && record.evidence.length === 0) {
    throw new DecisionValidationError(
      'hasDirectGitEvidence is set to true, but evidence array contains zero commits',
      'hasDirectGitEvidence'
    );
  }

  // 13. Constraints validation
  if (Array.isArray(record.constraints)) {
    for (const c of record.constraints) {
      if (!c.id || typeof c.id !== 'string') {
        throw new DecisionValidationError('Constraint must have an id (e.g. "C1")', 'constraints[].id');
      }
      if (!c.description || typeof c.description !== 'string' || c.description.trim().length === 0) {
        throw new DecisionValidationError('Constraint description is required', 'constraints[].description');
      }
      scanTextForSecrets(c.description, 'constraints[].description');
      if (!c.reason || typeof c.reason !== 'string') {
        throw new DecisionValidationError('Constraint reason is required', 'constraints[].reason');
      }
      scanTextForSecrets(c.reason, 'constraints[].reason');
      if (!['critical', 'advisory'].includes(c.severity)) {
        throw new DecisionValidationError('Constraint severity must be "critical" or "advisory"', 'constraints[].severity');
      }
    }
  } else {
    throw new DecisionValidationError('constraints must be an array', 'constraints');
  }

  // 14. Timestamps
  validateIsoDate(record.createdAt, 'createdAt');
  validateIsoDate(record.updatedAt, 'updatedAt');
  if (record.retiredAt) validateIsoDate(record.retiredAt, 'retiredAt');

  // 15. Tags
  if (!Array.isArray(record.tags)) {
    throw new DecisionValidationError('tags must be an array of strings', 'tags');
  }
  for (const t of record.tags) {
    if (typeof t !== 'string' || t.trim().length === 0) {
      throw new DecisionValidationError('Each tag must be a non-empty string', 'tags');
    }
    scanTextForSecrets(t, 'tags[]');
  }
}
