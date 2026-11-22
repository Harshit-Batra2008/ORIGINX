/**
 * GitWhisper — Compact Historical Evidence Graph Retriever (GraphRAG)
 * Retrieves connected evidence (PRs, issues, comments, design docs, decisions)
 * for a file or commit using Neo4j when available, with deterministic local Git & doc fallback.
 * Implements evidence-based supersession rules and conservative decision extraction.
 */

import * as path from 'path';
import { runGit, ICancellationTokenLike } from '../git/gitService';
import { extractIssueReferences, parseGitHubRemote } from '../github/githubService';
import { filterRelevantDesignDocs, scanDesignDocuments } from './designDocScanner';
import { openGraphSession, getActiveDriver, getOrCreateDriver, resolveNeo4jConfig } from '../neo4j/neo4jService';
import { INeo4jDriver, INeo4jSession } from '../neo4j/neo4jTypes';
import {
  CompactEvidencePackage,
  ConfidenceSignals,
  EvidenceClassification,
  GraphDecisionNode,
  GraphDesignDocumentNode,
  SupersessionStatus,
} from './evidenceGraphTypes';

export interface EvidenceRetrievalTarget {
  filePath: string;
  commitHash?: string;
  repoRoot: string;
  repoId?: string;
  neo4jService?: any;
  cancellationToken?: ICancellationTokenLike;
}

/**
 * Normalizes relative paths to POSIX format.
 */
function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Local Git commit metadata.
 */
export interface LocalGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  prNumber?: number;
  referencedIssues: number[];
}

export async function getLocalGitEvidence(
  repoRoot: string,
  filePath: string,
  cancellationToken?: ICancellationTokenLike
): Promise<LocalGitCommit[]> {
  try {
    const posixPath = toPosixPath(filePath);
    const result = await runGit(
      ['log', '-n', '25', '--follow', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', '--', posixPath],
      repoRoot,
      { cancellationToken, timeoutMs: 10000 }
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const rawCommits = result.stdout.split('\x1e').filter(chunk => chunk.trim().length > 0);
    const commits: LocalGitCommit[] = [];

    for (const chunk of rawCommits) {
      const parts = chunk.trim().split('\x1f');
      if (parts.length < 5) {
        continue;
      }

      const [hash, shortHash, author, date, subject, body = ''] = parts;

      // Extract PR number from subject like "fix(scope): preserve metacharacters (#122)"
      let prNumber: number | undefined;
      const prMatch = subject.match(/\(#(\d+)\)/);
      if (prMatch) {
        prNumber = parseInt(prMatch[1], 10);
      }

      const combinedText = `${subject}\n${body}`;
      const rawIssues = extractIssueReferences(combinedText);
      const referencedIssues = prNumber !== undefined ? rawIssues.filter(n => n !== prNumber) : rawIssues;

      commits.push({
        hash,
        shortHash,
        author,
        date,
        subject,
        body,
        prNumber,
        referencedIssues,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Extracts a relevant excerpt from a design doc referencing the target file.
 */
function findDocExcerpt(doc: GraphDesignDocumentNode, targetFile: string): string {
  const targetBase = path.basename(targetFile).toLowerCase();
  for (const sec of doc.sections) {
    if (
      sec.contentSnippet.toLowerCase().includes(targetFile.toLowerCase()) ||
      sec.contentSnippet.toLowerCase().includes(targetBase) ||
      sec.heading.toLowerCase().includes(targetBase)
    ) {
      return `[Section: ${sec.heading}] ${sec.contentSnippet.substring(0, 300)}...`;
    }
  }

  return doc.summary.substring(0, 300);
}

/**
 * Rigorous evidence-based supersession evaluator.
 * A decision/commit is ONLY marked superseded when concrete evidence exists:
 * 1. An explicit revert commit targeting this revision/PR.
 * 2. An explicit supersedes/replaces declaration in subsequent commit/PR descriptions.
 * Unrelated subsequent commits to the same file (e.g. UTF-8 encoding or formatting fixes)
 * DO NOT supersede an earlier engineering decision.
 */
export interface SupersessionEvaluation {
  status: SupersessionStatus;
  supersededBy?: {
    commitHash: string;
    shortHash: string;
    prNumber?: number;
    date: string;
    subject: string;
    reason: string;
  };
  explanation: string;
}

export function evaluateSupersession(
  targetCommitHash: string | undefined,
  targetPrNumber: number | undefined,
  commits: LocalGitCommit[]
): SupersessionEvaluation {
  if (!targetCommitHash) {
    return {
      status: 'current',
      explanation: 'No target revision specified; evaluating latest repository state.',
    };
  }

  const targetLower = targetCommitHash.toLowerCase();
  const targetIndex = commits.findIndex(
    c => c.hash.toLowerCase().startsWith(targetLower) || targetLower.startsWith(c.hash.toLowerCase())
  );

  if (targetIndex === -1) {
    return {
      status: 'unknown',
      explanation: `Target revision ${targetCommitHash.substring(0, 7)} was not found in recent Git history.`,
    };
  }

  // If the target commit is the newest commit on the file, it is current by definition
  if (targetIndex === 0) {
    return {
      status: 'current',
      explanation: 'Target revision is the latest change touching this component.',
    };
  }

  const targetCommit = commits[targetIndex];
  const targetShort = targetCommit.shortHash.toLowerCase();
  const subsequentCommits = commits.slice(0, targetIndex);

  // Inspect each subsequent commit for evidence of revert or explicit supersession
  for (const sub of subsequentCommits) {
    const textToSearch = `${sub.subject}\n${sub.body}`.toLowerCase();

    // 1. Direct Revert Check
    // e.g. "revert "fix(scope): ..."", "this reverts commit 228f976...", "revert pr #122"
    const isRevertOfTarget =
      textToSearch.includes(`revert "${targetCommit.subject.toLowerCase()}"`) ||
      textToSearch.includes(`revert '${targetCommit.subject.toLowerCase()}'`) ||
      textToSearch.includes(`revert ${targetShort}`) ||
      textToSearch.includes(`reverts commit ${targetShort}`) ||
      (targetPrNumber && (
        textToSearch.includes(`revert pr #${targetPrNumber}`) ||
        textToSearch.includes(`revert #${targetPrNumber}`) ||
        textToSearch.includes(`reverting #${targetPrNumber}`)
      ));

    if (isRevertOfTarget) {
      return {
        status: 'explicitly_superseded',
        supersededBy: {
          commitHash: sub.hash,
          shortHash: sub.shortHash,
          prNumber: sub.prNumber,
          date: sub.date,
          subject: sub.subject,
          reason: `Revert commit ${sub.shortHash} explicitly reverses this change.`,
        },
        explanation: `Explicitly superseded by revert commit ${sub.shortHash} ("${sub.subject}").`,
      };
    }

    // 2. Explicit Replacement / Supersession Declaration
    // e.g. "supersedes #122", "replaces #122", "supersedes commit 228f976"
    const isExplicitSupersede =
      textToSearch.includes(`supersedes ${targetShort}`) ||
      textToSearch.includes(`replaces ${targetShort}`) ||
      textToSearch.includes(`deprecates ${targetShort}`) ||
      (targetPrNumber && (
        textToSearch.includes(`supersedes #${targetPrNumber}`) ||
        textToSearch.includes(`replaces #${targetPrNumber}`) ||
        textToSearch.includes(`obsoletes #${targetPrNumber}`) ||
        textToSearch.includes(`deprecates #${targetPrNumber}`)
      ));

    if (isExplicitSupersede) {
      return {
        status: 'explicitly_superseded',
        supersededBy: {
          commitHash: sub.hash,
          shortHash: sub.shortHash,
          prNumber: sub.prNumber,
          date: sub.date,
          subject: sub.subject,
          reason: `Commit ${sub.shortHash} explicitly states it supersedes/replaces this change.`,
        },
        explanation: `Explicitly superseded by commit ${sub.shortHash} ("${sub.subject}").`,
      };
    }
  }

  // If no subsequent commit reverts or supersedes the change, it remains active.
  const subsequentSummary = subsequentCommits.map(c => `${c.shortHash} ("${c.subject}")`).join(', ');
  return {
    status: 'current',
    explanation: `Active decision: ${subsequentCommits.length} subsequent commit(s) (${subsequentSummary}) touch this file for orthogonal concerns and do not revert or supersede this choice.`,
  };
}

/**
 * Extracts conservative, evidence-grounded Decision nodes from PR rationale and ADR documents.
 * Does not invent decisions or promote unsupported hypotheses.
 */
export function extractDecisionsFromContext(
  repoId: string,
  pullRequests: Array<{
    number: number;
    title: string;
    body?: string;
    rationaleSummary: string;
    author: string;
    mergedAt?: string;
    url: string;
    changedFiles?: Array<{ filename: string }>;
    headSha?: string;
  }>,
  designDocs: GraphDesignDocumentNode[],
  targetFilePath: string
): GraphDecisionNode[] {
  const decisions: GraphDecisionNode[] = [];
  const normalizedTarget = toPosixPath(targetFilePath);

  // 1. Extract from PRs with explicit rationale
  for (const pr of pullRequests) {
    const rawRationale = (pr.body || pr.rationaleSummary || '').trim();

    // Conservative validation: require at least 30 characters of meaningful explanation
    // and reject trivial non-decisions like "bump", "typo", "wip", "update readme"
    const lower = rawRationale.toLowerCase();
    const isTrivial =
      lower.length < 30 ||
      lower === 'update' ||
      lower === 'bump version' ||
      lower.startsWith('merge branch') ||
      lower.startsWith('wip');

    if (isTrivial) {
      continue;
    }

    // Clean title (strip conventional commit prefixes and PR numbers)
    let cleanTitle = pr.title.replace(/\(#\d+\)/g, '').trim();
    if (cleanTitle.includes(':')) {
      cleanTitle = cleanTitle.split(':').slice(1).join(':').trim();
    }
    cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);

    decisions.push({
      id: `${repoId}:decision:pr-${pr.number}`,
      repoId,
      decisionId: `DEC-PR-${pr.number}`,
      title: cleanTitle || `Decision from PR #${pr.number}`,
      rationale: rawRationale,
      sourceType: 'pull_request_rationale',
      sourceReference: pr.url,
      targetFile: normalizedTarget,
      author: pr.author,
      recordedAt: pr.mergedAt || new Date().toISOString(),
      status: 'current',
      evidenceClassification: 'directly_supported',
      supportingCommitSha: pr.headSha,
      linkedPrNumber: pr.number,
    });
  }

  // 2. Extract from ADR / Design Documents with formal decision sections
  for (const doc of designDocs) {
    if (!doc.hasDecisionStructure) {
      continue;
    }

    const decisionSec = doc.sections.find(
      s => s.heading.toLowerCase().includes('decision') || s.heading.toLowerCase().includes('rationale')
    );

    if (decisionSec && decisionSec.contentSnippet.trim().length >= 30) {
      decisions.push({
        id: `${repoId}:decision:doc-${doc.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        repoId,
        decisionId: `DEC-DOC-${path.basename(doc.path, '.md').toUpperCase()}`,
        title: `${doc.title} — ${decisionSec.heading}`,
        rationale: decisionSec.contentSnippet.trim(),
        sourceType: 'adr_document',
        sourceReference: doc.path,
        targetFile: normalizedTarget,
        author: 'Repository Architect',
        recordedAt: doc.lastModified,
        status: 'current',
        evidenceClassification: 'directly_supported',
      });
    }
  }

  return decisions;
}

/**
 * Computes defensible confidence signals and evidence quality classification.
 * Replaces opaque percentage calculations with explicit evidence tests.
 * Supports backwards compatibility for existing tests while enabling rigorous supersession.
 */
export function computeConfidenceSignals(
  hasPr: boolean,
  hasIssue: boolean,
  hasDoc: boolean,
  supersessionOrIsSuperseded: SupersessionEvaluation | boolean,
  supersededByOrHasRationale?: any,
  customSignals?: string[]
): ConfidenceSignals {
  let supersession: SupersessionEvaluation;
  let hasExplicitRationale = true;
  let signals: string[] = [];

  if (typeof supersessionOrIsSuperseded === 'boolean') {
    // Backwards compatible signature: (hasPr, hasIssue, hasDoc, isSuperseded, supersededBy, customSignals)
    const isSuperseded = supersessionOrIsSuperseded;
    const supersededBy = supersededByOrHasRationale;
    signals = [...(customSignals ?? [])];
    supersession = isSuperseded
      ? {
          status: 'explicitly_superseded',
          supersededBy,
          explanation: 'Target revision is superseded by newer changes',
        }
      : {
          status: 'current',
          explanation: 'Target revision is current and active (no reversal found)',
        };
  } else {
    // New signature: (hasPr, hasIssue, hasDoc, supersession, hasExplicitRationale, customSignals)
    supersession = supersessionOrIsSuperseded;
    hasExplicitRationale = typeof supersededByOrHasRationale === 'boolean' ? supersededByOrHasRationale : true;
    signals = [...(customSignals ?? [])];
  }

  // Evidence Classification
  let evidenceClassification: EvidenceClassification = 'insufficient_evidence';
  if ((hasPr && hasExplicitRationale) || (hasDoc && hasExplicitRationale)) {
    evidenceClassification = 'directly_supported';
  } else if (hasPr || hasIssue || hasDoc) {
    evidenceClassification = 'partially_supported';
  }

  // Heuristic index (uncalibrated 0.0 to 1.0 index for UI sorting only)
  let heuristicScore = 0.2; // Base commit presence
  if (hasPr && hasExplicitRationale) {
    heuristicScore += 0.35;
    signals.push('Corroborated by Pull Request rationale');
  } else if (hasPr) {
    heuristicScore += 0.15;
    signals.push('Correlated Pull Request found without extended rationale');
  }

  if (hasDoc) {
    heuristicScore += 0.25;
    signals.push('Design document / ADR explicitly references this component');
  }

  if (hasIssue) {
    heuristicScore += 0.2;
    signals.push('Linked Issue or incident context available');
  }

  if (supersession.status === 'explicitly_superseded') {
    heuristicScore = Math.max(0.1, heuristicScore - 0.4);
    signals.push(supersession.explanation);
  } else {
    signals.push(supersession.explanation);
  }

  const finalScore = Math.min(1.0, Math.round(heuristicScore * 100) / 100);

  return {
    evidenceClassification,
    supersessionStatus: supersession.status,
    hasPrEvidence: hasPr,
    hasIssueLink: hasIssue,
    hasDesignDocGrounding: hasDoc,
    isSuperseded: supersession.status === 'explicitly_superseded',
    supersededBy: supersession.supersededBy,
    heuristicScore: finalScore,
    confidenceScore: finalScore,
    rationaleSignals: signals,
  };
}

const evidencePackageCache = new Map<string, { pkg: CompactEvidencePackage; timestamp: number }>();
const EVIDENCE_CACHE_TTL_MS = 60000;

/**
 * Clears the in-memory evidence package cache (used in tests).
 */
export function clearEvidencePackageCache(): void {
  evidencePackageCache.clear();
}

/**
 * Queries Neo4j AuraDB for historical evidence connecting commits, PRs, issues,
 * decisions, design documents, and supersession links for the target file.
 * Returns null if Neo4j is offline, not populated for this repo, or encounters an error,
 * triggering safe fallback to local Git & docs.
 */
export async function retrieveNeo4jEvidencePackage(
  driver: INeo4jDriver,
  target: EvidenceRetrievalTarget,
  effectiveSlug: string
): Promise<CompactEvidencePackage | null> {
  const repoId = target.repoId || effectiveSlug;
  const posixFilePath = toPosixPath(target.filePath);
  const fileId = `${repoId}:${posixFilePath}`;

  const session: INeo4jSession = openGraphSession(driver);
  try {
    // 1. Verify repository and file presence in Neo4j
    const checkQuery = `
      MATCH (r:Repository { id: $repoId })
      OPTIONAL MATCH (r)-[:CONTAINS]->(f:File { id: $fileId })
      RETURN r.id AS repoId, f.id AS fileId
    `;
    const checkRes = await session.run(checkQuery, { repoId, fileId });
    if (!checkRes.records || checkRes.records.length === 0 || !checkRes.records[0].get('repoId')) {
      return null;
    }

    // 2. Query Commits modifying file with Author and merged PR info
    const commitsQuery = `
      MATCH (r:Repository { id: $repoId })-[:HAS_COMMIT]->(c:Commit)-[m:MODIFIED]->(f:File)
      WHERE (f.id = $fileId OR f.path = $posixFilePath)
      OPTIONAL MATCH (p:Person)-[:AUTHORED]->(c)
      OPTIONAL MATCH (c)-[:MERGED_BY_PR]->(pr:PullRequest)
      RETURN
        c.hash AS hash,
        c.shortHash AS shortHash,
        c.subject AS subject,
        c.body AS body,
        c.committedAt AS committedAt,
        coalesce(p.name, 'Unknown') AS authorName,
        pr.number AS prNumber,
        pr.title AS prTitle,
        pr.url AS prUrl,
        pr.body AS prBody,
        pr.mergedAt AS prMergedAt,
        pr.author AS prAuthor
      ORDER BY c.committedAt DESC
      LIMIT 25
    `;
    const commitsRes = await session.run(commitsQuery, { repoId, fileId, posixFilePath });
    if (!commitsRes.records || commitsRes.records.length === 0) {
      return null;
    }

    const connectedCommits: CompactEvidencePackage['connectedCommits'] = [];
    const connectedPullRequests: CompactEvidencePackage['connectedPullRequests'] = [];
    const allPrNumbers = new Set<number>();

    for (const rec of commitsRes.records) {
      const getVal = (k: string) => {
        const v = typeof rec.get === 'function' ? rec.get(k) : rec[k];
        return v !== null && v !== undefined ? String(v) : '';
      };

      const hash = getVal('hash');
      const shortHash = getVal('shortHash') || hash.slice(0, 7);
      const subject = getVal('subject') || 'No subject';
      const body = getVal('body');
      const committedAt = getVal('committedAt');
      const authorName = getVal('authorName') || 'Unknown';
      const rawPrNum = typeof rec.get === 'function' ? rec.get('prNumber') : rec['prNumber'];
      const prNumber = rawPrNum ? Number(rawPrNum) : undefined;

      connectedCommits.push({
        hash,
        shortHash,
        subject,
        author: authorName,
        date: committedAt,
        prNumber,
      });

      if (prNumber && !allPrNumbers.has(prNumber)) {
        allPrNumbers.add(prNumber);
        const prTitle = getVal('prTitle') || subject;
        const prUrl = getVal('prUrl') || `https://github.com/${repoId}/pull/${prNumber}`;
        const prBody = getVal('prBody') || body;
        const prAuthor = getVal('prAuthor') || authorName;

        connectedPullRequests.push({
          number: prNumber,
          title: prTitle,
          rationaleSummary: prBody ? prBody.substring(0, 300) : prTitle,
          author: prAuthor,
          state: 'closed',
          isMerged: true,
          mergedAt: getVal('prMergedAt') || committedAt,
          url: prUrl,
          keyDiscussions: prBody ? [prBody.substring(0, 200)] : [],
        });
      }
    }

    // 3. Query Decisions anchored to file or justified by PR
    const decisionsQuery = `
      MATCH (d:Decision)
      WHERE d.repoId = $repoId
        AND (
          d.targetFile = $posixFilePath
          OR (d)-[:ANCHORED_TO_FILE]->(:File {id: $fileId})
          OR (d)-[:ANCHORED_TO_FILE]->(:File {path: $posixFilePath})
          OR (d)-[:JUSTIFIED_BY_PR]->(:PullRequest)-[:MODIFIED_FILE]->(:File {id: $fileId})
          OR (d)-[:JUSTIFIED_BY_PR]->(:PullRequest)-[:MODIFIED_FILE]->(:File {path: $posixFilePath})
        )
      OPTIONAL MATCH (d)-[:JUSTIFIED_BY_PR]->(pr:PullRequest)
      OPTIONAL MATCH (d)-[:GROUNDED_IN_COMMIT]->(gc:Commit)
      RETURN
        d.id AS id,
        d.decisionId AS decisionId,
        d.title AS title,
        d.rationale AS rationale,
        d.status AS status,
        d.evidenceClassification AS evidenceClassification,
        d.isProvisional AS isProvisional,
        d.verificationStatus AS verificationStatus,
        pr.number AS linkedPrNumber,
        gc.hash AS supportingCommitSha
      LIMIT 10
    `;
    const decRes = await session.run(decisionsQuery, { repoId, fileId, posixFilePath });
    const existingDecisions: Array<{
      id: string;
      title: string;
      status: string;
      rationale: string;
      decisionId?: string;
      isProvisional?: boolean;
      verificationStatus?: string;
      linkedPrNumber?: number;
      supportingCommitSha?: string;
    }> = [];
    if (decRes.records) {
      for (const rec of decRes.records) {
        const getVal = (k: string) => {
          const v = typeof rec.get === 'function' ? rec.get(k) : rec[k];
          return v !== null && v !== undefined ? String(v) : '';
        };
        const id = getVal('id');
        const title = getVal('title');
        const rationale = getVal('rationale');
        const status = getVal('status') || 'current';
        const decisionId = getVal('decisionId');
        const isProvisional = typeof rec.get === 'function' ? rec.get('isProvisional') : rec['isProvisional'];
        const verificationStatus = getVal('verificationStatus');
        const prNumVal = typeof rec.get === 'function' ? rec.get('linkedPrNumber') : rec['linkedPrNumber'];
        const linkedPrNumber = prNumVal ? Number(prNumVal) : undefined;
        const supportingCommitSha = getVal('supportingCommitSha');
        if (id && title) {
          existingDecisions.push({
            id,
            title,
            status,
            rationale,
            decisionId: decisionId || undefined,
            isProvisional: Boolean(isProvisional),
            verificationStatus: verificationStatus || undefined,
            linkedPrNumber,
            supportingCommitSha: supportingCommitSha || undefined,
          });
        }
      }
    }

    // 4. Query Grounding Documents
    const docsQuery = `
      MATCH (doc:DesignDocument)-[:DOCUMENTS_FILE]->(f:File)
      WHERE doc.repoId = $repoId AND (f.id = $fileId OR f.path = $posixFilePath)
      RETURN doc.path AS path, doc.title AS title, doc.summary AS summary
      LIMIT 5
    `;
    const docsRes = await session.run(docsQuery, { repoId, fileId, posixFilePath });
    const groundingDocuments: CompactEvidencePackage['groundingDocuments'] = [];
    if (docsRes.records) {
      for (const rec of docsRes.records) {
        const getVal = (k: string) => {
          const v = typeof rec.get === 'function' ? rec.get(k) : rec[k];
          return v !== null && v !== undefined ? String(v) : '';
        };
        groundingDocuments.push({
          path: getVal('path'),
          title: getVal('title'),
          relevantExcerpt: getVal('summary'),
        });
      }
    }

    // 5. Query Connected Issues (closing PRs)
    const issuesQuery = `
      MATCH (pr:PullRequest)-[:CLOSES_ISSUE]->(i:Issue)
      WHERE pr.repoId = $repoId
      RETURN i.number AS number, i.title AS title, i.isIncident AS isIncident, i.url AS url
      LIMIT 5
    `;
    const issuesRes = await session.run(issuesQuery, { repoId });
    const connectedIssues: CompactEvidencePackage['connectedIssues'] = [];
    if (issuesRes.records) {
      for (const rec of issuesRes.records) {
        const numVal = typeof rec.get === 'function' ? rec.get('number') : rec['number'];
        const num = Number(numVal);
        if (num && !allPrNumbers.has(num)) {
          const getVal = (k: string) => {
            const v = typeof rec.get === 'function' ? rec.get(k) : rec[k];
            return v !== null && v !== undefined ? String(v) : '';
          };
          connectedIssues.push({
            number: num,
            title: getVal('title') || `Issue #${num}`,
            isIncident: Boolean(typeof rec.get === 'function' ? rec.get('isIncident') : rec['isIncident']),
            url: getVal('url') || `https://github.com/${repoId}/issues/${num}`,
          });
        }
      }
    }

    // 6. Query Explicit Supersession
    const supersessionQuery = `
      MATCH (c1:Commit)-[:EXPLICITLY_SUPERSEDES]->(c2:Commit)
      WHERE c2.repoId = $repoId
      RETURN c1.hash AS supersedingHash, c2.hash AS supersededHash
    `;
    const superRes = await session.run(supersessionQuery, { repoId });
    const explicitReversals = new Set<string>();
    if (superRes.records) {
      for (const rec of superRes.records) {
        const v = typeof rec.get === 'function' ? rec.get('supersededHash') : rec['supersededHash'];
        if (v) explicitReversals.add(String(v).toLowerCase());
      }
    }

    // Target commit re-ordering if specified
    const targetCommitObj = connectedCommits.find(
      c => target.commitHash && (c.hash.toLowerCase().startsWith(target.commitHash.toLowerCase()) || target.commitHash.toLowerCase().startsWith(c.hash.toLowerCase()))
    );

    if (targetCommitObj) {
      const commitIdx = connectedCommits.findIndex(c => c.hash.toLowerCase() === targetCommitObj.hash.toLowerCase());
      if (commitIdx > 0) {
        const [tc] = connectedCommits.splice(commitIdx, 1);
        connectedCommits.unshift(tc);
      }
      if (targetCommitObj.prNumber) {
        const prIdx = connectedPullRequests.findIndex(pr => pr.number === targetCommitObj.prNumber);
        if (prIdx > 0) {
          const [tp] = connectedPullRequests.splice(prIdx, 1);
          connectedPullRequests.unshift(tp);
        }
        // Prioritize decision linked to the target PR
        const decIdx = existingDecisions.findIndex(
          d => d.linkedPrNumber === targetCommitObj.prNumber || d.id.includes(`pr-${targetCommitObj.prNumber}`)
        );
        if (decIdx > 0) {
          const [td] = existingDecisions.splice(decIdx, 1);
          existingDecisions.unshift(td);
        }
      }
      if (existingDecisions.length > 0 && targetCommitObj.hash) {
        const decByCommit = existingDecisions.findIndex(
          d => d.supportingCommitSha && d.supportingCommitSha.toLowerCase().startsWith(targetCommitObj.hash.toLowerCase().substring(0, 7))
        );
        if (decByCommit > 0) {
          const [td] = existingDecisions.splice(decByCommit, 1);
          existingDecisions.unshift(td);
        }
      }
    }

    const isExplicitlyReversed = target.commitHash ? explicitReversals.has(target.commitHash.toLowerCase()) : false;
    const supersessionStatus: SupersessionStatus = isExplicitlyReversed ? 'explicitly_superseded' : 'current';
    const hasPrForTarget = target.commitHash ? Boolean(targetCommitObj?.prNumber) : connectedPullRequests.length > 0;
    const hasExplicitRationale = existingDecisions.length > 0 || connectedPullRequests.some(pr => pr.rationaleSummary.length >= 30);

    const confidenceSignals = computeConfidenceSignals(
      hasPrForTarget,
      connectedIssues.length > 0,
      groundingDocuments.length > 0,
      {
        status: supersessionStatus,
        explanation: isExplicitlyReversed
          ? 'Explicitly superseded by a subsequent revert commit in the Neo4j graph.'
          : 'Active / Current (no supersession found in inspected evidence).',
      },
      hasExplicitRationale
    );

    return {
      query: {
        filePath: posixFilePath,
        commitHash: target.commitHash,
        repoId,
      },
      connectedCommits,
      connectedPullRequests,
      connectedIssues,
      groundingDocuments,
      existingDecisions,
      confidenceSignals,
      retrievalSource: 'neo4j_aura',
      retrievedAt: new Date().toISOString(),
    };
  } catch {
    return null; // Fall back to local Git & docs
  } finally {
    await session.close();
  }
}

/**
 * Retrieves a compact, structured GraphRAG evidence package for a file or commit.
 */
export async function retrieveCompactEvidencePackage(
  target: EvidenceRetrievalTarget
): Promise<CompactEvidencePackage> {
  const repoId = target.repoId || path.basename(target.repoRoot);
  const posixFilePath = toPosixPath(target.filePath);
  const cacheKey = `${target.repoRoot}::${posixFilePath}::${target.commitHash || ''}`;
  const now = Date.now();
  const cached = evidencePackageCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < EVIDENCE_CACHE_TTL_MS) {
    return cached.pkg;
  }

  // Determine GitHub remote owner/repo slug if available
  let githubSlug: string | undefined;
  if (repoId.includes('/')) {
    githubSlug = repoId;
  } else {
    try {
      const remoteRes = await runGit(['remote', 'get-url', 'origin'], target.repoRoot, {
        cancellationToken: target.cancellationToken,
        timeoutMs: 3000
      });
      if (remoteRes.exitCode === 0 && remoteRes.stdout) {
        const parsed = parseGitHubRemote(remoteRes.stdout.trim());
        if (parsed) {
          githubSlug = `${parsed.owner}/${parsed.repo}`;
        }
      }
    } catch {
      // Fallback to repoId
    }
  }

  const effectiveSlug = githubSlug || repoId;

  // 0. Live Neo4j Aura GraphRAG Retrieval (if driver configured/available)
  let driverToUse = target.neo4jService?.getActiveDriver?.() ||
    (typeof target.neo4jService?.session === 'function' ? target.neo4jService : undefined) ||
    getActiveDriver();

  if (!driverToUse) {
    try {
      const cfg = resolveNeo4jConfig();
      if (cfg.password) {
        driverToUse = getOrCreateDriver(cfg);
      }
    } catch {
      // Driver creation failed or no credentials
    }
  }

  if (driverToUse) {
    try {
      const graphPkg = await retrieveNeo4jEvidencePackage(driverToUse, target, effectiveSlug);
      if (graphPkg) {
        evidencePackageCache.set(cacheKey, { pkg: graphPkg, timestamp: now });
        return graphPkg;
      }
    } catch {
      // Safe fallback to local Git & docs
    }
  }

  // 1. Local Git Commits (Deterministic Fallback)
  const localCommits = await getLocalGitEvidence(target.repoRoot, posixFilePath, target.cancellationToken);

  // 2. Scan and strictly filter relevant design docs
  const allDesignDocs = scanDesignDocuments(target.repoRoot, { repoId: effectiveSlug });
  const relevantDocResults = filterRelevantDesignDocs(allDesignDocs, posixFilePath);
  const relevantDocs = relevantDocResults.map(r => r.doc);

  const connectedCommits = localCommits.map(c => ({
    hash: c.hash,
    shortHash: c.shortHash,
    subject: c.subject,
    author: c.author,
    date: c.date,
    prNumber: c.prNumber,
  }));

  const connectedPullRequests: CompactEvidencePackage['connectedPullRequests'] = [];
  const connectedIssues: CompactEvidencePackage['connectedIssues'] = [];
  const allPrNumbers = new Set<number>();

  for (const c of localCommits) {
    if (c.prNumber) {
      allPrNumbers.add(c.prNumber);
      if (!connectedPullRequests.some(pr => pr.number === c.prNumber)) {
        connectedPullRequests.push({
          number: c.prNumber,
          title: c.subject,
          rationaleSummary: c.body ? c.body.substring(0, 300) : c.subject,
          author: c.author,
          state: 'closed',
          isMerged: true,
          mergedAt: c.date,
          url: `https://github.com/${effectiveSlug}/pull/${c.prNumber}`,
          keyDiscussions: c.body ? [c.body.substring(0, 200)] : [],
        });
      }
    }
  }

  for (const c of localCommits) {
    for (const issueNum of c.referencedIssues) {
      // Do not duplicate known PR numbers as issues
      if (allPrNumbers.has(issueNum)) {
        continue;
      }
      if (!connectedIssues.some(i => i.number === issueNum)) {
        connectedIssues.push({
          number: issueNum,
          title: `Referenced in commit ${c.shortHash}`,
          isIncident: false,
          url: `https://github.com/${effectiveSlug}/issues/${issueNum}`,
        });
      }
    }
  }

  const groundingDocuments = relevantDocs.map(d => ({
    path: d.path,
    title: d.title,
    relevantExcerpt: findDocExcerpt(d, posixFilePath),
  }));

  // Target commit PR number if any
  const targetCommitObj = localCommits.find(
    c => target.commitHash && (c.hash.toLowerCase().startsWith(target.commitHash.toLowerCase()) || target.commitHash.toLowerCase().startsWith(c.hash.toLowerCase()))
  );

  // If a target commit is specified, prioritize it at the front of commits and PRs
  if (targetCommitObj) {
    const commitIdx = connectedCommits.findIndex(c => c.hash.toLowerCase() === targetCommitObj.hash.toLowerCase());
    if (commitIdx > 0) {
      const [tc] = connectedCommits.splice(commitIdx, 1);
      connectedCommits.unshift(tc);
    }

    if (targetCommitObj.prNumber) {
      const prIdx = connectedPullRequests.findIndex(pr => pr.number === targetCommitObj.prNumber);
      if (prIdx > 0) {
        const [tp] = connectedPullRequests.splice(prIdx, 1);
        connectedPullRequests.unshift(tp);
      }
    }
  }

  // 3. Evaluate Supersession using rigorous evidence-based rules
  const supersession = evaluateSupersession(
    target.commitHash,
    targetCommitObj?.prNumber,
    localCommits
  );

  // 4. Extract conservative, evidence-grounded Decision nodes
  const prsForDecisions = target.commitHash
    ? (targetCommitObj?.prNumber ? connectedPullRequests.filter(pr => pr.number === targetCommitObj.prNumber) : [])
    : connectedPullRequests;

  const existingDecisions = extractDecisionsFromContext(
    repoId,
    prsForDecisions,
    relevantDocs,
    posixFilePath
  );

  const hasExplicitRationale = existingDecisions.length > 0;
  const hasPrForTarget = target.commitHash ? Boolean(targetCommitObj?.prNumber) : connectedPullRequests.length > 0;

  const confidenceSignals = computeConfidenceSignals(
    hasPrForTarget,
    connectedIssues.length > 0,
    groundingDocuments.length > 0,
    supersession,
    hasExplicitRationale
  );

  const resultPkg: CompactEvidencePackage = {
    query: {
      filePath: posixFilePath,
      commitHash: target.commitHash,
      repoId: effectiveSlug,
    },
    connectedCommits,
    connectedPullRequests,
    connectedIssues,
    groundingDocuments,
    existingDecisions: existingDecisions.map(d => ({
      id: d.id,
      title: d.title,
      status: d.status,
      rationale: d.rationale,
    })),
    confidenceSignals,
    retrievalSource: 'local_git_and_docs_fallback',
    retrievedAt: new Date().toISOString(),
  };

  evidencePackageCache.set(cacheKey, { pkg: resultPkg, timestamp: now });
  return resultPkg;
}
