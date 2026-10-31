export interface StatementClassification {
  verified: string[];
  inferred: string[];
  unknown: string[];
}

export interface GeminiExplanation {
  whatChanged: string;
  possibleReasons: string;
  supportingCommits: string;
  uncertainty: string;
  rawResponse: string;
  model: string;
  isAiInference: boolean;
  classification?: StatementClassification;
  chronologicalEvolution?: string;
}

export interface ExplanationPayloadPreview {
  fileName: string;
  startLine: number;
  endLine: number;
  selectedCodeSnippet: string;
  commits: { hash: string; shortHash: string; subject: string; author: string }[];
  diffLineCount: number;
  destination: string;
  model: string;
}

export interface InspectionPayload {
  aiProvider: string;
  model: string;
  promptVariant: string;
  approximateInputTokens: number;
  requestSizeBytes: number;
  targetFile: string;
  targetLines: string;
  securityStatus: string;
  endpoint?: string;
  method?: string;
  headers?: Record<string, string>;
  outgoingMessages?: Array<{ role: string; content: string }>;
  requestBody?: {
    contents: Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    generationConfig?: {
      temperature: number;
      maxOutputTokens: number;
    };
  };
  notes?: string;
}

export type ExplanationStatus =
  | 'none'
  | 'success'
  | 'cancelled'
  | 'blocked_security'
  | 'failed'
  | 'no_key'
  | 'no_model'
  | 'disabled';

export type ErrorCategory =
  | 'SUCCESS'
  | 'TIMEOUT'
  | 'DNS_ERROR'
  | 'TCP_CONNECT_ERROR'
  | 'TLS_ERROR'
  | 'PROXY_ERROR'
  | 'AUTH_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMIT_ERROR'
  | 'SERVER_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_ERROR'
  | 'NO_PERMISSIONS'
  | 'BLOCKED'
  | 'UNSUPPORTED';

export type RequestStage =
  | 'init'
  | 'dns'
  | 'tcp_connect'
  | 'tls_handshake'
  | 'waiting_for_response'
  | 'reading_body'
  | 'completed'
  | 'timeout';

export interface GenerationConfigDiagnostics {
  temperature?: number;
  maxOutputTokens?: number;
  thinkingConfig?: string;
  omitted?: boolean;
}

export interface TransportMetadata {
  endpoint: string;
  method: string;
  headerNames: string[];
  transport: string;
  sameAsDiagnosticProbe: boolean;
}

export interface RequestComparisonItem {
  id: 'A' | 'B' | 'C' | 'D';
  name: string;
  promptType: 'literal' | 'synthetic';
  hasGenerationConfig: boolean;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  category: ErrorCategory | 'SKIPPED';
  httpStatus?: number;
  durationMs: number;
  requestSizeBytes: number;
  responseSizeBytes?: number;
  details: string;
}

export interface RequestComparisonResult {
  model: string;
  timestamp: string;
  items: RequestComparisonItem[];
  stoppedEarly: boolean;
  stopReason?: string;
}

/**
 * Safe diagnostic telemetry containing zero credentials, headers, code, prompts, or diffs.
 */
export interface RequestDiagnostics {
  durationMs: number;
  httpStatus?: number;
  stage: RequestStage;
  category: ErrorCategory;
  details: string;
  model: string;
  responseSizeBytes?: number;
  // Analysis request metrics (zero source code or diffs)
  requestSizeBytes?: number;
  approximateInputTokens?: number;
  commitCount?: number;
  diffCharacterCount?: number;
  attemptCount?: number;
  provider?: 'vscode' | 'gemini';
  generationConfig?: GenerationConfigDiagnostics;
  transportMeta?: TransportMetadata;
}
