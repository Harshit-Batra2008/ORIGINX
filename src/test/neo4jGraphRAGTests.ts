/**
 * GitWhisper — Neo4j GraphRAG Integration & Code Entity Unit & Integration Tests
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractCodeEntities, findEnclosingEntity } from '../neo4j/codeEntityExtractor';
import { planUnifiedEvidenceGraph, importUnifiedEvidenceGraph } from '../neo4j/unifiedGraphImporter';
import {
  retrieveCompactEvidencePackage,
  retrieveNeo4jEvidencePackage,
  clearEvidencePackageCache,
} from '../evidenceGraph/evidenceGraphRetriever';
import { runGit } from '../git/gitService';
import { executeAskWhy } from '../askWhy/askWhyService';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `originx-neo4j-test-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export async function runNeo4jGraphRAGTests(): Promise<void> {
  console.log('\n====================================================');
  console.log('Running GitWhisper Neo4j GraphRAG Test Suite');
  console.log('====================================================\n');

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
    } catch (err: any) {
      console.error(`  [FAIL] ${name}`);
      console.error(err);
      throw err;
    }
  }

  // 1. Code Entity & Configuration Key Extraction
  await test('CodeEntityExtractor: extracts Python functions, classes, and enclosing scope', async () => {
    const pythonCode = `
import re

def _host_of(target):
    return target.lower()

def _match(pattern, host):
    if pattern.startswith("re:"):
        return re.search(pattern[3:], host) is not None
    return pattern == host

class ScopeManager:
    def check(self):
        pass
`;
    const entities = extractCodeEntities('engine/scope.py', pythonCode);
    assert.strictEqual(entities.length, 3);
    assert.strictEqual(entities[0].name, '_host_of');
    assert.strictEqual(entities[0].kind, 'function');
    assert.strictEqual(entities[1].name, '_match');
    assert.strictEqual(entities[1].kind, 'function');
    assert.strictEqual(entities[2].name, 'ScopeManager');
    assert.strictEqual(entities[2].kind, 'class');

    // Test enclosing function resolution for lines 7-9 (inside _match)
    const enclosing = findEnclosingEntity(entities, 8);
    assert.ok(enclosing, 'Must find enclosing entity');
    assert.strictEqual(enclosing?.name, '_match');
  });

  await test('CodeEntityExtractor: extracts TypeScript functions and config keys', async () => {
    const tsCode = `
export function parseConfig(raw: string) {
  return JSON.parse(raw);
}
export class EngineRunner {}
`;
    const tsEntities = extractCodeEntities('src/engine.ts', tsCode);
    assert.strictEqual(tsEntities.length, 2);
    assert.strictEqual(tsEntities[0].name, 'parseConfig');
    assert.strictEqual(tsEntities[1].name, 'EngineRunner');

    const jsonCode = `{\n  "neo4jUri": "neo4j+s://...",\n  "timeout": 5000\n}`;
    const jsonEntities = extractCodeEntities('config.json', jsonCode);
    assert.strictEqual(jsonEntities.length, 2);
    assert.strictEqual(jsonEntities[0].name, 'neo4jUri');
    assert.strictEqual(jsonEntities[0].kind, 'config_key');
  });

  // 2. Unified Graph Dry-Run Pipeline
  await test('UnifiedGraphImporter: planUnifiedEvidenceGraph creates comprehensive dry-run without writing to DB', async () => {
    const tempRepo = createTempDir('dry-run-repo');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const pyFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(pyFile, 'def _match(pattern, host):\n    return pattern == host\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat(scope): initial scope matching (#101)\n\nDetailed rationale for initial scope matching rules.'], tempRepo);

      fs.appendFileSync(pyFile, '\ndef _host_of(target):\n    return target.strip()\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nDetailed engineering rationale for host regex matching rules to preserve metacharacters.'], tempRepo);

      const { plan, payload } = await planUnifiedEvidenceGraph({
        repoRoot: tempRepo,
        maxCommits: 10,
        dryRun: true,
      });

      assert.strictEqual(plan.dryRun, true);
      assert.strictEqual(plan.nodesToCreateOrMerge.commits, 2);
      assert.strictEqual(plan.nodesToCreateOrMerge.pullRequests, 2);
      assert.strictEqual(plan.nodesToCreateOrMerge.issues, 0, 'No fabricated issues');
      assert.strictEqual(plan.nodesToCreateOrMerge.decisions, 2);
      assert.ok(plan.nodesToCreateOrMerge.functions >= 2, 'Discovered functions');
      assert.ok(plan.relationshipsToCreate.totalRelationships > 0);
      assert.ok(plan.sampleQueries.length > 0);
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // 3. Live Graph Retrieval Path with Mock Neo4j Driver
  await test('AskWhy: retrieves live evidence directly from Neo4j Aura knowledge graph', async () => {
    const tempRepo = createTempDir('live-neo4j-retrieval');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Rudy Celekli'], tempRepo);
      await runGit(['config', 'user.email', 'rudy@example.com'], tempRepo);

      const scopeFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(scopeFile, 'def _match(p, h):\n    return p in h\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nDetailed engineering rationale for host regex matching rules to preserve metacharacters.'], tempRepo);

      const mockDriver = {
        session: () => ({
          run: async (query: string, params: any) => {
            if (query.includes('MATCH (r:Repository { id: $repoId })') && query.includes('RETURN r.id AS repoId')) {
              return { records: [{ get: (k: string) => k === 'repoId' ? 'test-repo' : 'test-repo:scope.py' }] };
            }
            if (query.includes('MERGED_BY_PR')) {
              return {
                records: [
                  {
                    get: (k: string) => {
                      switch (k) {
                        case 'hash': return '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10';
                        case 'shortHash': return '228f976';
                        case 'subject': return 'fix(scope): preserve metacharacters in host regex rules (#122)';
                        case 'body': return 'Detailed engineering rationale for host regex matching rules to preserve metacharacters.';
                        case 'committedAt': return '2026-11-16T08:10:49-05:00';
                        case 'authorName': return 'Rudy Celekli';
                        case 'prNumber': return 122;
                        case 'prTitle': return 'fix(scope): preserve metacharacters in host regex rules';
                        case 'prUrl': return 'https://github.com/elementalsouls/Claude-BugHunter/pull/122';
                        case 'prBody': return 'Detailed engineering rationale for host regex matching rules to preserve metacharacters.';
                        default: return null;
                      }
                    }
                  }
                ]
              };
            }
            if (query.includes('MATCH (d:Decision)')) {
              return {
                records: [
                  {
                    get: (k: string) => {
                      switch (k) {
                        case 'id': return 'test-repo:decision:pr-122';
                        case 'title': return 'Preserve metacharacters in host regex rules';
                        case 'rationale': return 'Preserves regex metacharacters in host regex rules to prevent case alteration.';
                        case 'status': return 'current';
                        case 'evidenceClassification': return 'directly_supported';
                        default: return null;
                      }
                    }
                  }
                ]
              };
            }
            return { records: [] };
          },
          close: async () => {},
        })
      };

      clearEvidencePackageCache();
      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'scope.py',
        question: 'Why preserve regex metacharacters?',
        neo4jService: mockDriver,
      });

      assert.strictEqual(result.diagnostics.retrievalSource, 'neo4j_graph', 'Source must be neo4j_graph');
      assert.strictEqual(result.diagnostics.isNeo4jActive, true, 'isNeo4jActive must be true');
      assert.strictEqual(result.evidenceClassification, 'directly_supported');
      assert.strictEqual(result.supersessionStatus, 'current');
      assert.ok(result.citations.some(c => c.type === 'pull_request' && c.identifier.includes('122')));
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // 4. Safe Deterministic Fallback when Neo4j is disconnected
  await test('AskWhy: falls back to deterministic local Git & docs when Neo4j driver is null', async () => {
    const tempRepo = createTempDir('fallback-neo4j-retrieval');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const scopeFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(scopeFile, 'p = pattern.strip()\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nDetailed engineering rationale for host regex matching rules to preserve metacharacters.'], tempRepo);

      clearEvidencePackageCache();
      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'scope.py',
        question: 'Why regex?',
        neo4jService: null, // Disconnected Neo4j
      });

      assert.ok(result.diagnostics.retrievalSource === 'github_api' || result.diagnostics.retrievalSource === 'local_git', 'Source must fall back from neo4j_graph');
      assert.strictEqual(result.diagnostics.isNeo4jActive, false, 'isNeo4jActive must be false');
      assert.strictEqual(result.evidenceClassification, 'directly_supported');
      assert.strictEqual(result.supersessionStatus, 'current');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });
}
