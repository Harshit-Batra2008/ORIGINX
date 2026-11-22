/**
 * GitWhisper Decision Memory — Historical Evidence Discovery Service
 * 
 * Inspects local Git repository history for a file or line range and discovers
 * candidate engineering decisions using deterministic, transparent heuristics.
 * 
 * Strict Guarantees:
 * - Operates entirely offline using local Git (no Neo4j, Copilot/LLM, network, or paid APIs).
 * - Never automatically saves or modifies decision records.
 * - Categorizes findings with transparent hypotheses (never presents inferences as proven intent).
 * - Never assigns invented confidence percentages.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  findRepoRoot,
  getUncommittedDiff,
  hasCommits,
  isFileTracked,
  isGitInstalled,
  parseBlamePorcelain,
  parseGitLogOutput,
  runGit,
  DEFAULT_GIT_TIMEOUT_MS,
  GitExecOptions
} from '../git/gitService';
import { CommitInfo } from '../git/gitTypes';
import { isSourceTarget } from '../git/sourcePaths';
import { resolveRepositoryFile } from '../security/repositoryFiles';
import {
  CandidateDecision,
  CandidateDecisionCategory,
  CodeAnchorContext,
  DiscoveredCommitReference,
  EvidenceDiscoveryLimitation,
  HistoricalEvidenceDiscoveryOptions,
  HistoricalEvidenceDiscoveryResult
} from './decisionEvidenceTypes';
import { CreateDecisionInput, DecisionAuthor, RelatedFileLink, SupportingEvidence } from './decisionTypes';
import { validateRelativeFilePath } from './decisionValidator';

export const DEFAULT_MAX_DISCOVERY_COMMITS = 25;

/**
 * Validates input parameters and normalizes the repository-relative path.
 */
function validateAndResolvePaths(
  repoRoot: string,
  filePath: string
): { resolvedRepoRoot: string; relativeFilePath: string; fullPath: string } {
  if (!repoRoot || typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new Error('repoRoot must be a non-empty string');
  }
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('filePath must be a non-empty string');
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const fullPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedRepoRoot, filePath);
  const relativeFilePath = path.relative(resolvedRepoRoot, fullPath).replace(/\\/g, '/');

  // Strict path traversal and Windows reserved name validation
  validateRelativeFilePath(relativeFilePath);

  return { resolvedRepoRoot, relativeFilePath, fullPath };
}

/**
 * Checks if a file appears to be a binary file.
 */
function isBinaryFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(4096);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true; // Null byte indicates binary format
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extracts a code snippet preview from disk for the specified line range.
 */
function extractContextSnippet(
  fullPath: string,
  startLine?: number,
  endLine?: number
): { snippet?: string; contentHash?: string } {
  if (!fs.existsSync(fullPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);

    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);

    if (start <= lines.length) {
      const selectedLines = lines.slice(start - 1, end);
      const snippet = selectedLines.join('\n');
      const contentHash = crypto.createHash('sha256').update(snippet, 'utf8').digest('hex');
      return { snippet, contentHash };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Determines whether a repository is a shallow clone with truncated history.
 */
async function checkIsShallowRepository(
  repoRoot: string,
  gitOpts: GitExecOptions
): Promise<boolean> {
  try {
    const shallowFile = path.join(repoRoot, '.git', 'shallow');
    if (fs.existsSync(shallowFile)) {
      return true;
    }
    const result = await runGit(['rev-parse', '--is-shallow-repository'], repoRoot, gitOpts);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Retrieves the list of files modified by a specific commit.
 */
async function getCommitChangedFiles(
  repoRoot: string,
  commitHash: string,
  gitOpts: GitExecOptions
): Promise<string[]> {
  try {
    const result = await runGit(['show', '--name-only', '-z', '--format=', commitHash], repoRoot, gitOpts);
    return result.exitCode === 0 ? result.stdout.split('\0').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic regex patterns for identifying candidate engineering decision categories.
 */
const CATEGORY_HEURISTICS: {
  category: CandidateDecisionCategory;
  patterns: RegExp[];
  addedLineSignal?: RegExp;
  defaultHypothesis: string;
  defaultFollowUp: string;
  constraintTemplate: (subject: string, shortHash: string) => string;
}[] = [
  {
    category: 'workaround',
    patterns: [
      /\b(workaround|work[\s-]around|hack|temporary fix|temp fix|kludge|upstream (?:issue|bug)|bypass|monkey[\s-]patch)\b/i
    ],
    addedLineSignal: /work[\s-]?around|upstream|fallback|temporary|monkey[\s-]?patch|kludge|bypass/i,
    defaultHypothesis:
      'Hypothesis: The author introduced this implementation to bypass an external, upstream, or environment constraint rather than as the ideal long-term architecture.',
    defaultFollowUp:
      'Check if the upstream dependency or defect has been resolved in newer releases so this workaround can be retired.',
    constraintTemplate: (s, h) => `Review whether the workaround described in "${s}" is still required [${h}].`
  },
  {
    category: 'security_constraint',
    patterns: [
      /\b(security|cve[-_]?\d+|vulnerab(?:ility|le)|saniti[zs](?:e|ed|ing|ation)|redact(?:s|ed|ing|ion)?|csrf|xss|injection)\b/i,
      /\b(?:reject|block|prevent|validate|verify|restrict|enforce|require)\w*\s+(?:\w+\s+){0,3}(?:access|authenticat\w*|authoriz\w*|permissions?|credentials?|tokens?|signatures?)\b/i
    ],
    addedLineSignal: /redact|saniti[sz]|unauthori[sz]ed|forbidden|denied|csrf|validateToken|verify(?:Token|Signature)|(?:has|check|enforce|require)(?:Permission|Auth|Role)/i,
    defaultHypothesis:
      'Hypothesis: Specific validation rules or restrictions were introduced to prevent security vulnerabilities or enforce access controls.',
    defaultFollowUp:
      'Review current security guidelines and threat models before modifying or relaxing these constraints.',
    constraintTemplate: (s, h) => `Check whether the guard described in "${s}" still applies before editing it [${h}].`
  },
  {
    category: 'revert',
    patterns: [
      /\b(revert(?:s|ed|ing)?|roll[\s-]back|rollback|backed out|undo(?:ne)?)\b/i
    ],
    defaultHypothesis:
      'Hypothesis: An earlier architectural approach or modification caused unexpected regression, requiring reversion to stable behavior.',
    defaultFollowUp:
      'Inspect the reverted commit history to understand why the rejected approach failed.',
    constraintTemplate: (s, h) => `Do not re-apply reverted pattern without addressing prior failure (${s} [${h}]).`
  },
  {
    category: 'compatibility',
    patterns: [
      /\b(compat(?:ibility)?|backwards?[\s-]compat(?:ible)?|legacy|fallback|polyfill|cross[\s-]platform|support for (?:node|windows|linux|macos|safari|firefox|chrome|v\d+)|interop|shim)\b/i
    ],
    defaultHypothesis:
      'Hypothesis: The code structure or fallback branch was implemented to preserve compatibility with older environments or external consumers.',
    defaultFollowUp:
      'Verify whether the targeted legacy platform, runtime, or API version is still supported by project policy.',
    constraintTemplate: (s, h) => `Preserve compatibility branch unless legacy requirements are deprecated (${s} [${h}]).`
  },
  {
    category: 'bug_fix',
    patterns: [
      /\b(fix(?:es|ed|ing)?|bug(?:s)?|issue(?:s)?|resolve(?:s|d|ing)?|patch(?:es|ed|ing)?|defect(?:s)?|race condition|deadlock|null pointer|crash(?:es|ed)?|error handling|panic)\b/i,
      /(?:#\d+|GH-\d+|[A-Z]{2,10}-\d+)/
    ],
    defaultHypothesis:
      'Hypothesis: The logic was modified to resolve an observed defect or race condition, though broader architectural intent requires team review.',
    defaultFollowUp:
      'Inspect the linked issue tracker, PR discussion, or regression test cases for this fix.',
    constraintTemplate: (s, h) => `Ensure bug regression tests pass and root cause remains addressed (${s} [${h}]).`
  },
  {
    category: 'architectural_migration',
    patterns: [
      /\b(migrat(?:e|ed|ing|ion)|refactor(?:ed|ing)?|deprecat(?:e|ed|ing|ion)|rewrite|architect(?:ure)?|restructur(?:e|ed|ing)|decoupl(?:e|ed|ing)|extract module|split out)\b/i
    ],
    defaultHypothesis:
      'Hypothesis: The structural changes represent an intentional architectural migration toward modular, decoupled boundaries.',
    defaultFollowUp:
      'Check if the architectural migration was fully realized or if intermediate transition shims remain in place.',
    constraintTemplate: (s, h) => `Preserve decoupled architectural boundary (${s} [${h}]).`
  },
  {
    category: 'performance_tradeoff',
    patterns: [
      /\b(perf(?:ormance)?|optimi[zs](?:e|ed|ing|ation)|latency|throughput|memory[\s-]leak|debounce|throttle|batch(?:ing)?|overhead|bottleneck|allocations?)\b/i,
      /\b(caching layer|caching strategy|cache tuning|add cache|optimize cache)\b/i
    ],
    defaultHypothesis:
      'Hypothesis: This implementation may deliberately prioritize runtime execution speed, memory footprint, or latency over simpler code structure.',
    defaultFollowUp:
      'Perform micro-benchmarks or profiler analysis against current performance standards before refactoring.',
    constraintTemplate: (s, h) => `Preserve performance characteristics and caching boundaries (${s} [${h}]).`
  }
];

/**
 * Analyzes discovered commits using deterministic heuristics and transparently constructs
 * candidate engineering decisions with empirical facts and labeled hypotheses.
 */
function discoverCandidatesFromCommits(
  commits: DiscoveredCommitReference[],
  anchor: CodeAnchorContext
): CandidateDecision[] {
  const candidates: CandidateDecision[] = [];

  for (const commit of commits) {
    // A release message can describe many unrelated changes. Attribute body text to
    // this anchor only for a single-file commit or a line that names its full path.
    const scopedBody = commit.changedFiles?.length === 1
      ? commit.body
      : commit.body.split(/\r?\n/).filter(line => line.includes(anchor.filePath)).join('\n');
    const message = `${commit.subject}\n${scopedBody}`;
    const matchedCategory = CATEGORY_HEURISTICS.find(rule => rule.patterns.some(pattern => pattern.test(message)));

    if (!matchedCategory) {
      // Unrelated chore, documentation typo, or formatting changes that do not match decision heuristics
      // are omitted from candidate decisions to avoid presenting routine commits as architectural decisions.
      continue;
    }

    // Security and workaround claims need corroboration in an added line of the
    // file-scoped patch. Context lines, filenames and removed guards do not qualify.
    const signal = matchedCategory.addedLineSignal;
    const addedLine = signal && commit.diffHunk?.split(/\r?\n/).find(line =>
      line.startsWith('+') && !line.startsWith('+++') && signal.test(line.slice(1))
    );
    if (signal && !addedLine) continue;

    // 1. Directly observed facts
    const facts: string[] = [
      `Commit ${commit.shortHash} authored by ${commit.authorName} on ${commit.commitDate}.`,
      `Commit subject: "${commit.subject}".`
    ];

    if (scopedBody.trim()) {
      const firstLine = scopedBody.trim().split(/\r?\n/)[0];
      facts.push(`Commit body excerpt: "${firstLine}".`);
    }
    if (addedLine) facts.push(`Added in ${anchor.filePath}: ${addedLine.slice(1).trim().slice(0, 200)}`);

    if (commit.changedFiles && commit.changedFiles.length > 1) {
      facts.push(
        `Git lists ${commit.changedFiles.length} files changed together in this commit.`
      );
    }

    // 2. Inferred rationale hypotheses (clearly labeled as hypotheses)
    const hypotheses: string[] = [matchedCategory.defaultHypothesis];

    // Explicit check for minimal or terse commit messages (e.g., "fix", "fix bug", "patch", "minor fix")
    const cleanSubject = commit.subject.trim();
    const isTerseMessage =
      /^(?:fix(?:es)?|bug(?:s)?|patch|update|minor|quick[\s-]fix|fix[\s-]bug|bug[\s-]fix|hotfix)$/i.test(cleanSubject) ||
      (cleanSubject.split(/\s+/).length <= 2 && /\b(fix|bug|patch)\b/i.test(cleanSubject));
    const missingEvidence: string[] = [];

    if (isTerseMessage) {
      missingEvidence.push(
        `Commit message is minimal ("${commit.subject}") with no issue tracker reference or rationale. Developer intent cannot be proven without external context.`
      );
      hypotheses.push(
        'Hypothesis: The change was an ad-hoc fix for an immediate symptom rather than an intentional architectural decision.'
      );
    } else {
      missingEvidence.push(
        'Developer confirmation of the intended scope of this change is still needed.'
      );
    }

    if (!commit.body || commit.body.trim().length === 0) {
      missingEvidence.push('Commit lacks a detailed commit body explaining alternatives considered or constraints.');
    }

    // 3. Suggested follow-up
    const followUp: string[] = [matchedCategory.defaultFollowUp];
    if (commit.authorEmail) {
      followUp.push(`Consult commit author (${commit.authorName} <${commit.authorEmail}>) to verify intended constraints.`);
    }

    // 4. Candidate title
    let candidateTitle = commit.subject;
    if (isTerseMessage) {
      candidateTitle = `Potential ${matchedCategory.category.replace('_', ' ')} in ${path.basename(anchor.filePath)}`;
    }

    // 5. Potential constraints
    const constraints: string[] = isTerseMessage ? [] : [
      matchedCategory.constraintTemplate(commit.subject, commit.shortHash)
    ];

    candidates.push({
      candidateTitle,
      category: matchedCategory.category,
      anchor,
      supportingCommits: [commit],
      directlyObservedFacts: facts,
      inferredRationaleHypotheses: hypotheses,
      missingOrAmbiguousEvidence: missingEvidence,
      suggestedFollowUp: followUp,
      potentialConstraints: constraints
    });
  }

  return candidates;
}

/**
 * Discovers historical Git evidence and candidate engineering decisions for a file or line range.
 * Runs completely offline and deterministically.
 */
export async function discoverHistoricalEvidence(
  repoRoot: string,
  filePath: string,
  options?: HistoricalEvidenceDiscoveryOptions
): Promise<HistoricalEvidenceDiscoveryResult> {
  const { resolvedRepoRoot, relativeFilePath, fullPath } = validateAndResolvePaths(repoRoot, filePath);

  const gitOpts: GitExecOptions = {
    timeoutMs: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    cancellationToken: options?.cancellationToken,
    abortSignal: options?.abortSignal
  };

  const isCancelled = () =>
    Boolean(options?.cancellationToken?.isCancellationRequested || options?.abortSignal?.aborted);

  const maxCommits = options?.maxCommits ?? DEFAULT_MAX_DISCOVERY_COMMITS;
  const limitations: EvidenceDiscoveryLimitation[] = [];

  // Anchor metadata
  const lineRange = options?.lineRange;
  if (lineRange) {
    if (lineRange.startLine < 1 || lineRange.endLine < lineRange.startLine) {
      throw new Error(`Invalid line range: [${lineRange.startLine}, ${lineRange.endLine}]. startLine must be >= 1 and endLine >= startLine.`);
    }
  }

  const anchor: CodeAnchorContext = {
    filePath: relativeFilePath,
    startLine: lineRange?.startLine,
    endLine: lineRange?.endLine
  };

  // 1. Check Git binary availability
  const gitInstalled = await isGitInstalled(gitOpts);
  if (!gitInstalled) {
    limitations.push({
      code: 'NO_GIT',
      description: 'Git executable was not found in PATH.'
    });
    return {
      status: 'no_git',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: false,
      message: 'Git executable not found in system PATH.'
    };
  }

  if (isCancelled()) {
    return {
      status: 'cancelled',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: false,
      message: 'Evidence discovery cancelled by caller.'
    };
  }

  // 2. Verify repository root
  const verifiedRoot = await findRepoRoot(resolvedRepoRoot, gitOpts);
  if (!verifiedRoot || path.relative(fs.realpathSync(verifiedRoot), fs.realpathSync(resolvedRepoRoot)) !== '') {
    limitations.push({
      code: 'NOT_A_REPO',
      description: `Target path "${resolvedRepoRoot}" is not inside a valid Git repository.`
    });
    return {
      status: 'not_a_repo',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: false,
      message: 'Repository root is not a Git repository.'
    };
  }

  // 3. Check for shallow repository
  const isShallow = await checkIsShallowRepository(resolvedRepoRoot, gitOpts);
  if (isShallow) {
    limitations.push({
      code: 'SHALLOW_REPOSITORY',
      description: 'Repository is a shallow clone; historical ancestor commits and origin decisions may be truncated.'
    });
  }

  // 4. Verify repository has commits
  const repoHasCommits = await hasCommits(resolvedRepoRoot, gitOpts);
  if (!repoHasCommits) {
    limitations.push({
      code: 'EMPTY_REPO',
      description: 'Repository has no commits on HEAD.'
    });
    return {
      status: 'empty_repo',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: isShallow,
      message: 'The Git repository has no commits yet.'
    };
  }

  // 5. Binary file detection
  const existingFile = resolveRepositoryFile(resolvedRepoRoot, relativeFilePath);
  if (existingFile && isBinaryFile(existingFile)) {
    limitations.push({
      code: 'BINARY_FILE',
      description: 'Target is a binary file; line-level diffs and code anchors are unsupported.'
    });
    return {
      status: 'binary_file',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: isShallow,
      message: 'Binary file format; code-level history analysis is unsupported.'
    };
  }

  // 6. Check tracking and deletion state
  const fileExistsOnDisk = existingFile !== undefined;
  const isTracked = await isFileTracked(resolvedRepoRoot, relativeFilePath, gitOpts);

  if (!fileExistsOnDisk) {
    if (isTracked) {
      // Tracked in index/HEAD but deleted from working tree
      limitations.push({
        code: 'DELETED_FILE',
        description: 'File has been deleted from working tree. Historical evidence is retrieved from commit history.'
      });
    } else {
      // Check if it existed in HEAD commit history before deletion
      const headCheck = await runGit(['ls-tree', 'HEAD', '--', relativeFilePath], resolvedRepoRoot, gitOpts);
      if (headCheck.exitCode === 0 && headCheck.stdout.trim().length > 0) {
        limitations.push({
          code: 'DELETED_FILE',
          description: 'File has been deleted from working tree. Historical evidence is retrieved from commit history.'
        });
      } else {
        // Check if it existed in any prior commit
        const logCheck = await runGit(['log', '-n', '1', '--', relativeFilePath], resolvedRepoRoot, gitOpts);
        if (logCheck.exitCode === 0 && logCheck.stdout.trim().length > 0) {
          limitations.push({
            code: 'DELETED_FILE',
            description: 'File has been deleted from repository. Historical evidence is retrieved from commit history.'
          });
        } else {
          limitations.push({
            code: 'NO_HISTORY_FOR_RANGE',
            description: `File "${relativeFilePath}" does not exist and has no Git commit history.`
          });
          return {
            status: 'no_history',
            repoRoot: resolvedRepoRoot,
            relativeFilePath,
            anchor,
            commits: [],
            candidateDecisions: [],
            retrievalSource: 'git_log_file',
            limitations,
            hasUncommittedChanges: false,
            isShallowRepo: isShallow,
            message: `File "${relativeFilePath}" does not exist in repository.`
          };
        }
      }
    }
  } else if (!isTracked) {
    // Exists on disk, but untracked by Git
    limitations.push({
      code: 'UNTRACKED_FILE',
      description: `File "${relativeFilePath}" is not tracked by Git; no commit history exists.`
    });
    return {
      status: 'untracked_file',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource: 'git_log_file',
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: isShallow,
      message: `File "${relativeFilePath}" is untracked by Git.`
    };
  }

  if (existingFile) {
    const { snippet, contentHash } = extractContextSnippet(existingFile, lineRange?.startLine, lineRange?.endLine);
    anchor.contextSnippet = snippet;
    anchor.contentHash = contentHash;
  }

  // 7. Check for uncommitted working tree changes
  let hasUncommitted = false;
  let uncommittedDiff: string | undefined;

  try {
    const diff = await getUncommittedDiff(resolvedRepoRoot, relativeFilePath, gitOpts);
    if (diff && diff.trim().length > 0) {
      hasUncommitted = true;
      uncommittedDiff = diff;
      limitations.push({
        code: 'UNCOMMITTED_CHANGES',
        description: 'Uncommitted modifications exist in the working tree that are not yet recorded in Git history.'
      });
    }
  } catch {}

  // 8. Retrieve commits
  let rawCommits: CommitInfo[] = [];
  let retrievalSource: 'git_log_range' | 'git_blame_fallback' | 'git_log_file' | 'working_tree_only' = 'git_log_file';

  if (lineRange) {
    // Attempt git log -L first
    const start = Math.max(1, lineRange.startLine);
    const end = Math.max(start, lineRange.endLine);

    const logLResult = await runGit(
      ['-c', 'core.quotepath=false', 'log', '-L', `${start},${end}:${relativeFilePath}`, '--no-color', `-n`, `${maxCommits}`],
      resolvedRepoRoot,
      gitOpts
    );

    if (logLResult.exitCode === 0 && logLResult.stdout.trim().length > 0) {
      rawCommits = parseGitLogOutput(logLResult.stdout);
      retrievalSource = 'git_log_range';
    } else {
      // Fallback to git blame
      const blameResult = await runGit(
        ['-c', 'core.quotepath=false', 'blame', '--line-porcelain', '-L', `${start},${end}`, '--', relativeFilePath],
        resolvedRepoRoot,
        gitOpts
      );

      if (blameResult.exitCode === 0 && blameResult.stdout.trim().length > 0) {
        const blameData = parseBlamePorcelain(blameResult.stdout);
        const cappedHashes = blameData.hashes.slice(0, maxCommits);

        for (const hash of cappedHashes) {
          if (isCancelled()) break;
          const showResult = await runGit(
            ['-c', 'core.quotepath=false', 'show', '--format=fuller', '-p', hash, '--', relativeFilePath],
            resolvedRepoRoot,
            gitOpts
          );
          if (showResult.exitCode === 0 && showResult.stdout.trim().length > 0) {
            rawCommits.push(...parseGitLogOutput(showResult.stdout));
          }
        }
        retrievalSource = 'git_blame_fallback';
        limitations.push({
          code: 'LINE_RANGE_OUTSIDE_HEAD',
          description: 'Line range could not be tracked via git log -L directly; retrieved line history via git blame fallback.'
        });
      }
    }
  } else {
    // Whole-file history using --follow
    const logFileResult = await runGit(
      ['-c', 'core.quotepath=false', 'log', '--follow', '-p', '--format=fuller', '--no-color', `-n`, `${maxCommits}`, '--', relativeFilePath],
      resolvedRepoRoot,
      gitOpts
    );

    if (logFileResult.exitCode === 0 && logFileResult.stdout.trim().length > 0) {
      rawCommits = parseGitLogOutput(logFileResult.stdout);
      retrievalSource = 'git_log_file';
    }
  }

  // De-duplicate commits by full 40-character SHA
  const seenHashes = new Set<string>();
  const uniqueRawCommits = rawCommits.filter((c) => {
    if (seenHashes.has(c.hash)) return false;
    seenHashes.add(c.hash);
    return true;
  });

  if (uniqueRawCommits.length >= maxCommits) {
    limitations.push({
      code: 'HISTORY_TRUNCATED',
      description: `History capped at ${maxCommits} commits to ensure responsiveness.`
    });
  }

  // 9. Enhance commits with changed files metadata
  const discoveredCommits: DiscoveredCommitReference[] = [];
  for (const c of uniqueRawCommits) {
    if (isCancelled()) break;
    const changedFiles = await getCommitChangedFiles(resolvedRepoRoot, c.hash, gitOpts);
    discoveredCommits.push({
      origin: retrievalSource === 'git_blame_fallback' ? 'git_blame' : 'git_log',
      hash: c.hash,
      shortHash: c.shortHash,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      commitDate: c.date,
      subject: c.subject,
      body: c.body,
      diffHunk: c.diff,
      changedFiles,
      relevanceReason: `Commit touched ${relativeFilePath}`
    });
  }

  // 10. Run deterministic candidate engineering decision heuristics
  const candidateDecisions = discoverCandidatesFromCommits(discoveredCommits, anchor);

  // Status mapping
  if (discoveredCommits.length === 0) {
    if (hasUncommitted) {
      return {
        status: 'ok',
        repoRoot: resolvedRepoRoot,
        relativeFilePath,
        anchor,
        commits: [],
        candidateDecisions: [],
        retrievalSource: 'working_tree_only',
        limitations,
        hasUncommittedChanges: true,
        uncommittedDiff,
        isShallowRepo: isShallow,
        message: 'Selected target only exists in uncommitted working tree changes.'
      };
    }

    limitations.push({
      code: 'NO_HISTORY_FOR_RANGE',
      description: 'No commits touched the specified target location.'
    });
    return {
      status: 'no_history',
      repoRoot: resolvedRepoRoot,
      relativeFilePath,
      anchor,
      commits: [],
      candidateDecisions: [],
      retrievalSource,
      limitations,
      hasUncommittedChanges: false,
      isShallowRepo: isShallow,
      message: 'No Git commit history found for target.'
    };
  }

  return {
    status: 'ok',
    repoRoot: resolvedRepoRoot,
    relativeFilePath,
    anchor,
    commits: discoveredCommits,
    candidateDecisions,
    retrievalSource,
    limitations,
    hasUncommittedChanges: hasUncommitted,
    uncommittedDiff,
    isShallowRepo: isShallow
  };
}

/**
 * Converts a candidate decision into a proposed Decision Memory input structure
 * ready for subsequent human or automated review.
 * 
 * NOTE: This function only produces the in-memory object and DOES NOT write to disk.
 */
export function convertCandidateToProposedDecision(
  candidate: CandidateDecision,
  author: DecisionAuthor
): CreateDecisionInput {
  const rationaleParts: string[] = [
    `### Directly Observed Historical Evidence\n${candidate.directlyObservedFacts.map((f) => `- ${f}`).join('\n')}`,
    `\n### Inferred Hypotheses (Unverified)\n${candidate.inferredRationaleHypotheses.map((h) => `- ${h}`).join('\n')}`
  ];

  if (candidate.missingOrAmbiguousEvidence.length > 0) {
    rationaleParts.push(
      `\n### Missing or Ambiguous Evidence\n${candidate.missingOrAmbiguousEvidence.map((m) => `- ${m}`).join('\n')}`
    );
  }

  if (candidate.suggestedFollowUp.length > 0) {
    rationaleParts.push(
      `\n### Recommended Follow-Up\n${candidate.suggestedFollowUp.map((u) => `- ${u}`).join('\n')}`
    );
  }

  const supportingEvidence: SupportingEvidence[] = candidate.supportingCommits.map((c) => ({
    commitHash: c.hash,
    shortHash: c.shortHash,
    commitDate: c.commitDate,
    author: `${c.authorName}${c.authorEmail ? ` <${c.authorEmail}>` : ''}`,
    subject: c.subject,
    body: c.body,
    diffHunk: c.diffHunk,
    origin: c.origin,
    isHypothesis: false
  }));

  const constraints = candidate.potentialConstraints.map((c, idx) => ({
    id: `C${idx + 1}`,
    description: c,
    reason: `Suggested for developer review from "${candidate.candidateTitle}".`,
    severity: 'advisory' as const
  }));

  // Identify companion files changed together in supporting commits
  const companionFiles = new Map<string, RelatedFileLink>();
  for (const commit of candidate.supportingCommits) {
    for (const filePath of commit.changedFiles || []) {
      if (filePath === candidate.anchor.filePath || !isSourceTarget(filePath) || companionFiles.has(filePath)) continue;
      companionFiles.set(filePath, {
        filePath,
        couplingReason: `Changed together in commit ${commit.shortHash}.`,
        isDirectDependency: false
      });
    }
  }

  return {
    title: candidate.candidateTitle,
    rationale: rationaleParts.join('\n\n'),
    primaryAnchor: {
      filePath: candidate.anchor.filePath,
      startLine: candidate.anchor.startLine,
      endLine: candidate.anchor.endLine,
      contextSnippet: candidate.anchor.contextSnippet,
      contentHash: candidate.anchor.contentHash
    },
    relatedFiles: Array.from(companionFiles.values()),
    evidence: supportingEvidence,
    hasDirectGitEvidence: supportingEvidence.length > 0,
    constraints,
    status: 'proposed',
    createdBy: author,
    tags: [candidate.category, 'historical-discovery']
  };
}
