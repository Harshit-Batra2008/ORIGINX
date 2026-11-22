/**
 * GitWhisper — Historical Evidence Graph Importer
 * Provides dry-run planning and idempotent parameterized Neo4j graph imports
 * linking Pull Requests, Issues, Comments, Design Docs, and Decisions to Git Commits & Files.
 */

import * as path from 'path';
import { GitHubIssue, GitHubPullRequest } from '../github/githubTypes';
import { DecisionMemoryRecord } from '../decisionMemory/decisionTypes';
import {
  EvidenceGraphDryRunPlan,
  EvidenceImportResult,
  GraphDecisionNode,
  GraphDesignDocumentNode,
} from './evidenceGraphTypes';

export interface EvidenceImportInput {
  repoId: string;
  pullRequests?: GitHubPullRequest[];
  issues?: GitHubIssue[];
  designDocs?: GraphDesignDocumentNode[];
  decisions?: Array<GraphDecisionNode | DecisionMemoryRecord>;
}

export interface EvidenceImportOptions {
  dryRun?: boolean;
  batchSize?: number;
  database?: string;
}

export interface Neo4jSessionLike {
  run(query: string, parameters?: Record<string, any>): Promise<any>;
  close(): Promise<void>;
}

export interface Neo4jDriverLike {
  session(options?: { database?: string }): Neo4jSessionLike;
}

/**
 * Normalizes input decisions or extracts conservative decisions from PRs and ADRs.
 */
function resolveDecisions(
  repoId: string,
  inputDecisions: Array<GraphDecisionNode | DecisionMemoryRecord> | undefined,
  prs: GitHubPullRequest[],
  docs: GraphDesignDocumentNode[]
): GraphDecisionNode[] {
  const result: GraphDecisionNode[] = [];

  // 1. If decisions were explicitly passed, normalize them
  if (inputDecisions && inputDecisions.length > 0) {
    for (const d of inputDecisions) {
      if ('schemaVersion' in d) {
        // DecisionMemoryRecord
        result.push({
          id: `${repoId}:decision:${d.id}`,
          repoId,
          decisionId: d.id,
          title: d.title,
          rationale: d.rationale,
          sourceType: 'decision_record',
          sourceReference: d.primaryAnchor.filePath,
          targetFile: d.primaryAnchor.filePath,
          author: d.createdBy?.name || 'unknown',
          recordedAt: d.createdAt,
          status: d.status === 'retired' ? 'explicitly_superseded' : 'current',
          evidenceClassification: d.hasDirectGitEvidence ? 'directly_supported' : 'partially_supported',
          supportingCommitSha: d.evidence?.[0]?.commitHash,
        });
      } else {
        result.push(d as GraphDecisionNode);
      }
    }
    return result;
  }

  // 2. Conservative Extraction from PRs with explicit rationale
  for (const pr of prs) {
    const rawRationale = (pr.body || '').trim();
    const isMeaningful =
      rawRationale.length >= 30 &&
      !rawRationale.toLowerCase().startsWith('merge branch') &&
      !rawRationale.toLowerCase().startsWith('wip');

    if (isMeaningful) {
      let cleanTitle = pr.title.replace(/\(#\d+\)/g, '').trim();
      if (cleanTitle.includes(':')) {
        cleanTitle = cleanTitle.split(':').slice(1).join(':').trim();
      }
      cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);

      result.push({
        id: `${repoId}:decision:pr-${pr.number}`,
        repoId,
        decisionId: `DEC-PR-${pr.number}`,
        title: cleanTitle || `Decision from PR #${pr.number}`,
        rationale: rawRationale,
        sourceType: 'pull_request_rationale',
        sourceReference: pr.htmlUrl,
        targetFile: pr.changedFiles[0]?.filename || '',
        author: pr.user.login,
        recordedAt: pr.mergedAt || pr.createdAt,
        status: 'current',
        evidenceClassification: 'directly_supported',
        supportingCommitSha: pr.mergeCommitSha || pr.headSha,
        linkedPrNumber: pr.number,
      });
    }
  }

  // 3. Conservative Extraction from ADR Design Documents
  for (const doc of docs) {
    if (!doc.hasDecisionStructure) {
      continue;
    }

    const decisionSec = doc.sections.find(
      s => s.heading.toLowerCase().includes('decision') || s.heading.toLowerCase().includes('rationale')
    );

    if (decisionSec && decisionSec.contentSnippet.trim().length >= 30) {
      result.push({
        id: `${repoId}:decision:doc-${doc.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        repoId,
        decisionId: `DEC-DOC-${path.basename(doc.path, '.md').toUpperCase()}`,
        title: `${doc.title} — ${decisionSec.heading}`,
        rationale: decisionSec.contentSnippet.trim(),
        sourceType: 'adr_document',
        sourceReference: doc.path,
        targetFile: doc.referencedFiles[0] || '',
        author: 'Repository Architect',
        recordedAt: doc.lastModified,
        status: 'current',
        evidenceClassification: 'directly_supported',
      });
    }
  }

  return result;
}

/**
 * Generates a non-destructive dry-run plan of all nodes, relationships,
 * and parameterized Cypher queries without connecting or writing to Neo4j.
 */
export function planEvidenceGraphDryRun(input: EvidenceImportInput): EvidenceGraphDryRunPlan {
  const repoId = input.repoId;
  const prs = input.pullRequests ?? [];
  const issues = input.issues ?? [];
  const docs = input.designDocs ?? [];
  const decisions = resolveDecisions(repoId, input.decisions, prs, docs);

  let totalComments = 0;
  let commitToPrCount = 0;
  let prToFileCount = 0;
  let prToIssueCount = 0;
  let prToCommentCount = 0;
  let issueToCommentCount = 0;
  let docToFileCount = 0;
  let docToIssueCount = 0;
  let decisionToPrCount = 0;
  let decisionToDocCount = 0;
  let decisionToFileCount = 0;
  let decisionToCommitCount = 0;

  const issueNumbers = new Set(issues.map(i => i.number));

  for (const pr of prs) {
    totalComments += pr.comments.length;
    prToCommentCount += pr.comments.length;
    prToFileCount += pr.changedFiles.length;

    if (pr.mergeCommitSha) {
      commitToPrCount++;
    }
    commitToPrCount += pr.commits.length;

    for (const refIssue of pr.referencedIssueNumbers) {
      if (issueNumbers.has(refIssue)) {
        prToIssueCount++;
      }
    }
  }

  for (const issue of issues) {
    totalComments += issue.comments.length;
    issueToCommentCount += issue.comments.length;
  }

  for (const doc of docs) {
    docToFileCount += doc.referencedFiles.length;
    for (const refIssue of doc.referencedIssueNumbers) {
      if (issueNumbers.has(refIssue)) {
        docToIssueCount++;
      }
    }
  }

  for (const d of decisions) {
    if (d.linkedPrNumber) {
      decisionToPrCount++;
    }
    if (d.targetFile) {
      decisionToFileCount++;
    }
    if (d.supportingCommitSha) {
      decisionToCommitCount++;
    }
    if (d.sourceType === 'adr_document') {
      decisionToDocCount++;
    }
  }

  const totalNodes = prs.length + issues.length + totalComments + docs.length + decisions.length;
  const totalRelationships =
    commitToPrCount +
    prToFileCount +
    prToIssueCount +
    prToCommentCount +
    issueToCommentCount +
    docToFileCount +
    docToIssueCount +
    decisionToPrCount +
    decisionToDocCount +
    decisionToFileCount +
    decisionToCommitCount;

  const sampleQueries = [
    `// 1. Merge Pull Request Node
UNWIND $prs AS pr
MERGE (n:PullRequest {id: pr.id})
SET n.repoId = $repoId,
    n.number = pr.number,
    n.title = pr.title,
    n.body = pr.body,
    n.author = pr.author,
    n.state = pr.state,
    n.isMerged = pr.isMerged,
    n.mergedAt = pr.mergedAt,
    n.headSha = pr.headSha,
    n.url = pr.url;`,

    `// 2. Connect Pull Request to Modified File
UNWIND $prFiles AS rel
MATCH (pr:PullRequest {id: rel.prId})
MERGE (f:File {id: rel.fileId})
MERGE (pr)-[:MODIFIED_FILE {changeType: rel.changeType}]->(f);`,

    `// 3. Merge Decision Node
UNWIND $decisions AS dec
MERGE (d:Decision {id: dec.id})
SET d.repoId = $repoId,
    d.decisionId = dec.decisionId,
    d.title = dec.title,
    d.rationale = dec.rationale,
    d.sourceType = dec.sourceType,
    d.sourceReference = dec.sourceReference,
    d.targetFile = dec.targetFile,
    d.author = dec.author,
    d.recordedAt = dec.recordedAt,
    d.status = dec.status,
    d.evidenceClassification = dec.evidenceClassification;`,

    `// 4. Connect Decision to Justifying Pull Request
UNWIND $decisionPrs AS rel
MATCH (d:Decision {id: rel.decisionId})
MATCH (pr:PullRequest {id: rel.prId})
MERGE (d)-[:JUSTIFIED_BY_PR]->(pr);`,

    `// 5. Connect Decision to Anchored File
UNWIND $decisionFiles AS rel
MATCH (d:Decision {id: rel.decisionId})
MATCH (f:File {id: rel.fileId})
MERGE (d)-[:ANCHORED_TO_FILE]->(f);`,
  ];

  const estimatedPayloadBytes =
    JSON.stringify(prs).length +
    JSON.stringify(issues).length +
    JSON.stringify(docs).length +
    JSON.stringify(decisions).length;

  const warnings: string[] = [];
  if (prs.length === 0) {
    warnings.push('No pull requests provided in evidence input.');
  }
  if (issues.length === 0) {
    warnings.push('No issues provided in evidence input.');
  }
  if (docs.length === 0) {
    warnings.push('No design documents or ADRs discovered in local repository.');
  }
  if (decisions.length === 0) {
    warnings.push('No engineering decisions could be conservatively extracted from provided evidence.');
  }

  return {
    repositoryId: repoId,
    dryRun: true,
    nodesToCreateOrMerge: {
      pullRequests: prs.length,
      issues: issues.length,
      comments: totalComments,
      designDocs: docs.length,
      decisions: decisions.length,
      totalNodes,
    },
    relationshipsToCreate: {
      commitToPr: commitToPrCount,
      prToFile: prToFileCount,
      prToIssue: prToIssueCount,
      prToComment: prToCommentCount,
      issueToComment: issueToCommentCount,
      docToFile: docToFileCount,
      docToIssue: docToIssueCount,
      decisionToPr: decisionToPrCount,
      decisionToDoc: decisionToDocCount,
      decisionToFile: decisionToFileCount,
      decisionToCommit: decisionToCommitCount,
      totalRelationships,
    },
    sampleQueries,
    estimatedPayloadBytes,
    warnings,
    preparedAt: new Date().toISOString(),
  };
}

/**
 * Imports historical evidence into Neo4j using idempotent parameterized MERGE queries.
 * Defaults to dry-run mode unless options.dryRun is explicitly false and a driver is provided.
 */
export async function importEvidenceGraph(
  driver: Neo4jDriverLike | null | undefined,
  input: EvidenceImportInput,
  options?: EvidenceImportOptions
): Promise<EvidenceImportResult> {
  const startTime = Date.now();
  const dryRunPlan = planEvidenceGraphDryRun(input);

  // If dry-run requested or driver unavailable, return dry-run immediately
  if (options?.dryRun !== false || !driver) {
    return {
      status: 'dry_run',
      repositoryId: input.repoId,
      nodesImported: 0,
      relationshipsImported: 0,
      durationMs: Date.now() - startTime,
      dryRunPlan,
    };
  }

  const session = driver.session(options?.database ? { database: options.database } : undefined);
  try {
    const repoId = input.repoId;
    const prs = input.pullRequests ?? [];
    const issues = input.issues ?? [];
    const docs = input.designDocs ?? [];
    const decisions = resolveDecisions(repoId, input.decisions, prs, docs);

    let nodesImported = 0;
    let relationshipsImported = 0;

    // 1. Ingest Pull Requests in batches
    if (prs.length > 0) {
      const prRows = prs.map(pr => ({
        id: `${repoId}:pr-${pr.number}`,
        number: pr.number,
        title: pr.title,
        body: pr.body.substring(0, 2000),
        author: pr.user.login,
        state: pr.state,
        isMerged: pr.isMerged,
        mergedAt: pr.mergedAt || null,
        headSha: pr.headSha,
        url: pr.htmlUrl,
      }));

      await session.run(
        `UNWIND $batch AS pr
         MERGE (n:PullRequest {id: pr.id})
         SET n.repoId = $repoId,
             n.number = pr.number,
             n.title = pr.title,
             n.body = pr.body,
             n.author = pr.author,
             n.state = pr.state,
             n.isMerged = pr.isMerged,
             n.mergedAt = pr.mergedAt,
             n.headSha = pr.headSha,
             n.url = pr.url`,
        { batch: prRows, repoId }
      );
      nodesImported += prRows.length;

      // PR -> Modified File
      const prFiles: Array<{ prId: string; fileId: string; changeType: string }> = [];
      for (const pr of prs) {
        const prId = `${repoId}:pr-${pr.number}`;
        for (const f of pr.changedFiles) {
          prFiles.push({
            prId,
            fileId: `${repoId}:${f.filename}`,
            changeType: f.status,
          });
        }
      }

      if (prFiles.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (pr:PullRequest {id: row.prId})
           MERGE (f:File {id: row.fileId})
           MERGE (pr)-[:MODIFIED_FILE {changeType: row.changeType}]->(f)`,
          { batch: prFiles }
        );
        relationshipsImported += prFiles.length;
      }

      // Commit -> PR
      const commitPrs: Array<{ commitId: string; prId: string }> = [];
      for (const pr of prs) {
        const prId = `${repoId}:pr-${pr.number}`;
        if (pr.mergeCommitSha) {
          commitPrs.push({ commitId: `${repoId}:${pr.mergeCommitSha.toLowerCase()}`, prId });
        }
        for (const c of pr.commits) {
          commitPrs.push({ commitId: `${repoId}:${c.sha.toLowerCase()}`, prId });
        }
      }

      if (commitPrs.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (c:Commit {id: row.commitId})
           MATCH (pr:PullRequest {id: row.prId})
           MERGE (c)-[:MERGED_BY_PR]->(pr)`,
          { batch: commitPrs }
        );
        relationshipsImported += commitPrs.length;
      }
    }

    // 2. Ingest Issues in batches
    if (issues.length > 0) {
      const issueRows = issues.map(i => ({
        id: `${repoId}:issue-${i.number}`,
        number: i.number,
        title: i.title,
        body: i.body.substring(0, 2000),
        author: i.user.login,
        state: i.state,
        isIncident: i.isIncident,
        incidentSeverity: i.incidentSeverity || null,
        url: i.htmlUrl,
      }));

      await session.run(
        `UNWIND $batch AS issue
         MERGE (i:Issue {id: issue.id})
         SET i.repoId = $repoId,
             i.number = issue.number,
             i.title = issue.title,
             i.body = issue.body,
             i.author = issue.author,
             i.state = issue.state,
             i.isIncident = issue.isIncident,
             i.incidentSeverity = issue.incidentSeverity,
             i.url = issue.url`,
        { batch: issueRows, repoId }
      );
      nodesImported += issueRows.length;

      // PR -> CLOSES_ISSUE -> Issue
      const prIssues: Array<{ prId: string; issueId: string }> = [];
      for (const pr of prs) {
        const prId = `${repoId}:pr-${pr.number}`;
        for (const num of pr.referencedIssueNumbers) {
          prIssues.push({ prId, issueId: `${repoId}:issue-${num}` });
        }
      }

      if (prIssues.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (pr:PullRequest {id: row.prId})
           MATCH (i:Issue {id: row.issueId})
           MERGE (pr)-[:CLOSES_ISSUE]->(i)`,
          { batch: prIssues }
        );
        relationshipsImported += prIssues.length;
      }
    }

    // 3. Ingest Design Documents
    if (docs.length > 0) {
      const docRows = docs.map(d => ({
        id: d.id,
        path: d.path,
        title: d.title,
        summary: d.summary,
        hasDecisionStructure: d.hasDecisionStructure,
        lastModified: d.lastModified,
      }));

      await session.run(
        `UNWIND $batch AS doc
         MERGE (d:DesignDocument {id: doc.id})
         SET d.repoId = $repoId,
             d.path = doc.path,
             d.title = doc.title,
             d.summary = doc.summary,
             d.hasDecisionStructure = doc.hasDecisionStructure,
             d.lastModified = doc.lastModified`,
        { batch: docRows, repoId }
      );
      nodesImported += docRows.length;

      // Doc -> DOCUMENTS_FILE -> File
      const docFiles: Array<{ docId: string; fileId: string }> = [];
      for (const d of docs) {
        for (const f of d.referencedFiles) {
          docFiles.push({ docId: d.id, fileId: `${repoId}:${f}` });
        }
      }

      if (docFiles.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (d:DesignDocument {id: row.docId})
           MERGE (f:File {id: row.fileId})
           MERGE (d)-[:DOCUMENTS_FILE]->(f)`,
          { batch: docFiles }
        );
        relationshipsImported += docFiles.length;
      }
    }

    // 4. Ingest Decision Nodes and Relationships
    if (decisions.length > 0) {
      const decRows = decisions.map(d => ({
        id: d.id,
        decisionId: d.decisionId,
        title: d.title,
        rationale: d.rationale.substring(0, 2000),
        sourceType: d.sourceType,
        sourceReference: d.sourceReference,
        targetFile: d.targetFile,
        author: d.author,
        recordedAt: d.recordedAt,
        status: d.status,
        evidenceClassification: d.evidenceClassification,
      }));

      await session.run(
        `UNWIND $batch AS dec
         MERGE (d:Decision {id: dec.id})
         SET d.repoId = $repoId,
             d.decisionId = dec.decisionId,
             d.title = dec.title,
             d.rationale = dec.rationale,
             d.sourceType = dec.sourceType,
             d.sourceReference = dec.sourceReference,
             d.targetFile = dec.targetFile,
             d.author = dec.author,
             d.recordedAt = dec.recordedAt,
             d.status = dec.status,
             d.evidenceClassification = dec.evidenceClassification`,
        { batch: decRows, repoId }
      );
      nodesImported += decRows.length;

      // Decision -> JUSTIFIED_BY_PR -> PullRequest
      const decPrs = decisions
        .filter(d => d.linkedPrNumber)
        .map(d => ({ decisionId: d.id, prId: `${repoId}:pr-${d.linkedPrNumber}` }));

      if (decPrs.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (d:Decision {id: row.decisionId})
           MATCH (pr:PullRequest {id: row.prId})
           MERGE (d)-[:JUSTIFIED_BY_PR]->(pr)`,
          { batch: decPrs }
        );
        relationshipsImported += decPrs.length;
      }

      // Decision -> ANCHORED_TO_FILE -> File
      const decFiles = decisions
        .filter(d => d.targetFile)
        .map(d => ({ decisionId: d.id, fileId: `${repoId}:${d.targetFile}` }));

      if (decFiles.length > 0) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (d:Decision {id: row.decisionId})
           MERGE (f:File {id: row.fileId})
           MERGE (d)-[:ANCHORED_TO_FILE]->(f)`,
          { batch: decFiles }
        );
        relationshipsImported += decFiles.length;
      }
    }

    return {
      status: 'ok',
      repositoryId: repoId,
      nodesImported,
      relationshipsImported,
      durationMs: Date.now() - startTime,
      dryRunPlan,
    };
  } catch (err: any) {
    return {
      status: 'error',
      repositoryId: input.repoId,
      nodesImported: 0,
      relationshipsImported: 0,
      durationMs: Date.now() - startTime,
      dryRunPlan,
      error: err.message,
    };
  } finally {
    await session.close();
  }
}
