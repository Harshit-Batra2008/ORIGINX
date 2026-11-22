import * as path from 'path';
import { getHistoryForSelection, runGit } from '../git/gitService';
import { getGitCoChanges } from '../git/coChanges';
import { isSourceTarget } from '../git/sourcePaths';
import { listWorkingTreeEntries } from '../git/workingTreeStatus';
import { SelectionContext } from '../git/gitTypes';
import { collectDiagnosticsForDocument } from '../investigation/investigationService';
import { retrieveCoChangedFiles, retrieveFileEvidence } from '../neo4j/neo4jEvidenceRetriever';
import { Neo4jCoChangeItem, Neo4jCommitEvidence } from '../neo4j/neo4jGraphTypes';
import { aggregateCoChangeEvidence } from '../impact/coChangeImpact';
import {
  UnifiedAnalysisRequest,
  UnifiedEvidenceBundle
} from './unifiedTypes';

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Gathers unified code analysis evidence across all modules:
 * Selection lines, compiler diagnostics, working-tree modifications, Git blame history,
 * and Neo4j repository-scoped graph history + co-change companion files.
 */
export async function gatherUnifiedEvidence(
  request: UnifiedAnalysisRequest,
  options?: {
    cancellationToken?: any;
    neo4jDriver?: any;
    customDiagnostics?: any[];
  }
): Promise<UnifiedEvidenceBundle> {
  const fullPath = path.isAbsolute(request.filePath)
    ? request.filePath
    : path.join(request.repoRoot, request.filePath);

  const relativePath = path.relative(request.repoRoot, fullPath).replace(/\\/g, '/');

  const selectionContext: SelectionContext = {
    filePath: fullPath,
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
      docUri = vscode.Uri.file(fullPath);
    } catch {}
  }
  const diagnostics = collectDiagnosticsForDocument(
    docUri,
    request.startLine,
    request.endLine,
    options?.customDiagnostics
  );

  // 3. Inspect working-tree diff for this file (staged or unstaged)
  let workingTreeDiff: string | undefined = undefined;
  let isWorkingTreeModified = false;

  try {
    const diffRes = await runGit(['diff', 'HEAD', '--', relativePath], request.repoRoot, {
      cancellationToken: options?.cancellationToken
    });
    if (diffRes.exitCode === 0 && diffRes.stdout.trim().length > 0) {
      workingTreeDiff = diffRes.stdout;
      isWorkingTreeModified = true;
    } else if (gitHistory.hasUncommittedChanges && gitHistory.uncommittedDiff) {
      workingTreeDiff = gitHistory.uncommittedDiff;
      isWorkingTreeModified = true;
    }
  } catch {
    if (gitHistory.hasUncommittedChanges) {
      isWorkingTreeModified = true;
      workingTreeDiff = gitHistory.uncommittedDiff;
    }
  }

  // 4. Query Neo4j Knowledge Graph History & Co-Changes
  let neo4jStatus: 'ok' | 'offline' | 'no_records' | 'disabled' | 'error' = 'disabled';
  let neo4jError: string | undefined = undefined;
  let neo4jFileEvidence: Neo4jCommitEvidence[] | undefined = undefined;
  let companions: Neo4jCoChangeItem[] = [];

  if (options?.neo4jDriver) {
    try {
      // Historical commit records for this file
      const fileEvRes = await retrieveFileEvidence(options.neo4jDriver, request.repoId, relativePath, 20);
      if (fileEvRes.status === 'ok') {
        neo4jFileEvidence = fileEvRes.commits;
      }

      // Historically co-changed files (blast radius)
      const coRes = await retrieveCoChangedFiles(options.neo4jDriver, request.repoId, relativePath, 10);
      if (coRes.status === 'ok') {
        companions = coRes.coChangedFiles.filter(item => isSourceTarget(item.filePath));
        neo4jStatus = (neo4jFileEvidence && neo4jFileEvidence.length > 0) || companions.length > 0
          ? 'ok'
          : 'no_records';
      } else {
        neo4jStatus = 'error';
        neo4jError = coRes.error;
      }
    } catch (err: any) {
      neo4jStatus = 'offline';
      neo4jError = err instanceof Error ? err.message : String(err);
    }
  }

  const useLocalGit = companions.length === 0 && isSourceTarget(relativePath) &&
    !options?.cancellationToken?.isCancellationRequested;
  const gitOptions = { cancellationToken: options?.cancellationToken };
  if (useLocalGit) {
    const rows = await getGitCoChanges(request.repoRoot, [relativePath], 8, gitOptions);
    companions = rows.map(row => ({
      filePath: row.filePath,
      fileName: path.basename(row.filePath),
      sharedCommitCount: row.sharedCommitCount,
      sharedCommits: row.commits,
      commitHashes: row.commits.map(commit => commit.shortHash)
    }));
  }
  const workingTree = companions.length ? await listWorkingTreeEntries(request.repoRoot, gitOptions) : [];
  const recommendations = aggregateCoChangeEvidence(workingTree, [{
    targetFilePath: relativePath,
    targetFileName: request.fileName,
    coChangedFiles: companions
  }]);

  return {
    request,
    diagnostics,
    gitHistory,
    workingTreeDiff,
    isWorkingTreeModified,
    neo4jFileEvidence,
    neo4jCoChanges: useLocalGit ? [] : recommendations,
    localGitCoChanges: useLocalGit ? recommendations : undefined,
    neo4jStatus,
    neo4jError
  };
}
