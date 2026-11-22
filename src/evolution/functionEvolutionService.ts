/**
 * GitWhisper — Multi-PR Function Evolution Service
 * Traces the complete historical journey of a function across multiple commits, PRs,
 * bug fixes, and refactors, distinguishing substantive behavioral changes from formatting.
 */

import { EvolutionCommitItem, FunctionEvolutionTimeline, CommitEvolutionRole } from './types';
import { runGit, findRepoRoot } from '../git/gitService';
import { normalizePath } from '../git/sourcePaths';
import { evaluateSupersession, LocalGitCommit } from '../evidenceGraph/evidenceGraphRetriever';

export interface EvolutionOptions {
  repoRoot?: string;
  maxCommits?: number;
  enclosingFunctionName?: string;
  knownPullRequests?: Map<number, { title: string; url?: string; rationale?: string }>;
}

export class FunctionEvolutionService {
  /**
   * Retrieves and ranks the multi-commit / multi-PR evolution for a given file and line range.
   */
  public async traceFunctionEvolution(
    filePath: string,
    startLine: number,
    endLine: number,
    options: EvolutionOptions = {}
  ): Promise<FunctionEvolutionTimeline> {
    const normPath = normalizePath(filePath);
    const repoRoot = options.repoRoot || (await findRepoRoot(filePath)) || process.cwd();
    const maxCommits = options.maxCommits || 15;

    // 1. Fetch commits affecting this line range via git log -L
    const rawCommits = await this.fetchLineRangeHistory(repoRoot, normPath, startLine, endLine, maxCommits);

    // 2. Classify roles and determine behavioral impact
    const classified: EvolutionCommitItem[] = [];
    const total = rawCommits.length;

    for (let i = 0; i < total; i++) {
      const c = rawCommits[i];
      const isLatest = i === 0;
      const isEarliest = i === total - 1 && total > 1;

      const role = this.classifyRole(c.subject, isLatest, isEarliest);
      const isBehaviorChanging = role !== 'formatting';

      // Parse PR number
      const prMatch = c.subject.match(/#([0-9]+)/);
      let prInfo: EvolutionCommitItem['pullRequest'] | undefined;
      if (prMatch) {
        const prNum = parseInt(prMatch[1], 10);
        if (options.knownPullRequests && options.knownPullRequests.has(prNum)) {
          const prData = options.knownPullRequests.get(prNum)!;
          prInfo = {
            number: prNum,
            title: prData.title,
            url: prData.url,
            rationaleSummary: prData.rationale
          };
        } else {
          prInfo = {
            number: prNum,
            title: c.subject.replace(/\s*\(?#[0-9]+\)?/, '').trim(),
            url: `https://github.com/pull/${prNum}`
          };
        }
      }

      classified.push({
        hash: c.hash,
        shortHash: c.shortHash,
        author: c.author,
        date: c.date,
        subject: c.subject,
        body: c.body,
        role,
        isBehaviorChanging,
        pullRequest: prInfo
      });
    }

    // 3. Evaluate supersession relationships across chronological commits
    let supersededCount = 0;
    for (let i = 0; i < classified.length; i++) {
      const current = classified[i];
      const evalResult = evaluateSupersession(
        current.shortHash,
        current.pullRequest?.number,
        rawCommits
      );
      if (evalResult.status === 'explicitly_superseded') {
        current.supersessionStatus = 'superseded';
        current.supersededBy = evalResult.supersededBy?.shortHash || 'unknown';
        supersededCount++;
      } else if (evalResult.status === 'potentially_affected') {
        current.supersessionStatus = 'unknown';
      } else {
        current.supersessionStatus = 'current';
      }
    }

    // 4. Sort: behavior-changing commits first, preserving chronological clarity
    const behaviorChangingCount = classified.filter(c => c.isBehaviorChanging).length;
    const originCommit = classified.find(c => c.role === 'origin') || (classified.length > 0 ? classified[classified.length - 1] : undefined);
    const currentCommit = classified.find(c => c.role === 'current') || (classified.length > 0 ? classified[0] : undefined);

    const summary = this.buildSummary(
      options.enclosingFunctionName,
      normPath,
      startLine,
      endLine,
      classified,
      originCommit,
      currentCommit,
      supersededCount
    );

    return {
      filePath: normPath,
      targetLineRange: { startLine, endLine },
      enclosingFunctionName: options.enclosingFunctionName,
      originCommit,
      currentCommit,
      commits: classified,
      behaviorChangingCommitsCount: behaviorChangingCount,
      totalCommitsCount: classified.length,
      supersededDecisionsCount: supersededCount,
      summary
    };
  }

  private classifyRole(subject: string, isLatest: boolean, isEarliest: boolean): CommitEvolutionRole {
    const s = subject.toLowerCase();

    if (/\b(format|lint|prettier|style|whitespace|indent)\b/i.test(s)) {
      return 'formatting';
    }
    if (/\b(fix|bug|patch|revert|issue|hotfix|crash|error|prevent|avoid)\b/i.test(s)) {
      return 'bug_fix';
    }
    if (/\b(refactor|clean|cleanup|rename|reorganize|optimize|perf|modularize)\b/i.test(s)) {
      return 'refactor';
    }
    if (/\b(feat|feature|add|implement|support|introduce|create)\b/i.test(s)) {
      return isEarliest ? 'origin' : 'feature';
    }
    if (isEarliest) {
      return 'origin';
    }
    if (isLatest) {
      return 'current';
    }
    return 'feature';
  }

  private async fetchLineRangeHistory(
    repoRoot: string,
    filePath: string,
    startLine: number,
    endLine: number,
    limit: number
  ): Promise<LocalGitCommit[]> {
    const results: LocalGitCommit[] = [];

    // Attempt git log -L first
    try {
      const gitRes = await runGit([
        'log',
        `-${limit}`,
        `-L${Math.max(1, startLine)},${Math.max(startLine, endLine)}:${filePath}`,
        '--format=%x00%H%x00%h%x00%an%x00%aI%x00%s%x00%b%x00'
      ], repoRoot);

      if (gitRes.exitCode === 0 && gitRes.stdout) {
        const chunks = gitRes.stdout.split('\0').filter(Boolean);
        for (let i = 0; i < chunks.length; i += 6) {
          if (i + 4 < chunks.length) {
            const subject = chunks[i + 4];
            const prMatch = subject.match(/#([0-9]+)/);
            results.push({
              hash: chunks[i],
              shortHash: chunks[i + 1],
              author: chunks[i + 2],
              date: chunks[i + 3].split('T')[0],
              subject,
              body: chunks[i + 5]?.trim() || '',
              prNumber: prMatch ? parseInt(prMatch[1], 10) : undefined,
              referencedIssues: []
            });
          }
        }
        if (results.length > 0) return results;
      }
    } catch {
      // Fall through to standard git log on file
    }

    // Fallback: standard git log on filePath
    try {
      const gitRes = await runGit([
        'log',
        `-${limit}`,
        '--format=%H%x00%h%x00%an%x00%aI%x00%s',
        '--',
        filePath
      ], repoRoot);

      if (gitRes.exitCode === 0 && gitRes.stdout) {
        const lines = gitRes.stdout.split('\n').filter(Boolean);
        for (const l of lines) {
          const parts = l.split('\0');
          if (parts.length >= 5) {
            const subject = parts[4];
            const prMatch = subject.match(/#([0-9]+)/);
            results.push({
              hash: parts[0],
              shortHash: parts[1],
              author: parts[2],
              date: parts[3].split('T')[0],
              subject,
              body: '',
              prNumber: prMatch ? parseInt(prMatch[1], 10) : undefined,
              referencedIssues: []
            });
          }
        }
      }
    } catch {
      // Fallback empty
    }

    return results;
  }

  private buildSummary(
    fnName: string | undefined,
    filePath: string,
    startLine: number,
    endLine: number,
    commits: EvolutionCommitItem[],
    origin: EvolutionCommitItem | undefined,
    current: EvolutionCommitItem | undefined,
    supersededCount: number
  ): string {
    const targetLabel = fnName ? `Function \`${fnName}\`` : `Lines ${startLine}–${endLine}`;
    let text = `### Multi-PR Evolution: ${targetLabel} in \`${filePath}\`\n\n`;

    if (commits.length === 0) {
      return text + `No recorded Git commits found for specified line range.\n`;
    }

    text += `Found **${commits.length} commit(s)** shaping this code.\n\n`;

    if (origin) {
      text += `- **Origin:** Commit \`${origin.shortHash}\` (${origin.date}) by ${origin.author} — "${origin.subject}"\n`;
    }
    if (current && current !== origin) {
      text += `- **Current State:** Commit \`${current.shortHash}\` (${current.date}) — "${current.subject}"\n`;
    }
    if (supersededCount > 0) {
      text += `- **Superseded Decisions:** ${supersededCount} prior decision(s) superseded by subsequent fixes.\n`;
    }

    text += `\n| Commit | Date | Role | PR | Subject |\n| :--- | :--- | :--- | :--- | :--- |\n`;
    for (const c of commits) {
      const prCol = c.pullRequest ? `[#${c.pullRequest.number}](${c.pullRequest.url || '#'})` : '—';
      const roleBadge = c.role === 'bug_fix' ? '🐛 Fix' : (c.role === 'refactor' ? '♻️ Refactor' : (c.role === 'origin' ? '🌱 Origin' : '📝 ' + c.role));
      text += `| \`${c.shortHash}\` | ${c.date} | ${roleBadge} | ${prCol} | ${c.subject.slice(0, 50)} |\n`;
    }

    return text;
  }
}
