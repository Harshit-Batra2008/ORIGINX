import { ICancellationTokenLike } from '../git/gitService';

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';

export interface GitGraphFileChange {
  path: string;
  name: string;
  changeType: FileChangeType;
  oldPath?: string;
  fileId: string; // Composite ID: `${repoId}:${path}`
}

export interface GitGraphCommit {
  id: string; // Composite ID: `${repoId}:${hash}`
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  personId: string; // Author identity (email or name)
  committedAt: string; // ISO 8601 date string
  subject: string;
  body: string;
  repoId: string;
  files: GitGraphFileChange[];
}

export interface GitGraphRepoInfo {
  id: string; // Normalized repository ID (e.g. 'owner/repo' or folder basename)
  name: string;
  rootPath: string;
  remoteUrl?: string;
}

export interface GraphImportOptions {
  maxCommits?: number;
  batchSize?: number;
  cancellationToken?: ICancellationTokenLike;
  excludedDirectories?: string[];
}

export type GraphImportStatus = 'ok' | 'cancelled' | 'error';

export interface GraphImportSummary {
  status: GraphImportStatus;
  repositoryId: string;
  repositoryName: string;
  commitsProcessed: number;
  filesProcessed: number;
  fileChangesProcessed: number;
  // Verified repository database counts queried directly from Neo4j after import:
  databaseCommitCount: number;
  databaseFileCount: number;
  databaseModificationCount: number;
  // Backwards-compatible aliases:
  commitsImported: number;
  filesImported: number;
  personsImported: number;
  relationshipsCreated: number;
  durationMs: number;
  error?: string;
}

export interface RepositoryScopedMetrics {
  repoId: string;
  repoName: string;
  commitCount: number;
  fileCount: number;
  personCount: number;
  modificationCount: number;
  topModifiedFiles: Array<{
    path: string;
    modificationCount: number;
  }>;
  latestCommits: Array<{
    hash: string;
    subject: string;
    author: string;
    date: string;
  }>;
}

export interface GlobalDatabaseMetrics {
  totalRepositories: number;
  totalCommits: number;
  totalFiles: number;
  totalPersons: number;
  totalModifications: number;
}

export interface GraphInspectionSummary {
  connected: boolean;
  durationMs: number;
  // Repository-specific metrics (when scoped to a repository):
  repositoryScoped?: RepositoryScopedMetrics;
  // Global database totals across all repositories in Neo4j AuraDB:
  globalDatabase: GlobalDatabaseMetrics;
  // Flat convenience aliases:
  repositoryCount: number;
  commitCount: number;
  fileCount: number;
  personCount: number;
  modificationCount: number;
  latestCommits: Array<{
    hash: string;
    subject: string;
    author: string;
    date: string;
  }>;
  topModifiedFiles: Array<{
    path: string;
    modificationCount: number;
  }>;
  error?: string;
}

export interface RepositoryPruneEstimate {
  repoId: string;
  repoName: string;
  commitsToDelete: number;
  filesToDelete: number;
}

export interface RepositoryPruneResult {
  status: 'ok' | 'cancelled' | 'error';
  repoId: string;
  repoName: string;
  deletedCommits: number;
  deletedFiles: number;
  durationMs: number;
  error?: string;
}

export interface Neo4jCommitEvidence {
  commitHash: string;
  shortHash: string;
  subject: string;
  body: string;
  committedAt: string;
  authorName: string;
  authorEmail: string;
  filePath: string;
  changeType: FileChangeType;
  oldPath?: string;
}

export interface Neo4jFileEvidenceResult {
  status: 'ok' | 'error';
  repositoryId: string;
  filePath: string;
  commits: Neo4jCommitEvidence[];
  durationMs: number;
  error?: string;
}
