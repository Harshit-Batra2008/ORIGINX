/**
 * GitWhisper — Requirements Audit Types
 * Bridges PRD / TASKS.md requirements against workspace implementation & verified test evidence.
 */

export type RequirementStatus =
  | 'VERIFIED'
  | 'IMPLEMENTED_NOT_VERIFIED'
  | 'PARTIAL'
  | 'NOT_FOUND_IN_SCANNED_SCOPE'
  | 'INSUFFICIENT_EVIDENCE';

export interface ImplementationCandidate {
  filePath: string;
  line: number;
  symbol?: string;
  snippet?: string;
  confidence: number; // 0.0 to 1.0
  rationale: string;
}

export interface TestEvidenceCandidate {
  testFilePath: string;
  line: number;
  testName?: string;
  snippet?: string;
  wasExecuted: boolean;
  executionPassed: boolean;
}

export interface RequirementCitation {
  filePath: string;
  line: number;
  label: string;
}

export interface RequirementAuditItem {
  id: string; // e.g. REQ-1, REQ-2
  title: string;
  rawText: string;
  status: RequirementStatus;
  candidateImplementations: ImplementationCandidate[];
  candidateTests: TestEvidenceCandidate[];
  executedTests: string[];
  remainingGap: string;
  suggestedNextAction: string;
  citations: RequirementCitation[];
}

export interface ExecutedTestSuiteSummary {
  suiteName: string;
  totalPassed: number;
  totalFailed: number;
  durationMs?: number;
}

export interface RequirementsAuditReport {
  documentTitle: string;
  totalRequirements: number;
  verifiedCount: number;
  implementedNotVerifiedCount: number;
  partialCount: number;
  notFoundCount: number;
  insufficientCount: number;
  items: RequirementAuditItem[];
  scannedFilesCount: number;
  auditTimestamp: string;
  executedTestSuites: ExecutedTestSuiteSummary[];
  summary: string;
}
