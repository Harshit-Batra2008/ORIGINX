/**
 * Git and context data types for ORIGINX
 */
import { ExplanationStatus, GeminiExplanation, RequestDiagnostics } from '../gemini/geminiTypes';

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
}
