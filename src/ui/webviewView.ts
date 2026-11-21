import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CommitInfo, GitHistoryResult, SelectionContext } from '../git/gitTypes';
import { GeminiExplanation } from '../gemini/geminiTypes';
import { Neo4jCommitEvidence } from '../neo4j/neo4jGraphTypes';
import { MultiFileHistoryResult, PerFileExplanation } from '../multiFile/multiFileTypes';
import { ReviewerResult } from '../reviewer/reviewerTypes';
import { InvestigationResult } from '../investigation/investigationTypes';
import { UnifiedAnalysisResult } from '../unified/unifiedTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

let cachedLogoDataUri: string | undefined;

/**
 * Returns the base64 data URI of the approved ORIGINX 128x128 icon.
 */
export function getApprovedLogoDataUri(): string {
  if (cachedLogoDataUri) {
    return cachedLogoDataUri;
  }

  try {
    const candidatePaths = [
      path.join(__dirname, '../../assets/originx-icon.png'),
      path.join(__dirname, '../assets/originx-icon.png'),
      path.join(process.cwd(), 'assets/originx-icon.png')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const b64 = fs.readFileSync(p).toString('base64');
        cachedLogoDataUri = `data:image/png;base64,${b64}`;
        return cachedLogoDataUri;
      }
    }
  } catch {}

  return '';
}

export interface EvidenceCountSummary {
  totalRecords: number;
  uniqueCommits: number;
  gitCommitCount: number;
  neo4jRecordCount: number;
  uniqueCommitHashes: string[];
}

export interface ConsolidatedCommitEvidence {
  canonicalHash: string;
  shortHash: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  diff?: string;
  sources: {
    gitBlame: boolean;
    neo4j: boolean;
    neo4jChangeType?: string;
    neo4jOldPath?: string;
    neo4jRepoId?: string;
    neo4jCommittedAt?: string;
  };
}

/**
 * Calculates total evidence records and deduplicated unique commits across local Git blame
 * and Neo4j knowledge graph evidence by canonical full hash.
 */
export function calculateEvidenceCounts(
  commits: CommitInfo[],
  neo4jEvidence?: Neo4jCommitEvidence[]
): EvidenceCountSummary {
  const gitCommitCount = commits ? commits.length : 0;
  const neo4jRecordCount = neo4jEvidence ? neo4jEvidence.length : 0;
  const totalRecords = gitCommitCount + neo4jRecordCount;

  const seenHashes = new Map<string, string>();

  const addHash = (fullHash?: string, shortHash?: string) => {
    const full = (fullHash || '').trim().toLowerCase();
    const short = (shortHash || '').trim().toLowerCase();
    const key = full || short;
    if (!key) return;

    for (const existingKey of seenHashes.keys()) {
      if (existingKey === key) return;
      if (
        existingKey.length >= 7 &&
        key.length >= 7 &&
        (existingKey.startsWith(key) || key.startsWith(existingKey))
      ) {
        if (key.length > existingKey.length) {
          seenHashes.delete(existingKey);
          seenHashes.set(key, fullHash || shortHash || key);
        }
        return;
      }
    }

    seenHashes.set(key, fullHash || shortHash || key);
  };

  for (const c of (commits || [])) {
    addHash(c.hash, c.shortHash);
  }

  for (const ge of (neo4jEvidence || [])) {
    addHash(ge.commitHash, ge.shortHash);
  }

  return {
    totalRecords,
    uniqueCommits: seenHashes.size,
    gitCommitCount,
    neo4jRecordCount,
    uniqueCommitHashes: Array.from(seenHashes.keys())
  };
}

/**
 * Consolidates duplicate Git blame commits and Neo4j graph records by commit hash,
 * preserving multi-source attribution badges (Git Blame + Neo4j Graph).
 */
export function consolidateEvidence(
  commits: CommitInfo[],
  neo4jEvidence?: Neo4jCommitEvidence[]
): ConsolidatedCommitEvidence[] {
  const map = new Map<string, ConsolidatedCommitEvidence>();

  const getCanonicalKey = (fullHash?: string, shortHash?: string): string => {
    const full = (fullHash || '').trim().toLowerCase();
    const short = (shortHash || '').trim().toLowerCase();
    return full || short;
  };

  const findExistingKey = (key: string): string | undefined => {
    if (!key) return undefined;
    for (const k of map.keys()) {
      if (k === key) return k;
      if (k.length >= 7 && key.length >= 7 && (k.startsWith(key) || key.startsWith(k))) {
        return k;
      }
    }
    return undefined;
  };

  for (const c of (commits || [])) {
    const rawKey = getCanonicalKey(c.hash, c.shortHash);
    if (!rawKey) continue;
    const existing = findExistingKey(rawKey);
    const short = c.shortHash || (c.hash ? c.hash.slice(0, 7) : rawKey.slice(0, 7));

    if (existing) {
      const item = map.get(existing)!;
      item.sources.gitBlame = true;
      if (!item.diff && c.diff) item.diff = c.diff;
      if (!item.body && c.body) item.body = c.body;
      if (c.hash && c.hash.length > item.canonicalHash.length) {
        item.canonicalHash = c.hash;
        map.delete(existing);
        map.set(c.hash.toLowerCase(), item);
      }
    } else {
      map.set(rawKey, {
        canonicalHash: c.hash || c.shortHash || rawKey,
        shortHash: short,
        subject: c.subject || 'No commit subject',
        body: c.body || '',
        authorName: c.authorName || 'Unknown',
        authorEmail: c.authorEmail || '',
        date: c.date || '',
        diff: c.diff || '',
        sources: {
          gitBlame: true,
          neo4j: false
        }
      });
    }
  }

  for (const ge of (neo4jEvidence || [])) {
    const rawKey = getCanonicalKey(ge.commitHash, ge.shortHash);
    if (!rawKey) continue;
    const existing = findExistingKey(rawKey);
    const short = ge.shortHash || (ge.commitHash ? ge.commitHash.slice(0, 7) : rawKey.slice(0, 7));

    if (existing) {
      const item = map.get(existing)!;
      item.sources.neo4j = true;
      item.sources.neo4jChangeType = ge.changeType ? ge.changeType.toUpperCase() : 'MODIFIED';
      item.sources.neo4jOldPath = ge.oldPath;
      item.sources.neo4jCommittedAt = ge.committedAt;
      if (!item.body && ge.body) item.body = ge.body;
      if (!item.authorEmail && ge.authorEmail) item.authorEmail = ge.authorEmail;
      if ((!item.authorName || item.authorName === 'Unknown') && ge.authorName) item.authorName = ge.authorName;
      if (ge.commitHash && ge.commitHash.length > item.canonicalHash.length) {
        item.canonicalHash = ge.commitHash;
        map.delete(existing);
        map.set(ge.commitHash.toLowerCase(), item);
      }
    } else {
      map.set(rawKey, {
        canonicalHash: ge.commitHash || ge.shortHash || rawKey,
        shortHash: short,
        subject: ge.subject || 'No commit subject',
        body: ge.body || '',
        authorName: ge.authorName || 'Unknown',
        authorEmail: ge.authorEmail || '',
        date: ge.committedAt || '',
        sources: {
          gitBlame: false,
          neo4j: true,
          neo4jChangeType: ge.changeType ? ge.changeType.toUpperCase() : 'MODIFIED',
          neo4jOldPath: ge.oldPath,
          neo4jCommittedAt: ge.committedAt
        }
      });
    }
  }

  return Array.from(map.values());
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
          WebviewView.currentPanel = undefined;
        }
      }

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxHistory',
          'GitWhisper: Why Was This Changed?',
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = `GitWhisper: ${result.selection.fileName}:${result.selection.startLine}-${result.selection.endLine}`;
        WebviewView.currentPanel.webview.html = WebviewView.renderHtml(result);
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display results webview:', err);
    }
  }

  public static showMultiFileResult(result: MultiFileHistoryResult, extensionUri?: vscode.Uri): void {
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
          WebviewView.currentPanel = undefined;
        }
      }

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxMultiFileHistory',
          `GitWhisper: Cross-File Analysis (${result.eligibleFiles.length} files)`,
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = `GitWhisper: Cross-File Analysis (${result.eligibleFiles.length} files)`;
        WebviewView.currentPanel.webview.html = WebviewView.renderMultiFileHtml(result);
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display multi-file results webview:', err);
    }
  }

  public static showReviewerResult(result: ReviewerResult, extensionUri?: vscode.Uri): void {
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
          WebviewView.currentPanel = undefined;
        }
      }

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxReviewWorkingTree',
          `GitWhisper: Review Working Tree (${result.totalChangedFiles} files)`,
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = `GitWhisper: Review Working Tree (${result.totalChangedFiles} files)`;
        try {
          WebviewView.currentPanel.webview.html = WebviewView.renderReviewerHtml(result);
        } catch (renderErr) {
          console.error('[ORIGINX] Failed to render reviewer results HTML:', renderErr);
          WebviewView.currentPanel.webview.html = WebviewView.renderErrorHtml(
            'Failed to render reviewer results view',
            renderErr instanceof Error ? renderErr.message : String(renderErr)
          );
        }
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display reviewer results webview:', err);
    }
  }

  public static showInvestigationResult(result: InvestigationResult, extensionUri?: vscode.Uri): void {
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
          WebviewView.currentPanel = undefined;
        }
      }

      const fileName = result.request?.fileName || 'Bug Investigation';
      const panelTitle = `GitWhisper: Investigate ${fileName}`;

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxInvestigateBug',
          panelTitle,
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = panelTitle;
        try {
          WebviewView.currentPanel.webview.html = WebviewView.renderInvestigationHtml(result);
        } catch (renderErr) {
          console.error('[ORIGINX] Failed to render bug investigation HTML:', renderErr);
          WebviewView.currentPanel.webview.html = WebviewView.renderErrorHtml(
            'Failed to render bug investigation view',
            renderErr instanceof Error ? renderErr.message : String(renderErr)
          );
        }
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display bug investigation webview:', err);
    }
  }

  public static showUnifiedAnalysisResult(result: UnifiedAnalysisResult, extensionUri?: vscode.Uri): void {
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
          WebviewView.currentPanel = undefined;
        }
      }

      const fileName = result.request?.fileName || 'Code Analysis';
      const panelTitle = `GitWhisper: ${fileName}`;

      if (!WebviewView.currentPanel) {
        const panel = vsc.window.createWebviewPanel(
          'originxAnalyzeCode',
          panelTitle,
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        ) as vscode.WebviewPanel;

        panel.onDidDispose(() => {
          WebviewView.currentPanel = undefined;
        });

        WebviewView.currentPanel = panel;
      }

      if (WebviewView.currentPanel) {
        WebviewView.currentPanel.title = panelTitle;
        try {
          WebviewView.currentPanel.webview.html = WebviewView.renderUnifiedAnalysisHtml(result);
        } catch (renderErr) {
          console.error('[ORIGINX] Failed to render unified code analysis HTML:', renderErr);
          WebviewView.currentPanel.webview.html = WebviewView.renderErrorHtml(
            'Failed to render unified code analysis view',
            renderErr instanceof Error ? renderErr.message : String(renderErr)
          );
        }
      }
    } catch (err) {
      console.error('[ORIGINX] Failed to display unified code analysis webview:', err);
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

  /**
   * Generates the approved ORIGINX logo HTML (data URI img with vector SVG fallback).
   */
  public static getOriginxLogoHtml(size = 24): string {
    const dataUri = getApprovedLogoDataUri();
    if (dataUri) {
      return `<img src="${dataUri}" alt="ORIGINX" width="${size}" height="${size}" style="border-radius: 6px; vertical-align: middle; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);" />`;
    }
    return this.getOriginxLogoSvg(size);
  }

  /**
   * Fallback vector SVG if PNG cannot be read.
   */
  public static getOriginxLogoSvg(size = 22): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; flex-shrink: 0;">
      <defs>
        <linearGradient id="oxBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#141529"/>
          <stop offset="50%" stop-color="#0E0F1E"/>
          <stop offset="100%" stop-color="#090A14"/>
        </linearGradient>
        <linearGradient id="oxOrbit" x1="15%" y1="85%" x2="85%" y2="15%">
          <stop offset="0%" stop-color="#9333EA"/>
          <stop offset="35%" stop-color="#7C3AED"/>
          <stop offset="70%" stop-color="#3B82F6"/>
          <stop offset="100%" stop-color="#38BDF8"/>
        </linearGradient>
        <linearGradient id="oxDelta" x1="0%" y1="30%" x2="100%" y2="70%">
          <stop offset="0%" stop-color="#6366F1"/>
          <stop offset="50%" stop-color="#8B5CF6"/>
          <stop offset="100%" stop-color="#06B6D4"/>
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="26" fill="url(#oxBg)" stroke="rgba(124, 58, 237, 0.45)" stroke-width="3"/>
      <g transform="translate(64, 64)">
        <circle cx="0" cy="0" r="36" fill="none" stroke="url(#oxOrbit)" stroke-width="14" opacity="0.22"/>
        <path d="M 0 -36 A 36 36 0 1 0 0 36 L 16 26 A 21 21 0 1 1 16 -26 Z" fill="url(#oxOrbit)"/>
        <path d="M -8 -20 L 28 0 L -8 20 L -2 0 Z" fill="url(#oxDelta)"/>
        <path d="M -3 -11 L 17 0 L -3 11 Z" fill="#101222"/>
        <circle cx="-1" cy="0" r="5" fill="#FFFFFF"/>
        <circle cx="-1" cy="0" r="7.5" fill="none" stroke="#38BDF8" stroke-width="1.2" opacity="0.8"/>
      </g>
    </svg>`;
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

    const counts = calculateEvidenceCounts(result.commits, result.neo4jEvidence);
    const hasNeo = Boolean(result.neo4jEvidence && result.neo4jEvidence.length > 0);

    // Section 1: Explanation & Supporting Commits
    const conciseExplanationHtml = this.renderConciseExplanation(result);
    const supportingCommitsSummaryHtml = this.renderSupportingCommitsSummary(result.commits, result.neo4jEvidence);

    // Section 2: Details Panels (Code snippet & diagnostics)
    const codeSnippetDetailsHtml = this.renderCodeSnippetDetails(result.selection);
    const diagnosticsDetailsHtml = this.renderDiagnosticsDetails(result);

    // Section 3: Unique Commits Timeline
    const commitsTimelineHtml = this.renderCommitsTimeline(result.commits, result.neo4jEvidence);

    // Section 4: Neo4j Graph Evidence
    const graphEvidenceHtml = this.renderGraphEvidence(result);

    // Section 5: Diffs & Patches
    const gitEvidenceDetailsHtml = this.renderGitEvidenceDetails(result);

    const logoHtml = this.getOriginxLogoHtml(26);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper by ORIGINX: Why Was This Changed?</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --subtle: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.8));
      --card-bg: var(--vscode-editorWidget-background, rgba(20, 22, 38, 0.7));
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

    html, body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      margin: 0;
      padding: 14px 18px 40px;
      overflow-x: hidden;
      max-width: 100%;
    }

    /* Top Brand Bar */
    .app-header {
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
      margin-bottom: 14px;
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
      gap: 10px;
    }

    .brand-logo-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin: 0;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .brand-tag {
      background: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
      color: #ffffff;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
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
      background: rgba(124, 58, 237, 0.14);
      color: #a78bfa;
      border: 1px solid rgba(139, 92, 246, 0.35);
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
      border: 1px solid rgba(63, 185, 80, 0.3);
    }

    .badge-warning {
      background: var(--warning-bg);
      color: var(--warning-fg);
    }

    .badge-error {
      background: var(--error-bg);
      color: var(--error-fg);
    }

    /* Subheader Context Card */
    .context-bar {
      margin-top: 10px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      font-size: 12px;
      color: var(--subtle);
    }

    .context-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .context-label {
      color: var(--subtle);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.4px;
    }

    .context-value {
      font-weight: 600;
      color: var(--fg);
    }

    /* Concept Badges Strip */
    .concept-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }

    .concept-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .concept-card.lm-card {
      border-color: rgba(139, 92, 246, 0.3);
    }
    .concept-card.neo-card {
      border-color: rgba(6, 182, 212, 0.3);
    }
    .concept-card.git-card {
      border-color: rgba(245, 158, 11, 0.3);
    }
    .concept-card.metrics-card {
      border-color: rgba(59, 130, 246, 0.3);
    }

    .concept-icon {
      font-size: 14px;
      line-height: 1;
      flex-shrink: 0;
    }

    .concept-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--fg);
    }

    .concept-sub {
      font-size: 10px;
      color: var(--subtle);
      font-family: var(--font-mono);
    }

    /* Tab Bar Navigation */
    .tab-nav {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 14px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .tab-button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px 5px 0 0;
      color: var(--subtle);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .tab-button:hover {
      color: var(--fg);
      background: var(--hover-bg);
    }

    .tab-button.active {
      color: var(--fg);
      background: var(--card-bg);
      border-color: var(--card-border) var(--card-border) transparent var(--card-border);
      border-bottom: 2px solid #7c3aed;
    }

    .tab-panel {
      display: none;
    }

    .tab-panel.active {
      display: block;
    }

    /* Smart Reasoning Pills */
    .reason-pill {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 1px 7px;
      border-radius: 12px;
      margin-right: 6px;
      vertical-align: middle;
      line-height: 1.4;
    }

    .reason-verified {
      background: rgba(46, 160, 67, 0.18);
      color: #3fb950;
      border: 1px solid rgba(63, 185, 80, 0.4);
    }

    .reason-inferred {
      background: rgba(210, 153, 34, 0.18);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
    }

    .reason-uncertain, .reason-unknown {
      background: rgba(248, 81, 73, 0.18);
      color: #f85149;
      border: 1px solid rgba(248, 81, 73, 0.4);
    }

    /* Explanation Card */
    .explanation-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 14px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .explanation-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .explanation-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--fg);
      margin: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .explanation-text {
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 8px;
      color: var(--fg);
    }

    .explanation-lead {
      font-size: 13.5px;
      line-height: 1.6;
      margin-bottom: 10px;
      color: var(--fg);
      font-weight: 500;
    }

    .explanation-reasons {
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 8px;
      color: var(--fg);
    }

    .uncertainty-box {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--card-border);
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 11px;
      color: var(--subtle);
    }

    .uncertainty-badge {
      display: inline-block;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--subtle);
      font-weight: 700;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    /* Supporting Commits List */
    .supporting-commits-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
    }

    .section-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--subtle);
      margin-bottom: 10px;
    }

    .commit-summary-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(127, 127, 127, 0.1);
      flex-wrap: wrap;
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
      padding: 1px 6px;
      border-radius: 3px;
      color: var(--fg);
      flex-shrink: 0;
      font-weight: 600;
    }

    .commit-subject {
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 140px;
    }

    /* Timeline Commit Cards in Commits Tab */
    .timeline-commit-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
      padding: 10px 12px;
    }

    .timeline-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }

    .timeline-subject {
      font-weight: 600;
      color: var(--fg);
      font-size: 13px;
      flex: 1;
      min-width: 140px;
    }

    .timeline-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11px;
      color: var(--subtle);
      padding-top: 4px;
    }

    .timeline-body {
      margin-top: 8px;
      padding: 8px 10px;
      font-size: 12px;
      white-space: pre-wrap;
      background: rgba(127, 127, 127, 0.05);
      border-radius: 4px;
      color: var(--fg);
    }

    /* Graph Record Cards in Graph Tab */
    .graph-record-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-left: 3px solid var(--info-fg);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
      padding: 10px 12px;
    }

    .graph-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }

    .graph-subject {
      font-weight: 600;
      color: var(--fg);
      font-size: 13px;
      flex: 1;
      min-width: 140px;
    }

    .graph-record-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11px;
      color: var(--subtle);
      padding-top: 4px;
    }

    .graph-provenance-box {
      margin-top: 8px;
      padding: 6px 8px;
      background: rgba(6, 182, 212, 0.07);
      border: 1px solid rgba(6, 182, 212, 0.2);
      border-radius: 4px;
      font-size: 11px;
    }

    .graph-cypher-preview {
      display: block;
      margin-top: 4px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--info-fg);
      word-break: break-all;
    }

    /* Notice / Banner Boxes */
    .banner {
      padding: 10px 14px;
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
      padding: 9px 12px;
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
      background: rgba(127, 127, 127, 0.14);
    }

    .summary-title {
      flex: 1;
    }

    .summary-subtext {
      font-size: 11px;
      font-weight: 400;
      color: var(--subtle);
    }

    .collapse-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      user-select: none;
    }
    details:not([open]) > summary .collapse-badge::after {
      content: "Click to expand";
    }
    details[open] > summary .collapse-badge::after {
      content: "Click to collapse";
    }
    summary {
      cursor: pointer;
      user-select: none;
    }
    summary:focus-visible {
      outline: 1px solid var(--accent);
      outline-offset: 2px;
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
      padding: 10px 12px;
      line-height: 1.45;
    }

    /* Detailed Commit Cards */
    .detailed-commit-card {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .detailed-commit-card:last-child {
      margin-bottom: 0;
    }

    .detailed-commit-header {
      padding: 9px 12px;
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
      padding: 9px 12px;
      font-size: 12px;
      white-space: pre-wrap;
      border-bottom: 1px solid var(--card-border);
      color: var(--fg);
      background: rgba(127, 127, 127, 0.03);
    }

    pre.diff-block {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      overflow-x: auto;
      padding: 8px 10px;
      line-height: 1.4;
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
      padding: 6px 10px;
      border-bottom: 1px solid var(--card-border);
      vertical-align: top;
    }

    .diag-table tr:last-child td {
      border-bottom: none;
    }

    .diag-label {
      color: var(--subtle);
      font-weight: 600;
      width: 160px;
    }

    .diag-value {
      color: var(--fg);
      font-family: var(--font-mono);
      word-break: break-all;
    }

    .empty-state {
      padding: 28px 16px;
      text-align: center;
      color: var(--subtle);
      font-size: 12px;
      background: var(--card-bg);
      border: 1px dashed var(--card-border);
      border-radius: 8px;
      margin: 12px 0;
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="header-top">
      <div class="brand-row">
        <span class="brand-logo-wrap">${logoHtml}</span>
        <span class="brand-tag">ORIGINX</span>
        <h1 class="brand-title">
          <span>GitWhisper: Why Was This Changed?</span>
        </h1>
        <span class="badge ${providerBadgeClass}">${providerLabel}</span>
        ${hasNeo ? `<span class="badge badge-meta" style="color: var(--info-fg); border-color: rgba(55, 148, 255, 0.4);">Neo4j Grounded (${result.neo4jEvidence!.length})</span>` : ''}
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
        <span class="context-label">Git History:</span>
        <span class="context-value">${counts.gitCommitCount} commit${counts.gitCommitCount === 1 ? '' : 's'}</span>
      </span>
      <span class="context-item">
        <span class="context-label">Unique Commits:</span>
        <span class="context-value">${counts.uniqueCommits}</span>
      </span>
      <span class="context-item">
        <span class="context-label">Evidence Records:</span>
        <span class="context-value">${counts.totalRecords}</span>
      </span>
    </div>
  </header>

  <!-- Visual Concept Badges Strip -->
  <div class="concept-strip">
    <div class="concept-card lm-card">
      <span class="concept-icon">🧠</span>
      <div>
        <div class="concept-title">${providerLabel}</div>
        <div class="concept-sub">${durationBadge || 'Verified Synthesis'}</div>
      </div>
    </div>
    <div class="concept-card neo-card">
      <span class="concept-icon">🌐</span>
      <div>
        <div class="concept-title">${hasNeo ? `Neo4j Grounded (${result.neo4jEvidence!.length})` : 'Neo4j Standby'}</div>
        <div class="concept-sub">${hasNeo ? (result.neo4jRepositoryId || 'Graph Linked') : 'Local Graph Cache'}</div>
      </div>
    </div>
    <div class="concept-card git-card">
      <span class="concept-icon">⚡</span>
      <div>
        <div class="concept-title">Git History: ${counts.gitCommitCount} commit${counts.gitCommitCount === 1 ? '' : 's'}</div>
        <div class="concept-sub">Local Line Evolution</div>
      </div>
    </div>
    <div class="concept-card metrics-card">
      <span class="concept-icon">📊</span>
      <div>
        <div class="concept-title">Unique Commits: ${counts.uniqueCommits}</div>
        <div class="concept-sub">Evidence Records: ${counts.totalRecords} (across sources)</div>
      </div>
    </div>
  </div>

  <!-- Interactive 5-Panel Tab Navigation -->
  <nav class="tab-nav" role="tablist">
    <button class="tab-button active" role="tab" aria-selected="true" data-tab="panel-explanation" onclick="window.switchOriginxTab('panel-explanation')">✨ Explanation</button>
    <button class="tab-button" role="tab" aria-selected="false" data-tab="panel-commits" onclick="window.switchOriginxTab('panel-commits')">⚡ Commits (${counts.uniqueCommits})</button>
    <button class="tab-button" role="tab" aria-selected="false" data-tab="panel-graph" onclick="window.switchOriginxTab('panel-graph')">🌐 Graph${hasNeo ? ` (${result.neo4jEvidence!.length})` : ''}</button>
    <button class="tab-button" role="tab" aria-selected="false" data-tab="panel-diffs" onclick="window.switchOriginxTab('panel-diffs')">📄 Diffs</button>
    <button class="tab-button" role="tab" aria-selected="false" data-tab="panel-details" onclick="window.switchOriginxTab('panel-details')">🔍 Details</button>
  </nav>

  <!-- Panel 1: Explanation View (Active by default) -->
  <div id="panel-explanation" class="tab-panel active">
    ${conciseExplanationHtml}
    ${supportingCommitsSummaryHtml}
  </div>

  <!-- Panel 5: Details (Selected Code Snippet & Diagnostics) -->
  <div id="panel-details" class="tab-panel">
    ${codeSnippetDetailsHtml}
    ${diagnosticsDetailsHtml}
  </div>

  <!-- Panel 2: Commits Timeline -->
  <div id="panel-commits" class="tab-panel">
    ${commitsTimelineHtml}
  </div>

  <!-- Panel 3: Neo4j Graph Evidence -->
  <div id="panel-graph" class="tab-panel">
    ${graphEvidenceHtml}
  </div>

  <!-- Panel 4: Diffs & Patches -->
  <div id="panel-diffs" class="tab-panel">
    ${gitEvidenceDetailsHtml}
  </div>

  <script>
    (function() {
      // 1. Direct Global Tab Switcher (accessible by onclick or event listeners)
      window.switchOriginxTab = function(targetId) {
        if (!targetId) return;
        var tabButtons = document.querySelectorAll('.tab-button');
        var panels = document.querySelectorAll('.tab-panel');

        tabButtons.forEach(function(b) {
          if (b.getAttribute('data-tab') === targetId) {
            b.classList.add('active');
            b.setAttribute('aria-selected', 'true');
          } else {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
          }
        });

        panels.forEach(function(p) {
          if (p.id === targetId) {
            p.classList.add('active');
            p.style.display = 'block';
            var innerDetails = p.querySelectorAll('details.collapsible-section');
            innerDetails.forEach(function(d) { d.open = true; });
          } else {
            p.classList.remove('active');
            p.style.display = 'none';
          }
        });
      };

      // 2. Interactive Expandables
      function initExpandables() {
        var detailsList = document.querySelectorAll('details');
        detailsList.forEach(function(d) {
          var summary = d.querySelector('summary');
          if (!summary) return;
          summary.setAttribute('aria-expanded', d.hasAttribute('open') ? 'true' : 'false');
          d.addEventListener('toggle', function() {
            summary.setAttribute('aria-expanded', d.open ? 'true' : 'false');
          });
          summary.addEventListener('keydown', function(e) {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              d.open = !d.open;
            }
          });
        });
      }

      // 3. Tab Button Click Listeners (delegated & direct)
      function initTabs() {
        var tabButtons = document.querySelectorAll('.tab-button');
        tabButtons.forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            var targetId = btn.getAttribute('data-tab');
            if (targetId && window.switchOriginxTab) {
              window.switchOriginxTab(targetId);
            }
          });
        });
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          initExpandables();
          initTabs();
        });
      } else {
        initExpandables();
        initTabs();
      }
    })();
  </script>
</body>
</html>`;
  }

  private static renderClassifiedReasons(text: string): string {
    const escaped = this.escapeHtml(text);
    return escaped
      .replace(/\[Verified(?:\s*Fact)?\]/gi, '<span class="badge badge-success reason-pill reason-verified">Verified</span>')
      .replace(/\(Verified(?:\s*Fact)?\)/gi, '<span class="badge badge-success reason-pill reason-verified">Verified</span>')
      .replace(/\[Inferred(?:\s*Hypothesis)?\]/gi, '<span class="badge badge-provider-vscode reason-pill reason-inferred">Inferred</span>')
      .replace(/\(Inferred(?:\s*Hypothesis)?\)/gi, '<span class="badge badge-provider-vscode reason-pill reason-inferred">Inferred</span>')
      .replace(/\[Unknown\]/gi, '<span class="badge badge-warning reason-pill reason-unknown">Unknown</span>')
      .replace(/\(Unknown\)/gi, '<span class="badge badge-warning reason-pill reason-unknown">Unknown</span>')
      .replace(/\[Uncertain\]/gi, '<span class="badge badge-warning reason-pill reason-uncertain">Uncertain</span>')
      .replace(/\(Uncertain\)/gi, '<span class="badge badge-warning reason-pill reason-uncertain">Uncertain</span>');
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
            <h2 class="explanation-title">
              <span>Explanation</span>
            </h2>
            <span class="badge badge-success" style="font-size: 11px;">Evidence-Backed</span>
          </div>
          <div class="explanation-lead">
            ${this.escapeHtml(exp.whatChanged)}
          </div>
          <div class="explanation-reasons">
            ${this.renderClassifiedReasons(exp.possibleReasons)}
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
   * Consolidates duplicate Git and Neo4j graph evidence by canonical hash while preserving source badges.
   */
  private static renderSupportingCommitsSummary(commits: CommitInfo[], neo4jEvidence?: Neo4jCommitEvidence[]): string {
    const hasCommits = commits.length > 0;
    const hasNeo = Boolean(neo4jEvidence && neo4jEvidence.length > 0);

    if (!hasCommits && !hasNeo) {
      return '';
    }

    const consolidated = consolidateEvidence(commits, neo4jEvidence);
    const counts = calculateEvidenceCounts(commits, neo4jEvidence);

    const rows = consolidated
      .map((c) => {
        const gitBadge = c.sources.gitBlame
          ? '<span class="badge badge-meta" style="font-size: 10px;">Git Blame</span>'
          : '';
        const neoBadge = c.sources.neo4j
          ? `<span class="badge badge-meta" style="font-size: 10px; color: var(--info-fg); border-color: rgba(55, 148, 255, 0.35);">Neo4j Graph (${this.escapeHtml(c.sources.neo4jChangeType || 'MODIFIED')})</span>`
          : '';

        return `
          <div class="commit-summary-row">
            <code class="commit-hash">${this.escapeHtml(c.shortHash)}</code>
            <span class="commit-subject">${this.escapeHtml(c.subject)}</span>
            ${gitBadge}
            ${neoBadge}
          </div>
        `;
      })
      .join('');

    let headingLabel: string;
    if (hasNeo) {
      if (counts.uniqueCommits !== counts.totalRecords) {
        headingLabel = `Supporting Evidence Records (${counts.totalRecords}) — ${counts.uniqueCommits} Unique Commits`;
      } else {
        headingLabel = `Supporting Evidence Records (${counts.totalRecords})`;
      }
    } else {
      headingLabel = `Supporting Evidence Commits (${counts.uniqueCommits})`;
    }

    return `
      <section class="supporting-commits-card">
        <div class="section-label">${this.escapeHtml(headingLabel)}</div>
        <div>
          ${rows}
        </div>
      </section>
    `;
  }

  /**
   * Panel 2 Content: Unique Commit Timeline with full author, date, and commit message.
   */
  private static renderCommitsTimeline(commits: CommitInfo[], neo4jEvidence?: Neo4jCommitEvidence[]): string {
    const consolidated = consolidateEvidence(commits, neo4jEvidence);
    if (consolidated.length === 0) {
      return `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 6px;">⚡</div>
          <strong>No Commit History</strong>
          <div style="font-size: 11px; color: var(--subtle); margin-top: 4px;">No commit records found in Git for the selected lines.</div>
        </div>
      `;
    }

    const cards = consolidated
      .map((c, i) => {
        const gitBadge = c.sources.gitBlame
          ? '<span class="badge badge-meta" style="font-size: 10px;">Git Blame</span>'
          : '';
        const neoBadge = c.sources.neo4j
          ? `<span class="badge badge-meta" style="font-size: 10px; color: var(--info-fg); border-color: rgba(55, 148, 255, 0.35);">Neo4j Graph (${this.escapeHtml(c.sources.neo4jChangeType || 'MODIFIED')})</span>`
          : '';

        return `
          <div class="timeline-commit-card">
            <div class="timeline-title-row">
              <code class="commit-hash">${this.escapeHtml(c.shortHash)}</code>
              <span class="timeline-subject">${this.escapeHtml(c.subject)}</span>
              ${gitBadge}
              ${neoBadge}
            </div>
            <div class="timeline-meta">
              <span>Author: <strong>${this.escapeHtml(c.authorName)}</strong>${c.authorEmail ? ` &lt;${this.escapeHtml(c.authorEmail)}&gt;` : ''}</span>
              <span>Date: <strong>${this.escapeHtml(c.date || c.sources.neo4jCommittedAt || 'unknown')}</strong></span>
              <span>Commit: <strong>${i + 1} of ${consolidated.length}</strong></span>
              <span>Full Hash: <code style="font-family: var(--font-mono); font-size: 10.5px;">${this.escapeHtml(c.canonicalHash)}</code></span>
            </div>
            ${c.body ? `<div class="timeline-body">${this.escapeHtml(c.body)}</div>` : ''}
          </div>
        `;
      })
      .join('');

    return `
      <section style="margin-bottom: 16px;">
        <div class="section-label">Commit History Timeline (${consolidated.length} Unique Commit${consolidated.length === 1 ? '' : 's'})</div>
        <div>
          ${cards}
        </div>
      </section>
    `;
  }

  /**
   * Panel 3 Content: Neo4j Knowledge Graph Provenance records.
   */
  private static renderGraphEvidence(result: GitHistoryResult): string {
    const neoList = result.neo4jEvidence || [];
    if (neoList.length === 0) {
      return `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 6px;">🌐</div>
          <strong>No Neo4j Graph Evidence</strong>
          <div style="font-size: 11px; color: var(--subtle); margin-top: 4px;">
            No graph nodes were found for this file in Neo4j AuraDB.
            Local Git evidence is accessible in the Commits and Diffs tabs.
          </div>
          <div style="font-size: 11px; color: var(--subtle); margin-top: 6px;">
            Run <code>ORIGINX: Import Git History to Neo4j Knowledge Graph</code> from the Command Center to ingest repository provenance.
          </div>
        </div>
      `;
    }

    const cards = neoList
      .map((ge, idx) => {
        const hash = ge.shortHash || (ge.commitHash ? ge.commitHash.slice(0, 7) : 'unknown');
        const authorStr = ge.authorEmail ? `${ge.authorName} <${ge.authorEmail}>` : ge.authorName;
        const changeStr = ge.oldPath ? `${ge.changeType.toUpperCase()} (from ${ge.oldPath})` : ge.changeType.toUpperCase();
        const relPath = ge.filePath || result.selection.fileName;

        return `
          <div class="graph-record-card">
            <div class="graph-title-row">
              <code class="commit-hash">${this.escapeHtml(hash)}</code>
              <span class="graph-subject">${this.escapeHtml(ge.subject || 'No subject')}</span>
              <span class="badge badge-meta" style="font-size: 10px; color: var(--info-fg); border-color: rgba(55, 148, 255, 0.35);">Neo4j Graph (${this.escapeHtml(ge.changeType.toUpperCase())})</span>
            </div>
            <div class="graph-record-meta">
              <span>Author: <strong>${this.escapeHtml(authorStr)}</strong></span>
              <span>Committed At: <strong>${this.escapeHtml(ge.committedAt || 'unknown')}</strong></span>
              <span>Change Type: <strong>${this.escapeHtml(changeStr)}</strong></span>
              <span>Record: <strong>${idx + 1} of ${neoList.length}</strong></span>
              <span>Full Hash: <code style="font-family: var(--font-mono); font-size: 10.5px;">${this.escapeHtml(ge.commitHash)}</code></span>
            </div>
            <div class="graph-provenance-box">
              <span style="font-weight: 600; color: var(--subtle); font-size: 10px; text-transform: uppercase;">Graph Provenance:</span>
              <code class="graph-cypher-preview">(:Repository {id: "${this.escapeHtml(result.neo4jRepositoryId || 'repo')}"})-[:HAS_COMMIT]-&gt;(:Commit {hash: "${this.escapeHtml(hash)}"})-[:MODIFIED {changeType: "${this.escapeHtml(ge.changeType.toUpperCase())}"}]-&gt;(:File {path: "${this.escapeHtml(relPath)}"})</code>
            </div>
            ${ge.body ? `<div class="timeline-body">${this.escapeHtml(ge.body)}</div>` : ''}
          </div>
        `;
      })
      .join('');

    const durationText = result.neo4jDurationMs !== undefined ? ` • Queried in ${result.neo4jDurationMs}ms` : '';
    const repoText = result.neo4jRepositoryId ? ` • Repository: ${this.escapeHtml(result.neo4jRepositoryId)}` : '';

    return `
      <section style="margin-bottom: 16px;">
        <div class="section-label">Neo4j Knowledge Graph Evidence (${neoList.length} Record${neoList.length === 1 ? '' : 's'}${repoText}${durationText})</div>
        <div>
          ${cards}
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
      <details class="collapsible-section" id="details-snippet">
        <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
          <span class="summary-title">Selected Code Snippet (Lines ${selection.startLine}–${selection.endLine})</span>
          <span class="summary-subtext" style="display: inline-flex; align-items: center; gap: 8px;">
            <span>${lineCount} line${lineCount === 1 ? '' : 's'}</span>
            <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
          </span>
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
    const hasNeo = Boolean(result.neo4jEvidence && result.neo4jEvidence.length > 0);
    if (result.commits.length === 0 && !result.uncommittedDiff && !hasNeo) {
      return `
        <details class="collapsible-section" id="details-diffs">
          <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
            <span class="summary-title">Git Evidence & Complete Diffs (0 Commits)</span>
            <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
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
              <span class="badge badge-meta" style="margin-left: 8px; font-size: 10px;">Git Blame</span>
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

    const neoCommitsHtml = (result.neo4jEvidence || [])
      .map(
        (ge, idx) => {
          const hash = ge.shortHash || (ge.commitHash ? ge.commitHash.slice(0, 7) : 'unknown');
          const authorStr = ge.authorEmail ? `${ge.authorName} <${ge.authorEmail}>` : ge.authorName;
          const changeStr = ge.oldPath ? `${ge.changeType.toUpperCase()} (from ${ge.oldPath})` : ge.changeType.toUpperCase();
          return `
          <div class="detailed-commit-card" style="border-left: 3px solid var(--info-fg);">
            <div class="detailed-commit-header">
              <div class="detailed-commit-title">
                <span class="commit-hash">${this.escapeHtml(hash)}</span>
                ${this.escapeHtml(ge.subject || 'No subject')}
                <span class="badge badge-meta" style="margin-left: 8px; font-size: 10px; color: var(--info-fg); border-color: rgba(55, 148, 255, 0.3);">Neo4j Graph (${this.escapeHtml(ge.changeType.toUpperCase())})</span>
              </div>
              <div class="detailed-commit-meta">
                <span>Author: <strong>${this.escapeHtml(authorStr)}</strong></span>
                <span>Date: <strong>${this.escapeHtml(ge.committedAt || 'unknown')}</strong></span>
                <span>Change: <strong>${this.escapeHtml(changeStr)}</strong></span>
                <span>Graph Record: <strong>${idx + 1} of ${result.neo4jEvidence!.length}</strong></span>
                <span>Full Hash: <code style="font-family: var(--font-mono);">${this.escapeHtml(ge.commitHash)}</code></span>
              </div>
            </div>
            ${ge.body ? `<div class="detailed-commit-body">${this.escapeHtml(ge.body)}</div>` : ''}
          </div>
        `;
        }
      )
      .join('');

    const counts = calculateEvidenceCounts(result.commits, result.neo4jEvidence);
    const uniqueNote = hasNeo && counts.uniqueCommits !== counts.totalRecords
      ? ` — ${counts.uniqueCommits} Unique Commits`
      : '';
    const countLabel = `${result.commits.length} Line Record${result.commits.length === 1 ? '' : 's'}${hasNeo ? ` + ${result.neo4jEvidence!.length} Graph Record${result.neo4jEvidence!.length === 1 ? '' : 's'}` : ''}${uniqueNote}${result.hasUncommittedChanges ? ' + uncommitted' : ''}`;

    return `
      <details class="collapsible-section" id="details-diffs">
        <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
          <span class="summary-title">Git & Knowledge Graph Evidence (${countLabel})</span>
          <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
        </summary>
        <div class="collapsible-content">
          ${uncommittedHtml}
          ${commitsHtml}
          ${neoCommitsHtml}
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
    if (result.neo4jEvidence && result.neo4jEvidence.length > 0) {
      rows.push({ label: 'Neo4j Graph Commits', value: String(result.neo4jEvidence.length) });
    }
    if (result.neo4jRepositoryId) {
      rows.push({ label: 'Neo4j Repository', value: result.neo4jRepositoryId });
    }
    if (result.neo4jDurationMs !== undefined) {
      rows.push({ label: 'Neo4j Retrieval', value: `${result.neo4jDurationMs}ms` });
    }
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
      <details class="collapsible-section" id="details-diagnostics">
        <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
          <span class="summary-title">Technical Diagnostics & Metadata</span>
          <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
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

  public static renderMultiFileHtml(result: MultiFileHistoryResult): string {
    const diag = result.explanationDiagnostics;
    const exp = result.explanation;

    let providerLabel = 'Local Git Only';
    let providerBadgeClass = 'badge-neutral';
    if (exp) {
      providerLabel = `VS Code LM (${this.escapeHtml(exp.model)})`;
      providerBadgeClass = 'badge-provider-vscode';
    } else if (result.explanationStatus === 'disabled') {
      providerLabel = 'AI Analysis Disabled';
      providerBadgeClass = 'badge-neutral';
    } else if (result.explanationStatus === 'no_model') {
      providerLabel = 'VS Code LM Unavailable';
      providerBadgeClass = 'badge-warning';
    } else if (result.explanationStatus === 'blocked_security') {
      providerLabel = 'Security Blocked';
      providerBadgeClass = 'badge-error';
    } else if (result.explanationStatus === 'failed') {
      providerLabel = 'AI Error';
      providerBadgeClass = 'badge-error';
    } else if (result.explanationStatus === 'cancelled') {
      providerLabel = 'Cancelled';
      providerBadgeClass = 'badge-neutral';
    }

    const durationBadge = diag ? `${(diag.durationMs / 1000).toFixed(1)}s` : '';
    const fileCountLabel = `${result.eligibleFiles.length} File${result.eligibleFiles.length === 1 ? '' : 's'}`;
    const commitCountLabel = `${result.evidence.totalCommits} Commit${result.evidence.totalCommits === 1 ? '' : 's'}`;

    // Target files overview (deduplicated)
    const seenOverviewFiles = new Set<string>();
    const filesListHtml = result.eligibleFiles
      .filter((f) => {
        const key = (f.filePath || f.fileName).toLowerCase();
        if (seenOverviewFiles.has(key)) return false;
        seenOverviewFiles.add(key);
        return true;
      })
      .map((f) => `<span class="badge badge-meta">${this.escapeHtml(f.fileName)}</span>`)
      .join(' ');

    const mixedRepoBadgeHtml = result.isMixedRepositories
      ? '<span class="badge badge-warning">Mixed Repositories</span>'
      : '';

    // Sections
    const crossFileHtml = this.renderMultiFileCrossSummary(result);
    const perFileHtml = this.renderMultiFilePerFileCards(result);
    const supportingCommitsHtml = this.renderMultiFileSupportingCommits(result);
    const uncertaintyHtml = this.renderMultiFileUncertainty(result);
    const diffEvidenceHtml = this.renderMultiFileDiffEvidence(result);
    const diagnosticsHtml = this.renderMultiFileDiagnostics(result);

    const logoHtml = this.getOriginxLogoHtml(26);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper by ORIGINX: Multi-File Cross-Repository Analysis</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --subtle: var(--vscode-descriptionForeground, #858585);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --accent-fg: #ffffff;
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --diff-add-fg: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
      --diff-add-bg: rgba(129, 184, 139, 0.15);
      --diff-del-fg: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
      --diff-del-bg: rgba(199, 78, 57, 0.15);
      --warning-fg: var(--vscode-editorWarning-foreground, #d29922);
      --warning-bg: rgba(210, 153, 34, 0.12);
      --error-fg: var(--vscode-editorError-foreground, #f85149);
      --error-bg: rgba(248, 81, 73, 0.12);
      --info-fg: var(--vscode-textLink-foreground, #3794ff);
      --info-bg: rgba(55, 148, 255, 0.1);
      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; }
    html, body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      margin: 0;
      padding: 14px 18px 40px;
      overflow-x: hidden;
      max-width: 100%;
    }
    .collapse-badge {
      display: inline-flex;
      align-items: center;
      user-select: none;
    }
    details:not([open]) > summary .collapse-badge::after {
      content: "Click to expand";
    }
    details[open] > summary .collapse-badge::after {
      content: "Click to collapse";
    }
    summary {
      cursor: pointer;
      user-select: none;
    }
    summary:focus-visible {
      outline: 1px solid var(--accent);
      outline-offset: 2px;
    }
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
      gap: 10px;
    }
    .brand-logo-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .brand-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin: 0;
      color: var(--fg);
    }
    .brand-tag {
      background: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
      color: #ffffff;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
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
    .badge-neutral { background: var(--badge-bg); color: var(--badge-fg); }
    .badge-provider-vscode { background: var(--info-bg); color: var(--info-fg); border: 1px solid rgba(55, 148, 255, 0.3); }
    .badge-meta { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--subtle); font-family: var(--font-mono); font-size: 11px; }
    .badge-success { background: var(--diff-add-bg); color: var(--diff-add-fg); }
    .badge-warning { background: var(--warning-bg); color: var(--warning-fg); border: 1px solid rgba(210, 153, 34, 0.3); }
    .badge-error { background: var(--error-bg); color: var(--error-fg); }
    .overview-bar {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .main-section {
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--accent);
      margin: 0 0 6px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 12px 14px;
    }
    .card-narrative {
      font-size: 13.5px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .per-file-grid {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .per-file-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
    }
    .per-file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .per-file-name {
      font-weight: 700;
      font-size: 13px;
    }
    .per-file-path {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--subtle);
    }
    .per-file-field {
      margin-top: 4px;
      font-size: 12.5px;
    }
    .field-label {
      font-weight: 600;
      color: var(--subtle);
      font-size: 11px;
      text-transform: uppercase;
    }
    .commit-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(128, 128, 128, 0.1);
    }
    .commit-row:last-child {
      border-bottom: none;
    }
    .commit-hash {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--card-border);
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
    .commit-files {
      margin-left: auto;
      font-size: 11px;
      color: var(--subtle);
      flex-shrink: 0;
    }
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
      background: rgba(128, 128, 128, 0.08);
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
      background: rgba(128, 128, 128, 0.14);
    }
    .summary-title {
      flex: 1;
    }
    .collapsible-content {
      padding: 12px;
      border-top: 1px solid var(--card-border);
    }
    .file-diff-card {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 5px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .file-diff-card:last-child {
      margin-bottom: 0;
    }
    .file-diff-header {
      padding: 7px 10px;
      background: rgba(128, 128, 128, 0.06);
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      color: var(--subtle);
    }
    .diag-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    .diag-table td {
      padding: 4px 8px;
      border-bottom: 1px solid var(--card-border);
      vertical-align: top;
    }
    .diag-table tr:last-child td {
      border-bottom: none;
    }
    .diag-label {
      color: var(--subtle);
      font-weight: 600;
      width: 160px;
    }
    .diag-value {
      color: var(--fg);
      font-family: var(--font-mono);
      word-break: break-all;
    }
    .reason-pill {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 1px 7px;
      border-radius: 12px;
      margin-right: 6px;
      vertical-align: middle;
      line-height: 1.4;
    }
    .reason-verified {
      background: rgba(46, 160, 67, 0.18);
      color: #3fb950;
      border: 1px solid rgba(63, 185, 80, 0.4);
    }
    .reason-inferred {
      background: rgba(210, 153, 34, 0.18);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
    }
    .reason-uncertain, .reason-unknown {
      background: rgba(248, 81, 73, 0.18);
      color: #f85149;
      border: 1px solid rgba(248, 81, 73, 0.4);
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="header-top">
      <div class="brand-row">
        <span class="brand-logo-wrap">${logoHtml}</span>
        <span class="brand-tag">ORIGINX</span>
        <h1 class="brand-title">GitWhisper: Multi-File Cross-Repository Analysis</h1>
        <span class="badge ${providerBadgeClass}">${providerLabel}</span>
        ${durationBadge ? `<span class="badge badge-meta">${durationBadge}</span>` : ''}
        ${mixedRepoBadgeHtml}
      </div>
      <div>
        <span class="badge badge-success">${fileCountLabel}</span>
        <span class="badge badge-neutral" style="margin-left: 4px;">${commitCountLabel}</span>
      </div>
    </div>
    <div class="overview-bar">
      <span style="font-size: 11px; color: var(--subtle); font-weight: 600; text-transform: uppercase;">Analyzed Files:</span>
      ${filesListHtml}
    </div>
  </header>

  <section class="main-section">
    <div class="section-title">
      <span>Cross-File Relationship & Change Summary</span>
    </div>
    ${crossFileHtml}
  </section>

  <section class="main-section">
    <div class="section-title">
      <span>Per-File Change Breakdown</span>
    </div>
    ${perFileHtml}
  </section>

  <section class="main-section">
    <div class="section-title">
      <span>Supporting Commits</span>
    </div>
    ${supportingCommitsHtml}
  </section>

  ${uncertaintyHtml}
  <details class="collapsible-section">
    <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
      <span class="summary-title">Complete Git Evidence & Diffs (${result.evidence.totalDiffChars.toLocaleString()} chars)</span>
      <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
    </summary>
    <div class="collapsible-content">
      ${diffEvidenceHtml}
    </div>
  </details>
  ${diagnosticsHtml}

  <script>
    (function() {
      function initExpandables() {
        var detailsList = document.querySelectorAll('details');
        detailsList.forEach(function(d) {
          var summary = d.querySelector('summary');
          if (!summary) return;
          summary.setAttribute('aria-expanded', d.hasAttribute('open') ? 'true' : 'false');
          d.addEventListener('toggle', function() {
            summary.setAttribute('aria-expanded', d.open ? 'true' : 'false');
          });
          summary.addEventListener('keydown', function(e) {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              d.open = !d.open;
            }
          });
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initExpandables);
      } else {
        initExpandables();
      }
    })();
  </script>
</body>
</html>`;
  }

  private static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static renderMultiFileCrossSummary(result: MultiFileHistoryResult): string {
    if (result.explanation) {
      return `<div class="card card-narrative">${this.escapeHtml(result.explanation.crossFileSummary)}</div>`;
    }

    if (result.explanationStatus === 'disabled') {
      return `
        <div class="banner banner-info" style="border-left: 3px solid var(--subtle);">
          <strong>Automatic AI Analysis is Disabled (Default)</strong>
          <div style="font-size: 12px; margin-top: 4px;">
            ORIGINX gathered local Git evidence for ${result.eligibleFiles.length} file(s). To enable cross-file Copilot AI explanations, open the <strong>Command Center</strong> (<code>Ctrl+Shift+P</code> -&gt; <code>ORIGINX: Command Center</code>) and select <strong>Enable Automatic AI Analysis</strong>.
          </div>
        </div>`;
    }

    if (result.explanationStatus === 'no_model') {
      return `
        <div class="banner banner-warning">
          <strong>No Language Model Available:</strong> ${this.escapeHtml(result.explanationError || 'No models discovered via vscode.lm.')}
          <br/>Ensure GitHub Copilot is installed and active. Local Git evidence is preserved below.
        </div>`;
    }

    if (result.explanationStatus === 'blocked_security') {
      return `
        <div class="card" style="border-left: 3px solid var(--error-fg); background: var(--error-bg);">
          <div style="font-weight: 600; color: var(--error-fg);">Security Block: Sensitive Credentials Detected</div>
          <div style="margin-top: 4px; font-size: 12px;">
            ${this.escapeHtml(result.explanationError || 'Potential secret detected in repository diffs. Request was halted to protect your credentials.')}
          </div>
        </div>`;
    }

    if (result.explanationStatus === 'failed') {
      return `
        <div class="banner banner-error">
          <strong>AI Analysis Failed:</strong> ${this.escapeHtml(result.explanationError || 'Request failed.')}
          <br/>Local Git history for all files is preserved below.
        </div>`;
    }

    if (result.explanationStatus === 'cancelled') {
      return `
        <div class="banner banner-info">
          <strong>Analysis Cancelled:</strong> Request was cancelled. Local Git history is preserved below.
        </div>`;
    }

    return '<div class="card" style="color: var(--subtle); font-size: 12px;">No explanation available.</div>';
  }

  private static renderMultiFilePerFileCards(result: MultiFileHistoryResult): string {
    const exp = result.explanation;
    const summaries = exp?.perFileSummaries || [];

    if (summaries.length === 0) {
      const seenPaths = new Set<string>();
      const uniqueEligible = result.eligibleFiles.filter((f) => {
        const key = (f.filePath || f.fileName).toLowerCase();
        if (seenPaths.has(key)) return false;
        seenPaths.add(key);
        return true;
      });
      return `
        <div class="per-file-grid">
          ${uniqueEligible
            .map(
              (f) => `
            <div class="per-file-card">
              <div class="per-file-header">
                <span class="per-file-name">${this.escapeHtml(f.fileName)}</span>
                <span class="per-file-path">${this.escapeHtml(f.relativeFilePath || f.filePath)}</span>
              </div>
              <div class="per-file-field" style="color: var(--subtle); font-size: 12px;">
                Raw Git history preserved below.
              </div>
            </div>`
            )
            .join('')}
        </div>`;
    }

    const seenSummaries = new Set<string>();
    const uniqueSummaries = summaries.filter((s) => {
      const key = (s.filePath || s.fileName).toLowerCase();
      if (seenSummaries.has(key)) return false;
      seenSummaries.add(key);
      return true;
    });

    return `
      <div class="per-file-grid">
        ${uniqueSummaries
          .map(
            (s) => {
              const fileHeadingPattern = new RegExp(
                `^[ \\t]*(?:#{1,6}[ \\t]*)?(?:[-*•][ \\t]*)?(?:\\*{1,2}|_{1,2}|\`)?[ \\t]*(?:(?:\\d+\\.|File(?:\\s+\\d+)?:?)[ \\t]*)?(?:\\*{1,2}|_{1,2}|\`)?[ \\t]*${this.escapeRegex(s.fileName)}[ \\t]*(?:\\*{1,2}|_{1,2}|\`)?(?:[ \\t]*:[ \\t]*)?(?:\\*{1,2}|_{1,2}|\`)?(?:[ \\t]*:[ \\t]*)?`,
                'i'
              );
              const cleanWhatChanged = s.whatChanged.replace(fileHeadingPattern, '').trim();
              const cleanReasons = s.possibleReasons.replace(fileHeadingPattern, '').trim();
              return `
          <div class="per-file-card">
            <div class="per-file-header">
              <span class="per-file-name">${this.escapeHtml(s.fileName)}</span>
              <span class="per-file-path">${this.escapeHtml(s.filePath || s.fileName)}</span>
            </div>
            <div class="per-file-field">
              <span class="field-label">What Changed:</span>
              <div>${this.escapeHtml(cleanWhatChanged || s.whatChanged)}</div>
            </div>
            <div class="per-file-field" style="margin-top: 6px;">
              <span class="field-label">Possible Reasons:</span>
              <div>${this.renderClassifiedReasons(cleanReasons || s.possibleReasons)}</div>
            </div>
          </div>`;
            }
          )
          .join('')}
      </div>`;
  }

  private static renderMultiFileSupportingCommits(result: MultiFileHistoryResult): string {
    const allCommits: CommitInfo[] = [];
    const seenHashes = new Set<string>();
    for (const f of result.evidence.files) {
      for (const c of f.commits) {
        if (!seenHashes.has(c.hash)) {
          seenHashes.add(c.hash);
          allCommits.push(c);
        }
      }
    }

    if (allCommits.length === 0) {
      return '<div class="card" style="color: var(--subtle); font-size: 12px;">No commits found in Git history for selected files.</div>';
    }

    const rows = allCommits
      .map(
        (c) => `
        <div class="commit-row">
          <code class="commit-hash">${this.escapeHtml(c.shortHash)}</code>
          <span class="commit-subject">${this.escapeHtml(c.subject)}</span>
        </div>`
      )
      .join('');

    return `<div class="card">${rows}</div>`;
  }

  private static renderMultiFileUncertainty(result: MultiFileHistoryResult): string {
    const exp = result.explanation;
    const text = exp?.uncertainty;

    if (!text && !result.isMixedRepositories) {
      return '';
    }

    const mixedNotice = result.isMixedRepositories
      ? '<div style="margin-bottom: 6px; color: var(--warning-fg); font-weight: 600;">Note: Selected files belong to different Git repositories. Cross-file relationships cannot be established through Git commit history alone.</div>'
      : '';

    return `
      <section class="main-section">
        <div class="section-title">
          <span>Uncertainty & Evidence Limitations</span>
        </div>
        <div class="card" style="border-left: 3px solid var(--warning-fg); font-size: 12.5px; line-height: 1.5;">
          ${mixedNotice}
          ${text ? `<div>${this.escapeHtml(text)}</div>` : ''}
        </div>
      </section>`;
  }

  private static renderMultiFileDiffEvidence(result: MultiFileHistoryResult): string {
    const hasFiles = result.evidence.files.length > 0;
    if (!hasFiles) {
      return '<div style="color: var(--subtle); font-size: 12px;">No Git evidence available.</div>';
    }

    const seenDiffFiles = new Set<string>();
    const uniqueEvidenceFiles = result.evidence.files.filter((f) => {
      const key = (f.file.filePath || f.file.fileName).toLowerCase();
      if (seenDiffFiles.has(key)) return false;
      seenDiffFiles.add(key);
      return true;
    });

    return uniqueEvidenceFiles
      .map((f) => {
        let diffContent = '';
        if (f.hasUncommittedChanges && f.uncommittedDiff) {
          diffContent = this.renderDiff(f.uncommittedDiff);
        } else if (f.commits.length > 0 && f.commits[0].diff) {
          diffContent = this.renderDiff(f.commits[0].diff);
        } else {
          diffContent = '<span class="diff-line meta">(No diff content available)</span>';
        }

        return `
        <details class="collapsible-section">
          <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
            <span class="summary-title">${this.escapeHtml(f.file.fileName)}</span>
            <span class="summary-subtext">${f.commits.length} commit${f.commits.length === 1 ? '' : 's'}${f.hasUncommittedChanges ? ' + uncommitted' : ''}</span>
            <span class="badge badge-meta collapse-badge" aria-hidden="true" style="margin-left: 8px;"></span>
          </summary>
          <div class="collapsible-content">
            <div class="file-diff-card">
              <div class="file-diff-header">
                <span>${this.escapeHtml(f.file.relativeFilePath || f.file.filePath)}</span>
                <span class="badge badge-neutral">${f.file.repoRoot ? 'Git Tracked' : 'External'}</span>
              </div>
              <pre class="diff-block">${diffContent}</pre>
            </div>
          </div>
        </details>`;
      })
      .join('');
  }

  private static renderMultiFileDiagnostics(result: MultiFileHistoryResult): string {
    const diag = result.explanationDiagnostics;
    const exp = result.explanation;

    const seenCommitHashes = new Set<string>();
    for (const f of result.evidence.files) {
      for (const c of f.commits) {
        seenCommitHashes.add(c.hash);
      }
    }

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Total Files Requested', value: String(result.totalReceived) },
      { label: 'Eligible Files Analyzed', value: String(result.eligibleFiles.length) },
      { label: 'Total Commits Found', value: String(result.evidence.totalCommits) },
      { label: 'Unique Commits', value: String(seenCommitHashes.size) },
      { label: 'Cross-Repository', value: result.isMixedRepositories ? 'Yes (Multiple Repos)' : 'No (Single Repo)' }
    ];

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
        </tr>`
      )
      .join('');

    return `
      <details class="collapsible-section">
        <summary class="collapsible-summary" role="button" aria-expanded="false" tabindex="0">
          <span class="summary-title">Technical Diagnostics & Copilot Telemetry</span>
          <span class="badge badge-meta collapse-badge" aria-hidden="true"></span>
        </summary>
        <div class="collapsible-content">
          <table class="diag-table">
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </details>`;
  }

  public static renderReviewerHtml(result: ReviewerResult): string {
    const logoHtml = this.getOriginxLogoHtml(26);

    let providerLabel = 'Local Git Only';
    let providerBadgeClass = 'badge-neutral';

    if (result.explanation) {
      providerLabel = `VS Code LM (${this.escapeHtml(result.explanation.model || 'copilot')})`;
      providerBadgeClass = 'badge-provider-vscode';
    } else if (result.explanationStatus === 'disabled') {
      providerLabel = 'AI Review Disabled (Default)';
      providerBadgeClass = 'badge-neutral';
    } else if (result.explanationStatus === 'no_model') {
      providerLabel = 'VS Code LM Unavailable';
      providerBadgeClass = 'badge-warning';
    } else if (result.explanationStatus === 'blocked_security') {
      providerLabel = 'Security Blocked';
      providerBadgeClass = 'badge-error';
    }

    const durationBadge = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';

    if (result.status === 'no_changes') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Review Working Tree</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, rgba(127,127,127,0.06));
      --card-border: var(--vscode-widget-border, rgba(127,127,127,0.2));
      --subtle: var(--vscode-descriptionForeground, rgba(127,127,127,0.8));
    }
    body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); padding: 20px; line-height: 1.5; }
    .header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .empty-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 24px; text-align: center; }
    .empty-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; color: var(--fg); }
    .empty-desc { color: var(--subtle); font-size: 13px; max-width: 480px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    <h2 style="margin:0; font-size:16px;">GitWhisper Code Reviewer</h2>
  </div>
  <div class="empty-card">
    <div class="empty-title">Working Tree Clean</div>
    <div class="empty-desc">No staged, unstaged, or untracked changes were detected in the active Git repository. Make some code edits and run this command again to review your changes.</div>
  </div>
</body>
</html>`;
    }

    if (result.status === 'not_a_repo') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitWhisper: Review Working Tree</title>
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    .empty-card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="empty-card">
    <h3>Not a Git Repository</h3>
    <p>Please open a folder or workspace that contains a Git repository.</p>
  </div>
</body>
</html>`;
    }

    // Identify un-modified companions vs modified companions
    const unModifiedCompanions = result.relatedFilesWorthInspecting.filter((r) => !r.isCurrentlyChanged);
    const modifiedCompanions = result.relatedFilesWorthInspecting.filter((r) => r.isCurrentlyChanged);

    // Render Checklist
    let checklistHtml = '';
    if (result.explanation && result.explanation.reviewChecklist && result.explanation.reviewChecklist.length > 0) {
      checklistHtml = `
        <div class="review-subcard">
          <div class="subcard-title">Actionable Review Checklist</div>
          <ul class="checklist-items">
            ${result.explanation.reviewChecklist
              .map((item) => `<li><label class="check-item"><input type="checkbox"> <span>${this.escapeHtml(item)}</span></label></li>`)
              .join('')}
          </ul>
        </div>`;
    }

    // Render Co-Change Panel
    let coChangeContentHtml = '';
    if (result.relatedFilesWorthInspecting.length === 0) {
      coChangeContentHtml = `
        <div class="notice-box">
          <strong>No historical co-changes identified in Neo4j.</strong>
          <p>Files in this change were historically modified independently, or have not yet been ingested into the repository knowledge graph.</p>
        </div>`;
    } else {
      let unModifiedCards = '';
      if (unModifiedCompanions.length > 0) {
        unModifiedCards = `
          <div class="cochange-group-title">
            <span class="cochange-alert-pill">Blast Radius Alert</span>
            Related Files Worth Inspecting (${unModifiedCompanions.length} not modified in this change)
          </div>
          <p class="section-subtext">These companion files frequently co-changed with your modified files in previous commits. Verify that tightly-coupled logic or tests were not overlooked.</p>
          <div class="cochange-list">
            ${unModifiedCompanions.map((r) => `
              <div class="cochange-card alert-border">
                <div class="cochange-card-header">
                  <span class="cochange-path">${this.escapeHtml(r.filePath)}</span>
                  <span class="badge badge-warning">Not Modified</span>
                </div>
                <div class="cochange-meta">
                  <span>Historically coupled with: <strong>${this.escapeHtml(r.historicallyCoupledWith.join(', '))}</strong></span>
                  <span class="badge badge-meta">Shared Commits: ${r.sharedCommitCount}</span>
                </div>
                ${r.sampleCommitHashes.length > 0 ? `
                  <div class="cochange-hashes">
                    <span class="meta-label">Supporting Commits:</span>
                    ${r.sampleCommitHashes.slice(0, 4).map((h) => `<span class="hash-pill">${this.escapeHtml(h)}</span>`).join(' ')}
                  </div>` : ''}
              </div>`).join('')}
          </div>`;
      }

      let modifiedCards = '';
      if (modifiedCompanions.length > 0) {
        modifiedCards = `
          <div class="cochange-group-title" style="margin-top: 20px;">
            Companion Files Already Included in This Change (${modifiedCompanions.length})
          </div>
          <div class="cochange-list">
            ${modifiedCompanions.map((r) => `
              <div class="cochange-card">
                <div class="cochange-card-header">
                  <span class="cochange-path">${this.escapeHtml(r.filePath)}</span>
                  <span class="badge badge-success">Included</span>
                </div>
                <div class="cochange-meta">
                  <span>Shared with: <strong>${this.escapeHtml(r.historicallyCoupledWith.join(', '))}</strong></span>
                  <span class="badge badge-meta">Shared Commits: ${r.sharedCommitCount}</span>
                </div>
                ${r.sampleCommitHashes.length > 0 ? `
                  <div class="cochange-hashes">
                    <span class="meta-label">Supporting Commits:</span>
                    ${r.sampleCommitHashes.slice(0, 4).map((h) => `<span class="hash-pill">${this.escapeHtml(h)}</span>`).join(' ')}
                  </div>` : ''}
              </div>`).join('')}
          </div>`;
      }

      coChangeContentHtml = unModifiedCards + modifiedCards;
    }

    // Render Changed Files Cards
    const changedFilesHtml = result.changedFiles.map((f, idx) => {
      let statusBadge = '';
      if (f.status === 'staged') statusBadge = '<span class="badge badge-success">Staged</span>';
      else if (f.status === 'unstaged') statusBadge = '<span class="badge badge-warning">Unstaged</span>';
      else if (f.status === 'both') statusBadge = '<span class="badge badge-provider-vscode">Staged + Unstaged</span>';
      else if (f.status === 'untracked') statusBadge = '<span class="badge badge-neutral">Untracked</span>';

      return `
        <div class="file-card">
          <div class="file-card-header">
            <span class="file-index">#${idx + 1}</span>
            <span class="file-path">${this.escapeHtml(f.filePath)}</span>
            ${statusBadge}
            <span class="badge badge-meta">${(f.diffCharCount / 1024).toFixed(1)} KB</span>
          </div>
          ${f.oldPath ? `<div class="file-rename">Renamed from: ${this.escapeHtml(f.oldPath)}</div>` : ''}
        </div>`;
    }).join('');

    // Render Diffs
    const diffsHtml = result.changedFiles.map((f, idx) => {
      return `
        <details class="diff-accordion" ${idx === 0 ? 'open' : ''}>
          <summary class="diff-summary">
            <span><strong>${this.escapeHtml(f.filePath)}</strong> (${f.status.toUpperCase()})</span>
            <span class="badge badge-meta">${(f.diffCharCount / 1024).toFixed(1)} KB</span>
          </summary>
          <div class="diff-content">
            <pre class="diff-pre"><code>${this.escapeHtml(f.diff || '(No diff content)')}</code></pre>
          </div>
        </details>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Review Working Tree Changes</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, rgba(127,127,127,0.06));
      --card-border: var(--vscode-widget-border, rgba(127,127,127,0.2));
      --subtle: var(--vscode-descriptionForeground, rgba(127,127,127,0.8));
      --accent: var(--vscode-textLink-foreground, #7c3aed);
      --badge-bg: var(--vscode-badge-background, rgba(127,127,127,0.2));
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px 20px 40px 20px;
      overflow-x: hidden;
      word-break: break-word;
    }
    .header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    .brand-title { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--fg); }
    .header-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; line-height: 1.3; }
    .badge-neutral { background: var(--badge-bg); color: var(--badge-fg); }
    .badge-provider-vscode { background: rgba(124, 58, 237, 0.16); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.35); }
    .badge-success { background: rgba(46, 160, 67, 0.18); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.35); }
    .badge-warning { background: rgba(210, 153, 34, 0.18); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.35); }
    .badge-error { background: rgba(248, 81, 73, 0.18); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.35); }
    .badge-meta { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--subtle); font-family: var(--font-mono); font-size: 10px; }

    .metric-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .metric-label { font-size: 11px; text-transform: uppercase; color: var(--subtle); font-weight: 600; letter-spacing: 0.5px; }
    .metric-value { font-size: 15px; font-weight: 700; color: var(--fg); }

    .nav-tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .tab-button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px 5px 0 0;
      color: var(--subtle);
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .tab-button:hover { color: var(--fg); background: rgba(127,127,127,0.08); }
    .tab-button.active {
      color: var(--fg);
      background: var(--card-bg);
      border-color: var(--card-border) var(--card-border) transparent var(--card-border);
      border-bottom: 2px solid #7c3aed;
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .review-subcard {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .subcard-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: var(--accent); margin-bottom: 8px; }
    .checklist-items { list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .check-item { display: inline-flex; align-items: flex-start; gap: 8px; cursor: pointer; }

    .cochange-group-title { font-size: 13px; font-weight: 700; margin-bottom: 4px; color: var(--fg); display: flex; align-items: center; gap: 8px; }
    .cochange-alert-pill { font-size: 10px; font-weight: 700; text-transform: uppercase; background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.4); padding: 1px 6px; border-radius: 10px; }
    .section-subtext { font-size: 12px; color: var(--subtle); margin-bottom: 10px; }
    .cochange-list { display: flex; flex-direction: column; gap: 8px; }
    .cochange-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px 14px; }
    .cochange-card.alert-border { border-left: 3px solid #d29922; }
    .cochange-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .cochange-path { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--fg); }
    .cochange-meta { font-size: 11px; color: var(--subtle); display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .cochange-hashes { font-size: 11px; color: var(--subtle); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .hash-pill { font-family: var(--font-mono); font-size: 10px; background: rgba(127,127,127,0.15); padding: 1px 5px; border-radius: 3px; }

    .file-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; }
    .file-card-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .file-index { font-size: 11px; color: var(--subtle); font-weight: 700; }
    .file-path { font-family: var(--font-mono); font-size: 12px; font-weight: 600; flex: 1; }
    .file-rename { font-size: 11px; color: var(--subtle); margin-top: 4px; }

    .diff-accordion { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
    .diff-summary { padding: 10px 14px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; font-family: var(--font-mono); font-size: 12px; user-select: none; }
    .diff-content { padding: 10px 14px; border-top: 1px solid var(--card-border); }
    .diff-pre { font-family: var(--font-mono); font-size: 11px; line-height: 1.4; overflow-x: auto; white-space: pre; background: rgba(0,0,0,0.15); padding: 10px; border-radius: 4px; }

    .notice-box { background: var(--card-bg); border: 1px dashed var(--card-border); border-radius: 6px; padding: 16px; color: var(--subtle); }
  </style>
</head>
<body>
  <div class="header-row">
    <div class="brand-title">
      ${logoHtml}
      <span>GitWhisper Code Reviewer</span>
    </div>
    <div class="header-badges">
      <span class="badge ${providerBadgeClass}">${providerLabel}</span>
      <span class="badge badge-meta">${this.escapeHtml(result.repoName || 'Repository')}</span>
      ${durationBadge ? `<span class="badge badge-meta">${durationBadge}</span>` : ''}
    </div>
  </div>

  <div class="metric-strip">
    <div class="metric-card">
      <span class="metric-label">Changed Files</span>
      <span class="metric-value">${result.totalChangedFiles} <span style="font-size:11px; font-weight:normal; color:var(--subtle);">(${result.stagedCount} staged, ${result.unstagedCount} unstaged, ${result.untrackedCount} untracked)</span></span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Diff Volume</span>
      <span class="metric-value">${(result.totalDiffChars / 1024).toFixed(1)} KB</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Blast Radius Warning</span>
      <span class="metric-value" style="color: ${unModifiedCompanions.length > 0 ? '#d29922' : 'var(--fg)'};">${unModifiedCompanions.length} un-modified companion(s)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Neo4j Provenance</span>
      <span class="metric-value">${result.neo4jStatus === 'ok' ? 'Connected' : result.neo4jStatus.toUpperCase()}</span>
    </div>
  </div>

  <nav class="nav-tabs" role="tablist">
    <button class="tab-button active" data-tab="rev-panel-review" role="tab">Review Summary</button>
    <button class="tab-button" data-tab="rev-panel-files" role="tab">Changed Files (${result.totalChangedFiles})</button>
    <button class="tab-button" data-tab="rev-panel-cochange" role="tab">Co-Change & Blast Radius (${result.relatedFilesWorthInspecting.length})</button>
    <button class="tab-button" data-tab="rev-panel-diffs" role="tab">Diffs (${result.totalChangedFiles})</button>
  </nav>

  <div id="rev-panel-review" class="tab-panel active" role="tabpanel">
    ${result.explanation ? `
      <div class="review-subcard">
        <div class="subcard-title">Executive Summary</div>
        <p>${this.escapeHtml(result.explanation.summary)}</p>
      </div>
      <div class="review-subcard">
        <div class="subcard-title">Architectural Impact & Blast Radius</div>
        <p>${this.escapeHtml(result.explanation.impactAnalysis)}</p>
      </div>
      ${result.explanation.relatedFilesGuidance ? `
        <div class="review-subcard">
          <div class="subcard-title">Related Files Guidance</div>
          <p>${this.escapeHtml(result.explanation.relatedFilesGuidance)}</p>
        </div>` : ''}
      ${checklistHtml}
      <div class="review-subcard">
        <div class="subcard-title">Uncertainty & Evidence Limitations</div>
        <p>${this.escapeHtml(result.explanation.uncertaintyNotes)}</p>
      </div>
    ` : `
      <div class="review-subcard">
        <div class="subcard-title">Local Git Review Mode</div>
        <p>Automatic AI analysis is disabled by default. GitWhisper has collected local working tree diffs and historical Neo4j co-change context without network transmission.</p>
        <p style="margin-top: 8px; color: var(--subtle);">To generate AI-powered review summaries with GitHub Copilot, enable Automatic AI Analysis in the ORIGINX Command Center.</p>
      </div>
      ${unModifiedCompanions.length > 0 ? `
        <div class="review-subcard" style="border-left: 3px solid #d29922;">
          <div class="subcard-title" style="color: #d29922;">Blast Radius Inspection Recommended</div>
          <p>Neo4j detected <strong>${unModifiedCompanions.length}</strong> companion file(s) that frequently co-changed with your modified files in past commits, but are NOT modified in this change. Inspect the <em>Co-Change & Blast Radius</em> tab to verify these dependencies.</p>
        </div>` : ''}
    `}
  </div>

  <div id="rev-panel-files" class="tab-panel" role="tabpanel">
    ${changedFilesHtml}
  </div>

  <div id="rev-panel-cochange" class="tab-panel" role="tabpanel">
    ${coChangeContentHtml}
  </div>

  <div id="rev-panel-diffs" class="tab-panel" role="tabpanel">
    ${diffsHtml}
  </div>

  <script>
    (function() {
      const tabs = document.querySelectorAll('.tab-button');
      const panels = document.querySelectorAll('.tab-panel');

      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const targetId = tab.getAttribute('data-tab');
          tabs.forEach(t => t.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));

          tab.classList.add('active');
          const activePanel = document.getElementById(targetId);
          if (activePanel) {
            activePanel.classList.add('active');
          }
        });
      });
    })();
  </script>
</body>
</html>`;
  }

  public static renderInvestigationHtml(result: InvestigationResult): string {
    const logoHtml = this.getOriginxLogoHtml(26);
    const req = result.request;
    const exp = result.explanation;
    const diagList = result.evidence?.diagnostics || [];
    const commits = result.evidence?.gitHistory?.commits || [];
    const coChanges = result.evidence?.coChangeEvidence || [];

    let providerLabel = 'Local Git Only';
    let providerBadgeClass = 'badge-neutral';

    if (exp) {
      providerLabel = `VS Code LM (${this.escapeHtml(exp.model || 'copilot')})`;
      providerBadgeClass = 'badge-provider-vscode';
    } else if (result.explanationStatus === 'disabled') {
      providerLabel = 'AI Investigation Disabled (Default)';
      providerBadgeClass = 'badge-neutral';
    } else if (result.explanationStatus === 'no_model') {
      providerLabel = 'VS Code LM Unavailable';
      providerBadgeClass = 'badge-warning';
    } else if (result.explanationStatus === 'blocked_security') {
      providerLabel = 'Security Blocked';
      providerBadgeClass = 'badge-error';
    } else if (result.explanationStatus === 'failed') {
      providerLabel = 'AI Failed (Local Mode)';
      providerBadgeClass = 'badge-warning';
    }

    const durationBadge = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';

    if (result.status === 'not_a_repo') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitWhisper: Investigate Bug</title>
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    .empty-card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="empty-card">
    <h3>File Outside Git Repository</h3>
    <p>The selected file is not inside a Git repository. GitWhisper requires Git history to investigate causality and historical co-changes.</p>
  </div>
</body>
</html>`;
    }

    if (result.status === 'untracked_file') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitWhisper: Investigate Bug</title>
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    .empty-card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="empty-card">
    <h3>Untracked File</h3>
    <p>The selected file is untracked and has no Git commits. Commit the file to Git to enable historical investigation.</p>
  </div>
</body>
</html>`;
    }

    const errCount = diagList.filter((d) => d.severity === 'error').length;
    const warnCount = diagList.filter((d) => d.severity === 'warning').length;
    const targetFileName = req?.fileName || 'Selected Code';
    const targetFilePath = req?.filePath || '';
    const startLine = req?.startLine || 1;
    const endLine = req?.endLine || 1;
    const totalLines = Math.max(1, endLine - startLine + 1);

    // Diagnostics cards
    let diagnosticsHtml = '<p class="subtle-text">No active VS Code compiler or linter diagnostics detected for this file.</p>';
    if (diagList.length > 0) {
      diagnosticsHtml = `<div class="diag-list">${diagList.map((d, i) => {
        let badgeClass = 'badge-neutral';
        if (d.severity === 'error') badgeClass = 'badge-error';
        else if (d.severity === 'warning') badgeClass = 'badge-warning';
        else if (d.severity === 'information') badgeClass = 'badge-provider-vscode';

        const overlapBadge = d.overlapsSelection
          ? '<span class="badge badge-success">Overlaps Selection</span>'
          : '<span class="badge badge-meta">File Level</span>';
        const sourceInfo = d.source ? `${this.escapeHtml(d.source)}${d.code ? `:${this.escapeHtml(String(d.code))}` : ''}` : '';

        const rangeStr = d.range
          ? `Lines ${d.range.startLine ?? 1}:${d.range.startCharacter ?? 0}–${d.range.endLine ?? 1}:${d.range.endCharacter ?? 0}`
          : '';

        return `
          <div class="diag-card">
            <div class="diag-card-header">
              <span class="badge ${badgeClass}">${this.escapeHtml(d.severity ? d.severity.toUpperCase() : 'ISSUE')}</span>
              ${sourceInfo ? `<span class="badge badge-meta">${sourceInfo}</span>` : ''}
              ${overlapBadge}
              ${rangeStr ? `<span class="meta-label" style="margin-left: auto;">${this.escapeHtml(rangeStr)}</span>` : ''}
            </div>
            <div class="diag-message">${this.escapeHtml(d.message || '')}</div>
          </div>`;
      }).join('')}</div>`;
    }

    // Co-change companion cards
    let coChangeHtml = '<p class="subtle-text">No Neo4j co-change companion files found for this file (Neo4j may be offline or no shared commits recorded).</p>';
    if (coChanges.length > 0) {
      coChangeHtml = `<div class="cochange-list">${coChanges.map((co: any) => {
        const changedTag = co.isCurrentlyChanged
          ? '<span class="badge badge-warning">Currently Modified</span>'
          : '<span class="badge badge-provider-vscode">Coupled Companion</span>';
        const sampleHashes = Array.isArray(co.sampleCommitHashes) ? co.sampleCommitHashes : [];
        const hashes = sampleHashes.length > 0
          ? `<div class="cochange-hashes"><span class="meta-label">Supporting Commits:</span> ${sampleHashes.slice(0, 4).map((h: any) => `<span class="hash-pill">${this.escapeHtml(h)}</span>`).join(' ')}</div>`
          : '';
        const coupledWith = Array.isArray(co.historicallyCoupledWith)
          ? co.historicallyCoupledWith.join(', ')
          : (co.historicallyCoupledWith || targetFileName);

        return `
          <div class="cochange-card">
            <div class="cochange-card-header">
              <span class="cochange-path">${this.escapeHtml(co.filePath || co.fileName || '')}</span>
              ${changedTag}
              <span class="badge badge-meta" style="margin-left: auto;">${this.escapeHtml(String(co.sharedCommitCount ?? 1))} shared commit(s)</span>
            </div>
            <div class="cochange-meta">Historically coupled with: <strong>${this.escapeHtml(coupledWith)}</strong></div>
            ${hashes}
          </div>`;
      }).join('')}</div>`;
    }

    // Git commits list
    let commitsHtml = '<p class="subtle-text">No Git commits found for the selected lines.</p>';
    if (commits.length > 0) {
      commitsHtml = `<div class="commit-list">${commits.map((c: any) => {
        return `
          <div class="commit-card">
            <div class="commit-card-header">
              <span class="hash-pill">${this.escapeHtml(c.shortHash)}</span>
              <span class="commit-subject">${this.escapeHtml(c.subject)}</span>
            </div>
            <div class="commit-meta">
              <span>Author: <strong>${this.escapeHtml(c.authorName)}</strong> &lt;${this.escapeHtml(c.authorEmail)}&gt;</span>
              <span>Date: ${this.escapeHtml(c.date)}</span>
            </div>
            ${c.body ? `<div class="commit-body">${this.escapeHtml(c.body)}</div>` : ''}
          </div>`;
      }).join('')}</div>`;
    }

    // Diffs html
    let diffsHtml = '<p class="subtle-text">No diff hunks available for the selected lines.</p>';
    if (commits.some((c: any) => c.diff)) {
      diffsHtml = commits
        .filter((c: any) => c.diff)
        .map((c: any, idx: number) => {
          return `
            <details class="diff-accordion" ${idx === 0 ? 'open' : ''}>
              <summary class="diff-summary">
                <span><strong>${this.escapeHtml(c.shortHash)}</strong>: ${this.escapeHtml(c.subject)}</span>
                <span class="badge badge-meta">${this.escapeHtml(c.date)}</span>
              </summary>
              <div class="diff-content">
                <pre class="diff-pre"><code>${this.escapeHtml(c.diff || '(No diff content)')}</code></pre>
              </div>
            </details>`;
        })
        .join('');
    }

    // Minimal Suggested Fix section
    const fix = exp?.minimalSuggestedFix || {
      code: '// [UNVERIFIED - SUGGESTED FIX]\n// No automated patch generated. Review the observed facts and investigation steps.',
      explanation: 'No patch was generated by the language model.',
      isVerified: false
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Investigate Bug</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, rgba(127,127,127,0.06));
      --card-border: var(--vscode-widget-border, rgba(127,127,127,0.2));
      --subtle: var(--vscode-descriptionForeground, rgba(127,127,127,0.8));
      --accent: var(--vscode-textLink-foreground, #7c3aed);
      --badge-bg: var(--vscode-badge-background, rgba(127,127,127,0.2));
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px 20px 40px 20px;
      overflow-x: hidden;
      word-break: break-word;
    }
    .header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    .brand-title { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--fg); }
    .header-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; line-height: 1.3; }
    .badge-neutral { background: var(--badge-bg); color: var(--badge-fg); }
    .badge-provider-vscode { background: rgba(124, 58, 237, 0.16); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.35); }
    .badge-success { background: rgba(46, 160, 67, 0.18); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.35); }
    .badge-warning { background: rgba(210, 153, 34, 0.18); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.35); }
    .badge-error { background: rgba(248, 81, 73, 0.18); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.35); }
    .badge-meta { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--subtle); font-family: var(--font-mono); font-size: 10px; }

    .target-bar {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
    }
    .target-path { font-family: var(--font-mono); font-weight: 600; color: var(--accent); }

    .symptom-card {
      background: rgba(210, 153, 34, 0.08);
      border: 1px solid rgba(210, 153, 34, 0.3);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
    }
    .symptom-header { margin-bottom: 6px; }
    .symptom-body { font-family: var(--font-mono); font-size: 12px; color: var(--fg); white-space: pre-wrap; }

    .metric-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .metric-label { font-size: 11px; text-transform: uppercase; color: var(--subtle); font-weight: 600; letter-spacing: 0.5px; }
    .metric-value { font-size: 15px; font-weight: 700; color: var(--fg); }

    .nav-tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .tab-button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px 5px 0 0;
      color: var(--subtle);
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .tab-button:hover { color: var(--fg); background: var(--card-bg); }
    .tab-button.active {
      color: var(--fg);
      background: var(--card-bg);
      border-color: var(--card-border) var(--card-border) var(--bg);
      border-bottom: 2px solid var(--accent);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--fg);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .bullet-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .bullet-item { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; }
    .bullet-icon { color: var(--accent); font-weight: 700; }

    .unverified-banner {
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid rgba(248, 81, 73, 0.35);
      border-radius: 6px;
      padding: 12px 14px;
      margin-bottom: 14px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .code-container {
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 11px;
      font-weight: 600;
      color: var(--subtle);
    }
    .copy-btn {
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .copy-btn:hover { opacity: 0.9; }
    .code-pre {
      padding: 12px;
      margin: 0;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .fix-explanation { font-size: 13px; color: var(--fg); line-height: 1.5; }

    .diag-list, .cochange-list, .commit-list { display: flex; flex-direction: column; gap: 8px; }
    .diag-card, .cochange-card, .commit-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .diag-card-header, .cochange-card-header, .commit-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .diag-message { font-size: 12px; color: var(--fg); }
    .cochange-path { font-family: var(--font-mono); font-weight: 600; font-size: 12px; color: var(--fg); }
    .cochange-meta, .commit-meta { font-size: 11px; color: var(--subtle); display: flex; gap: 12px; flex-wrap: wrap; }
    .cochange-hashes { margin-top: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .hash-pill {
      font-family: var(--font-mono);
      font-size: 10px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 1px 6px;
      border-radius: 3px;
      color: var(--accent);
    }
    .commit-subject { font-weight: 600; font-size: 12px; color: var(--fg); }
    .commit-body { font-size: 11px; color: var(--subtle); margin-top: 4px; white-space: pre-wrap; }

    .diff-accordion {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .diff-summary {
      padding: 8px 12px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card-bg);
      user-select: none;
    }
    .diff-content { padding: 10px; border-top: 1px solid var(--card-border); background: rgba(0,0,0,0.2); }
    .diff-pre { margin: 0; font-family: var(--font-mono); font-size: 11px; overflow-x: auto; white-space: pre; }
    .subtle-text { color: var(--subtle); font-size: 12px; font-style: italic; }
  </style>
</head>
<body>
  <div class="header-row">
    <div class="brand-title">
      ${logoHtml}
      <span>GitWhisper: Investigate Bug</span>
    </div>
    <div class="header-badges">
      <span class="badge ${providerBadgeClass}">${providerLabel}</span>
      ${diagList.length > 0 ? `<span class="badge ${errCount > 0 ? 'badge-error' : 'badge-warning'}">${diagList.length} Diagnostic(s)</span>` : ''}
      <span class="badge badge-meta">${commits.length} Commit(s)</span>
      <span class="badge badge-meta">Neo4j: ${result.evidence?.neo4jStatus || 'disabled'}</span>
      ${durationBadge ? `<span class="badge badge-meta">${durationBadge}</span>` : ''}
    </div>
  </div>

  <div class="target-bar">
    <div>Target: <span class="target-path">${this.escapeHtml(targetFilePath)}</span></div>
    <div>Lines: <strong>${startLine}–${endLine}</strong> (${totalLines} line(s))</div>
  </div>

  ${req?.userErrorMessage ? `
    <div class="symptom-card">
      <div class="symptom-header">
        <span class="badge badge-warning">Reported Error / Symptom</span>
      </div>
      <div class="symptom-body">${this.escapeHtml(req.userErrorMessage)}</div>
    </div>` : ''}

  <div class="metric-strip">
    <div class="metric-card">
      <span class="metric-label">Compiler Diagnostics</span>
      <span class="metric-value">${diagList.length} (${errCount} err, ${warnCount} warn)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Git Commits On Lines</span>
      <span class="metric-value">${commits.length} commit(s)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Neo4j Co-Changes</span>
      <span class="metric-value">${coChanges.length} coupled file(s)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Analysis Mode</span>
      <span class="metric-value" style="font-size: 12px;">${exp ? 'Copilot + Graph' : 'Local Evidence'}</span>
    </div>
  </div>

  <div class="nav-tabs">
    <button class="tab-button active" data-tab="tab-analysis">Analysis &amp; Hypotheses</button>
    <button class="tab-button" data-tab="tab-plan">Investigation Plan</button>
    <button class="tab-button" data-tab="tab-fix">Suggested Fix</button>
    <button class="tab-button" data-tab="tab-evidence">Diagnostics &amp; Evidence (${diagList.length + coChanges.length})</button>
    <button class="tab-button" data-tab="tab-diffs">Git Diffs (${commits.length})</button>
  </div>

  <!-- TAB 1: Analysis & Hypotheses -->
  <div id="tab-analysis" class="tab-panel active">
    <div class="section-card">
      <div class="section-title">1. Observed Facts</div>
      <div style="font-size: 13px; line-height: 1.5; color: var(--fg); white-space: pre-wrap;">${this.escapeHtml(exp?.observedFacts || 'Observed facts based on static code, diagnostics, and Git history.')}</div>
    </div>

    <div class="section-card">
      <div class="section-title">2. Plausible Root-Cause Hypotheses</div>
      <ul class="bullet-list">
        ${(exp?.rootCauseHypotheses || ['Review compiler diagnostics and recent commit diffs for potential logic errors.']).map((h) => `
          <li class="bullet-item">
            <span class="bullet-icon">&#x2022;</span>
            <span>${this.escapeHtml(h)}</span>
          </li>`).join('')}
      </ul>
    </div>

    ${exp?.relatedFiles && exp.relatedFiles.length > 0 ? `
      <div class="section-card">
        <div class="section-title">Related Files Worth Inspecting</div>
        <ul class="bullet-list">
          ${exp.relatedFiles.map((rf) => `
            <li class="bullet-item">
              <span class="bullet-icon">&#x2192;</span>
              <span><strong>${this.escapeHtml(rf.filePath)}</strong>: ${this.escapeHtml(rf.reason)}</span>
            </li>`).join('')}
        </ul>
      </div>` : ''}

    <div class="section-card">
      <div class="section-title">Uncertainties &amp; Limitations</div>
      <ul class="bullet-list">
        ${(exp?.uncertainties || ['Static analysis only. Verify with runtime execution and reproduction steps.']).map((u) => `
          <li class="bullet-item">
            <span class="bullet-icon">&#x25CB;</span>
            <span style="color: var(--subtle);">${this.escapeHtml(u)}</span>
          </li>`).join('')}
      </ul>
    </div>
  </div>

  <!-- TAB 2: Investigation Plan -->
  <div id="tab-plan" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Proposed Investigation Steps</div>
      <ul class="bullet-list">
        ${(exp?.investigationSteps || ['Set a breakpoint on the target line.', 'Inspect variable values during reproduction.']).map((step, idx) => `
          <li class="bullet-item">
            <span class="bullet-icon">${idx + 1}.</span>
            <span>${this.escapeHtml(step)}</span>
          </li>`).join('')}
      </ul>
    </div>

    <div class="section-card">
      <div class="section-title">Relevant Tests to Run</div>
      <ul class="bullet-list">
        ${(exp?.relevantTests || ['Run existing test suites.', 'Add an edge-case test covering this scenario.']).map((t) => `
          <li class="bullet-item">
            <span class="bullet-icon">&#x2713;</span>
            <span>${this.escapeHtml(t)}</span>
          </li>`).join('')}
      </ul>
    </div>
  </div>

  <!-- TAB 3: Suggested Fix -->
  <div id="tab-fix" class="tab-panel">
    <div class="unverified-banner">
      <span class="badge badge-error">[UNVERIFIED - SUGGESTED FIX]</span>
      <span>This minimal patch is an <strong>advisory suggestion</strong> generated from Git &amp; Neo4j context. It has NOT been automatically executed or tested. Always review and verify before applying.</span>
    </div>

    <div class="code-container">
      <div class="code-header">
        <span>Suggested Patch</span>
        <button class="copy-btn" id="copy-btn">Copy Fix</button>
      </div>
      <pre class="code-pre"><code id="fix-code-block">${this.escapeHtml(fix.code)}</code></pre>
    </div>

    <div class="section-card">
      <div class="section-title">Explanation &amp; Assumptions</div>
      <div class="fix-explanation">${this.escapeHtml(fix.explanation)}</div>
    </div>
  </div>

  <!-- TAB 4: Diagnostics & Evidence -->
  <div id="tab-evidence" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Active VS Code Diagnostics (${diagList.length})</div>
      ${diagnosticsHtml}
    </div>

    <div class="section-card">
      <div class="section-title">Neo4j Co-Changed Companion Files (${coChanges.length})</div>
      ${coChangeHtml}
    </div>

    <div class="section-card">
      <div class="section-title">Git Blame Commits On Selection (${commits.length})</div>
      ${commitsHtml}
    </div>
  </div>

  <!-- TAB 5: Git Diffs -->
  <div id="tab-diffs" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Diff Hunks for Selected Lines (${commits.length})</div>
      ${diffsHtml}
    </div>
  </div>

  <script>
    (function() {
      const tabs = document.querySelectorAll('.tab-button');
      const panels = document.querySelectorAll('.tab-panel');

      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const targetId = tab.getAttribute('data-tab');
          tabs.forEach(t => t.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));

          tab.classList.add('active');
          const activePanel = document.getElementById(targetId);
          if (activePanel) {
            activePanel.classList.add('active');
          }
        });
      });

      const copyBtn = document.getElementById('copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const codeEl = document.getElementById('fix-code-block');
          if (codeEl) {
            navigator.clipboard.writeText(codeEl.innerText).then(() => {
              copyBtn.textContent = 'Copied!';
              setTimeout(() => { copyBtn.textContent = 'Copy Fix'; }, 2000);
            });
          }
        });
      }
    })();
  </script>
</body>
</html>`;
  }

  public static renderUnifiedAnalysisHtml(result: UnifiedAnalysisResult): string {
    const logoHtml = this.getOriginxLogoHtml(26);
    const req = result?.request;
    const exp = result?.explanation;
    const diagList = result?.evidence?.diagnostics || [];
    const commits = result?.evidence?.gitHistory?.commits || [];
    const coChanges = result?.evidence?.neo4jCoChanges || [];
    const neo4jCommits = result?.evidence?.neo4jFileEvidence || [];
    const isWorkingTreeMod = result?.evidence?.isWorkingTreeModified || false;

    const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    let providerLabel = 'Local Git Only';
    let providerBadgeClass = 'badge-neutral';

    if (exp) {
      providerLabel = `VS Code LM (${this.escapeHtml(exp.model || 'copilot')})`;
      providerBadgeClass = 'badge-provider-vscode';
    } else if (result?.explanationStatus === 'disabled') {
      providerLabel = 'AI Analysis Disabled (Default)';
      providerBadgeClass = 'badge-neutral';
    } else if (result?.explanationStatus === 'no_model') {
      providerLabel = 'VS Code LM Unavailable';
      providerBadgeClass = 'badge-warning';
    } else if (result?.explanationStatus === 'blocked_security') {
      providerLabel = 'Security Blocked';
      providerBadgeClass = 'badge-error';
    } else if (result?.explanationStatus === 'failed') {
      providerLabel = 'AI Failed (Local Mode)';
      providerBadgeClass = 'badge-warning';
    }

    const durationBadge = result?.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';

    if (result?.status === 'not_a_repo') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Analyze Code</title>
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    .empty-card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="empty-card">
    <h3>File Outside Git Repository</h3>
    <p>The selected file is not inside a Git repository. GitWhisper requires Git history to analyze code causality and historical evolution.</p>
  </div>
</body>
</html>`;
    }

    if (result?.status === 'untracked_file') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Analyze Code</title>
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    .empty-card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="empty-card">
    <h3>Untracked File</h3>
    <p>The selected file is untracked and has no Git commits. Commit the file to Git to enable historical analysis.</p>
  </div>
</body>
</html>`;
    }

    const errCount = Array.isArray(diagList) ? diagList.filter((d: any) => d && d.severity === 'error').length : 0;
    const warnCount = Array.isArray(diagList) ? diagList.filter((d: any) => d && d.severity === 'warning').length : 0;
    const targetFileName = req?.fileName || 'Selected Code';
    const targetFilePath = req?.filePath || '';
    const startLine = req?.startLine || 1;
    const endLine = req?.endLine || 1;
    const totalLines = Math.max(1, endLine - startLine + 1);

    // Diagnostics section html
    let diagnosticsHtml = `
      <div class="clean-card">
        <span class="badge badge-success" style="margin-bottom: 6px;">Clean State</span>
        <div style="font-weight: 600; font-size: 13px;">No compiler diagnostics or reported bugs detected for this selection.</div>
        <div class="subtle-text" style="margin-top: 4px;">Language server reports zero errors, warnings, or active diagnostic issues on the selected lines.</div>
      </div>`;

    if (Array.isArray(diagList) && diagList.length > 0) {
      diagnosticsHtml = `<div class="diag-list">${diagList.map((d: any) => {
        let badgeClass = 'badge-neutral';
        const severity = d?.severity || 'warning';
        if (severity === 'error') badgeClass = 'badge-error';
        else if (severity === 'warning') badgeClass = 'badge-warning';
        else if (severity === 'information') badgeClass = 'badge-provider-vscode';

        const overlapBadge = d?.overlapsSelection
          ? '<span class="badge badge-success">Overlaps Selection</span>'
          : '<span class="badge badge-meta">File Level</span>';
        const sourceInfo = d?.source ? `${this.escapeHtml(d.source)}${d?.code ? `:${this.escapeHtml(String(d.code))}` : ''}` : '';
        const rangeStr = d?.range
          ? `Lines ${d.range.startLine ?? 1}:${d.range.startCharacter ?? 0}–${d.range.endLine ?? 1}:${d.range.endCharacter ?? 0}`
          : '';

        return `
          <div class="diag-card">
            <div class="diag-card-header">
              <span class="badge ${badgeClass}">${this.escapeHtml(String(severity).toUpperCase())}</span>
              ${sourceInfo ? `<span class="badge badge-meta">${sourceInfo}</span>` : ''}
              ${overlapBadge}
              ${rangeStr ? `<span class="meta-label" style="margin-left: auto;">${this.escapeHtml(rangeStr)}</span>` : ''}
            </div>
            <div class="diag-message">${this.escapeHtml(d?.message || '')}</div>
          </div>`;
      }).join('')}</div>`;
    }

    // Co-change companion cards
    let coChangeHtml = '<p class="subtle-text">No Neo4j co-change companion files found for this file (Neo4j may be offline or no shared commits recorded).</p>';
    if (Array.isArray(coChanges) && coChanges.length > 0) {
      coChangeHtml = `<div class="cochange-list">${coChanges.map((co: any) => {
        const changedTag = co?.isCurrentlyChanged
          ? '<span class="badge badge-warning">Currently Modified</span>'
          : '<span class="badge badge-provider-vscode">Coupled Companion</span>';
        const sampleHashes = Array.isArray(co?.sampleCommitHashes) ? co.sampleCommitHashes : [];
        const hashes = sampleHashes.length > 0
          ? `<div class="cochange-hashes"><span class="meta-label">Supporting Commits:</span> ${sampleHashes.slice(0, 4).map((h: any) => `<span class="hash-pill">${this.escapeHtml(h)}</span>`).join(' ')}</div>`
          : '';
        const coupledWith = Array.isArray(co?.historicallyCoupledWith)
          ? co.historicallyCoupledWith.join(', ')
          : (co?.historicallyCoupledWith || targetFileName);
        const count = co?.sharedCommitCount ?? 1;

        return `
          <div class="cochange-card">
            <div class="cochange-card-header">
              <span class="cochange-path">${this.escapeHtml(co?.filePath || co?.fileName || '')}</span>
              ${changedTag}
              <span class="badge badge-meta" style="margin-left: auto;">${this.escapeHtml(String(count))} shared commit(s)</span>
            </div>
            <div class="cochange-meta">Historically coupled with: <strong>${this.escapeHtml(coupledWith)}</strong></div>
            ${hashes}
          </div>`;
      }).join('')}</div>`;
    }

    // Git commits list
    let commitsHtml = '<p class="subtle-text">No Git commits found for the selected lines.</p>';
    if (Array.isArray(commits) && commits.length > 0) {
      commitsHtml = `<div class="commit-list">${commits.map((c: any) => {
        const shortHash = c?.shortHash || (c?.hash ? String(c.hash).substring(0, 7) : 'commit');
        const subject = c?.subject || '(no subject)';
        const authorName = c?.authorName || c?.author || 'Unknown';
        const dateStr = c?.date || c?.committedAt || 'Unknown';
        return `
          <div class="commit-card">
            <div class="commit-card-header">
              <span class="hash-pill">${this.escapeHtml(shortHash)}</span>
              <span class="commit-subject">${this.escapeHtml(subject)}</span>
            </div>
            <div class="commit-meta">
              <span>Author: <strong>${this.escapeHtml(authorName)}</strong>${c?.authorEmail ? ` &lt;${this.escapeHtml(c.authorEmail)}&gt;` : ''}</span>
              <span>Date: ${this.escapeHtml(dateStr)}</span>
            </div>
            ${c?.body ? `<div class="commit-body">${this.escapeHtml(c.body)}</div>` : ''}
          </div>`;
      }).join('')}</div>`;
    }

    // Diffs html
    let diffsHtml = '<p class="subtle-text">No diff hunks available for the selected lines.</p>';
    if (Array.isArray(commits) && commits.some((c: any) => c && c.diff)) {
      diffsHtml = commits
        .filter((c: any) => c && c.diff)
        .map((c: any, idx: number) => {
          const shortHash = c?.shortHash || (c?.hash ? String(c.hash).substring(0, 7) : 'commit');
          const subject = c?.subject || '(no subject)';
          const dateStr = c?.date || c?.committedAt || '';
          return `
            <details class="diff-accordion" ${idx === 0 ? 'open' : ''}>
              <summary class="diff-summary">
                <span><strong>${this.escapeHtml(shortHash)}</strong>: ${this.escapeHtml(subject)}</span>
                ${dateStr ? `<span class="badge badge-meta">${this.escapeHtml(dateStr)}</span>` : ''}
              </summary>
              <div class="diff-content">
                <pre class="diff-pre"><code>${this.escapeHtml(c.diff || '(No diff content)')}</code></pre>
              </div>
            </details>`;
        })
        .join('');
    }

    // Suggestions & Fixes HTML
    let fixSectionHtml = `
      <div class="clean-card">
        <span class="badge badge-success" style="margin-bottom: 6px;">No Fixes Required</span>
        <div style="font-weight: 600; font-size: 13px;">Code selection is functional. No automated patches required.</div>
        <div class="subtle-text" style="margin-top: 4px;">No syntax or compiler diagnostics detected that warrant a corrective patch.</div>
      </div>`;

    if (exp?.suggestedImprovementsOrFixes) {
      const fix = exp.suggestedImprovementsOrFixes;
      const fixCode = fix?.code || '';
      const fixExpl = fix?.explanation || '';
      fixSectionHtml = `
        <div class="unverified-banner">
          <span class="badge badge-error">[UNVERIFIED - SUGGESTED FIX]</span>
          <span>This advisory suggestion is generated from Git &amp; diagnostic context. It has <strong>NOT</strong> been automatically executed or verified. Always test before applying.</span>
        </div>
        <div class="code-container">
          <div class="code-header">
            <span>Suggested Patch</span>
            <button class="copy-btn" id="unified-copy-btn">Copy Fix</button>
          </div>
          <pre class="code-pre"><code id="unified-fix-code">${this.escapeHtml(fixCode)}</code></pre>
        </div>
        <div class="section-card">
          <div class="section-title">Explanation &amp; Rationale</div>
          <div class="fix-explanation">${this.escapeHtml(fixExpl)}</div>
        </div>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-inline'; img-src data: https:;">
  <title>GitWhisper: Analyze Code</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, rgba(127,127,127,0.06));
      --card-border: var(--vscode-widget-border, rgba(127,127,127,0.2));
      --subtle: var(--vscode-descriptionForeground, rgba(127,127,127,0.8));
      --accent: var(--vscode-textLink-foreground, #7c3aed);
      --badge-bg: var(--vscode-badge-background, rgba(127,127,127,0.2));
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font-mono: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px 20px 40px 20px;
      overflow-x: hidden;
      word-break: break-word;
    }
    .header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    .brand-title { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--fg); }
    .header-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; line-height: 1.3; }
    .badge-neutral { background: var(--badge-bg); color: var(--badge-fg); }
    .badge-provider-vscode { background: rgba(124, 58, 237, 0.16); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.35); }
    .badge-success { background: rgba(46, 160, 67, 0.18); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.35); }
    .badge-warning { background: rgba(210, 153, 34, 0.18); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.35); }
    .badge-error { background: rgba(248, 81, 73, 0.18); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.35); }
    .badge-meta { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--subtle); font-family: var(--font-mono); font-size: 10px; }

    .target-bar {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
    }
    .target-path { font-family: var(--font-mono); font-weight: 600; color: var(--accent); }

    .metric-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .metric-label { font-size: 11px; text-transform: uppercase; color: var(--subtle); font-weight: 600; letter-spacing: 0.5px; }
    .metric-value { font-size: 15px; font-weight: 700; color: var(--fg); }

    .nav-tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .tab-button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px 5px 0 0;
      color: var(--subtle);
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .tab-button:hover { color: var(--fg); background: var(--card-bg); }
    .tab-button.active {
      color: var(--fg);
      background: var(--card-bg);
      border-color: var(--card-border) var(--card-border) var(--bg);
      border-bottom: 2px solid var(--accent);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .clean-card {
      background: rgba(46, 160, 67, 0.08);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 6px;
      padding: 16px;
      text-align: left;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--fg);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .bullet-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .bullet-item { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; }
    .bullet-icon { color: var(--accent); font-weight: 700; }

    .unverified-banner {
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid rgba(248, 81, 73, 0.35);
      border-radius: 6px;
      padding: 12px 14px;
      margin-bottom: 14px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .code-container {
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 11px;
      font-weight: 600;
      color: var(--subtle);
    }
    .copy-btn {
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .copy-btn:hover { opacity: 0.9; }
    .code-pre {
      padding: 12px;
      margin: 0;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .fix-explanation { font-size: 13px; color: var(--fg); line-height: 1.5; }

    .diag-list, .cochange-list, .commit-list { display: flex; flex-direction: column; gap: 8px; }
    .diag-card, .cochange-card, .commit-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .diag-card-header, .cochange-card-header, .commit-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .diag-message { font-size: 12px; color: var(--fg); }
    .cochange-path { font-family: var(--font-mono); font-weight: 600; font-size: 12px; color: var(--fg); }
    .cochange-meta, .commit-meta { font-size: 11px; color: var(--subtle); display: flex; gap: 12px; flex-wrap: wrap; }
    .cochange-hashes { margin-top: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .hash-pill {
      font-family: var(--font-mono);
      font-size: 10px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 1px 6px;
      border-radius: 3px;
      color: var(--accent);
    }
    .commit-subject { font-weight: 600; font-size: 12px; color: var(--fg); }
    .commit-body { font-size: 11px; color: var(--subtle); margin-top: 4px; white-space: pre-wrap; }

    .diff-accordion {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .diff-summary {
      padding: 8px 12px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card-bg);
      user-select: none;
    }
    .diff-content { padding: 10px; border-top: 1px solid var(--card-border); background: rgba(0,0,0,0.2); }
    .diff-pre { margin: 0; font-family: var(--font-mono); font-size: 11px; overflow-x: auto; white-space: pre; }
    .subtle-text { color: var(--subtle); font-size: 12px; font-style: italic; }
  </style>
</head>
<body>
  <div class="header-row">
    <div class="brand-title">
      ${logoHtml}
      <span>GitWhisper: Analyze Code</span>
    </div>
    <div class="header-badges">
      <span class="badge ${providerBadgeClass}">${providerLabel}</span>
      <span class="badge ${isWorkingTreeMod ? 'badge-warning' : 'badge-success'}">${isWorkingTreeMod ? 'Modified Locally' : 'Working Tree Clean'}</span>
      ${diagList.length > 0 ? `<span class="badge ${errCount > 0 ? 'badge-error' : 'badge-warning'}">${diagList.length} Diagnostic(s)</span>` : '<span class="badge badge-success">0 Diagnostics</span>'}
      <span class="badge badge-meta">${commits.length} Commit(s)</span>
      <span class="badge badge-meta">Neo4j: ${this.escapeHtml(result?.evidence?.neo4jStatus || 'disabled')}</span>
      ${durationBadge ? `<span class="badge badge-meta">${durationBadge}</span>` : ''}
    </div>
  </div>

  <div class="target-bar">
    <div>Target: <span class="target-path">${this.escapeHtml(targetFilePath)}</span></div>
    <div>Lines: <strong>${startLine}–${endLine}</strong> (${totalLines} line(s))</div>
  </div>

  <div class="metric-strip">
    <div class="metric-card">
      <span class="metric-label">Working Tree State</span>
      <span class="metric-value" style="font-size: 13px;">${isWorkingTreeMod ? 'Modified Uncommitted' : 'Clean / Committed'}</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Compiler Diagnostics</span>
      <span class="metric-value">${diagList.length} (${errCount} err, ${warnCount} warn)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Git Commits On Lines</span>
      <span class="metric-value">${commits.length} commit(s)</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Neo4j Co-Changes</span>
      <span class="metric-value">${coChanges.length} coupled file(s)</span>
    </div>
  </div>

  <div class="nav-tabs">
    <button class="tab-button active" data-tab="tab-overview">Overview</button>
    <button class="tab-button" data-tab="tab-history">History &amp; Evidence (${commits.length})</button>
    <button class="tab-button" data-tab="tab-bugs">Bugs &amp; Diagnostics (${diagList.length})</button>
    <button class="tab-button" data-tab="tab-related">Related Files &amp; Impact (${coChanges.length})</button>
    <button class="tab-button" data-tab="tab-fixes">Suggestions &amp; Fixes</button>
  </div>

  <!-- TAB 1: Overview -->
  <div id="tab-overview" class="tab-panel active">
    <div class="section-card">
      <div class="section-title">1. What This Code Does</div>
      <div style="font-size: 13px; line-height: 1.5; color: var(--fg); white-space: pre-wrap;">${this.escapeHtml(exp?.whatCodeDoes || 'Code selection analyzed.')}</div>
    </div>

    <div class="section-card">
      <div class="section-title">2. Historical Evolution &amp; Why It Changed</div>
      <div style="font-size: 13px; line-height: 1.5; color: var(--fg); white-space: pre-wrap;">${this.escapeHtml(exp?.whyChangedHistorically || 'Historical commit analysis.')}</div>
    </div>

    <div class="section-card">
      <div class="section-title">Uncertainties &amp; Limitations</div>
      <ul class="bullet-list">
        ${(Array.isArray(exp?.uncertaintiesAndLimitations) && exp.uncertaintiesAndLimitations.length > 0
          ? exp.uncertaintiesAndLimitations
          : ['Static analysis only. Verify with runtime execution.']).map((u: any) => `
          <li class="bullet-item">
            <span class="bullet-icon">&#x25CB;</span>
            <span style="color: var(--subtle);">${this.escapeHtml(u)}</span>
          </li>`).join('')}
      </ul>
    </div>
  </div>

  <!-- TAB 2: History & Evidence -->
  <div id="tab-history" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Git Blame Commits On Selection (${commits.length})</div>
      ${commitsHtml}
    </div>

    <div class="section-card">
      <div class="section-title">Diff Hunks for Selected Lines</div>
      ${diffsHtml}
    </div>

    ${Array.isArray(neo4jCommits) && neo4jCommits.length > 0 ? `
      <div class="section-card">
        <div class="section-title">Neo4j Knowledge Graph History (${neo4jCommits.length})</div>
        <div class="commit-list">
          ${neo4jCommits.map((c: any) => {
            const shortHash = c?.shortHash || (c?.commitHash ? String(c.commitHash).substring(0, 7) : 'commit');
            const subject = c?.subject || '(no subject)';
            const changeType = c?.changeType || 'MODIFIED';
            const author = c?.authorName || c?.author || 'Unknown';
            const dateStr = c?.committedAt || c?.date || 'Unknown';
            return `
            <div class="commit-card">
              <div class="commit-card-header">
                <span class="hash-pill">${this.escapeHtml(shortHash)}</span>
                <span class="commit-subject">${this.escapeHtml(subject)}</span>
                <span class="badge badge-meta" style="margin-left: auto;">${this.escapeHtml(changeType)}</span>
              </div>
              <div class="commit-meta">
                <span>Author: <strong>${this.escapeHtml(author)}</strong></span>
                <span>Date: ${this.escapeHtml(dateStr)}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}
  </div>

  <!-- TAB 3: Bugs & Diagnostics -->
  <div id="tab-bugs" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Compiler &amp; Linter Diagnostics (${diagList.length})</div>
      ${diagnosticsHtml}
    </div>

    ${exp?.diagnosticsAndIssues?.details && Array.isArray(exp.diagnosticsAndIssues.details) && exp.diagnosticsAndIssues.details.length > 0 ? `
      <div class="section-card">
        <div class="section-title">Potential Issues &amp; Inconsistencies</div>
        <ul class="bullet-list">
          ${exp.diagnosticsAndIssues.details.map((d: any) => `
            <li class="bullet-item">
              <span class="bullet-icon">&#x2022;</span>
              <span>${this.escapeHtml(d)}</span>
            </li>`).join('')}
        </ul>
      </div>` : ''}
  </div>

  <!-- TAB 4: Related Files & Impact -->
  <div id="tab-related" class="tab-panel">
    <div class="section-card">
      <div class="section-title">Neo4j Co-Changed Companion Files (${coChanges.length})</div>
      ${coChangeHtml}
    </div>

    ${exp?.relatedFilesAndImpact && Array.isArray(exp.relatedFilesAndImpact) && exp.relatedFilesAndImpact.length > 0 ? `
      <div class="section-card">
        <div class="section-title">Blast Radius &amp; Impact Analysis</div>
        <ul class="bullet-list">
          ${exp.relatedFilesAndImpact.map((rf: any) => `
            <li class="bullet-item">
              <span class="bullet-icon">&#x2192;</span>
              <span><strong>${this.escapeHtml(rf?.filePath || '')}</strong>: ${this.escapeHtml(rf?.reason || '')}</span>
            </li>`).join('')}
        </ul>
      </div>` : ''}
  </div>

  <!-- TAB 5: Suggestions & Fixes -->
  <div id="tab-fixes" class="tab-panel">
    ${fixSectionHtml}
  </div>

  <script nonce="${nonce}">
    (function() {
      const tabs = document.querySelectorAll('.tab-button');
      const panels = document.querySelectorAll('.tab-panel');

      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const targetId = tab.getAttribute('data-tab');
          tabs.forEach(t => t.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));

          tab.classList.add('active');
          const activePanel = document.getElementById(targetId);
          if (activePanel) {
            activePanel.classList.add('active');
          }
        });
      });

      const copyBtn = document.getElementById('unified-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const codeEl = document.getElementById('unified-fix-code');
          if (codeEl) {
            navigator.clipboard.writeText(codeEl.innerText).then(() => {
              copyBtn.textContent = 'Copied!';
              setTimeout(() => { copyBtn.textContent = 'Copy Fix'; }, 2000);
            });
          }
        });
      }
    })();
  </script>
</body>
</html>`;
  }

  public static renderErrorHtml(title: string, details: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      padding: 24px;
    }
    .error-card {
      background: var(--vscode-inputValidation-errorBackground, rgba(248,81,73,0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(248,81,73,0.4));
      border-radius: 8px;
      padding: 20px;
    }
    h3 { margin-bottom: 8px; color: #f85149; }
    p { margin-bottom: 12px; font-size: 13px; }
    pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 10px;
      background: rgba(0,0,0,0.25);
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-all;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="error-card">
    <h3>${this.escapeHtml(title)}</h3>
    <p>An unexpected error occurred while preparing this view. The analysis completed, but the visual template could not render.</p>
    <pre>${this.escapeHtml(details)}</pre>
  </div>
</body>
</html>`;
  }

  private static escapeHtml(text: any): string {
    if (text === null || text === undefined) {
      return '';
    }
    const str = typeof text === 'string' ? text : String(text);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
