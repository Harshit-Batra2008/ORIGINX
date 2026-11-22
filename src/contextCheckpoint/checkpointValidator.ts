/**
 * GitWhisper Context Checkpoint — Schema & Safety Validation
 * Protects repository integrity against path traversal, Windows device names,
 * secret leaks, and unverified AI claims.
 */

import * as path from 'path';
import { scanAndSanitize } from '../security/redactor';
import {
  ContextCheckpoint,
  SaveCheckpointInput
} from './checkpointTypes';

export class CheckpointValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(`[ContextCheckpoint Validation] ${message}`);
    this.name = 'CheckpointValidationError';
  }
}

export class CheckpointSecurityError extends Error {
  constructor(message: string, public readonly pattern?: string) {
    super(`[ContextCheckpoint Security] ${message}`);
    this.name = 'CheckpointSecurityError';
  }
}

export const CHECKPOINT_ID_REGEX = /^CHK-[A-Za-z0-9_-]{3,64}$/;
export const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Validates a Checkpoint ID format and blocks dangerous Windows device names.
 */
export function validateCheckpointId(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new CheckpointValidationError('Checkpoint ID must be a non-empty string', 'id');
  }
  const clean = id.trim();
  const base = path.basename(clean);
  if (base !== clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) {
    throw new CheckpointValidationError(`Path traversal detected in checkpoint ID: "${id}"`, 'id');
  }

  const suffix = clean.replace(/^CHK-/i, '').split(/[-_.]/)[0];
  if (WINDOWS_RESERVED_NAMES.test(clean) || WINDOWS_RESERVED_NAMES.test(suffix)) {
    throw new CheckpointValidationError(
      `Checkpoint ID "${clean}" conflicts with Windows reserved device name`,
      'id'
    );
  }

  if (!CHECKPOINT_ID_REGEX.test(clean)) {
    throw new CheckpointValidationError(
      `Invalid checkpoint ID "${id}". Must match format "CHK-<alphanumeric>" (e.g. "CHK-20261122-8A4F1C2B")`,
      'id'
    );
  }

  return clean;
}

/**
 * Scans text content for sensitive credentials and throws CheckpointSecurityError if blocked.
 */
export function scanCheckpointTextForSecrets(text: string, contextLabel: string): void {
  if (!text) return;
  const scanResult = scanAndSanitize(text);
  if (scanResult.isBlocked) {
    throw new CheckpointSecurityError(
      `Potential secret or credential detected in ${contextLabel}: ${scanResult.blockReason || 'Critical secret detected'}`,
      scanResult.detectedCriticalTypes[0]
    );
  }
}

/**
 * Validates a relative file path for safe repository reference.
 */
export function validateRelativeFilePath(filePath: string, fieldName = 'filePath'): string {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new CheckpointValidationError(`${fieldName} must be a non-empty string`, fieldName);
  }

  const normalized = filePath.replace(/\\/g, '/').trim();
  if (path.isAbsolute(normalized) || normalized.startsWith('/') || /^[A-Za-z]:/i.test(normalized)) {
    throw new CheckpointValidationError(
      `${fieldName} must be a relative repository path, got: "${filePath}"`,
      fieldName
    );
  }

  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..') {
      throw new CheckpointValidationError(
        `Path traversal detected in ${fieldName}: "${filePath}"`,
        fieldName
      );
    }
    if (WINDOWS_RESERVED_NAMES.test(part)) {
      throw new CheckpointValidationError(
        `${fieldName} component "${part}" conflicts with Windows reserved device name`,
        fieldName
      );
    }
  }

  return normalized;
}

/**
 * Validates an ISO 8601 timestamp.
 */
export function validateIsoTimestamp(timestamp: string, fieldName = 'timestamp'): string {
  if (!timestamp || typeof timestamp !== 'string') {
    throw new CheckpointValidationError(`${fieldName} must be a valid ISO 8601 string`, fieldName);
  }
  const parsed = Date.parse(timestamp);
  if (isNaN(parsed)) {
    throw new CheckpointValidationError(
      `${fieldName} "${timestamp}" is not a parseable ISO 8601 timestamp`,
      fieldName
    );
  }
  return timestamp;
}

/**
 * Validates the complete ContextCheckpoint record for structural, cryptographic, and security safety.
 */
export function validateCheckpointRecord(record: ContextCheckpoint): void {
  if (!record || typeof record !== 'object') {
    throw new CheckpointValidationError('ContextCheckpoint record must be an object');
  }

  validateCheckpointId(record.id);

  if (record.schemaVersion !== '1.0.0') {
    throw new CheckpointValidationError(
      `Unsupported schema version "${record.schemaVersion}". Expected "1.0.0"`,
      'schemaVersion'
    );
  }

  if (!record.title || typeof record.title !== 'string' || record.title.trim().length === 0) {
    throw new CheckpointValidationError('title must be a non-empty string', 'title');
  }
  scanCheckpointTextForSecrets(record.title, 'title');

  if (!record.repository || typeof record.repository !== 'object') {
    throw new CheckpointValidationError('repository context is required', 'repository');
  }
  if (!record.repository.repoName || typeof record.repository.repoName !== 'string') {
    throw new CheckpointValidationError('repository.repoName is required', 'repository.repoName');
  }
  if (!record.repository.branch || typeof record.repository.branch !== 'string') {
    throw new CheckpointValidationError('repository.branch is required', 'repository.branch');
  }
  if (!record.repository.headCommit || typeof record.repository.headCommit !== 'string') {
    throw new CheckpointValidationError('repository.headCommit is required', 'repository.headCommit');
  }

  // Developer Intent (Optional, but strictly verified)
  if (record.developerIntent) {
    if (!record.developerIntent.goal || typeof record.developerIntent.goal !== 'string') {
      throw new CheckpointValidationError('developerIntent.goal must be a non-empty string', 'developerIntent.goal');
    }
    scanCheckpointTextForSecrets(record.developerIntent.goal, 'developerIntent.goal');
    if (record.developerIntent.author) {
      scanCheckpointTextForSecrets(record.developerIntent.author, 'developerIntent.author');
    }
    if (record.developerIntent.note) {
      scanCheckpointTextForSecrets(record.developerIntent.note, 'developerIntent.note');
    }
    if (record.developerIntent.isAiGenerated !== false) {
      throw new CheckpointValidationError(
        'developerIntent.isAiGenerated must be false (developer notes cannot be claimed as AI generated)',
        'developerIntent.isAiGenerated'
      );
    }
    validateIsoTimestamp(record.developerIntent.recordedAt, 'developerIntent.recordedAt');
  }

  // Completed Work
  if (!Array.isArray(record.completedWork)) {
    throw new CheckpointValidationError('completedWork must be an array', 'completedWork');
  }
  for (let idx = 0; idx < record.completedWork.length; idx++) {
    const item = record.completedWork[idx];
    if (!item.description || typeof item.description !== 'string') {
      throw new CheckpointValidationError(
        `completedWork[${idx}].description must be a non-empty string`,
        'completedWork[].description'
      );
    }
    scanCheckpointTextForSecrets(item.description, `completedWork[${idx}].description`);
    if (typeof item.confirmedByHuman !== 'boolean') {
      throw new CheckpointValidationError(
        `completedWork[${idx}].confirmedByHuman must be an explicit boolean`,
        'completedWork[].confirmedByHuman'
      );
    }
    if (item.completionNote) {
      scanCheckpointTextForSecrets(item.completionNote, `completedWork[${idx}].completionNote`);
    }
    validateIsoTimestamp(item.timestamp, `completedWork[${idx}].timestamp`);
  }

  // Unfinished Tasks
  if (!Array.isArray(record.unfinishedTasks)) {
    throw new CheckpointValidationError('unfinishedTasks must be an array', 'unfinishedTasks');
  }
  for (let idx = 0; idx < record.unfinishedTasks.length; idx++) {
    const task = record.unfinishedTasks[idx];
    if (!task.description || typeof task.description !== 'string') {
      throw new CheckpointValidationError(
        `unfinishedTasks[${idx}].description must be a non-empty string`,
        'unfinishedTasks[].description'
      );
    }
    scanCheckpointTextForSecrets(task.description, `unfinishedTasks[${idx}].description`);
    if (task.notes) scanCheckpointTextForSecrets(task.notes, `unfinishedTasks[${idx}].notes`);
    if (task.blocker) scanCheckpointTextForSecrets(task.blocker, `unfinishedTasks[${idx}].blocker`);
    if (task.priority && !['high', 'medium', 'low'].includes(task.priority)) {
      throw new CheckpointValidationError(
        `unfinishedTasks[${idx}].priority must be "high", "medium", or "low"`,
        'unfinishedTasks[].priority'
      );
    }
  }

  // Known Constraints
  if (!Array.isArray(record.knownConstraints)) {
    throw new CheckpointValidationError('knownConstraints must be an array', 'knownConstraints');
  }
  for (let idx = 0; idx < record.knownConstraints.length; idx++) {
    const c = record.knownConstraints[idx];
    if (!c.description || typeof c.description !== 'string') {
      throw new CheckpointValidationError(
        `knownConstraints[${idx}].description must be a non-empty string`,
        'knownConstraints[].description'
      );
    }
    scanCheckpointTextForSecrets(c.description, `knownConstraints[${idx}].description`);
  }

  // Target Files
  if (!Array.isArray(record.targetFiles)) {
    throw new CheckpointValidationError('targetFiles must be an array', 'targetFiles');
  }
  for (let idx = 0; idx < record.targetFiles.length; idx++) {
    const tf = record.targetFiles[idx];
    validateRelativeFilePath(tf.filePath, `targetFiles[${idx}].filePath`);
  }

  // Decision Memory References
  if (!Array.isArray(record.decisionMemoryReferences)) {
    throw new CheckpointValidationError('decisionMemoryReferences must be an array', 'decisionMemoryReferences');
  }
  for (const ref of record.decisionMemoryReferences) {
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new CheckpointValidationError('decisionMemoryReferences entries must be non-empty strings');
    }
  }

  // Commit References
  if (!Array.isArray(record.commitReferences)) {
    throw new CheckpointValidationError('commitReferences must be an array', 'commitReferences');
  }

  // Timestamps
  validateIsoTimestamp(record.createdAt, 'createdAt');
  validateIsoTimestamp(record.updatedAt, 'updatedAt');
}
