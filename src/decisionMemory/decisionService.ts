/**
 * GitWhisper Decision Memory — Public Service API
 * Independent of VS Code Webviews or UI layers.
 */

import { DecisionStorage } from './decisionStorage';
import {
  CreateDecisionInput,
  DecisionMemoryRecord,
  DecisionSearchQuery,
  DecisionSearchResult,
  DecisionStatus,
  DisputeDecisionInput,
  UpdateDecisionInput,
  VerifyDecisionInput
} from './decisionTypes';

export class DecisionMemoryService {
  private readonly storage: DecisionStorage;

  constructor(storage?: DecisionStorage) {
    this.storage = storage || new DecisionStorage();
  }

  /**
   * Creates a new DecisionMemoryRecord and persists it to .gitwhisper/decisions/.
   * All newly created records start in 'proposed' status (or 'disputed').
   */
  public async createDecision(
    repoRoot: string,
    input: CreateDecisionInput
  ): Promise<DecisionMemoryRecord> {
    return this.storage.createDecision(repoRoot, input);
  }

  /**
   * Retrieves a DecisionMemoryRecord by ID. Returns null if not found.
   */
  public async getDecision(
    repoRoot: string,
    id: string
  ): Promise<DecisionMemoryRecord | null> {
    return this.storage.getDecision(repoRoot, id);
  }

  /**
   * Lists all stored decision records with optional status, file path, or tag filtering.
   */
  public async listDecisions(
    repoRoot: string,
    filter?: {
      status?: DecisionStatus | DecisionStatus[];
      filePath?: string;
      tag?: string;
    }
  ): Promise<DecisionMemoryRecord[]> {
    return this.storage.listDecisions(repoRoot, filter);
  }

  /**
   * Updates an existing decision record with validated partial modifications.
   */
  public async updateDecision(
    repoRoot: string,
    id: string,
    changes: UpdateDecisionInput
  ): Promise<DecisionMemoryRecord> {
    return this.storage.updateDecision(repoRoot, id, changes);
  }

  /**
   * Explicit human verification lifecycle operation.
   * Records human reviewer attribution, verification note, and timestamp.
   */
  public async verifyDecision(
    repoRoot: string,
    id: string,
    verifier: VerifyDecisionInput
  ): Promise<DecisionMemoryRecord> {
    return this.storage.verifyDecision(repoRoot, id, verifier);
  }

  /**
   * Explicit dispute lifecycle operation.
   * Flags obsolete, disputed, or questionable architectural choices.
   */
  public async disputeDecision(
    repoRoot: string,
    id: string,
    disputer: DisputeDecisionInput
  ): Promise<DecisionMemoryRecord> {
    return this.storage.disputeDecision(repoRoot, id, disputer);
  }

  /**
   * Searches decision memory across title, rationale, constraints, file paths, and tags.
   */
  public async searchDecisions(
    repoRoot: string,
    query: DecisionSearchQuery
  ): Promise<DecisionSearchResult[]> {
    return this.storage.searchDecisions(repoRoot, query);
  }

  /**
   * Retires an architectural decision, preserving its historical record and recording retirement reason.
   */
  public async retireDecision(
    repoRoot: string,
    id: string,
    reason: string
  ): Promise<DecisionMemoryRecord> {
    return this.storage.retireDecision(repoRoot, id, reason);
  }

  /**
   * Explicitly and permanently deletes a decision file. Requires confirmDestructive: true.
   */
  public async deleteDecision(
    repoRoot: string,
    id: string,
    confirmDestructive: boolean = false
  ): Promise<boolean> {
    return this.storage.deleteDecision(repoRoot, id, confirmDestructive);
  }
}

// Default singleton instance for convenience
const defaultService = new DecisionMemoryService();

/**
 * Public functional API wrappers
 */
export async function createDecision(
  repoRoot: string,
  input: CreateDecisionInput
): Promise<DecisionMemoryRecord> {
  return defaultService.createDecision(repoRoot, input);
}

export async function getDecision(
  repoRoot: string,
  id: string
): Promise<DecisionMemoryRecord | null> {
  return defaultService.getDecision(repoRoot, id);
}

export async function listDecisions(
  repoRoot: string,
  filter?: {
    status?: DecisionStatus | DecisionStatus[];
    filePath?: string;
    tag?: string;
  }
): Promise<DecisionMemoryRecord[]> {
  return defaultService.listDecisions(repoRoot, filter);
}

export async function updateDecision(
  repoRoot: string,
  id: string,
  changes: UpdateDecisionInput
): Promise<DecisionMemoryRecord> {
  return defaultService.updateDecision(repoRoot, id, changes);
}

export async function verifyDecision(
  repoRoot: string,
  id: string,
  verifier: VerifyDecisionInput
): Promise<DecisionMemoryRecord> {
  return defaultService.verifyDecision(repoRoot, id, verifier);
}

export async function disputeDecision(
  repoRoot: string,
  id: string,
  disputer: DisputeDecisionInput
): Promise<DecisionMemoryRecord> {
  return defaultService.disputeDecision(repoRoot, id, disputer);
}

export async function searchDecisions(
  repoRoot: string,
  query: DecisionSearchQuery
): Promise<DecisionSearchResult[]> {
  return defaultService.searchDecisions(repoRoot, query);
}

export async function retireDecision(
  repoRoot: string,
  id: string,
  reason: string
): Promise<DecisionMemoryRecord> {
  return defaultService.retireDecision(repoRoot, id, reason);
}

export async function deleteDecision(
  repoRoot: string,
  id: string,
  confirmDestructive: boolean = false
): Promise<boolean> {
  return defaultService.deleteDecision(repoRoot, id, confirmDestructive);
}
