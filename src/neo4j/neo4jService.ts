import neo4j, { Driver } from 'neo4j-driver';
import { Neo4jConfig, Neo4jConnectionResult, INeo4jDriver, INeo4jSession } from './neo4jTypes';
import { redactSecret } from './neo4jEnv';

export const DEFAULT_NEO4J_URI = 'neo4j+s://f46dba8b.databases.neo4j.io';
export const DEFAULT_NEO4J_USERNAME = 'f46dba8b';
export const DEFAULT_CONNECTION_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_CONNECTION_LIFETIME_MS = 60000;

let activeDriver: INeo4jDriver | Driver | null = null;

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Resolves Neo4j configuration from overrides, VS Code settings, environment variables, or defaults.
 * Does not expose or print password values.
 */
export function resolveNeo4jConfig(overrides?: Partial<Neo4jConfig>): Neo4jConfig {
  const vscode = getVsCode();
  const configSection = vscode?.workspace?.getConfiguration?.('originx');
  const configuredUri = configSection?.get?.('neo4jUri');
  const configuredUsername = configSection?.get?.('neo4jUsername');
  const configuredDatabase = configSection?.get?.('neo4jDatabase');

  const envUri =
    process.env.NEO4J_URI && process.env.NEO4J_URI !== 'undefined' ? process.env.NEO4J_URI : undefined;
  const envUsername =
    process.env.NEO4J_USERNAME && process.env.NEO4J_USERNAME !== 'undefined'
      ? process.env.NEO4J_USERNAME
      : undefined;
  const envPassword =
    process.env.NEO4J_PASSWORD && process.env.NEO4J_PASSWORD !== 'undefined'
      ? process.env.NEO4J_PASSWORD
      : '';
  const envDatabase =
    process.env.NEO4J_DATABASE && process.env.NEO4J_DATABASE !== 'undefined'
      ? process.env.NEO4J_DATABASE
      : undefined;

  const uri = overrides?.uri || configuredUri || envUri || DEFAULT_NEO4J_URI;
  const username =
    overrides?.username || configuredUsername || envUsername || DEFAULT_NEO4J_USERNAME;
  const password = overrides?.password || envPassword;
  const database = overrides?.database || configuredDatabase || envDatabase || undefined;
  const connectionTimeoutMs =
    overrides?.connectionTimeoutMs || DEFAULT_CONNECTION_TIMEOUT_MS;
  const maxConnectionLifetimeMs =
    overrides?.maxConnectionLifetimeMs || DEFAULT_MAX_CONNECTION_LIFETIME_MS;

  return {
    uri,
    username,
    password,
    database: database && database.trim().length > 0 ? database.trim() : undefined,
    connectionTimeoutMs,
    maxConnectionLifetimeMs
  };
}

/**
 * Creates a configured Neo4j driver instance.
 * Throws if password is not provided.
 */
export function createNeo4jDriver(config: Neo4jConfig): Driver {
  if (!config.password || config.password.trim().length === 0) {
    throw new Error('Neo4j password is required to initialize driver.');
  }

  const timeout = config.connectionTimeoutMs || DEFAULT_CONNECTION_TIMEOUT_MS;
  const lifetime = config.maxConnectionLifetimeMs || DEFAULT_MAX_CONNECTION_LIFETIME_MS;

  return neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.username, config.password),
    {
      connectionTimeout: timeout,
      connectionAcquisitionTimeout: timeout,
      maxConnectionLifetime: lifetime,
      userAgent: 'ORIGINX-VSCode-Extension/0.2.0'
    }
  );
}

/**
 * Retrieves the currently active singleton driver, or creates one from config.
 */
export function getOrCreateDriver(config?: Partial<Neo4jConfig>): Driver | INeo4jDriver {
  if (activeDriver) {
    return activeDriver;
  }
  const resolved = resolveNeo4jConfig(config);
  const driver = createNeo4jDriver(resolved);
  activeDriver = driver;
  return driver;
}

/**
 * Explicitly sets the active driver (supports testing and dependency injection).
 */
export function setActiveDriver(driver: (Driver | INeo4jDriver) | null): void {
  activeDriver = driver;
}

/**
 * Returns the currently active driver if one exists.
 */
export function getActiveDriver(): (Driver | INeo4jDriver) | null {
  return activeDriver;
}

/**
 * Executes a verification health check against the Neo4j instance using `RETURN 1 AS success`.
 * Guarantees session is closed in a `finally` block.
 * Redacts any credentials from all error strings.
 */
export async function verifyConnection(
  driverOrConfig?: (Driver | INeo4jDriver) | Partial<Neo4jConfig>,
  timeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS
): Promise<Neo4jConnectionResult> {
  const startTime = Date.now();
  let driverToUse: Driver | INeo4jDriver | null = null;
  let shouldCloseDriverAfter = false;
  let resolvedConfig: Neo4jConfig | null = null;

  try {
    if (driverOrConfig && typeof (driverOrConfig as any).session === 'function') {
      // Driver or INeo4jDriver provided directly
      driverToUse = driverOrConfig as (Driver | INeo4jDriver);
      resolvedConfig = resolveNeo4jConfig();
    } else {
      resolvedConfig = resolveNeo4jConfig(driverOrConfig as Partial<Neo4jConfig> | undefined);
      if (!resolvedConfig.password) {
        return {
          connected: false,
          durationMs: Date.now() - startTime,
          uri: resolvedConfig.uri,
          username: resolvedConfig.username,
          database: resolvedConfig.database,
          error:
            'NEO4J_PASSWORD is not set. Please provide NEO4J_PASSWORD via .env or SecretStorage.'
        };
      }
      driverToUse = createNeo4jDriver(resolvedConfig);
      shouldCloseDriverAfter = true;
    }

    const sessionConfig: any = {};
    if (resolvedConfig?.database) {
      sessionConfig.database = resolvedConfig.database;
    }
    if (neo4j?.session?.READ) {
      sessionConfig.defaultAccessMode = neo4j.session.READ;
    }

    const session: INeo4jSession = driverToUse.session(sessionConfig);
    let serverVersion: string | undefined;

    try {
      // Execute health check with explicit timeout race
      const queryPromise = session.run('RETURN 1 AS success');
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Neo4j connection timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      );

      const result: any = await Promise.race([queryPromise, timeoutPromise]);
      const record = result?.records?.[0];
      const successVal = record
        ? typeof record.get === 'function'
          ? record.get('success')
          : record['success']
        : null;

      // Check if driver provides server info
      try {
        if (typeof (driverToUse as any).getServerInfo === 'function') {
          const infoPromise = (driverToUse as any).getServerInfo();
          const infoTimeout = new Promise<null>((r) => setTimeout(() => r(null), 2000));
          const serverInfo: any = await Promise.race([infoPromise, infoTimeout]);
          if (serverInfo) {
            serverVersion =
              serverInfo.agent ||
              serverInfo.protocolVersion ||
              (serverInfo.address ? `Neo4j @ ${serverInfo.address}` : undefined);
          }
        }
      } catch {
        // Server info retrieval is non-fatal
      }

      const connected = successVal !== null && successVal !== undefined;
      const durationMs = Date.now() - startTime;

      return {
        connected,
        serverVersion,
        durationMs,
        uri: resolvedConfig?.uri || DEFAULT_NEO4J_URI,
        username: resolvedConfig?.username || DEFAULT_NEO4J_USERNAME,
        database: resolvedConfig?.database
      };
    } finally {
      // Session cleanup is ALWAYS guaranteed
      await session.close();
    }
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedError = redactSecret(rawMsg, resolvedConfig?.password);

    return {
      connected: false,
      durationMs,
      uri: resolvedConfig?.uri || DEFAULT_NEO4J_URI,
      username: resolvedConfig?.username || DEFAULT_NEO4J_USERNAME,
      database: resolvedConfig?.database,
      error: sanitizedError
    };
  } finally {
    if (shouldCloseDriverAfter && driverToUse) {
      try {
        await driverToUse.close();
      } catch {
        // Driver close errors during cleanup are suppressed
      }
    }
  }
}

/**
 * Shuts down the active Neo4j driver cleanly upon extension deactivation.
 */
export async function closeNeo4jDriver(): Promise<void> {
  if (activeDriver) {
    const driver = activeDriver;
    activeDriver = null;
    try {
      await driver.close();
    } catch (err) {
      console.warn('[ORIGINX] Error closing Neo4j driver during shutdown:', err);
    }
  }
}
