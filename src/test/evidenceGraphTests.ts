/**
 * GitWhisper — Historical Evidence Graph & Ingestion Test Suite
 * Tests GitHub client, rate limit handling, pagination, reference parsing,
 * design doc scanner, dry-run importer, and GraphRAG retriever.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runGit, ICancellationTokenLike } from '../git/gitService';
import {
  GitHubApiError,
  GitHubClient,
  extractCommitReferences,
  extractIncidentMetadata,
  extractIssueReferences,
  GitHubService,
  parseGitHubRemote,
} from '../github';
import {
  extractCodeFileReferences,
  hasAdrStructure,
  parseMarkdownDocument,
  scanDesignDocuments,
  filterRelevantDesignDocs,
  planEvidenceGraphDryRun,
  importEvidenceGraph,
  computeConfidenceSignals,
  retrieveCompactEvidencePackage,
  evaluateSupersession,
  extractDecisionsFromContext,
  GraphDesignDocumentNode,
  LocalGitCommit,
} from '../evidenceGraph';

function createTempDir(prefix: string): string {
  const dir = path.resolve(__dirname, `../../temp-evid-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

export async function runEvidenceGraphTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
) {
  // ---------------------------------------------------------
  // 1. GitHub Remote & Reference Parsing
  // ---------------------------------------------------------
  await test('EvidenceGraph: parseGitHubRemote correctly extracts owner and repo', () => {
    assert.deepStrictEqual(
      parseGitHubRemote('https://github.com/elementalsouls/Claude-BugHunter.git'),
      { owner: 'elementalsouls', repo: 'Claude-BugHunter' }
    );
    assert.deepStrictEqual(
      parseGitHubRemote('https://github.com/owner/repo'),
      { owner: 'owner', repo: 'repo' }
    );
    assert.deepStrictEqual(
      parseGitHubRemote('git@github.com:elementalsouls/Claude-BugHunter.git'),
      { owner: 'elementalsouls', repo: 'Claude-BugHunter' }
    );
    assert.deepStrictEqual(
      parseGitHubRemote('ssh://git@github.com/org/project.git'),
      { owner: 'org', repo: 'project' }
    );
    assert.strictEqual(parseGitHubRemote('not-a-github-url'), null);
  });

  await test('EvidenceGraph: extractIssueReferences identifies #123, GH-123, and fixes #123', () => {
    const text = 'Fixes #122 and closes gh-45. Also see #122 again and #999.';
    const refs = extractIssueReferences(text);
    assert.deepStrictEqual(refs, [45, 122, 999]);
  });

  await test('EvidenceGraph: extractCommitReferences identifies 7-40 hex shas without false positives', () => {
    const text = 'Reverts commit 228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10 and 228f976. But 1234567 is not a sha.';
    const refs = extractCommitReferences(text);
    assert.ok(refs.includes('228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10'));
    assert.ok(refs.includes('228f976'));
    assert.ok(!refs.includes('1234567'));
  });

  await test('EvidenceGraph: extractIncidentMetadata detects P0, critical, and outage flags accurately', () => {
    const p0 = extractIncidentMetadata('Fix memory leak', ['p0', 'bug']);
    assert.strictEqual(p0.isIncident, true);
    assert.strictEqual(p0.severity, 'P0');

    const critical = extractIncidentMetadata('[CRITICAL] Auth outage', ['security']);
    assert.strictEqual(critical.isIncident, true);
    assert.strictEqual(critical.severity, 'critical');

    const normal = extractIncidentMetadata('Update README.md', ['docs']);
    assert.strictEqual(normal.isIncident, false);
  });

  // ---------------------------------------------------------
  // 2. GitHub Client & Rate Limit Handling
  // ---------------------------------------------------------
  await test('EvidenceGraph: GitHubClient parses rate limit headers and detects exhaustion', async () => {
    const mockHeaders = {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': `${Math.floor(Date.now() / 1000) + 120}`,
    };

    const client = new GitHubClient({
      fetchFn: async () => {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: mockHeaders,
        });
      },
    });

    await assert.rejects(
      async () => {
        await client.get('/rate-limit-test');
      },
      (err: any) => {
        assert.ok(err instanceof GitHubApiError);
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.rateLimit?.isExhausted, true);
        return true;
      }
    );
  });

  await test('EvidenceGraph: GitHubClient paginates multiple pages up to maxItems', async () => {
    let callCount = 0;
    const client = new GitHubClient({
      fetchFn: async (url: any) => {
        callCount++;
        const urlStr = url.toString();
        const isPage2 = /[?&]page=2(&|$)/.test(urlStr);
        const data = isPage2 ? [{ id: 3 }] : [{ id: 1 }, { id: 2 }];
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '58',
            'x-ratelimit-reset': '1999999999',
          },
        });
      },
    });

    const result = await client.getPaginated<any>('/items', { maxItems: 3, perPage: 2 });
    assert.strictEqual(result.items.length, 3);
    assert.strictEqual(callCount, 2);
    assert.deepStrictEqual(result.items.map(i => i.id), [1, 2, 3]);
  });

  await test('EvidenceGraph: GitHubClient respects cancellation tokens', async () => {
    let cancelled = false;
    const dummyToken: ICancellationTokenLike = {
      get isCancellationRequested() {
        return true;
      },
      onCancellationRequested: () => ({ dispose: () => {} }),
    };

    const client = new GitHubClient();
    await assert.rejects(
      async () => {
        await client.get('/test', { cancellationToken: dummyToken });
      },
      (err: any) => {
        assert.strictEqual(err.status, 499);
        return true;
      }
    );
  });

  // ---------------------------------------------------------
  // 3. GitHub Service Ingestion with Mock Client
  // ---------------------------------------------------------
  await test('EvidenceGraph: GitHubService fetches PRs with commits, files, and comments', async () => {
    const mockClient = new GitHubClient({
      fetchFn: async (url: any) => {
        const u = url.toString();
        if (u.includes('/pulls?state=all')) {
          return new Response(JSON.stringify([
            {
              id: 101,
              number: 122,
              title: 'fix(scope): preserve metacharacters in host regex rules (#122)',
              body: 'Lowercasing converted \\D to \\d. Fixes #120.',
              state: 'closed',
              merged_at: '2026-11-16T13:10:49Z',
              user: { login: 'rudycelekli' },
              merge_commit_sha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
              head: { sha: '999abc' },
              base: { ref: 'main' },
              html_url: 'https://github.com/elementalsouls/Claude-BugHunter/pull/122',
            },
          ]), { status: 200 });
        }
        if (u.includes('/issues/122/comments')) {
          return new Response(JSON.stringify([
            {
              id: 501,
              body: 'Reviewed and confirmed regex metacharacter fix.',
              user: { login: 'reviewer1' },
              created_at: '2026-11-16T13:00:00Z',
              updated_at: '2026-11-16T13:00:00Z',
              html_url: 'https://github.com/...',
            },
          ]), { status: 200 });
        }
        if (u.includes('/pulls/122/files')) {
          return new Response(JSON.stringify([
            {
              filename: 'engine/scope.py',
              status: 'modified',
              additions: 5,
              deletions: 2,
              changes: 7,
            },
          ]), { status: 200 });
        }
        if (u.includes('/pulls/122/commits')) {
          return new Response(JSON.stringify([
            {
              sha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
              commit: {
                message: 'fix(scope): preserve metacharacters in host regex rules (#122)',
                author: { name: 'Rudy', email: 'rudy@example.com', date: '2026-11-16T13:05:00Z' },
              },
            },
          ]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    const service = new GitHubService(mockClient);
    const prs = await service.fetchRepositoryPullRequests('elementalsouls', 'Claude-BugHunter', {
      maxPullRequests: 1,
      fetchComments: true,
      fetchFiles: true,
      fetchCommits: true,
    });

    assert.strictEqual(prs.length, 1);
    const pr = prs[0];
    assert.strictEqual(pr.number, 122);
    assert.strictEqual(pr.isMerged, true);
    assert.strictEqual(pr.changedFiles.length, 1);
    assert.strictEqual(pr.changedFiles[0].filename, 'engine/scope.py');
    assert.strictEqual(pr.commits.length, 1);
    assert.strictEqual(pr.commits[0].sha, '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10');
    assert.ok(pr.referencedIssueNumbers.includes(120));
    assert.ok(pr.referencedIssueNumbers.includes(122));
  });

  // ---------------------------------------------------------
  // 4. Design Document & ADR Scanner
  // ---------------------------------------------------------
  await test('EvidenceGraph: extractCodeFileReferences captures inline code and markdown links', () => {
    const markdown = `
# Scope Rules
See \`engine/scope.py\` and [Scope Docs](commands/scope.md).
Also relates to \`src/auth.ts\`.
Do not match bash commands like \`pytest -v\` or strings like \`invalid file\`.
    `;
    const refs = extractCodeFileReferences(markdown);
    assert.ok(refs.includes('engine/scope.py'));
    assert.ok(refs.includes('commands/scope.md'));
    assert.ok(refs.includes('src/auth.ts'));
    assert.ok(!refs.includes('pytest -v'));
  });

  await test('EvidenceGraph: scanDesignDocuments parses local repository docs and ADRs', () => {
    const tempDir = createTempDir('docs-scan');
    try {
      const docsDir = path.join(tempDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });

      fs.writeFileSync(
        path.join(docsDir, 'architecture.md'),
        `# System Architecture
## Context
This project uses microservices for code analysis.
## Decision
We choose \`engine/scope.py\` for deterministic pattern filtering.
## Rationale
Ensures low latency and security isolation.
Fixes #122.
`,
        'utf8'
      );

      const docs = scanDesignDocuments(tempDir, { repoId: 'test-repo' });
      assert.strictEqual(docs.length, 1);
      const doc = docs[0];
      assert.strictEqual(doc.title, 'System Architecture');
      assert.strictEqual(doc.hasDecisionStructure, true);
      assert.ok(doc.referencedFiles.includes('engine/scope.py'));
      assert.ok(doc.referencedIssueNumbers.includes(122));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // ---------------------------------------------------------
  // 5. Evidence Graph Importer & Dry-Run Planner
  // ---------------------------------------------------------
  await test('EvidenceGraph: planEvidenceGraphDryRun creates accurate dry-run plan without writing to DB', () => {
    const dryRun = planEvidenceGraphDryRun({
      repoId: 'elementalsouls/Claude-BugHunter',
      pullRequests: [
        {
          id: 101,
          number: 122,
          title: 'fix(scope): preserve metacharacters in host regex rules',
          body: 'Fixes #120',
          state: 'closed',
          isMerged: true,
          mergedAt: '2026-11-16T13:10:49Z',
          createdAt: '2026-11-16T12:00:00Z',
          updatedAt: '2026-11-16T13:10:49Z',
          htmlUrl: 'https://github.com/...',
          user: { login: 'rudycelekli' },
          mergeCommitSha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
          headSha: '999abc',
          baseRef: 'main',
          headRef: 'patch-1',
          reviewers: [],
          comments: [
            {
              id: 1,
              body: 'Good catch on the lowercase regex issue.',
              user: { login: 'reviewer' },
              createdAt: '2026-11-16T13:00:00Z',
              updatedAt: '2026-11-16T13:00:00Z',
              htmlUrl: '',
              commentType: 'issue',
            },
          ],
          commits: [
            {
              sha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
              shortSha: '228f976',
              message: 'fix(scope): preserve metacharacters in host regex rules',
              authorName: 'Rudy',
              authorEmail: '',
              date: '',
            },
          ],
          changedFiles: [
            {
              filename: 'engine/scope.py',
              status: 'modified',
              additions: 5,
              deletions: 2,
              changes: 7,
            },
          ],
          referencedIssueNumbers: [120],
        },
      ],
      issues: [
        {
          id: 201,
          number: 120,
          title: 'Host regex fails on \\D escape sequences',
          body: 'Pattern \\D is treated as \\d when lowercased.',
          state: 'closed',
          createdAt: '2026-11-16T11:00:00Z',
          updatedAt: '2026-11-16T13:15:00Z',
          htmlUrl: '',
          user: { login: 'user1' },
          labels: [{ name: 'bug' }, { name: 'p0' }],
          isPullRequest: false,
          isIncident: true,
          incidentSeverity: 'P0',
          comments: [],
          referencedPrNumbers: [122],
          referencedCommitShas: [],
        },
      ],
      designDocs: [
        {
          id: 'elementalsouls/Claude-BugHunter:doc-commands/scope.md',
          repoId: 'elementalsouls/Claude-BugHunter',
          path: 'commands/scope.md',
          title: 'Scope Command Specification',
          summary: 'Deterministic scope matching',
          sections: [],
          referencedFiles: ['engine/scope.py'],
          referencedIssueNumbers: [120],
          referencedPrNumbers: [122],
          hasDecisionStructure: true,
          lastModified: '2026-11-16T12:00:00Z',
        },
      ],
    });

    assert.strictEqual(dryRun.dryRun, true);
    assert.strictEqual(dryRun.repositoryId, 'elementalsouls/Claude-BugHunter');
    assert.strictEqual(dryRun.nodesToCreateOrMerge.pullRequests, 1);
    assert.strictEqual(dryRun.nodesToCreateOrMerge.issues, 1);
    assert.strictEqual(dryRun.nodesToCreateOrMerge.comments, 1);
    assert.strictEqual(dryRun.nodesToCreateOrMerge.designDocs, 1);
    assert.ok(dryRun.relationshipsToCreate.commitToPr >= 1);
    assert.ok(dryRun.relationshipsToCreate.prToFile >= 1);
    assert.ok(dryRun.relationshipsToCreate.docToFile >= 1);
    assert.ok(dryRun.sampleQueries.length >= 3);
  });

  await test('EvidenceGraph: importEvidenceGraph defaults to dry-run when driver is null', async () => {
    const res = await importEvidenceGraph(null, {
      repoId: 'test-repo',
      pullRequests: [],
      issues: [],
    });

    assert.strictEqual(res.status, 'dry_run');
    assert.ok(res.dryRunPlan);
  });

  await test('EvidenceGraph: importEvidenceGraph executes parameterized MERGE queries against mock driver', async () => {
    const executedQueries: Array<{ query: string; params: any }> = [];
    const mockDriver: any = {
      session: () => ({
        run: async (query: string, params: any) => {
          executedQueries.push({ query, params });
          return { records: [] };
        },
        close: async () => {},
      }),
    };

    const res = await importEvidenceGraph(
      mockDriver,
      {
        repoId: 'test-repo',
        pullRequests: [
          {
            id: 1,
            number: 10,
            title: 'Test PR',
            body: 'Body',
            state: 'open',
            isMerged: false,
            createdAt: '',
            updatedAt: '',
            htmlUrl: 'https://...',
            user: { login: 'tester' },
            headSha: 'abc',
            baseRef: 'main',
            headRef: 'test',
            reviewers: [],
            comments: [],
            commits: [],
            changedFiles: [{ filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
            referencedIssueNumbers: [],
          },
        ],
      },
      { dryRun: false }
    );

    assert.strictEqual(res.status, 'ok');
    assert.ok(executedQueries.length >= 2);
    // Verifies parameterized MERGE queries are used
    assert.ok(executedQueries.some(q => q.query.includes('MERGE (n:PullRequest {id: pr.id})')));
    assert.ok(executedQueries.some(q => q.query.includes('MERGE (pr)-[:MODIFIED_FILE')));
  });

  // ---------------------------------------------------------
  // 6. GraphRAG Evidence Package Retrieval & Fallback
  // ---------------------------------------------------------
  await test('EvidenceGraph: computeConfidenceSignals scores evidence accurately', () => {
    const full = computeConfidenceSignals(true, true, true, false);
    assert.strictEqual(full.confidenceScore, 1.0);
    assert.strictEqual(full.hasPrEvidence, true);
    assert.strictEqual(full.hasDesignDocGrounding, true);

    const superseded = computeConfidenceSignals(true, false, false, true, {
      commitHash: 'newer123',
      date: '2026-11-20',
      subject: 'Refactor scope',
    });
    assert.strictEqual(superseded.isSuperseded, true);
    assert.ok(superseded.confidenceScore < 1.0);
  });

  await test('EvidenceGraph: retrieveCompactEvidencePackage runs local Git & doc fallback deterministically', async () => {
    const tempRepo = createTempDir('retriever-fallback');
    try {
      await runGit(['init', '-b', 'main'], tempRepo);
      await runGit(['config', 'user.name', 'Tester'], tempRepo);
      await runGit(['config', 'user.email', 'tester@example.com'], tempRepo);

      // Create engine/scope.py
      const engineDir = path.join(tempRepo, 'engine');
      fs.mkdirSync(engineDir, { recursive: true });
      const scopeFile = path.join(engineDir, 'scope.py');
      fs.writeFileSync(scopeFile, '# initial scope\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(['commit', '-m', 'feat: initial scope commit'], tempRepo);

      // Create PR-like commit
      fs.appendFileSync(scopeFile, '# preserve metacharacters in host regex\n', 'utf8');
      await runGit(['add', '.'], tempRepo);
      await runGit(
        ['commit', '-m', 'fix(scope): preserve metacharacters in host regex rules (#122)\n\nResolves #120'],
        tempRepo
      );

      // Create design doc commands/scope.md
      const cmdDir = path.join(tempRepo, 'commands');
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdDir, 'scope.md'),
        '# Scope Command\nSee `engine/scope.py` for regex matching rules.\n',
        'utf8'
      );

      const pkg = await retrieveCompactEvidencePackage({
        filePath: 'engine/scope.py',
        repoRoot: tempRepo,
      });

      assert.strictEqual(pkg.retrievalSource, 'local_git_and_docs_fallback');
      assert.strictEqual(pkg.query.filePath, 'engine/scope.py');
      assert.strictEqual(pkg.connectedCommits.length, 2);
      assert.strictEqual(pkg.connectedPullRequests.length, 1);
      assert.strictEqual(pkg.connectedPullRequests[0].number, 122);
      assert.strictEqual(pkg.groundingDocuments.length, 1);
      assert.strictEqual(pkg.groundingDocuments[0].path, 'commands/scope.md');
      assert.strictEqual(pkg.confidenceSignals.hasPrEvidence, true);
      assert.strictEqual(pkg.confidenceSignals.hasDesignDocGrounding, true);
      assert.ok(pkg.confidenceSignals.confidenceScore >= 0.7);
    } finally {
      cleanupTempDir(tempRepo);
    }
  });

  // ---------------------------------------------------------
  // 7. Evidence Integrity, Supersession & Decision Graph Tests
  // ---------------------------------------------------------
  await test('EvidenceGraph: evaluateSupersession prevents false supersession on unrelated subsequent commits (228f976 vs dbb9a59)', () => {
    // Exact scenario from Claude-BugHunter:
    // 228f976 fixed host regex metacharacter rules.
    // bf06658 normalized URL bullet tokens in scope.md.
    // dbb9a59 fixed UTF-8 file/console I/O encoding on Windows.
    const commits: LocalGitCommit[] = [
      {
        hash: 'dbb9a590e558b9524e51c07c65d9460530d741e2',
        shortHash: 'dbb9a59',
        author: 'Sachin Sharma',
        date: '2026-11-20T21:23:22+05:30',
        subject: 'fix(engine): utf-8 encoding for all file/console I/O (Windows cp1252 crash) (#191)',
        body: 'Fixes #189. Pin encoding="utf-8" on every text-mode open().',
        prNumber: 191,
        referencedIssues: [189],
      },
      {
        hash: 'bf066585aebaa88a621d0f69095789f06c08824e',
        shortHash: 'bf06658',
        author: 'Ege',
        date: '2026-11-18T12:39:13+03:00',
        subject: 'fix(scope): reduce URL bullets in scope.md to their host (#155)',
        body: 'A scope.md bullet pasted from a program page is usually a URL.',
        prNumber: 155,
        referencedIssues: [155],
      },
      {
        hash: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
        shortHash: '228f976',
        author: 'Rudy Mizrahi Celekli',
        date: '2026-11-16T08:10:49-05:00',
        subject: 'fix(scope): preserve metacharacters in host regex rules (#122)',
        body: 'Scope matching lowercased the whole regex, changing escapes such as \\D into \\d.',
        prNumber: 122,
        referencedIssues: [122],
      },
    ];

    const result = evaluateSupersession('228f976', 122, commits);
    assert.strictEqual(result.status, 'current', '228f976 must remain current despite later unrelated commits');
    assert.strictEqual(result.supersededBy, undefined);
    assert.ok(result.explanation.includes('Active decision'));
    assert.ok(result.explanation.includes('orthogonal concerns'));
  });

  await test('EvidenceGraph: evaluateSupersession detects explicit git revert commits', () => {
    const commits: LocalGitCommit[] = [
      {
        hash: 'abc1234567890abcdef1234567890abcdef1234',
        shortHash: 'abc1234',
        author: 'Reviewer',
        date: '2026-11-17T10:00:00Z',
        subject: 'Revert "fix(scope): preserve metacharacters in host regex rules (#122)"',
        body: 'This reverts commit 228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10 due to performance regression.',
        prNumber: 130,
        referencedIssues: [],
      },
      {
        hash: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
        shortHash: '228f976',
        author: 'Rudy',
        date: '2026-11-16T08:10:49Z',
        subject: 'fix(scope): preserve metacharacters in host regex rules (#122)',
        body: 'Scope matching regex fix.',
        prNumber: 122,
        referencedIssues: [122],
      },
    ];

    const result = evaluateSupersession('228f976', 122, commits);
    assert.strictEqual(result.status, 'explicitly_superseded');
    assert.ok(result.supersededBy);
    assert.strictEqual(result.supersededBy.shortHash, 'abc1234');
    assert.ok(result.explanation.includes('Revert'));
  });

  await test('EvidenceGraph: evaluateSupersession detects explicit supersedes/replaces declarations', () => {
    const commits: LocalGitCommit[] = [
      {
        hash: 'def567890abcdef1234567890abcdef12345678',
        shortHash: 'def5678',
        author: 'Architect',
        date: '2026-11-19T10:00:00Z',
        subject: 'feat(scope): rewrite pattern engine with hyperscan (supersedes #122)',
        body: 'Replaces previous regex lowercasing approach with streaming DFA.',
        prNumber: 170,
        referencedIssues: [],
      },
      {
        hash: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
        shortHash: '228f976',
        author: 'Rudy',
        date: '2026-11-16T08:10:49Z',
        subject: 'fix(scope): preserve metacharacters in host regex rules (#122)',
        body: 'Scope matching regex fix.',
        prNumber: 122,
        referencedIssues: [122],
      },
    ];

    const result = evaluateSupersession('228f976', 122, commits);
    assert.strictEqual(result.status, 'explicitly_superseded');
    assert.ok(result.supersededBy);
    assert.strictEqual(result.supersededBy.shortHash, 'def5678');
  });

  await test('EvidenceGraph: extractDecisionsFromContext extracts structured Decision nodes from PR rationale', () => {
    const prs = [
      {
        number: 122,
        title: 'fix(scope): preserve metacharacters in host regex rules (#122)',
        body: '## What does this change?\nScope matching lowercased the whole regex, changing escapes such as \\D into \\d and reversing the rule. Preserve the expression and match case-insensitively with the regex engine.',
        rationaleSummary: 'Preserve metacharacters in host regex rules',
        author: 'rudycelekli',
        mergedAt: '2026-11-16T13:10:49Z',
        url: 'https://github.com/elementalsouls/Claude-BugHunter/pull/122',
        changedFiles: [{ filename: 'engine/scope.py' }],
        headSha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
      },
    ];

    const decisions = extractDecisionsFromContext('test-repo', prs, [], 'engine/scope.py');
    assert.strictEqual(decisions.length, 1);
    const d = decisions[0];
    assert.strictEqual(d.id, 'test-repo:decision:pr-122');
    assert.strictEqual(d.decisionId, 'DEC-PR-122');
    assert.strictEqual(d.title, 'Preserve metacharacters in host regex rules');
    assert.ok(d.rationale.includes('Scope matching lowercased the whole regex'));
    assert.strictEqual(d.sourceType, 'pull_request_rationale');
    assert.strictEqual(d.targetFile, 'engine/scope.py');
    assert.strictEqual(d.author, 'rudycelekli');
    assert.strictEqual(d.evidenceClassification, 'directly_supported');
    assert.strictEqual(d.status, 'current');
  });

  await test('EvidenceGraph: extractDecisionsFromContext rejects trivial commits and unsupported hypotheses', () => {
    const trivialPrs = [
      {
        number: 99,
        title: 'chore: bump version',
        body: 'bump',
        rationaleSummary: 'bump',
        author: 'bot',
        url: 'https://github.com/test/99',
      },
      {
        number: 100,
        title: 'wip: test',
        body: 'wip commit',
        rationaleSummary: 'wip',
        author: 'dev',
        url: 'https://github.com/test/100',
      },
    ];

    const decisions = extractDecisionsFromContext('test-repo', trivialPrs, [], 'engine/scope.py');
    assert.strictEqual(decisions.length, 0, 'Trivial PRs without substantive rationale must not generate decisions');
  });

  await test('EvidenceGraph: filterRelevantDesignDocs ranks and filters documents relevant to target file', () => {
    const docs: GraphDesignDocumentNode[] = [
      {
        id: 'doc-1',
        repoId: 'repo',
        path: 'commands/scope.md',
        title: 'Scope Command',
        summary: 'Scope verification',
        sections: [{ heading: 'Overview', contentSnippet: 'Uses `engine/scope.py` for deterministic filtering.' }],
        referencedFiles: ['engine/scope.py'],
        referencedIssueNumbers: [],
        referencedPrNumbers: [],
        hasDecisionStructure: false,
        lastModified: '',
      },
      {
        id: 'doc-2',
        repoId: 'repo',
        path: 'docs/disclosed-reports/hunt-clickjacking.md',
        title: 'Clickjacking Guide',
        summary: 'General guide',
        sections: [{ heading: 'Headers', contentSnippet: 'X-Frame-Options' }],
        referencedFiles: [],
        referencedIssueNumbers: [],
        referencedPrNumbers: [],
        hasDecisionStructure: false,
        lastModified: '',
      },
    ];

    const relevant = filterRelevantDesignDocs(docs, 'engine/scope.py');
    assert.strictEqual(relevant.length, 1);
    assert.strictEqual(relevant[0].doc.path, 'commands/scope.md');
    assert.strictEqual(relevant[0].relevanceScore, 100);
  });

  await test('EvidenceGraph: planEvidenceGraphDryRun creates Decision nodes and links them to PR and File', () => {
    const dryRun = planEvidenceGraphDryRun({
      repoId: 'elementalsouls/Claude-BugHunter',
      pullRequests: [
        {
          id: 122,
          number: 122,
          title: 'fix(scope): preserve metacharacters in host regex rules',
          body: 'Scope matching lowercased the whole regex, changing escapes such as \\D into \\d.',
          state: 'closed',
          isMerged: true,
          mergedAt: '2026-11-16T13:10:49Z',
          createdAt: '2026-11-16T12:00:00Z',
          updatedAt: '2026-11-16T13:10:49Z',
          htmlUrl: 'https://github.com/elementalsouls/Claude-BugHunter/pull/122',
          user: { login: 'rudycelekli' },
          headSha: '228f976a6535ae2bd6d8b4e5736f5e1ca1c7ec10',
          baseRef: 'main',
          headRef: 'patch-1',
          reviewers: [],
          comments: [],
          commits: [],
          changedFiles: [{ filename: 'engine/scope.py', status: 'modified', additions: 5, deletions: 2, changes: 7 }],
          referencedIssueNumbers: [],
        },
      ],
    });

    assert.strictEqual(dryRun.nodesToCreateOrMerge.decisions, 1, 'Must extract at least 1 Decision node from explicit PR rationale');
    assert.strictEqual(dryRun.relationshipsToCreate.decisionToPr, 1);
    assert.strictEqual(dryRun.relationshipsToCreate.decisionToFile, 1);
    assert.strictEqual(dryRun.relationshipsToCreate.decisionToCommit, 1);
  });
}
