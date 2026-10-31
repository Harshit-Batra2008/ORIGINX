# GitWhisper by ORIGINX: Why The Code Is Like This

> **hackFront India 2026 Prototype**  
> **Problem Statement PS T1.1: “Why The Code Is Like This”**  
> **GitWhisper by ORIGINX** — An AI-powered VS Code extension providing evidence-grounded code history explanations by combining local Git line evolution with Neo4j Knowledge Graph provenance, natively driven by GitHub Copilot (`vscode.lm`).

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.85.0-007ACC.svg)](https://code.visualstudio.com/)
[![Neo4j](https://img.shields.io/badge/Neo4j-AuraDB-008CC1.svg)](https://neo4j.com/cloud/platform/aura-graph-database/)
[![Tests](https://img.shields.io/badge/Tests-169%20Passed-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Executive Summary

Software engineering often answers *what* code does through comments and syntax, but rarely captures *why* it was written that way. When debugging legacy systems, reviewing pull requests, or onboarding onto unfamiliar repositories, developers spend hours wading through Git blame, PR discussions, and fragmented commit histories to reconstruct architectural intent.

**GitWhisper** (by team **ORIGINX**) solves problem statement **PS T1.1 (“Why The Code Is Like This”)** by turning code archaeology into a fast, transparent, and evidence-grounded experience:
1. **Local Git Line Evolution**: Pinpoints exact commit hunks, timestamps, authors, and diffs for any selected code lines.
2. **Neo4j Knowledge Graph Provenance**: Cross-references repository-level file modifications, commit relationships, and author networks stored in Neo4j AuraDB.
3. **Copilot-Native AI Synthesis**: Synthesizes verified change narratives using VS Code's native Language Model API (`vscode.lm`), strictly distinguishing verified facts from plausible inferences and stating `"Original reason unknown"` when documentation is missing.
4. **Zero Third-Party Cloud Keys**: Operates entirely with native GitHub Copilot chat models (`gpt-4o`, `gpt-4o-mini`, `claude`) and local Git execution. No credit cards, external Gemini/OpenAI API keys, or leaked credentials.

![ORIGINX Preview](assets/originx-preview.png)
*Figure 1: GitWhisper by ORIGINX visual concept and design preview (illustrative design preview representing the UI architecture, evidence tabs, and reasoning labels; actual extension uses native VS Code theme integration).*

---

## Architecture

ORIGINX connects the code editor, local version control, remote graph database, and native language models in a modular, secure pipeline:

```mermaid
flowchart TD
    subgraph Editor ["VS Code Editor"]
        Selection["User Selection (Line Range)"]
        Context["Right-Click Menu / Ctrl+Alt+H"]
    end

    subgraph GitEngine ["Local Git Subsystem"]
        GitLog["git log -L (Line Evolution)"]
        GitBlame["git blame & git show (Fallback)"]
        GitDiff["Unified Diff Parser & Redactor"]
    end

    subgraph GraphEngine ["Neo4j Knowledge Graph"]
        AuraDB[("Neo4j AuraDB\n(Repository Subgraph)")]
        Retriever["neo4jEvidenceRetriever\n(MATCH c:Commit -> f:File)"]
        AuthHelper["SecretStorage Credential Resolver"]
    end

    subgraph Grounding ["Grounding & Security"]
        Dedup["calculateEvidenceCounts\n(Full-Hash Deduplication)"]
        Sanitizer["scanAndSanitize\n(Regex Credential Blocker)"]
        PromptBuilder["Prompt Builder\n(Anti-Injection Fencing)"]
    end

    subgraph AI ["AI Engine (vscode.lm)"]
        Copilot["GitHub Copilot Models\n(gpt-4o, gpt-4o-mini)"]
        Parser["Response Parser & Hash Verifier"]
    end

    subgraph UI ["Presentation"]
        Webview["VS Code Themed Webview Panel\n(Dual View: Narrative + Collapsible Evidence)"]
        Output["ORIGINX Output Channel"]
    end

    Selection --> Context
    Context --> GitLog
    GitLog --> GitDiff
    Context --> Retriever
    AuthHelper --> Retriever
    Retriever <--> AuraDB
    GitDiff --> Dedup
    Retriever --> Dedup
    Dedup --> Sanitizer
    Sanitizer --> PromptBuilder
    PromptBuilder --> Copilot
    Copilot --> Parser
    Parser --> Webview
    Parser --> Output
    GitDiff --> Webview
```

### Component Breakdown
- **Git Retrieval Service (`src/git/gitService.ts`)**: Runs `git log -L` and `git blame --porcelain` via safe `child_process.execFile` without shell interpolation.
- **Neo4j Evidence Retriever (`src/neo4j/neo4jEvidenceRetriever.ts`)**: Executes read-only, parameterized Cypher queries scoped strictly by repository identifier (`repoId`), pulling historical commit dates, subjects, bodies, authors, and change types (`ADDED`, `MODIFIED`, `DELETED`, `RENAMED`).
- **SecretStorage & Security Manager (`src/security/secretManager.ts`)**: Safely persists Neo4j database credentials in VS Code's encrypted `SecretStorage`. Automatically purges legacy unencrypted keys on activation.
- **Credential Redaction & Security Fence (`src/neo4j/neo4jEnv.ts`, `src/gemini/geminiPrompt.ts`)**: Scans code and diffs with regex patterns for private keys, AWS tokens, GitHub PATs, and bearer tokens, blocking AI transmission if secrets are detected.
- **Evidence Deduplicator (`src/ui/webviewView.ts`)**: Reconciles local line-blame commits with Neo4j graph records by canonical full 40-character commit hashes, clearly differentiating total evidence records from unique commits.
- **Copilot Language Model Client (`src/lm/vscodeLmClient.ts`, `src/gemini/geminiExplainer.ts`)**: Interfaces dynamically with models registered under `vscode.lm.selectChatModels()`.

---

## How Git & Neo4j Evidence Ground Explanations

Large language models are prone to hallucinating plausible-sounding reasons for code changes. ORIGINX eliminates guesswork by enforcing strict evidence grounding:

1. **Multi-Source Evidence Aggregation**:
   - **Local Git Blame**: Provides precise, line-level diff hunks for the exact selected region.
   - **Neo4j Knowledge Graph**: Supplies historical context, parent commits, file rename lineages, and cross-commit relationships.
2. **Canonical Deduplication**:
   - In multi-source analyses, a single commit often appears in both line blame and repository graph history. ORIGINX deduplicates by full 40-character SHA-1 hash (with 7-character prefix collision guards), displaying accurate metrics (e.g. *“Supporting Evidence Records (9) — 5 Unique Commits”*).
3. **Structured Explanation Format**:
   - **What Changed**: Structural and syntactic summary strictly observed from diffs.
   - **Possible Reasons**: Architectural motivations classified as `[Verified]`, `[Inferred]`, or `[Unknown]`. If commit messages are non-descriptive (e.g. `"update"`, `"wip"`), it explicitly outputs **“Original reason unknown”**.
   - **Supporting Commits**: Real commit citations. The parser verifies cited hashes against retrieved evidence; hallucinated hashes are flagged immediately.
   - **Uncertainty & Limitations**: Explicitly notes uncommitted changes, truncated lines, or lack of architectural rationale.

---

## Key Features & User Interface

### 1. Line-Level Code Inspection
Select any block of code, right-click, and select **`ORIGINX: Why Was This Changed?`** (or press `Ctrl+Alt+H` / `Cmd+Alt+H`).
- Displays a dedicated, VS Code-themed Webview beside your code.
- Summarizes the change rationale with badges indicating the model (`copilot/gpt-4o-mini`) and Neo4j grounding status.
- Collapsible detailed evidence view showing full unified diffs, authors, timestamps, and full 40-character commit hashes.

### 2. Multi-File History & Cross-File Reasoning
Select multiple files in the Explorer tree, right-click, and select **`ORIGINX: Why Were These Changed?`**.
- Inspects change history across multiple files simultaneously.
- Provides a cross-file relationship overview and individual per-file breakdowns.
- Features a themed confirmation modal estimating token usage and file eligibility.

### 3. GitWhisper Command Center (`Ctrl+Shift+P` -> `ORIGINX: Command Center`)
To maintain a clutter-free Command Palette, GitWhisper by ORIGINX exposes a centralized QuickPick action hub:
- **GENERAL**:
  - `Explain Selected Code`
  - `Explain Multiple Selected Files`
  - `Enable Automatic AI Analysis` / `Disable Automatic AI Analysis`
  - `List Available AI Models`
  - `Import Git History to Neo4j Knowledge Graph`
  - `Inspect Neo4j Evidence Graph`
  - `Clean Up Repository Subgraph in Neo4j`
- **DEVELOPER TOOLS**:
  - `Inspect Outgoing AI Payload` (inspect JSON payload in side editor without sending)
  - `View Technical Diagnostics`
  - `Open ORIGINX Output Channel`
  - `Manage Neo4j Database Credentials`

---

## Configuration Settings

All options can be configured in VS Code Settings (`Ctrl+,` -> search `originx`):

| Setting | Default | Description |
|---|---|---|
| `originx.enableAutomaticAnalysis` | `false` | When `true`, automatically queries Copilot LM on selection. When `false` (default), displays instant local Git history without network transmission. |
| `originx.promptVariant` | `"compact"` | Prompt variant: `'compact'` minimizes tokens (<350 tokens); `'standard'` uses full prompt template. |
| `originx.showMultiFileConfirmation` | `true` | Displays token estimation and file count confirmation before multi-file analysis. |
| `originx.neo4jUri` | `"neo4j+s://f46dba8b.databases.neo4j.io"` | Connection URI for the Neo4j AuraDB instance. |
| `originx.neo4jUsername` | `"f46dba8b"` | Configurable database username (defaults to AuraDB instance user). |
| `originx.neo4jDatabase` | `""` | Target Neo4j database name (leave empty for default database). |
| `originx.neo4jExcludedDirectories` | `["node_modules", "dist", "build", "coverage", ...]` | Path segments excluded from graph ingestion. |

---

## Installation & Setup

### Option A: Install from VSIX Package (Recommended for Judges)
1. Download the pre-built `originx-extension-0.2.0.vsix` package.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
3. Click the **`...`** (Views and More Actions) menu in the top right of the Extensions pane.
4. Select **Install from VSIX...** and choose `originx-extension-0.2.0.vsix`.
5. Ensure GitHub Copilot or GitHub Copilot Chat is installed and active in VS Code.

### Option B: Build & Run from Source
1. **Clone the repository**:
   ```bash
   git clone https://github.com/Harshit-Batra2008/ORIGINX.git
   cd ORIGINX
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Compile TypeScript**:
   ```bash
   npm run compile
   ```

4. **Run the offline automated test suite**:
   ```bash
   npm test
   ```
   *(All 165 tests run completely offline without requiring network access or database credentials.)*

---

## How to Run the Demo

Follow these simple steps for a live demonstration:

1. **Launch Extension Development Host**:
   - Open the project in VS Code (`code .`).
   - Press **`F5`** (or Run -> Start Debugging). An `[Extension Development Host]` window will open.

2. **Configure AI & Neo4j (First-time setup)**:
   - In the Extension Development Host window, press `Ctrl+Shift+P` -> select **`ORIGINX: Command Center`**.
   - Choose **`Enable Automatic AI Analysis`** (allows Copilot LM queries on code selection).
   - Choose **`Manage Neo4j Database Credentials`** -> **`Test Neo4j Connection`** (or enter password if prompted; credentials are saved in VS Code's encrypted SecretStorage).

3. **Demo Scenario 1: Why Was This Changed?**:
   - Open any source file in a Git repository (e.g. `src/main.jsx` or `README.md`).
   - Select 2–10 lines of code.
   - Right-click and choose **`ORIGINX: Why Was This Changed?`** (or press `Ctrl+Alt+H`).
   - Observe the Webview side panel displaying:
     - The AI explanation with `[Verified]` and `[Inferred]` rationale.
     - The supporting evidence summary: e.g., *“Supporting Evidence Records (9) — 5 Unique Commits”*.
     - Collapsible code snippet and detailed diff sections.

4. **Demo Scenario 2: Offline Resilience (No AI / No Database)**:
   - Run `ORIGINX: Command Center` -> choose **`Disable Automatic AI Analysis`**.
   - Select code and run `ORIGINX: Why Was This Changed?`.
   - Observe that full local Git history, diffs, authors, and commit messages render instantly without sending data over the network.

5. **Demo Scenario 3: Inspect AI Payload (Privacy & Transparency)**:
   - Select code in an editor.
   - Open Command Center -> choose **`Inspect Outgoing AI Payload`**.
   - View the sanitized JSON payload (with system prompts, Git diffs, and Neo4j graph records) rendered in a side editor without transmitting any data.

---

## Automated Test Suite

ORIGINX includes a comprehensive, 100% offline test suite validating all core subsystems:
- **Git Engine**: Standard & porcelain log parsing, line tracking, empty repositories, untracked files, uncommitted changes.
- **Security & Privacy**: Private key detection, AWS key redaction, PAT redaction, SecretStorage purge migrations, payload sanitization.
- **AI Explainer & Prompts**: Prompt injection defenses, 4-section parsing, hallucinated hash detection, compact prompt bounds (<350 tokens).
- **VS Code Language Model Client**: Model discovery, error category mappings, token cancellations, streaming response assembly.
- **Multi-File Reasoning**: Binary buffer detection, eligible file filters, cross-file prompt building, confirmation modal behaviors.
- **Neo4j Knowledge Graph**: Path normalization, name-status parsing, repository namespacing, idempotent MERGE queries, repository-scoped evidence retrieval, and exclusivity-guarded graph pruning.
- **Evidence Deduplication**: Canonical full-hash deduplication, prefix matching, and Webview count summaries.

```text
====================================================
Test Results: 165 passed, 0 failed
====================================================
```

---

## Current Limitations

- **VS Code Language Model API Dependency**: AI synthesis requires an active language model provider in VS Code (e.g., GitHub Copilot extension active with access to `copilot/gpt-4o` or `copilot/gpt-4o-mini`). When unavailable, ORIGINX gracefully falls back to complete local Git history.
- **Line Evolution Bounded Range**: To ensure responsive editor performance, line-level Git history traces are bounded to recent commits.
- **Graph Ingestion Scope**: Ingestion into Neo4j AuraDB captures commit metadata, file modifications, and author attribution; actual code diff contents are kept local to respect repository privacy.

---

## License

This project is licensed under the [MIT License](LICENSE).
