import type * as vscode from 'vscode';
import { CommitInfo, GitHistoryResult, SelectionContext } from '../git/gitTypes';
import { GeminiExplanation } from '../gemini/geminiTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

export class WebviewView {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static show(result: GitHistoryResult, extensionUri: vscode.Uri): void {
    const vsc = getVsCode();
    if (!vsc) {
      return;
    }

    try {
      const column = vsc.window.activeTextEditor
        ? vsc.ViewColumn.Beside
        : vsc.ViewColumn.One;

      if (WebviewView.currentPanel) {
        try {
          WebviewView.currentPanel.reveal(column);
        } catch {
          // If reveal failed (e.g. underlying window or editor state destroyed), reset panel reference
          WebviewView.currentPanel = undefined;
        }
      }

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxHistory',
          'ORIGINX: Why Was This Changed?',
          column,
          {
            enableScripts: false, // Strict security: zero script execution
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = `ORIGINX: ${result.selection.fileName}:${result.selection.startLine}-${result.selection.endLine}`;
        WebviewView.currentPanel.webview.html = WebviewView.renderHtml(result);
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display results webview:', err);
    }
  }

  public static dispose(): void {
    try {
      if (this.currentPanel) {
        this.currentPanel.dispose();
        this.currentPanel = undefined;
      }
    } catch {
      this.currentPanel = undefined;
    }
  }

  public static renderHtml(result: GitHistoryResult): string {
    const diag = result.explanationDiagnostics;
    const exp = result.explanation;
    const isVsCode = diag?.provider === 'vscode';

    // Provider / Model header tag
    let providerLabel = 'Local Git Only';
    let providerBadgeClass = 'badge-neutral';
    if (exp) {
      if (isVsCode) {
        providerLabel = `VS Code LM (${this.escapeHtml(exp.model)})`;
        providerBadgeClass = 'badge-provider-vscode';
      } else {
        providerLabel = `Gemini AI (${this.escapeHtml(exp.model)})`;
        providerBadgeClass = 'badge-provider-gemini';
      }
    } else if (result.explanationStatus === 'disabled') {
      providerLabel = 'AI Analysis Disabled';
      providerBadgeClass = 'badge-neutral';
    } else if (result.explanationStatus === 'no_model') {
      providerLabel = 'VS Code LM Unavailable';
      providerBadgeClass = 'badge-warning';
    } else if (result.explanationStatus === 'no_key') {
      providerLabel = 'Gemini Key Missing';
      providerBadgeClass = 'badge-warning';
    } else if (result.explanationStatus === 'blocked_security') {
      providerLabel = 'Security Blocked';
      providerBadgeClass = 'badge-error';
    }

    const durationBadge = diag ? `${(diag.durationMs / 1000).toFixed(1)}s` : '';
    const statusBadge = this.getStatusBadge(result);

    // Default View: Concise Explanation Section
    const conciseExplanationHtml = this.renderConciseExplanation(result);

    // Default View: Supporting Commits Summary
    const supportingCommitsSummaryHtml = this.renderSupportingCommitsSummary(result.commits);

    // Collapsible Section 1: Selected Code Snippet
    const codeSnippetDetailsHtml = this.renderCodeSnippetDetails(result.selection);

    // Collapsible Section 2: Complete Git Evidence & Diffs
    const gitEvidenceDetailsHtml = this.renderGitEvidenceDetails(result);

    // Collapsible Section 3: Technical Diagnostics & Metadata
    const diagnosticsDetailsHtml = this.renderDiagnosticsDetails(result);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>ORIGINX: Why Was This Changed?</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --subtle: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.8));
      --card-bg: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.05));
      --card-border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.2)));
      --hover-bg: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.08));

      --badge-bg: var(--vscode-badge-background, rgba(127, 127, 127, 0.15));
      --badge-fg: var(--vscode-badge-foreground, var(--vscode-foreground));

      --accent: var(--vscode-button-background, #007acc);
      --accent-fg: var(--vscode-button-foreground, #ffffff);

      --diff-add-fg: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
      --diff-add-bg: rgba(46, 160, 67, 0.12);
      --diff-del-fg: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      --diff-del-bg: rgba(248, 81, 73, 0.12);
      --diff-meta-fg: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.8));

      --warning-fg: var(--vscode-editorWarning-foreground, #d29922);
      --warning-bg: rgba(210, 153, 34, 0.12);
      --error-fg: var(--vscode-editorError-foreground, #f85149);
      --error-bg: rgba(248, 81, 73, 0.12);
      --info-fg: var(--vscode-textLink-foreground, #3794ff);
      --info-bg: rgba(55, 148, 255, 0.1);

      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }

    * {
      box-sizing: border-box;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      margin: 0;
      padding: 14px 18px 40px;
    }

    /* Header Bar */
    .app-header {
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
      margin-bottom: 16px;
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin: 0;
      color: var(--fg);
    }

    .brand-tag {
      background: var(--accent);
      color: var(--accent-fg);
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 700;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.2;
    }

    .badge-neutral {
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    .badge-provider-vscode {
      background: var(--info-bg);
      color: var(--info-fg);
      border: 1px solid rgba(55, 148, 255, 0.3);
    }

    .badge-provider-gemini {
      background: rgba(137, 87, 229, 0.12);
      color: var(--vscode-textLink-foreground, #a371f7);
      border: 1px solid rgba(137, 87, 229, 0.3);
    }

    .badge-meta {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--subtle);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .badge-success {
      background: var(--diff-add-bg);
      color: var(--diff-add-fg);
    }

    .badge-warning {
      background: var(--warning-bg);
      color: var(--warning-fg);
    }

    .badge-error {
      background: var(--error-bg);
      color: var(--error-fg);
    }

    .context-bar {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      font-size: 12px;
      color: var(--subtle);
    }

    .context-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .context-label {
      color: var(--subtle);
    }

    .context-value {
      font-weight: 600;
      color: var(--fg);
    }

    /* Explanation Card (Concise default view) */
    .explanation-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }

    .explanation-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .explanation-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--subtle);
      margin: 0;
    }

    .explanation-text {
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
      color: var(--fg);
    }

    .explanation-text:last-child {
      margin-bottom: 0;
    }

    .explanation-lead {
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
      color: var(--fg);
      font-weight: 500;
    }

    .explanation-reasons {
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
      color: var(--fg);
    }

    .uncertainty-box {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11px;
      color: var(--subtle);
    }

    .uncertainty-badge {
      display: inline-block;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--subtle);
      font-weight: 600;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    /* Supporting Commits List (Default view) */
    .supporting-commits-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
    }

    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--subtle);
      margin-bottom: 8px;
    }

    .commit-summary-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 5px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(127, 127, 127, 0.08);
    }

    .commit-summary-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .commit-hash {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--hover-bg);
      border: 1px solid var(--card-border);
      padding: 1px 5px;
      border-radius: 3px;
      color: var(--fg);
      flex-shrink: 0;
    }

    .commit-subject {
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Notice / Banner Boxes */
    .banner {
      padding: 10px 12px;
      border-radius: 6px;
      margin-bottom: 14px;
      font-size: 12px;
      line-height: 1.4;
      border: 1px solid transparent;
    }

    .banner-info {
      background: var(--info-bg);
      border-color: rgba(55, 148, 255, 0.25);
      color: var(--fg);
    }

    .banner-warning {
      background: var(--warning-bg);
      border-color: rgba(210, 153, 34, 0.25);
      color: var(--fg);
    }

    .banner-error {
      background: var(--error-bg);
      border-color: rgba(248, 81, 73, 0.25);
      color: var(--fg);
    }

    /* Collapsible Sections */
    details.collapsible-section {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    summary.collapsible-summary {
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 12px;
      color: var(--fg);
      background: var(--hover-bg);
      list-style: none;
    }

    summary.collapsible-summary::-webkit-details-marker {
      display: none;
    }

    summary.collapsible-summary::before {
      content: '▶';
      font-size: 9px;
      margin-right: 8px;
      color: var(--subtle);
      transition: transform 0.12s ease;
      display: inline-block;
    }

    details[open] > summary.collapsible-summary::before {
      transform: rotate(90deg);
    }

    summary.collapsible-summary:hover {
      background: rgba(127, 127, 127, 0.12);
    }

    .summary-title {
      flex: 1;
    }

    .summary-subtext {
      font-size: 11px;
      font-weight: 400;
      color: var(--subtle);
    }

    .collapsible-content {
      padding: 12px;
      border-top: 1px solid var(--card-border);
    }

    /* Code Block & Diffs */
    pre.code-block {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 8px 10px;
      line-height: 1.4;
    }

    /* Detailed Commit Cards in Collapsible Section */
    .detailed-commit-card {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 5px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .detailed-commit-card:last-child {
      margin-bottom: 0;
    }

    .detailed-commit-header {
      padding: 8px 10px;
      background: var(--hover-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
    }

    .detailed-commit-title {
      font-weight: 600;
      color: var(--fg);
      margin-bottom: 4px;
    }

    .detailed-commit-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11px;
      color: var(--subtle);
    }

    .detailed-commit-body {
      padding: 8px 10px;
      font-size: 12px;
      white-space: pre-wrap;
      border-bottom: 1px solid var(--card-border);
      color: var(--fg);
    }

    pre.diff-block {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      overflow-x: auto;
      padding: 6px 8px;
      line-height: 1.35;
      background: var(--bg);
    }

    .diff-line {
      display: block;
      white-space: pre;
    }

    .diff-line.add {
      background-color: var(--diff-add-bg);
      color: var(--diff-add-fg);
    }

    .diff-line.del {
      background-color: var(--diff-del-bg);
      color: var(--diff-del-fg);
    }

    .diff-line.chunk {
      color: var(--info-fg);
      font-weight: 600;
      margin-top: 2px;
    }

    .diff-line.meta {
      color: var(--diff-meta-fg);
    }

    /* Diagnostic Table */
    .diag-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }

    .diag-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--card-border);
      vertical-align: top;
    }

    .diag-table tr:last-child td {
      border-bottom: none;
    }

    .diag-label {
      color: var(--subtle);
      font-weight: 600;
      width: 150px;
    }

    .diag-value {
      color: var(--fg);
      font-family: var(--font-mono);
      word-break: break-all;
    }

    .empty-state {
      padding: 18px 14px;
      text-align: center;
      color: var(--subtle);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="header-top">
      <div class="brand-row">
        <span class="brand-tag">ORIGINX</span>
        <h1 class="brand-title">Why Was This Changed?</h1>
        <span class="badge ${providerBadgeClass}">${providerLabel}</span>
        ${durationBadge ? `<span class="badge badge-meta">${durationBadge}</span>` : ''}
      </div>
      <div>
        ${statusBadge}
      </div>
    </div>
    <div class="context-bar">
      <span class="context-item">
        <span class="context-label">File:</span>
        <span class="context-value">${this.escapeHtml(result.selection.fileName)}</span>
      </span>
      <span class="context-item">
        <span class="context-label">Range:</span>
        <span class="context-value">Lines ${result.selection.startLine}–${result.selection.endLine}</span>
      </span>
      <span class="context-item">
        <span class="context-label">History:</span>
        <span class="context-value">${result.commits.length} commit${result.commits.length === 1 ? '' : 's'}</span>
      </span>
    </div>
  </header>

  ${conciseExplanationHtml}

  ${supportingCommitsSummaryHtml}

  ${codeSnippetDetailsHtml}

  ${gitEvidenceDetailsHtml}

  ${diagnosticsDetailsHtml}
</body>
</html>`;
  }

  /**
   * Renders the primary default view concise explanation (2-4 sentences) or status notice.
   */
  private static renderConciseExplanation(result: GitHistoryResult): string {
    if (result.explanation) {
      const exp = result.explanation;
      const uncertaintyText = exp.uncertainty
        ? this.escapeHtml(exp.uncertainty)
        : 'Grounded directly in commit history evidence.';

      return `
        <section class="explanation-card">
          <div class="explanation-header">
            <h2 class="explanation-title">Explanation</h2>
            <span class="badge badge-neutral">Evidence-Backed</span>
          </div>
          <div class="explanation-lead">
            ${this.escapeHtml(exp.whatChanged)}
          </div>
          <div class="explanation-reasons">
            ${this.escapeHtml(exp.possibleReasons)}
          </div>
          <div class="uncertainty-box">
            <span class="uncertainty-badge">Uncertainty</span>
            <span>${uncertaintyText}</span>
          </div>
        </section>
      `;
    }

    if (result.explanationStatus === 'disabled') {
      return `
        <div class="banner banner-info">
          <strong>Automatic AI Analysis Disabled:</strong> Local Git history is shown below. Run command
          <code>ORIGINX: Enable Automatic AI Analysis</code> to enable evidence-backed explanations.
        </div>
      `;
    }

    if (result.explanationStatus === 'no_model') {
      return `
        <div class="banner banner-warning">
          <strong>No Language Model Available:</strong> ${this.escapeHtml(result.explanationError || 'No language models discovered via vscode.lm.')}
          <br/>Ensure GitHub Copilot is installed and active, or switch <code>originx.aiProvider</code> to <code>"gemini"</code> in Settings.
        </div>
      `;
    }

    if (result.explanationStatus === 'no_key') {
      return `
        <div class="banner banner-info">
          <strong>Gemini API Key Required:</strong> Gemini API key is not configured.
          Run <code>ORIGINX: Set Gemini API Key</code> or switch <code>originx.aiProvider</code> to <code>"vscode"</code> to use native models.
        </div>
      `;
    }

    if (result.explanationStatus === 'blocked_security') {
      return `
        <div class="banner banner-error">
          <strong>Security Block:</strong> ${this.escapeHtml(result.explanationError || 'Potential sensitive credentials detected.')}
          <br/>AI transmission was blocked to safeguard credentials. Local Git history is preserved below.
        </div>
      `;
    }

    if (result.explanationStatus === 'failed') {
      return `
        <div class="banner banner-warning">
          <strong>AI Explanation Unavailable:</strong> ${this.escapeHtml(result.explanationError || 'Request failed.')}
          <br/>Local Git history is preserved below.
        </div>
      `;
    }

    if (result.explanationStatus === 'cancelled') {
      return `
        <div class="banner banner-info">
          <strong>Note:</strong> AI explanation request was cancelled. Local Git history is preserved below.
        </div>
      `;
    }

    return '';
  }

  /**
   * Renders supporting commits summary in the default view (hashes and subject messages only; no author emails).
   */
  private static renderSupportingCommitsSummary(commits: CommitInfo[]): string {
    if (commits.length === 0) {
      return '';
    }

    const rows = commits
      .map(
        (c) => `
        <div class="commit-summary-row">
          <code class="commit-hash">${this.escapeHtml(c.shortHash)}</code>
          <span class="commit-subject">${this.escapeHtml(c.subject)}</span>
        </div>
      `
      )
      .join('');

    return `
      <section class="supporting-commits-card">
        <div class="section-label">Supporting Commits (${commits.length})</div>
        <div>
          ${rows}
        </div>
      </section>
    `;
  }

  /**
   * Collapsible Section 1: Selected Code Snippet (closed by default).
   */
  private static renderCodeSnippetDetails(selection: SelectionContext): string {
    const lineCount = selection.endLine - selection.startLine + 1;
    return `
      <details class="collapsible-section">
        <summary class="collapsible-summary">
          <span class="summary-title">Selected Code Snippet (Lines ${selection.startLine}–${selection.endLine})</span>
          <span class="summary-subtext">${lineCount} line${lineCount === 1 ? '' : 's'}</span>
        </summary>
        <div class="collapsible-content">
          <pre class="code-block">${this.escapeHtml(selection.selectedText)}</pre>
        </div>
      </details>
    `;
  }

  /**
   * Collapsible Section 2: Complete Git Evidence & Diffs (closed by default).
   * Author emails and full diffs are preserved here in the expanded details.
   */
  private static renderGitEvidenceDetails(result: GitHistoryResult): string {
    if (result.commits.length === 0 && !result.uncommittedDiff) {
      return `
        <details class="collapsible-section">
          <summary class="collapsible-summary">
            <span class="summary-title">Git Evidence & Complete Diffs (0 Commits)</span>
            <span class="summary-subtext">Empty</span>
          </summary>
          <div class="collapsible-content">
            <div class="empty-state">${this.escapeHtml(result.message || 'No commits found for selected lines.')}</div>
          </div>
        </details>
      `;
    }

    const uncommittedHtml =
      result.hasUncommittedChanges && result.uncommittedDiff
        ? `
        <div class="detailed-commit-card" style="border-color: var(--warning-fg);">
          <div class="detailed-commit-header">
            <span class="badge badge-warning">Uncommitted Changes</span>
            <span class="summary-subtext">Working copy contains modifications</span>
          </div>
          <div class="detailed-commit-body">
            <pre class="diff-block">${this.renderDiff(result.uncommittedDiff)}</pre>
          </div>
        </div>
      `
        : '';

    const commitsHtml = result.commits
      .map(
        (c, i) => `
        <div class="detailed-commit-card">
          <div class="detailed-commit-header">
            <div class="detailed-commit-title">
              <span class="commit-hash">${this.escapeHtml(c.shortHash)}</span>
              ${this.escapeHtml(c.subject)}
            </div>
            <div class="detailed-commit-meta">
              <span>Author: <strong>${this.escapeHtml(c.authorName)}</strong> &lt;${this.escapeHtml(c.authorEmail)}&gt;</span>
              <span>Date: <strong>${this.escapeHtml(c.date)}</strong></span>
              <span>Commit: <strong>${i + 1} of ${result.commits.length}</strong></span>
              <span>Full Hash: <code style="font-family: var(--font-mono);">${this.escapeHtml(c.hash)}</code></span>
            </div>
          </div>
          ${c.body ? `<div class="detailed-commit-body">${this.escapeHtml(c.body)}</div>` : ''}
          ${
            c.diff
              ? `<pre class="diff-block">${this.renderDiff(c.diff)}</pre>`
              : '<div class="empty-state">(No diff recorded for this commit)</div>'
          }
        </div>
      `
      )
      .join('');

    const countLabel = `${result.commits.length} Commit${result.commits.length === 1 ? '' : 's'}${result.hasUncommittedChanges ? ' + uncommitted' : ''}`;

    return `
      <details class="collapsible-section">
        <summary class="collapsible-summary">
          <span class="summary-title">Git Evidence & Complete Diffs (${countLabel})</span>
          <span class="summary-subtext">Full commit diffs & metadata</span>
        </summary>
        <div class="collapsible-content">
          ${uncommittedHtml}
          ${commitsHtml}
        </div>
      </details>
    `;
  }

  /**
   * Collapsible Section 3: Technical Diagnostics & Metadata (closed by default).
   * Absolute local paths and telemetry details are safely kept here.
   */
  private static renderDiagnosticsDetails(result: GitHistoryResult): string {
    const diag = result.explanationDiagnostics;
    const exp = result.explanation;

    const rows: Array<{ label: string; value: string }> = [
      { label: 'File (Basename)', value: result.selection.fileName },
      { label: 'Line Range', value: `${result.selection.startLine} - ${result.selection.endLine}` },
      { label: 'Local Path', value: result.selection.filePath }
    ];

    if (result.relativeFilePath) {
      rows.push({ label: 'Repo Path', value: result.relativeFilePath });
    }

    rows.push({ label: 'Git Commits Found', value: String(result.commits.length) });
    rows.push({
      label: 'Uncommitted Changes',
      value: result.hasUncommittedChanges ? 'Yes' : 'No'
    });

    if (diag) {
      rows.push({ label: 'AI Provider', value: diag.provider || 'vscode' });
      rows.push({ label: 'Model Identifier', value: diag.model || (exp ? exp.model : 'N/A') });
      rows.push({
        label: 'Duration',
        value: `${diag.durationMs}ms (${(diag.durationMs / 1000).toFixed(2)}s)`
      });
      if (diag.httpStatus !== undefined) {
        rows.push({ label: 'HTTP Status', value: String(diag.httpStatus) });
      }
      rows.push({ label: 'Category', value: diag.category });
      rows.push({ label: 'Stage', value: diag.stage });
      if (diag.requestSizeBytes !== undefined) {
        rows.push({
          label: 'Request Size',
          value: `${diag.requestSizeBytes} bytes (~${diag.approximateInputTokens ?? 0} tokens)`
        });
      }
      if (diag.responseSizeBytes !== undefined) {
        rows.push({ label: 'Response Size', value: `${diag.responseSizeBytes} bytes` });
      }
      if (diag.attemptCount !== undefined) {
        rows.push({ label: 'Attempt Count', value: String(diag.attemptCount) });
      }
      if (diag.details) {
        rows.push({ label: 'Diagnostic Details', value: diag.details });
      }
    } else {
      rows.push({ label: 'Explanation Status', value: result.explanationStatus || 'none' });
    }

    const tableRows = rows
      .map(
        (r) => `
        <tr>
          <td class="diag-label">${this.escapeHtml(r.label)}</td>
          <td class="diag-value">${this.escapeHtml(r.value)}</td>
        </tr>
      `
      )
      .join('');

    return `
      <details class="collapsible-section">
        <summary class="collapsible-summary">
          <span class="summary-title">Technical Diagnostics & Metadata</span>
          <span class="summary-subtext">Local path & safe telemetry</span>
        </summary>
        <div class="collapsible-content">
          <table class="diag-table">
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  private static renderDiff(rawDiff: string): string {
    const MAX_RENDER_DIFF_CHARS = 100000;
    let diffToRender = rawDiff;
    let truncatedNotice = '';

    if (rawDiff.length > MAX_RENDER_DIFF_CHARS) {
      diffToRender = rawDiff.substring(0, MAX_RENDER_DIFF_CHARS);
      truncatedNotice = `\n... [Diff preview bounded to 100,000 characters for performance (${rawDiff.length.toLocaleString()} total characters). Full diff available in Output Channel or Git log.]`;
    }

    const lines = diffToRender.split(/\r?\n/);
    const rendered = lines
      .map((line) => {
        const escaped = this.escapeHtml(line);
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return `<span class="diff-line add">${escaped}</span>`;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return `<span class="diff-line del">${escaped}</span>`;
        }
        if (line.startsWith('@@')) {
          return `<span class="diff-line chunk">${escaped}</span>`;
        }
        if (
          line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('---') ||
          line.startsWith('+++')
        ) {
          return `<span class="diff-line meta">${escaped}</span>`;
        }
        return `<span class="diff-line">${escaped}</span>`;
      })
      .join('');

    return truncatedNotice
      ? `${rendered}<div class="diff-line meta">${this.escapeHtml(truncatedNotice)}</div>`
      : rendered;
  }

  private static getStatusBadge(result: GitHistoryResult): string {
    switch (result.status) {
      case 'ok':
        return `<span class="badge badge-success">${result.commits.length} Commit${result.commits.length === 1 ? '' : 's'}</span>`;
      case 'no_git':
        return '<span class="badge badge-error">Git Not Found</span>';
      case 'not_a_repo':
        return '<span class="badge badge-warning">Not A Git Repo</span>';
      case 'untracked_file':
        return '<span class="badge badge-warning">Untracked File</span>';
      case 'empty_repo':
        return '<span class="badge badge-warning">Empty Repo</span>';
      case 'uncommitted_only':
        return '<span class="badge badge-warning">Uncommitted Only</span>';
      case 'no_history_for_selection':
        return '<span class="badge badge-warning">No History</span>';
      case 'cancelled':
        return '<span class="badge badge-neutral">Cancelled</span>';
      case 'error':
        return '<span class="badge badge-error">Git Error</span>';
    }
  }

  public static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
