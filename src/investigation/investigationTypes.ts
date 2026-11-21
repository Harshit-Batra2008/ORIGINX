import { CommitInfo, GitHistoryResult } from '../git/gitTypes';
import { RequestDiagnostics } from '../gemini/geminiTypes';
import { RelatedFileRecommendation } from '../reviewer/reviewerTypes';

export type DiagnosticSeverityLevel = 'error' | 'warning' | 'information' | 'hint';

export interface CollectedDiagnostic {
  message: string;
  severity: DiagnosticSeverityLevel;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  source?: string;
  code?: string;
  overlapsSelection: boolean;
}

export interface InvestigationRequest {
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedCode: string;
  userErrorMessage?: string;
  repoRoot: string;
  repoId: string;
  repoName: string;
}

export interface MinimalSuggestedFix {
  code: string;
  explanation: string;
  isVerified: false; // Explicitly false: advisory suggestion only
}

export interface InvestigationExplanation {
  observedFacts: string;
  rootCauseHypotheses: string[];
  relatedFiles: Array<{ filePath: string; reason: string }>;
  investigationSteps: string[];
  minimalSuggestedFix: MinimalSuggestedFix;
  relevantTests: string[];
  uncertainties: string[];
  model?: string;
}

export interface InvestigationEvidencePackage {
  request: InvestigationRequest;
  diagnostics: CollectedDiagnostic[];
  gitHistory: GitHistoryResult;
  coChangeEvidence: RelatedFileRecommendation[];
  neo4jStatus: 'ok' | 'offline' | 'no_records' | 'disabled' | 'error';
  neo4jError?: string;
}

export interface InvestigationResult {
  status:
    | 'ok'
    | 'no_git'
    | 'not_a_repo'
    | 'untracked_file'
    | 'empty_repo'
    | 'no_history'
    | 'error';
  request?: InvestigationRequest;
  evidence?: InvestigationEvidencePackage;
  explanationStatus:
    | 'ok'
    | 'disabled'
    | 'no_model'
    | 'blocked_security'
    | 'failed'
    | 'cancelled';
  explanation?: InvestigationExplanation;
  explanationError?: string;
  explanationDiagnostics?: RequestDiagnostics;
  durationMs: number;
  error?: string;
}
