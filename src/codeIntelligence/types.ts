/**
 * GitWhisper — Function Role & Impact (Code Intelligence) Types
 * Defines data structures for enclosing symbols, direct callers, production & test references,
 * static citations, and inferred blast-radius impact analysis.
 */

export interface CodeLocationCitation {
  filePath: string;
  line: number;           // 1-indexed line number
  character?: number;     // 1-indexed column number
  endLine?: number;       // 1-indexed end line if range is known
  endCharacter?: number;
  previewSnippet?: string;
}

export interface EnclosingSymbolInfo {
  name: string;
  kind: 'function' | 'method' | 'constructor' | 'class' | 'interface' | 'variable' | 'unknown';
  citation: CodeLocationCitation;
  startLine: number;
  endLine: number;
  signature?: string;
  source: 'language_provider' | 'ast_heuristic' | 'unknown';
}

export interface CallerCitation {
  callerName: string;
  callerKind?: string;
  citation: CodeLocationCitation;
  callSitePreview?: string;
  isTestCaller: boolean;
}

export interface ReferenceCitation {
  citation: CodeLocationCitation;
  isTest: boolean;
  referenceType: 'production' | 'test';
  snippet?: string;
}

export interface LanguageProviderStatus {
  isAvailable: boolean;
  documentSymbolsAvailable: boolean;
  callHierarchyAvailable: boolean;
  referencesAvailable: boolean;
  diagnostics?: string;
}

export interface CoChangeLead {
  filePath: string;
  sharedCommitCount: number;
  sampleCommitHashes: string[];
  sampleCommitSubjects: string[];
  isTest: boolean;
}

export interface HistoricalFixLead {
  commitHash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  isBugFix: boolean;
}

export interface InferredBlastRadius {
  affectedProductionCallers: CallerCitation[];
  affectedProductionReferences: ReferenceCitation[];
  relevantTestsToRun: Array<{
    filePath: string;
    line?: number;
    testName?: string;
    source: 'call_hierarchy' | 'reference' | 'co_change';
  }>;
  coupledFiles: CoChangeLead[];
  historicalFixLeads: HistoricalFixLead[];
  highRiskRegressionAreas: string[];
}

export interface FunctionRoleAndImpactResult {
  targetFile: string;
  targetLine: number;
  targetCodeSnippet?: string;
  enclosingSymbol?: EnclosingSymbolInfo;
  behaviorExplanation: string;
  directCallers: CallerCitation[];
  productionReferences: ReferenceCitation[];
  testReferences: ReferenceCitation[];
  languageProviderStatus: LanguageProviderStatus;
  blastRadius: InferredBlastRadius;
  summary: string;
  timestamp: string;
}
