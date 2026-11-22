/**
 * GitWhisper — Flagship "Ask Why" (Why The Code Is Like This) Service
 * Reconstructs the complete historical evidence chain (Code -> Commit -> PR -> Decision -> Doc)
 * and generates evidence-grounded AI reasoning for natural-language questions.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  findRepoRoot,
  getHistoryForSelection,
  parseBlamePorcelain,
  runGit,
  ICancellationTokenLike,
} from '../git/gitService';
import {
  retrieveCompactEvidencePackage,
  LocalGitCommit,
} from '../evidenceGraph/evidenceGraphRetriever';
import {
  EvidenceClassification,
  GraphDecisionNode,
  SupersessionStatus,
} from '../evidenceGraph/evidenceGraphTypes';
import {
  callVsCodeLanguageModel,
  DefaultVsCodeLanguageModelProvider,
  ILanguageModelChat,
  ILanguageModelProvider,
} from '../lm/vscodeLmClient';
import { redactSecret } from '../neo4j/neo4jEnv';
import {
  AskWhyCitation,
  AskWhyDiagnostics,
  AskWhyRequest,
  AskWhyResult,
  AskWhyTarget,
} from './askWhyTypes';

/**
 * Normalizes any path to POSIX relative format.
 */
function toPosixRelative(repoRoot: string, filePath: string): string {
  const rel = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  return rel.replace(/\\/g, '/');
}

/**
 * Reads lines from a file if snippet is not provided.
 */
function readCodeSnippet(
  repoRoot: string,
  relPath: string,
  lineRange?: { startLine: number; endLine: number }
): string {
  try {
    const fullPath = path.resolve(repoRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      return '';
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);

    if (!lineRange) {
      return lines.slice(0, 50).join('\n');
    }

    const start = Math.max(0, lineRange.startLine - 1);
    const end = Math.min(lines.length, lineRange.endLine);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

/**
 * Identifies the primary commit for a specific line range via Git blame.
 */
async function findCommitForLineRange(
  repoRoot: string,
  relPath: string,
  lineRange?: { startLine: number; endLine: number },
  cancellationToken?: ICancellationTokenLike
): Promise<string | undefined> {
  if (!lineRange) {
    return undefined;
  }

  try {
    const blameResult = await runGit(
      ['blame', '-p', '-L', `${lineRange.startLine},${lineRange.endLine}`, '--', relPath],
      repoRoot,
      { cancellationToken, timeoutMs: 10000 }
    );

    if (blameResult.exitCode === 0 && blameResult.stdout) {
      const parsed = parseBlamePorcelain(blameResult.stdout);
      if (parsed.hashes && parsed.hashes.length > 0) {
        const hash = parsed.hashes[0];
        if (!hash.startsWith('0000000')) {
          return hash;
        }
      }
    }
  } catch {
    // Ignore and fallback
  }

  return undefined;
}

/**
 * Builds the strict, evidence-grounded prompt for the Language Model.
 */
export function buildAskWhyPrompt(
  question: string,
  target: AskWhyTarget,
  evidencePkg: any,
  retrievedDecision?: GraphDecisionNode
): string {
  const lines: string[] = [];

  lines.push('You are GitWhisper’s "Why The Code Is Like This" explanation engine.');
  lines.push('A developer has highlighted code in their repository and asked a question about why it was written this way.');
  lines.push('Your sole role is to answer their question using ONLY the provided historical evidence (Commits, Pull Requests, Issues, and Design Documents).');
  lines.push('');
  lines.push('CRITICAL GROUNDING & REFUSAL RULES:');
  lines.push('1. STRICT EVIDENCE REQUISITE: Base your answer exclusively on the historical evidence below. Do not guess, speculate, or fabricate intention.');
  lines.push('2. EXPLICIT ABSTENTION / REFUSAL: If the provided commits, PRs, and documents do NOT explain why the code was written this way (e.g. only mechanical changes or unrelated commits exist), you MUST state clearly:');
  lines.push('   "INSUFFICIENT HISTORICAL EVIDENCE: The recorded commit history, pull requests, and documentation do not state the engineering reason for this implementation."');
  lines.push('   Explain what is known and what is missing without inventing answers.');
  lines.push('3. CITATIONS: Every claim must cite the specific source: Commit SHA (e.g. `228f976`), Pull Request (e.g. `PR #122`), or Document (e.g. `commands/scope.md`).');
  lines.push('4. SUPERSESSION: Report whether the decision is current or superseded based on the provided supersession evaluation.');
  lines.push('5. CONCISENESS: Provide a concise, specific answer in 2 to 5 sentences. State the concrete engineering reason and design intent directly without generic filler or conversational padding.');
  lines.push('');
  lines.push('=== DEVELOPER QUESTION ===');
  lines.push(question);
  lines.push('');
  lines.push(`=== TARGET CODE (${target.filePath}${target.lineRange ? ` L${target.lineRange.startLine}-L${target.lineRange.endLine}` : ''}) ===`);
  lines.push('```');
  lines.push(target.selectedSnippet || '(Entire file context)');
  lines.push('```');
  lines.push('');

  lines.push('=== HISTORICAL EVIDENCE ===');
  if (retrievedDecision) {
    const dId = (retrievedDecision as any).decisionId || (retrievedDecision as any).id || 'DECISION';
    lines.push(`RECORDED DECISION [${dId}]: "${retrievedDecision.title}"`);
    lines.push(`- Rationale: ${retrievedDecision.rationale}`);
    if ((retrievedDecision as any).author) {
      lines.push(`- Author: ${(retrievedDecision as any).author}`);
    }
    lines.push(`- Status: ${retrievedDecision.status || 'current'}`);
    lines.push('');
  }

  lines.push('CONNECTED PULL REQUESTS:');
  if (evidencePkg.connectedPullRequests && evidencePkg.connectedPullRequests.length > 0) {
    for (const pr of evidencePkg.connectedPullRequests) {
      lines.push(`- PR #${pr.number}: "${pr.title}" by @${pr.author} (Merged: ${pr.mergedAt || 'N/A'})`);
      if (pr.rationaleSummary) {
        lines.push(`  Description / Discussion: ${pr.rationaleSummary.replace(/\n+/g, ' ').substring(0, 1000)}`);
      }
      if (pr.keyDiscussions && pr.keyDiscussions.length > 0) {
        lines.push(`  Key Discussions: ${pr.keyDiscussions.join(' | ').substring(0, 500)}`);
      }
      lines.push(`  URL: ${pr.url}`);
    }
  } else {
    lines.push('  (No pull requests correlated)');
  }
  lines.push('');

  lines.push('CONNECTED COMMITS:');
  if (evidencePkg.connectedCommits && evidencePkg.connectedCommits.length > 0) {
    for (const c of evidencePkg.connectedCommits.slice(0, 6)) {
      lines.push(`- Commit ${c.shortHash} by ${c.author} on ${c.date}: "${c.subject}"`);
    }
  } else {
    lines.push('  (No commit history available)');
  }
  lines.push('');

  lines.push('GROUNDING DESIGN DOCUMENTS & ADRs:');
  if (evidencePkg.groundingDocuments && evidencePkg.groundingDocuments.length > 0) {
    for (const doc of evidencePkg.groundingDocuments) {
      lines.push(`- Document "${doc.title}" (${doc.path}):`);
      lines.push(`  ${doc.relevantExcerpt}`);
    }
  } else {
    lines.push('  (No relevant design documents or ADRs found)');
  }
  lines.push('');

  lines.push('SUPERSESSION STATUS:');
  lines.push(`- Status: ${evidencePkg.confidenceSignals.supersessionStatus === 'current' ? 'No supersession found in inspected evidence (Active / Current)' : evidencePkg.confidenceSignals.supersessionStatus}`);
  if (evidencePkg.confidenceSignals.supersededBy) {
    lines.push(`- Superseded by commit ${evidencePkg.confidenceSignals.supersededBy.commitHash.substring(0, 7)}: "${evidencePkg.confidenceSignals.supersededBy.subject}"`);
  }
  lines.push(`- Details: ${evidencePkg.confidenceSignals.rationaleSignals.join('; ')}`);
  lines.push('');

  lines.push('=== NOW ANSWER THE DEVELOPER QUESTION ===');
  return lines.join('\n');
}

/**
 * Executes the Flagship "Ask Why" reasoning and evidence assembly workflow.
 */
export async function executeAskWhy(request: AskWhyRequest): Promise<AskWhyResult> {
  const retrievalStartTime = Date.now();
  const relPath = toPosixRelative(request.repoRoot, request.filePath);

  const snippet = request.selectedSnippet || readCodeSnippet(request.repoRoot, relPath, request.lineRange);

  // 1. Identify specific commit if line range is provided
  let primaryCommit = request.commitHash;
  if (!primaryCommit && request.lineRange) {
    primaryCommit = await findCommitForLineRange(
      request.repoRoot,
      relPath,
      request.lineRange,
      request.cancellationToken
    );
  }

  const target: AskWhyTarget = {
    filePath: relPath,
    lineRange: request.lineRange,
    selectedSnippet: snippet,
    commitHash: primaryCommit,
  };

  // 2. Retrieve Evidence Package using the evidence graph retriever
  const evidencePkg = await retrieveCompactEvidencePackage({
    filePath: relPath,
    commitHash: primaryCommit,
    repoRoot: request.repoRoot,
    neo4jService: request.neo4jService,
    cancellationToken: request.cancellationToken,
  });

  const retrievalDurationMs = Date.now() - retrievalStartTime;

  // 3. Assemble Prioritized Citations
  // Prioritize the target commit's PR, the target commit itself, and direct documentation
  const citations: AskWhyCitation[] = [];
  const primaryDecision = evidencePkg.existingDecisions?.[0] as GraphDecisionNode | undefined;

  const targetCommitObj = evidencePkg.connectedCommits.find(
    (c: any) => primaryCommit && (c.hash.toLowerCase().startsWith(primaryCommit.toLowerCase()) || primaryCommit.toLowerCase().startsWith(c.hash.toLowerCase()))
  );
  const targetPr = targetCommitObj
    ? (targetCommitObj.prNumber ? evidencePkg.connectedPullRequests.find((pr: any) => pr.number === targetCommitObj.prNumber) : undefined)
    : (evidencePkg.connectedPullRequests.length > 0 ? evidencePkg.connectedPullRequests[0] : undefined);

  // 1) Primary Pull Request
  if (targetPr) {
    citations.push({
      type: 'pull_request',
      identifier: `PR #${targetPr.number}`,
      title: targetPr.title,
      url: targetPr.url,
      author: targetPr.author,
      date: targetPr.mergedAt,
      excerpt: targetPr.rationaleSummary,
    });
  }

  // 2) Primary Commit
  const primaryCommitItem = targetCommitObj || (evidencePkg.connectedCommits.length > 0 ? evidencePkg.connectedCommits[0] : undefined);
  if (primaryCommitItem) {
    citations.push({
      type: 'commit',
      identifier: primaryCommitItem.shortHash,
      title: primaryCommitItem.subject,
      author: primaryCommitItem.author,
      date: primaryCommitItem.date,
    });
  }

  // 3) Primary Design Document / ADR
  if (evidencePkg.groundingDocuments.length > 0) {
    const doc = evidencePkg.groundingDocuments[0];
    citations.push({
      type: 'design_doc',
      identifier: doc.path,
      title: doc.title,
      excerpt: doc.relevantExcerpt,
    });
  }

  // 4) Connected Issues (distinct from PR)
  for (const issue of evidencePkg.connectedIssues) {
    if (!citations.some(c => c.identifier === `Issue #${issue.number}`)) {
      citations.push({
        type: 'issue',
        identifier: `Issue #${issue.number}`,
        title: issue.title,
        url: issue.url,
      });
    }
  }

  // 5) Additional supporting PRs and commits (for Full Investigation)
  for (const pr of evidencePkg.connectedPullRequests) {
    const isTargetPr = targetPr && pr.number === targetPr.number;
    const isPrimaryDecisionPr = primaryDecision && (primaryDecision as any).linkedPrNumber === pr.number;
    const matchesCommit = targetCommitObj && targetCommitObj.prNumber === pr.number;

    // If a primary PR or decision exists, filter out orthogonal PRs that do not relate to the selected code/rationale
    if ((targetPr || primaryDecision) && !isTargetPr && !isPrimaryDecisionPr && !matchesCommit) {
      continue;
    }

    if (!citations.some(c => c.identifier === `PR #${pr.number}`)) {
      citations.push({
        type: 'pull_request',
        identifier: `PR #${pr.number}`,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        date: pr.mergedAt,
        excerpt: pr.rationaleSummary,
      });
    }
  }

  for (const c of evidencePkg.connectedCommits.slice(0, 5)) {
    const isTargetCommit = targetCommitObj && (c.hash.toLowerCase().startsWith(targetCommitObj.hash.toLowerCase()) || targetCommitObj.hash.toLowerCase().startsWith(c.hash.toLowerCase()));
    const isTargetPrCommit = targetCommitObj?.prNumber && c.prNumber === targetCommitObj.prNumber;

    if (targetCommitObj && !isTargetCommit && !isTargetPrCommit) {
      continue;
    }

    if (!citations.some(item => item.identifier === c.shortHash)) {
      citations.push({
        type: 'commit',
        identifier: c.shortHash,
        title: c.subject,
        author: c.author,
        date: c.date,
      });
    }
  }

  for (const doc of evidencePkg.groundingDocuments.slice(1)) {
    if (!citations.some(c => c.identifier === doc.path)) {
      citations.push({
        type: 'design_doc',
        identifier: doc.path,
        title: doc.title,
        excerpt: doc.relevantExcerpt,
      });
    }
  }

  // 4. Determine Deterministic Evidence Classification & Supersession
  const classification: EvidenceClassification = evidencePkg.confidenceSignals.evidenceClassification;
  const supersession: SupersessionStatus = evidencePkg.confidenceSignals.supersessionStatus;

  // 5. Build Grounded Prompt & Run Security Redactor
  const rawPrompt = buildAskWhyPrompt(request.question, target, evidencePkg, primaryDecision);
  const sanitizedPrompt = redactSecret(rawPrompt);

  let answerText = '';
  let modelName = 'none';
  let aiDurationMs = 0;
  let isRefusal = classification === 'insufficient_evidence';

  const aiStartTime = Date.now();
  const provider = request.lmProvider || new DefaultVsCodeLanguageModelProvider();

  if (provider.isSupported()) {
    try {
      const callResult = await callVsCodeLanguageModel(sanitizedPrompt, {
        provider,
        modelInstance: request.preferredModel,
        cancellationToken: request.cancellationToken as any,
      });
      answerText = callResult.text.trim();
      modelName = callResult.model;
      aiDurationMs = Date.now() - aiStartTime;
    } catch {
      // Fallback to structured evidence synthesis
    }
  }

  // 6. Deterministic Fallback if AI Model is not available or threw an error
  if (!answerText) {
    aiDurationMs = Date.now() - aiStartTime;
    modelName = 'deterministic_evidence_synthesizer';

    if (primaryDecision && primaryDecision.rationale) {
      const decId = (primaryDecision as any).decisionId || (primaryDecision as any).id || 'Decision';
      const decAuthor = (primaryDecision as any).author ? `@${(primaryDecision as any).author}` : 'evidence graph';
      const decType = (primaryDecision as any).sourceType ? ` (${String((primaryDecision as any).sourceType).replace(/_/g, ' ')})` : '';
      const isProvisional = (primaryDecision as any).isProvisional || (primaryDecision as any).verificationStatus === 'provisional';
      const provisionalNote = isProvisional
        ? '\n\n> [!NOTE]\n> **Decision Status:** Provisional (extracted from pull request evidence; no supersession found in inspected evidence).'
        : '';
      answerText = `### Engineering Rationale\n\n${primaryDecision.rationale}\n\n` +
        `**Source Evidence:** Recorded in **${decId}** by ${decAuthor}${decType}.\n\n` +
        `**Supersession Status:** ${supersession === 'current' ? 'No supersession found in inspected evidence (Active / Current)' : supersession}.\n\n` +
        `**Connected Citations:** ${citations.slice(0, 3).map(c => `\`${c.identifier}\``).join(', ')}.${provisionalNote}`;
    } else if (targetPr && targetPr.rationaleSummary) {
      answerText = `### Pull Request Rationale\n\n${targetPr.rationaleSummary}\n\n` +
        `**Source Evidence:** **PR #${targetPr.number}** ("${targetPr.title}") by @${targetPr.author}.\n\n` +
        `**Supersession Status:** ${supersession === 'current' ? 'No supersession found in inspected evidence (Active / Current)' : supersession}.`;
    } else {
      isRefusal = true;
      answerText = `INSUFFICIENT HISTORICAL EVIDENCE: The recorded commit history, pull requests, and repository documentation do not state the engineering reason for this implementation.\n\n` +
        `- **Inspected File:** \`${target.filePath}\`\n` +
        `- **Known Commits:** ${evidencePkg.connectedCommits.map((c: any) => `\`${c.shortHash}\``).slice(0, 3).join(', ') || 'None'}\n` +
        `- **Missing Source:** No associated pull request description or architecture decision record documents the intent for this specific choice.`;
    }
  }

  if (answerText.startsWith('INSUFFICIENT HISTORICAL EVIDENCE') || answerText.includes('INSUFFICIENT HISTORICAL EVIDENCE:')) {
    isRefusal = true;
  }

  // Authoritative deterministic classification: do NOT let string matching override directly_supported
  const finalClassification: EvidenceClassification =
    classification === 'directly_supported'
      ? 'directly_supported'
      : (isRefusal ? 'insufficient_evidence' : classification);

  const isRefusalOrInsufficient = finalClassification === 'insufficient_evidence' || isRefusal;

  // 7. Observability & Retrieval Source Labeling
  const isNeo4jActive = evidencePkg.retrievalSource === 'neo4j_aura';
  let retrievalSource: AskWhyDiagnostics['retrievalSource'] = 'local_git';
  let retrievalSourceLabel = 'Local Git History & Blame';

  if (isNeo4jActive) {
    retrievalSource = 'neo4j_graph';
    retrievalSourceLabel = 'Neo4j Aura Knowledge Graph';
  } else if (evidencePkg.connectedPullRequests.length > 0 && evidencePkg.groundingDocuments.length > 0) {
    retrievalSource = 'mixed_sources';
    retrievalSourceLabel = 'Local Git + GitHub Evidence + Repository Documentation';
  } else if (evidencePkg.connectedPullRequests.length > 0) {
    retrievalSource = 'github_api';
    retrievalSourceLabel = 'Local Git + GitHub API PR Records';
  } else if (evidencePkg.groundingDocuments.length > 0) {
    retrievalSource = 'local_documentation';
    retrievalSourceLabel = 'Local Git + Design Documents';
  }

  const diagnostics: AskWhyDiagnostics = {
    retrievalDurationMs,
    aiDurationMs,
    retrievalSource,
    retrievalSourceLabel,
    isNeo4jActive,
    approximateTokens: Math.ceil(sanitizedPrompt.length / 4),
    modelName,
    commitCount: evidencePkg.connectedCommits.length,
    prCount: evidencePkg.connectedPullRequests.length,
    docCount: evidencePkg.groundingDocuments.length,
  };

  const result: AskWhyResult = {
    question: request.question,
    target,
    answer: answerText,
    evidenceClassification: finalClassification,
    supersessionStatus: supersession,
    isRefusalOrInsufficient,
    primaryDecision,
    citations,
    diagnostics,
    answeredAt: new Date().toISOString(),
  };

  lastAskWhyResult = result;
  return result;
}

let lastAskWhyResult: AskWhyResult | undefined;

export function getLastAskWhyResult(): AskWhyResult | undefined {
  return lastAskWhyResult;
}

export function clearLastAskWhyResult(): void {
  lastAskWhyResult = undefined;
}
