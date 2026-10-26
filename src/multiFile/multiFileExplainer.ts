import {
  callVsCodeLanguageModel,
  ILanguageModelChat,
  ILanguageModelProvider,
  VsCodeLmError
} from '../lm/vscodeLmClient';
import { RequestDiagnostics } from '../gemini/geminiTypes';
import { scanPayload } from '../security/redactor';
import { buildMultiFilePrompt, parseMultiFileExplanation } from './multiFilePrompt';
import { FileEvidence, MultiFileExplanation } from './multiFileTypes';

export interface MultiFileExplainResult {
  status: 'ok' | 'blocked_security' | 'no_model' | 'failed' | 'cancelled';
  explanation?: MultiFileExplanation;
  error?: string;
  diagnostics?: RequestDiagnostics;
}

export class MultiFileExplainer {
  private lmProvider?: ILanguageModelProvider;

  constructor(lmProvider?: ILanguageModelProvider) {
    this.lmProvider = lmProvider;
  }

  /**
   * Generates a synthesized cross-file explanation using the VS Code Language Model API (Copilot).
   *
   * SAFEGUARDS:
   * - Performs credential scanning across all diffs and commit messages prior to prompt creation.
   * - Strictly blocks request if credentials/tokens are detected.
   * - Never introduces external endpoints, API keys, or third-party SDKs.
   * - Fully cancellable via cancellationToken.
   */
  public async explainMultiFileChanges(
    files: FileEvidence[],
    options?: {
      cancellationToken?: any;
      lmModelInstance?: ILanguageModelChat;
    }
  ): Promise<MultiFileExplainResult> {
    // 1. Gather all diffs and texts for credential redactor scanning
    const allSubjects: string[] = [];
    const allBodies: string[] = [];
    const allDiffs: string[] = [];

    for (const f of files) {
      if (f.uncommittedDiff) {
        allDiffs.push(f.uncommittedDiff);
      }
      for (const c of f.commits) {
        if (c.subject) allSubjects.push(c.subject);
        if (c.body) allBodies.push(c.body);
        if (c.diff) allDiffs.push(c.diff);
      }
    }

    const scanResult = scanPayload({
      selectedText: files.map((f) => f.file.fileName).join('\n'),
      commitSubjects: allSubjects,
      commitBodies: allBodies,
      diffs: allDiffs
    });

    if (scanResult.isBlocked) {
      return {
        status: 'blocked_security',
        error: `Security scan blocked request: ${scanResult.blockReason}`
      };
    }

    // 2. Build the bounded cross-file prompt
    const prompt = buildMultiFilePrompt(files, {
      maxInputTokens: options?.lmModelInstance?.maxInputTokens
    });

    const totalDiffChars = files.reduce((acc, f) => acc + (f.totalDiffChars || 0), 0);
    const totalCommits = files.reduce((acc, f) => acc + f.commits.length, 0);

    // 3. Dispatch to VS Code Copilot Language Model
    try {
      const callResult = await callVsCodeLanguageModel(prompt, {
        provider: this.lmProvider,
        modelInstance: options?.lmModelInstance,
        cancellationToken: options?.cancellationToken,
        metadata: {
          commitCount: totalCommits,
          diffCharacterCount: totalDiffChars
        }
      });

      const explanation = parseMultiFileExplanation(callResult.text, files, callResult.model);

      return {
        status: 'ok',
        explanation,
        diagnostics: callResult.diagnostics
      };
    } catch (err: any) {
      if (err instanceof VsCodeLmError) {
        if (err.diagnostics.category === 'NOT_FOUND') {
          return {
            status: 'no_model',
            error: err.message,
            diagnostics: err.diagnostics
          };
        }
        if (options?.cancellationToken?.isCancellationRequested || err.message.includes('cancelled')) {
          return {
            status: 'cancelled',
            error: err.message,
            diagnostics: err.diagnostics
          };
        }
        return {
          status: 'failed',
          error: err.message,
          diagnostics: err.diagnostics
        };
      }

      if (options?.cancellationToken?.isCancellationRequested) {
        return {
          status: 'cancelled',
          error: 'Multi-file analysis was cancelled by the user.'
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
