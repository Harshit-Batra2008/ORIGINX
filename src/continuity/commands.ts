import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AskWhyWebviewController,
  GitWhisperSidebarProvider,
  executeAskWhy,
  getLastAskWhyResult,
} from '../askWhy';
import { CheckpointStorage, CheckpointWebviewController } from '../contextCheckpoint';
import { createCheckpointRetriever } from '../contextCheckpoint/checkpointRetrievalService';
import { collectCheckpointTargets } from '../context/checkpointTargets';
import { DecisionWebviewController, discoverHistoricalEvidence } from '../decisionMemory';
import { findRepoRoot } from '../git/gitService';
import { isSourceTarget } from '../git/sourcePaths';
import { redactSecret } from '../neo4j/neo4jEnv';
import { getOrCreateDriver, resolveNeo4jConfig } from '../neo4j/neo4jService';
import { SecretManager } from '../security/secretManager';
import { showContinuityMenu } from '../ui/commandCenter';
import { selectRepositoryPath } from '../ui/repositorySelection';
import { FunctionIntelligenceService } from '../codeIntelligence/functionIntelligenceService';
import { RoleAndImpactWebviewController } from '../codeIntelligence/roleAndImpactWebview';
import { RequirementsAuditor } from '../requirementsAudit/requirementsAuditor';
import { RequirementsAuditWebviewController } from '../requirementsAudit/requirementsAuditWebview';
import { FunctionEvolutionService } from '../evolution/functionEvolutionService';
import { FunctionEvolutionWebviewController } from '../evolution/evolutionWebview';
import { ExplainCodeService } from '../explainCode/explainCodeService';

export interface CapturedEditorContext {
  filePath: string;
  startLine: number;
  endLine: number;
  selectedSnippet: string;
}

/**
 * Captures editor selection context immediately before any focus change or input box display.
 */
export function captureCurrentEditorContext(): CapturedEditorContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }

  const doc = editor.document;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty && (sel.start.line !== sel.end.line || sel.start.character !== sel.end.character);

  let startLine: number;
  let endLine: number;
  let selectedSnippet: string;

  if (hasSelection) {
    startLine = sel.start.line + 1;
    endLine = sel.end.line + 1;
    if (sel.end.character === 0 && sel.end.line > sel.start.line) {
      endLine = sel.end.line;
    }
    selectedSnippet = doc.getText(
      new vscode.Range(
        new vscode.Position(startLine - 1, 0),
        new vscode.Position(endLine - 1, doc.lineAt(endLine - 1).text.length)
      )
    );
  } else {
    // Single-line cursor
    startLine = sel.active.line + 1;
    endLine = sel.active.line + 1;
    selectedSnippet = doc.lineAt(sel.active.line).text;
  }

  return {
    filePath: doc.uri.fsPath,
    startLine,
    endLine,
    selectedSnippet,
  };
}

export function registerContinuityCommands(
  context: vscode.ExtensionContext,
  sidebarProvider?: GitWhisperSidebarProvider
): void {
  const storage = new CheckpointStorage();
  const retrieve = createCheckpointRetriever(new SecretManager(context.secrets));

  async function inRepository(action: (root: string) => Promise<void>): Promise<void> {
    try {
      const target = await selectRepositoryPath();
      if (!target && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) return;
      const root = target && await findRepoRoot(target);
      if (!root) {
        void vscode.window.showWarningMessage('GitWhisper: Open a file or workspace folder in a Git repository.');
        return;
      }
      await action(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage('GitWhisper: ' + redactSecret(message));
    }
  }

  async function discoverDecisions(root: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file' || !isSourceTarget(path.relative(root, editor.document.uri.fsPath))) {
      void vscode.window.showWarningMessage('GitWhisper: Open a source file to discover historical decisions.');
      return;
    }
    const file = editor.document.uri.fsPath;
    const { selection } = editor;
    const lineRange = selection.isEmpty ? undefined : {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1
    };
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'GitWhisper: Discovering decisions for ' + path.basename(file),
      cancellable: true
    }, async (_progress, token) => {
      const evidence = await discoverHistoricalEvidence(root, file, { lineRange, cancellationToken: token });
      if (evidence.status !== 'cancelled') {
        await DecisionWebviewController.show(context, evidence, undefined, 'discovery');
      }
    });
  }

  async function saveContext(root: string): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const activeFile = uri?.scheme === 'file' ? path.relative(root, uri.fsPath) : undefined;
    const [checkpoints, targets] = await Promise.all([
      storage.listCheckpoints(root),
      collectCheckpointTargets(root, activeFile)
    ]);
    await CheckpointWebviewController.show(context, root, 'save', undefined, checkpoints, targets, retrieve);
  }

  async function resumeContext(root: string): Promise<void> {
    const checkpoints = await storage.listCheckpoints(root);
    const latest = checkpoints[0];
    const resumed = latest && await retrieve(root, latest);
    await CheckpointWebviewController.show(context, root, 'resume', resumed, checkpoints, undefined, retrieve);
  }

  async function askWhyWithContext(
    root: string,
    captured: CapturedEditorContext,
    initialQuestion?: string
  ): Promise<void> {
    const promptTitle = captured.startLine === captured.endLine
      ? `GitWhisper: Ask Why (${path.basename(captured.filePath)} L${captured.startLine})`
      : `GitWhisper: Ask Why (${path.basename(captured.filePath)} L${captured.startLine}-L${captured.endLine})`;

    const defaultQuestion = 'Why is this code implemented this way?';

    const question = initialQuestion || await vscode.window.showInputBox({
      title: promptTitle,
      prompt: 'Ask why this code exists, why it was changed, or what constraints govern it',
      value: defaultQuestion,
      ignoreFocusOut: true,
    });

    if (!question) {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `GitWhisper: Asking Why for ${path.basename(captured.filePath)}...`,
      cancellable: true,
    }, async (_progress, token) => {
      let neo4jDriver: any = undefined;
      try {
        const secretManager = new SecretManager(context.secrets);
        const storedPassword = await secretManager.getNeo4jPassword();
        const activePassword =
          (process.env.NEO4J_PASSWORD && process.env.NEO4J_PASSWORD.trim()) ||
          (storedPassword && storedPassword.trim());

        if (activePassword) {
          const authConfig = resolveNeo4jConfig({ password: activePassword });
          neo4jDriver = getOrCreateDriver(authConfig);
        }
      } catch (driverErr) {
        console.warn('[GitWhisper] Neo4j connection initialization skipped:', driverErr);
      }

      const result = await executeAskWhy({
        repoRoot: root,
        filePath: captured.filePath,
        question,
        lineRange: { startLine: captured.startLine, endLine: captured.endLine },
        selectedSnippet: captured.selectedSnippet,
        cancellationToken: token,
        neo4jService: neo4jDriver,
      });

      if (sidebarProvider) {
        sidebarProvider.showResult(result);
      } else {
        await AskWhyWebviewController.showFullInvestigation(context, result);
      }
    });
  }

  async function askWhy(root: string, initialQuestion?: string): Promise<void> {
    const captured = captureCurrentEditorContext();
    if (!captured) {
      void vscode.window.showWarningMessage('GitWhisper: Open a file to ask why it was implemented this way.');
      return;
    }
    await askWhyWithContext(root, captured, initialQuestion);
  }

  async function handleUnderstandAndContinue(): Promise<void> {
    const captured = captureCurrentEditorContext();
    if (captured) {
      const root = await findRepoRoot(captured.filePath);
      if (root) {
        const promptTitle = captured.startLine === captured.endLine
          ? `GitWhisper: Ask Why (${path.basename(captured.filePath)} L${captured.startLine})`
          : `GitWhisper: Ask Why (${path.basename(captured.filePath)} L${captured.startLine}-L${captured.endLine})`;

        const defaultQuestion = 'Why is this code implemented this way?';

        const question = await vscode.window.showInputBox({
          title: promptTitle,
          prompt: 'Press Enter to ask why this code is like this, type your own question, or press Escape for menu',
          value: defaultQuestion,
          ignoreFocusOut: false,
        });

        if (question) {
          await askWhyWithContext(root, captured, question);
          return;
        }
      }
    }

    // If cancelled, escaped, or no file open, show the Continuity Menu
    await showContinuityMenu(context);
  }

  async function explainRoleAndImpact(): Promise<void> {
    const captured = captureCurrentEditorContext();
    if (!captured) {
      void vscode.window.showWarningMessage('GitWhisper: Open a source file to analyze function role and impact.');
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `GitWhisper: Analyzing Function Role & Impact for ${path.basename(captured.filePath)}...`,
      cancellable: false
    }, async () => {
      const service = new FunctionIntelligenceService();
      const result = await service.analyzeFunctionRoleAndImpact(captured.filePath, captured.startLine);
      await RoleAndImpactWebviewController.show(context, result);
    });
  }

  async function auditRequirements(root: string): Promise<void> {
    const defaultCandidates = ['PRD.md', 'TASKS.md', 'REQUIREMENTS.md', 'docs/PRD.md', 'docs/architecture.md'];
    const foundFiles: string[] = [];
    for (const cand of defaultCandidates) {
      const fp = path.join(root, cand);
      if (fs.existsSync(fp)) {
        foundFiles.push(cand);
      }
    }

    const quickPickItems: Array<vscode.QuickPickItem & { action: string; filePath?: string }> = [];
    for (const f of foundFiles) {
      quickPickItems.push({
        label: `$(file) Audit ${f}`,
        description: `Use workspace requirement document ${f}`,
        action: 'file',
        filePath: path.join(root, f)
      });
    }

    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && (activeDoc.fileName.endsWith('.md') || activeDoc.fileName.endsWith('.txt'))) {
      quickPickItems.push({
        label: '$(edit) Audit Active Editor Content',
        description: `Audit requirements in ${path.basename(activeDoc.fileName)}`,
        action: 'active'
      });
    }

    quickPickItems.push({
      label: '$(file-code) Choose Another Document...',
      description: 'Select any Markdown or text PRD / Tasks file',
      action: 'browse'
    });

    quickPickItems.push({
      label: '$(pencil) Paste Numbered Requirements / Checklist...',
      description: 'Paste requirement text directly',
      action: 'paste'
    });

    const chosen = await vscode.window.showQuickPick(quickPickItems, {
      title: 'GitWhisper: Select PRD / Requirements Source to Audit',
      placeHolder: 'Choose a PRD file or paste checklist requirements'
    });

    if (!chosen) return;

    let contentToAudit = '';
    if (chosen.action === 'file' && chosen.filePath) {
      contentToAudit = fs.readFileSync(chosen.filePath, 'utf8');
    } else if (chosen.action === 'active' && activeDoc) {
      contentToAudit = activeDoc.getText();
    } else if (chosen.action === 'browse') {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Markdown / Text': ['md', 'txt', 'markdown'] },
        title: 'Select PRD or TASKS.md file'
      });
      if (uris && uris.length > 0) {
        contentToAudit = fs.readFileSync(uris[0].fsPath, 'utf8');
      }
    } else if (chosen.action === 'paste') {
      const pasted = await vscode.window.showInputBox({
        title: 'GitWhisper: Paste Numbered Requirements or Checklist',
        prompt: 'e.g. "1. Scope preservation \\n 2. Neo4j GraphRAG \\n 3. Ask Why citations"',
        placeHolder: 'Enter requirements...'
      });
      if (pasted) contentToAudit = pasted;
    }

    if (!contentToAudit || !contentToAudit.trim()) return;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'GitWhisper: Auditing Requirements against codebase...',
      cancellable: false
    }, async () => {
      const auditor = new RequirementsAuditor();
      const parsed = auditor.parseRequirements(contentToAudit);
      const report = await auditor.auditWorkspace(parsed, root);
      await RequirementsAuditWebviewController.show(context, report, () => auditRequirements(root));
    });
  }

  async function functionEvolution(): Promise<void> {
    const captured = captureCurrentEditorContext();
    if (!captured) {
      void vscode.window.showWarningMessage('GitWhisper: Open a source file to trace function evolution.');
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `GitWhisper: Tracing Multi-PR Evolution for ${path.basename(captured.filePath)}...`,
      cancellable: false
    }, async () => {
      const service = new FunctionEvolutionService();
      const timeline = await service.traceFunctionEvolution(
        captured.filePath,
        captured.startLine,
        captured.endLine
      );
      await FunctionEvolutionWebviewController.show(context, timeline);
    });
  }

  async function explainCode(): Promise<void> {
    const captured = captureCurrentEditorContext();
    if (!captured) {
      void vscode.window.showWarningMessage('GitWhisper: Open a source file and select code to explain.');
      return;
    }
    const doc = vscode.window.activeTextEditor?.document;
    const service = new ExplainCodeService();
    const result = service.explainCode({
      filePath: captured.filePath,
      startLine: captured.startLine,
      endLine: captured.endLine,
      selectedCode: captured.selectedSnippet,
      fileContent: doc ? doc.getText() : undefined
    });

    const choice = await vscode.window.showInformationMessage(
      `GitWhisper: Explain Code (${path.basename(result.filePath)}:${result.startLine})\n\n${result.syntaxSummary}`,
      'Ask Why (Historical Rationale)',
      'Explain Role & Impact'
    );
    if (choice === 'Ask Why (Historical Rationale)') {
      void vscode.commands.executeCommand('originx.askWhy');
    } else if (choice === 'Explain Role & Impact') {
      void vscode.commands.executeCommand('originx.explainRoleAndImpact');
    }
  }

  const openMenu = () => showContinuityMenu(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('originx.understandAndContinue', handleUnderstandAndContinue),
    vscode.commands.registerCommand('originx.askWhy', () => inRepository(askWhy)),
    vscode.commands.registerCommand('originx.openFullInvestigation', async () => {
      const last = getLastAskWhyResult();
      if (last) {
        await AskWhyWebviewController.showFullInvestigation(context, last);
      } else {
        void vscode.window.showInformationMessage('GitWhisper: No active investigation yet. Select code and Ask Why first.');
      }
    }),
    vscode.commands.registerCommand('originx.explainRoleAndImpact', explainRoleAndImpact),
    vscode.commands.registerCommand('originx.auditRequirements', () => inRepository(auditRequirements)),
    vscode.commands.registerCommand('originx.explainCode', explainCode),
    vscode.commands.registerCommand('originx.functionEvolution', functionEvolution),
    vscode.commands.registerCommand('originx.commandCenter', openMenu),
    vscode.commands.registerCommand('originx.discoverDecisions', () => inRepository(discoverDecisions)),
    vscode.commands.registerCommand('originx.manageDecisions', () => inRepository(async root => { await DecisionWebviewController.showStored(context, root); })),
    vscode.commands.registerCommand('originx.saveContextCheckpoint', () => inRepository(saveContext)),
    vscode.commands.registerCommand('originx.resumeContextCheckpoint', () => inRepository(resumeContext))
  );
}
