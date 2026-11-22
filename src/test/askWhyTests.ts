/**
 * GitWhisper — Flagship "Ask Why" (Why The Code Is Like This) Test Suite
 * Tests question-to-evidence retrieval, citation generation, evidence-limited reasoning,
 * strict abstention/refusal on missing rationale, supersession reporting, and webview rendering.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runGit, ICancellationTokenLike } from '../git/gitService';
import {
  buildAskWhyPrompt,
  executeAskWhy,
} from '../askWhy/askWhyService';
import { renderAskWhyHtml } from '../askWhy/askWhyWebview';
import { AskWhyRequest, AskWhyResult } from '../askWhy/askWhyTypes';
import { ILanguageModelProvider } from '../lm/vscodeLmClient';

function createTempDir(prefix: string): string {
  const dir = path.resolve(__dirname, `../../temp-askwhy-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

export async function runAskWhyTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
) {
  // ---------------------------------------------------------
  // 1. Prompt Construction & Evidence-Limited Grounding Rules
  // ---------------------------------------------------------
  await test('AskWhy: buildAskWhyPrompt includes strict grounding rules, citations, and abstention instructions', () => {
    const prompt = buildAskWhyPrompt(
      'Why does this code preserve regex patterns instead of lowercasing them?',
      {
        filePath: 'engine/scope.py',
        lineRange: { startLine: 31, endLine: 40 },
        selectedSnippet: 'if p[:3].lower() == "re:":\n    return re.search(p[3:], host, re.IGNORECASE)',
      },
      {
        connectedPullRequests: [
          {
            number: 122,
            title: 'fix(scope): preserve metacharacters in host regex rules',
            author: 'rudycelekli',
            mergedAt: '2026-11-16T13:10:49Z',
            rationaleSummary: 'Scope matching lowercased the whole regex, changing escapes such as \\D into \\d.',
            url: 'https://github.com/elementalsouls/Claude-BugHunter/pull/122',
          },
        ],
        connectedCommits: [
          {
            shortHash: '228f976',
            author: 'Rudy',
            date: '2026-11-16',
            subject: 'fix(scope): preserve metacharacters in host regex rules (#122)',
          },
        ],
        groundingDocuments: [
          {
            title: '/scope',
            path: 'commands/scope.md',
            relevantExcerpt: 'Deterministic deny-wins via engine/scope.py',
          },
        ],
        confidenceSignals: {
          supersessionStatus: 'current',
          rationaleSignals: ['Active decision: subsequent commits touch orthogonal concerns'],
        },
      },
      {
        id: 'repo:decision:pr-122',
        repoId: 'repo',
        decisionId: 'DEC-PR-122',
        title: 'Preserve metacharacters in host regex rules',
        rationale: 'Scope matching lowercased the whole regex, changing escapes such as \\D into \\d.',
        sourceType: 'pull_request_rationale',
        sourceReference: 'https://github.com/...',
        targetFile: 'engine/scope.py',
        author: 'rudycelekli',
        recordedAt: '2026-11-16T13:10:49Z',
        status: 'current',
        evidenceClassification: 'directly_supported',
      }
    );

    assert.ok(prompt.includes('Why The Code Is Like This'));
    assert.ok(prompt.includes('CRITICAL GROUNDING & REFUSAL RULES'));
    assert.ok(prompt.includes('INSUFFICIENT HISTORICAL EVIDENCE'));
    assert.ok(prompt.includes('PR #122'));
    assert.ok(prompt.includes('DEC-PR-122'));
    assert.ok(prompt.includes('commands/scope.md'));
    assert.ok(prompt.includes('228f976'));
    assert.ok(prompt.includes('re.IGNORECASE'));
  });

  // ---------------------------------------------------------
  // 2. Real Retrieval & Grounded Reasoning Execution
  // ---------------------------------------------------------
  await test('AskWhy: executeAskWhy retrieves full evidence chain and cites PR and commits for supported question', async () => {
    const tempRepo = createTempDir('supported-chain');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      // Create initial engine/scope.py
      const engineDir = path.join(tempRepo, 'engine');
      fs.mkdirSync(engineDir, { recursive: true });
      const scopeFile = path.join(engineDir, 'scope.py');
      fs.writeFileSync(scopeFile, 'def _match(pattern, host):\n    return False\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial scope implementation'], tempRepo);

      // Create PR #122 commit
      fs.writeFileSync(
        scopeFile,
        'def _match(pattern, host):\n' +
        '    p = pattern.strip()\n' +
        '    if p[:3].lower() == "re:":\n' +
        '        return re.search(p[3:], host, re.IGNORECASE) is not None\n' +
        '    return False\n',
        'utf8'
      );
      await runGit(['add', '.'], tempRepo);
      await runGit(
        ['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\n' +
          'Scope matching lowercased the whole regex, changing escapes such as \\D into \\d and reversing the rule. ' +
          'Preserve the expression and match case-insensitively with the regex engine.'],
        tempRepo
      );

      // Create commands/scope.md
      const cmdDir = path.join(tempRepo, 'commands');
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdDir, 'scope.md'),
        '# Scope Command\n\nSee `engine/scope.py` for deterministic regex matching rules.\n',
        'utf8'
      );

      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'engine/scope.py',
        question: 'Why does this code preserve regex patterns instead of lowercasing them?',
        lineRange: { startLine: 3, endLine: 4 },
      });

      assert.strictEqual(result.isRefusalOrInsufficient, false);
      assert.strictEqual(result.evidenceClassification, 'directly_supported');
      assert.strictEqual(result.supersessionStatus, 'current');
      assert.ok(result.answer.includes('Scope matching lowercased the whole regex') || result.answer.includes('PR #122'));
      assert.ok(result.citations.some(c => c.identifier === 'PR #122'));
      assert.ok(result.citations.some(c => c.identifier === 'commands/scope.md'));
      assert.strictEqual(result.diagnostics.retrievalSource, 'mixed_sources');
      assert.ok(result.diagnostics.retrievalDurationMs >= 0);
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 3. Strict Abstention / Refusal on Insufficient Evidence
  // ---------------------------------------------------------
  await test('AskWhy: executeAskWhy explicitly abstains and refuses to hallucinate on unexplained code', async () => {
    const tempRepo = createTempDir('unexplained-code');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      // Create file with terse unexplained commit
      const f = path.join(tempRepo, 'calc.py');
      fs.writeFileSync(f, 'x = 42\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'update'], tempRepo);

      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'calc.py',
        question: 'Why is x set to 42 instead of 100?',
      });

      assert.strictEqual(result.isRefusalOrInsufficient, true);
      assert.strictEqual(result.evidenceClassification, 'insufficient_evidence');
      assert.ok(result.answer.startsWith('INSUFFICIENT HISTORICAL EVIDENCE'));
      assert.ok(result.answer.includes('calc.py'));
      assert.ok(result.answer.includes('No associated pull request description or architecture decision record'));
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 4. Observability & Retrieval Source Indicator
  // ---------------------------------------------------------
  await test('AskWhy: executeAskWhy reports honest retrieval source without misrepresenting local fallback', async () => {
    const tempRepo = createTempDir('source-check');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f = path.join(tempRepo, 'app.ts');
      fs.writeFileSync(f, 'export const port = 8080;\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial port setting'], tempRepo);

      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'app.ts',
        question: 'Why port 8080?',
      });

      // Must be local git, NOT neo4j
      assert.strictEqual(result.diagnostics.isNeo4jActive, false);
      assert.strictEqual(result.diagnostics.retrievalSource, 'local_git');
      assert.strictEqual(result.diagnostics.retrievalSourceLabel, 'Local Git History & Blame');
      assert.ok(!result.diagnostics.retrievalSourceLabel.includes('Neo4j Aura'));
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 5. Webview HTML Rendering & UI Safety
  // ---------------------------------------------------------
  await test('AskWhy: renderAskWhyHtml produces clean, escaped, branded HTML interface', () => {
    const mockResult: AskWhyResult = {
      question: 'Why does this code preserve regex patterns instead of lowercasing them?',
      target: {
        filePath: 'engine/scope.py',
        lineRange: { startLine: 31, endLine: 40 },
        selectedSnippet: 'if p[:3].lower() == "re:":',
      },
      answer: '### Rationale\n\nScope matching lowercased the whole regex, changing `\\D` to `\\d`.\n\n- Fixes **#120** in `PR #122`.',
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
          excerpt: 'Lowercasing inverted allow/deny regex rules.',
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
          excerpt: 'Deterministic deny-wins via engine/scope.py',
        },
      ],
      diagnostics: {
        retrievalDurationMs: 42,
        aiDurationMs: 210,
        retrievalSource: 'mixed_sources',
        retrievalSourceLabel: 'Local Git + GitHub Evidence + Repository Documentation',
        isNeo4jActive: false,
        approximateTokens: 450,
        modelName: 'gpt-4o',
        commitCount: 2,
        prCount: 1,
        docCount: 1,
      },
      answeredAt: new Date().toISOString(),
    };

    const html = renderAskWhyHtml(mockResult);

    assert.ok(html.includes('GitWhisper: Ask Why'), 'Must contain title');
    assert.ok(html.includes('Why The Code Is Like This'), 'Must contain problem statement subtitle');
    assert.ok(html.includes('Directly Supported'), 'Must contain evidence quality badge');
    assert.ok(html.includes('No Supersession Identified (Current)'), 'Must contain supersession pill');
    assert.ok(html.includes('Local Git + GitHub Evidence + Repository Documentation'), 'Must contain honest source pill');
    assert.ok(html.includes('PR #122'), 'Must cite PR #122');
    assert.ok(html.includes('https://github.com/elementalsouls/Claude-BugHunter/pull/122'), 'Must include clickable URL');
    assert.ok(html.includes('commands/scope.md'), 'Must cite design document');
    assert.ok(html.includes('228f976'), 'Must cite commit 228f976');
    assert.ok(html.includes('Save as Decision Memory'), 'Must offer action buttons');
    assert.ok(html.includes('Save Context Checkpoint'), 'Must offer checkpoint button');
  });

  // ---------------------------------------------------------
  // 6. Cancellation & Error Handling
  // ---------------------------------------------------------
  await test('AskWhy: executeAskWhy respects cancellation token cleanly', async () => {
    const tempRepo = createTempDir('cancellation');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      const f = path.join(tempRepo, 'index.ts');
      fs.writeFileSync(f, 'console.log("hello");\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: init'], tempRepo);

      const cancelledToken: ICancellationTokenLike = {
        get isCancellationRequested() {
          return true;
        },
        onCancellationRequested: () => ({ dispose: () => {} }),
      };

      const result = await executeAskWhy({
        repoRoot: tempRepo,
        filePath: 'index.ts',
        question: 'Why hello?',
        cancellationToken: cancelledToken,
      });

      assert.ok(result);
      assert.strictEqual(result.target.filePath, 'index.ts');
    } finally {
      cleanupTempDir(tempRepo);
    }
  });
}
