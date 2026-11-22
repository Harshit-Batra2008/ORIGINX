# GitWhisper by ORIGINX (v0.3.7)

**GitWhisper** (by team **ORIGINX**) answers the foundational engineering questions:
> **"Why The Code Is Like This"** and **"What Is Its Role, Impact & Evolution Across The Project"**

GitWhisper goes beyond traditional Git blame by connecting commit history, pull requests, issue discussions, architecture decision records (ADRs), language provider symbol analysis, and live Neo4j AuraDB knowledge graphs into an inspectable chain of engineering evidence.

![GitWhisper evidence view](assets/originx-marketplace-preview.png)

---

## Key Capabilities

### 1. Flagship "Ask Why" Experience
- **Editor Context Menu & Sidebar:** Highlight unfamiliar code and run **GitWhisper: Ask Why** (`Ctrl+O, Ctrl+X` or via the Activity Bar sidebar).
- **Evidence-Backed Answers:** Natural-language answers citing genuine pull request descriptions, commit SHAs, and architectural documentation.
- **Strict Anti-Hallucination & Honesty:** Explicitly abstains with `INSUFFICIENT HISTORICAL EVIDENCE` when historical sources do not record the technical rationale for a change. Absence of evidence is honestly presented as unverified rather than falsely claimed as "current".
- **Two-Level Interface:**
  - **Level 1 (Activity Bar Sidebar):** Lightweight, persistent quick-lookup panel with confidence badges, supersession status, and top citations.
  - **Level 2 (Full Investigation Webview):** 5-section in-depth investigation covering Rationale, Commits & PRs, Knowledge Graph & ADRs, Code Diffs, and Diagnostics.

### 2. Function Role & Impact Analysis (`originx.explainRoleAndImpact`)
- **Symbol & Enclosing Scope Resolution:** Automatically resolves the enclosing function, method, or class.
- **Project-Wide Static Callers:** Uses VS Code language providers to find production references and callers throughout the project.
- **Test File Corroboration:** Segregates test references from production usage, identifying existing test coverage.
- **Blast Radius & Inferred Impact:** Computes potentially affected files, co-change history, and warns of breaking changes.
- **Graceful Degradation:** Clearly indicates whether static language providers are active or if results rely on AST/Git fallback.

### 3. Requirements & PRD Audit Ledger (`originx.auditRequirements`)
- **Markdown PRD & TASKS.md Auditing:** Accepts Markdown PRDs, `TASKS.md`, or pasted numbered checklists.
- **Stable Requirement IDs:** Assigns persistent IDs (e.g., `REQ-001`, `REQ-002`) to each requirement.
- **Conservative Status Ledger:**
  - `VERIFIED`: Proven by relevant passing automated tests.
  - `IMPLEMENTED, NOT VERIFIED`: Implementation files found, but test verification is absent.
  - `PARTIAL`: Some clauses matched, others unverified.
  - `NOT FOUND IN SCANNED SCOPE`: No matching symbols or files found (never claims proven absence).
  - `INSUFFICIENT EVIDENCE`: Ambiguous requirements or insufficient project context.
- **Actionable Gap Analysis:** Highlights remaining gaps and suggests immediate next engineering actions.

### 4. Multi-PR Function Evolution (`originx.functionEvolution`)
- **Multi-Commit Line-Range Tracing:** Traces all meaningful commits and PRs that modified a selected function over time.
- **Semantic Commit Roles:** Automatically classifies commits as `origin`, `bug_fix`, `refactor`, `feature`, `formatting`, or `current`.
- **Supersession & Rationale Drift:** Flags earlier decisions that have been superseded by subsequent architectural changes.

### 5. Explain Code Walkthrough (`originx.explainCode`)
- **Ground-Truth Structural Explanation:** Explains *what* code does and *how* it functions (regex, control flow, async patterns, edge cases) without requiring historical commits.
- **Seamless Ask Why Handoff:** Available directly as a fallback inside the Ask Why webview when historical rationale is unavailable.

### 6. Live Neo4j AuraDB GraphRAG Retrieval
- **Connected Knowledge Graph:** Links Repositories, Commits, Modified Files, Extracted Code Functions, Authors, Pull Requests, Issues, and Decisions into a unified graph.
- **Safe Multi-Repository Isolation:** Repository-scoped queries and idempotent `MERGE` operations guarantee multi-tenant repository boundaries are strictly preserved.
- **Deterministic Offline Fallback:** If Neo4j is offline or credentials are not configured, GitWhisper automatically falls back to local Git blame, commit logs, and repository documentation without breaking the user experience.

### 7. Evidence Integrity & Decision Memory
- **Rigorous Supersession Verification:** A later commit modifying the same file does not falsely mark an earlier decision as superseded unless convincing evidence exists (e.g., explicit Git revert commits or replacement statements).
- **Provisional Decision Tracking:** Extracted decisions from pull requests are marked as provisional until backed by explicit decision records.
- **Context Checkpoints:** Save and resume developer progress, working-tree changes, and unfinished intent across work sessions under `.gitwhisper/checkpoints/`.

---

## Installation & Setup

### Installing the VSIX
1. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the `...` menu in the upper-right corner and select **Install from VSIX...**.
3. Choose `originx-extension-0.3.7.vsix` (or run `code --install-extension originx-extension-0.3.7.vsix --force`).
4. Reload VS Code (`Developer: Reload Window`).

### Configuring Neo4j AuraDB (Optional)
Neo4j is optional. Without it, GitWhisper functions fully via local Git history, AST parsing, and language providers.
To enable the live AuraDB knowledge graph:
1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **ORIGINX: Manage Neo4j Credentials**.
2. Configure your Neo4j URI (`neo4j+s://...`) and username.
3. Save your password into VS Code `SecretStorage` or place credentials in a git-ignored `.env` file (`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`). Credentials are never committed or exposed in logs.
4. Run **Test Neo4j AuraDB Connection** to verify connectivity.

---

## Privacy & Security

- **Local Execution:** Blame, file history, working tree status, and AST entity parsing run locally on your machine.
- **Credential Scanning & Redaction:** Outbound language model prompts and database errors are scrubbed for API keys, bearer tokens, private keys, and passwords before transmission.
- **Safe Graph Storage:** Code diffs, credentials, and file contents are never stored in the Neo4j knowledge graph—only structural metadata (hashes, paths, function identifiers, PR URLs).

---

## Limitations & Boundaries

1. **Evidence Grounding:** GitWhisper reports only what is corroborated by repository artifacts. If a past author made changes without documentation or descriptive commit/PR messages, GitWhisper will honestly report insufficient evidence.
2. **Provisional Decisions:** Automatically extracted decisions are labeled provisional; "No supersession found in inspected evidence" reflects inspected history rather than an unconditional permanent guarantee.
3. **Repository Scope:** Multi-repository queries maintain strict boundaries; cross-repository dependencies are not inferred without explicit graph links.

---

## Development & Testing

```bash
# Install dependencies
npm ci

# Compile TypeScript
npm run compile

# Run the full automated test suite (304 tests)
npm test

# Build developer preview VSIX
npx @vscode/vsce package --no-git-tag-version
```

All 304 tests in the automated suite execute in isolated environments with temporary repositories and mock drivers. Press **F5** in VS Code to launch the Extension Development Host.
