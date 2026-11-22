/**
 * GitWhisper — Explain Code Service (What & How)
 * Provides source-grounded explanations of what code does and how it functions,
 * strictly separate from historical 'Ask Why' rationale.
 */

import * as path from 'path';
import { extractCodeEntities, findEnclosingEntity } from '../neo4j/codeEntityExtractor';
import { ILanguageModelProvider } from '../lm/vscodeLmClient';

export interface ExplainCodeRequest {
  filePath: string;
  startLine: number;
  endLine: number;
  selectedCode?: string;
  fileContent?: string;
  lmProvider?: ILanguageModelProvider;
}

export interface ExplainCodeResult {
  filePath: string;
  startLine: number;
  endLine: number;
  enclosingSymbolName?: string;
  enclosingSymbolKind?: string;
  syntaxSummary: string;
  detailedWalkthrough: string[];
  caveatsAndSideEffects: string[];
  explanationType: 'source_structural';
  timestamp: string;
}

export class ExplainCodeService {
  /**
   * Generates a structural and semantic explanation of what the selected code does.
   */
  public explainCode(request: ExplainCodeRequest): ExplainCodeResult {
    const { filePath, startLine, endLine, selectedCode, fileContent } = request;
    const baseName = path.basename(filePath);

    // Extract enclosing entity
    let symbolName: string | undefined;
    let symbolKind: string | undefined;

    if (fileContent) {
      const entities = extractCodeEntities(filePath, fileContent);
      const matched = findEnclosingEntity(entities, startLine, endLine);
      if (matched) {
        symbolName = matched.name;
        symbolKind = matched.kind;
      }
    }

    const codeSnippet = (selectedCode || '').trim();
    const walkthrough: string[] = [];
    const caveats: string[] = [];

    // Analyze specific programming constructs
    if (codeSnippet.includes('re.') || codeSnippet.includes('RegExp') || codeSnippet.includes('/^') || codeSnippet.includes('regex')) {
      walkthrough.push(`**Pattern Matching:** Evaluates regular expressions for pattern recognition or input validation.`);
      if (codeSnippet.includes('re.IGNORECASE') || codeSnippet.includes('/i')) {
        walkthrough.push(`**Case Insensitivity:** Matches case-insensitively using flags without mutating character classes (preserving escapes like \\D or \\S).`);
      }
      caveats.push(`Changes to regex patterns can alter matching strictness, leading to false positives or bypasses.`);
    }

    if (codeSnippet.includes('async ') || codeSnippet.includes('await ') || codeSnippet.includes('Promise')) {
      walkthrough.push(`**Asynchronous Execution:** Manages non-blocking asynchronous operations and awaits completion.`);
      caveats.push(`Uncaught promise rejections or unhandled timeouts can cause deadlocks or silent failures.`);
    }

    if (codeSnippet.includes('try ') || codeSnippet.includes('catch') || codeSnippet.includes('except')) {
      walkthrough.push(`**Error Handling:** Catches potential runtime exceptions to provide controlled fallbacks.`);
    }

    if (codeSnippet.includes('return ')) {
      walkthrough.push(`**Return Contract:** Produces structured results back to downstream callers.`);
    }

    if (walkthrough.length === 0) {
      walkthrough.push(`Executes algorithmic sequence at lines ${startLine}–${endLine} within \`${baseName}\`.`);
    }

    const symbolClause = symbolName ? ` within \`${symbolName}\` (${symbolKind})` : '';
    const syntaxSummary = `Code block spanning lines ${startLine}–${endLine} in \`${baseName}\`${symbolClause}. Executes deterministic source logic based on active parameters.`;

    return {
      filePath,
      startLine,
      endLine,
      enclosingSymbolName: symbolName,
      enclosingSymbolKind: symbolKind,
      syntaxSummary,
      detailedWalkthrough: walkthrough,
      caveatsAndSideEffects: caveats,
      explanationType: 'source_structural',
      timestamp: new Date().toISOString()
    };
  }
}
