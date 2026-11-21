import * as fs from 'fs';
import * as path from 'path';
import { ICancellationTokenLike, runGit } from '../git/gitService';
import { isExcludedPath } from '../neo4j/gitLogParser';
import { isBinaryFileBuffer } from '../multiFile/multiFileValidator';
import {
  RelatedFileRecommendation,
  ReviewerChangeStatus,
  ReviewerCoChangeGroup,
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

  // 1. Run git status --porcelain=v1 -u to list all modified, staged, deleted, and untracked files
  const statusRes = await runGit(['status', '--porcelain=v1', '-u'], repoRoot, options);
  if (statusRes.exitCode === 130 || options?.cancellationToken?.isCancellationRequested) {
    return {
      changedFiles: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalDiffChars: 0,
      isCancelled: true
    };
  }

  if (statusRes.exitCode !== 0 || !statusRes.stdout.trim()) {
    return {
      changedFiles: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalDiffChars: 0
    };
  }

  const rawLines = statusRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const changedFiles: ReviewerFileChange[] = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let totalDiffChars = 0;

  for (const line of rawLines) {
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

    if (line.length < 3) continue;

    const stagedFlag = line[0];
    const unstagedFlag = line[1];
    let rawPath = line.substring(3).trim();

    // Strip quotes if git quoted paths with spaces
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    }

    // Handle renames: "old.ts -> new.ts"
    let oldPath: string | undefined = undefined;
    if (rawPath.includes(' -> ')) {
      const parts = rawPath.split(' -> ');
      oldPath = parts[0].trim();
      rawPath = parts[1].trim();
    }

    const normalizedRelPath = rawPath.replace(/\\/g, '/');

    // Filter out dependencies and build output
    if (isExcludedPath(normalizedRelPath)) {
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

    const fullPath = path.resolve(repoRoot, rawPath);
    let isBinary = false;

    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          continue; // Ignore raw directory entries
        }
      } catch {}
      isBinary = isBinaryFileBuffer(fullPath);
    }

    let stagedDiff = '';
    let unstagedDiff = '';
    let diff = '';

    if (isUntracked) {
      if (!isBinary && fs.existsSync(fullPath)) {
        try {
          const fileBytes = fs.readFileSync(fullPath);
          if (fileBytes.length <= MAX_UNTRACKED_READ_BYTES) {
            const text = fileBytes.toString('utf8');
            const lines = text.split('\n');
            diff =
              `--- /dev/null\n+++ b/${normalizedRelPath}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map((l) => `+${l}`).join('\n');
            unstagedDiff = diff;
          } else {
            diff = `[Large untracked text file: ${(fileBytes.length / 1024).toFixed(1)}KB - content preview omitted]`;
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
          const sRes = await runGit(['diff', '--cached', '--', rawPath], repoRoot, options);
          if (sRes.exitCode === 0 && sRes.stdout.trim().length > 0) {
            stagedDiff = sRes.stdout.trim();
          }
        }
        if (hasUnstaged) {
          const uRes = await runGit(['diff', '--', rawPath], repoRoot, options);
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

/**
 * Aggregates and correlates co-change evidence from Neo4j across all changed files.
 * Identifies historically related files and clearly flags whether they are currently changed
 * or are un-modified companions worth reviewing (blast radius analysis).
 */
export function aggregateCoChangeEvidence(
  changedFiles: ReviewerFileChange[],
  coChangeGroups: ReviewerCoChangeGroup[]
): RelatedFileRecommendation[] {
  const changedPathsLower = new Set<string>(
    changedFiles.map((f) => f.filePath.replace(/\\/g, '/').toLowerCase())
  );

  const recMap = new Map<string, RelatedFileRecommendation>();

  for (const group of coChangeGroups) {
    const targetPath = group.targetFilePath.replace(/\\/g, '/');

    for (const item of group.coChangedFiles) {
      const itemPath = item.filePath.replace(/\\/g, '/');
      const key = itemPath.toLowerCase();

      const isCurrentlyChanged = changedPathsLower.has(key);

      const existing = recMap.get(key);
      if (!existing) {
        const hashes = item.commitHashes || (item.sharedCommits ? item.sharedCommits.map((c) => c.shortHash) : []);
        const subjects = (item.sharedCommits || [])
          .map((c) => c.subject)
          .filter(Boolean) as string[];

        recMap.set(key, {
          filePath: itemPath,
          fileName: item.fileName || path.basename(itemPath),
          historicallyCoupledWith: [targetPath],
          sharedCommitCount: item.sharedCommitCount || 1,
          sampleCommitHashes: Array.from(new Set(hashes)),
          sampleCommitSubjects: Array.from(new Set(subjects)),
          isCurrentlyChanged
        });
      } else {
        if (!existing.historicallyCoupledWith.includes(targetPath)) {
          existing.historicallyCoupledWith.push(targetPath);
        }
        existing.sharedCommitCount = Math.max(existing.sharedCommitCount, item.sharedCommitCount || 1);

        const newHashes = item.commitHashes || (item.sharedCommits ? item.sharedCommits.map((c) => c.shortHash) : []);
        for (const h of newHashes) {
          if (!existing.sampleCommitHashes.includes(h)) {
            existing.sampleCommitHashes.push(h);
          }
        }
        for (const c of (item.sharedCommits || [])) {
          if (c.subject && !existing.sampleCommitSubjects.includes(c.subject)) {
            existing.sampleCommitSubjects.push(c.subject);
          }
        }
      }
    }
  }

  // Sort: Files NOT currently changed first (potential missing co-changes), then by sharedCommitCount DESC
  return Array.from(recMap.values()).sort((a, b) => {
    if (a.isCurrentlyChanged !== b.isCurrentlyChanged) {
      return a.isCurrentlyChanged ? 1 : -1;
    }
    if (b.sharedCommitCount !== a.sharedCommitCount) {
      return b.sharedCommitCount - a.sharedCommitCount;
    }
    return a.filePath.localeCompare(b.filePath);
  });
}
