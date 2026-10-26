export const GEMINI_API_KEY_SECRET = 'originx.geminiApiKey';

export interface ISecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface IGlobalState {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: any): Thenable<void>;
}

export interface MigrationResult {
  migrated: boolean;
  previouslyExisted: boolean;
  verifiedDeleted: boolean;
  error?: string;
}

export class SecretManager {
  private secrets: ISecretStorage;

  constructor(secrets: ISecretStorage) {
    this.secrets = secrets;
  }

  /**
   * Securely saves the legacy Gemini API key in VS Code SecretStorage.
   * Throws if the key is empty or whitespace-only.
   */
  public async storeApiKey(key: string): Promise<void> {
    const trimmed = (key || '').trim();
    if (!trimmed) {
      throw new Error('API key cannot be empty.');
    }
    await this.secrets.store(GEMINI_API_KEY_SECRET, trimmed);
  }

  /**
   * Retrieves the legacy Gemini API key from VS Code SecretStorage.
   * Returns undefined if no key is stored.
   */
  public async getApiKey(): Promise<string | undefined> {
    const key = await this.secrets.get(GEMINI_API_KEY_SECRET);
    if (!key || key.trim().length === 0) {
      return undefined;
    }
    return key.trim();
  }

  /**
   * Removes the legacy Gemini API key from VS Code SecretStorage.
   */
  public async deleteApiKey(): Promise<void> {
    await this.secrets.delete(GEMINI_API_KEY_SECRET);
  }

  /**
   * Checks if an API key is currently stored.
   */
  public async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return typeof key === 'string' && key.length > 0;
  }
}

/**
 * Executes an idempotent, verified one-time cleanup migration on extension activation.
 * Purges legacy Gemini SecretStorage keys without logging, storing, or exporting credentials.
 */
export async function migrateAndPurgeLegacySecrets(
  secrets: ISecretStorage,
  globalState?: IGlobalState
): Promise<MigrationResult> {
  const MIGRATION_STATE_KEY = 'originx.legacyGeminiKeyPurged';

  // 1. Idempotency check: if migration already completed, return immediately
  if (globalState && globalState.get<boolean>(MIGRATION_STATE_KEY, false)) {
    return {
      migrated: false,
      previouslyExisted: false,
      verifiedDeleted: true
    };
  }

  try {
    const manager = new SecretManager(secrets);
    const hadKey = await manager.hasApiKey();

    if (hadKey) {
      // 2. Perform deletion
      await manager.deleteApiKey();

      // 3. Actively verify that the key no longer exists
      const stillHasKey = await manager.hasApiKey();
      if (stillHasKey) {
        return {
          migrated: false,
          previouslyExisted: true,
          verifiedDeleted: false,
          error: 'Verification failed: legacy key remained in SecretStorage after delete operation.'
        };
      }
    }

    // 4. Record migration completion in global state
    if (globalState) {
      await globalState.update(MIGRATION_STATE_KEY, true);
    }

    return {
      migrated: hadKey,
      previouslyExisted: hadKey,
      verifiedDeleted: true
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      migrated: false,
      previouslyExisted: false,
      verifiedDeleted: false,
      error: `SecretStorage migration encountered an error: ${message}`
    };
  }
}
