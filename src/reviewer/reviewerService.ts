import * as fs from 'fs';
import * as path from 'path';
import { ICancellationTokenLike, runGit } from '../git/gitService';
import { listWorkingTreeEntries } from '../git/workingTreeStatus';
import { resolveRepositoryFile } from '../security/repositoryFiles';
import { isBinaryFileBuffer } from '../multiFile/multiFileValidator';
import {
  ReviewerChangeStatus,
  ReviewerFileChange
} from './reviewerTypes';

export const MAX_DIFF_CHARS_PER_FILE = 40000;
export const MAX_TOTAL_DIFF_CHARS = 160000;
export const MAX_UNTRACKED_READ_BYTES = 40 * 1024; // 40KB max for untracked text preview

export interface WorkingTreeChangesResult {
  changedFiles: ReviewerFileChange[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  totalDiffChars: number;
  isCancelled?: boolean;
}

/**
 * Gathers real staged and unstaged changes across the repository working tree.
 * Handles renames, untracked text/binary files, and bounded diffs safely.
 */
export async function gatherWorkingTreeChanges(
  repoRoot: string,
  options?: {
    cancellationToken?: ICancellationTokenLike;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxDiffCharsPerFile?: number;
  }
): Promise<WorkingTreeChangesResult> {
  const maxDiffPerFile = options?.maxDiffCharsPerFile ?? MAX_DIFF_CHARS_PER_FILE;

  if (options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted) {
    return {
      changedFiles: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalDiffChars: 0,
      isCancelled: true
    };
  }

  const entries = await listWorkingTreeEntries(repoRoot, options);
  if (options?.abortSignal?.aborted || options?.cancellationToken?.isCancellationRequested) {
    return {
      changedFiles: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalDiffChars: 0,
      isCancelled: true
    };
  }

  const changedFiles: ReviewerFileChange[] = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let totalDiffChars = 0;

  for (const { stagedFlag, unstagedFlag, filePath: rawPath, oldPath } of entries) {
    if (options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted) {
      return {
        changedFiles,
        stagedCount,
        unstagedCount,
        untrackedCount,
        totalDiffChars,
        isCancelled: true
      };
    }

    const normalizedRelPath = rawPath;
    let fullPath: string | undefined;
    try {
      fullPath = resolveRepositoryFile(repoRoot, rawPath);
    } catch {
      continue;
    }

    const isUntracked = stagedFlag === '?' && unstagedFlag === '?';
    const hasStaged = stagedFlag !== ' ' && stagedFlag !== '?' && stagedFlag !== '';
    const hasUnstaged = unstagedFlag !== ' ' && unstagedFlag !== '?' && unstagedFlag !== '';

    let status: ReviewerChangeStatus = 'unstaged';
    if (isUntracked) {
      status = 'untracked';
      untrackedCount++;
    } else if (hasStaged && hasUnstaged) {
      status = 'both';
      stagedCount++;
      unstagedCount++;
    } else if (hasStaged) {
      status = 'staged';
      stagedCount++;
    } else if (hasUnstaged) {
      status = 'unstaged';
      unstagedCount++;
    }

    const isBinary = fullPath ? isBinaryFileBuffer(fullPath) : false;

    let stagedDiff = '';
    let unstagedDiff = '';
    let diff = '';

    if (isUntracked) {
      if (!isBinary && fullPath) {
        try {
          const size = fs.statSync(fullPath).size;
          if (size <= MAX_UNTRACKED_READ_BYTES) {
            const text = fs.readFileSync(fullPath, 'utf8');
            const lines = text.split('\n');
            diff =
              `--- /dev/null\n+++ b/${normalizedRelPath}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map((l) => `+${l}`).join('\n');
            unstagedDiff = diff;
          } else {
            diff = `[Large untracked text file: ${(size / 1024).toFixed(1)}KB - content preview omitted]`;
          }
        } catch {
          diff = '[Untracked file - unable to read content]';
        }
      } else if (isBinary) {
        diff = '[Binary file added]';
      }
    } else {
      if (isBinary) {
        diff = '[Binary file changes - diff omitted]';
      } else {
        if (hasStaged) {
          const sRes = await runGit(['--literal-pathspecs', 'diff', '--cached', '--', rawPath], repoRoot, options);
          if (sRes.exitCode === 0 && sRes.stdout.trim().length > 0) {
            stagedDiff = sRes.stdout.trim();
          }
        }
        if (hasUnstaged) {
          const uRes = await runGit(['--literal-pathspecs', 'diff', '--', rawPath], repoRoot, options);
          if (uRes.exitCode === 0 && uRes.stdout.trim().length > 0) {
            unstagedDiff = uRes.stdout.trim();
          }
        }

        if (stagedDiff && unstagedDiff) {
          diff = `--- STAGED CHANGES ---\n${stagedDiff}\n\n--- UNSTAGED CHANGES ---\n${unstagedDiff}`;
        } else if (stagedDiff) {
          diff = stagedDiff;
        } else if (unstagedDiff) {
          diff = unstagedDiff;
        }
      }
    }

    if (diff.length > maxDiffPerFile) {
      diff =
        diff.slice(0, maxDiffPerFile) +
        `\n\n[Diff truncated: exceeded ${Math.round(maxDiffPerFile / 1000)}k characters limit for single file review]`;
    }

    totalDiffChars += diff.length;

    changedFiles.push({
      filePath: normalizedRelPath,
      fileName: path.basename(normalizedRelPath),
      status,
      stagedDiff: stagedDiff || undefined,
      unstagedDiff: unstagedDiff || undefined,
      diff,
      diffCharCount: diff.length,
      isBinary,
      isUntracked,
      oldPath
    });
  }

  return {
    changedFiles,
    stagedCount,
    unstagedCount,
    untrackedCount,
    totalDiffChars
  };
}

export { aggregateCoChangeEvidence } from '../impact/coChangeImpact';
