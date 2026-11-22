import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { CheckpointStorage } from '../contextCheckpoint/checkpointStorage';
import { ContextCheckpoint, ContextRetrievalResult } from '../contextCheckpoint/checkpointTypes';
import { CheckpointWebviewController } from '../contextCheckpoint/checkpointWebview';
import { DecisionStorage } from '../decisionMemory/decisionStorage';
import { DecisionWebviewController } from '../decisionMemory/decisionWebview';
import { resolveRepositoryFile } from '../security/repositoryFiles';

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;
type Message = Record<string, unknown>;

class TestPanel {
  private handlers = new Set<(message: Message) => Promise<void>>();
  private disposeHandlers = new Set<() => void>();
  readonly webview = {
    html: '',
    onDidReceiveMessage: (handler: (message: Message) => Promise<void>) => {
      this.handlers.add(handler);
      return { dispose: () => this.handlers.delete(handler) };
    }
  };
  onDidDispose(handler: () => void) { this.disposeHandlers.add(handler); }
  async send(message: Message) { await Promise.all([...this.handlers].map(handle => handle(message))); }
  dispose() {
    this.handlers.clear();
    for (const handle of this.disposeHandlers) handle();
    this.disposeHandlers.clear();
  }
}

class TestWindow {
  modals: string[][] = [];
  errors: string[] = [];
  panel = new TestPanel();
  confirm: string | undefined;
  showInputBox = async (): Promise<string | undefined> => undefined;
  createWebviewPanel() { return this.panel = new TestPanel(); }
  showErrorMessage(text: string) { this.errors.push(text); }
  showInformationMessage(_text: string, options?: { modal: boolean }, ...items: string[]) {
    if (options?.modal) this.modals.push(items);
    return Promise.resolve(this.confirm);
  }
}

async function withWindow(run: (window: TestWindow, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitwhisper-panel-'));
  const window = new TestWindow();
  const modules = require('module') as { _load: (id: string, parent: NodeModule, main: boolean) => unknown };
  const load = modules._load;
  modules._load = function(id, parent, main) {
    return id === 'vscode' ? { window, ViewColumn: { Beside: -2 } } : load.call(this, id, parent, main);
  };
  try {
    await run(window, root);
    assert.deepStrictEqual(window.errors, []);
  } finally {
    window.panel.dispose();
    modules._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function localContext(_root: string, checkpoint: ContextCheckpoint): Promise<ContextRetrievalResult> {
  return Promise.resolve({
    checkpoint, freshness: { isAvailable: false, isFresh: false, currentHead: 'unknown' },
    relatedFiles: [], linkedDecisions: [], limitations: [],
    diagnostics: { queryDurationMs: 0, candidateCount: 0, serializedContextSizeBytes: 0, retrievalSource: 'none' }
  });
}

const context = { subscriptions: [] } as unknown as ExtensionContext;

export async function runMemoryPanelTests(test: Test) {
  await test('Context panel offers one affirmative save, dismisses safely and ignores overlapping saves', () =>
    withWindow(async (window, root) => {
      await CheckpointWebviewController.show(context, root, 'save', undefined, [], [], localContext);
      const save = { command: 'saveCheckpoint', payload: { title: 'Handoff for next developer', goal: 'Finish the retry tests' } };
      const storage = new CheckpointStorage();
      await window.panel.send(save);
      assert.deepStrictEqual(window.modals, [['Save Checkpoint']]);
      assert.strictEqual((await storage.listCheckpoints(root)).length, 0);
      window.confirm = 'Save Checkpoint';
      await Promise.all([window.panel.send(save), window.panel.send(save)]);
      assert.strictEqual(window.modals.length, 2);
      assert.strictEqual((await storage.listCheckpoints(root)).length, 1);
      assert.ok(window.panel.webview.html.includes('Finish the retry tests'));
      await window.panel.send({ command: 'switchMode', mode: 'save' });
      const draft = { title: 'Next handoff', goal: 'New draft', note: '', completed: '', unfinished: '', files: '' };
      await window.panel.send({ command: 'switchMode', mode: 'resume', draft });
      assert.ok(window.panel.webview.html.includes('Finish the retry tests'));
      await window.panel.send({ command: 'switchMode', mode: 'save' });
      assert.ok(window.panel.webview.html.includes('value="New draft"'));
      assert.strictEqual((await storage.listCheckpoints(root)).length, 1);
    }));

  await test('Stored decisions load without a source file and a replaced panel cannot finish an old edit', () =>
    withWindow(async (window, root) => {
      const other = path.join(root, 'other-repository');
      fs.mkdirSync(other);
      const storage = new DecisionStorage();
      const original = await storage.createDecision(root, {
        id: 'DEC-old', title: 'Original design', rationale: 'Original rationale',
        primaryAnchor: { filePath: "src/owner's file.ts" }, createdBy: { name: 'Reviewer', type: 'human' }
      });
      await DecisionWebviewController.showStored(context, root);
      const first = window.panel;
      assert.ok(first.webview.html.includes('Stored Decisions (1)'));
      assert.ok(first.webview.html.includes('data-file="src/owner&#039;s file.ts"'));
      assert.doesNotMatch(first.webview.html, /\bonclick=|javascript:void/);
      let answer!: (value: string) => void;
      let promptOpened!: () => void;
      const prompted = new Promise<void>(resolve => { promptOpened = resolve; });
      window.showInputBox = () => new Promise(resolve => { answer = resolve; promptOpened(); });
      const edit = first.send({ command: 'editRationale', id: original.id });
      await prompted;
      await DecisionWebviewController.showStored(context, other);
      answer('Late answer from the old panel');
      await edit;
      assert.ok(window.panel.webview.html.includes('Stored Decisions (0)'));
      assert.strictEqual((await storage.getDecision(root, original.id))?.rationale, 'Original rationale');
      assert.deepStrictEqual(await storage.listDecisions(other), []);
    }));

  await test('Pre-continuity schema 1.0.0 records load from their original folders without rewriting them', () =>
    withWindow(async (window, root) => {
      const timestamp = '2026-01-12T12:00:00.000Z';
      const decision = [
        '---', 'id: DEC-legacy', 'schemaVersion: 1.0.0', 'title: Original decision', 'status: proposed',
        'freshness: current', 'hasDirectGitEvidence: false', 'createdAt: ' + timestamp, 'updatedAt: ' + timestamp,
        'createdBy:', '  name: Alice', '  type: human', 'primaryAnchor:', '  filePath: src/parser.ts',
        'tags: []', 'relatedFiles: []', 'evidence: []', 'constraints: []', '---', '', '# DEC-legacy: Original decision',
        '', '## Rationale', 'Keep the existing parser.', '', '## Primary Anchor', '- src/parser.ts', ''
      ].join('\r\n');
      const checkpoint = [
        '---', 'id: CHK-legacy', 'schemaVersion: 1.0.0', 'title: Original context', 'createdAt: ' + timestamp,
        'updatedAt: ' + timestamp, 'repository:', '  repoName: parser', '  branch: main', '  headCommit: abc1234',
        '  headShortCommit: abc1234', '  isCleanWorkingTree: true', 'decisionMemoryReferences:', '  - DEC-legacy',
        'completedWork: []', 'unfinishedTasks: []', 'knownConstraints: []', 'targetFiles: []',
        'commitReferences: []', 'tags: []', '---', '', '# Context Checkpoint: Original context', ''
      ].join('\r\n');
      const decisionPath = path.join(root, '.gitwhisper', 'decisions', 'DEC-legacy.md');
      const checkpointPath = path.join(root, '.gitwhisper', 'checkpoints', 'CHK-legacy.md');
      for (const file of [decisionPath, checkpointPath]) fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(decisionPath, decision);
      fs.writeFileSync(checkpointPath, checkpoint);
      await DecisionWebviewController.showStored(context, root);
      assert.ok(window.panel.webview.html.includes('Keep the existing parser.'));
      await CheckpointWebviewController.show(context, root, 'resume', undefined, undefined, [], localContext);
      assert.ok(window.panel.webview.html.includes('Original context'));
      assert.strictEqual(fs.readFileSync(decisionPath, 'utf8'), decision);
      assert.strictEqual(fs.readFileSync(checkpointPath, 'utf8'), checkpoint);
      const storage = new CheckpointStorage();
      const prior = await storage.getCheckpoint(root, 'CHK-legacy');
      assert.deepStrictEqual(prior?.decisionMemoryReferences, ['DEC-legacy']);
      const updated = await storage.saveCheckpoint(root, { id: 'CHK-legacy', title: 'Revised title' }, prior!.repository);
      assert.strictEqual(updated.createdAt, timestamp);
    }));

  await test('Memory storage and source opening reject repository-escaping ancestor directories', () =>
    withWindow(async (_window, root) => {
      const repo = path.join(root, 'repo');
      const external = path.join(root, 'other');
      fs.mkdirSync(repo);
      fs.mkdirSync(external);
      fs.symlinkSync(external, path.join(repo, '.gitwhisper'), 'junction');
      const checkpoints = new CheckpointStorage();
      await assert.rejects(checkpoints.listCheckpoints(repo), { code: 'PATH_TRAVERSAL' });
      await assert.rejects(new DecisionStorage().listDecisions(repo), { code: 'PATH_TRAVERSAL' });
      await assert.rejects(checkpoints.saveCheckpoint(repo, { title: 'Test' }, {
        repoName: 'repo', branch: 'main', headCommit: 'abc1234', headShortCommit: 'abc1234', isCleanWorkingTree: true
      }), { code: 'PATH_TRAVERSAL' });
      assert.deepStrictEqual(fs.readdirSync(external), []);
      assert.throws(() => resolveRepositoryFile(repo, '.gitwhisper/missing/source.ts'), /outside this repository/);
      assert.strictEqual(resolveRepositoryFile(repo, 'missing/source.ts'), undefined);
    }));
}
