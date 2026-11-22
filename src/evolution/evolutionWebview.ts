/**
 * GitWhisper — Function Evolution Webview
 * Displays chronological and behavioral multi-PR evolution timeline.
 */

import * as path from 'path';
import type * as vscode from 'vscode';
import { FunctionEvolutionTimeline } from './types';

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

export function renderFunctionEvolutionHtml(timeline: FunctionEvolutionTimeline): string {
  const baseName = path.basename(timeline.filePath);
  const title = timeline.enclosingFunctionName ? `Function ${timeline.enclosingFunctionName}` : `Lines ${timeline.targetLineRange.startLine}–${timeline.targetLineRange.endLine}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>GitWhisper: Function Evolution</title>
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
    }
    .timeline {
      position: relative;
      margin-left: 20px;
      padding-left: 20px;
      border-left: 2px solid var(--vscode-panel-border, #444);
    }
    .timeline-node {
      position: relative;
      margin-bottom: 20px;
    }
    .timeline-dot {
      position: absolute;
      left: -27px;
      top: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #0e639c;
      border: 2px solid #1e1e1e;
    }
    .timeline-dot-fix { background: #d29922; }
    .timeline-dot-origin { background: #3fb950; }
    .timeline-dot-current { background: #a371f7; }
    .commit-card {
      background-color: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 6px;
      padding: 10px 14px;
    }
    .commit-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .role-badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.08);
    }
    .pr-link {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      font-weight: 600;
    }
    .superseded-alert {
      color: #f85149;
      font-size: 11px;
      margin-top: 4px;
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
  </style>
</head>
<body>
  <div class="header-bar">
    <h2>GitWhisper: Multi-PR Function Evolution</h2>
    <div><code>${escapeHtml(baseName)}</code> &bull; <strong>${escapeHtml(title)}</strong> &bull; ${timeline.totalCommitsCount} commits (${timeline.behaviorChangingCommitsCount} behavior-changing)</div>
  </div>

  <div class="timeline">
    ${timeline.commits.map(c => `
      <div class="timeline-node">
        <div class="timeline-dot ${c.role === 'origin' ? 'timeline-dot-origin' : (c.role === 'bug_fix' ? 'timeline-dot-fix' : (c.role === 'current' ? 'timeline-dot-current' : ''))}"></div>
        <div class="commit-card">
          <div class="commit-header">
            <div>
              <code>${escapeHtml(c.shortHash)}</code>
              ${c.pullRequest ? `&bull; <a href="${escapeHtml(c.pullRequest.url || '#')}" class="pr-link">PR #${c.pullRequest.number}</a>` : ''}
              <span class="role-badge">${escapeHtml(c.role.replace('_', ' '))}</span>
            </div>
            <div style="color: var(--vscode-descriptionForeground); font-size: 11px;">${escapeHtml(c.date)} by ${escapeHtml(c.author)}</div>
          </div>
          <div><strong>${escapeHtml(c.subject)}</strong></div>
          ${c.pullRequest?.rationaleSummary ? `
            <div style="font-size: 12px; margin-top: 4px; color: var(--vscode-descriptionForeground);">
              <strong>PR Rationale:</strong> ${escapeHtml(c.pullRequest.rationaleSummary)}
            </div>
          ` : ''}
          ${c.supersessionStatus === 'superseded' || c.supersessionStatus === 'reverted' ? `
            <div class="superseded-alert">⚠️ Superseded by subsequent commit <code>${escapeHtml(c.supersededBy || '')}</code></div>
          ` : ''}
        </div>
      </div>
    `).join('')}
  </div>

  <div style="margin-top: 20px;">
    <button class="btn" onclick="postAction('askWhy')">Ask Why for Current Code</button>
    <button class="btn" onclick="postAction('explainImpact')">Explain Role &amp; Impact</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function postAction(cmd) { vscode.postMessage({ command: cmd }); }
  </script>
</body>
</html>`;
}

export class FunctionEvolutionWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    timeline: FunctionEvolutionTimeline
  ): Promise<void> {
    const vsc = getVsCode();
    if (!vsc?.window) return;

    const column = vsc.ViewColumn.Beside;

    if (FunctionEvolutionWebviewController.currentPanel) {
      FunctionEvolutionWebviewController.currentPanel.reveal(column);
    } else {
      const panel = vsc.window.createWebviewPanel(
        'gitwhisper.functionEvolution',
        `Function Evolution: ${path.basename(timeline.filePath)}`,
        column,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      FunctionEvolutionWebviewController.currentPanel = panel;
      panel.onDidDispose(() => {
        FunctionEvolutionWebviewController.currentPanel = undefined;
      }, null, context.subscriptions);
    }

    const panel = FunctionEvolutionWebviewController.currentPanel;
    if (!panel) return;

    panel.title = `Function Evolution: ${path.basename(timeline.filePath)}`;
    panel.webview.html = renderFunctionEvolutionHtml(timeline);

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'askWhy') {
          void vsc.commands.executeCommand('originx.askWhy');
        } else if (message.command === 'explainImpact') {
          void vsc.commands.executeCommand('originx.explainRoleAndImpact');
        }
      },
      undefined,
      context.subscriptions
    );
  }
}
