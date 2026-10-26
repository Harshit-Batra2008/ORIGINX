import type * as vscode from 'vscode';
import { ILanguageModelChat } from '../lm/vscodeLmClient';
import { FileEvidence, MultiFileConfirmationResult, TokenEstimationResult } from './multiFileTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Builds a representative multi-file prompt string for accurate token estimation.
 */
export function buildMultiFileEstimationPrompt(files: FileEvidence[]): string {
  const parts: string[] = [
    '<<<ORIGINX MULTI-FILE SYNTHESIS PROMPT>>>',
    'Task: Explain relationships and causes of changes across the following files.'
  ];

  for (const f of files) {
    parts.push(`\n=== File: ${f.file.relativeFilePath || f.file.fileName} ===`);
    if (f.hasUncommittedChanges && f.uncommittedDiff) {
      parts.push(`[Uncommitted Diff]:\n${f.uncommittedDiff.substring(0, 1000)}`);
    }
    for (const c of f.commits.slice(0, 5)) {
      parts.push(`Commit ${c.shortHash} by ${c.authorName}: ${c.subject}`);
      if (c.diff) {
        parts.push(c.diff.substring(0, 1000));
      }
    }
  }

  return parts.join('\n');
}

/**
 * Estimates input tokens for the multi-file analysis payload.
 * Prefers native model.countTokens() where supported; falls back to labeled approximation.
 * Never claims knowledge of user's remaining quota.
 */
export async function estimateMultiFileTokens(
  files: FileEvidence[],
  model?: ILanguageModelChat,
  cancellationToken?: any
): Promise<TokenEstimationResult> {
  const prompt = buildMultiFileEstimationPrompt(files);
  const modelIdentifier = model ? `${model.vendor ? model.vendor + '/' : ''}${model.name || model.id}` : 'GitHub Copilot';

  if (model && typeof model.countTokens === 'function') {
    try {
      const count = await model.countTokens(prompt, cancellationToken);
      if (typeof count === 'number' && count > 0) {
        return {
          estimatedTokens: count,
          isExact: true,
          method: 'model.countTokens',
          modelIdentifier,
          maxInputTokens: model.maxInputTokens
        };
      }
    } catch {
      // Fallback to estimation if model.countTokens fails
    }
  }

  const approxTokens = Math.ceil(prompt.length / 4);
  return {
    estimatedTokens: approxTokens,
    isExact: false,
    method: 'approximate',
    modelIdentifier,
    maxInputTokens: model?.maxInputTokens
  };
}

/**
 * Prompts the user with a usage confirmation dialog before any multi-file AI request.
 * Contains file count, names, model, estimated tokens, capacity, warnings, and preferences.
 */
export async function promptMultiFileUsageConfirmation(
  files: FileEvidence[],
  tokenResult: TokenEstimationResult,
  warnings: string[] = [],
  isMixedRepos: boolean = false
): Promise<MultiFileConfirmationResult> {
  const vsc = getVsCode();
  if (!vsc) {
    return { confirmed: true, dontShowAgain: false, action: 'analyze' };
  }

  const config = vsc.workspace.getConfiguration('originx');
  const showConfirmation = config.get('showMultiFileConfirmation', true);

  if (!showConfirmation) {
    return { confirmed: true, dontShowAgain: false, action: 'analyze' };
  }

  const fileCount = files.length;
  const fileNames = files.map((f) => f.file.fileName);
  const sampleNames = fileNames.slice(0, 3).join(', ');
  const remainingCount = fileCount - 3;
  const filesLabel = remainingCount > 0 ? `${sampleNames} (+${remainingCount} more)` : sampleNames;

  const tokenLabel = tokenResult.isExact
    ? `${tokenResult.estimatedTokens.toLocaleString()} tokens (measured)`
    : `~${tokenResult.estimatedTokens.toLocaleString()} tokens (estimated)`;

  const capacityLabel = tokenResult.maxInputTokens
    ? ` | Model context window: ${tokenResult.maxInputTokens.toLocaleString()} tokens`
    : '';

  const warningSection = warnings.length > 0
    ? `\n\nWarnings:\n${warnings.map((w) => `• ${w}`).join('\n')}`
    : '';

  const mixedRepoWarning = isMixedRepos
    ? '\n• Note: Selected files span multiple Git repositories.'
    : '';

  const message =
    `ORIGINX: Multi-File Usage Confirmation\n\n` +
    `Ready to analyze ${fileCount} file(s): [${filesLabel}]\n` +
    `• Model: ${tokenResult.modelIdentifier}${capacityLabel}\n` +
    `• Payload size: ${tokenLabel}` +
    mixedRepoWarning +
    warningSection;

  const analyzeOption = `Analyze (${fileCount} files)`;
  const dontShowAgainOption = "Don't Show Again";
  const cancelOption = 'Cancel';

  const choice = await vsc.window.showInformationMessage(
    message,
    { modal: true },
    analyzeOption,
    dontShowAgainOption,
    cancelOption
  );

  if (choice === analyzeOption) {
    return { confirmed: true, dontShowAgain: false, action: 'analyze' };
  }

  if (choice === dontShowAgainOption) {
    try {
      await config.update('showMultiFileConfirmation', false, vsc.ConfigurationTarget.Global);
      vsc.window.showInformationMessage(
        'ORIGINX: Multi-file usage confirmation disabled. You can re-enable it anytime from the ORIGINX Command Center.'
      );
    } catch {}
    return { confirmed: true, dontShowAgain: true, action: 'analyze' };
  }

  return { confirmed: false, dontShowAgain: false, action: 'cancel' };
}
