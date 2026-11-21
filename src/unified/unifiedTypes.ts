import { CommitInfo, GitHistoryResult } from '../git/gitTypes';
import { Neo4jCommitEvidence } from '../neo4j/neo4jGraphTypes';
import { CollectedDiagnostic } from '../investigation/investigationTypes';
import { RelatedFileRecommendation } from '../reviewer/reviewerTypes';
import { RequestDiagnostics } from '../gemini/geminiTypes';

export interface UnifiedAnalysisRequest {
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedCode: string;
  repoRoot: string;
  repoId: string;
  repoName: string;
  userQuery?: string;
}

export interface UnifiedSuggestedFix {
  code: string;
  explanation: string;
  isVerified: false; // Always explicitly false for advisory unverified recommendations
}

export interface UnifiedDiagnosticsAndIssues {
  hasIssues: boolean;
  summary: string;
  details: string[];
}

export interface UnifiedRelatedFileImpact {
  filePath: string;
  reason: string;
  sharedCommitCount?: number;
  isCurrentlyChanged?: boolean;
}

export interface UnifiedAnalysisExplanation {
  whatCodeDoes: string;
  whyChangedHistorically: string;
  diagnosticsAndIssues: UnifiedDiagnosticsAndIssues;
  relatedFilesAndImpact: UnifiedRelatedFileImpact[];
  suggestedImprovementsOrFixes?: UnifiedSuggestedFix;
  supportingEvidence: string[];
  uncertaintiesAndLimitations: string[];
  model?: string;
}

export interface UnifiedEvidenceBundle {
  request: UnifiedAnalysisRequest;
  diagnostics: CollectedDiagnostic[];
  gitHistory: GitHistoryResult;
  workingTreeDiff?: string;
  isWorkingTreeModified: boolean;
  neo4jFileEvidence?: Neo4jCommitEvidence[];
  neo4jCoChanges: RelatedFileRecommendation[];
  neo4jStatus: 'ok' | 'offline' | 'no_records' | 'disabled' | 'error';
  neo4jError?: string;
}

export interface UnifiedAnalysisResult {
  status:
    | 'ok'
    | 'no_git'
    | 'not_a_repo'
    | 'untracked_file'
    | 'empty_repo'
    | 'no_history'
    | 'error';
  request?: UnifiedAnalysisRequest;
  evidence?: UnifiedEvidenceBundle;
  explanationStatus:
    | 'ok'
    | 'disabled'
    | 'no_model'
    | 'blocked_security'
    | 'failed'
    | 'cancelled';
  explanation?: UnifiedAnalysisExplanation;
  explanationError?: string;
  explanationDiagnostics?: RequestDiagnostics;
  durationMs: number;
  error?: string;
}
