import { listDecisions } from '../decisionMemory/decisionService';
import { GitExecOptions, runGit } from '../git/gitService';
import { boundedRelatedFileCount, getGitCoChanges, MAX_CONTEXT_TARGETS, MAX_RELATED_FILES, MAX_SHARED_COMMIT_SAMPLES } from '../git/coChanges';
import { isSourceTarget, normalizePath } from '../git/sourcePaths';
import { getConfiguredNeo4jCredentials } from '../neo4j/neo4jAuthHelper';
import { retrieveCoChangedFiles } from '../neo4j/neo4jEvidenceRetriever';
import { resolveRepositoryIdentity } from '../neo4j/neo4jGraphImporter';
import { createNeo4jDriver, getActiveDriver, openGraphSession } from '../neo4j/neo4jService';
import { INeo4jDriver, Neo4jConfig } from '../neo4j/neo4jTypes';
import type { SecretManager } from '../security/secretManager';
import { CheckpointRetrievalSource, ContextCheckpoint, ContextRetrievalResult, GraphFreshnessStatus, GraphRelatedFile } from './checkpointTypes';

export const BOUNDED_RELATED_FILES_LIMIT = MAX_RELATED_FILES;

export interface RetrieveContextOptions {
  limit?: number;
  gitOptions?: GitExecOptions;
  forceGitFallback?: boolean;
  driver?: INeo4jDriver | null;
  database?: string;
}

/** Look up the current checkout's exact Git object in the imported repository namespace. */
export async function checkGraphFreshness(
  repoId: string, currentHeadCommit: string, driver: INeo4jDriver | null = getActiveDriver(), database?: string
): Promise<GraphFreshnessStatus> {
  const base = { currentHead: currentHeadCommit.slice(0, 7), repositoryId: repoId || undefined };
  if (!driver || !repoId || !currentHeadCommit) {
    return { ...base, isAvailable: false, isFresh: false, limitationMessage: 'Graph evidence is unavailable for this checkout. Using local Git.' };
  }

  try {
    const session = openGraphSession(driver, database);
    try {
      const query = 'MATCH (r:Repository {id: $repoId})-[:HAS_COMMIT]->(c:Commit {id: $commitId}) ' +
        'WHERE c.repoId = $repoId AND c.hash = $head RETURN c.hash AS indexedHead LIMIT 1';
      const { records } = await session.run(query, { repoId, commitId: repoId + ':' + currentHeadCommit, head: currentHeadCommit });
      const record = records?.[0];
      const indexedHead = record && (typeof record.get === 'function' ? record.get('indexedHead') : record.indexedHead);
      const isFresh = indexedHead === currentHeadCommit;
      return {
        ...base, isAvailable: true, isFresh, indexedHead: isFresh ? currentHeadCommit : undefined,
        limitationMessage: isFresh ? undefined : 'The graph does not contain the current repository HEAD. Using local Git.'
      };
    } finally {
      await session.close();
    }
  } catch {
    return { ...base, isAvailable: false, isFresh: false, limitationMessage: 'The graph could not be read. Using local Git.' };
  }
}

export async function retrieveGitFallbackCoChanges(
  repoRoot: string, targetFilePaths: string[], limit = MAX_RELATED_FILES, options?: GitExecOptions
): Promise<GraphRelatedFile[]> {
  const matches = await getGitCoChanges(repoRoot, targetFilePaths, limit, options);
  return matches.map(match => ({
    filePath: match.filePath, relationshipType: 'historical_co_change', coChangeCount: match.sharedCommitCount,
    connectingCommits: match.commits,
    evidenceReason: 'Changed alongside target files in ' + match.sharedCommitCount + ' Git commit(s).'
  }));
}

/** Resolve configured credentials on use and close only the driver opened for this request. */
export function createCheckpointRetriever(
  secrets: Pick<SecretManager, 'getNeo4jPassword'>,
  createDriver: (config: Neo4jConfig) => INeo4jDriver = createNeo4jDriver
) {
  return async (repoRoot: string, checkpoint: ContextCheckpoint): Promise<ContextRetrievalResult> => {
    let driver: INeo4jDriver | null = null;
    let database: string | undefined;
    try {
      const config = await getConfiguredNeo4jCredentials(secrets);
      if (config) {
        driver = createDriver(config);
        database = config.database;
      }
    } catch {
      // A locked credential store or invalid connection configuration leaves Git available.
    }
    try {
      return await retrieveCheckpointContext(repoRoot, checkpoint, { driver, database });
    } finally {
      if (driver) await driver.close().catch(() => undefined);
    }
  };
}

export async function retrieveCheckpointContext(
  repoRoot: string, checkpoint: ContextCheckpoint, options: RetrieveContextOptions = {}
): Promise<ContextRetrievalResult> {
  const startTime = Date.now();
  const limit = boundedRelatedFileCount(options.limit);
  const limitations: string[] = [];
  const targets = [...new Set(checkpoint.targetFiles.map(t => normalizePath(t.filePath)).filter(p => isSourceTarget(p)))];
  const targetSet = new Set(targets);
  const queryTargets = targets.slice(0, MAX_CONTEXT_TARGETS);
  if (queryTargets.length < targets.length) limitations.push('Related history uses the first ' + MAX_CONTEXT_TARGETS + ' source targets.');

  const driver = options.forceGitFallback ? null : options.driver === undefined ? getActiveDriver() : options.driver;
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], repoRoot, options.gitOptions);
  const currentHead = head.exitCode === 0 ? head.stdout.trim() : '';
  const repoId = driver && queryTargets.length ? (await resolveRepositoryIdentity(repoRoot, options.gitOptions)).id : '';
  const freshness = await checkGraphFreshness(repoId, currentHead, driver, options.database);
  if (freshness.limitationMessage && queryTargets.length) limitations.push(freshness.limitationMessage);
  if (!checkpoint.repository.isCleanWorkingTree) limitations.push('The checkpoint was saved with uncommitted work. Graph history covers commits.');

  let retrievalSource: CheckpointRetrievalSource = 'none';
  let relatedFiles: GraphRelatedFile[] = [];
  if (driver && freshness.isFresh) {
    try {
      const result = await retrieveCoChangedFiles(driver, repoId, queryTargets, limit, {
        maxSharedCommitsPerFile: MAX_SHARED_COMMIT_SAMPLES, database: options.database
      });
      if (result.status === 'error') {
        limitations.push('The graph relationship query failed. Using local Git.');
      } else {
        relatedFiles = result.coChangedFiles.filter(f => !targetSet.has(f.filePath)).slice(0, limit).map(f => ({
          filePath: f.filePath, relationshipType: 'historical_co_change', coChangeCount: f.sharedCommitCount,
          connectingCommits: f.sharedCommits.slice(0, MAX_SHARED_COMMIT_SAMPLES).map(c => ({
            hash: c.hash, shortHash: c.shortHash, subject: c.subject ?? '', author: 'Unknown', date: c.committedAt || ''
          })),
          evidenceReason: 'Changed alongside target files in ' + f.sharedCommitCount + ' indexed commit(s).'
        }));
        if (relatedFiles.length) retrievalSource = 'neo4j_graph';
      }
    } catch {
      limitations.push('The graph relationship query failed. Using local Git.');
    }
  }
  if (!relatedFiles.length && queryTargets.length) {
    retrievalSource = 'git_fallback';
    relatedFiles = await retrieveGitFallbackCoChanges(repoRoot, targets, limit, options.gitOptions);
  }

  let linkedDecisions: ContextRetrievalResult['linkedDecisions'] = [];
  try {
    const relatedSet = new Set(relatedFiles.map(f => f.filePath));
    const explicitIds = new Set(checkpoint.decisionMemoryReferences.map(id => id.toLowerCase()));
    const decisions = await listDecisions(repoRoot);
    linkedDecisions = decisions.map(decision => {
      const files = [decision.primaryAnchor.filePath, ...decision.relatedFiles.map(f => f.filePath)].map(normalizePath);
      let rank = 0;
      if (explicitIds.has(decision.id.toLowerCase())) rank = 3;
      else if (files.some(f => targetSet.has(f))) rank = 2;
      else if (files.some(f => relatedSet.has(f))) rank = 1;
      return { decision, rank };
    }).filter(row => row.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, 5)
      .map(({ decision: { id, title, status, rationale } }) => ({ id, title, status, rationale }));
  } catch {
    limitations.push('Stored decisions could not be read for this repository.');
  }

  return {
    checkpoint, freshness, relatedFiles, linkedDecisions, limitations,
    diagnostics: {
      queryDurationMs: Date.now() - startTime, candidateCount: relatedFiles.length, retrievalSource,
      serializedContextSizeBytes: Buffer.byteLength(JSON.stringify({ checkpoint, relatedFiles, linkedDecisions }), 'utf8')
    }
  };
}
