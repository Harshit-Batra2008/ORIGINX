import * as path from 'path';
import * as vscode from 'vscode';
import { GeminiExplainer } from './gemini/geminiExplainer';
import { getHistoryForSelection } from './git/gitService';
import { SelectionContext } from './git/gitTypes';
import { getAvailableVsCodeModels } from './lm/vscodeLmClient';
import { estimateMultiFileTokens, promptMultiFileUsageConfirmation } from './multiFile/multiFileConfirmation';
import { gatherMultiFileGitEvidence } from './multiFile/multiFileService';
import { validateMultiFileSelection } from './multiFile/multiFileValidator';
import { migrateAndPurgeLegacySecrets } from './security/secretManager';
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
        const promptVariant =
          vscode.workspace.getConfiguration('originx').get<'compact' | 'standard'>('promptVariant', 'compact');
        const payload = explainer.buildInspectionPayload(
          selectionContext,
          result.commits,
          result.uncommittedDiff,
          undefined,
          promptVariant
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

              // 2. If Git evidence exists, check automatic AI analysis setting
              if (result.status === 'ok' && result.commits.length > 0) {
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
                      cancellationToken: token
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
                    ? `ORIGINX: Retrieved ${result.commits.length} commit(s) + Copilot LM explanation`
                    : `ORIGINX: Found ${result.commits.length} commit(s) for selected lines`;
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
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  status: 'Git evidence gathered (AI analysis disabled by default)'
                });
                vscode.window.showInformationMessage(
                  `ORIGINX: Gathered Git history for ${evidence.files.length} file(s). Automatic AI Analysis is disabled by default. Enable it in Command Center to run AI synthesis.`
                );
                return;
              }

              // 5. Usage Confirmation Dialog (shows file count, model, estimated tokens, warnings)
              const confirmation = await promptMultiFileUsageConfirmation(
                evidence.files,
                tokenEstimate,
                evidence.truncationWarnings,
                validation.isMixedRepositories
              );

              if (!confirmation.confirmed || confirmation.action === 'cancel') {
                OutputView.showMultiFileSummary({
                  totalReceived: validation.totalReceived,
                  eligibleFiles: validation.eligibleFiles,
                  excludedFiles: validation.excludedFiles,
                  isMixedRepositories: validation.isMixedRepositories,
                  evidence,
                  tokenEstimate,
                  status: 'Cancelled by user at usage confirmation'
                });
                return;
              }

              // 6. Phase 4B.1 milestone completion
              OutputView.showMultiFileSummary({
                totalReceived: validation.totalReceived,
                eligibleFiles: validation.eligibleFiles,
                excludedFiles: validation.excludedFiles,
                isMixedRepositories: validation.isMixedRepositories,
                evidence,
                tokenEstimate,
                status: 'Phase 4B.1 Verified: Ready for Phase 4B.2 cross-file AI synthesis'
              });

              vscode.window.showInformationMessage(
                `ORIGINX: Verified multi-file analysis for ${evidence.files.length} file(s) (~${tokenEstimate.estimatedTokens.toLocaleString()} tokens). Ready for Phase 4B.2 synthesis.`
              );
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(`ORIGINX Multi-File Error: ${errMsg}`);
            }
          }
        );
      }
    );

    context.subscriptions.push(
      commandCenterDisposable,
      listVsCodeModelsDisposable,
      enableAutoDisposable,
      disableAutoDisposable,
      inspectPayloadDisposable,
      explainDisposable,
      explainMultiDisposable
    );
  } catch (activationErr) {
    const errMsg =
      activationErr instanceof Error ? activationErr.message : String(activationErr);
    console.error('[ORIGINX] Activation failed:', activationErr);
    vscode.window.showErrorMessage(`ORIGINX Activation Error: ${errMsg}`);
  }
}

export function deactivate() {
  OutputView.dispose();
  WebviewView.dispose();
}
