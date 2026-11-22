/**
 * GitWhisper Decision Memory — Core Data Models and Schema Definitions
 * Schema Version: 1.0.0
 */

export type DecisionStatus =
  | 'proposed'  // AI-generated draft or developer suggestion, pending peer verification
  | 'verified'  // Explicitly confirmed by a human developer / reviewer via verifyDecision()
  | 'disputed'  // Flagged by a developer as inaccurate, obsolete, or under debate
  | 'retired';   // Intentionally superseded or deprecated by subsequent architectural changes

export type FreshnessState =
  | 'current'       // Anchored code content and commits match current repository state
  | 'needs-review'  // Anchored lines modified, moved, or surrounding code changed
  | 'unknown';      // Target file or commit not available in current working checkout

export type EvidenceOrigin =
  | 'git_blame'         // Direct local Git blame extraction
  | 'git_log'           // Commit history for a file or line range
  | 'neo4j_graph'       // Co-change knowledge graph query
  | 'copilot_inferred'  // AI synthesis from commit messages and code diffs
  | 'human_verified';   // Explicit developer input during review or recording

/**
 * Attribution metadata recorded for decision provenance and team accountability.
 * 
 * IMPORTANT SECURITY NOTE:
 * Local author metadata (name/email) is descriptive attribution recorded from local developer
 * configuration. It is NOT cryptographic proof of identity (such as a GPG-signed commit).
 * In security-sensitive workflows, verification should be paired with signed Git commits or PR reviews.
 */
export interface DecisionAuthor {
  name: string;
  email?: string;
  type: 'human' | 'ai_assistant';
  modelIdentifier?: string; // e.g. "copilot/gpt-4o" if type is ai_assistant
}

export interface DecisionAnchor {
  filePath: string;             // Repository-relative path (POSIX style: src/auth.ts)
  symbolName?: string;          // AST / code symbol identifier (e.g. "refreshToken")
  startLine?: number;           // Target start line at time of recording
  endLine?: number;             // Target end line at time of recording
  contentHash?: string;         // SHA-256 of the anchored code snippet
  contextSnippet?: string;      // 3-5 line preview of the anchored code
}

export interface SupportingEvidence {
  commitHash: string;           // Full 40-character canonical Git commit SHA
  shortHash: string;            // 7-character short SHA
  commitDate: string;           // ISO 8601 commit timestamp
  author: string;               // Git commit author
  subject: string;              // Commit summary line
  body?: string;                // Full commit body
  diffHunk?: string;            // Scoped patch diff
  origin: EvidenceOrigin;       // Provenance source
  isHypothesis: boolean;        // True if commit message interpretation is AI-inferred
}

export interface DecisionConstraint {
  id: string;                   // e.g. "C1", "C2"
  description: string;          // What future developers MUST NOT do (e.g. "Do not remove lock")
  reason: string;               // Why this constraint exists
  severity: 'critical' | 'advisory';
}

export interface RelatedFileLink {
  filePath: string;             // Repository-relative path
  couplingReason: string;       // Why this file is coupled
  isDirectDependency: boolean;  // Direct import/require relationship vs co-change
}

export interface DecisionMemoryRecord {
  /**
   * Collision-resistant unique ID.
   * Format: "DEC-" + alphanumeric identifier (e.g. "DEC-20261122-8A4F1C2B")
   */
  id: string;

  /** Schema specification version */
  schemaVersion: '1.0.0';

  /** Concise, searchable summary of the decision */
  title: string;

  /** Comprehensive human-readable rationale ("Why the code was written this way") */
  rationale: string;

  /** Primary file and code range anchored to this decision */
  primaryAnchor: DecisionAnchor;

  /** Secondary / related repository files governed by the same architectural choice */
  relatedFiles: RelatedFileLink[];

  /** Supporting cryptographic Git evidence */
  evidence: SupportingEvidence[];

  /**
   * Explicit flag indicating whether hard Git evidence exists.
   * If false, the record explicitly documents lack of historical evidence.
   */
  hasDirectGitEvidence: boolean;

  /** Non-negotiable architectural or functional constraints to preserve */
  constraints: DecisionConstraint[];

  /** Current lifecycle status */
  status: DecisionStatus;

  /** Current validity with respect to repository state */
  freshness: FreshnessState;

  /** Record creator */
  createdBy: DecisionAuthor;

  /** Human reviewer who verified the decision (required if status === 'verified') */
  verifiedBy?: DecisionAuthor;

  /** Optional human verification note */
  verificationNote?: string;

  /** Timestamps in ISO 8601 format */
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;

  /** Retirement audit metadata */
  retirementReason?: string;
  retiredAt?: string;

  /** Superseded by another decision record if retired */
  supersededById?: string;

  /** Freeform developer tags (e.g. ["security", "auth", "neo4j"]) */
  tags: string[];
}

export interface CreateDecisionInput {
  id?: string;
  title: string;
  rationale: string;
  primaryAnchor: {
    filePath: string;
    symbolName?: string;
    startLine?: number;
    endLine?: number;
    contentHash?: string;
    contextSnippet?: string;
  };
  relatedFiles?: RelatedFileLink[];
  evidence?: SupportingEvidence[];
  hasDirectGitEvidence?: boolean;
  constraints?: DecisionConstraint[];
  status?: 'proposed' | 'disputed'; // Newly created records cannot be pre-verified; must use verifyDecision()
  freshness?: FreshnessState;
  createdBy: DecisionAuthor;
  tags?: string[];
}

export interface UpdateDecisionInput {
  title?: string;
  rationale?: string;
  primaryAnchor?: Partial<DecisionAnchor>;
  relatedFiles?: RelatedFileLink[];
  evidence?: SupportingEvidence[];
  hasDirectGitEvidence?: boolean;
  constraints?: DecisionConstraint[];
  status?: 'proposed' | 'disputed'; // Verification must occur through verifyDecision() lifecycle API
  freshness?: FreshnessState;
  tags?: string[];
  supersededById?: string;
}

export interface VerifyDecisionInput {
  verifierName: string;
  verifierEmail?: string;
  verificationNote?: string;
}

export interface DisputeDecisionInput {
  disputerName: string;
  disputerEmail?: string;
  reason: string;
}

export interface DecisionSearchQuery {
  text?: string;
  filePath?: string;
  status?: DecisionStatus | DecisionStatus[];
  freshness?: FreshnessState | FreshnessState[];
  tag?: string;
  hasEvidence?: boolean;
}

export interface DecisionSearchResult {
  record: DecisionMemoryRecord;
  score: number;
  matchedFields: string[];
}
