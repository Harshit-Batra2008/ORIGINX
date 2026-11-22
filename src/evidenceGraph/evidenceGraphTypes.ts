/**
 * GitWhisper — Historical Evidence Graph Data Models
 * Defines schema nodes, relationships, dry-run plans, and GraphRAG retrieval models
 * connecting Commits, Pull Requests, Issues, Design Documents, and Decisions.
 */

import { GitHubIssue, GitHubPullRequest } from '../github/githubTypes';
import { DecisionMemoryRecord } from '../decisionMemory/decisionTypes';

export interface GraphPullRequestNode {
  id: string; // Composite: `${repoId}:pr-${number}`
  repoId: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
  isMerged: boolean;
  mergedAt?: string;
  mergeCommitSha?: string;
  headSha: string;
  url: string;
}

export interface GraphIssueNode {
  id: string; // Composite: `${repoId}:issue-${number}`
  repoId: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
  isIncident: boolean;
  incidentSeverity?: string;
  url: string;
}

export interface GraphDiscussionCommentNode {
  id: string; // Composite: `${repoId}:comment-${id}`
  commentId: number;
  repoId: string;
  author: string;
  body: string;
  createdAt: string;
  commentType: 'issue' | 'pull_review' | 'commit';
  url: string;
  path?: string;
  line?: number;
}

export interface GraphDesignDocumentNode {
  id: string; // Composite: `${repoId}:doc-${normalizedPath}`
  repoId: string;
  path: string; // Repository-relative path (e.g. "commands/scope.md")
  title: string;
  summary: string;
  sections: Array<{ heading: string; contentSnippet: string }>;
  referencedFiles: string[];
  referencedIssueNumbers: number[];
  referencedPrNumbers: number[];
  hasDecisionStructure: boolean;
  lastModified: string;
}

export type SupersessionStatus =
  | 'current'
  | 'explicitly_superseded'
  | 'potentially_affected'
  | 'unknown';

export type EvidenceClassification =
  | 'directly_supported'
  | 'partially_supported'
  | 'insufficient_evidence';

export interface GraphDecisionNode {
  id: string; // Composite: `${repoId}:decision:${decisionId}`
  repoId: string;
  decisionId: string;
  title: string;
  rationale: string;
  sourceType: 'pull_request_rationale' | 'adr_document' | 'issue_discussion' | 'decision_record';
  sourceReference: string;
  targetFile: string;
  author: string;
  recordedAt: string;
  status: SupersessionStatus;
  evidenceClassification: EvidenceClassification;
  supportingCommitSha?: string;
  linkedPrNumber?: number;
}

export interface EvidenceGraphDryRunPlan {
  repositoryId: string;
  dryRun: true;
  nodesToCreateOrMerge: {
    pullRequests: number;
    issues: number;
    comments: number;
    designDocs: number;
    decisions: number;
    totalNodes: number;
  };
  relationshipsToCreate: {
    commitToPr: number;
    prToFile: number;
    prToIssue: number;
    prToComment: number;
    issueToComment: number;
    docToFile: number;
    docToIssue: number;
    decisionToPr: number;
    decisionToDoc: number;
    decisionToFile: number;
    decisionToCommit: number;
    totalRelationships: number;
  };
  sampleQueries: string[];
  estimatedPayloadBytes: number;
  warnings: string[];
  preparedAt: string;
}

export interface EvidenceImportResult {
  status: 'ok' | 'dry_run' | 'cancelled' | 'error';
  repositoryId: string;
  nodesImported: number;
  relationshipsImported: number;
  durationMs: number;
  dryRunPlan?: EvidenceGraphDryRunPlan;
  error?: string;
}

export interface ConfidenceSignals {
  evidenceClassification: EvidenceClassification;
  supersessionStatus: SupersessionStatus;
  hasPrEvidence: boolean;
  hasIssueLink: boolean;
  hasDesignDocGrounding: boolean;
  isSuperseded: boolean; // Backwards-compatible alias: true only if supersessionStatus === 'explicitly_superseded'
  supersededBy?: {
    commitHash: string;
    prNumber?: number;
    date: string;
    subject: string;
    reason?: string;
  };
  heuristicScore: number; // Heuristic index 0.0 to 1.0 (uncalibrated ranking index)
  confidenceScore: number; // Backwards-compatible alias for heuristicScore
  rationaleSignals: string[];
}

export interface CompactEvidencePackage {
  query: {
    filePath: string;
    commitHash?: string;
    repoId: string;
  };
  connectedCommits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    date: string;
    prNumber?: number;
  }>;
  connectedPullRequests: Array<{
    number: number;
    title: string;
    rationaleSummary: string;
    author: string;
    state: 'open' | 'closed';
    isMerged: boolean;
    mergedAt?: string;
    url: string;
    keyDiscussions: string[];
  }>;
  connectedIssues: Array<{
    number: number;
    title: string;
    isIncident: boolean;
    severity?: string;
    url: string;
  }>;
  groundingDocuments: Array<{
    path: string;
    title: string;
    relevantExcerpt: string;
  }>;
  existingDecisions: Array<{
    id: string;
    title: string;
    status: string;
    rationale: string;
  }>;
  confidenceSignals: ConfidenceSignals;
  retrievalSource: 'neo4j_aura' | 'local_git_and_docs_fallback';
  retrievedAt: string;
}
