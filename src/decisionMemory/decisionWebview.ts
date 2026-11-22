/**
 * GitWhisper Decision Memory — Webview Presentation & Interactive Controller
 * Provides developer-preview UI for historical decision discovery and memory lifecycle management.
 */

import { randomBytes } from 'crypto';
import { resolveRepositoryFile } from '../security/repositoryFiles';
import { getDecisionFilePath } from './decisionStorage';
import * as path from 'path';
import type * as vscode from 'vscode';
import { getApprovedLogoDataUri } from '../ui/webviewView';
import {
  HistoricalEvidenceDiscoveryResult
} from './decisionEvidenceTypes';
import {
  convertCandidateToProposedDecision
} from './decisionEvidenceService';
import {
  createDecision,
  disputeDecision,
  getDecision,
  listDecisions,
  retireDecision,
  updateDecision,
  verifyDecision
} from './decisionService';
import { DecisionMemoryRecord } from './decisionTypes';

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
    .replace(/'/g, '&#039;');
}

export class DecisionWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  /**
   * Displays the Decision Discovery and Memory Management webview panel.
   */
  public static async show(
    context: vscode.ExtensionContext,
    result: HistoricalEvidenceDiscoveryResult,
    column?: vscode.ViewColumn,
    initialTab: 'discovery' | 'stored' = 'discovery'
  ): Promise<vscode.WebviewPanel | undefined> {
    return this.open(context, result.repoRoot, result, column, initialTab);
  }

  public static showStored(
    context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<vscode.WebviewPanel | undefined> {
    return this.open(context, repoRoot, undefined, undefined, 'stored');
  }

  private static async open(
    context: vscode.ExtensionContext,
    repoRoot: string,
    result: HistoricalEvidenceDiscoveryResult | undefined,
    column: vscode.ViewColumn | undefined,
    initialTab: 'discovery' | 'stored'
  ): Promise<vscode.WebviewPanel | undefined> {
    const vsc = getVsCode();
    if (!vsc) return undefined;
    this.currentPanel?.dispose();
    const title = 'GitWhisper: Decisions — ' + path.basename(result?.relativeFilePath || repoRoot);
    const panel: vscode.WebviewPanel = vsc.window.createWebviewPanel(
      'gitwhisperDecisions', title, column ?? vsc.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.currentPanel = panel;
    const isCurrent = () => this.currentPanel === panel;
    panel.onDidDispose(() => {
      if (isCurrent()) this.currentPanel = undefined;
    });

    let stored: DecisionMemoryRecord[] = [];
    let busy = false;
    const savedCandidates = new Set<number>();
    const refreshContent = async (tab: 'discovery' | 'stored') => {
      const records = await listDecisions(repoRoot);
      if (!isCurrent()) return;
      stored = records;
      panel.webview.html = this.renderHtml(result, records, tab, repoRoot, savedCandidates);
    };

    panel.webview.onDidReceiveMessage(async message => {
      if (!isCurrent() || !message || typeof message !== 'object' || busy) return;
      if (message.command !== 'openSourceFile' && message.command !== 'saveProposed' &&
          !stored.some(record => record.id === message.id)) return;
      busy = true;
      try {
        switch (message.command) {
          case 'saveProposed': {
            const idx = message.candidateIndex;
            if (!Number.isInteger(idx) || savedCandidates.has(idx)) return;
            const candidate = result?.candidateDecisions[idx];
            if (!candidate) return;

            // Explicit user confirmation (ensures safety on untrusted external repos)
            const confirm = await vsc.window.showInformationMessage(
              `Save proposed decision "${candidate.candidateTitle}" to .gitwhisper/decisions/?`,
              { modal: true },
              'Save Proposed Decision'
            );

            if (isCurrent() && confirm === 'Save Proposed Decision') {
              const input = convertCandidateToProposedDecision(candidate, {
                name: 'GitWhisper Reviewer',
                type: 'ai_assistant',
                modelIdentifier: 'gitwhisper/decision-memory'
              });

              const saved = await createDecision(repoRoot, input);
              savedCandidates.add(idx);
              if (!isCurrent()) return;
              vsc.window.showInformationMessage(
                `Decision ${saved.id} saved as "proposed". Stored at .gitwhisper/decisions/${saved.id}.md`
              );
              await refreshContent('stored');
            }
            break;
          }

          case 'openDecisionFile': {
            const id = message.id;
            if (typeof id !== 'string') return;
            const filePath = getDecisionFilePath(repoRoot, id);
            const doc = await vsc.workspace.openTextDocument(filePath);
            if (isCurrent()) await vsc.window.showTextDocument(doc, { preview: true });
            break;
          }

          case 'openSourceFile': {
            if (!stored.some(record => record.primaryAnchor.filePath === message.filePath)) return;
            const filePath = resolveRepositoryFile(repoRoot, message.filePath);
            if (!filePath) {
              vsc.window.showWarningMessage('This file is absent from the current working tree.');
              return;
            }
            const doc = await vsc.workspace.openTextDocument(filePath);
            if (!isCurrent()) return;
            const editor = await vsc.window.showTextDocument(doc, { preview: true });
            if (isCurrent()) {
              const line = Number.isSafeInteger(message.line) ? message.line : 1;
              const pos = new vsc.Position(Math.max(0, Math.min(line, doc.lineCount) - 1), 0);
              editor.selection = new vsc.Selection(pos, pos);
              editor.revealRange(new vsc.Range(pos, pos), vsc.TextEditorRevealType.InCenter);
            }
            break;
          }

          case 'editRationale': {
            const id = message.id;
            const current = await getDecision(repoRoot, id);
            if (!isCurrent() || !current) return;

            const newRationale = await vsc.window.showInputBox({
              prompt: `Edit human rationale for ${id}`,
              value: current.rationale,
              placeHolder: 'Enter updated architectural rationale...'
            });

            if (isCurrent() && newRationale !== undefined && newRationale.trim().length > 0) {
              await updateDecision(repoRoot, id, { rationale: newRationale.trim() });
              vsc.window.showInformationMessage(`Updated rationale for ${id}.`);
              await refreshContent('stored');
            }
            break;
          }

          case 'verifyDecision': {
            const id = message.id;
            const verifierName = await vsc.window.showInputBox({
              prompt: `Enter your name to verify decision ${id} (Human Reviewer)`,
              placeHolder: 'e.g. Alice Engineer'
            });

            if (isCurrent() && verifierName && verifierName.trim().length > 0) {
              const note = await vsc.window.showInputBox({
                prompt: 'Verification note or review context (optional)',
                placeHolder: 'e.g. Confirmed requirement in architecture meeting'
              });

              if (!isCurrent() || note === undefined) return;
              await verifyDecision(repoRoot, id, {
                verifierName: verifierName.trim(),
                verificationNote: note?.trim() || undefined
              });

              vsc.window.showInformationMessage(`Decision ${id} is now HUMAN-VERIFIED by ${verifierName.trim()}!`);
              await refreshContent('stored');
            }
            break;
          }

          case 'disputeDecision': {
            const id = message.id;
            const reason = await vsc.window.showInputBox({
              prompt: `Reason for disputing decision ${id}`,
              placeHolder: 'e.g. Inaccurate constraint or superseded by new architecture'
            });

            if (isCurrent() && reason && reason.trim().length > 0) {
              await disputeDecision(repoRoot, id, {
                disputerName: 'Developer Reviewer',
                reason: reason.trim()
              });
              vsc.window.showInformationMessage(`Decision ${id} marked as DISPUTED.`);
              await refreshContent('stored');
            }
            break;
          }

          case 'retireDecision': {
            const id = message.id;
            const reason = await vsc.window.showInputBox({
              prompt: `Reason for retiring decision ${id}`,
              placeHolder: 'e.g. Deprecated feature branch; constraint no longer applies'
            });

            if (isCurrent() && reason && reason.trim().length > 0) {
              await retireDecision(
                repoRoot,
                id,
                reason.trim()
              );
              vsc.window.showInformationMessage(`Decision ${id} marked as RETIRED.`);
              await refreshContent('stored');
            }
            break;
          }
        }
      } catch (error) {
        if (isCurrent()) vsc.window.showErrorMessage('GitWhisper decision: ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        busy = false;
      }
    });

    await refreshContent(initialTab);
    return panel;
  }

  /**
   * Generates the complete HTML representation for the Decision Discovery & Memory interface.
   */
  public static renderHtml(
    result: HistoricalEvidenceDiscoveryResult | undefined,
    storedDecisions: DecisionMemoryRecord[] = [],
    initialTab = 'discovery',
    repoRoot = result?.repoRoot ?? '',
    savedCandidates: ReadonlySet<number> = new Set()
  ): string {
    const nonce = randomBytes(16).toString('hex');
    const logoUri = getApprovedLogoDataUri();
    const candidates = result?.candidateDecisions ?? [];
    const limitations = result?.limitations ?? [];
    const categoryBadgeClass: Record<string, string> = {
      bug_fix: 'badge-bug',
      workaround: 'badge-workaround',
      compatibility: 'badge-compat',
      security_constraint: 'badge-security',
      revert: 'badge-revert',
      architectural_migration: 'badge-migration',
      performance_tradeoff: 'badge-perf'
    };

    const statusBadgeClass: Record<string, string> = {
      proposed: 'badge-proposed',
      verified: 'badge-verified',
      disputed: 'badge-disputed',
      retired: 'badge-retired'
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitWhisper: Decision Memory</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      --subtle: var(--vscode-descriptionForeground, #858585);
      --accent: var(--vscode-textLink-foreground, #7c3aed);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px 20px 40px 20px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo { width: 28px; height: 28px; object-fit: contain; }
    .title-group h1 { font-size: 16px; font-weight: 700; }
    .title-group p { font-size: 11px; color: var(--subtle); font-family: var(--font-mono); }
    
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--fg);
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .limitation-box {
      background: rgba(210, 153, 34, 0.12);
      border: 1px solid #d29922;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12px;
      color: #e3b341;
    }
    
    .candidate-card, .decision-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .card-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
    
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 3px;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .badge-bug { background: #b91c1c; color: #fff; }
    .badge-workaround { background: #d97706; color: #fff; }
    .badge-compat { background: #0284c7; color: #fff; }
    .badge-security { background: #7e22ce; color: #fff; }
    .badge-migration { background: #0f766e; color: #fff; }
    .badge-perf { background: #059669; color: #fff; }
    .badge-proposed { background: #d97706; color: #fff; }
    .badge-verified { background: #15803d; color: #fff; }
    .badge-disputed { background: #dc2626; color: #fff; }
    .badge-retired { background: #4b5563; color: #fff; }

    .section-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--subtle);
      margin-top: 10px;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }
    .fact-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .fact-icon { color: #22c55e; font-weight: bold; }
    .hyp-box {
      background: rgba(59, 130, 246, 0.1);
      border-left: 3px solid #3b82f6;
      padding: 6px 10px;
      font-size: 12px;
      margin: 6px 0;
      color: #93c5fd;
    }
    .missing-box {
      background: rgba(234, 179, 8, 0.08);
      border-left: 3px solid #eab308;
      padding: 6px 10px;
      font-size: 12px;
      margin: 6px 0;
      color: #fde047;
    }
    .constraint-box {
      background: rgba(168, 85, 247, 0.08);
      border-left: 3px solid #a855f7;
      padding: 6px 10px;
      font-size: 12px;
      margin: 6px 0;
      color: #d8b4fe;
    }
    
    .commit-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--subtle);
      margin-top: 8px;
    }
    .commit-hash {
      background: rgba(127, 127, 127, 0.15);
      padding: 2px 5px;
      border-radius: 3px;
      color: var(--accent);
    }

    .btn-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .btn {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 3px;
      cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
    .btn-secondary {
      background: rgba(127, 127, 127, 0.15);
      color: var(--fg);
      border: 1px solid var(--card-border);
    }
    .btn-secondary:hover { background: rgba(127, 127, 127, 0.25); }
    .source-link { border: 0; background: none; padding: 0; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
    .btn-verify {
      background: #15803d;
      color: #fff;
    }
    .btn-verify:hover { background: #166534; }
    .btn-warn {
      background: #b45309;
      color: #fff;
    }
    .btn-danger {
      background: #b91c1c;
      color: #fff;
    }
    .empty-state {
      text-align: center;
      padding: 30px 10px;
      color: var(--subtle);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logoUri ? `<img src="${logoUri}" class="logo" alt="GitWhisper" />` : ''}
      <div class="title-group">
        <h1>GitWhisper Decision Memory</h1>
        <p>${result ? `${escapeHtml(result.relativeFilePath)} &middot; ${result.commits.length} commits &middot; ${candidates.length} candidates` : escapeHtml(path.basename(repoRoot))}</p>
      </div>
    </div>
  </div>

  <div class="tabs">
    ${result ? `<button id="tab-btn-discovery" class="tab-btn ${initialTab === 'discovery' ? 'active' : ''}" data-tab="discovery">
      🔍 Discovered Candidates (${candidates.length})
    </button>` : ''}
    <button id="tab-btn-stored" class="tab-btn ${initialTab === 'stored' ? 'active' : ''}" data-tab="stored">
      📚 Stored Decisions (${storedDecisions.length})
    </button>
  </div>

  <!-- TAB 1: DISCOVERED CANDIDATES -->
  <div id="tab-discovery" class="tab-content ${initialTab === 'discovery' ? 'active' : ''}">
    ${limitations.length > 0 ? `
      <div class="limitation-box">
        <strong>Repository Limitations Encountered:</strong>
        <ul style="margin-left: 18px; margin-top: 4px;">
          ${limitations.map(l => `<li><strong>${escapeHtml(l.code)}:</strong> ${escapeHtml(l.description)}</li>`).join('')}
        </ul>
      </div>
    ` : ''}

    ${candidates.length === 0 ? `
      <div class="empty-state">
        <p>No decision candidates detected in the Git history for this target.</p>
        <p style="font-size: 11px; margin-top: 4px;">Routine commits (e.g. typos, chores) are omitted to prevent false-positive architectural noise.</p>
      </div>
    ` : ''}

    ${candidates.map((cand, idx) => `
      <div class="candidate-card">
        <div class="card-head">
          <div>
            <span class="badge ${categoryBadgeClass[cand.category] || 'badge-compat'}">${escapeHtml(cand.category.replace('_', ' '))}</span>
            <div class="card-title" style="margin-top: 6px;">${escapeHtml(cand.candidateTitle)}</div>
          </div>
          <button class="btn" data-action="saveProposed" data-index="${idx}" ${savedCandidates.has(idx) ? 'disabled' : ''}>${savedCandidates.has(idx) ? 'Saved' : 'Propose memory'}</button>
        </div>

        <div class="section-label">Directly Observed Evidence (Verified Git History)</div>
        ${cand.directlyObservedFacts.map(f => `
          <div class="fact-item">
            <span class="fact-icon">✓</span>
            <span>${escapeHtml(f)}</span>
          </div>
        `).join('')}

        <div class="section-label">Inferred Decision Hypotheses (Unverified)</div>
        ${cand.inferredRationaleHypotheses.map(h => `
          <div class="hyp-box">💡 ${escapeHtml(h)}</div>
        `).join('')}

        ${cand.missingOrAmbiguousEvidence.length > 0 ? `
          <div class="section-label">Missing or Ambiguous Context</div>
          ${cand.missingOrAmbiguousEvidence.map(m => `
            <div class="missing-box">⚠ ${escapeHtml(m)}</div>
          `).join('')}
        ` : ''}

        ${cand.potentialConstraints.length > 0 ? `
          <div class="section-label">Suggested constraints for review</div>
          ${cand.potentialConstraints.map(c => `
            <div class="constraint-box">🛡 ${escapeHtml(c)}</div>
          `).join('')}
        ` : ''}

        ${cand.supportingCommits.map(sc => `
          <div class="commit-row">
            <span class="commit-hash">${escapeHtml(sc.shortHash)}</span>
            <span>${escapeHtml(sc.authorName)} (${escapeHtml(sc.commitDate)})</span>
          </div>
        `).join('')}
      </div>
    `).join('')}
  </div>

  <!-- TAB 2: STORED DECISIONS -->
  <div id="tab-stored" class="tab-content ${initialTab === 'stored' ? 'active' : ''}">
    ${storedDecisions.length === 0 ? `
      <div class="empty-state">
        <p>No decision memories stored in <code>.gitwhisper/decisions/</code> yet for this repository.</p>
        <p style="font-size: 11px; margin-top: 6px;">Run historical decision discovery on a source file to review and save a proposed decision.</p>
      </div>
    ` : ''}

    ${storedDecisions.map(dec => `
      <div class="decision-card">
        <div class="card-head">
          <div>
            <span class="badge ${statusBadgeClass[dec.status] || 'badge-proposed'}">${escapeHtml(dec.status)}</span>
            <span style="font-size: 11px; font-family: var(--font-mono); color: var(--subtle); margin-left: 6px;">${escapeHtml(dec.id)}</span>
            <div class="card-title" style="margin-top: 4px;">${escapeHtml(dec.title)}</div>
          </div>
          <button class="btn btn-secondary" data-action="openDecisionFile" data-id="${escapeHtml(dec.id)}">📄 Open .md</button>
        </div>

        <p style="font-size: 11px; color: var(--subtle); margin-bottom: 6px;">
          Anchor: <button class="source-link" data-file="${escapeHtml(dec.primaryAnchor.filePath)}" data-line="${Number(dec.primaryAnchor.startLine) || 1}">${escapeHtml(dec.primaryAnchor.filePath)}${dec.primaryAnchor.startLine ? `:${Number(dec.primaryAnchor.startLine)}` : ''}</button>
          &middot; Created by <strong>${escapeHtml(dec.createdBy.name)}</strong> (${escapeHtml(dec.createdBy.type)})
          ${dec.verifiedBy ? `&middot; <strong style="color: #22c55e;">Verified by ${escapeHtml(dec.verifiedBy.name)}</strong>` : ''}
        </p>

        <div style="background: rgba(127,127,127,0.06); padding: 8px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 8px; white-space: pre-wrap; max-height: 120px; overflow-y: auto;">${escapeHtml(dec.rationale)}</div>

        ${dec.constraints.length > 0 ? `
          <div class="section-label">Developer Constraints</div>
          ${dec.constraints.map(c => `
            <div class="constraint-box">
              <strong>[${escapeHtml(c.id)}] (${escapeHtml(c.severity)}):</strong> ${escapeHtml(c.description)}
              <br><span style="font-size: 11px; opacity: 0.85;">Reason: ${escapeHtml(c.reason)}</span>
            </div>
          `).join('')}
        ` : ''}

        <div class="btn-row">
          <button class="btn btn-secondary" data-action="editRationale" data-id="${escapeHtml(dec.id)}">✏️ Edit Rationale</button>
          ${dec.status !== 'verified' ? `<button class="btn btn-verify" data-action="verifyDecision" data-id="${escapeHtml(dec.id)}">✅ Verify as Human</button>` : ''}
          ${dec.status !== 'disputed' ? `<button class="btn btn-warn" data-action="disputeDecision" data-id="${escapeHtml(dec.id)}">⚠️ Dispute</button>` : ''}
          ${dec.status !== 'retired' ? `<button class="btn btn-danger" data-action="retireDecision" data-id="${escapeHtml(dec.id)}">🛑 Retire</button>` : ''}
        </div>
      </div>
    `).join('')}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
      const name = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === button));
      document.querySelectorAll('.tab-content').forEach(tab => tab.classList.toggle('active', tab.id === 'tab-' + name));
    }));
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.action === 'saveProposed') {
        vscode.postMessage({ command: 'saveProposed', candidateIndex: Number(button.dataset.index) });
      } else {
        vscode.postMessage({ command: button.dataset.action, id: button.dataset.id });
      }
    }));
    document.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openSourceFile', filePath: button.dataset.file, line: Number(button.dataset.line) });
    }));
  </script>
</body>
</html>`;
  }
}
