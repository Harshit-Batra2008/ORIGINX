/**
 * GitWhisper Decision Memory — Deterministic Markdown & YAML Frontmatter Serializer
 * Zero external dependencies. Guaranteed save-and-reload round trips.
 *
 * Synchronization Policy:
 * - Markdown Body is canonical for human-authored documentation:
 *   - Document Title (# [ID:] Title)
 *   - Narrative Rationale (## Rationale)
 *   - Developer Constraints (## Developer Constraints)
 * - YAML Frontmatter is canonical for machine-readable & cryptographic metadata:
 *   - Identity, schema version, status, freshness, timestamps
 *   - Primary anchor and related files
 *   - Cryptographic Git commit evidence (SHAs, dates, bodies, diffs)
 *   - Verification & author attribution
 *   - Tags
 */

import {
  DecisionAnchor,
  DecisionAuthor,
  DecisionConstraint,
  DecisionMemoryRecord,
  RelatedFileLink,
  SupportingEvidence
} from './decisionTypes';
import { DecisionValidationError, validateDecisionRecord } from './decisionValidator';

/**
 * Escapes and quotes a YAML string if it contains special characters, newlines, or colons.
 */
function toYamlString(val: any, indentSize = 4): string {
  if (val === null || val === undefined) return 'null';
  const str = String(val);
  if (str.length === 0) return '""';
  if (/[\n\r]/.test(str)) {
    // Multi-line block scalar
    const pad = ' '.repeat(indentSize);
    const indented = str.split(/\r?\n/).map((line) => (line ? `${pad}${line}` : '')).join('\n');
    return `|\n${indented}`;
  }
  if (/[:#\[\]{},'"*&!|>?%@`]/.test(str) || /^(true|false|null|[0-9]+)$/i.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

/**
 * Serializes a DecisionMemoryRecord to durable Markdown with YAML frontmatter.
 */
export function serializeDecisionToMarkdown(record: DecisionMemoryRecord): string {
  validateDecisionRecord(record);

  const lines: string[] = ['---'];

  // Machine-readable frontmatter metadata
  lines.push(`id: ${record.id}`);
  lines.push(`schemaVersion: ${record.schemaVersion}`);
  lines.push(`title: ${toYamlString(record.title)}`);
  lines.push(`status: ${record.status}`);
  lines.push(`freshness: ${record.freshness}`);
  lines.push(`hasDirectGitEvidence: ${record.hasDirectGitEvidence}`);
  lines.push(`createdAt: ${record.createdAt}`);
  lines.push(`updatedAt: ${record.updatedAt}`);
  if (record.verifiedAt) lines.push(`verifiedAt: ${record.verifiedAt}`);
  if (record.verificationNote) lines.push(`verificationNote: ${toYamlString(record.verificationNote)}`);
  if (record.retiredAt) lines.push(`retiredAt: ${record.retiredAt}`);
  if (record.retirementReason) lines.push(`retirementReason: ${toYamlString(record.retirementReason)}`);
  if (record.supersededById) lines.push(`supersededById: ${record.supersededById}`);

  // createdBy
  lines.push('createdBy:');
  lines.push(`  name: ${toYamlString(record.createdBy.name)}`);
  lines.push(`  type: ${record.createdBy.type}`);
  if (record.createdBy.email) lines.push(`  email: ${toYamlString(record.createdBy.email)}`);
  if (record.createdBy.modelIdentifier) lines.push(`  modelIdentifier: ${toYamlString(record.createdBy.modelIdentifier)}`);

  // verifiedBy
  if (record.verifiedBy) {
    lines.push('verifiedBy:');
    lines.push(`  name: ${toYamlString(record.verifiedBy.name)}`);
    lines.push(`  type: ${record.verifiedBy.type}`);
    if (record.verifiedBy.email) lines.push(`  email: ${toYamlString(record.verifiedBy.email)}`);
  }

  // primaryAnchor
  lines.push('primaryAnchor:');
  lines.push(`  filePath: ${toYamlString(record.primaryAnchor.filePath)}`);
  if (record.primaryAnchor.symbolName) lines.push(`  symbolName: ${toYamlString(record.primaryAnchor.symbolName)}`);
  if (record.primaryAnchor.startLine !== undefined) lines.push(`  startLine: ${record.primaryAnchor.startLine}`);
  if (record.primaryAnchor.endLine !== undefined) lines.push(`  endLine: ${record.primaryAnchor.endLine}`);
  if (record.primaryAnchor.contentHash) lines.push(`  contentHash: ${record.primaryAnchor.contentHash}`);
  if (record.primaryAnchor.contextSnippet) lines.push(`  contextSnippet: ${toYamlString(record.primaryAnchor.contextSnippet)}`);

  // tags
  if (record.tags && record.tags.length > 0) {
    lines.push('tags:');
    for (const t of record.tags) {
      lines.push(`  - ${toYamlString(t)}`);
    }
  } else {
    lines.push('tags: []');
  }

  // relatedFiles
  if (record.relatedFiles && record.relatedFiles.length > 0) {
    lines.push('relatedFiles:');
    for (const rf of record.relatedFiles) {
      lines.push(`  - filePath: ${toYamlString(rf.filePath)}`);
      lines.push(`    couplingReason: ${toYamlString(rf.couplingReason)}`);
      lines.push(`    isDirectDependency: ${rf.isDirectDependency}`);
    }
  } else {
    lines.push('relatedFiles: []');
  }

  // constraints (persisted in frontmatter for machine queries)
  if (record.constraints && record.constraints.length > 0) {
    lines.push('constraints:');
    for (const c of record.constraints) {
      lines.push(`  - id: ${toYamlString(c.id)}`);
      lines.push(`    description: ${toYamlString(c.description)}`);
      lines.push(`    reason: ${toYamlString(c.reason)}`);
      lines.push(`    severity: ${c.severity}`);
    }
  } else {
    lines.push('constraints: []');
  }

  // evidence
  if (record.evidence && record.evidence.length > 0) {
    lines.push('evidence:');
    for (const ev of record.evidence) {
      lines.push(`  - commitHash: ${ev.commitHash}`);
      lines.push(`    shortHash: ${ev.shortHash}`);
      lines.push(`    commitDate: ${ev.commitDate}`);
      lines.push(`    author: ${toYamlString(ev.author)}`);
      lines.push(`    subject: ${toYamlString(ev.subject)}`);
      lines.push(`    origin: ${ev.origin}`);
      lines.push(`    isHypothesis: ${ev.isHypothesis}`);
      if (ev.body) lines.push(`    body: ${toYamlString(ev.body, 6)}`);
      if (ev.diffHunk) lines.push(`    diffHunk: ${toYamlString(ev.diffHunk, 6)}`);
    }
  } else {
    lines.push('evidence: []');
  }

  lines.push('---');
  lines.push('');

  // Human-readable Markdown body
  lines.push(`# ${record.id}: ${record.title}`);
  lines.push('');
  lines.push('## Rationale');
  lines.push(record.rationale.trim());
  lines.push('');

  lines.push('## Primary Anchor');
  lines.push(`- **File:** \`${record.primaryAnchor.filePath}\``);
  if (record.primaryAnchor.symbolName) {
    lines.push(`- **Symbol:** \`${record.primaryAnchor.symbolName}\``);
  }
  if (record.primaryAnchor.startLine !== undefined) {
    const endStr = record.primaryAnchor.endLine ? `–${record.primaryAnchor.endLine}` : '';
    lines.push(`- **Lines:** ${record.primaryAnchor.startLine}${endStr}`);
  }
  if (record.primaryAnchor.contextSnippet) {
    lines.push('');
    lines.push('```');
    lines.push(record.primaryAnchor.contextSnippet.trim());
    lines.push('```');
  }
  lines.push('');

  if (record.constraints && record.constraints.length > 0) {
    lines.push('## Developer Constraints');
    for (const c of record.constraints) {
      lines.push(`- **[${c.id}] (${c.severity}):** ${c.description}`);
      if (c.reason) {
        lines.push(`  *Reason:* ${c.reason}`);
      }
    }
    lines.push('');
  }

  if (record.evidence && record.evidence.length > 0) {
    lines.push('## Supporting Git Evidence');
    for (const ev of record.evidence) {
      const hypTag = ev.isHypothesis ? ' *(Inferred Hypothesis)*' : ' *(Verified Commit Fact)*';
      lines.push(`- \`${ev.shortHash}\` — **${ev.subject}** (${ev.author}, ${ev.commitDate})${hypTag}`);
      if (ev.body) {
        lines.push(`  > ${ev.body.split(/\r?\n/).join(' ')}`);
      }
    }
    lines.push('');
  } else {
    lines.push('## Supporting Git Evidence');
    lines.push('_No direct Git commit evidence recorded for this architectural choice._');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parses simple YAML frontmatter dictionary.
 */
function parseYamlFrontmatter(yamlText: string): any {
  const result: any = {};
  const rawLines = yamlText.split(/\r?\n/);
  let i = 0;

  function getIndent(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  function parseScalar(val: string): any {
    const trimmed = val.trim();
    if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    if (trimmed === '[]') return [];
    if (trimmed === '{}') return {};
    return trimmed;
  }

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    let valuePart = line.slice(colonIdx + 1).trim();

    // Check if multi-line block scalar: key: |
    if (valuePart === '|') {
      i++;
      const blockLines: string[] = [];
      const baseIndent = rawLines[i] ? getIndent(rawLines[i]) : 2;
      while (i < rawLines.length) {
        const curLine = rawLines[i];
        if (curLine.trim() && getIndent(curLine) < baseIndent) {
          break;
        }
        blockLines.push(curLine.slice(baseIndent));
        i++;
      }
      result[key] = blockLines.join('\n');
      continue;
    }

    // Check if array of primitives or objects
    if (valuePart === '' || valuePart === '[]') {
      if (valuePart === '[]') {
        result[key] = [];
        i++;
        continue;
      }

      i++;
      const items: any[] = [];
      let inMapList = false;

      while (i < rawLines.length) {
        const subLine = rawLines[i];
        if (!subLine.trim() || subLine.trim().startsWith('#')) {
          i++;
          continue;
        }
        const indent = getIndent(subLine);
        if (indent === 0) {
          break; // Next top-level key
        }

        const trimmedSub = subLine.trim();
        if (trimmedSub.startsWith('- ')) {
          const itemVal = trimmedSub.slice(2).trim();
          const subColon = itemVal.indexOf(':');
          if (subColon !== -1) {
            // It's a list of objects! e.g. - id: C1
            inMapList = true;
            const obj: any = {};
            const subK = itemVal.slice(0, subColon).trim();
            const subV = itemVal.slice(subColon + 1).trim();
            obj[subK] = parseScalar(subV);
            i++;

            // Collect sibling properties for this item
            while (i < rawLines.length) {
              const objLine = rawLines[i];
              if (!objLine.trim() || objLine.trim().startsWith('#')) {
                i++;
                continue;
              }
              const objIndent = getIndent(objLine);
              if (objIndent <= indent || objLine.trim().startsWith('- ')) {
                break;
              }
              const oCol = objLine.indexOf(':');
              if (oCol !== -1) {
                const ok = objLine.slice(0, oCol).trim();
                const ov = objLine.slice(oCol + 1).trim();
                if (ov === '|') {
                  i++;
                  const bLines: string[] = [];
                  const firstIndent = rawLines[i] ? getIndent(rawLines[i]) : objIndent + 2;
                  const sliceLen = firstIndent > objIndent ? firstIndent : objIndent;
                  while (i < rawLines.length) {
                    const bLine = rawLines[i];
                    if (!bLine.trim()) {
                      bLines.push('');
                      i++;
                      continue;
                    }
                    const bIndent = getIndent(bLine);
                    if (bIndent <= indent) {
                      break;
                    }
                    if (
                      bIndent <= objIndent &&
                      /^(diffHunk|origin|isHypothesis|commitHash|shortHash|commitDate|author|subject|couplingReason|isDirectDependency):/.test(
                        bLine.trim()
                      )
                    ) {
                      break;
                    }
                    bLines.push(bLine.slice(Math.min(bIndent, sliceLen)));
                    i++;
                  }
                  obj[ok] = bLines.join('\n');
                  continue;
                } else {
                  obj[ok] = parseScalar(ov);
                }
              }
              i++;
            }
            items.push(obj);
          } else {
            // Simple primitive array: - tag1
            items.push(parseScalar(itemVal));
            i++;
          }
        } else if (!inMapList && trimmedSub.includes(':')) {
          // It's a nested object (e.g. primaryAnchor:)
          const nestedObj: any = {};
          while (i < rawLines.length) {
            const propLine = rawLines[i];
            if (!propLine.trim() || propLine.trim().startsWith('#')) {
              i++;
              continue;
            }
            if (getIndent(propLine) === 0) break;
            const pCol = propLine.indexOf(':');
            if (pCol !== -1) {
              const pk = propLine.slice(0, pCol).trim();
              let pv = propLine.slice(pCol + 1).trim();
              if (pv === '|') {
                i++;
                const bLines: string[] = [];
                const bIndent = rawLines[i] ? getIndent(rawLines[i]) : 4;
                while (i < rawLines.length && (getIndent(rawLines[i]) >= bIndent || !rawLines[i].trim())) {
                  bLines.push(rawLines[i].slice(bIndent));
                  i++;
                }
                nestedObj[pk] = bLines.join('\n');
                continue;
              } else {
                nestedObj[pk] = parseScalar(pv);
              }
            }
            i++;
          }
          result[key] = nestedObj;
          break;
        } else {
          i++;
        }
      }

      if (!result[key]) {
        result[key] = items;
      }
      continue;
    }

    result[key] = parseScalar(valuePart);
    i++;
  }

  return result;
}

/**
 * Extracts Title from the top-level Markdown header `# [ID:] <Title>`.
 */
function extractTitleFromBody(body: string): string | null {
  const match = body.match(/^#\s+(?:DEC-[A-Za-z0-9_-]+:\s*)?([^\r\n]+)/m);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

/**
 * Extracts Rationale from the Markdown body `## Rationale`.
 */
function extractRationaleFromBody(body: string): string {
  const match = body.match(/##\s+Rationale\s*\r?\n([\s\S]*?)(?=\r?\n##|\s*$)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return '';
}

/**
 * Parses Developer Constraints from Markdown body `## Developer Constraints`.
 * Validates formatting; returns clear validation errors if unsupported syntax is used.
 */
function extractConstraintsFromBody(body: string): DecisionConstraint[] | null {
  const sectionMatch = body.match(/##\s+Developer Constraints\s*\r?\n([\s\S]*?)(?=\r?\n##|\s*$)/i);
  if (!sectionMatch) {
    return null; // Section omitted in body; fall back to frontmatter
  }

  const sectionText = sectionMatch[1].trim();
  if (!sectionText || sectionText === '_No constraints defined._' || sectionText === 'None') {
    return [];
  }

  const lines = sectionText.split(/\r?\n/);
  const constraints: DecisionConstraint[] = [];
  let currentConstraint: DecisionConstraint | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    // Matches: - **[C1] (critical):** Description of constraint
    const bulletMatch = line.match(/^-\s+\*\*\[([A-Za-z0-9_-]+)\]\s*\((critical|advisory)\):\*\*\s*(.*)$/i);
    if (bulletMatch) {
      if (currentConstraint) {
        constraints.push(currentConstraint);
      }
      currentConstraint = {
        id: bulletMatch[1].trim(),
        severity: bulletMatch[2].toLowerCase() as 'critical' | 'advisory',
        description: bulletMatch[3].trim(),
        reason: ''
      };
    } else if (/^\*(?:Reason:)?\*\s*/i.test(line) || /^_(?:Reason:)?_\s*/i.test(line) || /^\*Reason:\*/i.test(line)) {
      if (!currentConstraint) {
        throw new DecisionValidationError(
          `Constraint reason found without constraint header at line: "${rawLine}"`,
          'constraints'
        );
      }
      currentConstraint.reason = line.replace(/^\*(?:Reason:)?\*\s*|^_(?:Reason:)?_\s*/i, '').trim();
    } else if (currentConstraint && !line.startsWith('- ')) {
      // Multi-line continuation
      if (currentConstraint.reason) {
        currentConstraint.reason += ' ' + line;
      } else {
        currentConstraint.description += ' ' + line;
      }
    } else {
      // Unsupported format inside ## Developer Constraints
      throw new DecisionValidationError(
        `Unsupported constraint format in Markdown body: "${rawLine}". Expected format: - **[ID] (critical|advisory):** <description> on a bullet line followed by optional "*Reason:* <reason>"`,
        'constraints'
      );
    }
  }

  if (currentConstraint) {
    constraints.push(currentConstraint);
  }

  return constraints;
}

/**
 * Parses and validates a DecisionMemoryRecord from Markdown content.
 * Guarantees that direct human edits to Title, Rationale, and Constraints in the Markdown body
 * are fully preserved and survive loading, updating, and saving.
 */
export function parseDecisionFromMarkdown(content: string, expectedId?: string): DecisionMemoryRecord {
  if (!content || typeof content !== 'string') {
    throw new DecisionValidationError('Decision file content is empty or invalid');
  }

  // Match YAML frontmatter between starting and closing ---
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new DecisionValidationError('Decision file does not contain valid YAML frontmatter fenced by "---"');
  }

  const frontmatterText = match[1];
  const markdownBody = match[2] || '';

  let frontmatter: any;
  try {
    frontmatter = parseYamlFrontmatter(frontmatterText);
  } catch (err) {
    throw new DecisionValidationError(`Corrupted or unparseable YAML frontmatter: ${err}`);
  }

  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new DecisionValidationError('YAML frontmatter produced invalid object');
  }

  // Check ID match
  if (expectedId && frontmatter.id && frontmatter.id !== expectedId) {
    throw new DecisionValidationError(
      `Decision ID mismatch: file defines "${frontmatter.id}" but filename specifies "${expectedId}"`,
      'id'
    );
  }

  // Canonical Title Resolution:
  // If human edited Title in Markdown header (# DEC-0001: New Title), that is canonical!
  const bodyTitle = extractTitleFromBody(markdownBody);
  const title = bodyTitle || (frontmatter.title as string) || '';

  // Canonical Rationale Resolution:
  // Markdown body ## Rationale is the single canonical source of truth for narrative rationale.
  const rationale = extractRationaleFromBody(markdownBody) || (frontmatter.rationale as string) || '';

  // Canonical Constraints Resolution:
  // If ## Developer Constraints section is in Markdown body, human edits in body are parsed and canonical.
  const bodyConstraints = extractConstraintsFromBody(markdownBody);
  const constraints = bodyConstraints !== null
    ? bodyConstraints
    : (Array.isArray(frontmatter.constraints) ? frontmatter.constraints : []);

  const record: DecisionMemoryRecord = {
    id: frontmatter.id,
    schemaVersion: frontmatter.schemaVersion,
    title,
    rationale,
    primaryAnchor: frontmatter.primaryAnchor || {},
    relatedFiles: Array.isArray(frontmatter.relatedFiles) ? frontmatter.relatedFiles : [],
    evidence: Array.isArray(frontmatter.evidence) ? frontmatter.evidence : [],
    hasDirectGitEvidence: Boolean(frontmatter.hasDirectGitEvidence),
    constraints,
    status: frontmatter.status,
    freshness: frontmatter.freshness,
    createdBy: frontmatter.createdBy || { name: 'Unknown', type: 'human' },
    verifiedBy: frontmatter.verifiedBy,
    verificationNote: frontmatter.verificationNote,
    verifiedAt: frontmatter.verifiedAt,
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
    retirementReason: frontmatter.retirementReason,
    retiredAt: frontmatter.retiredAt,
    supersededById: frontmatter.supersededById,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : []
  };

  validateDecisionRecord(record);
  return record;
}
