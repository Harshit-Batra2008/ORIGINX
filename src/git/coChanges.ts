import { GitExecOptions, runGit } from './gitService';
import { isSourceTarget, normalizePath } from './sourcePaths';

export const MAX_RELATED_FILES = 8;
export const MAX_CONTEXT_TARGETS = 8;
export const MAX_SHARED_COMMIT_SAMPLES = 5;

export interface CoChangeCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitCoChange {
  filePath: string;
  sharedCommitCount: number;
  commits: CoChangeCommit[];
}

export function boundedRelatedFileCount(limit = MAX_RELATED_FILES): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), MAX_RELATED_FILES)) : MAX_RELATED_FILES;
}

/** Select commits by literal target paths, then use their full changesets for co-change evidence. */
export async function getGitCoChanges(
  repoRoot: string, targetPaths: string[], limit = MAX_RELATED_FILES, options?: GitExecOptions
): Promise<GitCoChange[]> {
  const targets = new Set(targetPaths.filter(p => isSourceTarget(p)).map(normalizePath));
  if (!targets.size) return [];
  const result = await runGit([
    '--literal-pathspecs', 'log', '-50', '--full-diff', '--no-renames', '--name-only', '-z',
    '--format=%x00%H%x00%h%x00%aI%x00%an%x00%s', '--', ...[...targets].slice(0, MAX_CONTEXT_TARGETS)
  ], repoRoot, options);
  if (result.exitCode !== 0) return [];

  const fields = result.stdout.split('\0');
  const companions = new Map<string, GitCoChange>();
  let commit: CoChangeCommit | undefined;
  let firstFile = false;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === '') {
      if (i + 5 >= fields.length) break;
      commit = { hash: fields[++i], shortHash: fields[++i], date: fields[++i], author: fields[++i], subject: fields[++i] };
      firstFile = true;
      continue;
    }
    // Git inserts one newline between the pretty format and the first -z pathname.
    const filePath = normalizePath(firstFile ? fields[i].replace(/^\n/, '') : fields[i]);
    firstFile = false;
    if (!commit || targets.has(filePath) || !isSourceTarget(filePath)) continue;
    const entry = companions.get(filePath) || { filePath, sharedCommitCount: 0, commits: [] };
    entry.sharedCommitCount++;
    if (entry.commits.length < MAX_SHARED_COMMIT_SAMPLES) entry.commits.push(commit);
    companions.set(filePath, entry);
  }
  return [...companions.values()]
    .sort((a, b) => b.sharedCommitCount - a.sharedCommitCount || a.filePath.localeCompare(b.filePath))
    .slice(0, boundedRelatedFileCount(limit));
}
