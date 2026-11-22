/**
 * GitWhisper — Design Document & ADR Scanner
 * Discovers and parses repository Architecture Decision Records (ADRs)
 * and design documentation to connect them with code files and historical PRs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractCommitReferences, extractIssueReferences } from '../github/githubService';
import { GraphDesignDocumentNode } from './evidenceGraphTypes';

export interface DocScannerOptions {
  maxDocs?: number;
  maxFileSizeBytes?: number;
  repoId?: string;
  customDocDirs?: string[];
}

const DEFAULT_DOC_DIRS = [
  'docs',
  'doc',
  'adr',
  'adrs',
  'architecture',
  'design',
  'commands',
  '.github',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.vscode',
  '.gemini',
  'vendor',
  'coverage',
  '.next',
]);

const CODE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.sh',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
]);

/**
 * Normalizes any OS path to repository-relative POSIX path.
 */
function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Extracts referenced code files from markdown text.
 * Finds inline backticks (e.g. `engine/scope.py`, `scope.py`) and markdown links.
 */
export function extractCodeFileReferences(content: string, repoRoot?: string): string[] {
  const referenced = new Set<string>();

  // 1. Inline code backticks: `path/to/file.ext` or `file.ext`
  const backtickPattern = /`([^`\n\r]+)`/g;
  let match: RegExpExecArray | null;

  while ((match = backtickPattern.exec(content)) !== null) {
    const candidate = match[1].trim();
    // Exclude bash commands or code snippets
    if (candidate.includes(' ') || candidate.length > 120 || candidate.startsWith('-')) {
      continue;
    }

    const ext = path.extname(candidate).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      referenced.add(toPosixPath(candidate));
    }
  }

  // 2. Markdown links: [text](path/to/file.ext)
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((match = linkPattern.exec(content)) !== null) {
    const rawLink = match[2].trim().split('#')[0].split('?')[0];
    if (rawLink.startsWith('http://') || rawLink.startsWith('https://') || rawLink.startsWith('mailto:')) {
      continue;
    }

    const ext = path.extname(rawLink).toLowerCase();
    if (CODE_EXTENSIONS.has(ext) || ext === '.md') {
      referenced.add(toPosixPath(rawLink));
    }
  }

  return Array.from(referenced);
}

/**
 * Detects whether markdown content exhibits ADR / formal design structure.
 */
export function hasAdrStructure(content: string): boolean {
  const lower = content.toLowerCase();
  const decisionKeywords = ['context', 'decision', 'rationale', 'consequences', 'alternatives considered', 'status'];
  let matches = 0;

  for (const kw of decisionKeywords) {
    if (lower.includes(`## ${kw}`) || lower.includes(`### ${kw}`) || lower.includes(`**${kw}**`)) {
      matches++;
    }
  }

  return matches >= 2;
}

/**
 * Parses a single Markdown file into a GraphDesignDocumentNode.
 */
export function parseMarkdownDocument(
  fullPath: string,
  repoRoot: string,
  repoId: string
): GraphDesignDocumentNode | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return null;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const relPath = toPosixPath(path.relative(repoRoot, fullPath));
    const lines = content.split(/\r?\n/);

    // Extract title: first # heading or filename
    let title = path.basename(relPath, '.md');
    let summary = '';
    const sections: Array<{ heading: string; contentSnippet: string }> = [];

    let currentHeading = 'Overview';
    let currentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('# ') && title === path.basename(relPath, '.md')) {
        title = line.substring(2).trim();
        continue;
      }

      if (line.startsWith('## ') || line.startsWith('### ')) {
        if (currentLines.length > 0) {
          sections.push({
            heading: currentHeading,
            contentSnippet: currentLines.join('\n').trim().substring(0, 500),
          });
          currentLines = [];
        }
        currentHeading = line.replace(/^#+\s*/, '').trim();
        continue;
      }

      if (!summary && line && !line.startsWith('#') && !line.startsWith('>')) {
        summary = line.substring(0, 300);
      }

      currentLines.push(line);
    }

    if (currentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        contentSnippet: currentLines.join('\n').trim().substring(0, 500),
      });
    }

    const referencedFiles = extractCodeFileReferences(content, repoRoot);
    const referencedIssueNumbers = extractIssueReferences(content);
    const hasDecision = hasAdrStructure(content);

    return {
      id: `${repoId}:doc-${relPath}`,
      repoId,
      path: relPath,
      title,
      summary: summary || title,
      sections: sections.slice(0, 15),
      referencedFiles,
      referencedIssueNumbers,
      referencedPrNumbers: referencedIssueNumbers,
      hasDecisionStructure: hasDecision,
      lastModified: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

const docScanCache = new Map<string, { docs: GraphDesignDocumentNode[]; timestamp: number }>();
const DOC_SCAN_CACHE_TTL_MS = 30000;

/**
 * Clears the in-memory design document cache (used in tests).
 */
export function clearDocScanCache(): void {
  docScanCache.clear();
}

/**
 * Scans a repository for markdown documentation and ADRs.
 */
export function scanDesignDocuments(
  repoRoot: string,
  options?: DocScannerOptions
): GraphDesignDocumentNode[] {
  const cacheKey = `${repoRoot}::${options?.repoId || ''}`;
  const now = Date.now();
  const cached = docScanCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < DOC_SCAN_CACHE_TTL_MS) {
    return cached.docs;
  }

  const repoId = options?.repoId || path.basename(repoRoot);
  const maxDocs = options?.maxDocs ?? 100;
  const maxSizeBytes = options?.maxFileSizeBytes ?? 500 * 1024;
  const docDirs = options?.customDocDirs ?? DEFAULT_DOC_DIRS;

  const foundDocs: GraphDesignDocumentNode[] = [];
  const scannedPaths = new Set<string>();

  // 1. Scan root level markdown files (e.g. ARCHITECTURE.md, README.md, DESIGN.md)
  try {
    const rootEntries = fs.readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const fullPath = path.join(repoRoot, entry.name);
        const doc = parseMarkdownDocument(fullPath, repoRoot, repoId);
        if (doc) {
          foundDocs.push(doc);
          scannedPaths.add(fullPath);
        }
      }
    }
  } catch {
    // Continue
  }

  // 2. Scan designated documentation directories recursively
  for (const dirName of docDirs) {
    if (foundDocs.length >= maxDocs) {
      break;
    }

    const dirPath = path.join(repoRoot, dirName);
    if (!fs.existsSync(dirPath)) {
      continue;
    }

    const walk = (currDir: string) => {
      if (foundDocs.length >= maxDocs) {
        return;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (foundDocs.length >= maxDocs) {
          return;
        }

        const fullPath = path.join(currDir, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
            walk(fullPath);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          if (!scannedPaths.has(fullPath)) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size <= maxSizeBytes) {
                const doc = parseMarkdownDocument(fullPath, repoRoot, repoId);
                if (doc) {
                  foundDocs.push(doc);
                  scannedPaths.add(fullPath);
                }
              }
            } catch {
              // Ignore file read error
            }
          }
        }
      }
    };

    walk(dirPath);
  }

  docScanCache.set(cacheKey, { docs: foundDocs, timestamp: now });
  return foundDocs;
}

/**
 * Filters and prioritizes design documents relevant to a specific target file,
 * strictly excluding unrelated documentation (e.g. general install notes or unreferenced pattern libraries).
 */
export function filterRelevantDesignDocs(
  docs: GraphDesignDocumentNode[],
  targetFilePath: string
): Array<{ doc: GraphDesignDocumentNode; relevanceScore: number; matchReason: string }> {
  const normalizedTarget = toPosixPath(targetFilePath).toLowerCase();
  const targetBase = path.basename(normalizedTarget).toLowerCase();

  const results: Array<{ doc: GraphDesignDocumentNode; relevanceScore: number; matchReason: string }> = [];

  for (const doc of docs) {
    let score = 0;
    let matchReason = '';

    const exactMatch = doc.referencedFiles.some(f => toPosixPath(f).toLowerCase() === normalizedTarget);
    if (exactMatch) {
      score = 100;
      matchReason = `Direct reference to target file path (${targetFilePath})`;
    } else {
      const baseMatch = doc.referencedFiles.some(f => path.basename(toPosixPath(f)).toLowerCase() === targetBase);
      if (baseMatch) {
        score = 60;
        matchReason = `Component basename reference (${targetBase})`;
      } else {
        // Check document content sections
        const mentionsPath = doc.sections.some(s => s.contentSnippet.toLowerCase().includes(normalizedTarget));
        if (mentionsPath) {
          score = 50;
          matchReason = `Document text explicitly cites ${targetFilePath}`;
        }
      }
    }

    if (score > 0) {
      results.push({ doc, relevanceScore: score, matchReason });
    }
  }

  return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

