/**
 * GitWhisper Decision Memory — Historical Evidence Discovery Types
 * Defines data structures for discovering and structuring Git commit history
 * and deterministic candidate engineering decisions.
 */

export type CandidateDecisionCategory =
  | 'bug_fix'
  | 'compatibility'
  | 'workaround'
  | 'revert'
  | 'performance_tradeoff'
  | 'security_constraint'
  | 'architectural_migration'
  | 'general_evolution';

export interface CodeAnchorContext {
  filePath: string;
  startLine?: number;
  endLine?: number;
  contextSnippet?: string;
  contentHash?: string;
}

export interface DiscoveredCommitReference {
  origin: 'git_log' | 'git_blame';
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  commitDate: string;
  subject: string;
  body: string;
  diffHunk?: string;
  changedFiles?: string[];
  relevanceReason: string;
}

export interface CandidateDecision {
  /** Concise summary title of the candidate decision */
  candidateTitle: string;

  /** Identified category based on deterministic heuristics */
  category: CandidateDecisionCategory;

  /** Relevant code location in the repository */
  anchor: CodeAnchorContext;

  /** Supporting Git commits directly verified against local repository history */
  supportingCommits: DiscoveredCommitReference[];

  /** Directly observed, empirical facts extracted from commit history and diffs */
  directlyObservedFacts: string[];

  /**
   * Transparently labeled hypotheses regarding developer intent or rationale.
   * Every entry MUST be prefixed with "Hypothesis:" to avoid pretending to know unrecorded intent.
   */
  inferredRationaleHypotheses: string[];

  /** Missing, unverified, or ambiguous evidence in the commit history */
  missingOrAmbiguousEvidence: string[];

  /** Concrete suggestions for the developer to investigate before recording a permanent decision */
  suggestedFollowUp: string[];

  /** Inferred potential constraints to preserve */
  potentialConstraints: string[];
}

export type EvidenceRetrievalSource =
  | 'git_log_range'
  | 'git_blame_fallback'
  | 'git_log_file'
  | 'working_tree_only';

export interface EvidenceDiscoveryLimitation {
  code:
    | 'SHALLOW_REPOSITORY'
    | 'UNTRACKED_FILE'
    | 'NOT_A_REPO'
    | 'NO_GIT'
    | 'EMPTY_REPO'
    | 'NO_HISTORY_FOR_RANGE'
    | 'LINE_RANGE_OUTSIDE_HEAD'
    | 'DELETED_FILE'
    | 'RENAMED_FILE'
    | 'BINARY_FILE'
    | 'UNCOMMITTED_CHANGES'
    | 'HISTORY_TRUNCATED'
    | 'MISSING_COMMIT_OBJECT'
    | 'UNSAFE_PATH';
  description: string;
}

export type EvidenceDiscoveryStatus =
  | 'ok'
  | 'no_git'
  | 'not_a_repo'
  | 'untracked_file'
  | 'empty_repo'
  | 'no_history'
  | 'binary_file'
  | 'cancelled'
  | 'error';

export interface HistoricalEvidenceDiscoveryResult {
  /** Overall status of the discovery operation */
  status: EvidenceDiscoveryStatus;

  /** Absolute path to the repository root */
  repoRoot: string;

  /** POSIX-style repository-relative file path */
  relativeFilePath: string;

  /** Targeted code anchor location */
  anchor: CodeAnchorContext;

  /** All relevant commits discovered for this file or line range */
  commits: DiscoveredCommitReference[];

  /** Candidate engineering decisions discovered via deterministic heuristics */
  candidateDecisions: CandidateDecision[];

  /** Mechanism used to extract Git history */
  retrievalSource: EvidenceRetrievalSource;

  /** Any limitations, boundaries, or gaps encountered during discovery */
  limitations: EvidenceDiscoveryLimitation[];

  /** True if local working tree contains uncommitted changes for this file */
  hasUncommittedChanges: boolean;

  /** Uncommitted working-tree diff if present */
  uncommittedDiff?: string;

  /** True if repository is a shallow clone with truncated ancestry */
  isShallowRepo: boolean;

  /** Optional human-readable status message */
  message?: string;
}

export interface HistoricalEvidenceDiscoveryOptions {
  /** Optional 1-based line range */
  lineRange?: {
    startLine: number;
    endLine: number;
  };

  /** Maximum commits to inspect to ensure responsiveness in large repositories (default: 25) */
  maxCommits?: number;

  /** Cancellation token */
  cancellationToken?: any;

  /** Abort signal */
  abortSignal?: AbortSignal;

  /** Execution timeout in milliseconds (default: 25000) */
  timeoutMs?: number;
}
