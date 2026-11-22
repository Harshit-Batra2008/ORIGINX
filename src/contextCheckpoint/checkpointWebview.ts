/**
 * GitWhisper Context Checkpoint — Webview Presentation & Interactive Controller
 * Native dark-themed VS Code webview for creating and resuming developer handoff checkpoints.
 */

import { randomBytes } from 'crypto';
import { runGit } from '../git/gitService';
import { resolveRepositoryFile } from '../security/repositoryFiles';
import * as path from 'path';
import type * as vscode from 'vscode';
import { getApprovedLogoDataUri } from '../ui/webviewView';
import {
  ContextCheckpoint,
  ContextRetrievalResult,
  SaveCheckpointInput
} from './checkpointTypes';
import { CheckpointStorage, getCheckpointFilePath } from './checkpointStorage';
import { retrieveCheckpointContext } from './checkpointRetrievalService';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
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

interface CheckpointDraft {
  title: string;
  goal: string;
  note: string;
  completed: string;
  unfinished: string;
  files: string;
}

type RetrieveContext = (repoRoot: string, checkpoint: ContextCheckpoint) => Promise<ContextRetrievalResult>;

export class CheckpointWebviewController {
  private static currentPanel: vscode.WebviewPanel | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    repoRoot: string,
    initialMode: 'save' | 'resume' = 'save',
    activeCheckpoint?: ContextRetrievalResult,
    availableCheckpoints?: ContextCheckpoint[],
    prefilledTargetFiles: string[] = [],
    retrieveContext: RetrieveContext = retrieveCheckpointContext
  ): Promise<vscode.WebviewPanel | undefined> {
    const vsc = getVsCode();
    if (!vsc) return undefined;

    // Each invocation binds one panel to one repository. Disposing it also drops its message listener.
    this.currentPanel?.dispose();
    const repoName = path.basename(repoRoot);
    const panel: vscode.WebviewPanel = vsc.window.createWebviewPanel(
      'gitwhisperCheckpoint', 'GitWhisper: Context — ' + repoName, vsc.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.currentPanel = panel;
    const isCurrent = () => this.currentPanel === panel;
    panel.onDidDispose(() => {
      if (isCurrent()) this.currentPanel = undefined;
    });

    const storage = new CheckpointStorage();
    let mode = initialMode;
    let checkpoints: ContextCheckpoint[] = [];
    let selected = activeCheckpoint;
    let selectedId = selected?.checkpoint.id;
    let revision = 0;
    let saving = false;
    let draft: CheckpointDraft | undefined;
    let allowedSources = new Set<string>();

    const refresh = async (
      nextMode: 'save' | 'resume',
      id = selectedId,
      supplied?: ContextCheckpoint[],
      clearDraft = false
    ) => {
      const request = ++revision;
      mode = nextMode;
      const records = supplied ?? await storage.listCheckpoints(repoRoot);
      if (!isCurrent() || request !== revision) return;
      let resumed = selected;
      let nextId = id;
      if (nextMode === 'resume') {
        const checkpoint = records.find(record => record.id === id) ?? records[0];
        nextId = checkpoint?.id;
        if (!checkpoint) {
          resumed = undefined;
        } else if (checkpoint.id !== resumed?.checkpoint.id || checkpoint.updatedAt !== resumed.checkpoint.updatedAt) {
          try {
            resumed = await retrieveContext(repoRoot, checkpoint);
          } catch {
            resumed = undefined;
          }
        }
      }
      if (!isCurrent() || request !== revision) return;
      selected = resumed;
      selectedId = nextId;
      checkpoints = records;
      allowedSources = new Set([
        ...(resumed?.checkpoint.targetFiles.map(file => file.filePath) ?? []),
        ...(resumed?.relatedFiles.map(file => file.filePath) ?? [])
      ]);
      if (clearDraft) draft = undefined;
      panel.webview.html = this.renderHtml(repoRoot, nextMode, records, resumed, prefilledTargetFiles, draft, selectedId);
    };

    panel.webview.onDidReceiveMessage(async message => {
      if (!isCurrent() || !message || typeof message !== 'object') return;
      try {
        switch (message.command) {
          case 'switchMode':
            if (!saving && (message.mode === 'save' || message.mode === 'resume') && message.mode !== mode) {
              const values = message.draft;
              if (mode === 'save' && values && ['title', 'goal', 'note', 'completed', 'unfinished', 'files'].every(key => typeof values[key] === 'string')) {
                draft = values as CheckpointDraft;
              }
              await refresh(message.mode);
            }
            break;
          case 'selectCheckpoint':
            if (mode === 'resume' && checkpoints.some(record => record.id === message.id)) {
              await refresh('resume', message.id);
            }
            break;
          case 'saveCheckpoint': {
            if (mode !== 'save' || saving) return;
            const input: SaveCheckpointInput = message.payload;
            if (!input || input.id !== undefined || typeof input.title !== 'string' || !input.title.trim()) {
              vsc.window.showWarningMessage('Enter a checkpoint title before saving.');
              return;
            }
            saving = true;
            try {
              const confirm = await vsc.window.showInformationMessage(
                'Save “' + input.title + '” in .gitwhisper/checkpoints/?', { modal: true }, 'Save Checkpoint'
              );
              if (!isCurrent() || confirm !== 'Save Checkpoint') return;
              const [head, branch, status] = await Promise.all([
                runGit(['rev-parse', '--verify', 'HEAD'], repoRoot),
                runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot),
                runGit(['status', '--porcelain'], repoRoot)
              ]);
              if (!isCurrent()) return;
              const headCommit = head.exitCode === 0 ? head.stdout.trim() : 'unknown';
              const saved = await storage.saveCheckpoint(repoRoot, input, {
                repoName, branch: branch.exitCode === 0 ? branch.stdout.trim() : 'HEAD',
                headCommit, headShortCommit: headCommit.slice(0, 7),
                isCleanWorkingTree: status.exitCode === 0 && !status.stdout.trim()
              });
              if (!isCurrent()) return;
              vsc.window.showInformationMessage('Saved context in .gitwhisper/checkpoints/' + saved.id + '.md');
              await refresh('resume', saved.id, undefined, true);
            } finally {
              saving = false;
            }
            break;
          }
          case 'openCheckpointFile': {
            if (!checkpoints.some(record => record.id === message.id)) return;
            const file = getCheckpointFilePath(repoRoot, message.id);
            const doc = await vsc.workspace.openTextDocument(file);
            if (isCurrent()) await vsc.window.showTextDocument(doc, { preview: true });
            break;
          }
          case 'openSourceFile': {
            if (!allowedSources.has(message.filePath)) return;
            const file = resolveRepositoryFile(repoRoot, message.filePath);
            if (!file) {
              vsc.window.showWarningMessage('This file is absent from the current working tree.');
              return;
            }
            const doc = await vsc.workspace.openTextDocument(file);
            if (isCurrent()) await vsc.window.showTextDocument(doc, { preview: true });
            break;
          }
        }
      } catch (error) {
        if (isCurrent()) vsc.window.showErrorMessage('GitWhisper checkpoint: ' + (error instanceof Error ? error.message : String(error)));
      }
    });

    await refresh(initialMode, activeCheckpoint?.checkpoint.id, availableCheckpoints);
    return panel;
  }

  /**
   * Renders the complete HTML interface for Save/Resume Checkpoint workflows.
   */
  public static renderHtml(
    repoRoot: string,
    mode: 'save' | 'resume',
    checkpoints: ContextCheckpoint[] = [],
    resumed?: ContextRetrievalResult,
    targetFiles: string[] = [],
    draft?: CheckpointDraft,
    selectedId = resumed?.checkpoint.id
  ): string {
    const nonce = randomBytes(16).toString('hex');
    const logoUri = getApprovedLogoDataUri();
    const repoName = path.basename(repoRoot);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitWhisper: Context Checkpoint</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      --subtle: var(--vscode-descriptionForeground, #858585);
      --accent: var(--vscode-textLink-foreground, #7c3aed);
      --font-mono: var(--vscode-editor-font-family, Consolas, monospace);
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
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo { width: 28px; height: 28px; object-fit: contain; }
    .title-group h1 { font-size: 16px; font-weight: 700; }
    .title-group p { font-size: 11px; color: var(--subtle); font-family: var(--font-mono); }
    
    .nav-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    .nav-btn {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--fg);
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
    }
    .nav-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .form-group { margin-bottom: 12px; }
    .form-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--subtle);
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }
    .form-input, .form-textarea, .form-select {
      width: 100%;
      background: var(--vscode-input-background, #2d2d2d);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.4));
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
    }
    .form-textarea { resize: vertical; min-height: 60px; }

    .btn {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
    .btn-secondary {
      background: rgba(127,127,127,0.15);
      color: var(--fg);
      border: 1px solid var(--card-border);
    }
    .btn-secondary:hover { background: rgba(127,127,127,0.25); }

    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }
    .badge-fresh { background: #15803d; color: #fff; }
    .badge-outdated { background: #b45309; color: #fff; }
    .badge-fallback { background: #3b82f6; color: #fff; }

    .item-list { list-style: none; margin-top: 6px; }
    .item-list li {
      font-size: 12px;
      padding: 4px 0;
      border-bottom: 1px solid rgba(128,128,128,0.1);
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .check-icon { color: #22c55e; font-weight: bold; }
    .source-link { background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0; text-decoration: underline; }
    .todo-icon { color: #f59e0b; font-weight: bold; }

    .diag-bar {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: var(--subtle);
      font-family: var(--font-mono);
      background: rgba(127,127,127,0.06);
      padding: 6px 12px;
      border-radius: 4px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .diag-item strong { color: var(--fg); }
    .limitation-alert {
      background: rgba(210, 153, 34, 0.12);
      border: 1px solid #d29922;
      border-radius: 4px;
      padding: 8px 12px;
      margin-bottom: 12px;
      font-size: 11px;
      color: #e3b341;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logoUri ? `<img src="${logoUri}" class="logo" alt="GitWhisper" />` : ''}
      <div class="title-group">
        <h1>GitWhisper Context Checkpoint</h1>
        <p>${escapeHtml(repoName)} &middot; Developer Handoff &amp; Continuity Engine</p>
      </div>
    </div>
  </div>

  <div class="nav-tabs">
    <button class="nav-btn ${mode === 'save' ? 'active' : ''}" data-mode="save">
      💾 Save Checkpoint
    </button>
    <button class="nav-btn ${mode === 'resume' ? 'active' : ''}" data-mode="resume">
      📂 Resume Checkpoint (${checkpoints.length})
    </button>
  </div>

  ${mode === 'save' ? `
    <!-- SAVE CHECKPOINT MODE -->
    <div class="card">
      <div class="card-title">📝 Record Developer Context Checkpoint</div>
      <p style="font-size: 11px; color: var(--subtle); margin-bottom: 12px;">
        Capture your current goals, completed tasks, and unfinished open items before handing off or switching branches.
      </p>

      <div class="form-group">
        <label class="form-label">Checkpoint Title</label>
        <input type="text" id="chk-title" class="form-input" placeholder="e.g. Scope deterministic engine validation" value="${escapeHtml(draft?.title ?? 'Work-in-progress Context')}" />
      </div>

      <div class="form-group">
        <label class="form-label">Developer Goal / Primary Intent (Optional Note)</label>
        <input type="text" id="chk-goal" class="form-input" value="${escapeHtml(draft?.goal ?? '')}" placeholder="What were you aiming to achieve?" />
      </div>

      <div class="form-group">
        <label class="form-label">Handoff Notes &amp; Architectural Context</label>
        <textarea id="chk-note" class="form-textarea" placeholder="Detail any non-obvious constraints, architectural decisions, or advice for the next developer...">${escapeHtml(draft?.note ?? '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Explicitly Confirmed Completed Work (One per line)</label>
        <textarea id="chk-completed" class="form-textarea" placeholder="Implemented deterministic scope matching&#10;Added IPv4 CIDR regex validation">${escapeHtml(draft?.completed ?? '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Unfinished Tasks &amp; Blockers (One per line)</label>
        <textarea id="chk-unfinished" class="form-textarea" placeholder="Add tests for IPv6 scope edge cases&#10;Fix CRLF line endings on Windows install">${escapeHtml(draft?.unfinished ?? '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Target / Modified Files (One per line)</label>
        <textarea id="chk-files" class="form-textarea" placeholder="engine/scope.py">${escapeHtml(draft?.files ?? targetFiles.join('\n'))}</textarea>
      </div>

      <button class="btn" id="save-checkpoint">💾 Save Context Checkpoint</button>
    </div>
  ` : `
    <!-- RESUME CHECKPOINT MODE -->
    <div class="card">
      <div class="card-title">📂 Resume Existing Checkpoint</div>
      ${checkpoints.length === 0 ? `
        <p style="color: var(--subtle); font-size: 12px;">No checkpoints found in <code>.gitwhisper/checkpoints/</code> yet. Use the Save Checkpoint tab to create your first handoff record.</p>
      ` : `
        <div class="form-group">
          <label class="form-label">Select Stored Checkpoint</label>
          <select id="chk-select" class="form-select">
            ${checkpoints.map(c => `
              <option value="${escapeHtml(c.id)}" ${selectedId === c.id ? 'selected' : ''}>
                ${escapeHtml(c.title)} — ${escapeHtml(c.id)} (${escapeHtml(c.repository.branch)} @ ${escapeHtml(c.repository.headShortCommit)})
              </option>
            `).join('')}
          </select>
          ${selectedId && !resumed ? `<p>Historical context is unavailable. <button class="source-link" data-checkpoint="${escapeHtml(selectedId)}">Open the saved checkpoint</button></p>` : ''}
        </div>
      `}
    </div>

    ${resumed ? `
      <!-- RESUMED CHECKPOINT DETAILS -->
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div>
            <h2 style="font-size: 15px; font-weight: 700;">${escapeHtml(resumed.checkpoint.title)}</h2>
            <p style="font-size: 11px; font-family: var(--font-mono); color: var(--subtle);">
              ${escapeHtml(resumed.checkpoint.id)} &middot; Branch: <strong>${escapeHtml(resumed.checkpoint.repository.branch)}</strong> &middot; HEAD: <code>${escapeHtml(resumed.checkpoint.repository.headShortCommit)}</code>
            </p>
          </div>
          <button class="btn btn-secondary" data-checkpoint="${escapeHtml(resumed.checkpoint.id)}">📄 Open .md</button>
        </div>

        ${resumed.freshness.limitationMessage ? `
          <div class="limitation-alert">
            <strong>Graph Freshness Advisory:</strong> ${escapeHtml(resumed.freshness.limitationMessage)}
          </div>
        ` : ''}

        ${resumed.checkpoint.developerIntent ? `
          <div style="background: rgba(127,127,127,0.06); padding: 10px 12px; border-radius: 4px; margin-bottom: 12px;">
            <div style="font-size: 11px; font-weight: 700; color: #a855f7; margin-bottom: 4px;">DEVELOPER RECORDED INTENT</div>
            <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">Goal: ${escapeHtml(resumed.checkpoint.developerIntent.goal)}</div>
            ${resumed.checkpoint.developerIntent.note ? `<div style="font-size: 12px; white-space: pre-wrap; color: var(--fg);">${escapeHtml(resumed.checkpoint.developerIntent.note)}</div>` : ''}
          </div>
        ` : ''}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
          <div>
            <div class="form-label">Completed Work (${resumed.checkpoint.completedWork.length})</div>
            <ul class="item-list">
              ${resumed.checkpoint.completedWork.length === 0 ? '<li style="color: var(--subtle);">None confirmed</li>' : ''}
              ${resumed.checkpoint.completedWork.map(cw => `
                <li>
                  <span class="check-icon">✓</span>
                  <span>${escapeHtml(cw.description)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
          <div>
            <div class="form-label">Unfinished Tasks (${resumed.checkpoint.unfinishedTasks.length})</div>
            <ul class="item-list">
              ${resumed.checkpoint.unfinishedTasks.length === 0 ? '<li style="color: var(--subtle);">None recorded</li>' : ''}
              ${resumed.checkpoint.unfinishedTasks.map(ut => `
                <li>
                  <span class="todo-icon">⏳</span>
                  <span><strong>[${escapeHtml(ut.priority)}]</strong> ${escapeHtml(ut.description)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        </div>

        <div class="form-label">Target Files (${resumed.checkpoint.targetFiles.length})</div>
        <ul class="item-list" style="margin-bottom: 12px;">
          ${resumed.checkpoint.targetFiles.map(tf => `
            <li>
              <span>📄</span>
              <button class="source-link" data-file="${escapeHtml(tf.filePath)}">${escapeHtml(tf.filePath)}</button>
              <span style="font-size: 11px; color: var(--subtle);">(${escapeHtml(tf.changeStatus)})</span>
            </li>
          `).join('')}
        </ul>

        <!-- GRAPH RETRIEVED CO-CHANGED FILES -->
        <div style="margin-top: 14px; border-top: 1px solid var(--card-border); padding-top: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div class="form-label" style="margin: 0;">Historically Related Files &amp; Co-Changes (${resumed.relatedFiles.length})</div>
            <span class="badge ${resumed.diagnostics.retrievalSource === 'neo4j_graph' ? 'badge-fresh' : 'badge-fallback'}">
              ${resumed.diagnostics.retrievalSource === 'neo4j_graph' ? 'Neo4j graph' : resumed.diagnostics.retrievalSource === 'git_fallback' ? 'Local Git' : 'No history retrieved'}
            </span>
          </div>
          <p style="font-size: 11px; color: var(--subtle); margin-bottom: 8px;">
            These files changed together in earlier commits. Inspect their code to establish a dependency.
          </p>

          ${resumed.relatedFiles.length === 0 ? `
            <p style="color: var(--subtle); font-size: 11px;">No historically co-changed companion files found.</p>
          ` : `
            <ul class="item-list">
              ${resumed.relatedFiles.map(rf => `
                <li>
                  <span>🔗</span>
                  <button class="source-link" data-file="${escapeHtml(rf.filePath)}">${escapeHtml(rf.filePath)}</button>
                  <span style="font-size: 11px; color: var(--subtle); margin-left: 6px;">
                    co-changed in ${rf.coChangeCount} commit(s)
                  </span>
                </li>
              `).join('')}
            </ul>
          `}

          <!-- LINKED DECISION MEMORIES -->
          ${resumed.linkedDecisions.length > 0 ? `
            <div style="margin-top: 12px;">
              <div class="form-label">Linked Decision Memories (${resumed.linkedDecisions.length})</div>
              ${resumed.linkedDecisions.map(ld => `
                <div style="background: rgba(127,127,127,0.06); padding: 8px 10px; border-radius: 4px; margin-top: 4px; font-size: 12px;">
                  <strong>${escapeHtml(ld.id)}:</strong> ${escapeHtml(ld.title)}
                  <span class="badge" style="background: #15803d; color: #fff; margin-left: 6px;">${escapeHtml(ld.status)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <!-- DIAGNOSTICS BAR -->
          <div class="diag-bar">
            <span class="diag-item">Query Time: <strong>${resumed.diagnostics.queryDurationMs}ms</strong></span>
            <span class="diag-item">Candidates: <strong>${resumed.diagnostics.candidateCount}</strong></span>
            <span class="diag-item">Context Size: <strong>${resumed.diagnostics.serializedContextSizeBytes} bytes</strong></span>
            <span class="diag-item">Source: <strong>${escapeHtml(resumed.diagnostics.retrievalSource)}</strong></span>
          </div>
        </div>
      </div>
    ` : ''}
  `}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function readDraft() {
      const fields = ['title', 'goal', 'note', 'completed', 'unfinished', 'files'];
      return Object.fromEntries(fields.map(key => [key, document.getElementById('chk-' + key).value]));
    }

    document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
      const draft = document.getElementById('chk-title') ? readDraft() : undefined;
      vscode.postMessage({ command: 'switchMode', mode: button.dataset.mode, draft });
    }));
    document.getElementById('chk-select')?.addEventListener('change', event => {
      vscode.postMessage({ command: 'selectCheckpoint', id: event.target.value });
    });
    document.querySelector('[data-checkpoint]')?.addEventListener('click', event => {
      vscode.postMessage({ command: 'openCheckpointFile', id: event.currentTarget.dataset.checkpoint });
    });
    document.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openSourceFile', filePath: button.dataset.file });
    }));

    document.getElementById('save-checkpoint')?.addEventListener('click', () => {
      const { title, goal, note, completed: completedRaw, unfinished: unfinishedRaw, files: filesRaw } = readDraft();

      const completedWork = completedRaw
        ? completedRaw.split('\\n').map(c => c.trim()).filter(Boolean).map(description => ({ description, confirmedByHuman: true }))
        : [];

      const unfinishedTasks = unfinishedRaw
        ? unfinishedRaw.split('\\n').map(u => u.trim()).filter(Boolean).map(description => ({ description, priority: 'medium' }))
        : [];

      const targetFiles = filesRaw
        ? filesRaw.split('\\n').map(f => f.trim()).filter(Boolean).map(filePath => ({ filePath, changeStatus: 'referenced' }))
        : [];

      vscode.postMessage({
        command: 'saveCheckpoint',
        payload: {
          title: title.trim(),
          goal: goal || undefined,
          developerNote: note || undefined,
          completedWork: completedWork,
          unfinishedTasks: unfinishedTasks,
          targetFiles: targetFiles
        }
      });
    });
  </script>
</body>
</html>`;
  }
}
