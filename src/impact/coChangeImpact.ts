import * as path from 'path';
import { isSourceTarget, normalizePath } from '../git/sourcePaths';
import type { RelatedFileRecommendation, ReviewerCoChangeGroup } from '../reviewer/reviewerTypes';

function pathKey(filePath: string): string {
  const normalized = normalizePath(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Aggregates and correlates co-change evidence across all selected files.
 * Identifies historically related files and clearly flags whether they are currently changed
 * or are un-modified companions worth reviewing (blast radius analysis).
 */
export function aggregateCoChangeEvidence(
  changedFiles: ReadonlyArray<{ filePath: string; oldPath?: string }>,
  coChangeGroups: ReviewerCoChangeGroup[]
): RelatedFileRecommendation[] {
  const changedPaths = new Set<string>();
  for (const file of changedFiles) {
    changedPaths.add(pathKey(file.filePath));
    if (file.oldPath) changedPaths.add(pathKey(file.oldPath));
  }

  const recMap = new Map<string, RelatedFileRecommendation>();

  for (const group of coChangeGroups) {
    const targetPath = normalizePath(group.targetFilePath);
    if (!isSourceTarget(targetPath)) continue;

    for (const item of group.coChangedFiles) {
      const itemPath = normalizePath(item.filePath);
      const key = pathKey(itemPath);
      if (!isSourceTarget(itemPath) || key === pathKey(targetPath)) continue;

      const isCurrentlyChanged = changedPaths.has(key);

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
