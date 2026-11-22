/**
 * GitWhisper — Requirements Auditor Service
 * Extracts requirements from PRD/TASKS.md and audits them against codebase implementation
 * and executed test evidence with strictly conservative classifications.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ExecutedTestSuiteSummary,
  ImplementationCandidate,
  RequirementAuditItem,
  RequirementCitation,
  RequirementsAuditReport,
  RequirementStatus,
  TestEvidenceCandidate
} from './types';
import { isExcludedPath, isSourceTarget, normalizePath } from '../git/sourcePaths';
import { isTestFilePath } from '../codeIntelligence/functionIntelligenceService';

export interface ParsedRequirement {
  id: string;
  title: string;
  rawText: string;
  keywords: string[];
}

export interface AuditOptions {
  scannedFilesLimit?: number;
  knownPassedTests?: string[];
  testSuites?: ExecutedTestSuiteSummary[];
  customSourceFiles?: Array<{ filePath: string; content: string }>;
}

export class RequirementsAuditor {
  /**
   * Parses requirements from Markdown PRD, TASKS.md, or pasted checklist.
   */
  public parseRequirements(content: string, defaultPrefix = 'REQ'): ParsedRequirement[] {
    if (!content || !content.trim()) return [];

    const lines = content.split(/\r?\n/);
    const parsed: ParsedRequirement[] = [];
    let currentReq: ParsedRequirement | null = null;
    let autoIndex = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Pattern 1: Explicit ID (e.g., "REQ-1:", "[REQ-002]", "R-101")
      const explicitMatch = line.match(/^(?:#+\s*)?(?:\[\s*)?(REQ-[0-9A-Za-z_-]+|R-[0-9]+)(?:\])?[:.-]?\s*(.+)/i);
      
      // Pattern 2: Numbered item (e.g., "1. Feature description", "## 1. Scope Engine")
      const numberedMatch = line.match(/^(?:#+\s*)?([0-9]+)\.\s*(.+)/);

      // Pattern 3: Markdown task item (e.g., "- [ ] Task description", "* [x] Feature")
      const taskMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)/);

      // Pattern 4: Header requirement (e.g., "### Feature: Enclosing function")
      const headerMatch = line.match(/^#{1,4}\s+(?:Requirement|Feature|Task|PRD):\s*(.+)/i);

      if (explicitMatch) {
        if (currentReq) parsed.push(currentReq);
        const id = explicitMatch[1].toUpperCase();
        const text = explicitMatch[2].trim();
        currentReq = {
          id,
          title: text.slice(0, 80),
          rawText: text,
          keywords: this.extractKeywords(text)
        };
      } else if (numberedMatch) {
        if (currentReq) parsed.push(currentReq);
        const id = `${defaultPrefix}-${numberedMatch[1]}`;
        const text = numberedMatch[2].trim();
        currentReq = {
          id,
          title: text.slice(0, 80),
          rawText: text,
          keywords: this.extractKeywords(text)
        };
        autoIndex = parseInt(numberedMatch[1], 10) + 1;
      } else if (taskMatch) {
        if (currentReq) parsed.push(currentReq);
        const id = `${defaultPrefix}-${autoIndex++}`;
        const text = taskMatch[2].trim();
        currentReq = {
          id,
          title: text.slice(0, 80),
          rawText: text,
          keywords: this.extractKeywords(text)
        };
      } else if (headerMatch) {
        if (currentReq) parsed.push(currentReq);
        const id = `${defaultPrefix}-${autoIndex++}`;
        const text = headerMatch[1].trim();
        currentReq = {
          id,
          title: text.slice(0, 80),
          rawText: text,
          keywords: this.extractKeywords(text)
        };
      } else if (currentReq) {
        // Multi-line continuation of current requirement
        currentReq.rawText += ' ' + line;
        const additionalKeywords = this.extractKeywords(line);
        for (const kw of additionalKeywords) {
          if (!currentReq.keywords.includes(kw)) {
            currentReq.keywords.push(kw);
          }
        }
      }
    }

    if (currentReq) {
      parsed.push(currentReq);
    }

    return parsed;
  }

  /**
   * Audits parsed requirements against files in workspaceRoot.
   */
  public async auditWorkspace(
    requirements: ParsedRequirement[],
    workspaceRoot: string,
    options: AuditOptions = {}
  ): Promise<RequirementsAuditReport> {
    const files = options.customSourceFiles || this.scanWorkspaceFiles(workspaceRoot, options.scannedFilesLimit ?? 200);
    const knownPassedTests = new Set(options.knownPassedTests || []);

    const items: RequirementAuditItem[] = [];
    let verifiedCount = 0;
    let implNotVerifiedCount = 0;
    let partialCount = 0;
    let notFoundCount = 0;
    let insufficientCount = 0;

    for (const req of requirements) {
      const implCandidates: ImplementationCandidate[] = [];
      const testCandidates: TestEvidenceCandidate[] = [];
      const executedTestNames: string[] = [];
      const citations: RequirementCitation[] = [];

      // Match against scanned files
      for (const file of files) {
        const isTest = isTestFilePath(file.filePath);
        const lines = file.content.split(/\r?\n/);

        // Find keyword matches in lines
        const matchingLines: Array<{ lineNum: number; lineText: string; matchCount: number }> = [];

        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          const lowerLine = lineText.toLowerCase();

          // Count matching distinctive keywords
          let matchCount = 0;
          for (const kw of req.keywords) {
            if (lowerLine.includes(kw)) {
              matchCount++;
            }
          }

          if (matchCount > 0) {
            matchingLines.push({ lineNum: i + 1, lineText: lineText.trim(), matchCount });
          }
        }

        if (matchingLines.length === 0) continue;

        // Sort by match count descending
        matchingLines.sort((a, b) => b.matchCount - a.matchCount);
        const topMatch = matchingLines[0];
        const matchRatio = topMatch.matchCount / Math.max(1, req.keywords.length);

        if (isTest) {
          // Check if this test was executed
          let testName: string | undefined;
          const testNameMatch = topMatch.lineText.match(/(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/i);
          if (testNameMatch) {
            testName = testNameMatch[1];
          }

          const wasExecuted = testName ? knownPassedTests.has(testName) : false;
          testCandidates.push({
            testFilePath: file.filePath,
            line: topMatch.lineNum,
            testName: testName || path.basename(file.filePath),
            snippet: topMatch.lineText.slice(0, 100),
            wasExecuted,
            executionPassed: wasExecuted
          });

          if (wasExecuted && testName) {
            executedTestNames.push(testName);
          }

          citations.push({
            filePath: file.filePath,
            line: topMatch.lineNum,
            label: `Test: ${path.basename(file.filePath)}:${topMatch.lineNum}`
          });
        } else {
          // Implementation file
          implCandidates.push({
            filePath: file.filePath,
            line: topMatch.lineNum,
            snippet: topMatch.lineText.slice(0, 100),
            confidence: Math.min(1.0, 0.4 + matchRatio * 0.6),
            rationale: `Matched ${topMatch.matchCount} keyword(s) (${req.keywords.slice(0, 3).join(', ')}) in ${path.basename(file.filePath)}`
          });

          citations.push({
            filePath: file.filePath,
            line: topMatch.lineNum,
            label: `Impl: ${path.basename(file.filePath)}:${topMatch.lineNum}`
          });
        }
      }

      // Determine conservative status
      let status: RequirementStatus;
      let remainingGap = '';
      let suggestedNextAction = '';

      const hasImplementations = implCandidates.length > 0;
      const hasTests = testCandidates.length > 0;
      const hasVerifiedExecutedTest = testCandidates.some(t => t.wasExecuted && t.executionPassed);

      if (req.keywords.length === 0) {
        status = 'INSUFFICIENT_EVIDENCE';
        remainingGap = 'Requirement description contains no distinctive technical keywords.';
        suggestedNextAction = 'Refine requirement clause with specific function, file, or protocol identifiers.';
        insufficientCount++;
      } else if (hasImplementations && hasVerifiedExecutedTest) {
        status = 'VERIFIED';
        remainingGap = 'None. Implementation identified and verified by executed automated tests.';
        suggestedNextAction = 'Maintain regression coverage.';
        verifiedCount++;
      } else if (hasImplementations && hasTests) {
        status = 'IMPLEMENTED_NOT_VERIFIED';
        remainingGap = `Candidate tests found in ${testCandidates[0].testFilePath}, but execution pass was not recorded in current test run.`;
        suggestedNextAction = `Execute test suite covering ${path.basename(testCandidates[0].testFilePath)}.`;
        implNotVerifiedCount++;
      } else if (hasImplementations && !hasTests) {
        status = 'IMPLEMENTED_NOT_VERIFIED';
        remainingGap = 'Implementation candidates found, but zero candidate automated test cases identified.';
        suggestedNextAction = `Author automated test in src/test/ targeting ${path.basename(implCandidates[0].filePath)}.`;
        implNotVerifiedCount++;
      } else if (!hasImplementations && hasTests) {
        status = 'PARTIAL';
        remainingGap = 'Candidate test found but implementation source was not located in scanned scope.';
        suggestedNextAction = 'Verify implementation file path or expand scan scope.';
        partialCount++;
      } else {
        status = 'NOT_FOUND_IN_SCANNED_SCOPE';
        remainingGap = `No candidate implementation or test references found for keywords: ${req.keywords.slice(0, 5).join(', ')}.`;
        suggestedNextAction = 'Verify implementation status or check if code resides in another repository/module.';
        notFoundCount++;
      }

      items.push({
        id: req.id,
        title: req.title,
        rawText: req.rawText,
        status,
        candidateImplementations: implCandidates.slice(0, 5),
        candidateTests: testCandidates.slice(0, 5),
        executedTests: Array.from(new Set(executedTestNames)),
        remainingGap,
        suggestedNextAction,
        citations: citations.slice(0, 8)
      });
    }

    const testSuites = options.testSuites || (knownPassedTests.size > 0 ? [
      { suiteName: 'Active Test Run', totalPassed: knownPassedTests.size, totalFailed: 0 }
    ] : []);

    const summary = this.buildReportSummary(
      requirements.length,
      verifiedCount,
      implNotVerifiedCount,
      partialCount,
      notFoundCount,
      insufficientCount,
      files.length
    );

    return {
      documentTitle: 'Requirements Audit vs Codebase Build',
      totalRequirements: requirements.length,
      verifiedCount,
      implementedNotVerifiedCount: implNotVerifiedCount,
      partialCount,
      notFoundCount,
      insufficientCount,
      items,
      scannedFilesCount: files.length,
      auditTimestamp: new Date().toISOString(),
      executedTestSuites: testSuites,
      summary
    };
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'were', 'been',
      'code', 'must', 'should', 'will', 'show', 'when', 'what', 'into', 'then',
      'user', 'developer', 'need', 'needs', 'want', 'wants', 'like', 'only', 'also'
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9_#-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopWords.has(w));

    return Array.from(new Set(words));
  }

  private scanWorkspaceFiles(
    dir: string,
    limit: number,
    collected: Array<{ filePath: string; content: string }> = []
  ): Array<{ filePath: string; content: string }> {
    if (!fs.existsSync(dir) || collected.length >= limit) return collected;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (collected.length >= limit) break;
        const full = path.join(dir, ent.name);
        const rel = normalizePath(path.relative(process.cwd(), full));

        if (ent.isDirectory()) {
          if (!isExcludedPath(rel)) {
            this.scanWorkspaceFiles(full, limit, collected);
          }
        } else if (ent.isFile()) {
          if (isSourceTarget(rel) || isTestFilePath(rel) || rel.endsWith('.md')) {
            try {
              const stat = fs.statSync(full);
              if (stat.size < 200 * 1024) { // Ignore gigantic files > 200KB
                const content = fs.readFileSync(full, 'utf8');
                collected.push({ filePath: rel, content });
              }
            } catch {}
          }
        }
      }
    } catch {}

    return collected;
  }

  private buildReportSummary(
    total: number,
    verified: number,
    implNotVerified: number,
    partial: number,
    notFound: number,
    insufficient: number,
    scannedFiles: number
  ): string {
    return `Audited ${total} requirement(s) across ${scannedFiles} workspace file(s).\n` +
      `- **VERIFIED:** ${verified}\n` +
      `- **IMPLEMENTED, NOT VERIFIED:** ${implNotVerified}\n` +
      `- **PARTIAL:** ${partial}\n` +
      `- **NOT FOUND IN SCANNED SCOPE:** ${notFound}\n` +
      `- **INSUFFICIENT EVIDENCE:** ${insufficient}`;
  }
}
