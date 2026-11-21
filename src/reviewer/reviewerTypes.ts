import { RequestDiagnostics } from '../gemini/geminiTypes';
import { Neo4jCoChangeItem } from '../neo4j/neo4jGraphTypes';

export type ReviewerChangeStatus = 'staged' | 'unstaged' | 'both' | 'untracked';

export interface ReviewerFileChange {
  filePath: string;
  fileName: string;
  status: ReviewerChangeStatus;
  stagedDiff?: string;
  unstagedDiff?: string;
  diff: string;
  diffCharCount: number;
  isBinary: boolean;
  isUntracked: boolean;
  oldPath?: string;
}

export interface RelatedFileRecommendation {
  filePath: string;
  fileName: string;
  historicallyCoupledWith: string[];
  sharedCommitCount: number;
  sampleCommitHashes: string[];
  sampleCommitSubjects: string[];
  isCurrentlyChanged: boolean;
}

export interface ReviewerCoChangeGroup {
  targetFilePath: string;
  targetFileName: string;
  coChangedFiles: Neo4jCoChangeItem[];
}

export interface ReviewerExplanation {
  summary: string;
  impactAnalysis: string;
  reviewChecklist: string[];
  relatedFilesGuidance: string;
  uncertaintyNotes: string;
  model?: string;
}

export interface ReviewerResult {
  status: 'ok' | 'no_git' | 'not_a_repo' | 'empty_repo' | 'no_changes';
  repoRoot?: string;
  repoId?: string;
  repoName?: string;
  changedFiles: ReviewerFileChange[];
  totalChangedFiles: number;
  totalDiffChars: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  neo4jStatus: 'ok' | 'offline' | 'no_records' | 'disabled' | 'error';
  neo4jError?: string;
  coChangeEvidence: ReviewerCoChangeGroup[];
  relatedFilesWorthInspecting: RelatedFileRecommendation[];
  explanationStatus: 'ok' | 'disabled' | 'no_model' | 'blocked_security' | 'failed' | 'empty_diff' | 'cancelled';
  explanation?: ReviewerExplanation;
  explanationError?: string;
  explanationDiagnostics?: RequestDiagnostics;
  durationMs: number;
}
