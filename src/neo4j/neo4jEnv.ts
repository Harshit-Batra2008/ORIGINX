import * as fs from 'fs';
import * as path from 'path';

export interface ParsedEnv {
  [key: string]: string;
}

/**
 * Parses a .env format string into key-value pairs without executing code.
 * Skips comments, empty lines, trims whitespace, and strips quotes.
 */
export function parseEnvContent(content: string): ParsedEnv {
  const result: ParsedEnv = {};
  if (!content) {
    return result;
  }

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Loads .env from the specified directory or workspace root into process.env
 * without overwriting existing environment variables.
 */
export function loadEnvFile(dirPath?: string): ParsedEnv {
  const searchDir = dirPath || process.cwd();
  const envPath = path.join(searchDir, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = parseEnvContent(content);
    for (const [key, val] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Redacts passwords, auth tokens, or embedded credentials from text and error messages.
 * Never outputs the secret value.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!text) {
    return '';
  }
  let sanitized = text;
  const targetSecret = secret || process.env.NEO4J_PASSWORD;

  // Redact explicit secret or environment password if provided
  if (targetSecret && typeof targetSecret === 'string' && targetSecret.trim().length > 0) {
    sanitized = sanitized.split(targetSecret).join('[REDACTED_PASSWORD]');
  }

  // Redact credentials in connection URIs, e.g. neo4j+s://user:password@host
  sanitized = sanitized.replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:***@');

  // Redact Bearer / Basic auth headers
  sanitized = sanitized.replace(/(Basic|Bearer)\s+([A-Za-z0-9+/=._-]+)/gi, '$1 [REDACTED_AUTH]');

  return sanitized;
}
