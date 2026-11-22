import type * as vscode from 'vscode';
import { getAvailableVsCodeModels } from '../lm/vscodeLmClient';
import { isGitWhisperPath } from '../git/sourcePaths';
import { OutputView } from './outputView';

function getVsCode(): typeof vscode | undefined {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

const SEPARATOR_KIND = -1; // Corresponds to vscode.QuickPickItemKind.Separator

type MenuPage = 'home' | 'tools' | 'models' | 'diagnostics' | 'environment' | 'output' | 'toggleConfirmation';

interface Action extends vscode.QuickPickItem {
  command?: string;
  page?: MenuPage;
}

interface SubmenuItem extends vscode.QuickPickItem {
  isBack?: boolean;
  modelId?: string;
  openChannel?: boolean;
}

export function getContinuityItems(hasSourceFile: boolean): Action[] {
  const items: Action[] = [];
  if (hasSourceFile) {
    items.push({
      label: '$(question) Ask Why: Why The Code Is Like This',
      description: 'Ask any question about this code with historical evidence',
      command: 'originx.askWhy'
    });
    items.push({
      label: '$(circuit-board) Explain Role & Impact',
      description: 'Callers, references, blast radius, and test citations',
      command: 'originx.explainRoleAndImpact'
    });
    items.push({
      label: '$(git-commit) Multi-PR Function Evolution',
      description: 'Trace origin, fixes, refactors, and supersessions across PRs',
      command: 'originx.functionEvolution'
    });
    items.push({
      label: '$(code) Explain Code (What & How)',
      description: 'Source-grounded structural explanation of behavior',
      command: 'originx.explainCode'
    });
    items.push({
      label: '$(checklist) Audit PRD / Tasks vs Build',
      description: 'Compare PRD requirements against code and test evidence',
      command: 'originx.auditRequirements'
    });
  }
  items.push({
    label: 'Review unfinished changes',
    description: 'Inspect staged, unstaged and untracked work',
    command: 'originx.reviewWorkingTree'
  });
  if (hasSourceFile) {
    items.push({
      label: 'Understand this code',
      description: 'Review Git evidence with optional VS Code model analysis',
      command: 'originx.analyzeCode'
    });
  }
  return [...items,
    { label: 'Resume Context', description: 'Reopen a handoff with its tasks, decisions and related files', command: 'originx.resumeContextCheckpoint' },
    { label: 'Save Context', description: 'Record progress, constraints and next steps', command: 'originx.saveContextCheckpoint' },
    { label: 'View Historical Decisions', description: 'Read decisions saved in this repository', command: 'originx.manageDecisions' },
    { label: 'History, graph and settings…', page: 'tools' }
  ];
}

export function getToolItems(automatic: boolean, confirmMultiFile = true): Action[] {
  return [
    { label: '$(arrow-left) Back to Understand & Continue', page: 'home' },
    { label: 'History and investigation', kind: SEPARATOR_KIND },
    { label: 'Discover decisions for the current file', command: 'originx.discoverDecisions' },
    { label: 'Why was this selection changed?', command: 'originx.whyWasThisChanged' },
    { label: 'Why were these files changed?', description: 'Use with files selected in the Explorer', command: 'originx.whyWereTheseChanged' },
    { label: 'Investigate a bug', command: 'originx.investigateBug' },
    { label: 'Neo4j evidence graph', kind: SEPARATOR_KIND },
    { label: 'Import Git history', command: 'originx.importGitGraph' },
    { label: 'Inspect the graph', command: 'originx.inspectGitGraph' },
    { label: 'Retrieve evidence for the current file', command: 'originx.retrieveFileEvidence' },
    { label: 'Manage Neo4j credentials', command: 'originx.manageNeo4jCredentials' },
    { label: 'Clean up this repository’s graph', command: 'originx.pruneGitGraph' },
    { label: 'AI and diagnostics', kind: SEPARATOR_KIND },
    automatic
      ? { label: 'Disable automatic AI analysis', command: 'originx.disableAutomaticAnalysis' }
      : { label: 'Enable automatic AI analysis', command: 'originx.enableAutomaticAnalysis' },
    { label: 'Confirm multi-file requests', description: confirmMultiFile ? 'On' : 'Off', page: 'toggleConfirmation' },
    { label: 'Available language models', page: 'models' },
    { label: 'Inspect outgoing AI payload', command: 'originx.inspectPayload' },
    { label: 'Technical diagnostics', page: 'diagnostics' },
    { label: 'Open GitWhisper output', page: 'output' },
    { label: 'Environment and version', page: 'environment' }
  ];
}

/**
 * Builds the submenu items for Discovered VS Code Language Models.
 */
export function getModelSubmenuItems(models: any[]): SubmenuItem[] {
  const items: SubmenuItem[] = [
    {
      label: '$(arrow-left) Back to history, graph and settings',
      description: 'Return to GitWhisper tools',
      isBack: true
    },
    {
      label: 'DISCOVERED VS CODE LANGUAGE MODELS',
      kind: SEPARATOR_KIND
    }
  ];

  if (!models || models.length === 0) {
    items.push({
      label: '$(warning) No Language Models Available',
      description: 'Ensure GitHub Copilot or Copilot Chat is installed and enabled.',
      detail: 'Check the Output Channel for discovery guidance.'
    });
  } else {
    for (const m of models) {
      items.push({
        label: `$(hubot) ${m.name || m.id}`,
        description: `Vendor: ${m.vendor || 'vscode'} | Family: ${m.family || m.id}`,
        detail: `Max input tokens: ${m.maxInputTokens ? m.maxInputTokens.toLocaleString() : 'Dynamic'}`,
        modelId: m.id
      });
    }
  }

  return items;
}

/**
 * Builds the submenu items for Technical Diagnostics.
 */
export function getDiagnosticsSubmenuItems(
  isAutoAnalysis: boolean,
  promptVariant: string,
  showMultiFileConfirmation: boolean = true,
  legacyKeyPurged = false
): SubmenuItem[] {
  return [
    {
      label: '$(arrow-left) Back to history, graph and settings',
      description: 'Return to GitWhisper tools',
      isBack: true
    },
    {
      label: 'ACTIVE CONFIGURATION & TELEMETRY',
      kind: SEPARATOR_KIND
    },
    {
      label: '$(server) AI Provider',
      description: 'Native VS Code Language Model API (vscode.lm)',
      detail: 'Copilot-native: zero external API keys stored or required'
    },
    {
      label: '$(zap) Automatic Analysis',
      description: isAutoAnalysis ? 'ENABLED' : 'DISABLED (default)',
      detail: 'Controls whether right-clicking automatically invokes Copilot'
    },
    {
      label: '$(symbol-keyword) Prompt Variant',
      description: promptVariant,
      detail: 'Compact variant targets <350 input tokens for fast, economical inference'
    },
    {
      label: '$(bell) Multi-File Confirmation',
      description: showMultiFileConfirmation ? 'ENABLED (Always prompt)' : 'SUPPRESSED (Auto-proceed)',
      detail: 'Controls usage and token estimation dialog before multi-file operations'
    },
    {
      label: '$(shield) Credential Redaction & Security',
      description: 'ACTIVE',
      detail: 'Scans for tokens & keys; strictly halts request on sensitive credentials'
    },
    {
      label: '$(lock) Legacy Gemini Credentials',
      description: legacyKeyPurged ? 'PURGED & VERIFIED' : 'Verification pending',
      detail: 'Checked during extension activation'
    },
    {
      label: '$(output) View Complete Stream in Output Channel',
      description: 'Focus Output Channel for full request lifecycle logs',
      openChannel: true
    }
  ];
}

/**
 * Builds the submenu items for Environment & Runtime Information.
 */
export function getEnvironmentSubmenuItems(info?: {
  extensionVersion?: string;
  vsCodeVersion?: string;
  nodeVersion?: string;
  platformArch?: string;
  isLmSupported?: boolean;
}): SubmenuItem[] {
  const isLmSupported = info?.isLmSupported ?? true;
  const vsCodeVersion = info?.vsCodeVersion || 'Unknown';
  const nodeVersion = info?.nodeVersion || process.version;
  const platformArch = info?.platformArch || `${process.platform} (${process.arch})`;

  return [
    {
      label: '$(arrow-left) Back to history, graph and settings',
      description: 'Return to GitWhisper tools',
      isBack: true
    },
    {
      label: 'EXTENSION & RUNTIME INFORMATION',
      kind: SEPARATOR_KIND
    },
    {
      label: '$(package) GitWhisper Version',
      description: info?.extensionVersion || 'Unknown',
      detail: 'Evidence-backed code history explainer for VS Code'
    },
    {
      label: '$(vscode) VS Code Host',
      description: vsCodeVersion,
      detail: 'Extension API host environment'
    },
    {
      label: '$(terminal) Node.js Runtime',
      description: nodeVersion,
      detail: 'VS Code Extension Host execution runtime'
    },
    {
      label: '$(device-desktop) Platform Architecture',
      description: platformArch,
      detail: 'Operating system platform and CPU architecture'
    },
    {
      label: isLmSupported ? '$(check) VS Code LM API (vscode.lm)' : '$(warning) VS Code LM API',
      description: isLmSupported ? 'Available & Active' : 'Not Available (requires VS Code 1.90+)',
      detail: 'Used for dynamic model discovery and streaming explanation generation'
    }
  ];
}

export async function showContinuityMenu(context: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) return;
  const uri = vs.window.activeTextEditor?.document.uri;
  const hasSourceFile = uri?.scheme === 'file' && !isGitWhisperPath(uri.fsPath);
  const choice = await vs.window.showQuickPick(getContinuityItems(hasSourceFile), {
    title: 'GitWhisper: Understand & Continue',
    placeHolder: 'Choose how to pick up the work',
    matchOnDescription: true
  });
  if (choice?.command) {
    await vs.commands.executeCommand(choice.command);
  } else if (choice?.page === 'tools') {
    await showTools(context);
  }
}

async function showTools(context: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) return;
  const config = vs.workspace.getConfiguration('originx');
  const confirm = config.get<boolean>('showMultiFileConfirmation', true);
  const automatic = config.get<boolean>('enableAutomaticAnalysis', false);
  const choice = await vs.window.showQuickPick(getToolItems(automatic, confirm), {
    title: 'GitWhisper: History, graph and settings',
    matchOnDescription: true
  });
  if (choice?.command) {
    await vs.commands.executeCommand(choice.command);
    return;
  }
  switch (choice?.page) {
    case 'home': return showContinuityMenu(context);
    case 'models': return showModelsSubmenu(context);
    case 'diagnostics': return showDiagnosticsSubmenu(context);
    case 'environment': return showEnvironmentSubmenu(context);
    case 'output': OutputView.getChannel().show(true); break;
    case 'toggleConfirmation':
      await config.update('showMultiFileConfirmation', !confirm, vs.ConfigurationTarget.Global);
      await vs.window.showInformationMessage(confirm ? 'Multi-file confirmation disabled.' : 'Multi-file confirmation enabled.');
      break;
  }
}

/**
 * Submenu: Available AI Models (vscode.lm) with Back navigation.
 */
export async function showModelsSubmenu(context: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) {
    return;
  }

  let models: any[] = [];
  try {
    models = await getAvailableVsCodeModels();
    OutputView.showVsCodeModels(models);
  } catch {
    models = [];
  }

  const items = getModelSubmenuItems(models);

  const selection = await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Available AI Models (vscode.lm)',
    placeHolder: 'Available language models registered in VS Code...',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!selection) {
    return;
  }

  if (selection.isBack) {
    await showTools(context);
  } else if (selection.modelId) {
    OutputView.getChannel().show(true);
  }
}

/**
 * Submenu: Technical Diagnostics with Back navigation.
 */
export async function showDiagnosticsSubmenu(context: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) {
    return;
  }

  const isAutoAnalysis = vs.workspace
    .getConfiguration('originx')
    .get('enableAutomaticAnalysis', false);
  const promptVariant = vs.workspace
    .getConfiguration('originx')
    .get('promptVariant', 'compact');
  const showMultiConfirm = vs.workspace
    .getConfiguration('originx')
    .get('showMultiFileConfirmation', true);

  const items = getDiagnosticsSubmenuItems(isAutoAnalysis, promptVariant, showMultiConfirm, context.globalState.get('originx.legacyGeminiKeyPurged', false));

  const selection = await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Technical Diagnostics & Status',
    placeHolder: 'Inspect active diagnostics or return to tools...',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!selection) {
    return;
  }

  if (selection.isBack) {
    await showTools(context);
  } else if (selection.openChannel) {
    OutputView.getChannel().show(true);
  }
}

/**
 * Submenu: Extension Version & Environment Information with Back navigation.
 */
export async function showEnvironmentSubmenu(context: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) {
    return;
  }

  const isLmSupported =
    typeof vs.lm !== 'undefined' &&
    typeof vs.lm.selectChatModels === 'function';

  const items = getEnvironmentSubmenuItems({
    extensionVersion: context.extension.packageJSON.version,
    vsCodeVersion: vs.version,
    nodeVersion: process.version,
    platformArch: `${process.platform} (${process.arch})`,
    isLmSupported
  });

  const selection = await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Environment Information',
    placeHolder: 'Inspect environment details or return to tools...',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selection?.isBack) {
    await showTools(context);
  }
}
