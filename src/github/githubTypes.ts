/**
 * GitWhisper — GitHub Ingestion Data Types
 * Strongly typed representations of public GitHub Pull Requests, Issues,
 * Review Comments, Discussion Comments, and Rate Limits.
 */

import { ICancellationTokenLike } from '../git/gitService';

export interface GitHubUser {
  login: string;
  id?: number;
  avatarUrl?: string;
  htmlUrl?: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  commentType: 'issue' | 'pull_review' | 'commit';
  path?: string; // For review comments on specific lines/files
  line?: number;
  commitId?: string;
}

export interface GitHubPullRequestFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string;
}

export interface GitHubCommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  isMerged: boolean;
  mergedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  user: GitHubUser;
  mergeCommitSha?: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  reviewers: GitHubUser[];
  comments: GitHubComment[];
  commits: GitHubCommitSummary[];
  changedFiles: GitHubPullRequestFile[];
  referencedIssueNumbers: number[];
}

export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt?: string;
  updatedAt: string;
  htmlUrl: string;
  user: GitHubUser;
  labels: GitHubLabel[];
  isPullRequest: boolean;
  isIncident: boolean; // Flagged only when labels or titles explicitly indicate incident/outage
  incidentSeverity?: 'P0' | 'P1' | 'critical' | 'high' | 'unspecified';
  comments: GitHubComment[];
  referencedPrNumbers: number[];
  referencedCommitShas: string[];
}

export interface GitHubRateLimitInfo {
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
  resetDate: string;
  isExhausted: boolean;
}

export interface GitHubIngestionOptions {
  token?: string;
  maxPullRequests?: number;
  maxIssues?: number;
  state?: 'all' | 'open' | 'closed';
  cancellationToken?: ICancellationTokenLike;
  fetchComments?: boolean;
  fetchFiles?: boolean;
  fetchCommits?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface GitHubRepositoryEvidence {
  owner: string;
  repo: string;
  repositoryId: string; // "owner/repo"
  pullRequests: GitHubPullRequest[];
  issues: GitHubIssue[];
  rateLimit: GitHubRateLimitInfo;
  fetchedAt: string;
}
