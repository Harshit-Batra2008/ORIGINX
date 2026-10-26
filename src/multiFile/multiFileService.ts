import { getUncommittedDiff, ICancellationTokenLike, parseGitLogOutput, runGit } from '../git/gitService';
import { CommitInfo } from '../git/gitTypes';
import { FileEvidence, FileValidationItem, MultiFileEvidenceResult } from './multiFileTypes';

export const DEFAULT_MAX_COMMITS_PER_FILE = 10;
export const MAX_DIFF_CHARS_PER_FILE = 60000;

/**
 * Gathers bounded Git evidence for an array of validated eligible files.
 * Supports cancellation and bounds output to prevent host memory exhaustion.
 */
export async function gatherMultiFileGitEvidence(
  files: FileValidationItem[],
  options?: {
    cancellationToken?: ICancellationTokenLike;
    abortSignal?: AbortSignal;
    maxCommitsPerFile?: number;
    timeoutMs?: number;
  }
): Promise<MultiFileEvidenceResult> {
  const maxCommits = options?.maxCommitsPerFile ?? DEFAULT_MAX_COMMITS_PER_FILE;
  const fileEvidences: FileEvidence[] = [];
  const truncationWarnings: string[] = [];

  for (const file of files) {
    if (options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted) {
      return {
        files: fileEvidences,
        totalCommits: fileEvidences.reduce((acc, f) => acc + f.commits.length, 0),
        totalDiffChars: fileEvidences.reduce((acc, f) => acc + f.totalDiffChars, 0),
        isCancelled: true,
        truncationWarnings
      };
    }

    if (!file.repoRoot || !file.relativeFilePath) {
      continue;
    }

    try {
      // 1. Fetch uncommitted working tree diff
      const uncommittedDiff = await getUncommittedDiff(file.repoRoot, file.relativeFilePath, {
        cancellationToken: options?.cancellationToken,
        abortSignal: options?.abortSignal,
        timeoutMs: options?.timeoutMs
      });
      const hasUncommittedChanges = Boolean(uncommittedDiff);

      // 2. Fetch recent commit history for the file
      const logResult = await runGit(
        [
          'log',
          `-n${maxCommits}`,
          '--format=fuller',
          '-p',
          '--no-color',
          '--',
          file.relativeFilePath
        ],
        file.repoRoot,
        {
          cancellationToken: options?.cancellationToken,
          abortSignal: options?.abortSignal,
          timeoutMs: options?.timeoutMs
        }
      );

      if (logResult.exitCode === 130) {
        return {
          files: fileEvidences,
          totalCommits: fileEvidences.reduce((acc, f) => acc + f.commits.length, 0),
          totalDiffChars: fileEvidences.reduce((acc, f) => acc + f.totalDiffChars, 0),
          isCancelled: true,
          truncationWarnings
        };
      }

      let commits: CommitInfo[] = [];
      if (logResult.exitCode === 0 && logResult.stdout.trim().length > 0) {
        commits = parseGitLogOutput(logResult.stdout);
      }

      // Check diff size bounding
      let totalDiffChars = (uncommittedDiff ? uncommittedDiff.length : 0);
      let isBounded = false;

      for (const c of commits) {
        if (c.diff) {
          totalDiffChars += c.diff.length;
        }
      }

      if (totalDiffChars > MAX_DIFF_CHARS_PER_FILE) {
        isBounded = true;
        truncationWarnings.push(
          `${file.fileName}: diff evidence exceeds ${Math.round(MAX_DIFF_CHARS_PER_FILE / 1000)}k chars and will be bounded during synthesis.`
        );
      }

      fileEvidences.push({
        file,
        commits,
        uncommittedDiff: uncommittedDiff ?? undefined,
        hasUncommittedChanges,
        totalDiffChars,
        isBounded,
        status: commits.length > 0 || hasUncommittedChanges ? 'ok' : 'no_history'
      });
    } catch (err: any) {
      fileEvidences.push({
        file,
        commits: [],
        hasUncommittedChanges: false,
        totalDiffChars: 0,
        isBounded: false,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const totalCommits = fileEvidences.reduce((acc, f) => acc + f.commits.length, 0);
  const totalDiffChars = fileEvidences.reduce((acc, f) => acc + f.totalDiffChars, 0);

  return {
    files: fileEvidences,
    totalCommits,
    totalDiffChars,
    isCancelled: false,
    truncationWarnings
  };
}
