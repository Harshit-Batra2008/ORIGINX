import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { findRepoRoot, isFileTracked } from '../git/gitService';
import { FileValidationItem, MultiFileValidationResult } from './multiFileTypes';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.o', '.obj',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.wasm', '.class', '.pyc', '.jar'
]);

/**
 * Inspects a file's first 512 bytes for null characters (0x00) to identify binary content.
 */
export function isBinaryFileBuffer(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates an array of selected resource URIs from the VS Code Explorer context menu.
 * Handles mixed repositories, directories, duplicates, binary files, symlinks, and inaccessible paths.
 * Never silently skips files; explicitly categorizes eligible vs. excluded items.
 */
export async function validateMultiFileSelection(
  rawInputs: Array<vscode.Uri | string | { fsPath: string }>
): Promise<MultiFileValidationResult> {
  const seenPaths = new Set<string>();
  const eligibleFiles: FileValidationItem[] = [];
  const excludedFiles: FileValidationItem[] = [];
  const repoRootsSet = new Set<string>();

  for (const input of rawInputs || []) {
    let filePath: string;
    let uri: any;

    if (typeof input === 'string') {
      filePath = path.normalize(input);
      uri = { fsPath: filePath, scheme: 'file' };
    } else if (input && typeof (input as any).fsPath === 'string') {
      filePath = path.normalize((input as any).fsPath);
      uri = input;
    } else {
      continue;
    }

    const fileName = path.basename(filePath);
    const canonicalKey = process.platform === 'win32' ? filePath.toLowerCase() : filePath;

    // 1. Deduplication check
    if (seenPaths.has(canonicalKey)) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        exclusionReason: 'Duplicate selection'
      });
      continue;
    }
    seenPaths.add(canonicalKey);

    // 2. URI scheme check
    if (uri.scheme && uri.scheme !== 'file') {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        exclusionReason: `Unsupported URI scheme "${uri.scheme}" (local files only)`
      });
      continue;
    }

    // 3. Existence & Accessibility check
    if (!fs.existsSync(filePath)) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        exclusionReason: 'File does not exist on disk'
      });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (err: any) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        exclusionReason: `Inaccessible file path: ${err.message || 'Permission denied'}`
      });
      continue;
    }

    // 4. Directory check
    if (stat.isDirectory()) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        exclusionReason: 'Directory (folders not directly analyzed)'
      });
      continue;
    }

    // 5. Symlink handling
    let resolvedPath = filePath;
    if (stat.isSymbolicLink()) {
      try {
        resolvedPath = fs.realpathSync(filePath);
        if (!fs.existsSync(resolvedPath)) {
          excludedFiles.push({
            uri,
            filePath,
            fileName,
            isEligible: false,
            exclusionReason: 'Broken symbolic link (target does not exist)'
          });
          continue;
        }
      } catch {
        excludedFiles.push({
          uri,
          filePath,
          fileName,
          isEligible: false,
          exclusionReason: 'Unresolvable symbolic link'
        });
        continue;
      }
    }

    // 6. Binary file check
    const ext = path.extname(resolvedPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext) || isBinaryFileBuffer(resolvedPath)) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        fileSizeBytes: stat.size,
        exclusionReason: 'Binary file (text code files only)'
      });
      continue;
    }

    // 7. Git repository & tracking check
    const repoRoot = await findRepoRoot(resolvedPath);
    if (!repoRoot) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        isEligible: false,
        fileSizeBytes: stat.size,
        exclusionReason: 'Not inside a Git repository'
      });
      continue;
    }

    const relativeFilePath = path.relative(repoRoot, resolvedPath).replace(/\\/g, '/');
    const isTracked = await isFileTracked(repoRoot, relativeFilePath);
    if (!isTracked) {
      excludedFiles.push({
        uri,
        filePath,
        fileName,
        repoRoot,
        relativeFilePath,
        isEligible: false,
        fileSizeBytes: stat.size,
        exclusionReason: 'Untracked in Git (no commit history)'
      });
      continue;
    }

    // File is fully eligible
    repoRootsSet.add(repoRoot);
    eligibleFiles.push({
      uri,
      filePath: resolvedPath,
      fileName,
      relativeFilePath,
      repoRoot,
      isEligible: true,
      fileSizeBytes: stat.size
    });
  }

  const repoRoots = Array.from(repoRootsSet);

  return {
    totalReceived: (rawInputs || []).length,
    eligibleFiles,
    excludedFiles,
    repoRoots,
    isMixedRepositories: repoRoots.length > 1
  };
}
