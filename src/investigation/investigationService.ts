import * as path from 'path';
import { getHistoryForSelection } from '../git/gitService';
import { GitHistoryResult, SelectionContext } from '../git/gitTypes';
import { retrieveCoChangedFiles } from '../neo4j/neo4jEvidenceRetriever';
import { aggregateCoChangeEvidence } from '../reviewer/reviewerService';
import { RelatedFileRecommendation, ReviewerCoChangeGroup } from '../reviewer/reviewerTypes';
import {
  CollectedDiagnostic,
  DiagnosticSeverityLevel,
  InvestigationEvidencePackage,
  InvestigationRequest
} from './investigationTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Collects and normalizes compiler/linter diagnostics from VS Code for the target file.
 * Safely handles environments outside the VS Code Extension Host (e.g. unit test runner).
 */
export function collectDiagnosticsForDocument(
  documentUri: any,
  startLine: number,
  endLine: number,
  customDiagnostics?: any[]
): CollectedDiagnostic[] {
  const vscode = getVsCode();
  let rawDiagnostics: any[] = [];

  if (customDiagnostics) {
    rawDiagnostics = customDiagnostics;
  } else if (vscode && vscode.languages && vscode.languages.getDiagnostics && documentUri) {
    try {
      rawDiagnostics = vscode.languages.getDiagnostics(documentUri);
    } catch {
      rawDiagnostics = [];
    }
  }

  if (!rawDiagnostics || !Array.isArray(rawDiagnostics) || rawDiagnostics.length === 0) {
    return [];
  }

  const results: CollectedDiagnostic[] = [];

  for (const d of rawDiagnostics) {
    if (!d || !d.range) continue;

    // VS Code diagnostic lines are 0-indexed; convert to 1-indexed editor lines
    const dStartLine = (d.range.start?.line ?? 0) + 1;
    const dStartChar = (d.range.start?.character ?? 0) + 1;
    const dEndLine = (d.range.end?.line ?? 0) + 1;
    const dEndChar = (d.range.end?.character ?? 0) + 1;

    // Check if diagnostic range overlaps the user's selected line range [startLine, endLine]
    const overlapsSelection = !(dEndLine < startLine || dStartLine > endLine);

    let severity: DiagnosticSeverityLevel = 'information';
    // VS Code DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3
    if (d.severity === 0 || d.severity === 'error') {
      severity = 'error';
    } else if (d.severity === 1 || d.severity === 'warning') {
      severity = 'warning';
    } else if (d.severity === 3 || d.severity === 'hint') {
      severity = 'hint';
    }

    let code: string | undefined = undefined;
    if (d.code !== undefined && d.code !== null) {
      if (typeof d.code === 'object' && d.code.value !== undefined) {
        code = String(d.code.value);
      } else {
        code = String(d.code);
      }
    }

    results.push({
      message: String(d.message || ''),
      severity,
      range: {
        startLine: dStartLine,
        startCharacter: dStartChar,
        endLine: dEndLine,
        endCharacter: dEndChar
      },
      source: d.source ? String(d.source) : undefined,
      code,
      overlapsSelection
    });
  }

  // Prioritize overlapping diagnostics, then errors, then warnings, then position
  const severityRank: Record<DiagnosticSeverityLevel, number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3
  };

  return results.sort((a, b) => {
    if (a.overlapsSelection !== b.overlapsSelection) {
      return a.overlapsSelection ? -1 : 1;
    }
    const rankDiff = severityRank[a.severity] - severityRank[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.range.startLine - b.range.startLine;
  });
}

/**
 * Assembles a comprehensive evidence package for a bug investigation:
 * Selection details, VS Code diagnostics, Git line evolution & diffs, and Neo4j co-change companion files.
 */
export async function assembleInvestigationEvidence(
  request: InvestigationRequest,
  options?: {
    cancellationToken?: any;
    neo4jDriver?: any;
    customDiagnostics?: any[];
  }
): Promise<InvestigationEvidencePackage> {
  const selectionContext: SelectionContext = {
    filePath: path.isAbsolute(request.filePath) ? request.filePath : path.join(request.repoRoot, request.filePath),
    fileName: request.fileName,
    startLine: request.startLine,
    endLine: request.endLine,
    selectedText: request.selectedCode
  };

  // 1. Retrieve Git history and line diffs for selected lines
  const gitHistory = await getHistoryForSelection(selectionContext, {
    cancellationToken: options?.cancellationToken
  });

  // 2. Collect VS Code compiler and linter diagnostics
  const vscode = getVsCode();
  let docUri: any = undefined;
  if (vscode && vscode.Uri) {
    try {
      docUri = vscode.Uri.file(selectionContext.filePath);
    } catch {}
  }
  const diagnostics = collectDiagnosticsForDocument(
    docUri,
    request.startLine,
    request.endLine,
    options?.customDiagnostics
  );

  // 3. Query Neo4j historical co-changes (blast radius)
  let neo4jStatus: 'ok' | 'offline' | 'no_records' | 'disabled' | 'error' = 'disabled';
  let neo4jError: string | undefined = undefined;
  let coChangeEvidence: RelatedFileRecommendation[] = [];

  if (options?.neo4jDriver) {
    try {
      const relativePath = path.relative(request.repoRoot, selectionContext.filePath).replace(/\\/g, '/');
      const coRes = await retrieveCoChangedFiles(options.neo4jDriver, request.repoId, relativePath, 10);
      if (coRes.status === 'ok') {
        if (coRes.coChangedFiles.length > 0) {
          const group: ReviewerCoChangeGroup = {
            targetFilePath: relativePath,
            targetFileName: request.fileName,
            coChangedFiles: coRes.coChangedFiles
          };
          coChangeEvidence = aggregateCoChangeEvidence(
            [{ filePath: relativePath }],
            [group]
          );
          neo4jStatus = 'ok';
        } else {
          neo4jStatus = 'no_records';
        }
      } else {
        neo4jStatus = 'error';
        neo4jError = coRes.error;
      }
    } catch (err: any) {
      neo4jStatus = 'offline';
      neo4jError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    request,
    diagnostics,
    gitHistory,
    coChangeEvidence,
    neo4jStatus,
    neo4jError
  };
}
