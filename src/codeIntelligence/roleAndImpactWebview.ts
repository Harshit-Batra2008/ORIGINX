/**
 * GitWhisper — Function Role & Impact Webview
 * Renders an interactive evidence view for function behavior, callers, references,
 * blast radius, and degradation indicators.
 */

import * as path from 'path';
import type * as vscode from 'vscode';
import { FunctionRoleAndImpactResult } from './types';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderRoleAndImpactHtml(result: FunctionRoleAndImpactResult): string {
  const fnName = result.enclosingSymbol ? result.enclosingSymbol.name : `Line ${result.targetLine}`;
  const baseName = path.basename(result.targetFile);
  const lsp = result.languageProviderStatus;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>GitWhisper: Function Role & Impact</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: 13px;
      line-height: 1.5;
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      padding: 16px;
      margin: 0;
    }
    h2, h3, h4 { color: var(--vscode-editor-foreground, #ffffff); margin-top: 0; margin-bottom: 8px; }
    .header-bar {
      border-bottom: 1px solid var(--vscode-panel-border, #333333);
      padding-bottom: 12px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-lsp-on { background-color: rgba(46, 160, 67, 0.25); color: #3fb950; border: 1px solid #3fb950; }
    .badge-lsp-off { background-color: rgba(210, 153, 34, 0.25); color: #d29922; border: 1px solid #d29922; }
    .card {
      background-color: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .code-citation {
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      text-decoration: underline;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .section-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333333); }
    th { color: var(--vscode-descriptionForeground, #888888); font-weight: 600; }
    .btn {
      background-color: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-right: 8px;
      margin-bottom: 8px;
    }
    .btn:hover { background-color: var(--vscode-button-hoverBackground, #1177bb); }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .tag {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div>
      <h2>GitWhisper: Function Role &amp; Impact</h2>
      <div><code>${escapeHtml(baseName)}:${result.targetLine}</code> &bull; <strong>${escapeHtml(fnName)}</strong></div>
    </div>
    <div>
      <span class="badge ${lsp.isAvailable ? 'badge-lsp-on' : 'badge-lsp-off'}">
        ${lsp.isAvailable ? '⚡ Language Provider Active' : '⚠️ Static AST Heuristics'}
      </span>
    </div>
  </div>

  ${!lsp.isAvailable ? `
    <div class="card" style="border-left: 3px solid #d29922;">
      <strong>Language Provider Notice:</strong> ${escapeHtml(lsp.diagnostics || 'VS Code Language Provider not available. Using static code entities and Git co-change analysis.')}
    </div>
  ` : ''}

  <div class="card">
    <div class="section-title">🔍 Current Behavior &amp; Enclosing Scope</div>
    <p>${escapeHtml(result.behaviorExplanation)}</p>
    ${result.enclosingSymbol ? `
      <div><strong>Enclosing Range:</strong> <span class="code-citation" onclick="openFile('${escapeHtml(result.targetFile)}', ${result.enclosingSymbol.startLine})">${escapeHtml(result.targetFile)}:${result.enclosingSymbol.startLine}–${result.enclosingSymbol.endLine}</span> [${result.enclosingSymbol.source === 'language_provider' ? 'LSP Verified' : 'AST Extracted'}]</div>
    ` : ''}
    ${result.targetCodeSnippet ? `
      <div style="margin-top: 8px;">
        <pre style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto;"><code>${escapeHtml(result.targetCodeSnippet)}</code></pre>
      </div>
    ` : ''}
  </div>

  <div class="card">
    <div class="section-title">📞 Direct Callers (${result.directCallers.length})</div>
    ${result.directCallers.length === 0 ? `
      <p style="color: var(--vscode-descriptionForeground);">No direct incoming callers returned by language server in current project scope.</p>
    ` : `
      <table>
        <thead><tr><th>Caller Function</th><th>Calling File:Line</th><th>Type</th></tr></thead>
        <tbody>
          ${result.directCallers.map(c => `
            <tr>
              <td><code>${escapeHtml(c.callerName)}</code></td>
              <td><span class="code-citation" onclick="openFile('${escapeHtml(c.citation.filePath)}', ${c.citation.line})">${escapeHtml(path.basename(c.citation.filePath))}:${c.citation.line}</span></td>
              <td><span class="tag">${c.isTestCaller ? '🧪 Test Caller' : '🚀 Production'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>

  <div class="card">
    <div class="section-title">🔗 Project References (Production: ${result.productionReferences.length} | Tests: ${result.testReferences.length})</div>
    <table>
      <thead><tr><th>Reference File:Line</th><th>Classification</th></tr></thead>
      <tbody>
        ${result.productionReferences.concat(result.testReferences).slice(0, 10).map(r => `
          <tr>
            <td><span class="code-citation" onclick="openFile('${escapeHtml(r.citation.filePath)}', ${r.citation.line})">${escapeHtml(path.basename(r.citation.filePath))}:${r.citation.line}</span></td>
            <td><span class="tag">${r.isTest ? '🧪 Test Reference' : '🚀 Production Usage'}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <div class="section-title">💥 Inferred Blast Radius &amp; Regression Lead Areas</div>
    <div><strong>Relevant Tests to Execute:</strong> ${result.blastRadius.relevantTestsToRun.length} test(s)</div>
    ${result.blastRadius.relevantTestsToRun.length > 0 ? `
      <ul style="margin: 6px 0 12px 18px; padding: 0;">
        ${result.blastRadius.relevantTestsToRun.map(t => `
          <li><span class="code-citation" onclick="openFile('${escapeHtml(t.filePath)}', ${t.line || 1})">${escapeHtml(path.basename(t.filePath))}${t.line ? `:${t.line}` : ''}</span> (${t.source})</li>
        `).join('')}
      </ul>
    ` : ''}

    ${result.blastRadius.coupledFiles.length > 0 ? `
      <div style="margin-top: 8px;"><strong>Historically Coupled Companions:</strong></div>
      <ul style="margin: 6px 0 12px 18px; padding: 0;">
        ${result.blastRadius.coupledFiles.map(cf => `
          <li><code>${escapeHtml(path.basename(cf.filePath))}</code> (${cf.sharedCommitCount} shared commit(s))</li>
        `).join('')}
      </ul>
    ` : ''}

    ${result.blastRadius.historicalFixLeads.length > 0 ? `
      <div style="margin-top: 8px;"><strong>Historical Bug Fixes Touching This File:</strong></div>
      <ul style="margin: 6px 0 12px 18px; padding: 0;">
        ${result.blastRadius.historicalFixLeads.slice(0, 4).map(hf => `
          <li><code>${escapeHtml(hf.shortHash)}</code> (${hf.date}) — ${escapeHtml(hf.subject)}</li>
        `).join('')}
      </ul>
    ` : ''}
  </div>

  <div style="margin-top: 16px;">
    <button class="btn" onclick="postAction('askWhy')">Ask Why (Historical Rationale)</button>
    <button class="btn btn-secondary" onclick="postAction('traceEvolution')">Multi-PR Evolution Timeline</button>
    <button class="btn btn-secondary" onclick="postAction('auditRequirements')">Audit PRD Requirements</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(cmd) { vscode.postMessage({ command: cmd }); }
    function openFile(fp, line) { vscode.postMessage({ command: 'openFile', filePath: fp, line: line }); }
  </script>
</body>
</html>`;
}

export class RoleAndImpactWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    result: FunctionRoleAndImpactResult
  ): Promise<void> {
    const vsc = getVsCode();
    if (!vsc?.window) return;

    const column = vsc.ViewColumn.Beside;

    if (RoleAndImpactWebviewController.currentPanel) {
      RoleAndImpactWebviewController.currentPanel.reveal(column);
    } else {
      const panel = vsc.window.createWebviewPanel(
        'gitwhisper.roleAndImpact',
        `Role & Impact: ${path.basename(result.targetFile)}`,
        column,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      RoleAndImpactWebviewController.currentPanel = panel;
      panel.onDidDispose(() => {
        RoleAndImpactWebviewController.currentPanel = undefined;
      }, null, context.subscriptions);
    }

    const panel = RoleAndImpactWebviewController.currentPanel;
    if (!panel) return;

    panel.title = `Role & Impact: ${path.basename(result.targetFile)}`;
    panel.webview.html = renderRoleAndImpactHtml(result);

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'openFile' && message.filePath) {
          try {
            const uri = vsc.Uri.file(message.filePath);
            const doc = await vsc.workspace.openTextDocument(uri);
            const line = Math.max(0, (message.line || 1) - 1);
            const editor = await vsc.window.showTextDocument(doc, { viewColumn: vsc.ViewColumn.One });
            const pos = new vsc.Position(line, 0);
            editor.selection = new vsc.Selection(pos, pos);
            editor.revealRange(new vsc.Range(pos, pos), vsc.TextEditorRevealType.InCenter);
          } catch (openErr) {
            void vsc.window.showErrorMessage(`GitWhisper: Unable to open file ${message.filePath}`);
          }
        } else if (message.command === 'askWhy') {
          void vsc.commands.executeCommand('originx.askWhy');
        } else if (message.command === 'traceEvolution') {
          void vsc.commands.executeCommand('originx.functionEvolution');
        } else if (message.command === 'auditRequirements') {
          void vsc.commands.executeCommand('originx.auditRequirements');
        }
      },
      undefined,
      context.subscriptions
    );
  }
}
