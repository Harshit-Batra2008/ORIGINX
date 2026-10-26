import type * as vscode from 'vscode';
import { ErrorCategory, RequestDiagnostics } from '../gemini/geminiTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

export interface ILanguageModelChat {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken
  ): Thenable<vscode.LanguageModelChatResponse>;
  countTokens?(text: string | vscode.LanguageModelChatMessage, token?: vscode.CancellationToken): Thenable<number>;
}

export interface ILanguageModelProvider {
  isSupported(): boolean;
  selectChatModels(selector?: vscode.LanguageModelChatSelector): Promise<ILanguageModelChat[]>;
}

/**
 * Standard implementation that delegates to vscode.lm inside the extension host.
 */
export class DefaultVsCodeLanguageModelProvider implements ILanguageModelProvider {
  isSupported(): boolean {
    const vsc = getVsCode();
    return (
      typeof vsc !== 'undefined' &&
      typeof vsc.lm !== 'undefined' &&
      typeof vsc.lm.selectChatModels === 'function'
    );
  }

  async selectChatModels(selector?: vscode.LanguageModelChatSelector): Promise<ILanguageModelChat[]> {
    if (!this.isSupported()) {
      return [];
    }
    const vsc = getVsCode();
    return (await vsc.lm.selectChatModels(selector)) as ILanguageModelChat[];
  }
}

export class VsCodeLmError extends Error {
  public readonly diagnostics: RequestDiagnostics;

  constructor(message: string, diagnostics: RequestDiagnostics) {
    super(message);
    this.name = 'VsCodeLmError';
    this.diagnostics = diagnostics;
  }
}

export interface VsCodeLmExecutionOptions {
  modelSelector?: vscode.LanguageModelChatSelector;
  cancellationToken?: vscode.CancellationToken;
  provider?: ILanguageModelProvider;
  modelInstance?: ILanguageModelChat;
  metadata?: {
    commitCount?: number;
    diffCharacterCount?: number;
  };
}

export interface VsCodeLmCallResult {
  text: string;
  model: string;
  diagnostics: RequestDiagnostics;
}

/**
 * Queries available models dynamically using the VS Code Language Model API.
 */
export async function getAvailableVsCodeModels(
  provider: ILanguageModelProvider = new DefaultVsCodeLanguageModelProvider(),
  selector?: vscode.LanguageModelChatSelector
): Promise<ILanguageModelChat[]> {
  if (!provider.isSupported()) {
    return [];
  }
  try {
    return await provider.selectChatModels(selector);
  } catch {
    return [];
  }
}

/**
 * Formats discovered VS Code Language Models for display in the Output Channel.
 */
export function formatAvailableVsCodeModels(models: ILanguageModelChat[]): string[] {
  const lines: string[] = [];
  const separator = '='.repeat(80);
  lines.push(separator);
  lines.push('  AVAILABLE VS CODE LANGUAGE MODELS (vscode.lm)');
  lines.push(separator);
  lines.push(`Total Models Discovered: ${models.length}`);
  lines.push('');
  lines.push('Vendor     | Family               | Max Tokens | Name / ID');
  lines.push('-'.repeat(80));

  for (const m of models) {
    const vendor = (m.vendor || 'vscode').padEnd(11);
    const family = (m.family || m.id).padEnd(21);
    const tokens = (m.maxInputTokens ? String(m.maxInputTokens) : 'N/A').padEnd(11);
    const name = m.name || m.id;
    lines.push(`${vendor}| ${family}| ${tokens}| ${name}`);
  }

  lines.push(separator);
  lines.push('Note: Models are provided dynamically by active extensions (e.g., GitHub Copilot).');
  lines.push('No external API keys are required when using originx.aiProvider = "vscode".');
  lines.push(separator);
  return lines;
}

/**
 * Sends a code history explanation prompt to a native VS Code language model.
 *
 * SAFETY & COMPATIBILITY GUARANTEES:
 * - Checks vscode.lm API compatibility before invocation.
 * - Discovers available models dynamically; never hardcodes model IDs.
 * - Handles model permissions, unavailable models, and rate limits gracefully.
 * - Streams response text safely; never logs prompt text, code, or raw response bodies.
 * - Supports cancellation via vscode.CancellationToken.
 */
export async function callVsCodeLanguageModel(
  prompt: string,
  options?: VsCodeLmExecutionOptions
): Promise<VsCodeLmCallResult> {
  const provider = options?.provider || new DefaultVsCodeLanguageModelProvider();
  const promptByteLength = Buffer.byteLength(prompt, 'utf8');
  const approximateInputTokens = Math.ceil(prompt.length / 4);

  // 1. Check API compatibility
  if (!provider.isSupported()) {
    const diag: RequestDiagnostics = {
      durationMs: 0,
      stage: 'init',
      category: 'UNSUPPORTED',
      details: 'VS Code Language Model API (vscode.lm) is not available in this VS Code version (requires VS Code 1.90+).',
      model: 'unsupported',
      provider: 'vscode',
      requestSizeBytes: promptByteLength,
      approximateInputTokens
    };
    throw new VsCodeLmError(
      'The VS Code Language Model API is not supported in this version of VS Code. Please update VS Code or set "originx.aiProvider" to "gemini".',
      diag
    );
  }

  // 2. Discover available model dynamically
  let model = options?.modelInstance;
  if (!model) {
    const availableModels = await provider.selectChatModels(options?.modelSelector);
    if (!availableModels || availableModels.length === 0) {
      const diag: RequestDiagnostics = {
        durationMs: 0,
        stage: 'init',
        category: 'NOT_FOUND',
        details: 'No language models returned by vscode.lm.selectChatModels.',
        model: 'none',
        provider: 'vscode',
        requestSizeBytes: promptByteLength,
        approximateInputTokens
      };
      throw new VsCodeLmError(
        'No language models are available via the VS Code Language Model API. Ensure an extension providing language models (such as GitHub Copilot) is installed and active, or switch originx.aiProvider to "gemini".',
        diag
      );
    }
    // Select the first available model discovered dynamically
    model = availableModels[0];
  }

  const modelIdentifier = `${model.vendor ? model.vendor + '/' : ''}${model.family || model.name || model.id}`;
  const startTime = Date.now();

  // 3. Construct user message safely
  const vsc = getVsCode();
  const userMessage = vsc?.LanguageModelChatMessage?.User
    ? vsc.LanguageModelChatMessage.User(prompt)
    : ({ role: 1, content: [{ value: prompt }] } as any);

  try {
    // 4. Send chat request with cancellation support
    const response = await model.sendRequest([userMessage], {}, options?.cancellationToken);

    // 5. Consume streaming text
    let fullText = '';
    for await (const chunk of response.text) {
      if (options?.cancellationToken?.isCancellationRequested) {
        break;
      }
      fullText += chunk;
    }

    const duration = Date.now() - startTime;
    const responseSizeBytes = Buffer.byteLength(fullText, 'utf8');

    if (options?.cancellationToken?.isCancellationRequested) {
      const diag: RequestDiagnostics = {
        durationMs: duration,
        stage: 'timeout',
        category: 'TIMEOUT',
        details: 'Request was cancelled by user.',
        model: modelIdentifier,
        provider: 'vscode',
        requestSizeBytes: promptByteLength,
        approximateInputTokens,
        responseSizeBytes
      };
      throw new VsCodeLmError('Language model request was cancelled.', diag);
    }

    const diag: RequestDiagnostics = {
      durationMs: duration,
      httpStatus: 200,
      stage: 'completed',
      category: 'SUCCESS',
      details: `Successfully generated explanation via VS Code Language Model API in ${duration}ms.`,
      model: modelIdentifier,
      provider: 'vscode',
      requestSizeBytes: promptByteLength,
      approximateInputTokens,
      responseSizeBytes,
      commitCount: options?.metadata?.commitCount,
      diffCharacterCount: options?.metadata?.diffCharacterCount,
      attemptCount: 1
    };

    return {
      text: fullText,
      model: modelIdentifier,
      diagnostics: diag
    };
  } catch (err: any) {
    const duration = Date.now() - startTime;

    if (err instanceof VsCodeLmError) {
      throw err;
    }

    let category: ErrorCategory = 'SERVER_ERROR';
    let userMsg = err?.message || 'VS Code Language Model request failed.';

    // Safely classify standard LanguageModelError cases
    const code = err?.code || '';
    if (
      code === 'NoPermissions' ||
      err?.name === 'NoPermissions' ||
      userMsg.toLowerCase().includes('permission') ||
      userMsg.toLowerCase().includes('consent')
    ) {
      category = 'NO_PERMISSIONS';
      userMsg = 'Permission to access the VS Code language model was not granted. Please allow ORIGINX in the model consent dialog.';
    } else if (
      code === 'Blocked' ||
      err?.name === 'Blocked' ||
      userMsg.toLowerCase().includes('blocked') ||
      userMsg.toLowerCase().includes('quota') ||
      userMsg.toLowerCase().includes('rate limit')
    ) {
      category = 'BLOCKED';
      userMsg = 'VS Code Language Model request was blocked or rate-limited. Please wait a moment and try again.';
    } else if (
      code === 'NotFound' ||
      err?.name === 'NotFound' ||
      userMsg.toLowerCase().includes('not found')
    ) {
      category = 'NOT_FOUND';
      userMsg = 'The requested VS Code language model could not be found or is no longer available.';
    }

    const diag: RequestDiagnostics = {
      durationMs: duration,
      stage: 'reading_body',
      category,
      details: `VS Code LM error (${category}): ${userMsg}`,
      model: modelIdentifier,
      provider: 'vscode',
      requestSizeBytes: promptByteLength,
      approximateInputTokens,
      commitCount: options?.metadata?.commitCount,
      diffCharacterCount: options?.metadata?.diffCharacterCount,
      attemptCount: 1
    };

    throw new VsCodeLmError(userMsg, diag);
  }
}
