import {
  InvestigationEvidencePackage,
  InvestigationExplanation,
  MinimalSuggestedFix
} from './investigationTypes';

export const DEFAULT_MAX_INVESTIGATION_PROMPT_CHARS = 36000;

/**
 * Builds a structured, evidence-grounded prompt for investigating bugs
 * combining selected code, active VS Code diagnostics, Git line history, and Neo4j co-change companion files.
 */
export function buildInvestigationPrompt(
  evidence: InvestigationEvidencePackage,
  options?: {
    maxInputTokens?: number;
  }
): string {
  const req = evidence.request;
  const history = evidence.gitHistory;
  const diagnostics = evidence.diagnostics;
  const coChanges = evidence.coChangeEvidence;

  const maxChars = options?.maxInputTokens
    ? Math.min(options.maxInputTokens * 4, 60000)
    : DEFAULT_MAX_INVESTIGATION_PROMPT_CHARS;

  // 1. Format Active Diagnostics
  let diagnosticsSection = 'No active compiler or linter diagnostics detected for this file.';
  if (diagnostics && diagnostics.length > 0) {
    diagnosticsSection = diagnostics
      .map((d, i) => {
        const overlapNotice = d.overlapsSelection ? ' [OVERLAPS SELECTION]' : '';
        const src = d.source ? ` (${d.source}${d.code ? `:${d.code}` : ''})` : '';
        return `[Diag #${i + 1}] ${d.severity.toUpperCase()}${src} at L${d.range.startLine}:${d.range.startCharacter}-L${d.range.endLine}:${d.range.endCharacter}${overlapNotice}\n  Message: ${d.message}`;
      })
      .join('\n\n');
  }

  // 2. Format Git History for the Selection
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

  // 3. Format Neo4j Historical Co-Change Evidence (Blast Radius)
  let coChangeSection = 'No Neo4j co-change evidence available (offline, disabled, or no shared commits recorded).';
  if (evidence.neo4jStatus === 'ok' && coChanges && coChanges.length > 0) {
    coChangeSection = coChanges
      .slice(0, 8)
      .map((co, i) => {
        const hashes = co.sampleCommitHashes.length > 0 ? ` (Commits: ${co.sampleCommitHashes.slice(0, 3).join(', ')})` : '';
        const coupling = co.isCurrentlyChanged ? ' [ALSO MODIFIED IN CURRENT WORKING TREE]' : ' [UNTOUCHED COMPANION]';
        return `[Co-Change #${i + 1}] ${co.filePath}${coupling}\n  Shared Commits: ${co.sharedCommitCount}${hashes}\n  Coupled with: ${co.historicallyCoupledWith.join(', ')}`;
      })
      .join('\n\n');
  }

  // 4. User-provided error symptom
  const userErrorSection = req.userErrorMessage && req.userErrorMessage.trim()
    ? req.userErrorMessage.trim()
    : '(None provided by user)';

  // 5. Code snippet with line numbering
  const codeLines = req.selectedCode.split(/\r?\n/);
  const numberedSnippet = codeLines
    .map((line, idx) => `${req.startLine + idx}: ${line}`)
    .join('\n');

  const basePrompt = `You are GitWhisper by ORIGINX — an evidence-grounded bug investigation assistant.
Product Direction: "Understand the change. Trace the impact. Fix with context."

You are analyzing a target code region where a bug, diagnostic error, or regression was reported.
You must synthesize:
1) The current code snippet and its active compiler/linter diagnostics.
2) The developer's reported error symptom.
3) Git line evolution and diffs showing how and when these lines last changed.
4) Neo4j co-change companion files showing historically coupled modules.

CRITICAL RULES:
- STRICT GROUNDING: Base your observations only on the provided code, diagnostics, Git history, and Neo4j evidence. Never invent commit hashes, non-existent files, or hallucinated reasons.
- UNVERIFIED FIX ONLY: Any minimal fix you propose is an ADVISORY SUGGESTION. You are NOT an autonomous coding agent; you must clearly label the fix as [UNVERIFIED - SUGGESTED FIX] and state why it requires developer verification.
- CAUSAL REASONING: Explain how past commits or coupled companion files may have caused this issue.

=== TARGET CODE SELECTION ===
Repository: ${req.repoName} (${req.repoId})
File: ${req.filePath}
Lines: ${req.startLine} to ${req.endLine}
Code:
\`\`\`
${numberedSnippet}
\`\`\`

=== DEVELOPER ERROR / SYMPTOM ===
${userErrorSection}

=== ACTIVE VS CODE DIAGNOSTICS ===
${diagnosticsSection}

=== LOCAL GIT LINE HISTORY & DIFFS ===
${gitHistorySection}

=== NEO4J HISTORICAL CO-CHANGE EVIDENCE ===
${coChangeSection}

=== REQUIRED RESPONSE FORMAT ===
You must respond using EXACTLY these 7 Markdown section headers:

## 1. OBSERVED FACTS
(State the code behavior, line range, active diagnostics, and the Git commit(s) that last modified these lines.)

## 2. PLAUSIBLE ROOT-CAUSE HYPOTHESES
(List 1 to 3 concrete, grounded hypotheses explaining what might be wrong, referencing line numbers, diagnostics, or commit diffs.)

## 3. RELATED FILES WORTH INSPECTING
(List specific companion files from Neo4j co-changes or import dependencies that may need corresponding updates or may be the root cause.)

## 4. PROPOSED INVESTIGATION STEPS
(Provide concrete, actionable diagnostic steps for the developer: breakpoints to set, logs to inspect, variables to check.)

## 5. MINIMAL SUGGESTED FIX
(A minimal, defensive code patch. MUST be explicitly labeled with: [UNVERIFIED - SUGGESTED FIX] followed by a short explanation of the change and what assumptions it makes.)

## 6. RELEVANT TESTS TO RUN
(Specific unit tests, edge-case test cases, or test scripts to run to confirm the bug and verify any fix.)

## 7. UNCERTAINTIES & LIMITATIONS
(State clearly what cannot be determined without runtime logs, reproduction steps, or missing graph evidence.)`;

  if (basePrompt.length > maxChars) {
    return basePrompt.substring(0, maxChars) + '\n\n... [Prompt bounded for safety]';
  }
  return basePrompt;
}

/**
 * Parses the raw AI response into structured investigation sections with safe defaults.
 */
export function parseInvestigationExplanation(
  rawText: string,
  modelName?: string
): InvestigationExplanation {
  if (!rawText || !rawText.trim()) {
    return createDefaultInvestigationExplanation('Empty response returned from language model.', modelName);
  }

  const sections: { [key: number]: string } = {};

  const sectionHeaders = [
    { num: 1, pattern: /##\s*1\.\s*OBSERVED\s*FACTS/i },
    { num: 2, pattern: /##\s*2\.\s*PLAUSIBLE\s*ROOT-?CAUSE\s*HYPOTHESES/i },
    { num: 3, pattern: /##\s*3\.\s*RELATED\s*FILES\s*WORTH\s*INSPECTING/i },
    { num: 4, pattern: /##\s*4\.\s*PROPOSED\s*INVESTIGATION\s*STEPS/i },
    { num: 5, pattern: /##\s*5\.\s*MINIMAL\s*SUGGESTED\s*FIX/i },
    { num: 6, pattern: /##\s*6\.\s*RELEVANT\s*TESTS\s*TO\s*RUN/i },
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

  // 1. Observed Facts
  const observedFacts = sections[1] || 'Code selection analyzed without specific observed facts extracted.';

  // 2. Root Cause Hypotheses
  const rootCauseHypotheses = extractListItems(sections[2], [
    'Potential logic inconsistency or unhandled edge case in selection.',
    'Recent Git changes on this line may have introduced a regression.'
  ]);

  // 3. Related Files
  const relatedFiles = extractRelatedFiles(sections[3]);

  // 4. Investigation Steps
  const investigationSteps = extractListItems(sections[4], [
    'Inspect active compiler diagnostics in Problems panel.',
    'Set a breakpoint on the target line and inspect local variables at runtime.'
  ]);

  // 5. Minimal Suggested Fix
  const minimalSuggestedFix = extractSuggestedFix(sections[5]);

  // 6. Relevant Tests
  const relevantTests = extractListItems(sections[6], [
    'Run existing test suite to check for regressions.',
    'Add an edge-case test covering the reported symptom.'
  ]);

  // 7. Uncertainties
  const uncertainties = extractListItems(sections[7], [
    'Static analysis only: runtime execution path and variable values cannot be confirmed without reproduction.'
  ]);

  return {
    observedFacts,
    rootCauseHypotheses,
    relatedFiles,
    investigationSteps,
    minimalSuggestedFix,
    relevantTests,
    uncertainties,
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
    // Match Markdown bullet points: -, *, +, or numbered: 1., 2)
    const match = trimmed.match(/^(?:[-*+]|\d+[\.\)])\s+(.*)$/);
    if (match && match[1].trim()) {
      items.push(match[1].trim());
    } else if (items.length > 0 && !trimmed.startsWith('#')) {
      // Continuation of previous item
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
    // Look for format like: `path/to/file.ts`: reason or **path/to/file.ts** - reason
    const match = item.match(/(?:`|\*\*)?([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+)(?:`|\*\*)?\s*[-:]\s*(.*)/);
    if (match) {
      result.push({
        filePath: match[1].trim().replace(/\\/g, '/'),
        reason: match[2].trim()
      });
    } else {
      // Just take the item if it looks like a file path or description
      result.push({
        filePath: item.split(/[\s:]/)[0] || 'Companion File',
        reason: item
      });
    }
  }

  return result;
}

function extractSuggestedFix(text: string | undefined): MinimalSuggestedFix {
  if (!text || !text.trim()) {
    return {
      code: '// [UNVERIFIED - SUGGESTED FIX]\n// No minimal fix suggested. Review the observed facts and investigation steps.',
      explanation: 'No automated patch generated. Please verify the code manually.',
      isVerified: false
    };
  }

  let code = '';
  let explanation = '';

  const codeMatch = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (codeMatch) {
    code = codeMatch[1].trim();
    // Explanation is text before or after code block
    explanation = text.replace(codeMatch[0], '').trim();
  } else {
    code = text.trim();
    explanation = 'Review the suggested patch carefully before applying.';
  }

  // Prepend verification warning if not present in code
  if (!code.includes('[UNVERIFIED - SUGGESTED FIX]')) {
    code = `// [UNVERIFIED - SUGGESTED FIX]\n${code}`;
  }

  if (!explanation) {
    explanation = 'Minimal defensive fix suggestion based on static analysis and Git history.';
  }

  return {
    code,
    explanation,
    isVerified: false
  };
}

function createDefaultInvestigationExplanation(reason: string, modelName?: string): InvestigationExplanation {
  return {
    observedFacts: `Unable to generate AI investigation analysis: ${reason}`,
    rootCauseHypotheses: ['Static Git history and active compiler diagnostics are available for manual inspection.'],
    relatedFiles: [],
    investigationSteps: [
      'Check the Problems panel for compiler/linter error details.',
      'Review recent Git commits on the target line using Git Blame.',
      'Reproduce the issue locally with a minimal failing test.'
    ],
    minimalSuggestedFix: {
      code: '// [UNVERIFIED - SUGGESTED FIX]\n// Automatic fix unavailable. Manually review compiler diagnostics and Git history.',
      explanation: 'No AI model response was received to generate a patch.',
      isVerified: false
    },
    relevantTests: ['Run the workspace test suite to verify current test status.'],
    uncertainties: ['AI reasoning unavailable. Review local Git and diagnostic evidence directly.'],
    model: modelName
  };
}
