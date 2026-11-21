import type * as vscode from 'vscode';
import { getAvailableVsCodeModels } from '../lm/vscodeLmClient';
import { OutputView } from './outputView';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

const SEPARATOR_KIND = -1; // Corresponds to vscode.QuickPickItemKind.Separator

export interface CommandCenterEntry {
  id?: string;
  category?: 'PRIMARY' | 'HISTORY' | 'DEVELOPER_TOOLS' | 'GENERAL';
  label: string;
  description?: string;
  detail?: string;
  kind?: number;
  execute?: () => Promise<void> | void;
}

export interface ModelSubmenuItem {
  id?: string;
  label: string;
  description?: string;
  detail?: string;
  kind?: number;
  isBack?: boolean;
  modelId?: string;
}

export interface DiagSubmenuItem {
  id?: string;
  label: string;
  description?: string;
  detail?: string;
  kind?: number;
  isBack?: boolean;
  openChannel?: boolean;
}

export interface EnvSubmenuItem {
  id?: string;
  label: string;
  description?: string;
  detail?: string;
  kind?: number;
  isBack?: boolean;
}

/**
 * Builds the structured QuickPick items for the ORIGINX Command Center.
 * Separated for offline mock verification and testability.
 */
export function getCommandCenterItems(
  isAutoAnalysis: boolean,
  showMultiFileConfirmation: boolean = true
): CommandCenterEntry[] {
  return [
    {
      label: 'PRIMARY ACTIONS',
      kind: SEPARATOR_KIND
    },
    {
      id: 'analyze_code',
      category: 'PRIMARY',
      label: '$(sparkle) GitWhisper: Analyze Code (Main Action)',
      description: 'Unified code analysis, bug diagnostics, Git & Neo4j impact',
      detail: 'Shortcut: Ctrl+O then Ctrl+X (editor selection)'
    },
    {
      id: 'review_working_tree',
      category: 'PRIMARY',
      label: '$(git-pull-request) GitWhisper: Review Working Tree Changes',
      description: 'Inspect staged & unstaged modifications with co-change evidence',
      detail: 'Analyzes working tree modifications and blast radius'
    },
    {
      id: 'investigate_bug',
      category: 'PRIMARY',
      label: '$(bug) GitWhisper: Investigate Bug',
      description: 'Diagnose selected code and optionally use a reported error',
      detail: 'Finds causal commits with unverified suggested fix'
    },
    {
      label: 'FOCUSED HISTORY ANALYSIS',
      kind: SEPARATOR_KIND
    },
    {
      id: 'explain',
      category: 'HISTORY',
      label: '$(history) Why Was This Changed? (Single Selection)',
      description: 'Explain line evolution using Git blame & Copilot',
      detail: 'Shortcut: Ctrl+Alt+H (editor selection)'
    },
    {
      id: 'explain_multi',
      category: 'HISTORY',
      label: '$(files) Why Were These Changed? (Multi-File)',
      description: 'Correlate changes across multiple files selected in Explorer',
      detail: 'Context shortcut: Right-click files in Explorer -> "Why Were These Changed?"'
    },
    {
      label: 'DEVELOPER TOOLS & SETTINGS',
      kind: SEPARATOR_KIND
    },
    {
      id: 'enable_auto',
      category: 'DEVELOPER_TOOLS',
      label: '$(check) Enable Automatic AI Analysis',
      description: isAutoAnalysis ? '(Currently Active)' : 'Auto-analyze on right-click without prompt',
      detail: 'Sends selected code and Git diffs to Copilot without per-request confirmation'
    },
    {
      id: 'disable_auto',
      category: 'DEVELOPER_TOOLS',
      label: '$(circle-slash) Disable Automatic AI Analysis',
      description: !isAutoAnalysis ? '(Currently Active)' : 'Revert to manual AI invocation',
      detail: 'Preserves 100% offline Git history without transmitting repository code'
    },
    {
      id: 'toggle_multi_confirm',
      category: 'DEVELOPER_TOOLS',
      label: '$(bell) Multi-File Usage Confirmation',
      description: showMultiFileConfirmation ? 'ACTIVE (Always confirm)' : 'SUPPRESSED (Click to restore)',
      detail: 'Shows token estimation dialog before multi-file operations'
    },
    {
      id: 'list_models',
      category: 'DEVELOPER_TOOLS',
      label: '$(hubot) List Available AI Models',
      description: 'Inspect registered VS Code Language Models (vscode.lm)',
      detail: 'Discover available Copilot and vendor models'
    },
    {
      id: 'import_graph',
      category: 'DEVELOPER_TOOLS',
      label: '$(cloud-upload) Import Git History to Neo4j',
      description: 'Ingest local commits, files, and relationships into Neo4j AuraDB',
      detail: 'Creates Repository, Commit, File, and Person nodes with provenance'
    },
    {
      id: 'inspect_graph',
      category: 'DEVELOPER_TOOLS',
      label: '$(graph) Inspect Neo4j Evidence Graph',
      description: 'Query repository node counts, commit relations, and file stats',
      detail: 'Read-only graph inspection without invoking AI models'
    },
    {
      id: 'retrieve_evidence',
      category: 'DEVELOPER_TOOLS',
      label: '$(database) Retrieve File Evidence from Neo4j',
      description: 'Query historical graph evidence for active file',
      detail: 'Read-only query scoped to current repository'
    },
    {
      id: 'prune_graph',
      category: 'DEVELOPER_TOOLS',
      label: '$(trash) Clean Up Repository Subgraph in Neo4j',
      description: "Safely remove this repository's commits and files from Neo4j",
      detail: 'Requires confirmation; never deletes Person nodes or other repositories'
    },
    {
      id: 'manage_neo4j_creds',
      category: 'DEVELOPER_TOOLS',
      label: '$(key) Manage Neo4j Database Credentials',
      description: 'Store, update, or clear Neo4j AuraDB password in SecretStorage',
      detail: 'Never logs passwords or bundles credentials'
    },
    {
      id: 'inspect_payload',
      category: 'DEVELOPER_TOOLS',
      label: '$(eye) Inspect Outgoing AI Payload',
      description: 'Preview sanitized prompt and diff payload in editor',
      detail: 'Inspect code snippet, commit messages, diffs, and prompt structure'
    },
    {
      id: 'view_diagnostics',
      category: 'DEVELOPER_TOOLS',
      label: '$(pulse) Technical Diagnostics',
      description: 'Review operational telemetry and token metrics',
      detail: 'Safe diagnostics containing zero credentials, code, or prompts'
    },
    {
      id: 'open_channel',
      category: 'DEVELOPER_TOOLS',
      label: '$(output) Open GitWhisper Output Channel',
      description: 'Focus dedicated GitWhisper logging & telemetry stream',
      detail: 'View raw Git log details, startup diagnostics, and model lists'
    },
    {
      id: 'show_env',
      category: 'DEVELOPER_TOOLS',
      label: '$(info) Environment & Version Info',
      description: 'GitWhisper 0.3.0 | VS Code host & Node runtime',
      detail: 'Inspect runtime environment, VS Code version, and Copilot compatibility'
    }
  ];
}

/**
 * Builds the submenu items for Discovered VS Code Language Models.
 */
export function getModelSubmenuItems(models: any[]): ModelSubmenuItem[] {
  const items: ModelSubmenuItem[] = [
    {
      label: '$(arrow-left) Back to Command Center',
      description: 'Return to main ORIGINX Command Center menu',
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
  showMultiFileConfirmation: boolean = true
): DiagSubmenuItem[] {
  return [
    {
      label: '$(arrow-left) Back to Command Center',
      description: 'Return to main ORIGINX Command Center menu',
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
      description: 'PURGED & VERIFIED',
      detail: 'SecretStorage migration confirmed no Google keys stored'
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
  vsCodeVersion?: string;
  nodeVersion?: string;
  platformArch?: string;
  isLmSupported?: boolean;
}): EnvSubmenuItem[] {
  const isLmSupported = info?.isLmSupported ?? true;
  const vsCodeVersion = info?.vsCodeVersion || 'Unknown';
  const nodeVersion = info?.nodeVersion || process.version;
  const platformArch = info?.platformArch || `${process.platform} (${process.arch})`;

  return [
    {
      label: '$(arrow-left) Back to Command Center',
      description: 'Return to main ORIGINX Command Center menu',
      isBack: true
    },
    {
      label: 'EXTENSION & RUNTIME INFORMATION',
      kind: SEPARATOR_KIND
    },
    {
      label: '$(package) GitWhisper Version',
      description: '0.3.0',
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

/**
 * Opens the interactive ORIGINX Command Center QuickPick menu.
 */
export async function showCommandCenter(context?: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) {
    return;
  }

  const isAutoAnalysis = vs.workspace
    .getConfiguration('originx')
    .get('enableAutomaticAnalysis', false);
  const showMultiConfirm = vs.workspace
    .getConfiguration('originx')
    .get('showMultiFileConfirmation', true);

  const items = getCommandCenterItems(isAutoAnalysis, showMultiConfirm);

  const selected = (await vs.window.showQuickPick(items, {
    title: 'GitWhisper by ORIGINX — Command Center',
    placeHolder: 'Select a command (Analyze Code is the main action)...',
    matchOnDescription: true,
    matchOnDetail: true
  })) as CommandCenterEntry | undefined;

  if (!selected || !selected.id) {
    return;
  }

  switch (selected.id) {
    case 'analyze_code':
      await vs.commands.executeCommand('originx.analyzeCode');
      break;

    case 'explain':
      await vs.commands.executeCommand('originx.whyWasThisChanged');
      break;

    case 'explain_multi':
      await vs.commands.executeCommand('originx.whyWereTheseChanged');
      break;

    case 'review_working_tree':
      await vs.commands.executeCommand('originx.reviewWorkingTree');
      break;

    case 'investigate_bug':
      await vs.commands.executeCommand('originx.investigateBug');
      break;

    case 'enable_auto':
      await vs.commands.executeCommand('originx.enableAutomaticAnalysis');
      break;

    case 'disable_auto':
      await vs.commands.executeCommand('originx.disableAutomaticAnalysis');
      break;

    case 'toggle_multi_confirm':
      const newPref = !showMultiConfirm;
      await vs.workspace
        .getConfiguration('originx')
        .update('showMultiFileConfirmation', newPref, vs.ConfigurationTarget.Global);
      vs.window.showInformationMessage(
        newPref
          ? 'ORIGINX: Multi-file usage confirmation dialog has been RESTORED.'
          : 'ORIGINX: Multi-file usage confirmation dialog is now SUPPRESSED (Auto-proceed).'
      );
      break;

    case 'list_models':
      await showModelsSubmenu(context);
      break;

    case 'import_graph':
      await vs.commands.executeCommand('originx.importGitGraph');
      break;

    case 'inspect_graph':
      await vs.commands.executeCommand('originx.inspectGitGraph');
      break;

    case 'retrieve_evidence':
      await vs.commands.executeCommand('originx.retrieveFileEvidence');
      break;

    case 'prune_graph':
      await vs.commands.executeCommand('originx.pruneGitGraph');
      break;

    case 'inspect_payload':
      await vs.commands.executeCommand('originx.inspectPayload');
      break;

    case 'view_diagnostics':
      await showDiagnosticsSubmenu(context);
      break;

    case 'open_channel':
      OutputView.getChannel().show(true);
      break;

    case 'show_env':
      await showEnvironmentSubmenu(context);
      break;

    case 'manage_neo4j_creds':
      await vs.commands.executeCommand('originx.manageNeo4jCredentials');
      break;
  }
}

/**
 * Submenu: Available AI Models (vscode.lm) with Back navigation.
 */
export async function showModelsSubmenu(context?: vscode.ExtensionContext): Promise<void> {
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

  const selection = (await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Available AI Models (vscode.lm)',
    placeHolder: 'Available language models registered in VS Code...',
    matchOnDescription: true,
    matchOnDetail: true
  })) as ModelSubmenuItem | undefined;

  if (!selection) {
    return;
  }

  if (selection.isBack) {
    await showCommandCenter(context);
  } else if (selection.modelId) {
    OutputView.getChannel().show(true);
  }
}

/**
 * Submenu: Technical Diagnostics with Back navigation.
 */
export async function showDiagnosticsSubmenu(context?: vscode.ExtensionContext): Promise<void> {
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

  const items = getDiagnosticsSubmenuItems(isAutoAnalysis, promptVariant, showMultiConfirm);

  const selection = (await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Technical Diagnostics & Status',
    placeHolder: 'Inspect active diagnostics or return to Command Center...',
    matchOnDescription: true,
    matchOnDetail: true
  })) as DiagSubmenuItem | undefined;

  if (!selection) {
    return;
  }

  if (selection.isBack) {
    await showCommandCenter(context);
  } else if (selection.openChannel) {
    OutputView.getChannel().show(true);
  }
}

/**
 * Submenu: Extension Version & Environment Information with Back navigation.
 */
export async function showEnvironmentSubmenu(context?: vscode.ExtensionContext): Promise<void> {
  const vs = getVsCode();
  if (!vs) {
    return;
  }

  const isLmSupported =
    typeof vs.lm !== 'undefined' &&
    typeof vs.lm.selectChatModels === 'function';

  const items = getEnvironmentSubmenuItems({
    vsCodeVersion: vs.version,
    nodeVersion: process.version,
    platformArch: `${process.platform} (${process.arch})`,
    isLmSupported
  });

  const selection = (await vs.window.showQuickPick(items, {
    title: 'GitWhisper: Environment Information',
    placeHolder: 'Inspect environment details or return to Command Center...',
    matchOnDescription: true,
    matchOnDetail: true
  })) as EnvSubmenuItem | undefined;

  if (selection?.isBack) {
    await showCommandCenter(context);
  }
}
