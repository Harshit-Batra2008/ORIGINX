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
 * Renders the HTML for the VS Code-themed multi-file confirmation webview.
 * Includes file listing, model info, token estimates, real HTML checkbox, and action buttons.
 */
export function renderConfirmationWebviewHtml(
  files: FileEvidence[],
  tokenResult: TokenEstimationResult,
  warnings: string[] = [],
  isMixedRepos: boolean = false
): string {
  const fileCount = files.length;
  const tokenLabel = tokenResult.isExact
    ? `${tokenResult.estimatedTokens.toLocaleString()} tokens (measured)`
    : `~${tokenResult.estimatedTokens.toLocaleString()} tokens (approximate)`;

  const capacityLabel = tokenResult.maxInputTokens
    ? `${tokenResult.maxInputTokens.toLocaleString()} tokens`
    : 'Unknown';

  const fileItemsHtml = files
    .map(
      (f) => `
      <li class="file-item">
        <span class="file-name">${escapeHtml(f.file.fileName)}</span>
        <span class="file-path">${escapeHtml(f.file.relativeFilePath || f.file.filePath)}</span>
        <span class="file-meta">${f.commits.length} commit(s)${f.hasUncommittedChanges ? ' • uncommitted changes' : ''}</span>
      </li>`
    )
    .join('');

  let warningSectionHtml = '';
  if (warnings.length > 0 || isMixedRepos) {
    const list: string[] = [];
    if (isMixedRepos) {
      list.push('Selected files span multiple Git repositories.');
    }
    for (const w of warnings) {
      list.push(w);
    }
    warningSectionHtml = `
      <div class="alert-box warning-box">
        <div class="alert-title">⚠ Notices & Disclosures</div>
        <ul>
          ${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ORIGINX: Multi-File Usage Confirmation</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-editorWidget-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --warning-fg: var(--vscode-editorWarning-foreground, #d29922);
      --warning-bg: rgba(210, 153, 34, 0.12);
      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --font-mono: var(--vscode-editor-font-family, Consolas, monospace);
    }
    * { box-sizing: border-box; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      margin: 0;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header {
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
    }
    .brand {
      font-size: 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tag {
      background: var(--accent);
      color: #fff;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
    }
    .card-title {
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--accent);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .metric-card {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 8px 12px;
    }
    .metric-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .metric-value {
      font-size: 13px;
      font-weight: 600;
      margin-top: 2px;
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: 8px 0 0;
      max-height: 140px;
      overflow-y: auto;
      border: 1px solid var(--card-border);
      border-radius: 4px;
    }
    .file-item {
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
    }
    .file-item:last-child { border-bottom: none; }
    .file-name { font-weight: 600; }
    .file-path { font-family: var(--font-mono); color: var(--vscode-descriptionForeground, #888); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-meta { font-size: 11px; color: var(--accent); white-space: nowrap; }
    .alert-box {
      border-radius: 4px;
      padding: 10px 14px;
      font-size: 12px;
    }
    .warning-box {
      background: var(--warning-bg);
      border: 1px solid var(--warning-fg);
      color: var(--warning-fg);
    }
    .alert-title { font-weight: 600; margin-bottom: 4px; }
    .alert-box ul { margin: 4px 0 0; padding-left: 18px; }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 4px 0;
      user-select: none;
      font-size: 13px;
    }
    .checkbox-row input[type="checkbox"] {
      cursor: pointer;
      width: 16px;
      height: 16px;
      accent-color: var(--btn-bg);
    }
    .checkbox-row label {
      cursor: pointer;
    }
    .action-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 8px;
    }
    .btn {
      padding: 7px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    .btn-primary:hover {
      background: var(--btn-hover);
    }
    .btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
    }
    .btn-secondary:hover {
      background: var(--btn-sec-hover);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ORIGINX <span class="tag">Multi-File Analysis</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Analysis Overview</div>
    <div>Ready to synthesize changes across <strong>${fileCount} file(s)</strong> using local Git evidence and GitHub Copilot.</div>
    <ul class="file-list">
      ${fileItemsHtml}
    </ul>
    <div class="metric-grid">
      <div class="metric-card">
        <div class="metric-label">Selected Model</div>
        <div class="metric-value">${escapeHtml(tokenResult.modelIdentifier)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Payload Size</div>
        <div class="metric-value">${escapeHtml(tokenLabel)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Model Context Window</div>
        <div class="metric-value">${escapeHtml(capacityLabel)}</div>
      </div>
    </div>
  </div>

  ${warningSectionHtml}

  <div class="checkbox-row">
    <input type="checkbox" id="dontShowAgain" name="dontShowAgain" />
    <label for="dontShowAgain">Don't show this confirmation again</label>
  </div>

  <div class="action-buttons">
    <button id="btnCancel" class="btn btn-secondary">Cancel</button>
    <button id="btnAnalyze" class="btn btn-primary">Analyze Files (${fileCount})</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });
    document.getElementById('btnAnalyze').addEventListener('click', () => {
      const cb = document.getElementById('dontShowAgain');
      vscode.postMessage({ command: 'analyze', dontShowAgain: !!(cb && cb.checked) });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Prompts the user with a VS Code-themed Webview usage confirmation panel before multi-file AI analysis.
 *
 * SPECIFICATION GUARANTEES:
 * - Real HTML checkbox labeled "Don't show this confirmation again".
 * - Checkbox is NOT a third action button.
 * - Saves preference ONLY when user clicks "Analyze Files" with checkbox checked.
 * - "Cancel" never alters preferences.
 * - Disabling confirmation never bypasses data-sharing consent (originx.enableAutomaticAnalysis).
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

  return new Promise<MultiFileConfirmationResult>((resolve) => {
    let resolved = false;

    const column = vsc.window.activeTextEditor
      ? vsc.ViewColumn.Beside
      : vsc.ViewColumn.One;

    const panel = vsc.window.createWebviewPanel(
      'originxMultiFileConfirm',
      `ORIGINX: Confirm Analysis (${files.length} files)`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = renderConfirmationWebviewHtml(files, tokenResult, warnings, isMixedRepos);

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve({ confirmed: false, dontShowAgain: false, action: 'cancel' });
      }
    };

    panel.onDidDispose(() => {
      cleanup();
    });

    panel.webview.onDidReceiveMessage(async (message: any) => {
      if (message.command === 'analyze') {
        resolved = true;
        const dontShowAgain = Boolean(message.dontShowAgain);
        if (dontShowAgain) {
          try {
            await config.update('showMultiFileConfirmation', false, vsc.ConfigurationTarget.Global);
            vsc.window.showInformationMessage(
              'ORIGINX: Multi-file usage confirmation disabled. You can restore it anytime from the ORIGINX Command Center.'
            );
          } catch {}
        }
        try {
          panel.dispose();
        } catch {}
        resolve({ confirmed: true, dontShowAgain, action: 'analyze' });
      } else if (message.command === 'cancel') {
        resolved = true;
        try {
          panel.dispose();
        } catch {}
        resolve({ confirmed: false, dontShowAgain: false, action: 'cancel' });
      }
    });
  });
}
