import { Driver } from 'neo4j-driver';
import { normalizePath } from './gitLogParser';
import { redactSecret } from './neo4jEnv';
import {
  FileChangeType,
  Neo4jCommitEvidence,
  Neo4jFileEvidenceResult
} from './neo4jGraphTypes';
import { INeo4jDriver, INeo4jSession } from './neo4jTypes';

export const DEFAULT_EVIDENCE_LIMIT = 25;

/**
 * Retrieves historical commit evidence and code evolution for a specific file
 * from the Neo4j evidence graph.
 *
 * Strictly read-only: uses MATCH queries only without mutating database state.
 * Scoped strictly to the specified repository identity to prevent cross-repo leaks.
 * Parameterized Cypher guarantees injection safety.
 * Guarantees read session is cleanly closed on success, error, or cancellation.
 */
export async function retrieveFileEvidence(
  driver: Driver | INeo4jDriver,
  repoId: string,
  filePath: string,
  limit: number = DEFAULT_EVIDENCE_LIMIT
): Promise<Neo4jFileEvidenceResult> {
  const startTime = Date.now();

  const trimmedRepoId = (repoId || '').trim();
  const trimmedFilePath = (filePath || '').trim();

  if (!trimmedRepoId || !trimmedFilePath) {
    return {
      status: 'error',
      repositoryId: trimmedRepoId,
      filePath: trimmedFilePath,
      commits: [],
      durationMs: Date.now() - startTime,
      error: 'Repository identity and file path are required.'
    };
  }

  const normalizedPath = normalizePath(trimmedFilePath);
  const compositeFileId = `${trimmedRepoId}:${normalizedPath}`;
  const parsedLimit = typeof limit === 'number' && !isNaN(limit) ? limit : Number(limit);
  const numericLimit = isNaN(parsedLimit) ? DEFAULT_EVIDENCE_LIMIT : parsedLimit;
  const safeLimit = Math.max(1, Math.min(numericLimit, 100));

  const session: INeo4jSession = driver.session();

  try {
    const evidenceQuery = `
      MATCH (r:Repository { id: $repoId })
      MATCH (r)-[:CONTAINS]->(f:File)
      WHERE f.repoId = $repoId AND (f.path = $filePath OR f.id = $fileId)
      MATCH (r)-[:HAS_COMMIT]->(c:Commit)-[m:MODIFIED]->(f)
      WHERE c.repoId = $repoId
      OPTIONAL MATCH (p:Person)-[:AUTHORED]->(c)
      RETURN
        c.hash AS commitHash,
        c.shortHash AS shortHash,
        c.subject AS subject,
        c.body AS body,
        c.committedAt AS committedAt,
        coalesce(p.name, 'Unknown') AS authorName,
        coalesce(p.email, '') AS authorEmail,
        f.path AS filePath,
        m.changeType AS changeType,
        m.oldPath AS oldPath
      ORDER BY c.committedAt DESC
      LIMIT toInteger($limit)
    `;

    const res = await session.run(evidenceQuery, {
      repoId: trimmedRepoId,
      filePath: normalizedPath,
      fileId: compositeFileId,
      limit: safeLimit
    });

    const commits: Neo4jCommitEvidence[] = [];

    if (res.records && Array.isArray(res.records)) {
      for (const rec of res.records) {
        const getStr = (key: string): string => {
          const val = typeof rec.get === 'function' ? rec.get(key) : rec[key];
          return val !== null && val !== undefined ? String(val) : '';
        };

        const hash = getStr('commitHash');
        const shortHash = getStr('shortHash') || (hash ? hash.slice(0, 7) : '');
        const subject = getStr('subject') || 'No commit subject';
        const body = getStr('body');
        const committedAt = getStr('committedAt');
        const authorName = getStr('authorName') || 'Unknown';
        const authorEmail = getStr('authorEmail');
        const pathVal = getStr('filePath') || normalizedPath;
        const rawChange = getStr('changeType') || 'modified';
        const validChangeTypes: FileChangeType[] = [
          'added',
          'modified',
          'deleted',
          'renamed',
          'copied',
          'unknown'
        ];
        const changeType: FileChangeType = validChangeTypes.includes(
          rawChange as FileChangeType
        )
          ? (rawChange as FileChangeType)
          : 'modified';
        const rawOldPath = getStr('oldPath');
        const oldPath =
          rawOldPath && rawOldPath.trim().length > 0 ? rawOldPath.trim() : undefined;

        commits.push({
          commitHash: hash,
          shortHash,
          subject,
          body,
          committedAt,
          authorName,
          authorEmail,
          filePath: pathVal,
          changeType,
          oldPath
        });
      }
    }

    return {
      status: 'ok',
      repositoryId: trimmedRepoId,
      filePath: normalizedPath,
      commits,
      durationMs: Date.now() - startTime
    };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedError = redactSecret(rawMsg, process.env.NEO4J_PASSWORD);

    return {
      status: 'error',
      repositoryId: trimmedRepoId,
      filePath: normalizedPath,
      commits: [],
      durationMs: Date.now() - startTime,
      error: sanitizedError
    };
  } finally {
    await session.close();
  }
}
