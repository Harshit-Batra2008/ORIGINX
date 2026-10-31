import { SecretManager } from '../security/secretManager';
import { resolveNeo4jConfig } from './neo4jService';
import { Neo4jConfig } from './neo4jTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Resolves Neo4j credentials from environment, SecretStorage, or an interactive masked prompt.
 * Asks for explicit user consent before storing credentials in SecretStorage.
 * Returns null if the user cancels the prompt.
 */
export async function getOrPromptNeo4jCredentials(
  secretManager: SecretManager,
  configOverrides?: Partial<Neo4jConfig>
): Promise<Neo4jConfig | null> {
  const config = resolveNeo4jConfig(configOverrides);
  const vscode = getVsCode();

  // 1. Check process.env.NEO4J_PASSWORD first
  if (config.password && config.password.trim().length > 0) {
    return config;
  }

  // 2. Check VS Code SecretStorage
  const storedPassword = await secretManager.getNeo4jPassword();
  if (storedPassword && storedPassword.trim().length > 0) {
    config.password = storedPassword.trim();
    return config;
  }

  // 3. Prompt user via VS Code masked input box
  if (!vscode || !vscode.window) {
    return null;
  }

  const entered = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    title: 'ORIGINX: Neo4j AuraDB Authentication',
    prompt: `Enter the Neo4j password for user "${config.username}" (${config.uri})`,
    placeHolder: 'Neo4j AuraDB Password'
  });

  if (!entered || entered.trim().length === 0) {
    return null; // User cancelled
  }

  const cleanPassword = entered.trim();

  // 4. Request explicit consent to persist in SecretStorage
  const consentChoice = await vscode.window.showInformationMessage(
    'Would you like to securely save this Neo4j password in VS Code SecretStorage for future sessions?',
    'Save in SecretStorage',
    'Use for this session only'
  );

  if (consentChoice === 'Save in SecretStorage') {
    await secretManager.storeNeo4jPassword(cleanPassword);
    vscode.window.showInformationMessage(
      'ORIGINX: Neo4j password stored securely in VS Code SecretStorage.'
    );
  }

  config.password = cleanPassword;
  return config;
}

/**
 * Deletes any stored Neo4j password from VS Code SecretStorage.
 */
export async function clearStoredNeo4jPassword(
  secretManager: SecretManager
): Promise<boolean> {
  const vscode = getVsCode();
  const hadKey = await secretManager.hasNeo4jPassword();

  if (!hadKey) {
    if (vscode?.window) {
      vscode.window.showInformationMessage('ORIGINX: No Neo4j password currently stored in SecretStorage.');
    }
    return false;
  }

  await secretManager.deleteNeo4jPassword();
  if (vscode?.window) {
    vscode.window.showInformationMessage('ORIGINX: Stored Neo4j password has been removed from SecretStorage.');
  }
  return true;
}
