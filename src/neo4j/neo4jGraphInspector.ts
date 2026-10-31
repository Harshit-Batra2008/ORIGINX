import { Driver } from 'neo4j-driver';
import { redactSecret } from './neo4jEnv';
import {
  GlobalDatabaseMetrics,
  GraphInspectionSummary,
  RepositoryScopedMetrics
} from './neo4jGraphTypes';
import { INeo4jDriver, INeo4jSession } from './neo4jTypes';

/**
 * Queries Neo4j for high-level repository evidence statistics without invoking AI models.
 * Supports repository-scoped metrics alongside global database totals.
 * Uses parameterized Cypher and guarantees the read session is cleanly closed.
 */
export async function inspectGraphEvidence(
  driver: Driver | INeo4jDriver,
  repoId?: string
): Promise<GraphInspectionSummary> {
  const startTime = Date.now();
  const session: INeo4jSession = driver.session();

  try {
    const toNum = (val: any) => {
      if (val === null || val === undefined) return 0;
      if (typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
      if (typeof val === 'object' && val.low !== undefined) return Number(val.low);
      return Number(val) || 0;
    };

    const getRecordVal = (rec: any, key: string) => {
      const v = typeof rec.get === 'function' ? rec.get(key) : rec[key];
      return toNum(v);
    };

    const getRecordStr = (rec: any, key: string) => {
      const v = typeof rec.get === 'function' ? rec.get(key) : rec[key];
      return v ? String(v) : '';
    };

    // 1. Global counts across all repositories in Neo4j
    const globalCountQuery = `
      MATCH (r:Repository) WITH count(r) AS repoCount
      MATCH (c:Commit) WITH repoCount, count(c) AS commitCount
      MATCH (f:File) WITH repoCount, commitCount, count(f) AS fileCount
      MATCH (p:Person) WITH repoCount, commitCount, fileCount, count(p) AS personCount
      OPTIONAL MATCH ()-[m:MODIFIED]->()
      RETURN
        repoCount,
        commitCount,
        fileCount,
        personCount,
        count(m) AS modCount
    `;

    let globalRepos = 0;
    let globalCommits = 0;
    let globalFiles = 0;
    let globalPersons = 0;
    let globalModifications = 0;

    try {
      const countRes = await session.run(globalCountQuery);
      if (countRes.records && countRes.records.length > 0) {
        const rec = countRes.records[0];
        globalRepos = getRecordVal(rec, 'repoCount');
        globalCommits = getRecordVal(rec, 'commitCount');
        globalFiles = getRecordVal(rec, 'fileCount');
        globalPersons = getRecordVal(rec, 'personCount');
        globalModifications = getRecordVal(rec, 'modCount');
      }
    } catch {
      // Graph might be empty
    }

    const globalDatabase: GlobalDatabaseMetrics = {
      totalRepositories: globalRepos,
      totalCommits: globalCommits,
      totalFiles: globalFiles,
      totalPersons: globalPersons,
      totalModifications: globalModifications
    };

    let repositoryScoped: RepositoryScopedMetrics | undefined = undefined;

    // 2. Repository-scoped queries (parameterized) if repoId provided
    if (repoId) {
      try {
        const repoCountQuery = `
          MATCH (r:Repository { id: $repoId })
          OPTIONAL MATCH (r)-[:HAS_COMMIT]->(c:Commit)
          WITH r, count(DISTINCT c) AS commitCount
          OPTIONAL MATCH (r)-[:CONTAINS]->(f:File)
          WITH r, commitCount, count(DISTINCT f) AS fileCount
          OPTIONAL MATCH (r)-[:HAS_COMMIT]->(c2:Commit)<-[:AUTHORED]-(p:Person)
          WITH r, commitCount, fileCount, count(DISTINCT p) AS personCount
          OPTIONAL MATCH (r)-[:HAS_COMMIT]->(:Commit)-[m:MODIFIED]->(:File)
          RETURN
            r.id AS repoId,
            r.name AS repoName,
            commitCount,
            fileCount,
            personCount,
            count(m) AS modCount
        `;

        const repoRes = await session.run(repoCountQuery, { repoId });
        if (repoRes.records && repoRes.records.length > 0) {
          const rec = repoRes.records[0];
          const scopedRepoId = getRecordStr(rec, 'repoId');
          if (scopedRepoId) {
            const scopedRepoName = getRecordStr(rec, 'repoName') || repoId;
            const scopedCommitCount = getRecordVal(rec, 'commitCount');
            const scopedFileCount = getRecordVal(rec, 'fileCount');
            const scopedPersonCount = getRecordVal(rec, 'personCount');
            const scopedModCount = getRecordVal(rec, 'modCount');

            // Scoped top modified files
            const scopedTopFiles: Array<{ path: string; modificationCount: number }> = [];
            try {
              const scopedFilesQuery = `
                MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)-[m:MODIFIED]->(f:File)
                RETURN f.path AS path, count(c) AS count
                ORDER BY count DESC
                LIMIT 5
              `;
              const fRes = await session.run(scopedFilesQuery, { repoId });
              if (fRes.records) {
                for (const r of fRes.records) {
                  const p = getRecordStr(r, 'path');
                  const cnt = getRecordVal(r, 'count');
                  if (p) {
                    scopedTopFiles.push({ path: p, modificationCount: cnt });
                  }
                }
              }
            } catch {}

            // Scoped latest commits
            const scopedLatestCommits: Array<{ hash: string; subject: string; author: string; date: string }> = [];
            try {
              const scopedCommitsQuery = `
                MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)
                OPTIONAL MATCH (p:Person)-[:AUTHORED]->(c)
                RETURN
                  c.shortHash AS hash,
                  c.subject AS subject,
                  coalesce(p.name, 'Unknown') AS author,
                  c.committedAt AS date
                ORDER BY c.committedAt DESC
                LIMIT 5
              `;
              const cRes = await session.run(scopedCommitsQuery, { repoId });
              if (cRes.records) {
                for (const r of cRes.records) {
                  scopedLatestCommits.push({
                    hash: getRecordStr(r, 'hash'),
                    subject: getRecordStr(r, 'subject'),
                    author: getRecordStr(r, 'author'),
                    date: getRecordStr(r, 'date')
                  });
                }
              }
            } catch {}

            repositoryScoped = {
              repoId: scopedRepoId,
              repoName: scopedRepoName,
              commitCount: scopedCommitCount,
              fileCount: scopedFileCount,
              personCount: scopedPersonCount,
              modificationCount: scopedModCount,
              topModifiedFiles: scopedTopFiles,
              latestCommits: scopedLatestCommits
            };
          }
        }
      } catch {}
    }

    // 3. Fallback/global top modified files and latest commits (for flat backwards compatibility)
    const topFiles: Array<{ path: string; modificationCount: number }> =
      repositoryScoped ? repositoryScoped.topModifiedFiles : [];
    const latestCommits: Array<{ hash: string; subject: string; author: string; date: string }> =
      repositoryScoped ? repositoryScoped.latestCommits : [];

    if (!repositoryScoped) {
      try {
        const topFilesQuery = `
          MATCH (c:Commit)-[m:MODIFIED]->(f:File)
          RETURN f.path AS path, count(c) AS count
          ORDER BY count DESC
          LIMIT 5
        `;
        const filesRes = await session.run(topFilesQuery);
        if (filesRes.records) {
          for (const r of filesRes.records) {
            const p = getRecordStr(r, 'path');
            const cnt = getRecordVal(r, 'count');
            if (p) {
              topFiles.push({ path: p, modificationCount: cnt });
            }
          }
        }
      } catch {}

      try {
        const commitsQuery = `
          MATCH (p:Person)-[:AUTHORED]->(c:Commit)
          RETURN
            c.shortHash AS hash,
            c.subject AS subject,
            p.name AS author,
            c.committedAt AS date
          ORDER BY c.committedAt DESC
          LIMIT 5
        `;
        const commitsRes = await session.run(commitsQuery);
        if (commitsRes.records) {
          for (const r of commitsRes.records) {
            latestCommits.push({
              hash: getRecordStr(r, 'hash'),
              subject: getRecordStr(r, 'subject'),
              author: getRecordStr(r, 'author'),
              date: getRecordStr(r, 'date')
            });
          }
        }
      } catch {}
    }

    return {
      connected: true,
      durationMs: Date.now() - startTime,
      repositoryScoped,
      globalDatabase,
      repositoryCount: repositoryScoped ? 1 : globalRepos,
      commitCount: repositoryScoped ? repositoryScoped.commitCount : globalCommits,
      fileCount: repositoryScoped ? repositoryScoped.fileCount : globalFiles,
      personCount: repositoryScoped ? repositoryScoped.personCount : globalPersons,
      modificationCount: repositoryScoped ? repositoryScoped.modificationCount : globalModifications,
      latestCommits,
      topModifiedFiles: topFiles
    };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedError = redactSecret(rawMsg);

    return {
      connected: false,
      durationMs: Date.now() - startTime,
      globalDatabase: {
        totalRepositories: 0,
        totalCommits: 0,
        totalFiles: 0,
        totalPersons: 0,
        totalModifications: 0
      },
      repositoryCount: 0,
      commitCount: 0,
      fileCount: 0,
      personCount: 0,
      modificationCount: 0,
      latestCommits: [],
      topModifiedFiles: [],
      error: sanitizedError
    };
  } finally {
    await session.close();
  }
}
