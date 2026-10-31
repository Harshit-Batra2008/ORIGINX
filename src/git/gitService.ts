import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CommitInfo, GitHistoryResult, SelectionContext } from './gitTypes';

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ICancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose: () => void };
}

export interface GitExecOptions {
  cwd?: string;
  timeoutMs?: number;
  cancellationToken?: ICancellationTokenLike;
  abortSignal?: AbortSignal;
  maxBuffer?: number;
}

export interface HistorySelectionOptions {
  cancellationToken?: ICancellationTokenLike;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_GIT_TIMEOUT_MS = 25000; // 25-second bounded execution
export const DEFAULT_GIT_MAX_BUFFER = 15 * 1024 * 1024; // 15MB buffer for large diffs/logs
export const MAX_BLAME_COMMITS = 25; // Safe cap on sequential fallback commits

/**
 * Executes a Git command safely using execFile without invoking a shell.
 * Includes timeout boundaries, cancellation support, and robust child process cleanup.
 */
export function runGit(
  args: string[],
  cwd: string,
  options?: GitExecOptions
): Promise<GitExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBuffer = options?.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    // 1. Check if cancellation has already occurred
    if (options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted) {
      return resolve({
        stdout: '',
        stderr: 'Git operation was cancelled by user.',
        exitCode: 130
      });
    }

    let isDone = false;
    let timer: NodeJS.Timeout | undefined;
    let cancelDisposable: { dispose: () => void } | undefined;

    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (isDone) return;
        isDone = true;
        if (timer) clearTimeout(timer);
        if (cancelDisposable) cancelDisposable.dispose();

        if (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(new Error('GIT_NOT_FOUND'));
          }

          let errDetail = stderr ? stderr.toString() : error.message;
          if ((error as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            errDetail = `Git output exceeded maximum buffer limit (${Math.round(maxBuffer / (1024 * 1024))}MB). Range may be too large.`;
          }

          return resolve({
            stdout: stdout ? stdout.toString() : '',
            stderr: errDetail,
            exitCode: typeof error.code === 'number' ? error.code : 1
          });
        }

        resolve({
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : '',
          exitCode: 0
        });
      }
    );

    // 2. Safe error listener for immediate spawn failures
    child.on('error', (err) => {
      if (isDone) return;
      isDone = true;
      if (timer) clearTimeout(timer);
      if (cancelDisposable) cancelDisposable.dispose();

      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error('GIT_NOT_FOUND'));
      }
      resolve({
        stdout: '',
        stderr: `Failed to spawn Git subprocess: ${err.message}`,
        exitCode: 1
      });
    });

    // 3. Child process termination helper
    const killChild = (reason: string, code: number) => {
      if (isDone) return;
      isDone = true;
      if (timer) clearTimeout(timer);
      if (cancelDisposable) cancelDisposable.dispose();

      try {
        child.kill('SIGTERM');
        // Fallback hard kill after 500ms if process remains alive
        const killTimer = setTimeout(() => {
          try {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          } catch {}
        }, 500);
        if (killTimer.unref) {
          killTimer.unref();
        }
      } catch {}

      resolve({
        stdout: '',
        stderr: reason,
        exitCode: code
      });
    };

    // 4. Timeout boundary
    if (timeoutMs > 0 && timeoutMs !== Infinity) {
      timer = setTimeout(() => {
        killChild(`Git operation timed out after ${timeoutMs}ms.`, 124);
      }, timeoutMs);
    }

    // 5. Cancellation listeners
    if (options?.cancellationToken) {
      cancelDisposable = options.cancellationToken.onCancellationRequested(() => {
        killChild('Git operation was cancelled by user.', 130);
      });
    }

    if (options?.abortSignal) {
      options.abortSignal.addEventListener(
        'abort',
        () => {
          killChild('Git operation was cancelled by user.', 130);
        },
        { once: true }
      );
    }
  });
}

/**
 * Checks if Git is installed and available in the environment.
 */
export async function isGitInstalled(options?: GitExecOptions): Promise<boolean> {
  try {
    const result = await runGit(['--version'], process.cwd(), options);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Finds the Git repository root directory for the given file or directory.
 * Returns null if not in a Git repository.
 */
export async function findRepoRoot(
  targetPath: string,
  options?: GitExecOptions
): Promise<string | null> {
  try {
    let dir = targetPath;
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        dir = path.dirname(targetPath);
      }
    } else {
      dir = path.dirname(targetPath);
    }

    const result = await runGit(['rev-parse', '--show-toplevel'], dir, options);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return path.normalize(result.stdout.trim());
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Checks if the repository currently has any commits.
 */
export async function hasCommits(repoRoot: string, options?: GitExecOptions): Promise<boolean> {
  try {
    const result = await runGit(['rev-parse', 'HEAD'], repoRoot, options);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Checks if the specified file is tracked by Git.
 */
export async function isFileTracked(
  repoRoot: string,
  relativeFilePath: string,
  options?: GitExecOptions
): Promise<boolean> {
  try {
    const result = await runGit(['ls-files', '--error-unmatch', '--', relativeFilePath], repoRoot, options);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Retrieves uncommitted working tree diff for a file against HEAD.
 */
export async function getUncommittedDiff(
  repoRoot: string,
  relativeFilePath: string,
  options?: GitExecOptions
): Promise<string | null> {
  try {
    const result = await runGit(['diff', 'HEAD', '--', relativeFilePath], repoRoot, options);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses raw git log output (from git log -L or git show) into CommitInfo items.
 */
export function parseGitLogOutput(raw: string): CommitInfo[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  // Find all commit boundaries
  const commitRegex = /^commit ([0-9a-f]{40})/gm;
  const matches: { index: number; hash: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = commitRegex.exec(raw)) !== null) {
    matches.push({ index: match.index, hash: match[1] });
  }

  if (matches.length === 0) {
    return [];
  }

  const commits: CommitInfo[] = [];

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const block = raw.substring(cur.index, nextIndex);

    // Extract Author
    const authorMatch = block.match(/^Author:\s+(.+?)(?:\s+<([^>]+)>)?$/m);
    const authorName = authorMatch ? authorMatch[1].trim() : 'Unknown';
    const authorEmail = authorMatch && authorMatch[2] ? authorMatch[2].trim() : '';

    // Extract Date (supports standard Date: and fuller AuthorDate:)
    const dateMatch = block.match(/^(?:Date|AuthorDate):\s+(.+)$/m);
    const date = dateMatch ? dateMatch[1].trim() : '';

    // Separate commit message from the diff
    let diff = '';
    let messagePart = block;

    const diffStartRegex = /\n(diff --git [^\n]+[\s\S]*)$/;
    const diffMatch = block.match(diffStartRegex);

    if (diffMatch && typeof diffMatch.index === 'number') {
      messagePart = block.substring(0, diffMatch.index);
      diff = diffMatch[1].trim();
    }

    // Process commit message lines
    const lines = messagePart.split(/\r?\n/);
    const contentLines: string[] = [];
    let pastHeaders = false;

    const gitHeaderRegex = /^(?:commit\s+[0-9a-f]{40}|Author:\s+|AuthorDate:\s+|Commit:\s+|CommitDate:\s+|Date:\s+|Merge:\s+|gpg:\s+|parent\s+|tree\s+)/i;

    for (const line of lines) {
      if (!pastHeaders) {
        if (line.trim() === '') {
          pastHeaders = true;
          continue;
        }
        if (gitHeaderRegex.test(line)) {
          continue;
        }
      }
      contentLines.push(line.replace(/^\s{4}/, ''));
    }

    const fullMessage = contentLines.join('\n').trim();
    const firstLineBreak = fullMessage.indexOf('\n');
    let subject = fullMessage;
    let body = '';

    if (firstLineBreak !== -1) {
      subject = fullMessage.substring(0, firstLineBreak).trim();
      body = fullMessage.substring(firstLineBreak + 1).trim();
    }

    // Clean subject: ensure Git header metadata is never mistaken for a commit message
    if (gitHeaderRegex.test(subject) || /^(?:AuthorDate|CommitDate|Author|Commit|Date):/i.test(subject)) {
      subject = '';
    }

    commits.push({
      hash: cur.hash,
      shortHash: cur.hash.substring(0, 7),
      authorName,
      authorEmail,
      date,
      subject: subject || '(No commit message)',
      body,
      diff
    });
  }

  return commits;
}

/**
 * Parses git blame --line-porcelain output to find distinct commit hashes and uncommitted lines.
 */
export function parseBlamePorcelain(raw: string): { hashes: string[]; uncommittedLines: number[] } {
  const lines = raw.split(/\r?\n/);
  const hashes = new Set<string>();
  const uncommittedLines: number[] = [];

  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (match) {
      const hash = match[1];
      const finalLine = parseInt(match[2], 10);
      if (/^0{40}$/.test(hash)) {
        uncommittedLines.push(finalLine);
      } else {
        hashes.add(hash);
      }
    }
  }

  return {
    hashes: Array.from(hashes),
    uncommittedLines
  };
}

/**
 * Main coordinator function to retrieve Git history for a selected code range.
 * Supports cancellation and bounded execution to prevent Extension Host resource exhaustion.
 */
export async function getHistoryForSelection(
  selection: SelectionContext,
  options?: HistorySelectionOptions
): Promise<GitHistoryResult> {
  const isCancelled = () =>
    Boolean(options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted);

  if (isCancelled()) {
    return {
      status: 'cancelled',
      selection,
      commits: [],
      message: 'Git history retrieval was cancelled.'
    };
  }

  const gitOpts: GitExecOptions = {
    timeoutMs: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    cancellationToken: options?.cancellationToken,
    abortSignal: options?.abortSignal
  };

  // 1. Verify Git is installed
  const gitInstalled = await isGitInstalled(gitOpts);
  if (!gitInstalled) {
    if (isCancelled()) {
      return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
    }
    return {
      status: 'no_git',
      selection,
      commits: [],
      message: 'Git executable not found in PATH. Please verify Git is installed.'
    };
  }

  if (isCancelled()) {
    return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
  }

  // 2. Verify file belongs to a Git repository
  const repoRoot = await findRepoRoot(selection.filePath, gitOpts);
  if (!repoRoot) {
    if (isCancelled()) {
      return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
    }
    return {
      status: 'not_a_repo',
      selection,
      commits: [],
      message: `File "${selection.fileName}" is not inside a Git repository.`
    };
  }

  if (isCancelled()) {
    return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
  }

  // 3. Verify repo has at least one commit
  const repoHasCommits = await hasCommits(repoRoot, gitOpts);
  if (!repoHasCommits) {
    if (isCancelled()) {
      return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
    }
    return {
      status: 'empty_repo',
      selection,
      repoRoot,
      commits: [],
      message: 'The repository does not have any commits yet.'
    };
  }

  // Compute Git-compatible relative file path with forward slashes
  const relativeFilePath = path.relative(repoRoot, selection.filePath).replace(/\\/g, '/');

  if (isCancelled()) {
    return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
  }

  // 4. Verify file is tracked
  const tracked = await isFileTracked(repoRoot, relativeFilePath, gitOpts);
  if (!tracked) {
    if (isCancelled()) {
      return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
    }
    return {
      status: 'untracked_file',
      selection,
      repoRoot,
      relativeFilePath,
      commits: [],
      message: `File "${selection.fileName}" is untracked and has no Git history.`
    };
  }

  if (isCancelled()) {
    return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
  }

  // 5. Check for uncommitted working tree changes
  const uncommittedDiff = await getUncommittedDiff(repoRoot, relativeFilePath, gitOpts);
  const hasUncommittedChanges = Boolean(uncommittedDiff);

  if (isCancelled()) {
    return { status: 'cancelled', selection, commits: [], message: 'Git operation was cancelled.' };
  }

  // 6. Retrieve line-range history using git log -L
  const start = Math.max(1, selection.startLine);
  const end = Math.max(start, selection.endLine);

  let commits: CommitInfo[] = [];
  let boundedNotice: string | undefined;

  const logLResult = await runGit(
    ['log', '-L', `${start},${end}:${relativeFilePath}`, '--no-color'],
    repoRoot,
    gitOpts
  );

  if (isCancelled() || logLResult.exitCode === 130) {
    return {
      status: 'cancelled',
      selection,
      repoRoot,
      relativeFilePath,
      commits: [],
      hasUncommittedChanges,
      uncommittedDiff: uncommittedDiff ?? undefined,
      message: 'Git operation was cancelled by user.'
    };
  }

  if (logLResult.exitCode === 0 && logLResult.stdout.trim().length > 0) {
    commits = parseGitLogOutput(logLResult.stdout);
  } else {
    // If git log -L failed (e.g. range outside HEAD due to local uncommitted additions),
    // fallback to git blame --line-porcelain to find prior commits for overlapping lines.
    const blameResult = await runGit(
      ['blame', '--line-porcelain', '-L', `${start},${end}`, '--', relativeFilePath],
      repoRoot,
      gitOpts
    );

    if (isCancelled() || blameResult.exitCode === 130) {
      return {
        status: 'cancelled',
        selection,
        repoRoot,
        relativeFilePath,
        commits: [],
        hasUncommittedChanges,
        uncommittedDiff: uncommittedDiff ?? undefined,
        message: 'Git operation was cancelled by user.'
      };
    }

    if (blameResult.exitCode === 0 && blameResult.stdout.trim().length > 0) {
      const blameData = parseBlamePorcelain(blameResult.stdout);

      // Bound fallback sequential execution to MAX_BLAME_COMMITS to protect Extension Host
      const cappedHashes = blameData.hashes.slice(0, MAX_BLAME_COMMITS);
      if (blameData.hashes.length > MAX_BLAME_COMMITS) {
        boundedNotice = `Evidence bounded to the ${MAX_BLAME_COMMITS} most recent commits (of ${blameData.hashes.length} total touching this range).`;
      }

      for (const hash of cappedHashes) {
        if (isCancelled()) {
          break;
        }
        const showResult = await runGit(
          ['show', '--format=fuller', '-p', hash, '--', relativeFilePath],
          repoRoot,
          gitOpts
        );
        if (showResult.exitCode === 0 && showResult.stdout.trim().length > 0) {
          const parsed = parseGitLogOutput(showResult.stdout);
          commits.push(...parsed);
        }
      }
    }
  }

  // De-duplicate commits by hash if any overlap
  const seenHashes = new Set<string>();
  const uniqueCommits = commits.filter((c) => {
    if (seenHashes.has(c.hash)) {
      return false;
    }
    seenHashes.add(c.hash);
    return true;
  });

  if (uniqueCommits.length > 0) {
    return {
      status: 'ok',
      selection,
      repoRoot,
      relativeFilePath,
      commits: uniqueCommits,
      hasUncommittedChanges,
      uncommittedDiff: uncommittedDiff ?? undefined,
      message: boundedNotice
    };
  }

  if (hasUncommittedChanges) {
    return {
      status: 'uncommitted_only',
      selection,
      repoRoot,
      relativeFilePath,
      commits: [],
      hasUncommittedChanges: true,
      uncommittedDiff: uncommittedDiff ?? undefined,
      message: 'Selected lines are uncommitted local additions.'
    };
  }

  return {
    status: 'no_history_for_selection',
    selection,
    repoRoot,
    relativeFilePath,
    commits: [],
    hasUncommittedChanges: false,
    message: boundedNotice || 'No Git commit history found for the selected lines.'
  };
}
