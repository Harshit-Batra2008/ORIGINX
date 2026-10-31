import type * as vscode from 'vscode';
import { CommitInfo } from '../git/gitTypes';
import { RequestDiagnostics, StatementClassification } from '../gemini/geminiTypes';
import { ILanguageModelChat } from '../lm/vscodeLmClient';

export interface FileValidationItem {
  uri: vscode.Uri;
  filePath: string;
  fileName: string;
  relativeFilePath?: string;
  repoRoot?: string;
  isEligible: boolean;
  exclusionReason?: string;
  fileSizeBytes?: number;
}

export interface MultiFileValidationResult {
  totalReceived: number;
  eligibleFiles: FileValidationItem[];
  excludedFiles: FileValidationItem[];
  repoRoots: string[];
  isMixedRepositories: boolean;
}

export interface FileEvidence {
  file: FileValidationItem;
  commits: CommitInfo[];
  uncommittedDiff?: string;
  hasUncommittedChanges: boolean;
  totalDiffChars: number;
  isBounded: boolean;
  status: 'ok' | 'no_history' | 'error' | 'cancelled';
  errorMessage?: string;
}

export interface MultiFileEvidenceResult {
  files: FileEvidence[];
  totalCommits: number;
  totalDiffChars: number;
  isCancelled: boolean;
  truncationWarnings: string[];
}

export interface TokenEstimationResult {
  estimatedTokens: number;
  isExact: boolean;
  method: 'model.countTokens' | 'approximate';
  modelIdentifier: string;
  maxInputTokens?: number;
  warning?: string;
}

export interface MultiFileConfirmationResult {
  confirmed: boolean;
  dontShowAgain: boolean;
  action: 'analyze' | 'cancel' | 'dismissed';
}

export interface PerFileExplanation {
  fileName: string;
  filePath: string;
  whatChanged: string;
  possibleReasons: string;
  classification?: StatementClassification;
}

export interface MultiFileExplanation {
  crossFileSummary: string;
  perFileSummaries: PerFileExplanation[];
  supportingCommits: string;
  uncertainty: string;
  model: string;
  hallucinatedCommits?: string[];
}

export interface MultiFileHistoryResult {
  totalReceived: number;
  eligibleFiles: FileValidationItem[];
  excludedFiles: FileValidationItem[];
  isMixedRepositories: boolean;
  evidence: MultiFileEvidenceResult;
  tokenEstimate: TokenEstimationResult;
  explanationStatus: 'ok' | 'disabled' | 'blocked_security' | 'no_model' | 'failed' | 'cancelled';
  explanation?: MultiFileExplanation;
  explanationError?: string;
  explanationDiagnostics?: RequestDiagnostics;
}
