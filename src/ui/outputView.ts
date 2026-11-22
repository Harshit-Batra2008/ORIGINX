import type * as vscode from 'vscode';
import { GitHistoryResult } from '../git/gitTypes';
import {
  formatAvailableVsCodeModels,
  ILanguageModelChat
} from '../lm/vscodeLmClient';
import {
  GraphImportSummary,
  GraphInspectionSummary,
  Neo4jFileEvidenceResult,
  RepositoryPruneResult
} from '../neo4j/neo4jGraphTypes';
import { MigrationResult } from '../security/secretManager';
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

export class OutputView {
  private static channel: vscode.OutputChannel | undefined;

  public static getChannel(): vscode.OutputChannel {
    if (!this.channel) {
      const vs = getVsCode();
      if (vs && vs.window && typeof vs.window.createOutputChannel === 'function') {
        this.channel = vs.window.createOutputChannel('GitWhisper by ORIGINX: Why Was This Changed?');
      } else {
        this.channel = {
          name: 'GitWhisper by ORIGINX: Why Was This Changed?',
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
    channel.appendLine('  GITWHISPER BY ORIGINX: WHY WAS THIS CHANGED?');
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
      channel.appendLine('Open GitWhisper: Understand & Continue, then History, graph and settings to enable automatic AI analysis.');
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

    // Render Neo4j Knowledge Graph Evidence
    if (result.neo4jEvidence && result.neo4jEvidence.length > 0) {
      const repoTag = result.neo4jRepositoryId ? ` (${result.neo4jRepositoryId})` : '';
      channel.appendLine(`[NEO4J KNOWLEDGE GRAPH EVIDENCE${repoTag} — ${result.neo4jEvidence.length} commit(s)]`);
      channel.appendLine(subSeparator);
      result.neo4jEvidence.forEach((ge, index) => {
        const hash = ge.shortHash || (ge.commitHash ? ge.commitHash.slice(0, 7) : 'unknown');
        const change = ge.oldPath ? `${ge.changeType.toUpperCase()} (from ${ge.oldPath})` : ge.changeType.toUpperCase();
        const author = ge.authorEmail ? `${ge.authorName} <${ge.authorEmail}>` : ge.authorName;
        channel.appendLine(`[Graph Commit ${index + 1}/${result.neo4jEvidence!.length}] ${hash} | Change: ${change} | ${ge.subject}`);
        channel.appendLine(`Author: ${author}`);
        channel.appendLine(`Date:   ${ge.committedAt}`);
        if (ge.body && ge.body.trim()) {
          channel.appendLine(`Message:\n${ge.body.split('\n').map((l) => '  ' + l).join('\n')}`);
        }
        channel.appendLine('');
      });
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

  public static showGraphImportSummary(summary: GraphImportSummary): void {
    const channel = this.getChannel();
    const separator = '='.repeat(52);
    const subSeparator = '-'.repeat(52);
    channel.appendLine(separator);
    channel.appendLine('ORIGINX — Neo4j Evidence Graph Import');
    channel.appendLine(separator);
    channel.appendLine(`Status                : ${summary.status.toUpperCase()}`);
    channel.appendLine(`Repository            : ${summary.repositoryName} (${summary.repositoryId})`);
    channel.appendLine('');
    channel.appendLine('[IMPORT PROCESSING]');
    channel.appendLine(subSeparator);
    channel.appendLine(`Commits Processed     : ${summary.commitsProcessed}`);
    channel.appendLine(`Files Processed       : ${summary.filesProcessed}`);
    channel.appendLine(`File Changes          : ${summary.fileChangesProcessed}`);
    channel.appendLine('');
    channel.appendLine('[VERIFIED REPOSITORY GRAPH COUNTS]');
    channel.appendLine(subSeparator);
    channel.appendLine(`Repository Commits    : ${summary.databaseCommitCount}`);
    channel.appendLine(`Repository Files      : ${summary.databaseFileCount}`);
    channel.appendLine(`Code Modifications    : ${summary.databaseModificationCount}`);
    channel.appendLine('');
    channel.appendLine(`Duration              : ${(summary.durationMs / 1000).toFixed(2)}s`);

    if (summary.error) {
      channel.appendLine(`Error                 : ${summary.error}`);
    }

    channel.appendLine(separator);
    channel.appendLine('');
    channel.show(true);
  }

  public static showGraphInspectionSummary(summary: GraphInspectionSummary): void {
    const channel = this.getChannel();
    const separator = '='.repeat(52);
    const subSeparator = '-'.repeat(52);
    channel.appendLine(separator);
    channel.appendLine('ORIGINX — Neo4j Evidence Graph Inspection');
    channel.appendLine(separator);
    channel.appendLine(`Status                : ${summary.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
    channel.appendLine(`Duration              : ${(summary.durationMs / 1000).toFixed(2)}s`);

    if (summary.error) {
      channel.appendLine(`Error                 : ${summary.error}`);
    }

    if (summary.repositoryScoped) {
      const scope = summary.repositoryScoped;
      channel.appendLine('');
      channel.appendLine(`[REPOSITORY SCOPED EVIDENCE: ${scope.repoName}]`);
      channel.appendLine(subSeparator);
      channel.appendLine(`Repository ID         : ${scope.repoId}`);
      channel.appendLine(`Commits Tracked       : ${scope.commitCount}`);
      channel.appendLine(`Files Tracked         : ${scope.fileCount}`);
      channel.appendLine(`Contributors (People) : ${scope.personCount}`);
      channel.appendLine(`Code Modifications    : ${scope.modificationCount}`);

      if (scope.topModifiedFiles && scope.topModifiedFiles.length > 0) {
        channel.appendLine('');
        channel.appendLine('  Top Modified Files:');
        for (let i = 0; i < scope.topModifiedFiles.length; i++) {
          const item = scope.topModifiedFiles[i];
          channel.appendLine(`    ${i + 1}. ${item.path} (${item.modificationCount} changes)`);
        }
      }

      if (scope.latestCommits && scope.latestCommits.length > 0) {
        channel.appendLine('');
        channel.appendLine('  Recent Commits:');
        for (const c of scope.latestCommits) {
          channel.appendLine(`    - [${c.hash}] ${c.subject} (${c.author}, ${c.date})`);
        }
      }
    }

    channel.appendLine('');
    channel.appendLine('[GLOBAL DATABASE TOTALS (All Repositories)]');
    channel.appendLine(subSeparator);
    channel.appendLine(`Repositories Ingested : ${summary.globalDatabase.totalRepositories}`);
    channel.appendLine(`Total Commits         : ${summary.globalDatabase.totalCommits}`);
    channel.appendLine(`Total Files           : ${summary.globalDatabase.totalFiles}`);
    channel.appendLine(`Total Persons         : ${summary.globalDatabase.totalPersons}`);
    channel.appendLine(`Total Modifications   : ${summary.globalDatabase.totalModifications}`);

    channel.appendLine(separator);
    channel.appendLine('');
    channel.show(true);
  }

  public static showGraphPruneSummary(result: RepositoryPruneResult): void {
    const channel = this.getChannel();
    const separator = '='.repeat(52);
    channel.appendLine(separator);
    channel.appendLine('ORIGINX — Neo4j Repository Graph Cleanup');
    channel.appendLine(separator);
    channel.appendLine(`Status                : ${result.status.toUpperCase()}`);
    channel.appendLine(`Repository            : ${result.repoName} (${result.repoId})`);
    channel.appendLine(`Commits Pruned        : ${result.deletedCommits}`);
    channel.appendLine(`Files Pruned          : ${result.deletedFiles}`);
    channel.appendLine(`Duration              : ${(result.durationMs / 1000).toFixed(2)}s`);

    if (result.error) {
      channel.appendLine(`Error                 : ${result.error}`);
    }

    channel.appendLine(separator);
    channel.appendLine('');
    channel.show(true);
  }

  public static showFileEvidence(result: Neo4jFileEvidenceResult): void {
    const channel = this.getChannel();
    const separator = '='.repeat(52);
    const subSeparator = '-'.repeat(52);
    channel.appendLine(separator);
    channel.appendLine('ORIGINX — Neo4j Historical File Evidence');
    channel.appendLine(separator);
    channel.appendLine(`Status                : ${result.status.toUpperCase()}`);
    channel.appendLine(`Repository            : ${result.repositoryId}`);
    channel.appendLine(`File                  : ${result.filePath}`);
    channel.appendLine(`Commits Retrieved     : ${result.commits.length}`);
    channel.appendLine(`Duration              : ${(result.durationMs / 1000).toFixed(2)}s`);

    if (result.error) {
      channel.appendLine(`Error                 : ${result.error}`);
    }

    channel.appendLine(subSeparator);

    if (result.commits.length === 0) {
      channel.appendLine('No historical commit evidence found in Neo4j for this file.');
    } else {
      channel.appendLine('Historical Commits (Newest First):');
      for (let i = 0; i < result.commits.length; i++) {
        const c = result.commits[i];
        channel.appendLine('');
        const authorStr = c.authorEmail ? `${c.authorName} <${c.authorEmail}>` : c.authorName;
        const changeStr = c.oldPath ? `${c.changeType.toUpperCase()} (from ${c.oldPath})` : c.changeType.toUpperCase();
        channel.appendLine(`[${i + 1}] Commit: ${c.shortHash || c.commitHash} | Change: ${changeStr}`);
        channel.appendLine(`    Author : ${authorStr}`);
        channel.appendLine(`    Date   : ${c.committedAt}`);
        channel.appendLine(`    Subject: ${c.subject}`);
        if (c.body && c.body.trim().length > 0) {
          const bodyLines = c.body.split('\n');
          channel.appendLine('    Message:');
          for (const line of bodyLines) {
            channel.appendLine(`      ${line}`);
          }
        }
      }
    }

    channel.appendLine(separator);
    channel.appendLine('');
    channel.show(true);
  }

  public static showReviewerSummary(result: ReviewerResult): void {
    const channel = this.getChannel();
    channel.clear();

    const separator = '='.repeat(80);
    const subSeparator = '-'.repeat(80);

    channel.appendLine(separator);
    channel.appendLine('  GITWHISPER BY ORIGINX: CODE REVIEWER (WORKING TREE CHANGES)');
    channel.appendLine(separator);
    channel.appendLine(`Repository:    ${result.repoName || 'Current Repository'} (${result.repoRoot || ''})`);
    channel.appendLine(`Changed Files: ${result.totalChangedFiles} (Staged: ${result.stagedCount}, Unstaged: ${result.unstagedCount}, Untracked: ${result.untrackedCount})`);
    channel.appendLine(`Diff Size:     ${(result.totalDiffChars / 1024).toFixed(1)} KB`);
    channel.appendLine(`Neo4j Status:  ${result.neo4jStatus.toUpperCase()}${result.neo4jError ? ` (${result.neo4jError})` : ''}`);
    channel.appendLine(`AI Review:     ${result.explanationStatus.toUpperCase()}`);
    channel.appendLine(separator);
    channel.appendLine('');

    if (result.explanation) {
      channel.appendLine(subSeparator);
      channel.appendLine('  AI CODE REVIEW');
      channel.appendLine(subSeparator);
      channel.appendLine(`Model: ${result.explanation.model || 'copilot'}`);
      channel.appendLine('');
      channel.appendLine('Summary:');
      channel.appendLine(result.explanation.summary);
      channel.appendLine('');
      channel.appendLine('Architectural Impact & Blast Radius:');
      channel.appendLine(result.explanation.impactAnalysis);
      channel.appendLine('');
      if (result.explanation.relatedFilesGuidance) {
        channel.appendLine('Related Files Guidance:');
        channel.appendLine(result.explanation.relatedFilesGuidance);
        channel.appendLine('');
      }
      if (result.explanation.reviewChecklist && result.explanation.reviewChecklist.length > 0) {
        channel.appendLine('Review Checklist:');
        for (const item of result.explanation.reviewChecklist) {
          channel.appendLine(`  [ ] ${item}`);
        }
        channel.appendLine('');
      }
    }

    if (result.relatedFilesWorthInspecting.length > 0) {
      channel.appendLine(subSeparator);
      channel.appendLine('  HISTORICALLY CO-CHANGED FILES (NEO4J PROVENANCE)');
      channel.appendLine(subSeparator);
      for (const rec of result.relatedFilesWorthInspecting) {
        const statusTag = rec.isCurrentlyChanged
          ? '[CURRENTLY MODIFIED]'
          : '[WORTH INSPECTING - NOT IN CURRENT CHANGES]';
        channel.appendLine(`* ${rec.filePath} ${statusTag}`);
        channel.appendLine(`    Shared Commits: ${rec.sharedCommitCount} with ${rec.historicallyCoupledWith.join(', ')}`);
        if (rec.sampleCommitHashes.length > 0) {
          channel.appendLine(`    Commit Hashes : ${rec.sampleCommitHashes.join(', ')}`);
        }
      }
      channel.appendLine('');
    }

    channel.appendLine(subSeparator);
    channel.appendLine('  CHANGED FILES LIST');
    channel.appendLine(subSeparator);
    for (const f of result.changedFiles) {
      channel.appendLine(`- ${f.filePath} (${f.status.toUpperCase()}, ${(f.diffCharCount / 1024).toFixed(1)}KB)`);
    }

    channel.appendLine('');
    channel.appendLine(separator);
    channel.show(true);
  }

  public static showInvestigationSummary(result: InvestigationResult): void {
    const channel = this.getChannel();
    channel.clear();

    const separator = '='.repeat(80);
    const subSeparator = '-'.repeat(80);

    const req = result.request;
    const targetFile = req ? `${req.fileName} (${req.filePath})` : 'Unknown file';
    const lines = req ? `Lines ${req.startLine}-${req.endLine}` : '';
    const repoStr = req ? `${req.repoName} (${req.repoId})` : 'Unknown';

    channel.appendLine(separator);
    channel.appendLine('  GITWHISPER: EVIDENCE-AWARE BUG INVESTIGATION');
    channel.appendLine(separator);
    channel.appendLine(`Target File:      ${targetFile}`);
    channel.appendLine(`Line Range:       ${lines}`);
    channel.appendLine(`Repository:       ${repoStr}`);
    channel.appendLine(`Overall Status:   ${result.status.toUpperCase()}`);
    channel.appendLine(`Diagnostics:      ${result.evidence?.diagnostics?.length || 0} active issue(s)`);
    channel.appendLine(`Git History:      ${result.evidence?.gitHistory?.commits?.length || 0} commit(s)`);
    channel.appendLine(`Neo4j Graph:      ${result.evidence?.neo4jStatus?.toUpperCase() || 'DISABLED'}`);
    channel.appendLine(`AI Explanation:   ${result.explanationStatus.toUpperCase()}${result.explanation?.model ? ` [${result.explanation.model}]` : ''}`);
    channel.appendLine(`Duration:         ${result.durationMs}ms`);
    channel.appendLine(separator);
    channel.appendLine('');

    if (req?.userErrorMessage) {
      channel.appendLine(subSeparator);
      channel.appendLine('  REPORTED ERROR / SYMPTOM');
      channel.appendLine(subSeparator);
      channel.appendLine(req.userErrorMessage);
      channel.appendLine('');
    }

    if (result.evidence?.diagnostics && result.evidence.diagnostics.length > 0) {
      channel.appendLine(subSeparator);
      channel.appendLine('  ACTIVE VS CODE DIAGNOSTICS');
      channel.appendLine(subSeparator);
      for (const d of result.evidence.diagnostics) {
        const overlap = d.overlapsSelection ? ' [OVERLAPS SELECTION]' : '';
        const src = d.source ? ` (${d.source}${d.code ? `:${d.code}` : ''})` : '';
        channel.appendLine(`• [${d.severity.toUpperCase()}] at L${d.range.startLine}:${d.range.startCharacter}-L${d.range.endLine}:${d.range.endCharacter}${src}${overlap}`);
        channel.appendLine(`    ${d.message}`);
      }
      channel.appendLine('');
    }

    if (result.explanation) {
      const exp = result.explanation;

      channel.appendLine(subSeparator);
      channel.appendLine('  1. OBSERVED FACTS');
      channel.appendLine(subSeparator);
      channel.appendLine(exp.observedFacts);
      channel.appendLine('');

      if (exp.rootCauseHypotheses.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  2. PLAUSIBLE ROOT-CAUSE HYPOTHESES');
        channel.appendLine(subSeparator);
        for (const h of exp.rootCauseHypotheses) {
          channel.appendLine(`• ${h}`);
        }
        channel.appendLine('');
      }

      if (exp.relatedFiles.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  3. RELATED FILES WORTH INSPECTING');
        channel.appendLine(subSeparator);
        for (const rf of exp.relatedFiles) {
          channel.appendLine(`• ${rf.filePath}: ${rf.reason}`);
        }
        channel.appendLine('');
      }

      if (exp.investigationSteps.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  4. PROPOSED INVESTIGATION STEPS');
        channel.appendLine(subSeparator);
        for (let i = 0; i < exp.investigationSteps.length; i++) {
          channel.appendLine(`  ${i + 1}. ${exp.investigationSteps[i]}`);
        }
        channel.appendLine('');
      }

      if (exp.minimalSuggestedFix) {
        channel.appendLine(subSeparator);
        channel.appendLine('  5. MINIMAL SUGGESTED FIX [UNVERIFIED - SUGGESTED FIX]');
        channel.appendLine(subSeparator);
        channel.appendLine(exp.minimalSuggestedFix.code);
        channel.appendLine('');
        channel.appendLine(`Explanation: ${exp.minimalSuggestedFix.explanation}`);
        channel.appendLine('NOTE: This suggested fix is unverified and has not been tested or applied.');
        channel.appendLine('');
      }

      if (exp.relevantTests.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  6. RELEVANT TESTS TO RUN');
        channel.appendLine(subSeparator);
        for (const t of exp.relevantTests) {
          channel.appendLine(`• ${t}`);
        }
        channel.appendLine('');
      }

      if (exp.uncertainties.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  7. UNCERTAINTIES & LIMITATIONS');
        channel.appendLine(subSeparator);
        for (const u of exp.uncertainties) {
          channel.appendLine(`• ${u}`);
        }
        channel.appendLine('');
      }
    } else if (result.explanationError) {
      channel.appendLine(subSeparator);
      channel.appendLine('  AI INVESTIGATION NOTICE');
      channel.appendLine(subSeparator);
      channel.appendLine(`Explanation status: ${result.explanationStatus}`);
      channel.appendLine(`Details: ${result.explanationError}`);
      channel.appendLine('');
    }

    if (result.evidence?.coChangeEvidence && result.evidence.coChangeEvidence.length > 0) {
      channel.appendLine(subSeparator);
      channel.appendLine('  HISTORICALLY CO-CHANGED FILES (NEO4J BLAST RADIUS)');
      channel.appendLine(subSeparator);
      for (const rec of result.evidence.coChangeEvidence) {
        channel.appendLine(`• ${rec.filePath}`);
        channel.appendLine(`    Shared Commits: ${rec.sharedCommitCount} with ${rec.historicallyCoupledWith.join(', ')}`);
        if (rec.sampleCommitHashes.length > 0) {
          channel.appendLine(`    Supporting Commits: ${rec.sampleCommitHashes.join(', ')}`);
        }
      }
      channel.appendLine('');
    }

    channel.appendLine(separator);
    channel.show(true);
  }

  public static showUnifiedAnalysisSummary(result: UnifiedAnalysisResult): void {
    const channel = this.getChannel();
    channel.clear();

    const separator = '='.repeat(80);
    const subSeparator = '-'.repeat(80);

    const req = result.request;
    const targetFile = req ? `${req.fileName} (${req.filePath})` : 'Unknown file';
    const lines = req ? `Lines ${req.startLine}-${req.endLine}` : '';
    const repoStr = req ? `${req.repoName} (${req.repoId})` : 'Unknown';

    channel.appendLine(separator);
    channel.appendLine('  GITWHISPER: UNIFIED CODE ANALYSIS');
    channel.appendLine(separator);
    channel.appendLine(`Target File:      ${targetFile}`);
    channel.appendLine(`Line Range:       ${lines}`);
    channel.appendLine(`Repository:       ${repoStr}`);
    channel.appendLine(`Execution Status: ${result.status.toUpperCase()}`);
    channel.appendLine(`Working Tree:     ${result.evidence?.isWorkingTreeModified ? 'MODIFIED LOCALLY' : 'CLEAN'}`);
    channel.appendLine(`Diagnostics:      ${result.evidence?.diagnostics?.length || 0} active issue(s)`);
    channel.appendLine(`Git History:      ${result.evidence?.gitHistory?.commits?.length || 0} commit(s)`);
    channel.appendLine(`Neo4j Status:     ${result.evidence?.neo4jStatus?.toUpperCase() || 'DISABLED'}`);
    channel.appendLine(`AI Synthesis:     ${result.explanationStatus.toUpperCase()}${result.explanation?.model ? ` [${result.explanation.model}]` : ''}`);
    channel.appendLine(`Duration:         ${result.durationMs}ms`);
    channel.appendLine(separator);
    channel.appendLine('');

    if (result.explanation) {
      const exp = result.explanation;

      channel.appendLine(subSeparator);
      channel.appendLine('  1. WHAT THIS CODE DOES');
      channel.appendLine(subSeparator);
      channel.appendLine(exp.whatCodeDoes);
      channel.appendLine('');

      channel.appendLine(subSeparator);
      channel.appendLine('  2. HISTORICAL EVOLUTION & WHY IT CHANGED');
      channel.appendLine(subSeparator);
      channel.appendLine(exp.whyChangedHistorically);
      channel.appendLine('');

      channel.appendLine(subSeparator);
      channel.appendLine('  3. DIAGNOSTICS & POTENTIAL ISSUES');
      channel.appendLine(subSeparator);
      channel.appendLine(exp.diagnosticsAndIssues.summary);
      if (exp.diagnosticsAndIssues.details.length > 0) {
        for (const d of exp.diagnosticsAndIssues.details) {
          channel.appendLine(`• ${d}`);
        }
      }
      channel.appendLine('');

      if (exp.relatedFilesAndImpact.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  4. RELATED FILES & IMPACT ANALYSIS');
        channel.appendLine(subSeparator);
        for (const rf of exp.relatedFilesAndImpact) {
          const commits = rf.sharedCommitCount ? ` (${rf.sharedCommitCount} shared commits)` : '';
          channel.appendLine(`• ${rf.filePath}${commits}: ${rf.reason}`);
        }
        channel.appendLine('');
      }

      if (exp.suggestedImprovementsOrFixes) {
        channel.appendLine(subSeparator);
        channel.appendLine('  5. SUGGESTIONS & FIXES [UNVERIFIED - SUGGESTED FIX]');
        channel.appendLine(subSeparator);
        channel.appendLine(exp.suggestedImprovementsOrFixes.code);
        channel.appendLine('');
        channel.appendLine(`Explanation: ${exp.suggestedImprovementsOrFixes.explanation}`);
        channel.appendLine('NOTE: Advisory patch only. Has not been tested or applied autonomously.');
        channel.appendLine('');
      }

      if (exp.supportingEvidence.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  6. SUPPORTING EVIDENCE');
        channel.appendLine(subSeparator);
        for (const ev of exp.supportingEvidence) {
          channel.appendLine(`• ${ev}`);
        }
        channel.appendLine('');
      }

      if (exp.uncertaintiesAndLimitations.length > 0) {
        channel.appendLine(subSeparator);
        channel.appendLine('  7. UNCERTAINTIES & LIMITATIONS');
        channel.appendLine(subSeparator);
        for (const u of exp.uncertaintiesAndLimitations) {
          channel.appendLine(`• ${u}`);
        }
        channel.appendLine('');
      }
    } else {
      channel.appendLine(subSeparator);
      channel.appendLine('  LOCAL EVIDENCE SUMMARY (AI NOT ACTIVE)');
      channel.appendLine(subSeparator);
      channel.appendLine(`Explanation Status: ${result.explanationStatus}`);
      if (result.explanationError) {
        channel.appendLine(`Notice: ${result.explanationError}`);
      }
      channel.appendLine('');
    }

    // Active diagnostics summary
    if (result.evidence?.diagnostics && result.evidence.diagnostics.length > 0) {
      channel.appendLine(subSeparator);
      channel.appendLine('  ACTIVE VS CODE DIAGNOSTICS');
      channel.appendLine(subSeparator);
      for (const d of result.evidence.diagnostics) {
        const overlap = d.overlapsSelection ? ' [OVERLAPS SELECTION]' : '';
        const src = d.source ? ` (${d.source}${d.code ? `:${d.code}` : ''})` : '';
        channel.appendLine(`• [${d.severity.toUpperCase()}] at L${d.range.startLine}:${d.range.startCharacter}-L${d.range.endLine}:${d.range.endCharacter}${src}${overlap}`);
        channel.appendLine(`    ${d.message}`);
      }
      channel.appendLine('');
    }

    // Neo4j Co-Changes
    if (result.evidence?.neo4jCoChanges && result.evidence.neo4jCoChanges.length > 0) {
      channel.appendLine(subSeparator);
      channel.appendLine('  HISTORICALLY CO-CHANGED COMPANION FILES (NEO4J)');
      channel.appendLine(subSeparator);
      for (const rec of result.evidence.neo4jCoChanges) {
        channel.appendLine(`• ${rec.filePath}`);
        channel.appendLine(`    Shared Commits: ${rec.sharedCommitCount} with ${rec.historicallyCoupledWith.join(', ')}`);
        if (rec.sampleCommitHashes.length > 0) {
          channel.appendLine(`    Supporting Commits: ${rec.sampleCommitHashes.join(', ')}`);
        }
      }
      channel.appendLine('');
    }

    channel.appendLine(separator);
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
