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

export interface InspectionPayload {
  aiProvider: string;
  model: string;
  promptVariant: string;
  approximateInputTokens: number;
  requestSizeBytes: number;
  targetFile: string;
  targetLines: string;
  securityStatus: string;
  outgoingMessages?: Array<{ role: string; content: string }>;
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
}
