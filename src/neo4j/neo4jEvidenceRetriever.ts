import * as path from 'path';
import { Driver } from 'neo4j-driver';
import { normalizePath } from './gitLogParser';
import { redactSecret } from './neo4jEnv';
import {
  FileChangeType,
  Neo4jCoChangeItem,
  Neo4jCoChangeOptions,
  Neo4jCoChangeResult,
  Neo4jCommitEvidence,
  Neo4jFileEvidenceResult,
  Neo4jSharedCommit
} from './neo4jGraphTypes';
import { INeo4jDriver, INeo4jSession } from './neo4jTypes';

export const DEFAULT_EVIDENCE_LIMIT = 25;
export const DEFAULT_CO_CHANGE_LIMIT = 10;
export const MAX_CO_CHANGE_LIMIT = 50;
export const DEFAULT_SHARED_COMMITS_LIMIT = 10;

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

/**
 * Retrieves other files that historically changed in the same Git commits as the target file
 * from the Neo4j evidence graph (Co-Change Analysis).
 *
 * Traversal Pattern:
 *   (:Repository)-[:HAS_COMMIT]->(:Commit)-[:MODIFIED]->(:File)
 *
 * Query Structure:
 *   MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)-[:MODIFIED]->(target:File)
 *   WHERE c.repoId = $repoId AND target.repoId = $repoId AND (target.path = $filePath OR target.id = $fileId)
 *   MATCH (c)-[:MODIFIED]->(coFile:File)
 *   WHERE coFile.repoId = $repoId AND coFile.path <> target.path
 *
 * Safeguards:
 * - Strictly read-only MATCH queries with parameterized Cypher (no injection or mutations).
 * - Repository-scoped across all traversed nodes to prevent cross-repository evidence contamination.
 * - Bounded results with deterministic ordering (sharedCommitCount DESC, coFile.path ASC).
 * - Guarantees session is cleanly closed on success, error, or cancellation.
 * - Redacts database passwords/credentials in error messages.
 */
export async function retrieveCoChangedFiles(
  driver: Driver | INeo4jDriver,
  repoId: string,
  filePath: string,
  limit: number = DEFAULT_CO_CHANGE_LIMIT,
  options?: Neo4jCoChangeOptions
): Promise<Neo4jCoChangeResult> {
  const startTime = Date.now();

  const trimmedRepoId = (repoId || '').trim();
  const trimmedFilePath = (filePath || '').trim();

  if (!trimmedRepoId || !trimmedFilePath) {
    return {
      status: 'error',
      repositoryId: trimmedRepoId,
      targetFilePath: trimmedFilePath,
      coChangedFiles: [],
      totalCoChangedFiles: 0,
      durationMs: Date.now() - startTime,
      error: 'Repository identity and file path are required.'
    };
  }

  const normalizedPath = normalizePath(trimmedFilePath);
  const compositeFileId = `${trimmedRepoId}:${normalizedPath}`;

  const parsedLimit = typeof limit === 'number' && !isNaN(limit) ? limit : Number(limit);
  const numericLimit = isNaN(parsedLimit) ? DEFAULT_CO_CHANGE_LIMIT : parsedLimit;
  const safeLimit = Math.max(1, Math.min(numericLimit, MAX_CO_CHANGE_LIMIT));

  const rawMaxCommits = options?.maxSharedCommitsPerFile;
  const parsedMaxCommits =
    typeof rawMaxCommits === 'number' && !isNaN(rawMaxCommits) ? rawMaxCommits : Number(rawMaxCommits);
  const numericMaxCommits = isNaN(parsedMaxCommits) ? DEFAULT_SHARED_COMMITS_LIMIT : parsedMaxCommits;
  const safeMaxSharedCommits = Math.max(1, Math.min(numericMaxCommits, 50));

  const session: INeo4jSession = driver.session();

  try {
    const coChangeQuery = `
      MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)-[:MODIFIED]->(target:File)
      WHERE c.repoId = $repoId
        AND target.repoId = $repoId
        AND (target.path = $filePath OR target.id = $fileId)
      MATCH (c)-[:MODIFIED]->(coFile:File)
      WHERE coFile.repoId = $repoId
        AND coFile.path <> target.path
      WITH DISTINCT coFile, c
      ORDER BY c.committedAt DESC
      WITH coFile,
           count(c) AS sharedCommitCount,
           collect({
             hash: coalesce(c.hash, ''),
             shortHash: coalesce(c.shortHash, substring(coalesce(c.hash, ''), 0, 7)),
             subject: coalesce(c.subject, ''),
             committedAt: coalesce(c.committedAt, '')
           })[0..toInteger($maxSharedCommits)] AS sharedCommits,
           collect(coalesce(c.shortHash, substring(coalesce(c.hash, ''), 0, 7)))[0..toInteger($maxSharedCommits)] AS commitHashes
      ORDER BY sharedCommitCount DESC, coFile.path ASC
      LIMIT toInteger($limit)
      RETURN
        coFile.path AS filePath,
        coFile.name AS fileName,
        sharedCommitCount,
        sharedCommits,
        commitHashes
    `;

    const res = await session.run(coChangeQuery, {
      repoId: trimmedRepoId,
      filePath: normalizedPath,
      fileId: compositeFileId,
      limit: safeLimit,
      maxSharedCommits: safeMaxSharedCommits
    });

    const coChangedFiles: Neo4jCoChangeItem[] = [];

    if (res.records && Array.isArray(res.records)) {
      const toNum = (val: any): number => {
        if (val === null || val === undefined) return 0;
        if (typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
        if (typeof val === 'object' && val.low !== undefined) return Number(val.low);
        return Number(val) || 0;
      };

      for (const rec of res.records) {
        const getStr = (key: string): string => {
          const val = typeof rec.get === 'function' ? rec.get(key) : rec[key];
          return val !== null && val !== undefined ? String(val) : '';
        };

        const filePathVal = getStr('filePath');
        if (!filePathVal) continue;

        let fileNameVal = getStr('fileName');
        if (!fileNameVal) {
          fileNameVal = path.basename(filePathVal);
        }

        const countVal = typeof rec.get === 'function' ? rec.get('sharedCommitCount') : rec['sharedCommitCount'];
        const parsedCount = toNum(countVal);

        const rawCommits = typeof rec.get === 'function' ? rec.get('sharedCommits') : rec['sharedCommits'];
        const rawHashes = typeof rec.get === 'function' ? rec.get('commitHashes') : rec['commitHashes'];

        const sharedCommits: Neo4jSharedCommit[] = [];
        const commitHashes: string[] = [];

        if (Array.isArray(rawCommits)) {
          for (const sc of rawCommits) {
            if (!sc) continue;
            const hash = String(sc.hash || '').trim();
            const shortHash = String(sc.shortHash || (hash ? hash.slice(0, 7) : '')).trim();
            const subject = String(sc.subject || '').trim();
            const committedAt = sc.committedAt ? String(sc.committedAt).trim() : undefined;

            if (hash || shortHash) {
              sharedCommits.push({
                hash,
                shortHash: shortHash || hash.slice(0, 7),
                subject: subject || 'No commit subject',
                committedAt
              });
              const chosen = shortHash || (hash ? hash.slice(0, 7) : '');
              if (chosen && !commitHashes.includes(chosen)) {
                commitHashes.push(chosen);
              }
            }
          }
        }

        if (Array.isArray(rawHashes)) {
          for (const h of rawHashes) {
            const str = String(h || '').trim();
            if (str && !commitHashes.includes(str)) {
              commitHashes.push(str);
            }
          }
        }

        if (commitHashes.length > 0 && sharedCommits.length === 0) {
          for (const h of commitHashes) {
            sharedCommits.push({
              hash: h,
              shortHash: h.slice(0, 7),
              subject: 'Shared commit'
            });
          }
        }

        const finalCount = Math.max(parsedCount, sharedCommits.length, commitHashes.length);

        coChangedFiles.push({
          filePath: filePathVal,
          fileName: fileNameVal,
          sharedCommitCount: finalCount,
          sharedCommits,
          commitHashes
        });
      }
    }

    return {
      status: 'ok',
      repositoryId: trimmedRepoId,
      targetFilePath: normalizedPath,
      coChangedFiles,
      totalCoChangedFiles: coChangedFiles.length,
      durationMs: Date.now() - startTime
    };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedError = redactSecret(rawMsg, process.env.NEO4J_PASSWORD);

    return {
      status: 'error',
      repositoryId: trimmedRepoId,
      targetFilePath: normalizedPath,
      coChangedFiles: [],
      totalCoChangedFiles: 0,
      durationMs: Date.now() - startTime,
      error: sanitizedError
    };
  } finally {
    await session.close();
  }
}
