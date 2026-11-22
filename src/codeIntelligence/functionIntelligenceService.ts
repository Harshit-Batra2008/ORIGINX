/**
 * GitWhisper — Function Role & Impact Service
 * Provides project-level function intelligence, enclosing symbol resolution,
 * direct callers, production & test references, blast radius, and degradation indicators.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CallerCitation,
  CodeLocationCitation,
  EnclosingSymbolInfo,
  FunctionRoleAndImpactResult,
  HistoricalFixLead,
  InferredBlastRadius,
  LanguageProviderStatus,
  ReferenceCitation,
} from './types';
import {
  DocumentSymbolResult,
  ILanguageProviderAdapter,
  VsCodeLanguageProviderAdapter
} from './languageProviderAdapter';
import { extractCodeEntities, findEnclosingEntity } from '../neo4j/codeEntityExtractor';
import { getGitCoChanges } from '../git/coChanges';
import { findRepoRoot, runGit } from '../git/gitService';
import { normalizePath } from '../git/sourcePaths';

export interface FunctionIntelligenceOptions {
  adapter?: ILanguageProviderAdapter;
  repoRoot?: string;
  fileContent?: string;
  character?: number;
  skipGitAnalysis?: boolean;
}

export function isTestFilePath(filePath: string): boolean {
  const norm = normalizePath(filePath).toLowerCase();
  const segments = norm.split('/');
  const base = segments[segments.length - 1] || '';

  if (segments.some(s => s === 'test' || s === 'tests' || s === '__tests__' || s === 'spec' || s === 'specs')) {
    return true;
  }
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(base)) {
    return true;
  }
  if (base.endsWith('_test.py') || base.startsWith('test_')) {
    return true;
  }
  return false;
}

export class FunctionIntelligenceService {
  private adapter: ILanguageProviderAdapter;

  constructor(adapter?: ILanguageProviderAdapter) {
    this.adapter = adapter || new VsCodeLanguageProviderAdapter();
  }

  public async analyzeFunctionRoleAndImpact(
    filePath: string,
    targetLine: number,
    options: FunctionIntelligenceOptions = {}
  ): Promise<FunctionRoleAndImpactResult> {
    const adapter = options.adapter || this.adapter;
    const normPath = normalizePath(filePath);
    const char = options.character ?? 1;

    // 1. Read file content safely
    let content = options.fileContent;
    if (content === undefined && fs.existsSync(filePath)) {
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        content = '';
      }
    }
    const lines = content ? content.split(/\r?\n/) : [];

    // 2. Discover enclosing symbol
    let enclosingSymbol: EnclosingSymbolInfo | undefined;
    let symbolsAvailable = false;

    if (adapter.isAvailable()) {
      try {
        const docSymbols = await adapter.getDocumentSymbols(filePath);
        if (docSymbols && docSymbols.length > 0) {
          symbolsAvailable = true;
          enclosingSymbol = this.findEnclosingFromSymbols(docSymbols, targetLine, normPath, lines);
        }
      } catch {
        symbolsAvailable = false;
      }
    }

    // Fallback: AST/regex extractor from existing neo4j/codeEntityExtractor
    if (!enclosingSymbol && content) {
      const extracted = extractCodeEntities(filePath, content);
      const matched = findEnclosingEntity(extracted, targetLine, targetLine);
      if (matched) {
        const snippet = lines.length >= matched.startLine ? lines[matched.startLine - 1]?.trim() : undefined;
        enclosingSymbol = {
          name: matched.name,
          kind: matched.kind === 'function' ? 'function' : (matched.kind === 'class' ? 'class' : 'unknown'),
          startLine: matched.startLine,
          endLine: matched.endLine,
          citation: {
            filePath: normPath,
            line: matched.startLine,
            endLine: matched.endLine,
            previewSnippet: snippet
          },
          signature: snippet,
          source: 'ast_heuristic'
        };
      }
    }

    // 3. Resolve direct callers via language provider call hierarchy
    let callersAvailable = false;
    const directCallers: CallerCitation[] = [];

    if (adapter.isAvailable()) {
      try {
        const incoming = await adapter.getIncomingCalls(filePath, targetLine, char);
        if (incoming && incoming.length > 0) {
          callersAvailable = true;
          for (const call of incoming) {
            const callerNormPath = normalizePath(call.callerFilePath);
            const callLine = call.callSiteLines[0] || call.callerRange.startLine;
            directCallers.push({
              callerName: call.callerName,
              callerKind: call.callerKind,
              citation: {
                filePath: callerNormPath,
                line: callLine,
                endLine: call.callerRange.endLine
              },
              isTestCaller: isTestFilePath(callerNormPath)
            });
          }
        } else if (incoming && incoming.length === 0) {
          // Provider returned empty list (valid response, zero callers found)
          callersAvailable = true;
        }
      } catch {
        callersAvailable = false;
      }
    }

    // 4. Resolve references (production vs test)
    let referencesAvailable = false;
    const productionReferences: ReferenceCitation[] = [];
    const testReferences: ReferenceCitation[] = [];

    if (adapter.isAvailable()) {
      try {
        const refs = await adapter.getReferences(filePath, targetLine, char, false);
        if (refs) {
          referencesAvailable = true;
          for (const ref of refs) {
            const refNormPath = normalizePath(ref.filePath);
            const isTest = isTestFilePath(refNormPath);
            const citation: ReferenceCitation = {
              citation: {
                filePath: refNormPath,
                line: ref.line,
                character: ref.character
              },
              isTest,
              referenceType: isTest ? 'test' : 'production'
            };
            if (isTest) {
              testReferences.push(citation);
            } else {
              productionReferences.push(citation);
            }
          }
        }
      } catch {
        referencesAvailable = false;
      }
    }

    // 5. Build Language Provider Status
    const isLspActive = adapter.isAvailable();
    const lspStatus: LanguageProviderStatus = {
      isAvailable: isLspActive && (symbolsAvailable || callersAvailable || referencesAvailable),
      documentSymbolsAvailable: symbolsAvailable,
      callHierarchyAvailable: callersAvailable,
      referencesAvailable: referencesAvailable,
      diagnostics: isLspActive
        ? (callersAvailable && referencesAvailable
            ? 'Language provider connected: Call hierarchy and references active.'
            : 'Language provider connected: Partial symbol data returned; static AST heuristics active.')
        : 'Language server unavailable or not running in extension host. Static AST and Git analysis active.'
    };

    // 6. Behavioral explanation (source-grounded)
    const targetSnippet = (lines.length >= targetLine && targetLine > 0) ? lines[targetLine - 1]?.trim() : undefined;
    const behaviorExplanation = this.deriveBehaviorExplanation(
      enclosingSymbol,
      targetLine,
      targetSnippet,
      lines,
      normPath
    );

    // 7. Blast Radius Analysis & Git Co-Changes
    const repoRoot = options.repoRoot || (await findRepoRoot(path.dirname(filePath)));
    const blastRadius = await this.computeBlastRadius(
      normPath,
      targetLine,
      enclosingSymbol,
      directCallers,
      productionReferences,
      testReferences,
      repoRoot,
      options.skipGitAnalysis
    );

    // 8. Generate comprehensive summary
    const summary = this.buildSummary(
      enclosingSymbol,
      normPath,
      targetLine,
      directCallers,
      productionReferences,
      testReferences,
      blastRadius,
      lspStatus
    );

    return {
      targetFile: normPath,
      targetLine,
      targetCodeSnippet: targetSnippet,
      enclosingSymbol,
      behaviorExplanation,
      directCallers,
      productionReferences,
      testReferences,
      languageProviderStatus: lspStatus,
      blastRadius,
      summary,
      timestamp: new Date().toISOString()
    };
  }

  private findEnclosingFromSymbols(
    symbols: DocumentSymbolResult[],
    targetLine: number,
    filePath: string,
    lines: string[]
  ): EnclosingSymbolInfo | undefined {
    let bestMatch: DocumentSymbolResult | undefined;

    const traverse = (list: DocumentSymbolResult[]) => {
      for (const sym of list) {
        if (sym.range.startLine <= targetLine && sym.range.endLine >= targetLine) {
          bestMatch = sym;
          if (sym.children && sym.children.length > 0) {
            traverse(sym.children);
          }
        }
      }
    };

    traverse(symbols);

    if (!bestMatch) return undefined;

    const startLine = bestMatch.range.startLine;
    const endLine = bestMatch.range.endLine;
    const snippet = lines.length >= startLine ? lines[startLine - 1]?.trim() : undefined;

    let kind: EnclosingSymbolInfo['kind'] = 'function';
    const rawKind = bestMatch.kind.toLowerCase();
    if (rawKind.includes('method')) kind = 'method';
    else if (rawKind.includes('constructor')) kind = 'constructor';
    else if (rawKind.includes('class')) kind = 'class';
    else if (rawKind.includes('interface')) kind = 'interface';
    else if (rawKind.includes('var') || rawKind.includes('const') || rawKind.includes('let')) kind = 'variable';

    return {
      name: bestMatch.name,
      kind,
      startLine,
      endLine,
      citation: {
        filePath,
        line: startLine,
        endLine,
        previewSnippet: snippet
      },
      signature: snippet,
      source: 'language_provider'
    };
  }

  private deriveBehaviorExplanation(
    enclosing: EnclosingSymbolInfo | undefined,
    targetLine: number,
    targetSnippet: string | undefined,
    lines: string[],
    filePath: string
  ): string {
    if (!enclosing) {
      if (targetSnippet) {
        return `Line ${targetLine} (${targetSnippet}) executes standalone module logic in ${path.basename(filePath)}.`;
      }
      return `Target line ${targetLine} in ${filePath}.`;
    }

    // Inspect docstrings or leading comments
    let docstring = '';
    const startIdx = enclosing.startLine - 1;
    if (startIdx > 0) {
      const prevLine = lines[startIdx - 1]?.trim();
      if (prevLine && (prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/*') || prevLine.startsWith('#'))) {
        docstring = prevLine.replace(/^(\/\/|\*|\/\*|#)\s*/, '');
      }
    }
    if (!docstring && startIdx + 1 < lines.length) {
      const nextLine = lines[startIdx + 1]?.trim();
      if (nextLine && (nextLine.startsWith('"""') || nextLine.startsWith("'''"))) {
        docstring = nextLine.replace(/^('''|""")/, '').replace(/('''|"")/, '').trim();
      }
    }

    const docClause = docstring ? ` (${docstring})` : '';
    const spanClause = `lines ${enclosing.startLine}–${enclosing.endLine}`;
    return `${enclosing.kind === 'method' ? 'Method' : 'Function'} \`${enclosing.name}\` ${spanClause} in \`${path.basename(filePath)}\`${docClause}. Handles enclosing execution logic for selected line ${targetLine}.`;
  }

  private async computeBlastRadius(
    filePath: string,
    targetLine: number,
    enclosing: EnclosingSymbolInfo | undefined,
    callers: CallerCitation[],
    prodRefs: ReferenceCitation[],
    testRefs: ReferenceCitation[],
    repoRoot: string | null,
    skipGit = false
  ): Promise<InferredBlastRadius> {
    const affectedProductionCallers = callers.filter(c => !c.isTestCaller);
    const affectedProductionReferences = prodRefs;

    // Collect relevant tests to run
    const testMap = new Map<string, { filePath: string; line?: number; testName?: string; source: 'call_hierarchy' | 'reference' | 'co_change' }>();

    for (const caller of callers) {
      if (caller.isTestCaller) {
        testMap.set(`${caller.citation.filePath}:${caller.citation.line}`, {
          filePath: caller.citation.filePath,
          line: caller.citation.line,
          testName: caller.callerName,
          source: 'call_hierarchy'
        });
      }
    }

    for (const ref of testRefs) {
      const key = `${ref.citation.filePath}:${ref.citation.line}`;
      if (!testMap.has(key)) {
        testMap.set(key, {
          filePath: ref.citation.filePath,
          line: ref.citation.line,
          source: 'reference'
        });
      }
    }

    // Historical co-change and bug fixes
    const coupledFiles: InferredBlastRadius['coupledFiles'] = [];
    const historicalFixLeads: HistoricalFixLead[] = [];

    if (repoRoot && !skipGit) {
      try {
        const coChanges = await getGitCoChanges(repoRoot, [filePath], 6);
        for (const cc of coChanges) {
          const isTest = isTestFilePath(cc.filePath);
          coupledFiles.push({
            filePath: cc.filePath,
            sharedCommitCount: cc.sharedCommitCount,
            sampleCommitHashes: cc.commits.map(c => c.shortHash),
            sampleCommitSubjects: cc.commits.map(c => c.subject),
            isTest
          });

          if (isTest && !testMap.has(cc.filePath)) {
            testMap.set(cc.filePath, {
              filePath: cc.filePath,
              source: 'co_change'
            });
          }
        }
      } catch {
        // Git co-change graceful fallback
      }

      // Query historical bug fix commits on this file
      try {
        const gitLogRes = await runGit([
          'log', '-20', '--format=%H%x00%h%x00%an%x00%aI%x00%s', '--', filePath
        ], repoRoot);
        if (gitLogRes.exitCode === 0 && gitLogRes.stdout) {
          const entries = gitLogRes.stdout.split('\n').filter(Boolean);
          for (const entry of entries) {
            const parts = entry.split('\0');
            if (parts.length >= 5) {
              const subject = parts[4];
              const isBugFix = /\b(fix|bug|patch|revert|issue|hotfix|crash|error)\b/i.test(subject);
              if (isBugFix) {
                historicalFixLeads.push({
                  commitHash: parts[0],
                  shortHash: parts[1],
                  author: parts[2],
                  date: parts[3].split('T')[0],
                  subject,
                  isBugFix: true
                });
              }
            }
          }
        }
      } catch {
        // Git log graceful fallback
      }
    }

    // High risk regression areas
    const highRiskAreas: string[] = [];
    if (affectedProductionCallers.length > 0) {
      highRiskAreas.push(`Direct Callers: ${affectedProductionCallers.length} downstream caller(s) depend directly on this function's interface/return contract.`);
    }
    if (affectedProductionReferences.length > 0) {
      highRiskAreas.push(`Production References: ${affectedProductionReferences.length} call site(s) across production modules.`);
    }
    if (historicalFixLeads.length > 0) {
      highRiskAreas.push(`Historical Fixes: Modified in ${historicalFixLeads.length} prior bug-fix commit(s); changes here risk reintroducing regressions.`);
    }

    return {
      affectedProductionCallers,
      affectedProductionReferences,
      relevantTestsToRun: Array.from(testMap.values()),
      coupledFiles,
      historicalFixLeads,
      highRiskRegressionAreas: highRiskAreas
    };
  }

  private buildSummary(
    enclosing: EnclosingSymbolInfo | undefined,
    filePath: string,
    targetLine: number,
    callers: CallerCitation[],
    prodRefs: ReferenceCitation[],
    testRefs: ReferenceCitation[],
    blastRadius: InferredBlastRadius,
    status: LanguageProviderStatus
  ): string {
    const fnName = enclosing ? `\`${enclosing.name}\`` : `Line ${targetLine}`;
    const callerCount = callers.length;
    const testCount = blastRadius.relevantTestsToRun.length;
    const coupledCount = blastRadius.coupledFiles.length;

    let text = `### Function Role & Impact: ${fnName} (${path.basename(filePath)}:${targetLine})\n\n`;

    if (enclosing) {
      text += `**Enclosing Symbol:** \`${enclosing.name}\` (${enclosing.kind}) at \`${filePath}:${enclosing.startLine}-${enclosing.endLine}\` [${enclosing.source === 'language_provider' ? 'LSP Verified' : 'AST Heuristic'}]\n\n`;
    }

    text += `**Project Usage:** ${callerCount} direct caller(s), ${prodRefs.length} production reference(s), ${testRefs.length} direct test reference(s).\n`;
    text += `**Blast Radius:** ${testCount} relevant test(s) to execute, ${coupledCount} historically coupled companion file(s).\n`;

    if (!status.isAvailable) {
      text += `\n> ⚠️ **Language Provider Notice:** ${status.diagnostics}\n`;
    }

    return text;
  }
}
