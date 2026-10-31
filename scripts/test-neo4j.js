#!/usr/bin/env node
/**
 * ORIGINX — Development-only Neo4j AuraDB Connection Test Script
 *
 * Problem Statement: T1.1 "Why The Code Is Like This" (hackFront India 2026)
 *
 * Connects securely to the configured Neo4j AuraDB instance, runs a `RETURN 1 AS success`
 * verification check, and reports status, duration, and server information.
 *
 * SECURITY:
 * - Credentials are read from local .env or process.env.
 * - Passwords and secrets are NEVER printed, logged, or exported.
 */

const path = require('path');
const fs = require('fs');

// 1. Load local .env from workspace root if present
try {
  const { loadEnvFile } = require('../out/neo4j/neo4jEnv');
  loadEnvFile(path.resolve(__dirname, '..'));
} catch {
  // If compiled module isn't loaded yet, try simple inline .env parse
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
}

// 2. Import Neo4j service from compiled out/
let neo4jService;
try {
  neo4jService = require('../out/neo4j/neo4jService');
} catch (loadErr) {
  console.error('Error: ORIGINX compiled output not found. Please run "npm run compile" first.');
  process.exit(1);
}

async function main() {
  const config = neo4jService.resolveNeo4jConfig();

  console.log('====================================================');
  console.log('ORIGINX — Neo4j AuraDB Connection Test (Dev Tool)');
  console.log('====================================================');
  console.log(`Target URI : ${config.uri}`);
  console.log(`Username   : ${config.username}`);
  if (config.database) {
    console.log(`Database   : ${config.database}`);
  }

  if (!config.password || config.password.trim().length === 0) {
    console.log('Status     : Failed');
    console.log('Duration   : 0ms');
    console.log('Error      : NEO4J_PASSWORD is not set. Please add NEO4J_PASSWORD to your .env or environment.');
    console.log('====================================================');
    process.exit(1);
  }

  console.log('Verifying connection via "RETURN 1 AS success"...');
  const result = await neo4jService.verifyConnection(config, 10000);

  if (result.connected) {
    console.log('Status     : Connected');
    console.log(`Duration   : ${result.durationMs}ms`);
    if (result.serverVersion) {
      console.log(`Server     : ${result.serverVersion}`);
    }
    console.log('====================================================');
    process.exit(0);
  } else {
    console.log('Status     : Failed');
    console.log(`Duration   : ${result.durationMs}ms`);
    console.log(`Error      : ${result.error || 'Unknown connection error'}`);
    console.log('====================================================');
    process.exit(1);
  }
}

main().catch((err) => {
  const sanitized = err instanceof Error ? err.message : String(err);
  console.log('Status     : Failed (Unhandled Exception)');
  console.log(`Error      : ${sanitized}`);
  console.log('====================================================');
  process.exit(1);
});
