/**
 * GitWhisper — Multi-PR Function Evolution Types
 * Models chronological and behavioral evolution of a function across multiple commits, PRs, and decisions.
 */

export type CommitEvolutionRole =
  | 'origin'
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'formatting'
  | 'current';

export interface EvolutionCommitItem {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body?: string;
  role: CommitEvolutionRole;
  isBehaviorChanging: boolean;
  pullRequest?: {
    number: number;
    title: string;
    url?: string;
    rationaleSummary?: string;
  };
  supersessionStatus?: 'current' | 'superseded' | 'reverted' | 'unknown';
  supersededBy?: string;
  diffSummary?: string;
  changedLinesSnippet?: string;
}

export interface FunctionEvolutionTimeline {
  filePath: string;
  targetLineRange: {
    startLine: number;
    endLine: number;
  };
  enclosingFunctionName?: string;
  originCommit?: EvolutionCommitItem;
  currentCommit?: EvolutionCommitItem;
  commits: EvolutionCommitItem[];
  behaviorChangingCommitsCount: number;
  totalCommitsCount: number;
  supersededDecisionsCount: number;
  summary: string;
}
