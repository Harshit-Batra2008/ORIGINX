/**
 * GitWhisper — Flagship "Ask Why" Webview Interfaces
 * Level 1: Compact Persistent Activity Bar Sidebar (WebviewViewProvider)
 * Level 2: Full 5-Section Detailed Investigation (WebviewPanel)
 */

import type * as vscode from 'vscode';
import * as path from 'path';
import { getApprovedLogoDataUri } from '../ui/webviewView';
import { AskWhyResult, AskWhyCitation } from './askWhyTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdownBasic(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      out.push(inCodeBlock ? '<pre><code>' : '</code></pre>');
      continue;
    }

    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    if (line.startsWith('### ')) {
      out.push(`<h3>${escapeHtml(line.substring(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      out.push(`<h2>${escapeHtml(line.substring(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      out.push(`<h1>${escapeHtml(line.substring(2))}</h1>`);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      out.push(`<li>${escapeHtml(line.substring(2))}</li>`);
    } else if (line.startsWith('> ')) {
      const quoteText = line.substring(2).trim();
      let formatted = escapeHtml(quoteText);
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
      out.push(`<blockquote>${formatted}</blockquote>`);
    } else if (!line.trim()) {
      out.push('<br/>');
    } else {
      let formatted = escapeHtml(line);
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
      out.push(`<p>${formatted}</p>`);
    }
  }

  return out.join('\n');
}

/**
 * Level 1: Renders the compact persistent sidebar HTML for WebviewViewProvider.
 */
export function renderAskWhySidebarHtml(result?: AskWhyResult): string {
  const logoUri = getApprovedLogoDataUri();

  if (!result) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper</title>
  <style>${getSidebarStyles()}</style>
</head>
<body>
  <div class="sidebar-header">
    <div class="brand">
      ${logoUri ? `<img src="${logoUri}" alt="GitWhisper" />` : ''}
      <div>
        <div class="brand-title">GitWhisper</div>
        <div class="brand-subtitle">Why The Code Is Like This</div>
      </div>
    </div>
  </div>

  <div class="empty-state">
    <div class="empty-icon">&#x1F50E;</div>
    <div class="empty-title">Select Code to Understand Intent</div>
    <div class="empty-desc">
      Highlight unfamiliar code in your editor, then ask why it was written, what PR introduced it, or what design decisions govern it.
    </div>
    <button class="btn btn-primary" onclick="postAction('askWhy')">Ask Why for Selection</button>
    <button class="btn btn-secondary" onclick="postAction('reviewWorkingTree')">Review Working Tree Changes</button>
    <button class="btn btn-secondary" onclick="postAction('continuityMenu')">Continuity Menu…</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(type) { vscode.postMessage({ command: type }); }
  </script>
</body>
</html>`;
  }

  const diag = result.diagnostics;

  // Evidence badge
  let qualityBadgeClass = 'badge-supported';
  let qualityLabel = 'Directly Supported';
  if (result.evidenceClassification === 'partially_supported') {
    qualityBadgeClass = 'badge-partial';
    qualityLabel = 'Partially Supported';
  } else if (result.evidenceClassification === 'insufficient_evidence') {
    qualityBadgeClass = 'badge-insufficient';
    qualityLabel = 'Insufficient Evidence';
  }

  // Supersession pill
  let supersessionClass = 'pill-current';
  let supersessionLabel = 'No Supersession Identified (Current)';
  if (result.isRefusalOrInsufficient || result.evidenceClassification === 'insufficient_evidence') {
    supersessionClass = 'pill-unknown';
    supersessionLabel = 'Supersession Unverified (No historical rationale found)';
  } else if (result.supersessionStatus === 'explicitly_superseded') {
    supersessionClass = 'pill-superseded';
    supersessionLabel = 'Explicitly Superseded';
  } else if (result.supersessionStatus === 'potentially_affected') {
    supersessionClass = 'pill-partial';
    supersessionLabel = 'Potentially Affected / Needs Review';
  } else if (result.supersessionStatus === 'unknown') {
    supersessionClass = 'pill-unknown';
    supersessionLabel = 'Supersession Unverified (Absence of evidence ≠ verified current)';
  }

  // Citations: Top 2-3 most relevant for compact sidebar
  const primaryCitations = result.citations.slice(0, 3);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Ask Why</title>
  <style>${getSidebarStyles()}</style>
</head>
<body>
  <div class="sidebar-header">
    <div class="brand">
      ${logoUri ? `<img src="${logoUri}" alt="GitWhisper" />` : ''}
      <div>
        <div class="brand-title">GitWhisper: Ask Why</div>
        <div class="brand-subtitle">Why The Code Is Like This</div>
      </div>
    </div>
  </div>

  <div class="status-strip">
    <div class="status-row">
      <span class="status-label">Confidence:</span>
      <span class="badge ${qualityBadgeClass}">${qualityLabel}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Supersession:</span>
      <span class="badge ${supersessionClass}">${supersessionLabel}</span>
    </div>
  </div>

  <div class="target-card">
    <div class="target-path">${escapeHtml(path.basename(result.target.filePath))}</div>
    <div class="target-lines">
      ${result.target.lineRange ? `Lines ${result.target.lineRange.startLine}–${result.target.lineRange.endLine}` : 'Entire File'}
      ${result.target.commitHash ? ` &bull; Commit <code>${escapeHtml(result.target.commitHash.slice(0, 7))}</code>` : ''}
    </div>
  </div>

  <div class="question-box">
    <div class="question-label">Question:</div>
    <div class="question-text">${escapeHtml(result.question)}</div>
  </div>

  ${result.isRefusalOrInsufficient ? `
    <div class="refusal-box">
      <strong>INSUFFICIENT HISTORICAL EVIDENCE:</strong> The recorded commit history, pull requests, and repository documentation do not state the engineering reason for this implementation.
      <div style="margin-top: 8px;">
        <button class="btn btn-secondary" onclick="postAction('explainCodeInstead')">Explain Code Instead (Source Semantics)</button>
      </div>
    </div>
  ` : ''}

  <div class="answer-box">
    <div class="answer-label">Historical Rationale:</div>
    <div class="answer-body">${renderMarkdownBasic(result.answer)}</div>
  </div>

  ${primaryCitations.length > 0 ? `
    <div class="citations-section">
      <div class="section-heading">Key Historical Evidence (${primaryCitations.length}):</div>
      <div class="citation-list">
        ${primaryCitations.map(c => `
          <div class="citation-card">
            <div class="citation-card-header">
              <span class="citation-type-tag">${escapeHtml(c.type.replace('_', ' '))}</span>
              ${c.url ? `<a href="${escapeHtml(c.url)}" class="citation-link" target="_blank">${escapeHtml(c.identifier)}</a>` : `<strong class="citation-id">${escapeHtml(c.identifier)}</strong>`}
            </div>
            ${c.title ? `<div class="citation-title">${escapeHtml(c.title)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  ` : ''}

  <div class="actions-section">
    <button class="btn btn-primary" onclick="postAction('openFullInvestigation')">Open Full Investigation</button>
    <button class="btn btn-secondary" onclick="postAction('explainRoleAndImpact')">Explain Role &amp; Impact</button>
    <button class="btn btn-secondary" onclick="postAction('functionEvolution')">Multi-PR Evolution</button>
    <button class="btn btn-secondary" onclick="postAction('explainCode')">Explain Code</button>
    <button class="btn btn-secondary" onclick="postAction('askNewQuestion')">Ask Another Question</button>
    <button class="btn btn-secondary" onclick="postAction('copyAnswer')">Copy Explanation</button>
    <button class="btn btn-secondary" onclick="postAction('saveDecision')">Save as Decision Memory</button>
    <button class="btn btn-secondary" onclick="postAction('saveCheckpoint')">Save Context Checkpoint</button>
    <button class="btn btn-secondary" onclick="postAction('continuityMenu')">Continuity Menu…</button>
  </div>

  <div class="sidebar-footer">
    <span>Source: ${escapeHtml(diag.retrievalSourceLabel)}</span>
    <span>Retrieval: ${diag.retrievalDurationMs}ms | AI: ${diag.aiDurationMs}ms</span>
    <span>Tokens: ~${diag.approximateTokens}</span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(type) { vscode.postMessage({ command: type }); }
  </script>
</body>
</html>`;
}

/**
 * Level 2: Renders the full 5-section detailed investigation interface matching original GitWhisper UI.
 */
export function renderAskWhyFullInvestigationHtml(result: AskWhyResult): string {
  const logoUri = getApprovedLogoDataUri();
  const diag = result.diagnostics;

  let qualityBadgeClass = 'badge-supported';
  let qualityLabel = 'Directly Supported';
  if (result.evidenceClassification === 'partially_supported') {
    qualityBadgeClass = 'badge-partial';
    qualityLabel = 'Partially Supported';
  } else if (result.evidenceClassification === 'insufficient_evidence') {
    qualityBadgeClass = 'badge-insufficient';
    qualityLabel = 'Insufficient Evidence';
  }

  let supersessionLabel = 'No Supersession Identified (Current)';
  let supersessionClass = 'badge-supported';
  if (result.isRefusalOrInsufficient || result.evidenceClassification === 'insufficient_evidence') {
    supersessionClass = 'badge-neutral';
    supersessionLabel = 'Supersession Unverified (No historical rationale found)';
  } else if (result.supersessionStatus === 'explicitly_superseded') {
    supersessionClass = 'badge-insufficient';
    supersessionLabel = 'Explicitly Superseded';
  } else if (result.supersessionStatus === 'potentially_affected') {
    supersessionClass = 'badge-partial';
    supersessionLabel = 'Potentially Affected / Needs Review';
  } else if (result.supersessionStatus === 'unknown') {
    supersessionClass = 'badge-neutral';
    supersessionLabel = 'Supersession Unverified (Absence of evidence ≠ verified current)';
  }

  const allCommits = result.citations.filter(c => c.type === 'commit');
  const allPrs = result.citations.filter(c => c.type === 'pull_request');
  const allDocs = result.citations.filter(c => c.type === 'design_doc');
  const allIssues = result.citations.filter(c => c.type === 'issue');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Ask Why Investigation</title>
  <style>${getFullInvestigationStyles()}</style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logoUri ? `<img src="${logoUri}" alt="GitWhisper" />` : ''}
      <div>
        <div class="brand-title">GitWhisper: Ask Why (Full Investigation)</div>
        <div class="brand-subtitle">Why The Code Is Like This &bull; ${escapeHtml(result.target.filePath)}${result.target.lineRange ? ` (Lines ${result.target.lineRange.startLine}–${result.target.lineRange.endLine})` : ''}</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary" onclick="postAction('explainRoleAndImpact')">Role &amp; Impact</button>
      <button class="btn btn-secondary" onclick="postAction('functionEvolution')">Multi-PR Evolution</button>
      <button class="btn btn-secondary" onclick="postAction('copyAnswer')">Copy Explanation</button>
      <button class="btn btn-secondary" onclick="postAction('saveDecision')">Save as Decision Memory</button>
      <button class="btn btn-secondary" onclick="postAction('saveCheckpoint')">Save Context Checkpoint</button>
    </div>
  </div>

  <!-- Observability strip -->
  <div class="observability-strip">
    <span class="badge ${qualityBadgeClass}">${qualityLabel}</span>
    <span class="badge ${supersessionClass}">${supersessionLabel}</span>
    <span class="pill-source">${escapeHtml(diag.retrievalSourceLabel)}</span>
    <span class="metric-pill">Retrieval: ${diag.retrievalDurationMs}ms</span>
    <span class="metric-pill">AI Latency: ${diag.aiDurationMs}ms</span>
    <span class="metric-pill">~${diag.approximateTokens} tokens</span>
    <span class="metric-pill">Model: ${escapeHtml(diag.modelName)}</span>
  </div>

  <!-- Navigation Tabs (Original 5-Section Architecture) -->
  <div class="tabs-nav">
    <button class="tab-btn active" data-tab="tab-why">&#x1F4A1; 1. Explanation / Why</button>
    <button class="tab-btn" data-tab="tab-commits">&#x1F552; 2. Commits &amp; PRs (${allCommits.length + allPrs.length})</button>
    <button class="tab-btn" data-tab="tab-graph">&#x1F578; 3. Knowledge Graph &amp; ADRs (${allDocs.length + allIssues.length})</button>
    <button class="tab-btn" data-tab="tab-diffs">&#x29C9; 4. Code &amp; Diffs</button>
    <button class="tab-btn" data-tab="tab-diagnostics">&#x2699; 5. Technical Details</button>
  </div>

  <!-- TAB 1: Explanation / Why -->
  <div id="tab-why" class="tab-pane active">
    <div class="card">
      <div class="card-title">Developer Question</div>
      <div class="question-text">${escapeHtml(result.question)}</div>
    </div>

    ${result.isRefusalOrInsufficient ? `
      <div class="refusal-banner">
        <strong>INSUFFICIENT HISTORICAL EVIDENCE:</strong> The recorded commit history, pull requests, and repository documentation do not state the engineering reason for this implementation.
      </div>
    ` : ''}

    <div class="card">
      <div class="card-title">Grounded Historical Rationale</div>
      <div class="answer-content">${renderMarkdownBasic(result.answer)}</div>
    </div>

    <div class="card">
      <div class="card-title">Target Code Context (${result.target.filePath}${result.target.lineRange ? ` Lines ${result.target.lineRange.startLine}–${result.target.lineRange.endLine}` : ''})</div>
      <pre class="code-snippet"><code>${escapeHtml(result.target.selectedSnippet || '(Entire file context)')}</code></pre>
    </div>
  </div>

  <!-- TAB 2: Commits & Historical Evolution -->
  <div id="tab-commits" class="tab-pane">
    <div class="card">
      <div class="card-title">Connected Pull Requests (${allPrs.length})</div>
      ${allPrs.length > 0 ? `
        <div class="evidence-grid">
          ${allPrs.map(pr => `
            <div class="evidence-item">
              <div class="evidence-header">
                ${pr.url ? `<a href="${escapeHtml(pr.url)}" target="_blank" class="evidence-link">${escapeHtml(pr.identifier)}</a>` : `<strong>${escapeHtml(pr.identifier)}</strong>`}
                ${pr.author ? `<span class="meta-tag">By @${escapeHtml(pr.author)}</span>` : ''}
                ${pr.date ? `<span class="meta-tag">${escapeHtml(pr.date.substring(0, 10))}</span>` : ''}
              </div>
              <div class="evidence-title">${escapeHtml(pr.title || '')}</div>
              ${pr.excerpt ? `<div class="evidence-excerpt">${escapeHtml(pr.excerpt)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      ` : '<p class="subtle-text">No pull request records correlated with this line range.</p>'}
    </div>

    <div class="card">
      <div class="card-title">Timeline of Historical Commits (${allCommits.length})</div>
      ${allCommits.length > 0 ? `
        <div class="evidence-grid">
          ${allCommits.map(c => `
            <div class="evidence-item">
              <div class="evidence-header">
                <span class="hash-pill">${escapeHtml(c.identifier)}</span>
                ${c.author ? `<span class="meta-tag">@${escapeHtml(c.author)}</span>` : ''}
                ${c.date ? `<span class="meta-tag">${escapeHtml(c.date.substring(0, 10))}</span>` : ''}
              </div>
              <div class="evidence-title">${escapeHtml(c.title || '')}</div>
            </div>
          `).join('')}
        </div>
      ` : '<p class="subtle-text">No commit evolution records found.</p>'}
    </div>
  </div>

  <!-- TAB 3: Knowledge Graph & Related Decisions -->
  <div id="tab-graph" class="tab-pane">
    <div class="card">
      <div class="card-title">Repository Documentation &amp; ADRs (${allDocs.length})</div>
      ${allDocs.length > 0 ? `
        <div class="evidence-grid">
          ${allDocs.map(d => `
            <div class="evidence-item">
              <div class="evidence-header">
                <strong>${escapeHtml(d.identifier)}</strong>
                ${d.title ? `<span class="meta-tag">${escapeHtml(d.title)}</span>` : ''}
              </div>
              ${d.excerpt ? `<div class="evidence-excerpt">${escapeHtml(d.excerpt)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      ` : '<p class="subtle-text">No Architecture Decision Records explicitly reference this component.</p>'}
    </div>

    <div class="card">
      <div class="card-title">Connected Issues &amp; Incident References (${allIssues.length})</div>
      ${allIssues.length > 0 ? `
        <div class="evidence-grid">
          ${allIssues.map(i => `
            <div class="evidence-item">
              <div class="evidence-header">
                ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="evidence-link">${escapeHtml(i.identifier)}</a>` : `<strong>${escapeHtml(i.identifier)}</strong>`}
              </div>
              <div class="evidence-title">${escapeHtml(i.title || '')}</div>
            </div>
          `).join('')}
        </div>
      ` : '<p class="subtle-text">No distinct issue tickets or incidents linked to these changes.</p>'}
    </div>
  </div>

  <!-- TAB 4: Code & Diffs -->
  <div id="tab-diffs" class="tab-pane">
    <div class="card">
      <div class="card-title">Selected Code Snippet (${result.target.filePath})</div>
      <pre class="code-snippet"><code>${escapeHtml(result.target.selectedSnippet || '')}</code></pre>
    </div>
    <div class="card">
      <div class="card-title">Historical Patch Diffs</div>
      <p class="subtle-text">Use the Commits tab or editor context menu to inspect full before/after diffs in VS Code.</p>
    </div>
  </div>

  <!-- TAB 5: Technical Details & Diagnostics -->
  <div id="tab-diagnostics" class="tab-pane">
    <div class="card">
      <div class="card-title">Retrieval Provenance &amp; Verification</div>
      <table class="diag-table">
        <tr><td><strong>Retrieval Duration</strong></td><td>${diag.retrievalDurationMs} ms</td></tr>
        <tr><td><strong>AI Model Latency</strong></td><td>${diag.aiDurationMs} ms</td></tr>
        <tr><td><strong>Retrieval Source</strong></td><td>${escapeHtml(diag.retrievalSourceLabel)}</td></tr>
        <tr><td><strong>Remote Neo4j Aura</strong></td><td>${diag.isNeo4jActive ? 'Active (Live Cluster)' : 'Offline / Local Deterministic Fallback'}</td></tr>
        <tr><td><strong>Estimated Input Tokens</strong></td><td>~${diag.approximateTokens} tokens</td></tr>
        <tr><td><strong>AI Model Provider</strong></td><td>${escapeHtml(diag.modelName)}</td></tr>
        <tr><td><strong>Security Scanning</strong></td><td>Passed (Credentials &amp; secrets neutralized)</td></tr>
        <tr><td><strong>Total Citations</strong></td><td>${result.citations.length} sources</td></tr>
      </table>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(type) { vscode.postMessage({ command: type }); }

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        const pane = document.getElementById(target);
        if (pane) pane.classList.add('active');
      });
    });
  </script>
</body>
</html>`;
}

/**
 * Backward-compatible single-panel HTML exporter.
 */
export function renderAskWhyHtml(result: AskWhyResult): string {
  return renderAskWhyFullInvestigationHtml(result);
}

/**
 * Controller for WebviewPanel (Level 2: Full Investigation).
 */
export class AskWhyWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static async showFullInvestigation(
    context: vscode.ExtensionContext,
    result: AskWhyResult,
    onAskNewQuestion?: (newQuestion: string) => Promise<void>
  ): Promise<void> {
    const vsc = getVsCode();
    if (!vsc || !vsc.window) return;

    const column = vsc.ViewColumn.Beside;

    if (AskWhyWebviewController.currentPanel) {
      AskWhyWebviewController.currentPanel.reveal(column);
    } else {
      const panel = vsc.window.createWebviewPanel(
        'gitwhisper.fullInvestigation',
        `GitWhisper Investigation: ${path.basename(result.target.filePath)}`,
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      AskWhyWebviewController.currentPanel = panel;
      panel.onDidDispose(() => {
        AskWhyWebviewController.currentPanel = undefined;
      }, null, context.subscriptions);
    }

    const panel = AskWhyWebviewController.currentPanel;
    if (!panel) return;

    panel.title = `GitWhisper Investigation: ${path.basename(result.target.filePath)}`;
    panel.webview.html = renderAskWhyFullInvestigationHtml(result);

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'copyAnswer') {
          await vsc.env?.clipboard?.writeText(result.answer);
          void vsc.window.showInformationMessage('GitWhisper: Explanation copied to clipboard.');
        } else if (message.command === 'saveDecision') {
          void vsc.commands.executeCommand('originx.manageDecisions');
        } else if (message.command === 'saveCheckpoint') {
          void vsc.commands.executeCommand('originx.saveContextCheckpoint');
        } else if (message.command === 'askNewQuestion') {
          const newQ = await vsc.window.showInputBox({
            prompt: 'Ask Why: Enter a question about this code',
            value: result.question,
          });
          if (newQ && onAskNewQuestion) {
            await onAskNewQuestion(newQ);
          }
        } else if (message.command === 'explainRoleAndImpact') {
          void vsc.commands.executeCommand('originx.explainRoleAndImpact');
        } else if (message.command === 'functionEvolution') {
          void vsc.commands.executeCommand('originx.functionEvolution');
        } else if (message.command === 'explainCode' || message.command === 'explainCodeInstead') {
          void vsc.commands.executeCommand('originx.explainCode');
        } else if (message.command === 'auditRequirements') {
          void vsc.commands.executeCommand('originx.auditRequirements');
        }
      },
      undefined,
      context.subscriptions
    );
  }

  public static async show(
    context: vscode.ExtensionContext,
    result: AskWhyResult,
    onAskNewQuestion?: (newQuestion: string) => Promise<void>
  ): Promise<void> {
    return this.showFullInvestigation(context, result, onAskNewQuestion);
  }
}

/**
 * WebviewViewProvider for Level 1 Persistent Activity Bar Sidebar.
 */
export class GitWhisperSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'originx.askWhySidebar';
  private view?: vscode.WebviewView;
  private currentResult?: AskWhyResult;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = renderAskWhySidebarHtml(this.currentResult);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const vsc = getVsCode();
      if (!vsc) return;

      switch (message.command) {
        case 'openFullInvestigation':
          if (this.currentResult) {
            await AskWhyWebviewController.showFullInvestigation(this.context, this.currentResult);
          }
          break;
        case 'askWhy':
          void vsc.commands.executeCommand('originx.askWhy');
          break;
        case 'reviewWorkingTree':
          void vsc.commands.executeCommand('originx.reviewWorkingTree');
          break;
        case 'continuityMenu':
          void vsc.commands.executeCommand('originx.commandCenter');
          break;
        case 'saveDecision':
          void vsc.commands.executeCommand('originx.manageDecisions');
          break;
        case 'saveCheckpoint':
          void vsc.commands.executeCommand('originx.saveContextCheckpoint');
          break;
        case 'copyAnswer':
          if (this.currentResult) {
            await vsc.env?.clipboard?.writeText(this.currentResult.answer);
            void vsc.window.showInformationMessage('GitWhisper: Explanation copied to clipboard.');
          }
          break;
        case 'askNewQuestion':
          void vsc.commands.executeCommand('originx.askWhy');
          break;
        case 'explainCodeInstead':
        case 'explainCode':
          void vsc.commands.executeCommand('originx.explainCode');
          break;
        case 'explainRoleAndImpact':
          void vsc.commands.executeCommand('originx.explainRoleAndImpact');
          break;
        case 'functionEvolution':
          void vsc.commands.executeCommand('originx.functionEvolution');
          break;
        case 'auditRequirements':
          void vsc.commands.executeCommand('originx.auditRequirements');
          break;
      }
    });
  }

  public showResult(result: AskWhyResult): void {
    this.currentResult = result;
    if (this.view) {
      this.view.show(true);
      this.view.webview.html = renderAskWhySidebarHtml(result);
    }
  }

  public getCurrentResult(): AskWhyResult | undefined {
    return this.currentResult;
  }
}

function getSidebarStyles(): string {
  return `
    :root {
      --ox-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      --ox-fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground, #cccccc));
      --ox-card: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
      --ox-border: var(--vscode-sideBar-border, var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.2)));
      --ox-accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #007acc));
      --ox-green: var(--vscode-testing-iconPassed, #2ea043);
      --ox-green-bg: rgba(46, 160, 67, 0.14);
      --ox-amber: var(--vscode-editorWarning-foreground, #d29922);
      --ox-amber-bg: rgba(210, 153, 34, 0.14);
      --ox-red: var(--vscode-testing-iconFailed, #f85149);
      --ox-red-bg: rgba(248, 81, 73, 0.14);
    }
    *, *:before, *:after {
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 12px);
      background: var(--ox-bg);
      color: var(--ox-fg);
      margin: 0;
      padding: 12px;
      line-height: 1.5;
      overflow-x: hidden;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--ox-border);
    }
    .brand { display: flex; align-items: center; gap: 8px; }
    .brand img { width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0; }
    .brand-title { font-weight: 700; font-size: 13px; letter-spacing: -0.01em; }
    .brand-subtitle { font-size: 10px; opacity: 0.7; }
    .status-strip {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      flex-wrap: wrap;
    }
    .status-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      opacity: 0.75;
      min-width: 75px;
      padding-top: 2px;
      flex-shrink: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
      flex: 1 1 auto;
    }
    .badge-supported { background: var(--ox-green-bg); color: var(--ox-green); border: 1px solid var(--ox-green); }
    .badge-partial { background: var(--ox-amber-bg); color: var(--ox-amber); border: 1px solid var(--ox-amber); }
    .badge-insufficient { background: var(--ox-red-bg); color: var(--ox-red); border: 1px solid var(--ox-red); }
    .pill-current { background: var(--ox-green-bg); color: var(--ox-green); border: 1px solid var(--ox-green); }
    .pill-superseded { background: var(--ox-red-bg); color: var(--ox-red); border: 1px solid var(--ox-red); }
    .pill-partial { background: var(--ox-amber-bg); color: var(--ox-amber); border: 1px solid var(--ox-amber); }
    .pill-unknown { background: rgba(127, 127, 127, 0.15); color: var(--ox-fg); border: 1px solid var(--ox-border); }
    .target-card {
      background: var(--ox-card);
      border: 1px solid var(--ox-border);
      border-radius: 4px;
      padding: 8px 10px;
      margin-bottom: 10px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .target-path { font-weight: 600; font-size: 12px; word-break: break-all; }
    .target-lines { font-size: 10px; opacity: 0.75; margin-top: 2px; }
    .question-box {
      background: rgba(0, 122, 204, 0.08);
      border-left: 3px solid var(--ox-accent);
      border-radius: 0 4px 4px 0;
      padding: 8px 10px;
      margin-bottom: 10px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .question-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--vscode-textLink-foreground, var(--ox-accent)); }
    .question-text { font-size: 12px; margin-top: 2px; line-height: 1.4; color: var(--ox-fg); }
    .refusal-box {
      background: var(--ox-red-bg);
      border-left: 3px solid var(--ox-red);
      color: var(--ox-red);
      padding: 8px 10px;
      margin-bottom: 10px;
      font-size: 11px;
      border-radius: 0 4px 4px 0;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .answer-box {
      background: var(--ox-card);
      border: 1px solid var(--ox-border);
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 14px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .answer-label { font-size: 10px; font-weight: 700; text-transform: uppercase; opacity: 0.75; margin-bottom: 6px; }
    .answer-body p { margin: 0 0 8px 0; font-size: 12px; line-height: 1.5; }
    .answer-body p:last-child { margin-bottom: 0; }
    .answer-body code {
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
      color: var(--ox-fg);
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .answer-body blockquote {
      border-left: 3px solid var(--vscode-textLink-foreground, var(--ox-accent));
      margin: 8px 0;
      padding: 6px 10px;
      background: var(--vscode-textBlockQuote-background, rgba(0, 122, 204, 0.08));
      color: var(--ox-fg);
      border-radius: 0 4px 4px 0;
      font-size: 11px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .citations-section { margin-bottom: 14px; }
    .section-heading { font-size: 10px; font-weight: 700; text-transform: uppercase; opacity: 0.75; margin-bottom: 8px; }
    .citation-list { display: flex; flex-direction: column; gap: 8px; }
    .citation-card {
      background: var(--ox-card);
      border: 1px solid var(--ox-border);
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .citation-card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .citation-type-tag {
      font-size: 9px;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background, rgba(127, 127, 127, 0.15));
      color: var(--vscode-badge-foreground, var(--ox-fg));
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .citation-link {
      color: var(--vscode-textLink-foreground, var(--ox-accent));
      text-decoration: none;
      font-weight: 600;
      font-size: 11px;
    }
    .citation-link:hover { text-decoration: underline; }
    .citation-id { font-size: 11px; font-weight: 600; }
    .citation-title {
      color: var(--ox-fg);
      opacity: 0.85;
      font-size: 11px;
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .actions-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 14px;
      margin-bottom: 18px;
    }
    .btn {
      width: 100%;
      padding: 8px 12px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      box-sizing: border-box;
      line-height: 1.3;
      border: 1px solid transparent;
      transition: background-color 0.1s ease, border-color 0.1s ease;
    }
    .btn-primary {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #0062a3);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.1));
      color: var(--vscode-button-secondaryForeground, var(--ox-fg));
      border: 1px solid var(--ox-border);
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.2));
    }
    .sidebar-footer {
      border-top: 1px solid var(--ox-border);
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 9px;
      opacity: 0.65;
      line-height: 1.3;
    }
    .empty-state {
      text-align: center;
      padding: 24px 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .empty-icon { font-size: 28px; opacity: 0.7; }
    .empty-title { font-weight: 700; font-size: 13px; }
    .empty-desc { font-size: 11px; opacity: 0.75; margin-bottom: 8px; line-height: 1.4; }
  `;
}

function getFullInvestigationStyles(): string {
  return `
    :root {
      --ox-bg: var(--vscode-editor-background, #1e1e1e);
      --ox-fg: var(--vscode-editor-foreground, #d4d4d4);
      --ox-card: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
      --ox-border: var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.2));
      --ox-accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #3b82f6));
      --ox-green: var(--vscode-testing-iconPassed, #2ea043);
      --ox-green-bg: rgba(46, 160, 67, 0.14);
      --ox-amber: var(--vscode-editorWarning-foreground, #d29922);
      --ox-amber-bg: rgba(210, 153, 34, 0.14);
      --ox-red: var(--vscode-testing-iconFailed, #f85149);
      --ox-red-bg: rgba(248, 81, 73, 0.14);
    }
    *, *:before, *:after {
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--ox-bg);
      color: var(--ox-fg);
      margin: 0;
      padding: 20px;
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--ox-border);
      padding-bottom: 14px;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand img { width: 30px; height: 30px; border-radius: 6px; flex-shrink: 0; }
    .brand-title { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
    .brand-subtitle { font-size: 12px; opacity: 0.7; }
    .header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .observability-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-supported { background: var(--ox-green-bg); color: var(--ox-green); border: 1px solid var(--ox-green); }
    .badge-partial { background: var(--ox-amber-bg); color: var(--ox-amber); border: 1px solid var(--ox-amber); }
    .badge-insufficient { background: var(--ox-red-bg); color: var(--ox-red); border: 1px solid var(--ox-red); }
    .badge-neutral { background: rgba(127, 127, 127, 0.15); color: var(--ox-fg); border: 1px solid var(--ox-border); }
    .pill-source {
      background: rgba(59, 130, 246, 0.12);
      color: var(--vscode-textLink-foreground, #3b82f6);
      border: 1px solid var(--vscode-textLink-foreground, #3b82f6);
      border-radius: 12px;
      padding: 3px 9px;
      font-size: 11px;
    }
    .metric-pill { font-size: 11px; opacity: 0.75; }
    .tabs-nav {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--ox-border);
      margin-bottom: 18px;
      overflow-x: auto;
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--ox-fg);
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      opacity: 0.7;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .tab-btn:hover { opacity: 1; }
    .tab-btn.active {
      opacity: 1;
      border-bottom-color: var(--ox-accent);
      color: var(--vscode-editor-foreground, #ffffff);
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .card {
      background: var(--ox-card);
      border: 1px solid var(--ox-border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .card-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.8;
      margin-bottom: 10px;
    }
    .question-text { font-size: 15px; font-weight: 600; line-height: 1.4; }
    .answer-content { font-size: 13px; line-height: 1.6; word-break: break-word; overflow-wrap: anywhere; }
    .answer-content code {
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
      color: var(--ox-fg);
      padding: 2px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .answer-content blockquote {
      border-left: 3px solid var(--vscode-textLink-foreground, var(--ox-accent));
      margin: 8px 0;
      padding: 6px 10px;
      background: var(--vscode-textBlockQuote-background, rgba(0, 122, 204, 0.08));
      color: var(--ox-fg);
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .code-snippet {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      margin: 0;
      color: var(--ox-fg);
    }
    .refusal-banner {
      background: var(--ox-red-bg);
      border: 1px solid var(--ox-red);
      color: var(--ox-red);
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-weight: 600;
      font-size: 13px;
    }
    .evidence-grid { display: flex; flex-direction: column; gap: 10px; }
    .evidence-item {
      background: var(--ox-card);
      border: 1px solid var(--ox-border);
      border-radius: 4px;
      padding: 10px 12px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .evidence-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
    .evidence-link { color: var(--ox-accent); text-decoration: none; font-weight: 700; font-size: 13px; }
    .evidence-link:hover { text-decoration: underline; }
    .evidence-title { font-size: 13px; font-weight: 600; word-break: break-word; overflow-wrap: anywhere; }
    .evidence-excerpt { font-size: 12px; opacity: 0.85; margin-top: 4px; line-height: 1.4; word-break: break-word; overflow-wrap: anywhere; }
    .meta-tag { font-size: 11px; opacity: 0.75; }
    .hash-pill {
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
      color: var(--ox-fg);
      padding: 1px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .subtle-text { opacity: 0.6; font-size: 12px; font-style: italic; }
    .diag-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .diag-table td { padding: 6px 10px; border-bottom: 1px solid var(--ox-border); }
    .diag-table tr:last-child td { border-bottom: none; }
    .btn {
      padding: 6px 12px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--ox-border);
      background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.1));
      color: var(--vscode-button-secondaryForeground, var(--ox-fg));
      box-sizing: border-box;
      transition: background-color 0.1s ease;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.2)); }
  `;
}
