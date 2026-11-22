/**
 * GitWhisper — GitHub Ingestion Service
 * Ingests pull requests, discussions, issue records, and incident contexts
 * from public GitHub repositories for evidence graph construction.
 */

import { GitHubClient } from './githubClient';
import {
  GitHubComment,
  GitHubCommitSummary,
  GitHubIngestionOptions,
  GitHubIssue,
  GitHubLabel,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubRepositoryEvidence,
  GitHubUser,
} from './githubTypes';

/**
 * Extracts owner and repository name from various Git remote URL formats.
 * e.g.
 * - https://github.com/elementalsouls/Claude-BugHunter.git
 * - git@github.com:elementalsouls/Claude-BugHunter.git
 * - https://github.com/elementalsouls/Claude-BugHunter
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return null;
  }

  const trimmed = remoteUrl.trim();

  // HTTPS match: https://github.com/owner/repo(.git)
  const httpsMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH match: git@github.com:owner/repo(.git)
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Generic SSH url: ssh://git@github.com/owner/repo(.git)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
  }

  return null;
}

/**
 * Extracts referenced issue numbers from text bodies.
 * Matches #123, GH-123, fixes #123, closes #123, etc.
 */
export function extractIssueReferences(text: string): number[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = new Set<number>();
  const issuePattern = /(?:(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+)?(?:#|gh-)(\d+)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = issuePattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num) && num > 0) {
      matches.add(num);
    }
  }

  return Array.from(matches).sort((a, b) => a - b);
}

/**
 * Extracts referenced Git commit SHAs (7 to 40 hex chars) from text bodies.
 */
export function extractCommitReferences(text: string): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = new Set<string>();
  const shaPattern = /\b([0-9a-f]{7,40})\b/gi;
  let match: RegExpExecArray | null;

  while ((match = shaPattern.exec(text)) !== null) {
    const sha = match[1].toLowerCase();
    // Exclude purely numeric strings like "1234567"
    if (/[a-f]/.test(sha)) {
      matches.add(sha);
    }
  }

  return Array.from(matches);
}

/**
 * Detects whether an issue is an incident or production outage based on explicit labels/titles.
 */
export function extractIncidentMetadata(
  title: string,
  labels: (string | GitHubLabel)[]
): { isIncident: boolean; severity?: 'P0' | 'P1' | 'critical' | 'high' | 'unspecified' } {
  const normalizedLabels = labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase());
  const lowerTitle = (title || '').toLowerCase();

  const isP0 = normalizedLabels.some(l => l.includes('p0') || l.includes('p-0')) ||
    /\b\[?p0\]?\b/i.test(lowerTitle);
  const isP1 = normalizedLabels.some(l => l.includes('p1') || l.includes('p-1')) ||
    /\b\[?p1\]?\b/i.test(lowerTitle);
  const isCritical = normalizedLabels.some(l => l.includes('critical') || l.includes('severity: critical')) ||
    lowerTitle.includes('[critical]');
  const isIncidentLabel = normalizedLabels.some(l =>
    l === 'incident' || l === 'outage' || l === 'postmortem' || l.startsWith('incident:')
  );
  const isIncidentTitle = lowerTitle.includes('[incident]') || lowerTitle.includes('[outage]') ||
    lowerTitle.startsWith('incident:') || lowerTitle.startsWith('outage:');

  const isIncident = isP0 || isP1 || isCritical || isIncidentLabel || isIncidentTitle;

  if (!isIncident) {
    return { isIncident: false };
  }

  let severity: 'P0' | 'P1' | 'critical' | 'high' | 'unspecified' = 'unspecified';
  if (isP0) {
    severity = 'P0';
  } else if (isP1) {
    severity = 'P1';
  } else if (isCritical) {
    severity = 'critical';
  } else if (normalizedLabels.some(l => l.includes('high') || l.includes('severity: high'))) {
    severity = 'high';
  }

  return { isIncident: true, severity };
}

export class GitHubService {
  private readonly client: GitHubClient;

  constructor(clientOrOptions?: GitHubClient | GitHubIngestionOptions) {
    if (clientOrOptions instanceof GitHubClient) {
      this.client = clientOrOptions;
    } else {
      this.client = new GitHubClient({
        token: clientOrOptions?.token,
        timeoutMs: clientOrOptions?.timeoutMs,
      });
    }
  }

  public getClient(): GitHubClient {
    return this.client;
  }

  /**
   * Fetches public Pull Requests with discussions, files, and linked issues.
   */
  public async fetchRepositoryPullRequests(
    owner: string,
    repo: string,
    options?: GitHubIngestionOptions
  ): Promise<GitHubPullRequest[]> {
    const maxPrs = options?.maxPullRequests ?? 20;
    const state = options?.state ?? 'all';

    const { items: rawPrs } = await this.client.getPaginated<any>(
      `/repos/${owner}/${repo}/pulls?state=${state}`,
      {
        maxItems: maxPrs,
        perPage: Math.min(maxPrs, 30),
        cancellationToken: options?.cancellationToken,
        timeoutMs: options?.timeoutMs,
      }
    );

    const pullRequests: GitHubPullRequest[] = [];

    for (const raw of rawPrs) {
      if (options?.cancellationToken?.isCancellationRequested) {
        break;
      }

      const comments: GitHubComment[] = [];
      const changedFiles: GitHubPullRequestFile[] = [];
      const commits: GitHubCommitSummary[] = [];

      // 1. Fetch comments if enabled (default true)
      if (options?.fetchComments !== false) {
        try {
          const { items: issueComments } = await this.client.getPaginated<any>(
            `/repos/${owner}/${repo}/issues/${raw.number}/comments`,
            { maxItems: 30, cancellationToken: options?.cancellationToken }
          );

          for (const c of issueComments) {
            comments.push({
              id: c.id,
              body: c.body || '',
              user: {
                login: c.user?.login || 'unknown',
                id: c.user?.id,
                avatarUrl: c.user?.avatar_url,
                htmlUrl: c.user?.html_url,
              },
              createdAt: c.created_at,
              updatedAt: c.updated_at,
              htmlUrl: c.html_url,
              commentType: 'issue',
            });
          }

          // Fetch PR code review comments
          const { items: reviewComments } = await this.client.getPaginated<any>(
            `/repos/${owner}/${repo}/pulls/${raw.number}/comments`,
            { maxItems: 30, cancellationToken: options?.cancellationToken }
          );

          for (const c of reviewComments) {
            comments.push({
              id: c.id,
              body: c.body || '',
              user: {
                login: c.user?.login || 'unknown',
                id: c.user?.id,
                avatarUrl: c.user?.avatar_url,
                htmlUrl: c.user?.html_url,
              },
              createdAt: c.created_at,
              updatedAt: c.updated_at,
              htmlUrl: c.html_url,
              commentType: 'pull_review',
              path: c.path,
              line: c.line ?? c.original_line,
              commitId: c.commit_id,
            });
          }
        } catch {
          // If comments fetch fails, continue gracefully
        }
      }

      // 2. Fetch changed files if enabled (default true)
      if (options?.fetchFiles !== false) {
        try {
          const { items: rawFiles } = await this.client.getPaginated<any>(
            `/repos/${owner}/${repo}/pulls/${raw.number}/files`,
            { maxItems: 50, cancellationToken: options?.cancellationToken }
          );

          for (const f of rawFiles) {
            changedFiles.push({
              filename: f.filename,
              status: f.status,
              additions: f.additions ?? 0,
              deletions: f.deletions ?? 0,
              changes: f.changes ?? 0,
              previousFilename: f.previous_filename,
            });
          }
        } catch {
          // Continue gracefully
        }
      }

      // 3. Fetch PR commits if enabled (default true)
      if (options?.fetchCommits !== false) {
        try {
          const { items: rawCommits } = await this.client.getPaginated<any>(
            `/repos/${owner}/${repo}/pulls/${raw.number}/commits`,
            { maxItems: 50, cancellationToken: options?.cancellationToken }
          );

          for (const c of rawCommits) {
            commits.push({
              sha: c.sha,
              shortSha: c.sha.substring(0, 7),
              message: c.commit?.message || '',
              authorName: c.commit?.author?.name || c.author?.login || 'unknown',
              authorEmail: c.commit?.author?.email || '',
              date: c.commit?.author?.date || c.commit?.committer?.date || '',
            });
          }
        } catch {
          // Continue gracefully
        }
      }

      // Extract referenced issues from title, body, and comments
      const textForRefSearch = [
        raw.title || '',
        raw.body || '',
        ...comments.map(c => c.body),
      ].join('\n');
      const referencedIssueNumbers = extractIssueReferences(textForRefSearch);

      // Extract reviewers
      const reviewers: GitHubUser[] = (raw.requested_reviewers || []).map((r: any) => ({
        login: r.login,
        id: r.id,
        avatarUrl: r.avatar_url,
        htmlUrl: r.html_url,
      }));

      pullRequests.push({
        id: raw.id,
        number: raw.number,
        title: raw.title || '',
        body: raw.body || '',
        state: raw.state === 'closed' ? 'closed' : 'open',
        isMerged: Boolean(raw.merged_at),
        mergedAt: raw.merged_at || undefined,
        closedAt: raw.closed_at || undefined,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        htmlUrl: raw.html_url,
        user: {
          login: raw.user?.login || 'unknown',
          id: raw.user?.id,
          avatarUrl: raw.user?.avatar_url,
          htmlUrl: raw.user?.html_url,
        },
        mergeCommitSha: raw.merge_commit_sha || undefined,
        headSha: raw.head?.sha || '',
        baseRef: raw.base?.ref || '',
        headRef: raw.head?.ref || '',
        reviewers,
        comments,
        commits,
        changedFiles,
        referencedIssueNumbers,
      });
    }

    return pullRequests;
  }

  /**
   * Fetches public Issues with discussion comments and incident context.
   */
  public async fetchRepositoryIssues(
    owner: string,
    repo: string,
    options?: GitHubIngestionOptions
  ): Promise<GitHubIssue[]> {
    const maxIssues = options?.maxIssues ?? 20;
    const state = options?.state ?? 'all';

    const { items: rawIssues } = await this.client.getPaginated<any>(
      `/repos/${owner}/${repo}/issues?state=${state}`,
      {
        maxItems: maxIssues * 2, // GitHub issues endpoint includes PRs, fetch extra to guarantee pure issues
        perPage: Math.min(maxIssues * 2, 40),
        cancellationToken: options?.cancellationToken,
        timeoutMs: options?.timeoutMs,
      }
    );

    const issues: GitHubIssue[] = [];

    for (const raw of rawIssues) {
      if (options?.cancellationToken?.isCancellationRequested) {
        break;
      }

      // GitHub returns PRs under /issues with a 'pull_request' attribute.
      // Filter out PRs here since they are handled by fetchRepositoryPullRequests.
      if (raw.pull_request) {
        continue;
      }

      const labels: GitHubLabel[] = (raw.labels || []).map((l: any) => ({
        name: typeof l === 'string' ? l : l.name,
        color: l.color,
        description: l.description,
      }));

      const incidentInfo = extractIncidentMetadata(raw.title || '', labels);

      const comments: GitHubComment[] = [];
      if (options?.fetchComments !== false && raw.comments > 0) {
        try {
          const { items: issueComments } = await this.client.getPaginated<any>(
            `/repos/${owner}/${repo}/issues/${raw.number}/comments`,
            { maxItems: 30, cancellationToken: options?.cancellationToken }
          );

          for (const c of issueComments) {
            comments.push({
              id: c.id,
              body: c.body || '',
              user: {
                login: c.user?.login || 'unknown',
                id: c.user?.id,
                avatarUrl: c.user?.avatar_url,
                htmlUrl: c.user?.html_url,
              },
              createdAt: c.created_at,
              updatedAt: c.updated_at,
              htmlUrl: c.html_url,
              commentType: 'issue',
            });
          }
        } catch {
          // Continue gracefully
        }
      }

      const textForRefSearch = [
        raw.title || '',
        raw.body || '',
        ...comments.map(c => c.body),
      ].join('\n');

      const referencedPrNumbers = extractIssueReferences(textForRefSearch);
      const referencedCommitShas = extractCommitReferences(textForRefSearch);

      issues.push({
        id: raw.id,
        number: raw.number,
        title: raw.title || '',
        body: raw.body || '',
        state: raw.state === 'closed' ? 'closed' : 'open',
        createdAt: raw.created_at,
        closedAt: raw.closed_at || undefined,
        updatedAt: raw.updated_at,
        htmlUrl: raw.html_url,
        user: {
          login: raw.user?.login || 'unknown',
          id: raw.user?.id,
          avatarUrl: raw.user?.avatar_url,
          htmlUrl: raw.user?.html_url,
        },
        labels,
        isPullRequest: false,
        isIncident: incidentInfo.isIncident,
        incidentSeverity: incidentInfo.severity,
        comments,
        referencedPrNumbers,
        referencedCommitShas,
      });

      if (issues.length >= maxIssues) {
        break;
      }
    }

    return issues;
  }

  /**
   * Fetches full evidence package from GitHub for the repository.
   */
  public async fetchRepositoryEvidence(
    owner: string,
    repo: string,
    options?: GitHubIngestionOptions
  ): Promise<GitHubRepositoryEvidence> {
    const pullRequests = await this.fetchRepositoryPullRequests(owner, repo, options);
    const issues = await this.fetchRepositoryIssues(owner, repo, options);

    return {
      owner,
      repo,
      repositoryId: `${owner}/${repo}`,
      pullRequests,
      issues,
      rateLimit: this.client.getRateLimit(),
      fetchedAt: new Date().toISOString(),
    };
  }
}
