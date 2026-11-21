import {
  callVsCodeLanguageModel,
  ILanguageModelChat,
  ILanguageModelProvider
} from '../lm/vscodeLmClient';
import { RequestDiagnostics } from '../gemini/geminiTypes';
import { scanPayload } from '../security/redactor';
import { buildReviewerPrompt, parseReviewerExplanation } from './reviewerPrompt';
import { RelatedFileRecommendation, ReviewerExplanation, ReviewerFileChange } from './reviewerTypes';

export interface ReviewerExplainResult {
  status: 'ok' | 'blocked_security' | 'no_model' | 'failed' | 'cancelled';
  explanation?: ReviewerExplanation;
  error?: string;
  diagnostics?: RequestDiagnostics;
}

export class ReviewerExplainer {
  private lmProvider?: ILanguageModelProvider;

  constructor(lmProvider?: ILanguageModelProvider) {
    this.lmProvider = lmProvider;
  }

  /**
   * Generates a reviewer-focused AI explanation of working tree changes and co-change impact.
   * Enforces credential scanning, token budgeting, and cancellation boundaries.
   */
  public async explainWorkingTreeChanges(
    changedFiles: ReviewerFileChange[],
    recommendations: RelatedFileRecommendation[],
    options?: {
      cancellationToken?: any;
      lmModelInstance?: ILanguageModelChat;
    }
  ): Promise<ReviewerExplainResult> {
    // 1. Audit all diffs and file paths with security redactor
    const diffs: string[] = [];
    for (const f of changedFiles) {
      if (f.diff) diffs.push(f.diff);
    }

    const scanResult = scanPayload({
      selectedText: changedFiles.map((f) => f.filePath).join('\n'),
      commitSubjects: [],
      commitBodies: [],
      diffs
    });

    if (scanResult.isBlocked) {
      return {
        status: 'blocked_security',
        error: `Security scan blocked request: ${scanResult.blockReason}`
      };
    }

    // 2. Build reviewer prompt
    const prompt = buildReviewerPrompt(changedFiles, recommendations, {
      maxInputTokens: options?.lmModelInstance?.maxInputTokens
    });

    const totalDiffChars = changedFiles.reduce((acc, f) => acc + (f.diffCharCount || 0), 0);

    // 3. Dispatch to VS Code Language Model API (Copilot)
    try {
      const callResult = await callVsCodeLanguageModel(prompt, {
        provider: this.lmProvider,
        modelInstance: options?.lmModelInstance,
        cancellationToken: options?.cancellationToken,
        metadata: {
          commitCount: changedFiles.length,
          diffCharacterCount: totalDiffChars
        }
      });

      if (!callResult.text || callResult.text.trim().length === 0) {
        return {
          status: 'failed',
          error: 'Language model returned an empty review.',
          diagnostics: callResult.diagnostics
        };
      }

      const explanation = parseReviewerExplanation(callResult.text, callResult.model);

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
          return { status: 'cancelled', error: 'Review was cancelled.', diagnostics: diag };
        }
        if (diag.category === 'NOT_FOUND' || diag.category === 'UNSUPPORTED') {
          return { status: 'no_model', error: err.message, diagnostics: diag };
        }
        return { status: 'failed', error: err.message, diagnostics: diag };
      }

      if (options?.cancellationToken?.isCancellationRequested) {
        return { status: 'cancelled', error: 'Review was cancelled.' };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: msg };
    }
  }
}
