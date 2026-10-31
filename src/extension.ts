import * as path from 'path';
import * as vscode from 'vscode';
import { GeminiExplainer } from './gemini/geminiExplainer';
import { findRepoRoot, getHistoryForSelection, runGit } from './git/gitService';
import { SelectionContext } from './git/gitTypes';
import { getAvailableVsCodeModels } from './lm/vscodeLmClient';
import { estimateMultiFileTokens, promptMultiFileUsageConfirmation } from './multiFile/multiFileConfirmation';
import { MultiFileExplainer } from './multiFile/multiFileExplainer';
import { gatherMultiFileGitEvidence } from './multiFile/multiFileService';
import { MultiFileHistoryResult } from './multiFile/multiFileTypes';
import { validateMultiFileSelection } from './multiFile/multiFileValidator';
import { clearStoredNeo4jPassword, getOrPromptNeo4jCredentials } from './neo4j/neo4jAuthHelper';
import { redactSecret } from './neo4j/neo4jEnv';
import {
  estimateRepositoryPruneCounts,
  fetchLocalGitGraphData,
  importGitGraph,
  pruneRepositorySubgraph,
  resolveRepositoryIdentity
} from './neo4j/neo4jGraphImporter';
import { inspectGraphEvidence } from './neo4j/neo4jGraphInspector';
import { retrieveFileEvidence } from './neo4j/neo4jEvidenceRetriever';
import { Neo4jCommitEvidence } from './neo4j/neo4jGraphTypes';
import { closeNeo4jDriver, createNeo4jDriver, resolveNeo4jConfig, verifyConnection } from './neo4j/neo4jService';
import { migrateAndPurgeLegacySecrets, SecretManager } from './security/secretManager';
import { showCommandCenter } from './ui/commandCenter';
import { OutputView } from './ui/outputView';
import { WebviewView } from './ui/webviewView';

export function activate(context: vscode.ExtensionContext) {
  try {
    const startupTime = new Date().toISOString();
    const isAutoAnalysis = vscode.workspace
      .getConfiguration('originx')
      .get<boolean>('enableAutomaticAnalysis', false);

    // 1. One-time idempotent legacy Gemini credential purge migration
    migrateAndPurgeLegacySecrets(context.secrets, context.globalState)
      .then((migration) => {
        OutputView.logMigrationStatus(migration);
      })
      .catch((err) => {
        console.warn('[ORIGINX] SecretStorage migration warning:', err);
      });

    // 2. Safe startup telemetry (zero secrets, prompts, or code logged)
    OutputView.logStartupDiagnostics({
      startupTime,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      vscodeVersion: vscode.version,
      provider: 'VS Code Language Model API (vscode.lm - Copilot Native)',
      automaticAnalysisEnabled: isAutoAnalysis
    });

    const explainer = new GeminiExplainer();

    // Command: ORIGINX: Command Center (Centralized action hub)
    const commandCenterDisposable = vscode.commands.registerCommand(
      'originx.commandCenter',
      async () => {
        await showCommandCenter(context);
      }
    );

    // Command: ORIGINX: List Available AI Models (vscode.lm discovery)
    const listVsCodeModelsDisposable = vscode.commands.registerCommand(
      'originx.listVsCodeModels',
      async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ORIGINX: Discovering available models via VS Code Language Model API...',
            cancellable: false
          },
          async () => {
            try {
              const models = await getAvailableVsCodeModels();
              OutputView.showVsCodeModels(models);

              if (models.length === 0) {
                vscode.window.showWarningMessage(
                  'ORIGINX: No language models available via vscode.lm. Ensure GitHub Copilot or Copilot Chat is installed and active.'
                );
                return;
              }

              vscode.window.showInformationMessage(
                `ORIGINX: Discovered ${models.length} language model(s) via vscode.lm. See Output Channel for details.`
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              vscode.window.showErrorMessage(`ORIGINX Model Discovery Error: ${msg}`);
            }
          }
        );
      }
    );

    // Command: ORIGINX: Enable Automatic AI Analysis (Opt-in with explicit data transmission disclosure)
    const enableAutoDisposable = vscode.commands.registerCommand(
      'originx.enableAutomaticAnalysis',
      async () => {
        const choice = await vscode.window.showInformationMessage(
          'Enabling Automatic AI Analysis allows ORIGINX to automatically send your selected code, commit messages, and Git diffs to GitHub Copilot (via the native VS Code Language Model API) on every analysis request. Detected credentials and secrets will always be blocked. Do you want to enable this?',
          { modal: true },
          'Enable Automatic Analysis',
          'Cancel'
        );

        if (choice === 'Enable Automatic Analysis') {
          await vscode.workspace
            .getConfiguration('originx')
            .update('enableAutomaticAnalysis', true, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            'ORIGINX: Automatic AI Analysis is now ENABLED (VS Code Copilot LM). Right-click will automatically generate AI explanations.'
          );
        }
      }
    );

    // Command: ORIGINX: Disable Automatic AI Analysis
    const disableAutoDisposable = vscode.commands.registerCommand(
      'originx.disableAutomaticAnalysis',
      async () => {
        await vscode.workspace
          .getConfiguration('originx')
          .update('enableAutomaticAnalysis', false, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          'ORIGINX: Automatic AI Analysis is now DISABLED. ORIGINX will show local Git history only.'
        );
      }
    );

    // Command: ORIGINX: Inspect Outgoing AI Payload (Inspect exact outgoing data format without transmitting)
    const inspectPayloadDisposable = vscode.commands.registerCommand(
      'originx.inspectPayload',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('ORIGINX: Please open a file and select code to inspect payload.');
          return;
        }

        const document = editor.document;
        if (document.isUntitled || document.uri.scheme !== 'file') {
          vscode.window.showWarningMessage('ORIGINX: File must be saved on disk.');
          return;
        }

        const selection = editor.selection;
        const selectedText = document.getText(selection);
        if (selection.isEmpty || selectedText.trim().length === 0) {
          vscode.window.showWarningMessage('ORIGINX: Please select a block of code to inspect payload.');
          return;
        }

        const startLine = selection.start.line + 1;
        let endLine = selection.end.line + 1;
        if (selection.end.character === 0 && selection.end.line > selection.start.line) {
          endLine = selection.end.line;
        }

        const filePath = document.uri.fsPath;
        const fileName = path.basename(filePath);
        const selectionContext: SelectionContext = {
          filePath,
          fileName,
          startLine,
          endLine,
          selectedText
        };

        const result = await getHistoryForSelection(selectionContext);

        let neo4jEvidence: Neo4jCommitEvidence[] | undefined = undefined;
        let repoId: string | undefined = undefined;
        try {
          const repoRoot = await findRepoRoot(filePath);
          if (repoRoot) {
            const repoInfo = await resolveRepositoryIdentity(repoRoot);
            repoId = repoInfo.id;
            const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');

            const secretManager = new SecretManager(context.secrets);
            const storedPassword = await secretManager.getNeo4jPassword();
            const activePassword = (process.env.NEO4J_PASSWORD && process.env.NEO4J_PASSWORD.trim()) || (storedPassword && storedPassword.trim());

            if (activePassword) {
              const authConfig = resolveNeo4jConfig({ password: activePassword });
              const driver = createNeo4jDriver(authConfig);
              try {
                const evidenceResult = await retrieveFileEvidence(driver, repoInfo.id, relPath, 25);
                if (evidenceResult.status === 'ok' && evidenceResult.commits.length > 0) {
                  neo4jEvidence = evidenceResult.commits;
                }
              } finally {
                await driver.close();
              }
            }
          }
        } catch {}

        const promptVariant =
          vscode.workspace.getConfiguration('originx').get<'compact' | 'standard'>('promptVariant', 'compact');
        const payload = explainer.buildInspectionPayload(
          selectionContext,
          result.commits,
          result.uncommittedDiff,
          undefined,
          promptVariant,
          undefined,
          {
            neo4jEvidence,
            repositoryId: repoId
          }
        );

        const payloadDoc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: JSON.stringify(payload, null, 2)
        });
        await vscode.window.showTextDocument(payloadDoc, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside
        });
        vscode.window.showInformationMessage(
          'ORIGINX: Outgoing payload displayed in editor for inspection (Copilot LM). No data was sent.'
        );
      }
    );

    // Command: ORIGINX: Why Was This Changed? (Primary user workflow)
    const explainDisposable = vscode.commands.registerCommand(
      'originx.whyWasThisChanged',
      async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
          vscode.window.showWarningMessage(
            'ORIGINX: No active editor found. Please open a file and select code to inspect.'
          );
          return;
        }

        const document = editor.document;
        if (document.isUntitled || document.uri.scheme !== 'file') {
          vscode.window.showWarningMessage(
            'ORIGINX: Git history is only available for saved files on disk. Please save the file first.'
          );
          return;
        }

        const selection = editor.selection;
        const selectedText = document.getText(selection);
        if (selection.isEmpty || selectedText.trim().length === 0) {
          vscode.window.showWarningMessage(
            'ORIGINX: Please select a block of code to examine why it was changed.'
          );
          return;
        }

        const startLine = selection.start.line + 1;
        let endLine = selection.end.line + 1;
        if (selection.end.character === 0 && selection.end.line > selection.start.line) {
          endLine = selection.end.line;
        }

        const filePath = document.uri.fsPath;
        const fileName = path.basename(filePath);
        const selectionContext: SelectionContext = {
          filePath,
          fileName,
          startLine,
          endLine,
          selectedText
        };

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ORIGINX: Examining Git history for ${fileName} (${startLine}-${endLine})...`,
            cancellable: true
          },
          async (_progress, token) => {
            try {
              // 1. Retrieve local Git history (100% offline, bounded with cancellation support)
              const result = await getHistoryForSelection(selectionContext, { cancellationToken: token });

              if (token.isCancellationRequested || result.status === 'cancelled') {
                OutputView.getChannel().appendLine('[ORIGINX] Analysis cancelled during Git retrieval.');
                return;
              }

              // 1.5. Query Neo4j Knowledge Graph evidence for file if available (non-blocking, graceful fallback)
              let neo4jEvidence: Neo4jCommitEvidence[] | undefined = undefined;
              let repoId: string | undefined = undefined;
              try {
                const repoRoot = await findRepoRoot(filePath);
                if (repoRoot) {
                  const repoInfo = await resolveRepositoryIdentity(repoRoot);
                  repoId = repoInfo.id;
                  const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');

                  const secretManager = new SecretManager(context.secrets);
                  const storedPassword = await secretManager.getNeo4jPassword();
                  const activePassword =
                    (process.env.NEO4J_PASSWORD && process.env.NEO4J_PASSWORD.trim()) ||
                    (storedPassword && storedPassword.trim());

                  if (activePassword) {
                    const authConfig = resolveNeo4jConfig({ password: activePassword });
                    const driver = createNeo4jDriver(authConfig);
                    try {
                      const neoStartTime = Date.now();
                      const evidenceResult = await retrieveFileEvidence(driver, repoInfo.id, relPath, 25);
                      if (evidenceResult.status === 'ok' && evidenceResult.commits.length > 0) {
                        neo4jEvidence = evidenceResult.commits;
                        result.neo4jEvidence = neo4jEvidence;
                        result.neo4jRepositoryId = repoInfo.id;
                        result.neo4jDurationMs = Date.now() - neoStartTime;
                      }
                    } finally {
                      await driver.close();
                    }
                  }
                }
              } catch (neoErr) {
                // Non-fatal: if Neo4j is offline or fails, preserve existing Git-based explanation
                console.warn('[ORIGINX] Neo4j evidence retrieval skipped or failed:', redactSecret(String(neoErr)));
              }

              // 2. If Git evidence or Neo4j evidence exists, check automatic AI analysis setting
              const hasEvidence =
                (result.status === 'ok' && result.commits.length > 0) ||
                (neo4jEvidence && neo4jEvidence.length > 0);

              if (hasEvidence) {
                const isAutoEnabled = vscode.workspace
                  .getConfiguration('originx')
                  .get<boolean>('enableAutomaticAnalysis', false);

                if (!isAutoEnabled) {
                  // Automatic analysis is disabled by default: show local Git history only
                  result.explanationStatus = 'disabled';
                } else {
                  // Automatic analysis is enabled: invoke Copilot LM natively
                  const promptVariant =
                    vscode.workspace
                      .getConfiguration('originx')
                      .get<'compact' | 'standard'>('promptVariant', 'compact');

                  const explainResult = await explainer.explainChanges(
                    selectionContext,
                    result.commits,
                    result.uncommittedDiff,
                    undefined,
                    {
                      promptVariant,
                      cancellationToken: token,
                      neo4jEvidence,
                      repositoryId: repoId
                    }
                  );

                  result.explanationStatus = explainResult.status;
                  result.explanation = explainResult.explanation;
                  result.explanationError = explainResult.error;
                  result.explanationDiagnostics = explainResult.diagnostics;

                  if (explainResult.status === 'blocked_security') {
                    vscode.window.showErrorMessage(
                      `ORIGINX Security Block: ${explainResult.error}`
                    );
                  } else if (explainResult.status === 'no_model') {
                    vscode.window.showWarningMessage(
                      'ORIGINX: No language models available via VS Code Language Model API. Ensure GitHub Copilot is installed and active.'
                    );
                  } else if (explainResult.status === 'failed') {
                    const diagSummary = explainResult.diagnostics
                      ? ` [Category: ${explainResult.diagnostics.category}, Duration: ${(explainResult.diagnostics.durationMs / 1000).toFixed(1)}s]`
                      : '';
                    vscode.window.showWarningMessage(
                      `ORIGINX AI Error: ${explainResult.error}${diagSummary}. Local Git history preserved.`
                    );
                  }
                }
              }

              // 3. Update Output Channel and Webview
              OutputView.showResult(result);
              WebviewView.show(result, context.extensionUri);

              // 4. Provide appropriate contextual feedback
              switch (result.status) {
                case 'no_git':
                  vscode.window.showErrorMessage(
                    'ORIGINX: Git is not installed or not found in system PATH.'
                  );
                  break;
                case 'not_a_repo':
                  vscode.window.showWarningMessage(
                    `ORIGINX: File "${fileName}" is not inside a Git repository.`
                  );
                  break;
                case 'untracked_file':
                  vscode.window.showInformationMessage(
                    `ORIGINX: File "${fileName}" is untracked and has no Git history.`
                  );
                  break;
                case 'empty_repo':
                  vscode.window.showInformationMessage(
                    'ORIGINX: The repository does not have any commits yet.'
                  );
                  break;
                case 'uncommitted_only':
                  vscode.window.showInformationMessage(
                    'ORIGINX: Selected lines are uncommitted local additions.'
                  );
                  break;
                case 'no_history_for_selection':
                  vscode.window.showInformationMessage(
                    'ORIGINX: No commit history found for the selected lines.'
                  );
                  break;
                case 'ok':
                  const summaryMsg = result.explanation
                    ? `ORIGINX: Retrieved ${result.commits.length} line commit(s)${neo4jEvidence ? ` + ${neo4jEvidence.length} graph commit(s)` : ''} + Copilot LM explanation`
                    : `ORIGINX: Found ${result.commits.length} commit(s) for selected lines${neo4jEvidence ? ` (${neo4jEvidence.length} in Neo4j graph)` : ''}`;
                  vscode.window.setStatusBarMessage(summaryMsg, 4000);
                  break;
              }
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(`ORIGINX Error: ${errMsg}`);
            }
          }
        );
      }
    );

    // Command: ORIGINX: Why Were These Changed? (Multi-file workflow)
    const explainMultiDisposable = vscode.commands.registerCommand(
      'originx.whyWereTheseChanged',
      async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        let targets: vscode.Uri[] = [];

        if (Array.isArray(selectedUris) && selectedUris.length > 0) {
          targets = selectedUris;
        } else if (clickedUri && clickedUri.fsPath) {
          targets = [clickedUri];
        } else if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
          targets = [vscode.window.activeTextEditor.document.uri];
        }

        if (targets.length === 0) {
          vscode.window.showWarningMessage(
            'ORIGINX: Please select one or more files in the VS Code File Explorer to analyze why they were changed.'
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ORIGINX: Validating and analyzing ${targets.length} selected file(s)...`,
            cancellable: true
          },
          async (_progress, token) => {
            try {
              // 1. Validate file selection (deduplication, symlinks, binary, git tracking, mixed repos)
              const validation = await validateMultiFileSelection(targets);

              if (validation.eligibleFiles.length === 0) {
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  status: 'No eligible code files selected'
                });
                vscode.window.showWarningMessage(
                  `ORIGINX: No eligible code files found in selection (${validation.excludedFiles.length} excluded). See ORIGINX Output Channel for details.`
                );
                return;
              }

              if (token.isCancellationRequested) {
                OutputView.getChannel().appendLine('[ORIGINX] Multi-file analysis cancelled during validation.');
                return;
              }

              // 2. Gather bounded Git evidence for eligible files
              const evidence = await gatherMultiFileGitEvidence(validation.eligibleFiles, {
                cancellationToken: token
              });

              if (token.isCancellationRequested || evidence.isCancelled) {
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  status: 'Cancelled by user during Git evidence retrieval'
                });
                OutputView.getChannel().appendLine('[ORIGINX] Multi-file analysis cancelled during Git retrieval.');
                return;
              }

              // 3. Discover model & estimate input tokens
              const models = await getAvailableVsCodeModels();
              const activeModel = models.length > 0 ? models[0] : undefined;
              const tokenEstimate = await estimateMultiFileTokens(evidence.files, activeModel, token);

              // 4. Consent boundary: Check if automatic AI analysis is enabled
              const isAutoEnabled = vscode.workspace
                .getConfiguration('originx')
                .get<boolean>('enableAutomaticAnalysis', false);

              if (!isAutoEnabled) {
                const disabledHistoryResult: MultiFileHistoryResult = {
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  explanationStatus: 'disabled'
                };
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  status: 'Git evidence gathered (AI analysis disabled by default)'
                });
                WebviewView.showMultiFileResult(disabledHistoryResult, context.extensionUri);
                vscode.window.showInformationMessage(
                  `ORIGINX: Gathered Git history for ${evidence.files.length} file(s). Automatic AI Analysis is disabled by default. Enable it in Command Center to run AI synthesis.`
                );
                return;
              }

              // 5. Usage Confirmation Webview Panel (shows file count, model, estimated tokens, real checkbox)
              const confirmation = await promptMultiFileUsageConfirmation(
                evidence.files,
                tokenEstimate,
                evidence.truncationWarnings,
                validation.isMixedRepositories
              );

              if (!confirmation.confirmed || confirmation.action === 'cancel') {
                const cancelledHistoryResult: MultiFileHistoryResult = {
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  explanationStatus: 'cancelled'
                };
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  status: 'Cancelled by user at usage confirmation'
                });
                WebviewView.showMultiFileResult(cancelledHistoryResult, context.extensionUri);
                return;
              }

              // 6. Invoke Copilot LM to generate the synthesized cross-file explanation (Phase 4B.2)
              const multiExplainer = new MultiFileExplainer();
              const explainResult = await multiExplainer.explainMultiFileChanges(evidence.files, {
                cancellationToken: token,
                lmModelInstance: activeModel
              });

              const multiHistoryResult: MultiFileHistoryResult = {
                totalReceived: validation.totalReceived,
                eligibleFiles: validation.eligibleFiles,
                excludedFiles: validation.excludedFiles,
                isMixedRepositories: validation.isMixedRepositories,
                evidence,
                tokenEstimate,
                explanationStatus: explainResult.status,
                explanation: explainResult.explanation,
                explanationError: explainResult.error,
                explanationDiagnostics: explainResult.diagnostics
              };

              // 7. Update Output Channel and Webview
              OutputView.showMultiFileSummary({
                totalReceived: validation.totalReceived,
                eligibleFiles: validation.eligibleFiles,
                excludedFiles: validation.excludedFiles,
                isMixedRepositories: validation.isMixedRepositories,
                evidence,
                tokenEstimate,
                explanation: explainResult.explanation,
                status: explainResult.status === 'ok'
                  ? `Completed: ${evidence.files.length} file(s) analyzed with Copilot LM`
                  : `Status: ${explainResult.status} - ${explainResult.error || 'See Output Channel / Webview'}`
              });

              WebviewView.showMultiFileResult(multiHistoryResult, context.extensionUri);

              if (explainResult.status === 'blocked_security') {
                vscode.window.showErrorMessage(
                  `ORIGINX Security Block: ${explainResult.error}`
                );
              } else if (explainResult.status === 'no_model') {
                vscode.window.showWarningMessage(
                  'ORIGINX: No language models available via VS Code Language Model API. Ensure GitHub Copilot is installed and active.'
                );
              } else if (explainResult.status === 'failed') {
                const diagSummary = explainResult.diagnostics
                  ? ` [Category: ${explainResult.diagnostics.category}, Duration: ${(explainResult.diagnostics.durationMs / 1000).toFixed(1)}s]`
                  : '';
                vscode.window.showWarningMessage(
                  `ORIGINX AI Error: ${explainResult.error}${diagSummary}. Local Git history preserved.`
                );
              } else if (explainResult.status === 'ok') {
                vscode.window.setStatusBarMessage(
                  `ORIGINX: Cross-file explanation generated for ${evidence.files.length} file(s) via Copilot LM`,
                  4000
                );
              }
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(`ORIGINX Multi-File Error: ${errMsg}`);
            }
          }
        );
      }
    );

    // Command: ORIGINX: Import Git History to Neo4j Knowledge Graph (Phase 5B)
    const importGitGraphDisposable = vscode.commands.registerCommand(
      'originx.importGitGraph',
      async (clickedUri?: vscode.Uri) => {
        try {
          let targetPath: string | undefined = clickedUri?.fsPath;
          if (!targetPath && vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
          }
          if (!targetPath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            targetPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
          }

          if (!targetPath) {
            vscode.window.showWarningMessage('ORIGINX: Please open a workspace or file to import Git history.');
            return;
          }

          const repoRoot = await findRepoRoot(targetPath);
          if (!repoRoot) {
            vscode.window.showWarningMessage(`ORIGINX: "${path.basename(targetPath)}" is not inside a Git repository.`);
            return;
          }

          const repoInfo = await resolveRepositoryIdentity(repoRoot);
          let totalCommits = 0;
          try {
            const countRes = await runGit(['rev-list', '--count', 'HEAD'], repoRoot);
            if (countRes.exitCode === 0) {
              totalCommits = parseInt(countRes.stdout.trim(), 10) || 0;
            }
          } catch {}

          const maxCommits = Math.min(totalCommits || 50, 50);
          const config = resolveNeo4jConfig();

          const choice = await vscode.window.showInformationMessage(
            `Import Git history for "${repoInfo.name}" into Neo4j AuraDB?\n\nTarget: ${config.uri}\nUser: ${config.username}\nScope: Up to ${maxCommits} commits, changed files, and contributors.\n(Code diffs and secrets are strictly excluded).`,
            { modal: true },
            'Proceed with Import',
            'Cancel'
          );

          if (choice !== 'Proceed with Import') {
            return;
          }

          const secretManager = new SecretManager(context.secrets);
          const authConfig = await getOrPromptNeo4jCredentials(secretManager, config);
          if (!authConfig) {
            return; // User cancelled password prompt
          }

          const excludedDirectories = vscode.workspace
            .getConfiguration('originx')
            .get<string[]>('neo4jExcludedDirectories');

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `ORIGINX: Importing Git history for ${repoInfo.name} into Neo4j AuraDB...`,
              cancellable: true
            },
            async (_progress, token) => {
              try {
                const { commits } = await fetchLocalGitGraphData(repoRoot, maxCommits, {
                  cancellationToken: token,
                  excludedDirectories
                });

                if (token.isCancellationRequested || commits.length === 0) {
                  vscode.window.showInformationMessage('ORIGINX: Git graph import cancelled or no commits found.');
                  return;
                }

                const driver = createNeo4jDriver(authConfig);
                try {
                  const summary = await importGitGraph(driver, repoInfo, commits, {
                    cancellationToken: token,
                    excludedDirectories
                  });

                  OutputView.showGraphImportSummary(summary);

                  if (summary.status === 'ok') {
                    vscode.window.showInformationMessage(
                      `ORIGINX: Successfully processed ${summary.commitsProcessed} commits and ${summary.filesProcessed} files (${summary.databaseCommitCount} repo commits, ${summary.databaseFileCount} repo files in Neo4j) (${(summary.durationMs / 1000).toFixed(1)}s).`
                    );
                  } else if (summary.status === 'cancelled') {
                    vscode.window.showInformationMessage('ORIGINX: Git graph import was cancelled.');
                  } else {
                    vscode.window.showErrorMessage(
                      `ORIGINX Graph Import Error: ${summary.error || 'Unknown error'}. See Output Channel.`
                    );
                  }
                } finally {
                  await driver.close();
                }
              } catch (err: any) {
                const rawMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`ORIGINX Graph Import Error: ${redactSecret(rawMsg)}`);
              }
            }
          );
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ORIGINX Error: ${redactSecret(rawMsg)}`);
        }
      }
    );

    // Command: ORIGINX: Inspect Neo4j Evidence Graph (Phase 5B & 5B.2)
    const inspectGitGraphDisposable = vscode.commands.registerCommand(
      'originx.inspectGitGraph',
      async () => {
        try {
          let targetPath: string | undefined = undefined;
          if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
          } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            targetPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
          }

          let repoId: string | undefined = undefined;
          if (targetPath) {
            try {
              const repoRoot = await findRepoRoot(targetPath);
              if (repoRoot) {
                const repoInfo = await resolveRepositoryIdentity(repoRoot);
                repoId = repoInfo.id;
              }
            } catch {}
          }

          const secretManager = new SecretManager(context.secrets);
          const authConfig = await getOrPromptNeo4jCredentials(secretManager);
          if (!authConfig) {
            return; // User cancelled password prompt
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'ORIGINX: Inspecting Neo4j Evidence Graph...',
              cancellable: false
            },
            async () => {
              const driver = createNeo4jDriver(authConfig);
              try {
                const summary = await inspectGraphEvidence(driver, repoId);
                OutputView.showGraphInspectionSummary(summary);

                if (summary.connected) {
                  const scopeMsg = summary.repositoryScoped
                    ? `Repository "${summary.repositoryScoped.repoName}": ${summary.repositoryScoped.commitCount} commit(s), ${summary.repositoryScoped.fileCount} file(s). Global total: ${summary.globalDatabase.totalCommits} commit(s) across ${summary.globalDatabase.totalRepositories} repo(s).`
                    : `Global Database: ${summary.globalDatabase.totalRepositories} repo(s), ${summary.globalDatabase.totalCommits} commit(s), ${summary.globalDatabase.totalFiles} file(s).`;

                  const choice = await vscode.window.showInformationMessage(
                    `ORIGINX Evidence Graph: ${scopeMsg}`,
                    'Open Output Channel'
                  );
                  if (choice === 'Open Output Channel') {
                    OutputView.getChannel().show(true);
                  }
                } else {
                  vscode.window.showErrorMessage(
                    `ORIGINX Graph Inspection Error: ${summary.error || 'Connection failed'}. See Output Channel.`
                  );
                }
              } finally {
                await driver.close();
              }
            }
          );
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ORIGINX Error: ${redactSecret(rawMsg)}`);
        }
      }
    );

    // Command: ORIGINX: Clean Up Repository Subgraph in Neo4j (Phase 5B.2)
    const pruneGitGraphDisposable = vscode.commands.registerCommand(
      'originx.pruneGitGraph',
      async (clickedUri?: vscode.Uri) => {
        try {
          let targetPath: string | undefined = clickedUri?.fsPath;
          if (!targetPath && vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
          }
          if (!targetPath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            targetPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
          }

          if (!targetPath) {
            vscode.window.showWarningMessage('ORIGINX: Please open a workspace or file to clean up repository graph.');
            return;
          }

          const repoRoot = await findRepoRoot(targetPath);
          if (!repoRoot) {
            vscode.window.showWarningMessage(`ORIGINX: "${path.basename(targetPath)}" is not inside a Git repository.`);
            return;
          }

          const repoInfo = await resolveRepositoryIdentity(repoRoot);
          const secretManager = new SecretManager(context.secrets);
          const authConfig = await getOrPromptNeo4jCredentials(secretManager);
          if (!authConfig) {
            return; // User cancelled password prompt
          }

          // Step 1: Pre-calculate scoped deletion estimate
          const driver = createNeo4jDriver(authConfig);
          let estimate;
          try {
            estimate = await estimateRepositoryPruneCounts(driver, repoInfo.id);
          } finally {
            await driver.close();
          }

          if (estimate.commitsToDelete === 0 && estimate.filesToDelete === 0) {
            vscode.window.showInformationMessage(
              `ORIGINX: No graph data found in Neo4j for repository "${repoInfo.name}" (${repoInfo.id}). Nothing to prune.`
            );
            return;
          }

          // Step 2: Explicit confirmation with target repository and estimated deletion counts
          const confirmChoice = await vscode.window.showWarningMessage(
            `Clean up Neo4j graph data for repository "${repoInfo.name}"?\n\nTarget Repository ID: ${repoInfo.id}\nCommits to delete: ${estimate.commitsToDelete}\nFiles to delete: ${estimate.filesToDelete}\n\nNote: Contributor (Person) nodes and other repositories are preserved. Code diffs and secrets are never stored.`,
            { modal: true },
            'Delete Repository Subgraph',
            'Cancel'
          );

          if (confirmChoice !== 'Delete Repository Subgraph') {
            return;
          }

          // Step 3: Perform scoped cleanup with progress and cancellation support
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `ORIGINX: Cleaning up Neo4j graph for ${repoInfo.name}...`,
              cancellable: true
            },
            async (_progress, token) => {
              const runDriver = createNeo4jDriver(authConfig);
              try {
                const result = await pruneRepositorySubgraph(runDriver, repoInfo.id, {
                  cancellationToken: token
                });

                OutputView.showGraphPruneSummary(result);

                if (result.status === 'ok') {
                  vscode.window.showInformationMessage(
                    `ORIGINX: Successfully pruned ${result.deletedCommits} commits and ${result.deletedFiles} files for "${result.repoName}" from Neo4j.`
                  );
                } else if (result.status === 'cancelled') {
                  vscode.window.showInformationMessage('ORIGINX: Repository graph cleanup was cancelled.');
                } else {
                  vscode.window.showErrorMessage(
                    `ORIGINX Cleanup Error: ${result.error || 'Failed to prune repository graph'}`
                  );
                }
              } finally {
                await runDriver.close();
              }
            }
          );
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ORIGINX Error: ${redactSecret(rawMsg)}`);
        }
      }
    );

    // Command: ORIGINX: Retrieve Neo4j Evidence for Active File (Phase 5C.1)
    const retrieveFileEvidenceDisposable = vscode.commands.registerCommand(
      'originx.retrieveFileEvidence',
      async (clickedUri?: vscode.Uri) => {
        try {
          let targetPath: string | undefined = clickedUri?.fsPath;
          if (!targetPath && vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
          }

          if (!targetPath) {
            vscode.window.showWarningMessage('ORIGINX: Please open an active file in the editor or right-click a file to retrieve Neo4j evidence.');
            return;
          }

          const repoRoot = await findRepoRoot(targetPath);
          if (!repoRoot) {
            vscode.window.showWarningMessage(`ORIGINX: "${path.basename(targetPath)}" is not inside a Git repository.`);
            return;
          }

          const repoInfo = await resolveRepositoryIdentity(repoRoot);
          const relativePath = path.relative(repoRoot, targetPath).replace(/\\/g, '/');

          const secretManager = new SecretManager(context.secrets);
          const authConfig = await getOrPromptNeo4jCredentials(secretManager);
          if (!authConfig) {
            return; // User cancelled password prompt
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `ORIGINX: Retrieving Neo4j evidence for ${path.basename(targetPath)}...`,
              cancellable: false
            },
            async () => {
              const driver = createNeo4jDriver(authConfig);
              try {
                const result = await retrieveFileEvidence(driver, repoInfo.id, relativePath);
                OutputView.showFileEvidence(result);

                if (result.status === 'ok') {
                  const msg = result.commits.length > 0
                    ? `ORIGINX: Retrieved ${result.commits.length} historical commit(s) for "${relativePath}" from Neo4j.`
                    : `ORIGINX: No historical commits found in Neo4j for "${relativePath}".`;
                  const choice = await vscode.window.showInformationMessage(msg, 'Open Output Channel');
                  if (choice === 'Open Output Channel') {
                    OutputView.getChannel().show(true);
                  }
                } else {
                  vscode.window.showErrorMessage(
                    `ORIGINX Evidence Retrieval Error: ${result.error || 'Failed to retrieve evidence'}. See Output Channel.`
                  );
                }
              } finally {
                await driver.close();
              }
            }
          );
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ORIGINX Error: ${redactSecret(rawMsg)}`);
        }
      }
    );

    // Command: ORIGINX: Manage Neo4j Database Credentials (Phase 5B)
    const manageNeo4jCredentialsDisposable = vscode.commands.registerCommand(
      'originx.manageNeo4jCredentials',
      async () => {
        try {
          const secretManager = new SecretManager(context.secrets);
          const hasStored = await secretManager.hasNeo4jPassword();
          const currentConfig = resolveNeo4jConfig();

          const choice = await vscode.window.showQuickPick(
            [
              {
                id: 'username',
                label: `$(person) Set Neo4j Username (Current: "${currentConfig.username}")`,
                description: 'Configure username in ORIGINX settings'
              },
              {
                id: 'store',
                label: hasStored ? '$(edit) Update Stored Neo4j Password' : '$(key) Store Neo4j Password in SecretStorage',
                description: hasStored ? 'Replace currently saved AuraDB password' : 'Save password securely for future sessions'
              },
              {
                id: 'clear',
                label: '$(trash) Clear Stored Neo4j Password',
                description: hasStored ? 'Remove saved password from VS Code SecretStorage' : '(No password stored)'
              },
              {
                id: 'test',
                label: `$(plug) Test Neo4j AuraDB Connection (as "${currentConfig.username}")`,
                description: 'Verify connection using RETURN 1 AS success'
              }
            ],
            {
              title: 'ORIGINX: Manage Neo4j Credentials',
              placeHolder: 'Select a credential management action...'
            }
          );

          if (!choice) return;

          if (choice.id === 'username') {
            const enteredUser = await vscode.window.showInputBox({
              title: 'ORIGINX: Configure Neo4j Username',
              prompt: 'Enter username for Neo4j AuraDB database authentication',
              value: currentConfig.username,
              ignoreFocusOut: true
            });
            if (enteredUser && enteredUser.trim().length > 0) {
              await vscode.workspace
                .getConfiguration('originx')
                .update('neo4jUsername', enteredUser.trim(), vscode.ConfigurationTarget.Global);
              vscode.window.showInformationMessage(`ORIGINX: Neo4j username set to "${enteredUser.trim()}".`);
            }
          } else if (choice.id === 'store') {
            const entered = await vscode.window.showInputBox({
              password: true,
              ignoreFocusOut: true,
              title: 'ORIGINX: Store Neo4j Password',
              prompt: `Enter the Neo4j AuraDB password for user "${currentConfig.username}" to save in VS Code SecretStorage`,
              placeHolder: 'Password'
            });
            if (entered && entered.trim().length > 0) {
              await secretManager.storeNeo4jPassword(entered.trim());
              vscode.window.showInformationMessage('ORIGINX: Neo4j password saved securely in SecretStorage.');
            }
          } else if (choice.id === 'clear') {
            await clearStoredNeo4jPassword(secretManager);
          } else if (choice.id === 'test') {
            const config = await getOrPromptNeo4jCredentials(secretManager);
            if (config) {
              const res = await verifyConnection(config);
              if (res.connected) {
                vscode.window.showInformationMessage(
                  `ORIGINX: Neo4j AuraDB connected as "${config.username}" (${res.durationMs}ms)! ${res.serverVersion || ''}`
                );
              } else {
                vscode.window.showErrorMessage(
                  `ORIGINX Connection Test Failed for user "${config.username}": ${res.error}`
                );
              }
            }
          }
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ORIGINX Error: ${redactSecret(rawMsg)}`);
        }
      }
    );

    context.subscriptions.push(
      commandCenterDisposable,
      listVsCodeModelsDisposable,
      enableAutoDisposable,
      disableAutoDisposable,
      inspectPayloadDisposable,
      explainDisposable,
      explainMultiDisposable,
      importGitGraphDisposable,
      inspectGitGraphDisposable,
      retrieveFileEvidenceDisposable,
      pruneGitGraphDisposable,
      manageNeo4jCredentialsDisposable
    );
  } catch (activationErr) {
    const errMsg =
      activationErr instanceof Error ? activationErr.message : String(activationErr);
    console.error('[ORIGINX] Activation failed:', activationErr);
    vscode.window.showErrorMessage(`ORIGINX Activation Error: ${errMsg}`);
  }
}

export async function deactivate() {
  OutputView.dispose();
  WebviewView.dispose();
  await closeNeo4jDriver();
}
