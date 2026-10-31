import type * as vscode from 'vscode';
import { CommitInfo, SelectionContext } from '../git/gitTypes';
import { Neo4jCommitEvidence } from '../neo4j/neo4jGraphTypes';
import { scanPayload } from '../security/redactor';
import {
  callVsCodeLanguageModel,
  ILanguageModelChat,
  ILanguageModelProvider,
  VsCodeLmError
} from '../lm/vscodeLmClient';
import { buildCompactGeminiPrompt, buildGeminiPrompt, parseGeminiExplanation } from './geminiPrompt';
import { ExplanationStatus, GeminiExplanation, InspectionPayload, RequestDiagnostics } from './geminiTypes';

export interface ExplainExecutionResult {
  status: ExplanationStatus;
  explanation?: GeminiExplanation;
  error?: string;
  diagnostics?: RequestDiagnostics;
}

export class GeminiExplainer {
  private lmProvider?: ILanguageModelProvider;

  constructor(_secretManager?: any, lmProvider?: ILanguageModelProvider) {
    this.lmProvider = lmProvider;
  }

  /**
   * Generates an evidence-backed explanation for the given selection and Git commits
   * using the native VS Code Language Model API (vscode.lm, e.g. GitHub Copilot).
   */
  public async explainChanges(
    selection: SelectionContext,
    commits: CommitInfo[],
    uncommittedDiff?: string,
    _model?: string,
    options?: {
      promptVariant?: 'compact' | 'standard';
      cancellationToken?: vscode.CancellationToken;
      lmModelInstance?: ILanguageModelChat;
      aiProvider?: string;
      abortSignal?: AbortSignal;
      onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
      neo4jEvidence?: Neo4jCommitEvidence[];
      repositoryId?: string;
    }
  ): Promise<ExplainExecutionResult> {
    // 1. Scan payload for sensitive credentials before preparing request
    const neoSubjects = (options?.neo4jEvidence || []).map((c) => c.subject || '');
    const neoBodies = (options?.neo4jEvidence || []).map((c) => c.body || '');

    const scanResult = scanPayload({
      selectedText: selection.selectedText,
      commitSubjects: commits.map((c) => c.subject).concat(neoSubjects),
      commitBodies: commits.map((c) => c.body).concat(neoBodies),
      diffs: commits.map((c) => c.diff).concat(uncommittedDiff ? [uncommittedDiff] : [])
    });

    if (scanResult.isBlocked) {
      return {
        status: 'blocked_security',
        error: `Security scan blocked request: ${scanResult.blockReason}`
      };
    }

    // 2. Construct the sanitized prompt (compact variant by default for token efficiency)
    const sanitizedCommits = commits.map((c, i) => ({
      ...c,
      diff: scanResult.sanitizedDiffs[i] ?? c.diff
    }));

    const sanitizedUncommitted = uncommittedDiff
      ? scanResult.sanitizedDiffs[commits.length] ?? uncommittedDiff
      : undefined;

    const variant = options?.promptVariant ?? 'compact';
    const promptBuilder = variant === 'standard' ? buildGeminiPrompt : buildCompactGeminiPrompt;

    const prompt = promptBuilder({
      fileName: selection.fileName,
      startLine: selection.startLine,
      endLine: selection.endLine,
      selectedText: scanResult.sanitizedSelectedText,
      commits: sanitizedCommits,
      uncommittedDiff: sanitizedUncommitted,
      neo4jEvidence: options?.neo4jEvidence,
      repositoryId: options?.repositoryId
    });

    const totalDiffChars =
      sanitizedCommits.reduce((acc, c) => acc + (c.diff ? c.diff.length : 0), 0) +
      (sanitizedUncommitted ? sanitizedUncommitted.length : 0);

    // 3. Dispatch to native VS Code Language Model API
    try {
      const callResult = await callVsCodeLanguageModel(prompt, {
        provider: this.lmProvider,
        modelInstance: options?.lmModelInstance,
        cancellationToken: options?.cancellationToken,
        metadata: {
          commitCount: sanitizedCommits.length,
          diffCharacterCount: totalDiffChars
        }
      });

      const explanation = parseGeminiExplanation(
        callResult.text,
        commits,
        callResult.model,
        options?.neo4jEvidence
      );
      return {
        status: 'success',
        explanation,
        diagnostics: callResult.diagnostics
      };
    } catch (err: any) {
      if (err instanceof VsCodeLmError) {
        const diag = err.diagnostics;
        if (diag.category === 'NOT_FOUND') {
          return {
            status: 'no_model',
            error: err.message,
            diagnostics: diag
          };
        }
        if (diag.category === 'TIMEOUT') {
          return {
            status: 'cancelled',
            error: err.message,
            diagnostics: diag
          };
        }
        return {
          status: 'failed',
          error: err.message,
          diagnostics: diag
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        error: msg
      };
    }
  }

  /**
   * Constructs the unabridged outgoing payload object for offline user inspection.
   */
  public buildInspectionPayload(
    selection: SelectionContext,
    commits: CommitInfo[],
    uncommittedDiff?: string,
    _model?: string,
    promptVariant: 'compact' | 'standard' = 'compact',
    _aiProvider?: string,
    extra?: {
      neo4jEvidence?: Neo4jCommitEvidence[];
      repositoryId?: string;
    }
  ): InspectionPayload {
    const neoSubjects = (extra?.neo4jEvidence || []).map((c) => c.subject || '');
    const neoBodies = (extra?.neo4jEvidence || []).map((c) => c.body || '');

    const scanResult = scanPayload({
      selectedText: selection.selectedText,
      commitSubjects: commits.map((c) => c.subject).concat(neoSubjects),
      commitBodies: commits.map((c) => c.body).concat(neoBodies),
      diffs: commits.map((c) => c.diff).concat(uncommittedDiff ? [uncommittedDiff] : [])
    });

    const sanitizedCommits = commits.map((c, i) => ({
      ...c,
      diff: scanResult.sanitizedDiffs[i] ?? c.diff
    }));

    const sanitizedUncommitted = uncommittedDiff
      ? scanResult.sanitizedDiffs[commits.length] ?? uncommittedDiff
      : undefined;

    const promptBuilder = promptVariant === 'standard' ? buildGeminiPrompt : buildCompactGeminiPrompt;

    const prompt = promptBuilder({
      fileName: selection.fileName,
      startLine: selection.startLine,
      endLine: selection.endLine,
      selectedText: scanResult.sanitizedSelectedText,
      commits: sanitizedCommits,
      uncommittedDiff: sanitizedUncommitted,
      neo4jEvidence: extra?.neo4jEvidence,
      repositoryId: extra?.repositoryId
    });

    return {
      aiProvider: 'vscode (VS Code Language Model API - vscode.lm)',
      model: 'Dynamic discovery via vscode.lm.selectChatModels()',
      promptVariant,
      approximateInputTokens: Math.ceil(prompt.length / 4),
      requestSizeBytes: Buffer.byteLength(prompt, 'utf8'),
      targetFile: selection.fileName,
      targetLines: `${selection.startLine}-${selection.endLine}`,
      securityStatus: scanResult.isBlocked ? `BLOCKED (${scanResult.blockReason})` : 'PASSED',
      outgoingMessages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      notes: 'Sent natively inside VS Code to registered language model providers (e.g. GitHub Copilot). Zero external API keys needed.'
    };
  }
}
