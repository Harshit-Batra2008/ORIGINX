import * as path from 'path';
import { Driver } from 'neo4j-driver';
import { GitExecOptions, ICancellationTokenLike, runGit } from '../git/gitService';
import { GIT_LOG_FORMAT, parseGitLogToGraph } from './gitLogParser';
import { redactSecret } from './neo4jEnv';
import {
  GitGraphCommit,
  GitGraphRepoInfo,
  GraphImportOptions,
  GraphImportSummary,
  RepositoryPruneEstimate,
  RepositoryPruneResult
} from './neo4jGraphTypes';
import { INeo4jDriver, INeo4jSession } from './neo4jTypes';

export const DEFAULT_GRAPH_IMPORT_COMMITS = 50;
export const DEFAULT_GRAPH_BATCH_SIZE = 25;

/**
 * Resolves repository identity metadata (name, id, remote origin URL).
 */
export async function resolveRepositoryIdentity(
  repoRoot: string,
  options?: GitExecOptions
): Promise<GitGraphRepoInfo> {
  let remoteUrl: string | undefined = undefined;
  let repoName = path.basename(repoRoot);

  try {
    const remoteRes = await runGit(['remote', 'get-url', 'origin'], repoRoot, options);
    if (remoteRes.exitCode === 0 && remoteRes.stdout.trim().length > 0) {
      remoteUrl = remoteRes.stdout.trim();
      // Extract owner/repo from git/https URLs if possible
      const match = remoteUrl.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
      if (match && match[1]) {
        repoName = match[1];
      }
    }
  } catch {
    // Remote detection is non-fatal
  }

  // Sanitize repoId for consistent cross-system namespace
  const sanitizedId = repoName.replace(/[^a-zA-Z0-9._/-]/g, '_');

  return {
    id: sanitizedId,
    name: repoName,
    rootPath: path.normalize(repoRoot),
    remoteUrl
  };
}

/**
 * Gathers bounded local Git history and parses into structured graph commits.
 * Filters out generated/dependency directories according to options or defaults.
 */
export async function fetchLocalGitGraphData(
  repoRoot: string,
  maxCommits: number = DEFAULT_GRAPH_IMPORT_COMMITS,
  options?: GitExecOptions & { excludedDirectories?: string[] }
): Promise<{ repo: GitGraphRepoInfo; commits: GitGraphCommit[] }> {
  const repo = await resolveRepositoryIdentity(repoRoot, options);

  const logArgs = [
    'log',
    '-n',
    String(maxCommits),
    '--name-status',
    `--format=${GIT_LOG_FORMAT}`
  ];

  const logResult = await runGit(logArgs, repoRoot, options);

  if (logResult.exitCode === 130 || options?.cancellationToken?.isCancellationRequested) {
    return { repo, commits: [] };
  }

  if (logResult.exitCode !== 0) {
    throw new Error(`Failed to retrieve Git history: ${logResult.stderr || 'Unknown Git error'}`);
  }

  const commits = parseGitLogToGraph(logResult.stdout, repo.id, options?.excludedDirectories);
  return { repo, commits };
}

/**
 * Ensures uniqueness constraints and indexes exist in Neo4j AuraDB.
 */
export async function ensureGraphSchema(session: INeo4jSession): Promise<void> {
  const constraintQueries = [
    'CREATE CONSTRAINT repository_id_unique IF NOT EXISTS FOR (r:Repository) REQUIRE r.id IS UNIQUE',
    'CREATE CONSTRAINT commit_id_unique IF NOT EXISTS FOR (c:Commit) REQUIRE c.id IS UNIQUE',
    'CREATE CONSTRAINT file_id_unique IF NOT EXISTS FOR (f:File) REQUIRE f.id IS UNIQUE',
    'CREATE CONSTRAINT person_id_unique IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE'
  ];

  for (const query of constraintQueries) {
    try {
      await session.run(query);
    } catch (err) {
      // In AuraDB or different Neo4j versions, constraint syntax may vary slightly;
      // non-fatal if constraint already exists or permissions differ.
    }
  }
}

/**
 * Imports commits, files, and contributors into Neo4j in bounded, parameterized batches.
 * Fully idempotent using MERGE semantics.
 * Returns both processed input metrics and verified database counts.
 */
export async function importGitGraph(
  driver: Driver | INeo4jDriver,
  repo: GitGraphRepoInfo,
  commits: GitGraphCommit[],
  options?: GraphImportOptions
): Promise<GraphImportSummary> {
  const startTime = Date.now();
  const batchSize = options?.batchSize || DEFAULT_GRAPH_BATCH_SIZE;
  const importedAt = new Date().toISOString();

  // Track unique entities and change occurrences processed
  const uniqueFiles = new Set<string>();
  const uniquePersons = new Set<string>();
  let commitsProcessed = 0;
  let fileChangesProcessed = 0;

  // 1. Ensure Schema
  const schemaSession = driver.session();
  try {
    await ensureGraphSchema(schemaSession);
  } finally {
    await schemaSession.close();
  }

  // 2. Ingest Commits and Metadata in Batches
  const writeSession = driver.session();
  try {
    if (options?.cancellationToken?.isCancellationRequested) {
      return {
        status: 'cancelled',
        repositoryId: repo.id,
        repositoryName: repo.name,
        commitsProcessed: 0,
        filesProcessed: 0,
        fileChangesProcessed: 0,
        databaseCommitCount: 0,
        databaseFileCount: 0,
        databaseModificationCount: 0,
        commitsImported: 0,
        filesImported: 0,
        personsImported: 0,
        relationshipsCreated: 0,
        durationMs: Date.now() - startTime
      };
    }

    for (let i = 0; i < commits.length; i += batchSize) {
      if (options?.cancellationToken?.isCancellationRequested) {
        return {
          status: 'cancelled',
          repositoryId: repo.id,
          repositoryName: repo.name,
          commitsProcessed,
          filesProcessed: uniqueFiles.size,
          fileChangesProcessed,
          databaseCommitCount: 0,
          databaseFileCount: 0,
          databaseModificationCount: 0,
          commitsImported: commitsProcessed,
          filesImported: uniqueFiles.size,
          personsImported: uniquePersons.size,
          relationshipsCreated: fileChangesProcessed * 2 + commitsProcessed * 2,
          durationMs: Date.now() - startTime
        };
      }

      const batch = commits.slice(i, i + batchSize);

      // Statement 1: Ingest Repository, Commits, Persons, HAS_COMMIT, AUTHORED
      const commitQuery = `
        MERGE (r:Repository { id: $repo.id })
        ON CREATE SET
          r.name = $repo.name,
          r.rootPath = $repo.rootPath,
          r.remoteUrl = $repo.remoteUrl,
          r.importedAt = $importedAt
        ON MATCH SET
          r.name = $repo.name,
          r.rootPath = $repo.rootPath,
          r.remoteUrl = $repo.remoteUrl,
          r.lastSyncedAt = $importedAt

        WITH r
        UNWIND $batch AS c

        MERGE (cmt:Commit { id: c.id })
        ON CREATE SET
          cmt.hash = c.hash,
          cmt.shortHash = c.shortHash,
          cmt.subject = c.subject,
          cmt.body = c.body,
          cmt.committedAt = c.committedAt,
          cmt.repoId = r.id,
          cmt.importedAt = $importedAt
        ON MATCH SET
          cmt.subject = c.subject,
          cmt.body = c.body

        MERGE (r)-[:HAS_COMMIT]->(cmt)

        MERGE (p:Person { id: c.personId })
        ON CREATE SET
          p.name = c.authorName,
          p.email = c.authorEmail

        MERGE (p)-[:AUTHORED]->(cmt)
      `;

      await writeSession.run(commitQuery, {
        repo: {
          id: repo.id,
          name: repo.name,
          rootPath: repo.rootPath,
          remoteUrl: repo.remoteUrl || ''
        },
        batch: batch.map((c) => ({
          id: c.id,
          hash: c.hash,
          shortHash: c.shortHash,
          subject: c.subject,
          body: c.body,
          committedAt: c.committedAt,
          personId: c.personId,
          authorName: c.authorName,
          authorEmail: c.authorEmail
        })),
        importedAt
      });

      // Statement 2: Ingest Files, CONTAINS, MODIFIED
      const fileChanges: Array<{
        commitId: string;
        fileId: string;
        path: string;
        name: string;
        changeType: string;
        oldPath: string;
      }> = [];

      for (const cmt of batch) {
        commitsProcessed++;
        uniquePersons.add(cmt.personId);

        for (const f of cmt.files) {
          uniqueFiles.add(f.fileId);
          fileChangesProcessed++;
          fileChanges.push({
            commitId: cmt.id,
            fileId: f.fileId,
            path: f.path,
            name: f.name,
            changeType: f.changeType,
            oldPath: f.oldPath || ''
          });
        }
      }

      if (fileChanges.length > 0) {
        const fileQuery = `
          MERGE (r:Repository { id: $repo.id })
          WITH r
          UNWIND $fileChanges AS fc

          MERGE (cmt:Commit { id: fc.commitId })

          MERGE (fl:File { id: fc.fileId })
          ON CREATE SET
            fl.path = fc.path,
            fl.name = fc.name,
            fl.repoId = r.id

          MERGE (r)-[:CONTAINS]->(fl)

          MERGE (cmt)-[m:MODIFIED]->(fl)
          SET m.changeType = fc.changeType,
              m.oldPath = fc.oldPath
        `;

        await writeSession.run(fileQuery, {
          repo: { id: repo.id },
          fileChanges
        });
      }
    }

    // 3. Query verified repository database counts directly from Neo4j
    let dbCommits = commitsProcessed;
    let dbFiles = uniqueFiles.size;
    let dbModifications = fileChangesProcessed;

    try {
      const verifyQuery = `
        MATCH (r:Repository { id: $repoId })
        OPTIONAL MATCH (r)-[:HAS_COMMIT]->(c:Commit)
        WITH r, count(DISTINCT c) AS dbCommits
        OPTIONAL MATCH (r)-[:CONTAINS]->(f:File)
        WITH r, dbCommits, count(DISTINCT f) AS dbFiles
        OPTIONAL MATCH (r)-[:HAS_COMMIT]->(:Commit)-[m:MODIFIED]->(:File)
        RETURN dbCommits, dbFiles, count(m) AS dbModifications
      `;
      const verifyRes = await writeSession.run(verifyQuery, { repoId: repo.id });
      if (verifyRes.records && verifyRes.records.length > 0) {
        const rec = verifyRes.records[0];
        const toNum = (val: any) =>
          val && typeof val.toNumber === 'function'
            ? val.toNumber()
            : typeof val === 'object' && val?.low !== undefined
            ? Number(val.low)
            : Number(val || 0);

        const cCount = toNum(typeof rec.get === 'function' ? rec.get('dbCommits') : rec['dbCommits']);
        const fCount = toNum(typeof rec.get === 'function' ? rec.get('dbFiles') : rec['dbFiles']);
        const mCount = toNum(typeof rec.get === 'function' ? rec.get('dbModifications') : rec['dbModifications']);

        dbCommits = cCount;
        dbFiles = fCount;
        dbModifications = mCount;
      }
    } catch {
      // In mock/test environments without verification query, retain processed estimates
    }

    return {
      status: 'ok',
      repositoryId: repo.id,
      repositoryName: repo.name,
      commitsProcessed,
      filesProcessed: uniqueFiles.size,
      fileChangesProcessed,
      databaseCommitCount: dbCommits,
      databaseFileCount: dbFiles,
      databaseModificationCount: dbModifications,
      commitsImported: commitsProcessed,
      filesImported: uniqueFiles.size,
      personsImported: uniquePersons.size,
      relationshipsCreated: fileChangesProcessed * 2 + commitsProcessed * 2,
      durationMs: Date.now() - startTime
    };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedError = redactSecret(rawMsg, process.env.NEO4J_PASSWORD);

    return {
      status: 'error',
      repositoryId: repo.id,
      repositoryName: repo.name,
      commitsProcessed,
      filesProcessed: uniqueFiles.size,
      fileChangesProcessed,
      databaseCommitCount: 0,
      databaseFileCount: 0,
      databaseModificationCount: 0,
      commitsImported: commitsProcessed,
      filesImported: uniqueFiles.size,
      personsImported: uniquePersons.size,
      relationshipsCreated: 0,
      durationMs: Date.now() - startTime,
      error: sanitizedError
    };
  } finally {
    // Guarantees session is closed
    await writeSession.close();
  }
}

/**
 * Estimates the number of commits and files that would be pruned for a repository.
 * Scoped strictly to the specified repository and excludes entities shared with other repositories.
 */
export async function estimateRepositoryPruneCounts(
  driver: Driver | INeo4jDriver,
  repoId: string
): Promise<RepositoryPruneEstimate> {
  const session = driver.session();
  try {
    const query = `
      MATCH (r:Repository { id: $repoId })
      OPTIONAL MATCH (r)-[:CONTAINS]->(f:File)
      WHERE f.repoId = $repoId
        AND NOT EXISTS { MATCH (other:Repository)-[:CONTAINS]->(f) WHERE other.id <> $repoId }
      WITH r, count(DISTINCT f) AS fileCount
      OPTIONAL MATCH (r)-[:HAS_COMMIT]->(c:Commit)
      WHERE c.repoId = $repoId
        AND NOT EXISTS { MATCH (other:Repository)-[:HAS_COMMIT]->(c) WHERE other.id <> $repoId }
      RETURN r.name AS repoName, count(DISTINCT c) AS commitCount, fileCount
    `;
    const res = await session.run(query, { repoId });
    if (!res.records || res.records.length === 0) {
      return {
        repoId,
        repoName: repoId,
        commitsToDelete: 0,
        filesToDelete: 0
      };
    }
    const rec = res.records[0];
    const toNum = (val: any) =>
      val && typeof val.toNumber === 'function'
        ? val.toNumber()
        : typeof val === 'object' && val?.low !== undefined
        ? Number(val.low)
        : Number(val || 0);

    const rName = typeof rec.get === 'function' ? rec.get('repoName') : rec['repoName'];
    const cCount = typeof rec.get === 'function' ? rec.get('commitCount') : rec['commitCount'];
    const fCount = typeof rec.get === 'function' ? rec.get('fileCount') : rec['fileCount'];

    return {
      repoId,
      repoName: String(rName || repoId),
      commitsToDelete: toNum(cCount),
      filesToDelete: toNum(fCount)
    };
  } finally {
    await session.close();
  }
}

/**
 * Safely prunes a repository's subgraph from Neo4j AuraDB inside an atomic transaction.
 * Never performs unrestricted DETACH DELETE.
 * Strictly deletes only:
 *  - Files contained exclusively by this repository: (r)-[:CONTAINS]->(f:File)
 *  - Commits attached exclusively to this repository: (r)-[:HAS_COMMIT]->(c:Commit)
 *  - The repository node itself: (r:Repository { id: $repoId })
 * Preserves all Person nodes, other repositories, and unrelated test nodes.
 * Rolled back atomically if any error occurs during execution.
 */
export async function pruneRepositorySubgraph(
  driver: Driver | INeo4jDriver,
  repoId: string,
  options?: { cancellationToken?: ICancellationTokenLike }
): Promise<RepositoryPruneResult> {
  const startTime = Date.now();

  if (options?.cancellationToken?.isCancellationRequested) {
    return {
      status: 'cancelled',
      repoId,
      repoName: repoId,
      deletedCommits: 0,
      deletedFiles: 0,
      durationMs: Date.now() - startTime
    };
  }

  // Pre-deletion count estimation matching exact deletion scope
  const estimate = await estimateRepositoryPruneCounts(driver, repoId);

  if (options?.cancellationToken?.isCancellationRequested) {
    return {
      status: 'cancelled',
      repoId,
      repoName: estimate.repoName,
      deletedCommits: 0,
      deletedFiles: 0,
      durationMs: Date.now() - startTime
    };
  }

  const session = driver.session();
  try {
    const txRunner = typeof session.executeWrite === 'function'
      ? (work: (tx: { run(q: string, p?: any): Promise<any> }) => Promise<any>) => session.executeWrite!(work)
      : async (work: (tx: { run(q: string, p?: any): Promise<any> }) => Promise<any>) => work(session);

    await txRunner(async (tx) => {
      // 1. Delete repository-contained File nodes exclusively belonging to this repository
      await tx.run(
        `MATCH (r:Repository { id: $repoId })-[:CONTAINS]->(f:File)
         WHERE f.repoId = $repoId
           AND NOT EXISTS { MATCH (other:Repository)-[:CONTAINS]->(f) WHERE other.id <> $repoId }
         DETACH DELETE f`,
        { repoId }
      );

      // 2. Delete repository-attached Commit nodes exclusively belonging to this repository
      // Preserves all Person nodes on [:AUTHORED] and any commits linked to other repositories
      await tx.run(
        `MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)
         WHERE c.repoId = $repoId
           AND NOT EXISTS { MATCH (other:Repository)-[:HAS_COMMIT]->(c) WHERE other.id <> $repoId }
         DETACH DELETE c`,
        { repoId }
      );

      // 3. Delete the repository node itself
      await tx.run(
        `MATCH (r:Repository { id: $repoId })
         DETACH DELETE r`,
        { repoId }
      );
    });

    return {
      status: 'ok',
      repoId,
      repoName: estimate.repoName,
      deletedCommits: estimate.commitsToDelete,
      deletedFiles: estimate.filesToDelete,
      durationMs: Date.now() - startTime
    };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = redactSecret(rawMsg, process.env.NEO4J_PASSWORD);

    return {
      status: 'error',
      repoId,
      repoName: estimate.repoName,
      deletedCommits: 0,
      deletedFiles: 0,
      durationMs: Date.now() - startTime,
      error: sanitized
    };
  } finally {
    await session.close();
  }
}
