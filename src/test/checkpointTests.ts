/**
 * GitWhisper Context Checkpoint — Comprehensive Test Suite
 * Tests checkpoint creation, reload, safety, path isolation, secret blocking,
 * Git-tracked portability, graph-first retrieval, and Git fallback.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from '../git/gitService';
import { createDecision } from '../decisionMemory/decisionService';
import {
  CheckpointStorage,
  generateCheckpointId,
  getCheckpointFilePath,
  getCheckpointsDir
} from '../contextCheckpoint/checkpointStorage';
import {
  parseCheckpointFromMarkdown,
  serializeCheckpointToMarkdown
} from '../contextCheckpoint/checkpointSerializer';
import {
  checkGraphFreshness,
  retrieveCheckpointContext,
  retrieveGitFallbackCoChanges
} from '../contextCheckpoint/checkpointRetrievalService';
import {
  CheckpointSecurityError,
  CheckpointValidationError,
  validateCheckpointId,
  validateCheckpointRecord
} from '../contextCheckpoint/checkpointValidator';
import { ContextCheckpoint, SaveCheckpointInput } from '../contextCheckpoint/checkpointTypes';

function createTempRepo(prefix: string): string {
  const tmpDir = path.resolve(__dirname, `../../temp-chk-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function cleanupTempRepo(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

export async function runCheckpointTests(test: (name: string, fn: () => Promise<void> | void) => Promise<void>) {
  await test('ContextCheckpoint: Creation, persistence, and reload round trip', async () => {
    const tempRepo = createTempRepo('create-reload');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f1 = path.join(tempRepo, 'src', 'engine.py');
      fs.mkdirSync(path.dirname(f1), { recursive: true });
      fs.writeFileSync(f1, 'def run(): pass\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial commit'], tempRepo);

      const headRes = await runGit(['rev-parse', 'HEAD'], tempRepo);
      const headSha = headRes.stdout.trim();
      const headShort = headSha.slice(0, 7);

      const storage = new CheckpointStorage();
      const input: SaveCheckpointInput = {
        title: 'Deterministic Engine Transition',
        goal: 'Move scope verification from AI prompt into Python engine',
        author: 'Alice Engineer',
        developerNote: 'Do not trust LLM output for CIDR validation. Strict regex required.',
        completedWork: [
          { description: 'Created scope.py with IPv4 parser', confirmedByHuman: true, completionNote: 'Unit tested locally' }
        ],
        unfinishedTasks: [
          { description: 'Add IPv6 CIDR parsing support', priority: 'high', notes: 'Blocker for dual-stack bounties' }
        ],
        knownConstraints: [
          { description: 'Must run without network dependencies in sandbox', source: 'developer_note' }
        ],
        targetFiles: [
          { filePath: 'src/engine.py', changeStatus: 'modified' }
        ],
        tags: ['scope', 'security', 'python']
      };

      const saved = await storage.saveCheckpoint(
        tempRepo,
        input,
        {
          repoName: 'test-repo',
          branch: 'main',
          headCommit: headSha,
          headShortCommit: headShort,
          isCleanWorkingTree: true
        }
      );

      assert.ok(saved.id.startsWith('CHK-'));
      assert.strictEqual(saved.title, 'Deterministic Engine Transition');
      assert.strictEqual(saved.repository.branch, 'main');
      assert.strictEqual(saved.repository.headCommit, headSha);
      assert.strictEqual(saved.developerIntent?.goal, 'Move scope verification from AI prompt into Python engine');
      assert.strictEqual(saved.developerIntent?.isAiGenerated, false);
      assert.strictEqual(saved.completedWork.length, 1);
      assert.strictEqual(saved.completedWork[0].confirmedByHuman, true);
      assert.strictEqual(saved.unfinishedTasks.length, 1);
      assert.strictEqual(saved.unfinishedTasks[0].priority, 'high');

      // Reload directly from disk
      const reloaded = await storage.getCheckpoint(tempRepo, saved.id);
      assert.ok(reloaded !== null);
      assert.strictEqual(reloaded?.id, saved.id);
      assert.strictEqual(reloaded?.title, saved.title);
      assert.strictEqual(reloaded?.developerIntent?.goal, saved.developerIntent?.goal);
      assert.strictEqual(reloaded?.completedWork[0].description, 'Created scope.py with IPv4 parser');
      assert.strictEqual(reloaded?.unfinishedTasks[0].description, 'Add IPv6 CIDR parsing support');

      // Verify listCheckpoints returns the record
      const listed = await storage.listCheckpoints(tempRepo);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0].id, saved.id);

      // Verify getLatestCheckpoint
      const latest = await storage.getLatestCheckpoint(tempRepo);
      assert.strictEqual(latest?.id, saved.id);
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Optional developer intent handles empty note gracefully', async () => {
    const tempRepo = createTempRepo('optional-intent');
    try {
      const storage = new CheckpointStorage();
      const saved = await storage.saveCheckpoint(
        tempRepo,
        {
          title: 'Automated Snapshot Without Developer Note',
          targetFiles: [{ filePath: 'src/config.ts', changeStatus: 'modified' }]
        },
        {
          repoName: 'test-repo',
          branch: 'feature/snapshot',
          headCommit: '1111222233334444555566667777888899990000',
          headShortCommit: '1111222',
          isCleanWorkingTree: false
        }
      );

      assert.strictEqual(saved.developerIntent, undefined);
      assert.strictEqual(saved.completedWork.length, 0);
      assert.strictEqual(saved.unfinishedTasks.length, 0);

      const reloaded = await storage.getCheckpoint(tempRepo, saved.id);
      assert.ok(reloaded !== null);
      assert.strictEqual(reloaded?.developerIntent, undefined);
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Path traversal and reserved device names are blocked', async () => {
    assert.throws(() => {
      validateCheckpointId('CHK-../../bad-escape');
    }, /Path traversal/);

    assert.throws(() => {
      validateCheckpointId('CHK-CON');
    }, /Windows reserved device name/);

    assert.throws(() => {
      validateCheckpointId('CHK-NUL');
    }, /Windows reserved device name/);

    const tempRepo = createTempRepo('path-traversal-storage');
    try {
      assert.throws(() => {
        getCheckpointFilePath(tempRepo, 'CHK-../../escape');
      }, /Path traversal/);
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Secret scanning strictly blocks private keys and credentials', async () => {
    const tempRepo = createTempRepo('secret-scan');
    try {
      const storage = new CheckpointStorage();
      let threw = false;

      try {
        await storage.saveCheckpoint(
          tempRepo,
          {
            title: 'Leaky Checkpoint',
            developerNote: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----'
          },
          {
            repoName: 'test-repo',
            branch: 'main',
            headCommit: 'aaaabbbbccccddddeeeeffff0000111122223333',
            headShortCommit: 'aaaabbb',
            isCleanWorkingTree: true
          }
        );
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof CheckpointSecurityError || err.message.includes('secret'));
      }

      assert.ok(threw, 'Must block private key in checkpoint note');
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Git-tracked checkpoint portability', async () => {
    const tempRepo = createTempRepo('git-portable');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f1 = path.join(tempRepo, 'README.md');
      fs.writeFileSync(f1, '# Project\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'initial'], tempRepo);

      const storage = new CheckpointStorage();
      const saved = await storage.saveCheckpoint(
        tempRepo,
        {
          title: 'Handoff to Developer B',
          goal: 'Finish refactor of auth module',
          unfinishedTasks: [{ description: 'Complete token verification', priority: 'high' }]
        },
        {
          repoName: 'portable-repo',
          branch: 'main',
          headCommit: '1234567890abcdef1234567890abcdef12345678',
          headShortCommit: '1234567',
          isCleanWorkingTree: true
        }
      );

      // Verify the file exists under .gitwhisper/checkpoints/
      const checkpointFile = path.join(tempRepo, '.gitwhisper', 'checkpoints', `${saved.id}.md`);
      assert.ok(fs.existsSync(checkpointFile));

      // Commit the checkpoint to Git
      await runGit(['add', '.gitwhisper/'], tempRepo);
      const commitRes = await runGit(['commit', '-m', 'docs: record context checkpoint'], tempRepo);
      assert.strictEqual(commitRes.exitCode, 0);

      // Create branch and verify file survives checkout
      await runGit(['checkout', '-b', 'developer-b-handoff'], tempRepo);
      const reloaded = await storage.getCheckpoint(tempRepo, saved.id);
      assert.ok(reloaded !== null);
      assert.strictEqual(reloaded?.title, 'Handoff to Developer B');
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Graph-first retrieval with local Git fallback discovers co-changes', async () => {
    const tempRepo = createTempRepo('git-cochange-fallback');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f1 = path.join(tempRepo, 'engine', 'scope.py');
      const f2 = path.join(tempRepo, 'engine', 'matcher.py');
      const f3 = path.join(tempRepo, 'tests', 'test_scope.py');
      fs.mkdirSync(path.dirname(f1), { recursive: true });
      fs.mkdirSync(path.dirname(f3), { recursive: true });

      fs.writeFileSync(f1, 'class Scope: pass\n', 'utf8');
      fs.writeFileSync(f2, 'class Matcher: pass\n', 'utf8');
      fs.writeFileSync(f3, 'def test_scope(): pass\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial setup'], tempRepo);

      // Co-change 1
      fs.appendFileSync(f1, '# update 1\n');
      fs.appendFileSync(f2, '# update 1\n');
      await runGit(['commit', '-am', 'fix(scope): harden matcher integration'], tempRepo);

      // Co-change 2
      fs.appendFileSync(f1, '# update 2\n');
      fs.appendFileSync(f3, '# update 2\n');
      await runGit(['commit', '-am', 'test(scope): add integration tests'], tempRepo);

      const coChanges = await retrieveGitFallbackCoChanges(tempRepo, ['engine/scope.py'], 5);
      assert.ok(coChanges.length >= 2, 'Must discover historically co-changed companion files');

      const filePaths = coChanges.map((c) => c.filePath);
      assert.ok(filePaths.includes('engine/matcher.py'));
      assert.ok(filePaths.includes('tests/test_scope.py'));
      assert.strictEqual(coChanges[0].relationshipType, 'historical_co_change');
      assert.ok(coChanges[0].connectingCommits.length > 0);
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });

  await test('ContextCheckpoint: Resuming checkpoint matches Decision Memories and measures diagnostics', async () => {
    const tempRepo = createTempRepo('resume-diagnostics');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f1 = path.join(tempRepo, 'engine', 'scope.py');
      fs.mkdirSync(path.dirname(f1), { recursive: true });
      fs.writeFileSync(f1, 'def check_scope(): return True\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: add scope checking'], tempRepo);

      // Add a Decision Memory for engine/scope.py
      await createDecision(tempRepo, {
        id: 'DEC-0101',
        title: 'Deterministic Scope Matching Decision',
        rationale: 'Avoid trusting LLMs for security boundaries.',
        primaryAnchor: { filePath: 'engine/scope.py' },
        hasDirectGitEvidence: false,
        createdBy: { name: 'Architect', type: 'human' }
      });

      const storage = new CheckpointStorage();
      const saved = await storage.saveCheckpoint(
        tempRepo,
        {
          title: 'Handoff on Scope Engine',
          goal: 'Verify CIDR handling',
          targetFiles: [{ filePath: 'engine/scope.py', changeStatus: 'modified' }]
        },
        {
          repoName: 'test-repo',
          branch: 'main',
          headCommit: 'abcdef1234567890abcdef1234567890abcdef12',
          headShortCommit: 'abcdef1',
          isCleanWorkingTree: true
        }
      );

      const result = await retrieveCheckpointContext(tempRepo, saved);
      assert.ok(result.checkpoint.id === saved.id);
      assert.ok(result.diagnostics.queryDurationMs >= 0);
      assert.ok(result.diagnostics.serializedContextSizeBytes > 0);
      assert.ok(['git_fallback', 'none'].includes(result.diagnostics.retrievalSource));

      const actualHead = (await runGit(['rev-parse', 'HEAD'], tempRepo)).stdout.trim();
      let indexed = actualHead;
      const driver = {
        session: () => ({
          run: async (query: string, params?: Record<string, any>) => {
            assert.ok(params?.repoId);
            assert.notStrictEqual(params.repoId, saved.repository.repoName);
            if (query.includes('AS indexedHead')) {
              assert.strictEqual(params.head, actualHead);
              return { records: [{ indexedHead: indexed }] };
            }
            return { records: ['.gitwhisper/checkpoints/old.md', 'engine/helper.py'].map(filePath =>
              ({ filePath, sharedCommitCount: 2, sharedCommits: [] })) };
          },
          close: async () => {}
        }),
        close: async () => {}
      };
      const graph = await retrieveCheckpointContext(tempRepo, saved, { driver });
      assert.strictEqual(graph.diagnostics.retrievalSource, 'neo4j_graph');
      assert.deepStrictEqual(graph.relatedFiles.map(file => file.filePath), ['engine/helper.py']);
      indexed = '';
      const stale = await retrieveCheckpointContext(tempRepo, saved, { driver });
      assert.strictEqual(stale.diagnostics.retrievalSource, 'git_fallback');

      // Verify linked Decision Memory was found!
      assert.ok(result.linkedDecisions.length >= 1, 'Must link relevant Decision Memories');
      assert.strictEqual(result.linkedDecisions[0].id, 'DEC-0101');
    } finally {
      cleanupTempRepo(tempRepo);
    }
  });
}
