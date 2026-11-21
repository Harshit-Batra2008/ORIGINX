import {
  callVsCodeLanguageModel,
  ILanguageModelChat,
  ILanguageModelProvider
} from '../lm/vscodeLmClient';
import { RequestDiagnostics } from '../gemini/geminiTypes';
import { scanPayload } from '../security/redactor';
import { buildUnifiedAnalysisPrompt, parseUnifiedExplanation } from './unifiedPrompt';
import {
  UnifiedAnalysisExplanation,
  UnifiedEvidenceBundle
} from './unifiedTypes';

export interface UnifiedExplainResult {
  status: 'ok' | 'blocked_security' | 'no_model' | 'failed' | 'cancelled';
  explanation?: UnifiedAnalysisExplanation;
  error?: string;
  diagnostics?: RequestDiagnostics;
}

export class UnifiedExplainer {
  private lmProvider?: ILanguageModelProvider;

  constructor(lmProvider?: ILanguageModelProvider) {
    this.lmProvider = lmProvider;
  }

  /**
   * Generates a unified AI code analysis synthesizing functionality, Git history, diagnostics,
   * working-tree state, and Neo4j co-change impact.
   * Strictly audits code, diagnostics, and diffs for credentials before transmission.
   */
  public async analyzeCode(
    evidence: UnifiedEvidenceBundle,
    options?: {
      cancellationToken?: any;
      lmModelInstance?: ILanguageModelChat;
      maxInputTokens?: number;
    }
  ): Promise<UnifiedExplainResult> {
    // 1. Audit payload with security redactor
    const diffs: string[] = [];
    if (evidence.workingTreeDiff) {
      diffs.push(evidence.workingTreeDiff);
    }
    if (evidence.gitHistory && evidence.gitHistory.commits) {
      for (const c of evidence.gitHistory.commits) {
        if (c.diff) diffs.push(c.diff);
      }
    }

    const textToScan = [
      evidence.request.selectedCode,
      evidence.request.userQuery || '',
      ...evidence.diagnostics.map((d) => d.message)
    ].join('\n');

    const scanResult = scanPayload({
      selectedText: textToScan,
      commitSubjects: (evidence.gitHistory?.commits || []).map((c: any) => c.subject),
      commitBodies: (evidence.gitHistory?.commits || []).map((c: any) => c.body),
      diffs
    });

    if (scanResult.isBlocked) {
      return {
        status: 'blocked_security',
        error: `Security scan blocked request: ${scanResult.blockReason}`
      };
    }

    // 2. Build structured unified prompt
    const prompt = buildUnifiedAnalysisPrompt(evidence, {
      maxInputTokens: options?.lmModelInstance?.maxInputTokens ?? options?.maxInputTokens
    });

    // 3. Dispatch to VS Code Language Model API (Copilot)
    try {
      const callResult = await callVsCodeLanguageModel(prompt, {
        provider: this.lmProvider,
        modelInstance: options?.lmModelInstance,
        cancellationToken: options?.cancellationToken,
        metadata: {
          commitCount: evidence.gitHistory?.commits?.length || 0,
          diffCharacterCount: prompt.length
        }
      });

      if (!callResult.text || callResult.text.trim().length === 0) {
        return {
          status: 'failed',
          error: 'Language model returned an empty response.',
          diagnostics: callResult.diagnostics
        };
      }

      const explanation = parseUnifiedExplanation(callResult.text, callResult.model);

      return {
        status: 'ok',
        explanation,
        diagnostics: callResult.diagnostics
      };
    } catch (err: any) {
      if (err?.name === 'VsCodeLmError') {
        const diag: RequestDiagnostics = err.diagnostics || {
          provider: 'vscode',
          status: 'failed',
          category: 'UNKNOWN',
          durationMs: 0
        };

        if (options?.cancellationToken?.isCancellationRequested || err.message?.includes('cancelled')) {
          return {
            status: 'cancelled',
            error: 'Unified code analysis cancelled by user.',
            diagnostics: diag
          };
        }

        if (diag.category === 'NOT_FOUND' || err.message?.includes('language models are available')) {
          return {
            status: 'no_model',
            error: err.message || 'No VS Code language models available.',
            diagnostics: diag
          };
        }

        return {
          status: 'failed',
          error: err.message || 'VS Code Language Model error.',
          diagnostics: diag
        };
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        error: errMsg
      };
    }
  }
}
