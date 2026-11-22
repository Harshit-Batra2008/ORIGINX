import {
  UnifiedAnalysisExplanation,
  UnifiedEvidenceBundle,
  UnifiedSuggestedFix
} from './unifiedTypes';

export const DEFAULT_MAX_UNIFIED_PROMPT_CHARS = 40000;

/**
 * Builds a structured, evidence-grounded prompt for unified code analysis
 * combining code explanation, Git history, diagnostics, working-tree changes, and Neo4j co-changes.
 */
export function buildUnifiedAnalysisPrompt(
  evidence: UnifiedEvidenceBundle,
  options?: {
    maxInputTokens?: number;
  }
): string {
  const req = evidence.request;
  const history = evidence.gitHistory;
  const diagnostics = evidence.diagnostics;
  const coChanges = evidence.localGitCoChanges ?? evidence.neo4jCoChanges;
  const neo4jCommits = evidence.neo4jFileEvidence;

  const maxChars = options?.maxInputTokens
    ? Math.min(options.maxInputTokens * 4, 64000)
    : DEFAULT_MAX_UNIFIED_PROMPT_CHARS;

  // 1. Format Target Code Snippet
  const codeLines = req.selectedCode.split(/\r?\n/);
  const numberedSnippet = codeLines
    .map((line, idx) => `${req.startLine + idx}: ${line}`)
    .join('\n');

  // 2. Format Active Diagnostics
  let diagnosticsSection = 'No active compiler or linter diagnostics detected for this file.';
  if (diagnostics && diagnostics.length > 0) {
    diagnosticsSection = diagnostics
      .map((d, i) => {
        const overlap = d.overlapsSelection ? ' [OVERLAPS SELECTION]' : '';
        const src = d.source ? ` (${d.source}${d.code ? `:${d.code}` : ''})` : '';
        return `[Diagnostic #${i + 1}] ${d.severity.toUpperCase()}${src} at L${d.range.startLine}:${d.range.startCharacter}-L${d.range.endLine}:${d.range.endCharacter}${overlap}\n  Message: ${d.message}`;
      })
      .join('\n\n');
  }

  // 3. Format Working Tree Status
  let workingTreeSection = 'Working tree clean for this file (no uncommitted local modifications).';
  if (evidence.isWorkingTreeModified) {
    const diffText = evidence.workingTreeDiff
      ? (evidence.workingTreeDiff.length > 2500 ? evidence.workingTreeDiff.substring(0, 2500) + '\n... [diff truncated]' : evidence.workingTreeDiff)
      : '(Diff content unavailable)';
    workingTreeSection = `This file has uncommitted local modifications in the working tree:\n\`\`\`diff\n${diffText}\n\`\`\``;
  }

  // 4. Format Git History & Line Blame
  let gitHistorySection = 'No commit history found for these lines.';
  if (history && history.commits && history.commits.length > 0) {
    gitHistorySection = history.commits
      .map((c: any, i: number) => {
        let diffSnippet = '';
        if (c.diff) {
          const boundedDiff = c.diff.length > 2000 ? c.diff.substring(0, 2000) + '\n... [diff truncated]' : c.diff;
          diffSnippet = `\nDiff:\n\`\`\`diff\n${boundedDiff}\n\`\`\``;
        }
        const fullHash = c.hash || c.fullHash || c.shortHash;
        return `[Commit #${i + 1}] Hash: ${fullHash} (${c.shortHash})\nAuthor: ${c.authorName} <${c.authorEmail}>\nDate: ${c.date}\nSubject: ${c.subject}\nBody: ${c.body || '(no body)'}${diffSnippet}`;
      })
      .join('\n\n---\n\n');
  }

  // 5. Format Neo4j Knowledge Graph History & Co-Changes
  let neo4jSection = 'Neo4j knowledge graph evidence offline or not configured.';
  if (evidence.neo4jStatus === 'ok') {
    const graphCommitsText = neo4jCommits && neo4jCommits.length > 0
      ? `Historical Graph Commits (${neo4jCommits.length}):\n` +
        neo4jCommits.slice(0, 5).map((c: any) => `• ${c.shortHash}: ${c.subject} (${c.authorName || c.author || 'Unknown'}, ${c.committedAt || c.date || 'Unknown'}) [Change: ${c.changeType}]`).join('\n')
      : 'No historical graph commits found in Neo4j for this file.';

    neo4jSection = graphCommitsText;
  }
  const coChangeSource = evidence.localGitCoChanges !== undefined ? 'local Git' : 'Neo4j';
  const coChangesText = coChanges.length ? coChanges.slice(0, 6).map(co => {
    const status = co.isCurrentlyChanged ? '[CURRENTLY MODIFIED]' : '[NO WORKING TREE CHANGE REPORTED]';
    const hashes = co.sampleCommitHashes.slice(0, 3).join(', ');
    return `• ${co.filePath} ${status}: ${co.sharedCommitCount} shared commit(s)${hashes ? ' (' + hashes + ')' : ''}`;
  }).join('\n') : 'No historical co-changes retrieved.';

  const basePrompt = `You are GitWhisper by ORIGINX — a unified, evidence-grounded code intelligence system.
Product direction: Code Continuity. Help a developer understand and continue unfinished work.

Analyze the selected code and produce a single comprehensive, high-signal report combining:
1) Code functionality (What it does)
2) Historical reasons for change (Git & Neo4j evolution)
3) Current diagnostics and potential issues (Strictly grounded; do not invent bugs if none exist)
4) Related files & blast radius impact
5) Suggested improvements or minimal fix (when justified, always labeled [UNVERIFIED - SUGGESTED FIX])
6) Supporting evidence (real commit hashes)
7) Uncertainties and limitations

CRITICAL RULES:
- STRICT FACTUALITY: Ground your analysis strictly in the provided code, diagnostics, Git diffs, and Neo4j evidence. Never invent commit hashes, non-existent files, or hallucinated reasons.
- NO FABRICATED BUGS: If there are NO active diagnostics and the user has not reported an error, explicitly state that no diagnostics or bugs were detected. Do NOT invent phantom bugs.
- UNVERIFIED SUGGESTED FIX: Any fix or improvement you propose is an ADVISORY SUGGESTION and MUST be labeled with [UNVERIFIED - SUGGESTED FIX]. You are an advisory tool, not an autonomous agent.
- DISTINGUISH FACTS FROM HYPOTHESES: Clearly separate observed facts from AI reasoning.
- Historical co-changes establish shared commits. A dependency or predicted failure needs independent evidence in the supplied code or diagnostics.

=== TARGET CODE SELECTION ===
Repository: ${req.repoName} (${req.repoId})
File: ${req.filePath}
Lines: ${req.startLine} to ${req.endLine}
Code:
\`\`\`
${numberedSnippet}
\`\`\`

=== ACTIVE VS CODE DIAGNOSTICS ===
${diagnosticsSection}

=== WORKING TREE STATUS FOR THIS FILE ===
${workingTreeSection}

=== LOCAL GIT LINE HISTORY & DIFFS ===
${gitHistorySection}

=== NEO4J KNOWLEDGE GRAPH EVIDENCE ===
${neo4jSection}

=== HISTORICALLY CO-CHANGED FILES (${coChangeSource}) ===
${coChangesText}

=== REQUIRED RESPONSE FORMAT ===
You must respond using EXACTLY these 7 Markdown section headers:

## 1. WHAT THIS CODE DOES
(Clear, concise explanation of the code's purpose and functionality.)

## 2. HISTORICAL EVOLUTION & WHY IT CHANGED
(Explain why these lines were modified historically based on the provided Git and Neo4j commits and diffs.)

## 3. DIAGNOSTICS & POTENTIAL ISSUES
(Discuss active compiler/linter diagnostics. If there are NO issues detected, explicitly state: "No compiler diagnostics or reported bugs detected for this selection.")

## 4. RELATED FILES & IMPACT ANALYSIS
(List companions with the supporting shared commits. Label possible effects as hypotheses and cite code evidence for any direct dependency.)

## 5. SUGGESTIONS & FIXES
(If an issue exists or a clean defensive improvement is justified, provide a minimal patch labeled [UNVERIFIED - SUGGESTED FIX] and explanation. If code is already clean, state: "No code changes required.")

## 6. SUPPORTING EVIDENCE
(List the exact Git commit hashes and Neo4j graph records that back your reasoning.)

## 7. UNCERTAINTIES & LIMITATIONS
(State any boundaries of static analysis or missing runtime context.)`;

  if (basePrompt.length > maxChars) {
    return basePrompt.substring(0, maxChars) + '\n\n... [Prompt bounded for safety]';
  }
  return basePrompt;
}

/**
 * Parses the raw AI response into structured unified analysis sections with safe defaults.
 */
export function parseUnifiedExplanation(
  rawText: string,
  modelName?: string
): UnifiedAnalysisExplanation {
  if (!rawText || !rawText.trim()) {
    return createDefaultUnifiedExplanation('Empty response returned from language model.', modelName);
  }

  const sections: { [key: number]: string } = {};

  const sectionHeaders = [
    { num: 1, pattern: /##\s*1\.\s*WHAT\s*THIS\s*CODE\s*DOES/i },
    { num: 2, pattern: /##\s*2\.\s*HISTORICAL\s*EVOLUTION\s*(?:&|AND)?\s*WHY\s*IT\s*CHANGED/i },
    { num: 3, pattern: /##\s*3\.\s*DIAGNOSTICS\s*(?:&|AND)?\s*POTENTIAL\s*ISSUES/i },
    { num: 4, pattern: /##\s*4\.\s*RELATED\s*FILES\s*(?:&|AND)?\s*IMPACT\s*ANALYSIS/i },
    { num: 5, pattern: /##\s*5\.\s*SUGGESTIONS\s*(?:&|AND)?\s*FIXES/i },
    { num: 6, pattern: /##\s*6\.\s*SUPPORTING\s*EVIDENCE/i },
    { num: 7, pattern: /##\s*7\.\s*UNCERTAINTIES\s*(?:&|AND)?\s*LIMITATIONS/i }
  ];

  const positions: Array<{ num: number; index: number; headerLength: number }> = [];

  for (const h of sectionHeaders) {
    const match = h.pattern.exec(rawText);
    if (match) {
      positions.push({
        num: h.num,
        index: match.index,
        headerLength: match[0].length
      });
    }
  }

  positions.sort((a, b) => a.index - b.index);

  for (let i = 0; i < positions.length; i++) {
    const curr = positions[i];
    const startIndex = curr.index + curr.headerLength;
    const endIndex = i + 1 < positions.length ? positions[i + 1].index : rawText.length;
    sections[curr.num] = rawText.substring(startIndex, endIndex).trim();
  }

  // 1. What This Code Does
  const whatCodeDoes = sections[1] || 'Code selection analyzed without specific description extracted.';

  // 2. Historical Evolution
  const whyChangedHistorically = sections[2] || 'Local Git commit history was analyzed for this code selection.';

  // 3. Diagnostics & Potential Issues
  const diagText = sections[3] || '';
  const hasNoIssuesMentioned = /no\s+(?:compiler\s+)?diagnostics|no\s+(?:reported\s+)?bugs|clean|no\s+issues\s+detected/i.test(diagText);
  const diagItems = extractListItems(diagText, []);
  const diagnosticsAndIssues = {
    hasIssues: !hasNoIssuesMentioned && diagItems.length > 0,
    summary: diagText || 'No active diagnostics or bugs detected for this selection.',
    details: diagItems
  };

  // 4. Related Files & Impact
  const relatedFilesAndImpact = extractRelatedFiles(sections[4]);

  // 5. Suggestions & Fixes
  const suggestedImprovementsOrFixes = extractSuggestedFix(sections[5]);

  // 6. Supporting Evidence
  const supportingEvidence = extractListItems(sections[6], ['Local Git blame commits']);

  // 7. Uncertainties & Limitations
  const uncertaintiesAndLimitations = extractListItems(sections[7], [
    'Static analysis only: runtime behavior depends on dynamic environment and inputs.'
  ]);

  return {
    whatCodeDoes,
    whyChangedHistorically,
    diagnosticsAndIssues,
    relatedFilesAndImpact,
    suggestedImprovementsOrFixes,
    supportingEvidence,
    uncertaintiesAndLimitations,
    model: modelName
  };
}

function extractListItems(text: string | undefined, defaultList: string[]): string[] {
  if (!text || !text.trim()) return defaultList;

  const lines = text.split(/\r?\n/);
  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(?:[-*+]|\d+[\.\)])\s+(.*)$/);
    if (match && match[1].trim()) {
      items.push(match[1].trim());
    } else if (items.length > 0 && !trimmed.startsWith('#')) {
      items[items.length - 1] += ' ' + trimmed;
    } else if (items.length === 0 && !trimmed.startsWith('#')) {
      items.push(trimmed);
    }
  }

  return items.length > 0 ? items : defaultList;
}

function extractRelatedFiles(text: string | undefined): Array<{ filePath: string; reason: string }> {
  if (!text || !text.trim()) return [];

  const items = extractListItems(text, []);
  const result: Array<{ filePath: string; reason: string }> = [];

  for (const item of items) {
    const match = item.match(/(?:`|\*\*)?([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+)(?:`|\*\*)?\s*[-:]\s*(.*)/);
    if (match) {
      result.push({
        filePath: match[1].trim().replace(/\\/g, '/'),
        reason: match[2].trim()
      });
    } else {
      result.push({
        filePath: item.split(/[\s:]/)[0] || 'Companion File',
        reason: item
      });
    }
  }

  return result;
}

function extractSuggestedFix(text: string | undefined): UnifiedSuggestedFix | undefined {
  if (!text || !text.trim()) return undefined;

  const lower = text.toLowerCase();
  if (lower.includes('no code changes required') || lower.includes('no fix required') || lower.includes('already clean')) {
    return undefined;
  }

  let code = '';
  let explanation = '';

  const codeMatch = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (codeMatch) {
    code = codeMatch[1].trim();
    explanation = text.replace(codeMatch[0], '').trim();
  } else {
    code = text.trim();
    explanation = 'Defensive improvement based on static code analysis.';
  }

  if (!code.includes('[UNVERIFIED - SUGGESTED FIX]')) {
    code = `// [UNVERIFIED - SUGGESTED FIX]\n${code}`;
  }

  return {
    code,
    explanation: explanation || 'Advisory suggested patch. Review and test before applying.',
    isVerified: false
  };
}

function createDefaultUnifiedExplanation(reason: string, modelName?: string): UnifiedAnalysisExplanation {
  return {
    whatCodeDoes: `Code selection analyzed without AI synthesis: ${reason}`,
    whyChangedHistorically: 'Local Git history and commits are available for inspection below.',
    diagnosticsAndIssues: {
      hasIssues: false,
      summary: 'No active compiler diagnostics reported.',
      details: []
    },
    relatedFilesAndImpact: [],
    supportingEvidence: ['Local Git repository blame history'],
    uncertaintiesAndLimitations: ['Language model synthesis was unavailable; showing grounded local evidence.'],
    model: modelName
  };
}
