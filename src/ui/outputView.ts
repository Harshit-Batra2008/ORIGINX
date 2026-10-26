import type * as vscode from 'vscode';
import { GitHistoryResult } from '../git/gitTypes';
import {
  formatAvailableVsCodeModels,
  ILanguageModelChat
} from '../lm/vscodeLmClient';
import { MigrationResult } from '../security/secretManager';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

export class OutputView {
  private static channel: vscode.OutputChannel | undefined;

  public static getChannel(): vscode.OutputChannel {
    if (!this.channel) {
      const vs = getVsCode();
      if (vs && vs.window && typeof vs.window.createOutputChannel === 'function') {
        this.channel = vs.window.createOutputChannel('ORIGINX: Why Was This Changed?');
      } else {
        this.channel = {
          name: 'ORIGINX: Why Was This Changed?',
          appendLine: (_value: string) => {},
          append: (_value: string) => {},
          clear: () => {},
          show: (_preserveFocus?: boolean) => {},
          hide: () => {},
          dispose: () => {},
          replace: (_value: string) => {}
        } as unknown as vscode.OutputChannel;
      }
    }
    return this.channel!;
  }

  public static logStartupDiagnostics(info: {
    startupTime: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    vscodeVersion: string;
    provider: string;
    automaticAnalysisEnabled: boolean;
  }): void {
    const channel = this.getChannel();
    channel.appendLine(`[ORIGINX Startup] Activated at ${info.startupTime}`);
    channel.appendLine(`[ORIGINX Startup] VS Code: ${info.vscodeVersion} | Node: ${info.nodeVersion} | Platform: ${info.platform} (${info.arch})`);
    channel.appendLine(`[ORIGINX Startup] Provider: ${info.provider} | Auto-Analysis: ${info.automaticAnalysisEnabled ? 'ENABLED' : 'DISABLED (default)'}`);
  }

  public static logMigrationStatus(migration: MigrationResult): void {
    const channel = this.getChannel();
    if (migration.migrated && migration.verifiedDeleted) {
      channel.appendLine('[ORIGINX Migration] Legacy Gemini SecretStorage credentials successfully purged and verified.');
    } else if (migration.error) {
      channel.appendLine(`[ORIGINX Migration] Note: ${migration.error}`);
    }
  }

  public static showResult(result: GitHistoryResult): void {
    const channel = this.getChannel();
    channel.clear();

    const separator = '='.repeat(80);
    const subSeparator = '-'.repeat(80);

    channel.appendLine(separator);
    channel.appendLine('  ORIGINX: WHY WAS THIS CHANGED?');
    channel.appendLine(separator);
    channel.appendLine(`File:          ${result.selection.fileName} (${result.selection.filePath})`);
    channel.appendLine(`Lines:         ${result.selection.startLine} - ${result.selection.endLine}`);
    if (result.repoRoot) {
      channel.appendLine(`Repo Root:     ${result.repoRoot}`);
    }
    if (result.relativeFilePath) {
      channel.appendLine(`Relative Path: ${result.relativeFilePath}`);
    }
    channel.appendLine(`Git Status:    ${this.formatStatus(result)}`);
    channel.appendLine(separator);
    channel.appendLine('');

    // Render Safe AI Request Diagnostics if available
    if (result.explanationDiagnostics) {
      const diag = result.explanationDiagnostics;
      channel.appendLine(separator);
      channel.appendLine('  ORIGINX AI REQUEST DIAGNOSTICS');
      channel.appendLine(separator);
      channel.appendLine(`Category:          ${diag.category}`);
      channel.appendLine(`Stage:             ${diag.stage}`);
      channel.appendLine(`Duration:          ${diag.durationMs}ms (${(diag.durationMs / 1000).toFixed(1)}s)`);
      channel.appendLine(`HTTP Status:       ${diag.httpStatus !== undefined ? diag.httpStatus : '200 (Native LM)'}`);
      channel.appendLine(`Model:             ${diag.model}`);
      if (diag.requestSizeBytes !== undefined) {
        channel.appendLine(`Request Size:      ${diag.requestSizeBytes} bytes (~${diag.approximateInputTokens ?? Math.ceil(diag.requestSizeBytes / 4)} tokens)`);
      }
      if (diag.commitCount !== undefined) {
        channel.appendLine(`Git Evidence Sent: ${diag.commitCount} commit(s) (~${diag.diffCharacterCount ?? 0} diff chars)`);
      }
      if (diag.responseSizeBytes !== undefined) {
        channel.appendLine(`Response Size:     ${diag.responseSizeBytes} bytes`);
      }
      channel.appendLine(`Details:           ${diag.details}`);
      channel.appendLine(separator);
      channel.appendLine('');
    }

    // Render AI Explanation if available
    if (result.explanation) {
      channel.appendLine(separator);
      channel.appendLine(`  ORIGINX AI EXPLANATION [VS Code Copilot LM] (${result.explanation.model})`);
      channel.appendLine('  Evidence-Backed Analysis (Verified Git Facts vs AI Inferences)');
      channel.appendLine(separator);
      channel.appendLine('');

      channel.appendLine('[WHAT CHANGED]');
      channel.appendLine(subSeparator);
      channel.appendLine(result.explanation.whatChanged);
      channel.appendLine('');

      channel.appendLine('[POSSIBLE REASONS]');
      channel.appendLine(subSeparator);
      channel.appendLine(result.explanation.possibleReasons);
      channel.appendLine('');

      channel.appendLine('[SUPPORTING COMMITS]');
      channel.appendLine(subSeparator);
      channel.appendLine(result.explanation.supportingCommits);
      channel.appendLine('');

      channel.appendLine('[UNCERTAINTY & EVIDENCE LIMITATIONS]');
      channel.appendLine(subSeparator);
      channel.appendLine(result.explanation.uncertainty);
      channel.appendLine(separator);
      channel.appendLine('');
    } else if (result.explanationStatus === 'disabled') {
      channel.appendLine('NOTE: Automatic AI analysis is disabled (default).');
      channel.appendLine('Run command "ORIGINX: Command Center" or "ORIGINX: Enable Automatic AI Analysis" to enable AI explanations.');
      channel.appendLine('Inspect outgoing data anytime via "ORIGINX: Inspect Outgoing AI Payload".');
      channel.appendLine(subSeparator);
      channel.appendLine('');
    } else if (result.explanationStatus === 'no_model') {
      channel.appendLine('NOTE: No language model is available through the VS Code Language Model API.');
      channel.appendLine('Please ensure GitHub Copilot or Copilot Chat is installed and active.');
      channel.appendLine(subSeparator);
      channel.appendLine('');
    } else if (result.explanationStatus === 'cancelled') {
      channel.appendLine('NOTE: AI explanation was cancelled by user. Displaying local Git history only.');
      channel.appendLine(subSeparator);
      channel.appendLine('');
    } else if (result.explanationStatus === 'blocked_security') {
      channel.appendLine(`SECURITY BLOCK: ${result.explanationError || 'Potential credentials detected.'}`);
      channel.appendLine('The request was blocked to protect your credentials. Local Git history is preserved below.');
      channel.appendLine(subSeparator);
      channel.appendLine('');
    } else if (result.explanationStatus === 'failed') {
      channel.appendLine(`NOTE: AI explanation request failed: ${result.explanationError}`);
      channel.appendLine('Raw Git history is preserved and displayed below.');
      channel.appendLine(subSeparator);
      channel.appendLine('');
    }

    // Render Raw Git Commits
    if (result.hasUncommittedChanges && result.uncommittedDiff) {
      channel.appendLine('[UNCOMMITTED LOCAL MODIFICATIONS]');
      channel.appendLine(subSeparator);
      channel.appendLine(result.uncommittedDiff);
      channel.appendLine('');
    }

    if (result.commits.length === 0) {
      channel.appendLine('No Git commit history found for the selected lines.');
      if (result.message) {
        channel.appendLine(`Detail: ${result.message}`);
      }
    } else {
      channel.appendLine(`COMMITS TOUCHING SELECTED LINES (${result.commits.length} found):`);
      channel.appendLine(subSeparator);

      result.commits.forEach((commit, index) => {
        channel.appendLine(`[Commit ${index + 1}/${result.commits.length}] ${commit.shortHash} - ${commit.subject}`);
        channel.appendLine(`Author: ${commit.authorName} <${commit.authorEmail}>`);
        channel.appendLine(`Date:   ${commit.date}`);
        if (commit.body) {
          channel.appendLine(`Message:\n${commit.body.split('\n').map((l) => '  ' + l).join('\n')}`);
        }
        if (commit.diff) {
          channel.appendLine('Diff:');
          channel.appendLine(commit.diff);
        }
        channel.appendLine('');
      });
    }

    channel.show(true);
  }

  public static showVsCodeModels(models: ILanguageModelChat[]): void {
    const channel = this.getChannel();
    channel.clear();

    const lines = formatAvailableVsCodeModels(models);
    for (const line of lines) {
      channel.appendLine(line);
    }

    channel.show(false);
  }

  public static showMultiFileSummary(info: {
    totalReceived: number;
    eligibleFiles: Array<{ fileName: string; filePath: string; repoRoot?: string }>;
    excludedFiles: Array<{ fileName: string; filePath: string; exclusionReason?: string }>;
    isMixedRepositories: boolean;
    evidence?: {
      files: Array<{ file: { fileName: string }; commits: any[]; totalDiffChars: number; isBounded: boolean }>;
      totalCommits: number;
      totalDiffChars: number;
      truncationWarnings: string[];
    };
    tokenEstimate?: {
      estimatedTokens: number;
      isExact: boolean;
      method: string;
      modelIdentifier: string;
      maxInputTokens?: number;
    };
    explanation?: {
      crossFileSummary: string;
      perFileSummaries: Array<{ fileName: string; whatChanged: string; possibleReasons: string }>;
      supportingCommits: string;
      uncertainty: string;
    };
    status: string;
  }): void {
    const channel = this.getChannel();
    channel.clear();

    const separator = '='.repeat(80);
    const subSeparator = '-'.repeat(80);

    channel.appendLine(separator);
    channel.appendLine('  ORIGINX: WHY WERE THESE CHANGED? (MULTI-FILE)');
    channel.appendLine(separator);
    channel.appendLine(`Total Files Selected: ${info.totalReceived}`);
    channel.appendLine(`Eligible Code Files:  ${info.eligibleFiles.length}`);
    channel.appendLine(`Excluded Files:       ${info.excludedFiles.length}`);
    if (info.isMixedRepositories) {
      channel.appendLine('Repository Status:    MIXED (Selected files span multiple Git repositories)');
    }
    channel.appendLine(`Execution Status:     ${info.status}`);
    channel.appendLine(separator);
    channel.appendLine('');

    if (info.excludedFiles.length > 0) {
      channel.appendLine('[EXCLUDED FILES]');
      channel.appendLine(subSeparator);
      for (const ex of info.excludedFiles) {
        channel.appendLine(`• ${ex.fileName} (${ex.filePath})`);
        channel.appendLine(`  Reason: ${ex.exclusionReason || 'Excluded'}`);
      }
      channel.appendLine('');
    }

    if (info.eligibleFiles.length > 0) {
      channel.appendLine('[ELIGIBLE FILES]');
      channel.appendLine(subSeparator);
      for (const el of info.eligibleFiles) {
        channel.appendLine(`• ${el.fileName} (${el.filePath})`);
      }
      channel.appendLine('');
    }

    if (info.evidence) {
      channel.appendLine('[GIT EVIDENCE SUMMARY]');
      channel.appendLine(subSeparator);
      channel.appendLine(`Total Commits Gathered: ${info.evidence.totalCommits}`);
      channel.appendLine(`Total Diff Characters:  ${info.evidence.totalDiffChars.toLocaleString()}`);

      for (const f of info.evidence.files) {
        channel.appendLine(`• ${f.file.fileName}: ${f.commits.length} commit(s), ${f.totalDiffChars.toLocaleString()} diff chars${f.isBounded ? ' [BOUNDED]' : ''}`);
      }

      if (info.evidence.truncationWarnings.length > 0) {
        channel.appendLine('');
        channel.appendLine('Bounding & Truncation Warnings:');
        for (const w of info.evidence.truncationWarnings) {
          channel.appendLine(`  ⚠ ${w}`);
        }
      }
      channel.appendLine('');
    }

    if (info.tokenEstimate) {
      channel.appendLine('[USAGE & TOKEN ESTIMATION]');
      channel.appendLine(subSeparator);
      channel.appendLine(`Model:            ${info.tokenEstimate.modelIdentifier}`);
      channel.appendLine(`Estimated Tokens: ${info.tokenEstimate.estimatedTokens.toLocaleString()} (${info.tokenEstimate.isExact ? 'exact via model.countTokens' : 'approximate ~4 chars/token'})`);
      if (info.tokenEstimate.maxInputTokens) {
        channel.appendLine(`Context Window:   ${info.tokenEstimate.maxInputTokens.toLocaleString()} tokens`);
      }
      channel.appendLine(separator);
      channel.appendLine('');
    }

    if (info.explanation) {
      channel.appendLine(separator);
      channel.appendLine('  ORIGINX MULTI-FILE AI EXPLANATION [VS Code Copilot LM]');
      channel.appendLine(separator);
      channel.appendLine('');

      channel.appendLine('[CROSS-FILE RELATIONSHIP & SUMMARY]');
      channel.appendLine(subSeparator);
      channel.appendLine(info.explanation.crossFileSummary);
      channel.appendLine('');

      channel.appendLine('[PER-FILE SUMMARIES]');
      channel.appendLine(subSeparator);
      for (const p of info.explanation.perFileSummaries) {
        channel.appendLine(`• ${p.fileName}:`);
        channel.appendLine(`  What Changed:    ${p.whatChanged}`);
        channel.appendLine(`  Possible Reasons: ${p.possibleReasons}`);
      }
      channel.appendLine('');

      channel.appendLine('[SUPPORTING COMMITS]');
      channel.appendLine(subSeparator);
      channel.appendLine(info.explanation.supportingCommits);
      channel.appendLine('');

      channel.appendLine('[UNCERTAINTY & EVIDENCE LIMITATIONS]');
      channel.appendLine(subSeparator);
      channel.appendLine(info.explanation.uncertainty);
      channel.appendLine(separator);
      channel.appendLine('');
    }

    channel.show(true);
  }

  public static dispose(): void {
    if (this.channel) {
      this.channel.dispose();
      this.channel = undefined;
    }
  }

  private static formatStatus(result: GitHistoryResult): string {
    switch (result.status) {
      case 'ok':
        return `OK - Retrieved ${result.commits.length} commit(s)`;
      case 'no_git':
        return 'ERROR - Git is not installed or not in PATH';
      case 'not_a_repo':
        return 'WARNING - File is outside a Git repository';
      case 'untracked_file':
        return 'INFO - File is untracked in Git';
      case 'empty_repo':
        return 'INFO - Repository has no commits';
      case 'uncommitted_only':
        return 'INFO - Selected lines are uncommitted local additions';
      case 'no_history_for_selection':
        return 'INFO - No Git history found for selected lines';
      case 'cancelled':
        return 'INFO - Git operation cancelled by user';
      case 'error':
        return `ERROR - Git operation failed: ${result.message || 'Unknown error'}`;
    }
  }
}
