/**
 * GitWhisper Context Checkpoint — Core Data Types & Schemas
 * Represents developer handoff context, explicit intent, completed work,
 * unfinished tasks, and graph-assisted file relationships.
 */

export type CheckpointRelationshipType =
  | 'historical_co_change'          // Observed changing together in historical commits (NOT runtime dependency)
  | 'direct_git_history'             // Directly modified in the same branch/commits
  | 'human_recorded_decision'        // Linked via verified or proposed Decision Memory
  | 'verified_code_dependency';      // Independently verified import/code dependency

export type CheckpointRetrievalSource =
  | 'neo4j_graph'
  | 'git_fallback'
  | 'none';

export interface CheckpointRepositoryContext {
  repoName: string;
  branch: string;
  headCommit: string;
  headShortCommit: string;
  remoteUrl?: string;
  isCleanWorkingTree: boolean;
}

export interface CheckpointDeveloperIntent {
  goal: string;
  author: string;
  note?: string;
  isAiGenerated: false; // Strictly marked as false to distinguish from AI inference
  recordedAt: string;
}

export interface CompletedWorkItem {
  id: string;
  description: string;
  confirmedByHuman: boolean; // Must be explicitly confirmed by a developer
  completionNote?: string;
  timestamp: string;
}

export interface UnfinishedTaskItem {
  id: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  notes?: string;
  blocker?: string;
}

export interface CheckpointConstraint {
  id: string;
  description: string;
  source: 'decision_memory' | 'developer_note' | 'git_history';
  decisionMemoryId?: string;
  severity?: 'critical' | 'advisory';
}

export interface CheckpointTargetFile {
  filePath: string;
  changeStatus: 'modified' | 'added' | 'deleted' | 'untracked' | 'referenced';
  linesChanged?: number;
}

export interface CheckpointCommitReference {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Complete durable Context Checkpoint entity.
 * Persisted as Markdown with YAML frontmatter under <repoRoot>/.gitwhisper/checkpoints/<id>.md
 */
export interface ContextCheckpoint {
  id: string; // e.g. CHK-20261122-8A4F1C2B9D3E7F01
  schemaVersion: '1.0.0';
  title: string;
  repository: CheckpointRepositoryContext;
  developerIntent?: CheckpointDeveloperIntent;
  completedWork: CompletedWorkItem[];
  unfinishedTasks: UnfinishedTaskItem[];
  knownConstraints: CheckpointConstraint[];
  targetFiles: CheckpointTargetFile[];
  decisionMemoryReferences: string[]; // List of DecisionMemory IDs (e.g. DEC-xxx)
  commitReferences: CheckpointCommitReference[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Input used to construct and persist a new Context Checkpoint.
 */
export interface SaveCheckpointInput {
  id?: string;
  title: string;
  goal?: string;
  author?: string;
  developerNote?: string;
  completedWork?: Array<{ description: string; confirmedByHuman?: boolean; completionNote?: string }>;
  unfinishedTasks?: Array<{ description: string; priority?: 'high' | 'medium' | 'low'; notes?: string; blocker?: string }>;
  knownConstraints?: Array<{ description: string; source?: 'decision_memory' | 'developer_note' | 'git_history'; decisionMemoryId?: string }>;
  targetFiles?: Array<{ filePath: string; changeStatus?: 'modified' | 'added' | 'deleted' | 'untracked' | 'referenced' }>;
  decisionMemoryReferences?: string[];
  tags?: string[];
}

/**
 * Diagnostics and freshness metrics for graph context retrieval.
 */
export interface GraphFreshnessStatus {
  isAvailable: boolean;
  isFresh: boolean;
  indexedHead?: string;
  currentHead: string;
  repositoryId?: string;
  limitationMessage?: string;
}

export interface GraphConnectingCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GraphRelatedFile {
  filePath: string;
  relationshipType: CheckpointRelationshipType;
  coChangeCount: number;
  connectingCommits: GraphConnectingCommit[];
  evidenceReason: string;
  isDirectDependency?: boolean;
}

export interface GraphRetrievalDiagnostics {
  queryDurationMs: number;
  candidateCount: number;
  serializedContextSizeBytes: number;
  retrievalSource: CheckpointRetrievalSource;
}

export interface ContextRetrievalResult {
  checkpoint: ContextCheckpoint;
  freshness: GraphFreshnessStatus;
  relatedFiles: GraphRelatedFile[];
  linkedDecisions: Array<{ id: string; title: string; status: string; rationale: string }>;
  diagnostics: GraphRetrievalDiagnostics;
  limitations: string[];
}
