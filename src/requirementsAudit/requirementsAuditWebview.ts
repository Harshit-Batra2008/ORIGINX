/**
 * GitWhisper — Requirements Audit Webview
 * Displays conservative requirements-to-build audit report with clickable evidence links.
 */

import * as path from 'path';
import type * as vscode from 'vscode';
import { RequirementsAuditReport } from './types';

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

export function renderRequirementsAuditHtml(report: RequirementsAuditReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>GitWhisper: Requirements Audit</title>
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
    .metrics-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .metric-pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--vscode-panel-border, #333333);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-VERIFIED { background-color: rgba(46, 160, 67, 0.25); color: #3fb950; border: 1px solid #3fb950; }
    .status-IMPLEMENTED_NOT_VERIFIED { background-color: rgba(210, 153, 34, 0.25); color: #d29922; border: 1px solid #d29922; }
    .status-PARTIAL { background-color: rgba(219, 109, 40, 0.25); color: #db6d28; border: 1px solid #db6d28; }
    .status-NOT_FOUND_IN_SCANNED_SCOPE { background-color: rgba(248, 81, 73, 0.25); color: #f85149; border: 1px solid #f85149; }
    .status-INSUFFICIENT_EVIDENCE { background-color: rgba(139, 148, 158, 0.25); color: #8b949e; border: 1px solid #8b949e; }
    .req-card {
      background-color: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .req-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .code-citation {
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      text-decoration: underline;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .btn {
      background-color: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-right: 8px;
    }
    .btn:hover { background-color: var(--vscode-button-hoverBackground, #1177bb); }
  </style>
</head>
<body>
  <div class="header-bar">
    <div>
      <h2>GitWhisper: PRD &amp; Tasks vs Build Audit</h2>
      <div>Scanned <strong>${report.scannedFilesCount}</strong> workspace files across <strong>${report.totalRequirements}</strong> requirement(s)</div>
    </div>
    <div>
      <button class="btn" onclick="postAction('reAudit')">Audit Another PRD/File</button>
    </div>
  </div>

  <div class="metrics-row">
    <div class="metric-pill"><strong>Verified:</strong> <span style="color:#3fb950;">${report.verifiedCount}</span></div>
    <div class="metric-pill"><strong>Implemented, Not Verified:</strong> <span style="color:#d29922;">${report.implementedNotVerifiedCount}</span></div>
    <div class="metric-pill"><strong>Partial:</strong> <span style="color:#db6d28;">${report.partialCount}</span></div>
    <div class="metric-pill"><strong>Not Found in Scope:</strong> <span style="color:#f85149;">${report.notFoundCount}</span></div>
    <div class="metric-pill"><strong>Insufficient:</strong> <span style="color:#8b949e;">${report.insufficientCount}</span></div>
  </div>

  ${report.executedTestSuites.length > 0 ? `
    <div style="margin-bottom: 16px; font-size: 12px; color: var(--vscode-descriptionForeground);">
      <strong>Executed Test Record:</strong> ${report.executedTestSuites.map(ts => `${ts.suiteName} (${ts.totalPassed} passed, ${ts.totalFailed} failed)`).join('; ')}
    </div>
  ` : ''}

  <div>
    ${report.items.map(item => `
      <div class="req-card">
        <div class="req-header">
          <div><strong>${escapeHtml(item.id)}:</strong> ${escapeHtml(item.title)}</div>
          <div><span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(item.status.replace(/_/g, ' '))}</span></div>
        </div>

        <div style="font-size: 12px; margin-bottom: 8px; color: var(--vscode-descriptionForeground);">
          ${escapeHtml(item.rawText)}
        </div>

        ${item.candidateImplementations.length > 0 ? `
          <div style="margin-top: 6px;">
            <strong>Implementation Candidates:</strong>
            <ul style="margin: 4px 0 6px 18px; padding: 0;">
              ${item.candidateImplementations.map(imp => `
                <li>
                  <span class="code-citation" onclick="openFile('${escapeHtml(imp.filePath)}', ${imp.line})">${escapeHtml(path.basename(imp.filePath))}:${imp.line}</span>
                  <span style="color: var(--vscode-descriptionForeground); font-size: 11px;">(${imp.rationale})</span>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        ${item.candidateTests.length > 0 ? `
          <div style="margin-top: 6px;">
            <strong>Test Coverage Evidence:</strong>
            <ul style="margin: 4px 0 6px 18px; padding: 0;">
              ${item.candidateTests.map(tc => `
                <li>
                  <span class="code-citation" onclick="openFile('${escapeHtml(tc.testFilePath)}', ${tc.line})">${escapeHtml(path.basename(tc.testFilePath))}:${tc.line}</span>
                  ${tc.wasExecuted ? `<span style="color:#3fb950; font-size: 11px;">[✓ Executed Pass]</span>` : `<span style="color:#d29922; font-size: 11px;">[Unverified in active run]</span>`}
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <div style="margin-top: 8px; font-size: 12px; background: rgba(0,0,0,0.15); padding: 6px; border-radius: 4px;">
          <div><strong>Remaining Gap:</strong> ${escapeHtml(item.remainingGap)}</div>
          <div><strong>Suggested Action:</strong> ${escapeHtml(item.suggestedNextAction)}</div>
        </div>
      </div>
    `).join('')}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(cmd) { vscode.postMessage({ command: cmd }); }
    function openFile(fp, line) { vscode.postMessage({ command: 'openFile', filePath: fp, line: line }); }
  </script>
</body>
</html>`;
}

export class RequirementsAuditWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    report: RequirementsAuditReport,
    onReAudit?: () => Promise<void>
  ): Promise<void> {
    const vsc = getVsCode();
    if (!vsc?.window) return;

    const column = vsc.ViewColumn.Beside;

    if (RequirementsAuditWebviewController.currentPanel) {
      RequirementsAuditWebviewController.currentPanel.reveal(column);
    } else {
      const panel = vsc.window.createWebviewPanel(
        'gitwhisper.requirementsAudit',
        'Requirements vs Build Audit',
        column,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      RequirementsAuditWebviewController.currentPanel = panel;
      panel.onDidDispose(() => {
        RequirementsAuditWebviewController.currentPanel = undefined;
      }, null, context.subscriptions);
    }

    const panel = RequirementsAuditWebviewController.currentPanel;
    if (!panel) return;

    panel.title = 'Requirements vs Build Audit';
    panel.webview.html = renderRequirementsAuditHtml(report);

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
          } catch (err) {
            void vsc.window.showErrorMessage(`GitWhisper: Unable to open file ${message.filePath}`);
          }
        } else if (message.command === 'reAudit' && onReAudit) {
          await onReAudit();
        }
      },
      undefined,
      context.subscriptions
    );
  }
}
