import * as path from 'path';
import { scanAndSanitize } from '../security/redactor';
import { redactSecret } from './neo4jEnv';
import {
  FileChangeType,
  GitGraphCommit,
  GitGraphFileChange
} from './neo4jGraphTypes';

export const GIT_LOG_FORMAT = 'commit:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00END_META';

/**
 * Default directory segments to exclude from Git evidence graph ingestion.
 * Matches directories anywhere in the path, not just at repository root.
 */
export const DEFAULT_EXCLUDED_DIRECTORY_SEGMENTS: string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  '.git'
];

/**
 * Normalizes file paths to POSIX format (forward slashes).
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Checks whether a file path contains any excluded directory segments.
 * Match directories anywhere in the path, not just at repository root.
 * Preserves package-lock.json, source files, documentation, and useful configuration files.
 */
export function isExcludedPath(filePath: string, customSegments?: string[]): boolean {
  if (!filePath) {
    return false;
  }
  const excluded = new Set(
    (customSegments && customSegments.length > 0
      ? customSegments
      : DEFAULT_EXCLUDED_DIRECTORY_SEGMENTS
    ).map((s) => s.toLowerCase().trim()).filter(Boolean)
  );

  const normalized = normalizePath(filePath);
  const segments = normalized.split('/').filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const seg = segments[i].toLowerCase();

    if (excluded.has(seg)) {
      // If it's a parent directory segment, it is definitely a directory match
      if (!isLast) {
        return true;
      }
      // If it's the last segment, only exclude if it has no extension (directory match)
      // or if it explicitly matches directory syntax
      if (!path.posix.extname(seg)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parses raw status line from `git log --name-status`.
 * Handles modifications, additions, deletions, renames, and copies.
 */
export function parseNameStatusLine(
  line: string,
  repoId: string
): GitGraphFileChange | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\t+/);
  if (parts.length < 2) {
    return null;
  }

  const statusRaw = parts[0].trim().toUpperCase();
  const statusCode = statusRaw.charAt(0);

  let changeType: FileChangeType = 'unknown';
  let filePath = '';
  let oldPath: string | undefined = undefined;

  switch (statusCode) {
    case 'A':
      changeType = 'added';
      filePath = normalizePath(parts[1]);
      break;
    case 'M':
      changeType = 'modified';
      filePath = normalizePath(parts[1]);
      break;
    case 'D':
      changeType = 'deleted';
      filePath = normalizePath(parts[1]);
      break;
    case 'R':
      changeType = 'renamed';
      if (parts.length >= 3) {
        oldPath = normalizePath(parts[1]);
        filePath = normalizePath(parts[2]);
      } else {
        filePath = normalizePath(parts[1]);
      }
      break;
    case 'C':
      changeType = 'copied';
      if (parts.length >= 3) {
        oldPath = normalizePath(parts[1]);
        filePath = normalizePath(parts[2]);
      } else {
        filePath = normalizePath(parts[1]);
      }
      break;
    default:
      changeType = 'modified';
      filePath = normalizePath(parts[1]);
      break;
  }

  if (!filePath) {
    return null;
  }

  const fileName = path.posix.basename(filePath);
  const fileId = `${repoId}:${filePath}`;

  return {
    path: filePath,
    name: fileName,
    changeType,
    oldPath,
    fileId
  };
}

/**
 * Sanitizes commit message fields before database ingestion.
 * Replaces critical keys/tokens and masks sensitive strings.
 */
export function sanitizeCommitText(text: string): string {
  if (!text) {
    return '';
  }
  const scan = scanAndSanitize(text);
  if (scan.isBlocked) {
    return `[REDACTED_CREDENTIALS: ${scan.detectedCriticalTypes.join(', ')}]`;
  }
  return redactSecret(scan.sanitizedText);
}

/**
 * Parses stdout from `git log --name-status --format="commit:%H%x00..."`
 * into structured GitGraphCommit array with composite IDs for Neo4j.
 * Automatically excludes files in generated/dependency directories (node_modules, dist, etc.)
 * while preserving commit metadata even if all changed files are excluded.
 */
export function parseGitLogToGraph(
  stdout: string,
  repoId: string,
  excludedSegments?: string[]
): GitGraphCommit[] {
  if (!stdout || stdout.trim().length === 0) {
    return [];
  }

  const commits: GitGraphCommit[] = [];
  // Split on "commit:" at line starts or file start
  const rawBlocks = stdout.split(/(?:^|\r?\n)commit:/);

  for (const block of rawBlocks) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) {
      continue;
    }

    const metaEndIdx = trimmedBlock.indexOf('\0END_META');
    if (metaEndIdx === -1) {
      continue;
    }

    const metaSection = trimmedBlock.slice(0, metaEndIdx);
    const filesSection = trimmedBlock.slice(metaEndIdx + '\0END_META'.length);

    const metaParts = metaSection.split('\0');
    if (metaParts.length < 5) {
      continue;
    }

    const hash = metaParts[0].trim();
    const shortHash = metaParts[1] ? metaParts[1].trim() : hash.slice(0, 7);
    const authorName = metaParts[2] ? metaParts[2].trim() : 'Unknown';
    const authorEmail = metaParts[3] ? metaParts[3].trim().toLowerCase() : '';
    const committedAt = metaParts[4] ? metaParts[4].trim() : new Date().toISOString();
    const rawSubject = metaParts[5] ? metaParts[5].trim() : '';
    const rawBody = metaParts[6] ? metaParts[6].trim() : '';

    // Sanitize subjects and bodies to guarantee no secrets are ingested into Neo4j
    const subject = sanitizeCommitText(rawSubject);
    const body = sanitizeCommitText(rawBody);

    const personId = authorEmail || authorName.toLowerCase().replace(/\s+/g, '_');
    const commitId = `${repoId}:${hash}`;

    // Parse file changes from the remainder of the block, filtering out excluded paths
    const files: GitGraphFileChange[] = [];
    const fileLines = filesSection.split(/\r?\n/);
    for (const fLine of fileLines) {
      const parsedFile = parseNameStatusLine(fLine, repoId);
      if (parsedFile) {
        // Exclude generated/dependency paths before constructing File nodes
        if (!isExcludedPath(parsedFile.path, excludedSegments)) {
          files.push(parsedFile);
        }
      }
    }

    commits.push({
      id: commitId,
      hash,
      shortHash,
      authorName,
      authorEmail,
      personId,
      committedAt,
      subject,
      body,
      repoId,
      files
    });
  }

  return commits;
}
