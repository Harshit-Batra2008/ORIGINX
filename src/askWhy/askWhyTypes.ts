/**
 * GitWhisper — "Ask Why" (Why The Code Is Like This) Data Models
 * Defines types for natural-language questioning, evidence-grounded AI reasoning,
 * source citations, and observability.
 */

import { ICancellationTokenLike } from '../git/gitService';
import {
  EvidenceClassification,
  GraphDecisionNode,
  SupersessionStatus,
} from '../evidenceGraph/evidenceGraphTypes';
import { ILanguageModelChat, ILanguageModelProvider } from '../lm/vscodeLmClient';

export interface AskWhyTarget {
  filePath: string;
  lineRange?: {
    startLine: number;
    endLine: number;
  };
  selectedSnippet?: string;
  commitHash?: string;
}

export interface AskWhyRequest {
  repoRoot: string;
  filePath: string;
  question: string;
  lineRange?: {
    startLine: number;
    endLine: number;
  };
  selectedSnippet?: string;
  commitHash?: string;
  cancellationToken?: ICancellationTokenLike;
  neo4jService?: any;
  lmProvider?: ILanguageModelProvider;
  preferredModel?: ILanguageModelChat;
}

export interface AskWhyCitation {
  type: 'commit' | 'pull_request' | 'issue' | 'design_doc' | 'decision';
  identifier: string; // e.g. "PR #122", "228f976", "commands/scope.md"
  title: string;
  url?: string;
  author?: string;
  date?: string;
  excerpt?: string;
}

export interface AskWhyDiagnostics {
  retrievalDurationMs: number;
  aiDurationMs: number;
  retrievalSource: 'neo4j_graph' | 'local_git' | 'github_api' | 'local_documentation' | 'mixed_sources';
  retrievalSourceLabel: string;
  isNeo4jActive: boolean;
  approximateTokens: number;
  modelName: string;
  commitCount: number;
  prCount: number;
  docCount: number;
}

export interface AskWhyResult {
  question: string;
  target: AskWhyTarget;
  answer: string;
  evidenceClassification: EvidenceClassification;
  supersessionStatus: SupersessionStatus;
  isRefusalOrInsufficient: boolean;
  primaryDecision?: GraphDecisionNode;
  citations: AskWhyCitation[];
  diagnostics: AskWhyDiagnostics;
  answeredAt: string;
}
