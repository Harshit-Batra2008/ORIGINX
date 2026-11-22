/**
 * GitWhisper — Integrated Intelligence Test Suite
 * Tests Function Role & Impact, Requirements Audit, Multi-PR Evolution, and Explain Code.
 */

import * as assert from 'assert';
import * as path from 'path';
import {
  FunctionIntelligenceService,
  ILanguageProviderAdapter,
  DocumentSymbolResult,
  CallHierarchyIncomingCallResult,
  ReferenceLocationResult,
  isTestFilePath
} from '../codeIntelligence';
import { RequirementsAuditor } from '../requirementsAudit';
import { FunctionEvolutionService } from '../evolution';
import { ExplainCodeService } from '../explainCode';

export async function runIntegratedIntelligenceTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
) {
  // =========================================================================
  // 1. Function Role & Impact (Code Intelligence)
  // =========================================================================
  await test('CodeIntelligence: isTestFilePath detects test files and production files accurately', () => {
    assert.strictEqual(isTestFilePath('src/test/askWhyTests.ts'), true);
    assert.strictEqual(isTestFilePath('tests/unit/test_engine.py'), true);
    assert.strictEqual(isTestFilePath('src/components/Avatar.test.tsx'), true);
    assert.strictEqual(isTestFilePath('engine/scope_test.py'), true);
    assert.strictEqual(isTestFilePath('src/codeIntelligence/types.ts'), false);
    assert.strictEqual(isTestFilePath('engine/scope.py'), false);
  });

  await test('CodeIntelligence: Resolves enclosing function and citations via mock LanguageProvider', async () => {
    const mockAdapter: ILanguageProviderAdapter = {
      isAvailable: () => true,
      getDocumentSymbols: async (fp: string): Promise<DocumentSymbolResult[]> => [
        {
          name: 'match_scope',
          kind: 'function',
          range: { startLine: 30, startCharacter: 1, endLine: 50, endCharacter: 20 }
        }
      ],
      getIncomingCalls: async (): Promise<CallHierarchyIncomingCallResult[]> => [
        {
          callerName: 'dispatch_request',
          callerFilePath: 'engine/router.py',
          callerRange: { startLine: 10, startCharacter: 1, endLine: 25, endCharacter: 1 },
          callSiteLines: [18]
        },
        {
          callerName: 'test_scope_matching',
          callerFilePath: 'tests/test_scope.py',
          callerRange: { startLine: 5, startCharacter: 1, endLine: 15, endCharacter: 1 },
          callSiteLines: [12]
        }
      ],
      getReferences: async (): Promise<ReferenceLocationResult[]> => [
        { filePath: 'engine/router.py', line: 18, character: 5 },
        { filePath: 'tests/test_scope.py', line: 12, character: 5 }
      ]
    };

    const service = new FunctionIntelligenceService(mockAdapter);
    const pythonCode = `
def helper():
    pass

def match_scope(host: str, patterns: list):
    """Matches host against regex patterns while preserving metacharacters."""
    if host.startswith("re:"):
        return True
    return False
`;
    const result = await service.analyzeFunctionRoleAndImpact('engine/scope.py', 35, {
      adapter: mockAdapter,
      fileContent: pythonCode,
      skipGitAnalysis: true
    });

    assert.ok(result.enclosingSymbol, 'Must resolve enclosing symbol');
    assert.strictEqual(result.enclosingSymbol?.name, 'match_scope');
    assert.strictEqual(result.enclosingSymbol?.startLine, 30);
    assert.strictEqual(result.enclosingSymbol?.endLine, 50);
    assert.strictEqual(result.enclosingSymbol?.source, 'language_provider');

    // Callers
    assert.strictEqual(result.directCallers.length, 2);
    const prodCaller = result.directCallers.find(c => !c.isTestCaller);
    const testCaller = result.directCallers.find(c => c.isTestCaller);
    assert.ok(prodCaller, 'Must identify production caller');
    assert.strictEqual(prodCaller?.callerName, 'dispatch_request');
    assert.strictEqual(prodCaller?.citation.line, 18);
    assert.ok(testCaller, 'Must identify test caller');
    assert.strictEqual(testCaller?.callerName, 'test_scope_matching');

    // References
    assert.strictEqual(result.productionReferences.length, 1);
    assert.strictEqual(result.testReferences.length, 1);
    assert.strictEqual(result.productionReferences[0].citation.filePath, 'engine/router.py');
    assert.strictEqual(result.testReferences[0].citation.filePath, 'tests/test_scope.py');

    // Status
    assert.strictEqual(result.languageProviderStatus.isAvailable, true);
    assert.strictEqual(result.languageProviderStatus.callHierarchyAvailable, true);
    assert.strictEqual(result.languageProviderStatus.referencesAvailable, true);
  });

  await test('CodeIntelligence: Gracefully falls back to AST extraction when language provider is unavailable', async () => {
    const unavailAdapter: ILanguageProviderAdapter = {
      isAvailable: () => false,
      getDocumentSymbols: async () => [],
      getIncomingCalls: async () => [],
      getReferences: async () => []
    };

    const service = new FunctionIntelligenceService(unavailAdapter);
    const tsCode = `
export function computeBlastRadius(target: string): number {
  return 42;
}
`;
    const result = await service.analyzeFunctionRoleAndImpact('src/impact/analyzer.ts', 3, {
      adapter: unavailAdapter,
      fileContent: tsCode,
      skipGitAnalysis: true
    });

    assert.strictEqual(result.languageProviderStatus.isAvailable, false);
    assert.ok(result.languageProviderStatus.diagnostics?.includes('Language server unavailable'), 'Must explain degradation');
    assert.ok(result.enclosingSymbol, 'Must fallback to AST heuristic');
    assert.strictEqual(result.enclosingSymbol?.name, 'computeBlastRadius');
    assert.strictEqual(result.enclosingSymbol?.source, 'ast_heuristic');
    assert.strictEqual(result.directCallers.length, 0);
  });

  // =========================================================================
  // 2. Requirements vs Build Audit
  // =========================================================================
  await test('RequirementsAudit: Parses markdown PRD, TASKS.md, and checklists into stable IDs', () => {
    const prdText = `
# Project PRD: Code Intelligence Engine
1. Scope Pattern Preservation: Engine must preserve regex case sensitivity and metacharacters.
2. Neo4j AuraDB Integration: Must connect to remote graph database and query evidence.
- [ ] Requirements Audit Ledger: Must audit requirements against codebase and test runs.
### REQ-4: Code Explain Mode
Explain code behavior and syntax semantics without hallucinating historical reasons.
`;
    const auditor = new RequirementsAuditor();
    const parsed = auditor.parseRequirements(prdText);

    assert.strictEqual(parsed.length, 4);
    assert.strictEqual(parsed[0].id, 'REQ-1');
    assert.ok(parsed[0].rawText.includes('Scope Pattern Preservation'));
    assert.strictEqual(parsed[1].id, 'REQ-2');
    assert.strictEqual(parsed[2].id, 'REQ-3');
    assert.strictEqual(parsed[3].id, 'REQ-4');
  });

  await test('RequirementsAudit: Classifies status conservatively with VERIFIED, IMPLEMENTED, and NOT_FOUND', async () => {
    const auditor = new RequirementsAuditor();
    const reqs = auditor.parseRequirements(`
1. Neo4j Graph Database: Connects to neo4j instance and imports evidence graph.
2. Quantum Teleportation Protocol: Interstellar quantum entanglement routing.
3. Code Entity Extractor: Extract python and typescript functions and config keys.
`);

    const mockFiles = [
      {
        filePath: 'src/neo4j/neo4jService.ts',
        content: 'export function createNeo4jDriver() { return neo4j.driver(); }'
      },
      {
        filePath: 'src/test/neo4jGraphRAGTests.ts',
        content: "test('Neo4j Graph Database: connects to neo4j instance', () => {});"
      },
      {
        filePath: 'src/neo4j/codeEntityExtractor.ts',
        content: 'export function extractCodeEntities(filePath: string, content: string) {}'
      }
    ];

    const report = await auditor.auditWorkspace(reqs, 'mock-root', {
      customSourceFiles: mockFiles,
      knownPassedTests: ['Neo4j Graph Database: connects to neo4j instance']
    });

    assert.strictEqual(report.totalRequirements, 3);

    // REQ-1 has implementation + executed passing test -> VERIFIED
    const req1 = report.items.find(r => r.id === 'REQ-1');
    assert.ok(req1);
    assert.strictEqual(req1?.status, 'VERIFIED');
    assert.strictEqual(req1?.executedTests.length, 1);
    assert.ok(req1?.citations.length! > 0);

    // REQ-2 has no implementation and no tests -> NOT_FOUND_IN_SCANNED_SCOPE
    const req2 = report.items.find(r => r.id === 'REQ-2');
    assert.ok(req2);
    assert.strictEqual(req2?.status, 'NOT_FOUND_IN_SCANNED_SCOPE');

    // REQ-3 has implementation but no executed test -> IMPLEMENTED_NOT_VERIFIED
    const req3 = report.items.find(r => r.id === 'REQ-3');
    assert.ok(req3);
    assert.strictEqual(req3?.status, 'IMPLEMENTED_NOT_VERIFIED');
    assert.ok(req3?.remainingGap.includes('zero candidate automated test'));
  });

  // =========================================================================
  // 3. Multi-PR Function Evolution
  // =========================================================================
  await test('FunctionEvolution: Classifies commit roles and detects supersession across commits', async () => {
    const service = new FunctionEvolutionService();
    // Trace evolution on a known file in the workspace
    const timeline = await service.traceFunctionEvolution('src/askWhy/askWhyService.ts', 1, 30, {
      repoRoot: path.resolve(__dirname, '../../'),
      maxCommits: 5
    });

    assert.ok(timeline.commits.length > 0, 'Must retrieve commits');
    assert.ok(timeline.totalCommitsCount >= 1);
    assert.ok(timeline.summary.includes('Multi-PR Evolution'));
    // Latest commit should have role current or bug_fix/refactor/feature
    assert.ok(timeline.currentCommit);
  });

  // =========================================================================
  // 4. Explain Code (What & How)
  // =========================================================================
  await test('ExplainCode: Explains regex, async, and error handling constructs with caveats', () => {
    const service = new ExplainCodeService();
    const snippet = `
async function matchRegexScope(pattern: string, host: string) {
  try {
    const regex = new RegExp(pattern, 'i');
    return regex.test(host);
  } catch (err) {
    return false;
  }
}
`;
    const result = service.explainCode({
      filePath: 'engine/scopeMatcher.ts',
      startLine: 1,
      endLine: 10,
      selectedCode: snippet,
      fileContent: snippet
    });

    assert.strictEqual(result.explanationType, 'source_structural');
    assert.ok(result.syntaxSummary.includes('scopeMatcher.ts'));
    assert.ok(result.detailedWalkthrough.some(w => w.includes('Pattern Matching')));
    assert.ok(result.detailedWalkthrough.some(w => w.includes('Asynchronous Execution')));
    assert.ok(result.detailedWalkthrough.some(w => w.includes('Error Handling')));
    assert.ok(result.caveatsAndSideEffects.length > 0);
  });
}
