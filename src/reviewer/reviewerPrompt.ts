import { RelatedFileRecommendation, ReviewerExplanation, ReviewerFileChange } from './reviewerTypes';

export const REVIEWER_SYSTEM_INSTRUCTIONS = `You are GitWhisper Code Reviewer, an expert code review assistant in VS Code.
Analyze the provided working tree changes (staged, unstaged, and untracked files) alongside historical co-change evidence from Neo4j.

STRICT GROUNDING & EVIDENCE RULES:
1. ONLY describe changes explicitly present in the provided diffs. Never hallucinate code changes.
2. Ground all blast radius and impact observations in the retrieved Neo4j co-change history.
3. DO NOT label historical co-changes as confirmed defects, breaking changes, or vulnerabilities. Treat them objectively as companion files that frequently evolved together in past Git commits.
4. DO NOT invent or fabricate commit hashes. Only cite real hashes provided in the context.
5. If intent or context is unknown, state uncertainty explicitly instead of speculating.

OUTPUT FORMAT (Must use exactly these markdown headers):
## Review Summary
[Concise summary of changes across the working tree]

## Architectural Impact & Blast Radius
[Assessment of affected components, boundaries, and system impact]

## Related Files Worth Inspecting
[Objective evaluation of historically co-changed companion files from Neo4j, noting whether un-modified companion files warrant verification]

## Review Checklist
- [ ] [Specific verification action item 1]
- [ ] [Specific verification action item 2]

## Uncertainty & Limitations
[Explicit limitations regarding uncommitted changes or missing documentation]`;

/**
 * Builds the reviewer prompt containing changed files, diffs, and Neo4j co-change evidence.
 */
export function buildReviewerPrompt(
  changedFiles: ReviewerFileChange[],
  recommendations: RelatedFileRecommendation[],
  options?: { maxInputTokens?: number }
): string {
  const parts: string[] = [];

  parts.push(REVIEWER_SYSTEM_INSTRUCTIONS);
  parts.push('\n---\n### CURRENT WORKING TREE CHANGES\n');

  for (const file of changedFiles) {
    parts.push(`#### File: ${file.filePath} (Status: ${file.status.toUpperCase()})`);
    if (file.isBinary) {
      parts.push('`[Binary file changes - diff omitted]`\n');
    } else if (file.diff && file.diff.trim().length > 0) {
      parts.push('```diff');
      parts.push(file.diff);
      parts.push('```\n');
    } else {
      parts.push('*(No text diff available)*\n');
    }
  }

  if (recommendations && recommendations.length > 0) {
    parts.push('\n---\n### HISTORICAL CO-CHANGE EVIDENCE (NEO4J KNOWLEDGE GRAPH)\n');
    parts.push('The following files frequently co-changed with the modified files in previous Git commits:');

    for (const rec of recommendations.slice(0, 8)) {
      const statusLabel = rec.isCurrentlyChanged
        ? 'CURRENTLY INCLUDED IN THIS CHANGE'
        : 'NOT MODIFIED IN CURRENT WORKING TREE (WORTH INSPECTING)';
      const coupledStr = rec.historicallyCoupledWith.join(', ');
      const commitsStr = rec.sampleCommitHashes.length > 0
        ? ` (Supporting commits: ${rec.sampleCommitHashes.slice(0, 4).join(', ')})`
        : '';
      parts.push(`- **${rec.filePath}** [${statusLabel}]: Shared ${rec.sharedCommitCount} commit(s) with ${coupledStr}${commitsStr}`);
    }
  }

  parts.push('\n---\nPlease provide your structured code review now following the exact headers above.');
  return parts.join('\n');
}

/**
 * Parses the raw AI response into structured ReviewerExplanation fields.
 */
export function parseReviewerExplanation(
  raw: string,
  modelName: string = 'copilot'
): ReviewerExplanation {
  if (!raw || !raw.trim()) {
    return {
      summary: 'No review explanation provided.',
      impactAnalysis: 'No impact analysis available.',
      reviewChecklist: [],
      relatedFilesGuidance: 'No related files guidance available.',
      uncertaintyNotes: 'Uncommitted working tree changes; review generated without model output.',
      model: modelName
    };
  }

  const sections: Record<string, string> = {};
  const headerRegex = /^##\s+([^\r\n]+)$/gm;
  const matches: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = headerRegex.exec(raw)) !== null) {
    matches.push({ name: match[1].trim(), index: match.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const body = raw.substring(cur.index, nextIndex).replace(/^##\s+[^\r\n]+\r?\n/, '').trim();
    sections[cur.name.toLowerCase()] = body;
  }

  const findSection = (keywords: string[]): string => {
    for (const key of Object.keys(sections)) {
      if (keywords.some((kw) => key.includes(kw))) {
        return sections[key];
      }
    }
    return '';
  };

  const summary = findSection(['summary', 'overview']) || 'Working tree changes reviewed.';
  const impactAnalysis = findSection(['impact', 'blast radius', 'architectural']) || 'Changes affect modified files locally.';
  const relatedFilesGuidance = findSection(['related files', 'co-change', 'worth inspecting']) || 'No specific co-change concerns noted.';
  const uncertaintyNotes = findSection(['uncertainty', 'limitation']) || 'Working tree review based on available uncommitted diffs.';

  const checklistRaw = findSection(['checklist', 'action items', 'verification']);
  const reviewChecklist: string[] = [];

  if (checklistRaw) {
    const lines = checklistRaw.split(/\r?\n/);
    for (const l of lines) {
      const trimmed = l.trim();
      const cleaned = trimmed.replace(/^-\s*\[[ xX]?\]\s*/, '').replace(/^[-*•]\s*/, '').trim();
      if (cleaned.length > 0) {
        reviewChecklist.push(cleaned);
      }
    }
  }

  return {
    summary,
    impactAnalysis,
    reviewChecklist,
    relatedFilesGuidance,
    uncertaintyNotes,
    model: modelName
  };
}
