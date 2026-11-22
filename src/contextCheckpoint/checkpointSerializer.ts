/**
 * GitWhisper Context Checkpoint — Deterministic Markdown & YAML Frontmatter Serializer
 * Zero external dependencies. Guaranteed round-trip persistence and human-readable formatting.
 */

import {
  CheckpointCommitReference,
  CheckpointConstraint,
  CheckpointDeveloperIntent,
  CheckpointRepositoryContext,
  CheckpointTargetFile,
  CompletedWorkItem,
  ContextCheckpoint,
  UnfinishedTaskItem
} from './checkpointTypes';
import { CheckpointValidationError, validateCheckpointRecord } from './checkpointValidator';

function toYamlString(val: any, indentSize = 4): string {
  if (val === null || val === undefined) return 'null';
  const str = String(val);
  if (str.length === 0) return '""';
  if (/[\n\r]/.test(str)) {
    const pad = ' '.repeat(indentSize);
    const indented = str.split(/\r?\n/).map((line) => (line ? `${pad}${line}` : '')).join('\n');
    return `|\n${indented}`;
  }
  if (/[:#\[\]{},'"*&!|>?%@`]/.test(str) || /^(true|false|null|[0-9]+)$/i.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseScalar(val: string): any {
  if (val === undefined || val === null) return '';
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
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

/**
 * Lightweight, robust zero-dependency YAML frontmatter parser for Context Checkpoints.
 */
export function parseCheckpointYaml(yamlText: string): any {
  const rawLines = yamlText.split(/\r?\n/);
  const result: any = {};
  let i = 0;

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

    // Multiline top-level scalar: key: |
    if (valuePart === '|') {
      i++;
      const blockLines: string[] = [];
      const baseIndent = rawLines[i] ? getIndent(rawLines[i]) : 2;
      while (i < rawLines.length) {
        const curLine = rawLines[i];
        if (curLine.trim() && getIndent(curLine) < baseIndent) break;
        blockLines.push(curLine.slice(baseIndent));
        i++;
      }
      result[key] = blockLines.join('\n');
      continue;
    }

    // Array or nested object
    if (valuePart === '' || valuePart === '[]' || valuePart === '{}') {
      if (valuePart === '[]') {
        result[key] = [];
        i++;
        continue;
      }
      if (valuePart === '{}') {
        result[key] = {};
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
        if (indent === 0) break; // Next top-level key

        const trimmedSub = subLine.trim();
        if (trimmedSub.startsWith('- ')) {
          const itemVal = trimmedSub.slice(2).trim();
          const subColon = itemVal.indexOf(':');
          if (subColon !== -1) {
            inMapList = true;
            const obj: any = {};
            const subK = itemVal.slice(0, subColon).trim();
            const subV = itemVal.slice(subColon + 1).trim();
            obj[subK] = parseScalar(subV);
            i++;

            while (i < rawLines.length) {
              const objLine = rawLines[i];
              if (!objLine.trim() || objLine.trim().startsWith('#')) {
                i++;
                continue;
              }
              const objIndent = getIndent(objLine);
              if (objIndent <= indent && objLine.trim().startsWith('- ')) break;
              if (objIndent === 0) break;

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
                    if (bIndent <= indent) break;
                    if (bIndent <= objIndent && /^[A-Za-z0-9_-]+:/.test(bLine.trim())) break;
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
            items.push(parseScalar(itemVal));
            i++;
          }
        } else if (!inMapList && trimmedSub.includes(':')) {
          // Nested object (e.g. repository: or developerIntent:)
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
 * Serializes a ContextCheckpoint into a Markdown file with YAML frontmatter.
 */
export function serializeCheckpointToMarkdown(checkpoint: ContextCheckpoint): string {
  validateCheckpointRecord(checkpoint);

  const lines: string[] = ['---'];

  lines.push(`id: ${checkpoint.id}`);
  lines.push(`schemaVersion: ${checkpoint.schemaVersion}`);
  lines.push(`title: ${toYamlString(checkpoint.title)}`);
  lines.push(`createdAt: ${checkpoint.createdAt}`);
  lines.push(`updatedAt: ${checkpoint.updatedAt}`);

  // Repository Context
  lines.push('repository:');
  lines.push(`  repoName: ${toYamlString(checkpoint.repository.repoName)}`);
  lines.push(`  branch: ${toYamlString(checkpoint.repository.branch)}`);
  lines.push(`  headCommit: ${toYamlString(checkpoint.repository.headCommit)}`);
  lines.push(`  headShortCommit: ${toYamlString(checkpoint.repository.headShortCommit)}`);
  lines.push(`  isCleanWorkingTree: ${checkpoint.repository.isCleanWorkingTree}`);
  if (checkpoint.repository.remoteUrl) {
    lines.push(`  remoteUrl: ${toYamlString(checkpoint.repository.remoteUrl)}`);
  }

  // Developer Intent
  if (checkpoint.developerIntent) {
    lines.push('developerIntent:');
    lines.push(`  goal: ${toYamlString(checkpoint.developerIntent.goal)}`);
    lines.push(`  author: ${toYamlString(checkpoint.developerIntent.author)}`);
    lines.push(`  isAiGenerated: false`);
    lines.push(`  recordedAt: ${checkpoint.developerIntent.recordedAt}`);
    if (checkpoint.developerIntent.note) {
      lines.push(`  note: ${toYamlString(checkpoint.developerIntent.note, 4)}`);
    }
  }

  // Completed Work
  if (checkpoint.completedWork && checkpoint.completedWork.length > 0) {
    lines.push('completedWork:');
    for (const cw of checkpoint.completedWork) {
      lines.push(`  - id: ${toYamlString(cw.id)}`);
      lines.push(`    description: ${toYamlString(cw.description)}`);
      lines.push(`    confirmedByHuman: ${cw.confirmedByHuman}`);
      lines.push(`    timestamp: ${cw.timestamp}`);
      if (cw.completionNote) {
        lines.push(`    completionNote: ${toYamlString(cw.completionNote, 6)}`);
      }
    }
  } else {
    lines.push('completedWork: []');
  }

  // Unfinished Tasks
  if (checkpoint.unfinishedTasks && checkpoint.unfinishedTasks.length > 0) {
    lines.push('unfinishedTasks:');
    for (const ut of checkpoint.unfinishedTasks) {
      lines.push(`  - id: ${toYamlString(ut.id)}`);
      lines.push(`    description: ${toYamlString(ut.description)}`);
      lines.push(`    priority: ${ut.priority}`);
      if (ut.notes) lines.push(`    notes: ${toYamlString(ut.notes, 6)}`);
      if (ut.blocker) lines.push(`    blocker: ${toYamlString(ut.blocker, 6)}`);
    }
  } else {
    lines.push('unfinishedTasks: []');
  }

  // Known Constraints
  if (checkpoint.knownConstraints && checkpoint.knownConstraints.length > 0) {
    lines.push('knownConstraints:');
    for (const kc of checkpoint.knownConstraints) {
      lines.push(`  - id: ${toYamlString(kc.id)}`);
      lines.push(`    description: ${toYamlString(kc.description)}`);
      lines.push(`    source: ${kc.source}`);
      if (kc.decisionMemoryId) lines.push(`    decisionMemoryId: ${kc.decisionMemoryId}`);
      if (kc.severity) lines.push(`    severity: ${kc.severity}`);
    }
  } else {
    lines.push('knownConstraints: []');
  }

  // Target Files
  if (checkpoint.targetFiles && checkpoint.targetFiles.length > 0) {
    lines.push('targetFiles:');
    for (const tf of checkpoint.targetFiles) {
      lines.push(`  - filePath: ${toYamlString(tf.filePath)}`);
      lines.push(`    changeStatus: ${tf.changeStatus}`);
      if (tf.linesChanged !== undefined) lines.push(`    linesChanged: ${tf.linesChanged}`);
    }
  } else {
    lines.push('targetFiles: []');
  }

  // Decision Memory References
  if (checkpoint.decisionMemoryReferences && checkpoint.decisionMemoryReferences.length > 0) {
    lines.push('decisionMemoryReferences:');
    for (const ref of checkpoint.decisionMemoryReferences) {
      lines.push(`  - ${toYamlString(ref)}`);
    }
  } else {
    lines.push('decisionMemoryReferences: []');
  }

  // Commit References
  if (checkpoint.commitReferences && checkpoint.commitReferences.length > 0) {
    lines.push('commitReferences:');
    for (const cr of checkpoint.commitReferences) {
      lines.push(`  - hash: ${cr.hash}`);
      lines.push(`    shortHash: ${cr.shortHash}`);
      lines.push(`    subject: ${toYamlString(cr.subject)}`);
      lines.push(`    author: ${toYamlString(cr.author)}`);
      lines.push(`    date: ${toYamlString(cr.date)}`);
    }
  } else {
    lines.push('commitReferences: []');
  }

  // Tags
  if (checkpoint.tags && checkpoint.tags.length > 0) {
    lines.push('tags:');
    for (const t of checkpoint.tags) {
      lines.push(`  - ${toYamlString(t)}`);
    }
  } else {
    lines.push('tags: []');
  }

  lines.push('---');
  lines.push('');

  // Human-Readable Markdown Body
  lines.push(`# Context Checkpoint: ${checkpoint.title}`);
  lines.push('');

  lines.push('## Repository Context');
  lines.push(`- **Repository:** \`${checkpoint.repository.repoName}\``);
  lines.push(`- **Branch:** \`${checkpoint.repository.branch}\``);
  lines.push(`- **HEAD Commit:** \`${checkpoint.repository.headShortCommit}\` (${checkpoint.repository.headCommit})`);
  lines.push(`- **Working Tree Clean:** ${checkpoint.repository.isCleanWorkingTree ? 'Yes' : 'No (contains local modifications)'}`);
  lines.push('');

  if (checkpoint.developerIntent) {
    lines.push('## Developer Intent & Goal');
    lines.push(`> [!NOTE] Developer-Recorded Intent (Human Context)`);
    lines.push(`> **Goal:** ${checkpoint.developerIntent.goal}`);
    lines.push(`> **Recorded by:** ${checkpoint.developerIntent.author} on ${checkpoint.developerIntent.recordedAt}`);
    if (checkpoint.developerIntent.note) {
      lines.push('');
      lines.push(checkpoint.developerIntent.note.trim());
    }
    lines.push('');
  }

  lines.push('## Explicitly Confirmed Completed Work');
  if (checkpoint.completedWork.length > 0) {
    for (const cw of checkpoint.completedWork) {
      const confirmBadge = cw.confirmedByHuman ? '*(Human-Confirmed)*' : '*(Unconfirmed)*';
      lines.push(`- [x] **${cw.id}:** ${cw.description} ${confirmBadge}`);
      if (cw.completionNote) {
        lines.push(`  *Note:* ${cw.completionNote}`);
      }
    }
  } else {
    lines.push('_No work items explicitly confirmed as completed yet._');
  }
  lines.push('');

  lines.push('## Unfinished Tasks & Open Items');
  if (checkpoint.unfinishedTasks.length > 0) {
    for (const ut of checkpoint.unfinishedTasks) {
      lines.push(`- [ ] **[${ut.priority.toUpperCase()}] ${ut.id}:** ${ut.description}`);
      if (ut.notes) lines.push(`  *Notes:* ${ut.notes}`);
      if (ut.blocker) lines.push(`  *Blocker:* ${ut.blocker}`);
    }
  } else {
    lines.push('_No unfinished tasks recorded._');
  }
  lines.push('');

  if (checkpoint.knownConstraints.length > 0) {
    lines.push('## Known Constraints & Invariants');
    for (const kc of checkpoint.knownConstraints) {
      lines.push(`- **[${kc.id}] (${kc.source}):** ${kc.description}`);
    }
    lines.push('');
  }

  if (checkpoint.targetFiles.length > 0) {
    lines.push('## Changed & Targeted Files');
    for (const tf of checkpoint.targetFiles) {
      lines.push(`- \`${tf.filePath}\` (${tf.changeStatus}${tf.linesChanged !== undefined ? `, ~${tf.linesChanged} lines` : ''})`);
    }
    lines.push('');
  }

  if (checkpoint.decisionMemoryReferences.length > 0) {
    lines.push('## Linked Decision Memories');
    for (const dRef of checkpoint.decisionMemoryReferences) {
      lines.push(`- \`${dRef}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parses and validates a ContextCheckpoint from Markdown content.
 */
export function parseCheckpointFromMarkdown(content: string, expectedId?: string): ContextCheckpoint {
  if (!content || typeof content !== 'string') {
    throw new CheckpointValidationError('Checkpoint content is empty or invalid');
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new CheckpointValidationError('Checkpoint file does not contain valid YAML frontmatter fenced by "---"');
  }

  const frontmatterText = match[1];
  const markdownBody = match[2] || '';

  const frontmatter = parseCheckpointYaml(frontmatterText);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new CheckpointValidationError('Checkpoint frontmatter produced invalid object');
  }

  if (expectedId && frontmatter.id && frontmatter.id !== expectedId) {
    throw new CheckpointValidationError(
      `Checkpoint ID mismatch: frontmatter defines "${frontmatter.id}" but filename specifies "${expectedId}"`,
      'id'
    );
  }

  if (frontmatter.repository && typeof frontmatter.repository === 'object') {
    if (frontmatter.repository.headCommit !== undefined) {
      frontmatter.repository.headCommit = String(frontmatter.repository.headCommit);
    }
    if (frontmatter.repository.headShortCommit !== undefined) {
      frontmatter.repository.headShortCommit = String(frontmatter.repository.headShortCommit);
    }
  }

  const checkpoint: ContextCheckpoint = {
    id: frontmatter.id,
    schemaVersion: frontmatter.schemaVersion,
    title: frontmatter.title,
    repository: frontmatter.repository,
    developerIntent: frontmatter.developerIntent,
    completedWork: Array.isArray(frontmatter.completedWork) ? frontmatter.completedWork : [],
    unfinishedTasks: Array.isArray(frontmatter.unfinishedTasks) ? frontmatter.unfinishedTasks : [],
    knownConstraints: Array.isArray(frontmatter.knownConstraints) ? frontmatter.knownConstraints : [],
    targetFiles: Array.isArray(frontmatter.targetFiles) ? frontmatter.targetFiles : [],
    decisionMemoryReferences: Array.isArray(frontmatter.decisionMemoryReferences)
      ? frontmatter.decisionMemoryReferences
      : [],
    commitReferences: Array.isArray(frontmatter.commitReferences) ? frontmatter.commitReferences : [],
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt
  };

  validateCheckpointRecord(checkpoint);
  return checkpoint;
}
