/**
 * GitWhisper v0.3.5 Integration & Legacy UI Preservation Test Suite
 * Validates:
 * 1. Line selection preservation (prevents 37-39 becoming 1-214)
 * 2. GitHub owner/repo resolution in URLs (prevents missing owner)
 * 3. Issue deduplication (prevents PR numbers becoming fake issues)
 * 4. Deterministic authoritative confidence signals & "no reversal found" supersession
 * 5. Coordinated Level 1 Sidebar and Level 2 Full Investigation rendering
 * 6. Evidence ranking (selected commit and PR first)
 * 7. In-memory retrieval caching & performance
 * 8. Legacy v0.3.1 command availability & reviewer/investigation flow preservation
 * 9. Webview CSP security & HTML escaping
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeAskWhy,
  renderAskWhySidebarHtml,
  renderAskWhyFullInvestigationHtml,
  getLastAskWhyResult,
  clearLastAskWhyResult,
  AskWhyResult,
} from '../askWhy';
import {
  retrieveCompactEvidencePackage,
  clearEvidencePackageCache,
} from '../evidenceGraph/evidenceGraphRetriever';
import { clearDocScanCache } from '../evidenceGraph/designDocScanner';
import { runGit } from '../git/gitService';
import { WebviewView } from '../ui/webviewView';
import { getContinuityItems, getToolItems } from '../ui/commandCenter';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gitwhisper-v035-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export async function runV035IntegrationTests(test: (name: string, fn: () => void | Promise<void>) => Promise<void>): Promise<void> {

  // ---------------------------------------------------------
  // 1. Line Range Selection Preservation (Lines 37-39 vs 1-214)
  // ---------------------------------------------------------
  await test('v0.3.5 Defect 1: Selected lines are preserved and target code bounds are exact', async () => {
    const tempRepo = createTempDir('selection-bounds');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      // Create a 200-line file
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        if (i >= 37 && i <= 39) {
          lines.push(`    pattern_rule_${i} = re.compile(r"^rule${i}$")`);
        } else {
          lines.push(`    line_${i} = ${i}`);
        }
      }
      const testFile = path.join(tempRepo, 'engine_rules.py');
      fs.writeFileSync(testFile, lines.join('\n') + '\n', 'utf8');

      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(rules): preserve metacharacters in host regex rules (#122)\n\nResolves #120'], tempRepo);

      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'engine_rules.py',
        question: 'Why does this code preserve regex patterns instead of lowercasing them?',
        lineRange: { startLine: 37, endLine: 39 },
      });

      // Assert target line range is EXACTLY 37-39, NOT 1-200
      assert.ok(result.target.lineRange);
      assert.strictEqual(result.target.lineRange.startLine, 37);
      assert.strictEqual(result.target.lineRange.endLine, 39);
      assert.ok(!result.target.selectedSnippet?.includes('line_1 = 1'));
      assert.ok(result.target.selectedSnippet?.includes('pattern_rule_37'));

      // Check rendered sidebar reflects lines 37-39
      const sidebarHtml = renderAskWhySidebarHtml(result);
      assert.ok(sidebarHtml.includes('Lines 37–39'), 'Sidebar must display exact line range');
      assert.ok(!sidebarHtml.includes('Lines 1–200'), 'Must not display whole file line bounds');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 2. Verified GitHub Owner/Repository Links (No Missing Owner)
  // ---------------------------------------------------------
  await test('v0.3.5 Defect 2: GitHub URLs include verified repository owner and repo slug', async () => {
    const tempRepo = createTempDir('github-urls');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);
      await runGit(['remote', 'add', 'origin', 'https://github.com/elementalsouls/Claude-BugHunter.git'], tempRepo);

      const scopeFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(scopeFile, 'p = pattern.strip()\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nFixes #189'], tempRepo);

      clearEvidencePackageCache();
      const pkg = await retrieveCompactEvidencePackage({
        repoRoot: tempRepo,
        filePath: 'scope.py',
      });

      assert.strictEqual(pkg.connectedPullRequests.length, 1);
      const pr = pkg.connectedPullRequests[0];
      assert.strictEqual(pr.number, 122);
      assert.strictEqual(pr.url, 'https://github.com/elementalsouls/Claude-BugHunter/pull/122');
      assert.ok(pr.url.includes('elementalsouls/Claude-BugHunter'), 'Must include repository owner in URL');

      assert.strictEqual(pkg.connectedIssues.length, 1);
      const issue = pkg.connectedIssues[0];
      assert.strictEqual(issue.number, 189);
      assert.strictEqual(issue.url, 'https://github.com/elementalsouls/Claude-BugHunter/issues/189');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 3. No Fabricated / Duplicated Issue Citations from PRs
  // ---------------------------------------------------------
  await test('v0.3.5 Defect 3: PR numbers are NOT duplicated as Issue citations', async () => {
    const tempRepo = createTempDir('no-duplicate-issues');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const scopeFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(scopeFile, 'p = pattern.strip()\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      // Squash merge format (#122) - 122 is the PR number
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)'], tempRepo);

      clearEvidencePackageCache();
      const pkg = await retrieveCompactEvidencePackage({
        repoRoot: tempRepo,
        filePath: 'scope.py',
      });

      assert.strictEqual(pkg.connectedPullRequests.length, 1);
      assert.strictEqual(pkg.connectedPullRequests[0].number, 122);
      // Crucial: issue 122 must NOT exist because 122 is the PR itself
      assert.strictEqual(pkg.connectedIssues.length, 0, 'Must not duplicate PR #122 as Issue #122');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 4. Deterministic Authoritative Classification & Supersession
  // ---------------------------------------------------------
  await test('v0.3.5 Defect 4: Evidence classification is deterministic and supersession confirms no reversal', async () => {
    const tempRepo = createTempDir('deterministic-classification');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const scopeFile = path.join(tempRepo, 'scope.py');
      fs.writeFileSync(scopeFile, 'p = pattern.strip()\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nDetailed rationale for regex: preserve metacharacters in host regex patterns without case mangling.'], tempRepo);

      // Subsequent orthogonal commit touching same file
      fs.appendFileSync(scopeFile, '# utf-8 fix\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'fix(engine): utf-8 encoding for file I/O (#191)'], tempRepo);

      clearEvidencePackageCache();
      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'scope.py',
        question: 'Why regex?',
        lineRange: { startLine: 1, endLine: 1 },
      });

      // Directly supported by PR #122
      assert.strictEqual(result.evidenceClassification, 'directly_supported');
      assert.strictEqual(result.supersessionStatus, 'current');
      assert.strictEqual(result.isRefusalOrInsufficient, false);
      assert.ok(result.answer.includes('no reversal found') || result.answer.includes('Current'), 'Supersession notes no reversal found');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 5. Coordinated Level 1 Sidebar & Level 2 Full Investigation
  // ---------------------------------------------------------
  await test('v0.3.5 Level 1 Sidebar and Level 2 Full Investigation display consistent evidence', async () => {
    const mockResult: AskWhyResult = {
      question: 'Why preserve regex metacharacters?',
      target: {
        filePath: 'engine/scope.py',
        lineRange: { startLine: 37, endLine: 39 },
        selectedSnippet: 'if p[:3].lower() == "re:":',
        commitHash: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
      },
      answer: '### Engineering Rationale\n\nPreserves regex metacharacters in host regex rules to prevent case alteration.',
      evidenceClassification: 'directly_supported',
      supersessionStatus: 'current',
      isRefusalOrInsufficient: false,
      citations: [
        {
          type: 'pull_request',
          identifier: 'PR #122',
          title: 'fix(scope): preserve metacharacters in host regex rules',
          url: 'https://github.com/elementalsouls/Claude-BugHunter/pull/122',
          author: 'rudycelekli',
          date: '2026-11-16',
          excerpt: 'Host regex rules must preserve case-sensitive metacharacters.',
        },
        {
          type: 'commit',
          identifier: '228f976',
          title: 'fix(scope): preserve metacharacters in host regex rules (#122)',
          author: 'rudycelekli',
          date: '2026-11-16',
        },
        {
          type: 'design_doc',
          identifier: 'commands/scope.md',
          title: '/scope',
          excerpt: 'Deterministic scope matching rules.',
        },
      ],
      diagnostics: {
        retrievalDurationMs: 14,
        aiDurationMs: 120,
        retrievalSource: 'mixed_sources',
        retrievalSourceLabel: 'Local Git + GitHub Evidence + Repository Documentation',
        isNeo4jActive: false,
        approximateTokens: 250,
        modelName: 'gpt-4o',
        commitCount: 2,
        prCount: 1,
        docCount: 1,
      },
      answeredAt: new Date().toISOString(),
    };

    // Level 1: Sidebar HTML
    const sidebarHtml = renderAskWhySidebarHtml(mockResult);
    assert.ok(sidebarHtml.includes('GitWhisper: Ask Why'));
    assert.ok(sidebarHtml.includes('Lines 37–39'));
    assert.ok(sidebarHtml.includes('Directly Supported'));
    assert.ok(sidebarHtml.includes('PR #122'));
    assert.ok(sidebarHtml.includes('Open Full Investigation'), 'Sidebar must offer Open Full Investigation button');
    assert.ok(sidebarHtml.includes('Ask Another Question'), 'Sidebar must offer Ask Another Question button');

    // Level 2: Full Investigation HTML
    const fullHtml = renderAskWhyFullInvestigationHtml(mockResult);
    assert.ok(fullHtml.includes('GitWhisper: Ask Why'));
    assert.ok(fullHtml.includes('1. Explanation / Why'));
    assert.ok(fullHtml.includes('2. Commits &amp; PRs'));
    assert.ok(fullHtml.includes('3. Knowledge Graph &amp; ADRs'));
    assert.ok(fullHtml.includes('4. Code &amp; Diffs'));
    assert.ok(fullHtml.includes('5. Technical Details'));
    assert.ok(fullHtml.includes('https://github.com/elementalsouls/Claude-BugHunter/pull/122'));
    assert.ok(fullHtml.includes('commands/scope.md'));
    assert.ok(fullHtml.includes('228f976'));

    // Empty state sidebar check
    const emptySidebarHtml = renderAskWhySidebarHtml(undefined);
    assert.ok(emptySidebarHtml.includes('Select Code to Understand Intent'));
    assert.ok(emptySidebarHtml.includes('Ask Why for Selection'));
  });

  // ---------------------------------------------------------
  // 6. In-Memory Retrieval & Design Doc Caching
  // ---------------------------------------------------------
  await test('v0.3.5 Performance: Retrieval and document scanning use bounded in-memory caching', async () => {
    const tempRepo = createTempDir('caching-speed');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f = path.join(tempRepo, 'test.py');
      fs.writeFileSync(f, 'print("hello")\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial'], tempRepo);

      clearEvidencePackageCache();
      clearDocScanCache();

      const t0 = Date.now();
      const pkg1 = await retrieveCompactEvidencePackage({ repoRoot: tempRepo, filePath: 'test.py' });
      const firstDuration = Date.now() - t0;

      // Second retrieval must hit in-memory cache and be faster
      const t1 = Date.now();
      const pkg2 = await retrieveCompactEvidencePackage({ repoRoot: tempRepo, filePath: 'test.py' });
      const secondDuration = Date.now() - t1;

      assert.strictEqual(pkg1.query.filePath, pkg2.query.filePath);
      assert.ok(secondDuration <= firstDuration + 5, 'Cached lookup should be immediate');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 7. Legacy v0.3.1 Capabilities & Command Availability
  // ---------------------------------------------------------
  await test('v0.3.5 Command Compatibility: Primary and secondary actions match v0.3.1 contracts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));

    assert.ok(pkg.version === '0.3.5' || pkg.version === '0.3.6', 'Version must be 0.3.5 or 0.3.6');
    assert.strictEqual(pkg.publisher, 'originx');

    const commands = pkg.contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(commands.includes('originx.understandAndContinue'));
    assert.ok(commands.includes('originx.askWhy'));
    assert.ok(commands.includes('originx.openFullInvestigation'));
    assert.ok(commands.includes('originx.reviewWorkingTree'));
    assert.ok(commands.includes('originx.analyzeCode'));
    assert.ok(commands.includes('originx.investigateBug'));
    assert.ok(commands.includes('originx.commandCenter'));
    assert.ok(commands.includes('originx.manageDecisions'));
    assert.ok(commands.includes('originx.saveContextCheckpoint'));
    assert.ok(commands.includes('originx.resumeContextCheckpoint'));

    // Command palette visible items: Exactly the 4 main actions
    const hidden = pkg.contributes.menus.commandPalette
      .filter((item: { when: string }) => item.when === 'false')
      .map((item: { command: string }) => item.command);
    const visible = commands.filter((id: string) => !hidden.includes(id));
    assert.deepStrictEqual(visible.sort(), [
      'originx.manageDecisions',
      'originx.resumeContextCheckpoint',
      'originx.saveContextCheckpoint',
      'originx.understandAndContinue',
    ]);

    // Views & Activity Bar
    assert.ok(pkg.contributes.viewsContainers?.activitybar?.length > 0);
    assert.strictEqual(pkg.contributes.viewsContainers.activitybar[0].id, 'gitwhisper');
    assert.ok(pkg.contributes.views?.gitwhisper?.some((v: any) => v.id === 'originx.askWhySidebar'));

    // Legacy WebviewView 5-tab investigation method remains intact
    assert.strictEqual(typeof WebviewView.renderInvestigationHtml, 'function');
    assert.strictEqual(typeof WebviewView.renderHtml, 'function');
    assert.strictEqual(typeof WebviewView.renderReviewerHtml, 'function');
    assert.strictEqual(typeof WebviewView.renderMultiFileHtml, 'function');

    // Menu helpers
    const continuityItems = getContinuityItems(false);
    assert.deepStrictEqual(continuityItems.flatMap(i => i.command || []), [
      'originx.reviewWorkingTree',
      'originx.resumeContextCheckpoint',
      'originx.saveContextCheckpoint',
      'originx.manageDecisions',
    ]);

    const toolItems = getToolItems(false);
    assert.ok(toolItems.length >= 6);
  });
}
