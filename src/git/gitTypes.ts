/**
 * Git and context data types for ORIGINX
 */
import { ExplanationStatus, GeminiExplanation, RequestDiagnostics } from '../gemini/geminiTypes';
import { Neo4jCommitEvidence } from '../neo4j/neo4jGraphTypes';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  diff: string;
}

export interface SelectionContext {
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

export type GitHistoryStatus =
  | 'ok'
  | 'no_git'
  | 'not_a_repo'
  | 'untracked_file'
  | 'empty_repo'
  | 'no_history_for_selection'
  | 'uncommitted_only'
  | 'cancelled'
  | 'error';

export interface GitHistoryResult {
  status: GitHistoryStatus;
  selection: SelectionContext;
  repoRoot?: string;
  relativeFilePath?: string;
  commits: CommitInfo[];
  hasUncommittedChanges?: boolean;
  uncommittedDiff?: string;
  message?: string;
  explanation?: GeminiExplanation;
  explanationError?: string;
  explanationStatus?: ExplanationStatus;
  explanationDiagnostics?: RequestDiagnostics;
  neo4jEvidence?: Neo4jCommitEvidence[];
  neo4jRepositoryId?: string;
  neo4jDurationMs?: number;
}
