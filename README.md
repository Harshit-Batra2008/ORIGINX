# ORIGINX - VS Code Extension

> **hackFront India 2026 Prototype**  
> Helping developers understand **why** selected code changed through local Git history and evidence-backed AI explanations natively powered by GitHub Copilot and the VS Code Language Model API (`vscode.lm`).

---

## Overview

ORIGINX is a developer productivity extension for Visual Studio Code that answers the question: **"Why was this code changed?"**
- **Local Git Inspection**: Fast, deterministic, and safe local Git inspection of line-range history (`git log -L`, `git blame`, unified diffs).
- **Copilot-Native AI Explanations**: Evidence-backed AI explanations strictly grounded in retrieved Git commits, distinguishing verified facts from AI inferences.
- **Zero External API Keys**: Directly utilizes models registered in VS Code (e.g., GitHub Copilot GPT-4o, Claude) via the official `vscode.lm` API—no external API keys, credit cards, or third-party cloud configurations required.
- **Command Center Hub**: A clean, two-command Command Palette surface with an interactive QuickPick Command Center for all settings, model exploration, and diagnostics.

---

## Key Features

### 1. Local Git History Inspection
- **Context Menu Integration**: Select any lines in your code editor, right-click, and choose **`ORIGINX: Why Was This Changed?`**.
- **Line-Evolution Tracing**: Uses Git's line history engine (`git log -L`) with automatic fallback to `git blame --line-porcelain` + `git show` to isolate changes affecting the exact selected lines.
- **Diff & Metadata Extraction**: Displays commit hashes, author metadata, commit timestamps, messages, and unified line diffs.
- **Dual Presentation**: Polished VS Code-native Webview panel alongside the editor + copy-friendly Output Channel.
- **Safe Execution**: All Git commands execute via `child_process.execFile` with argument arrays—zero shell interpolation.

### 2. Evidence-Backed Copilot AI Explanations
- **Native VS Code Language Model API (`vscode.lm`)**: Discovers and interacts dynamically with active Copilot models (`gpt-4o`, `gpt-4o-mini`, etc.) using `vscode.lm.selectChatModels()`.
- **Four Structured Sections**:
  1. **What Changed**: Concise syntactic and structural summary of code changes in the selected lines.
  2. **Possible Reasons**: Business and architectural motivations grounded strictly in commit messages. Explicitly outputs **"Original reason unknown"** if commit evidence is insufficient.
  3. **Supporting Commits**: Verified list of commits from Git history that directly contributed to the change. Anti-hallucination checks validate hashes against real Git history.
  4. **Uncertainty & Evidence Limitations**: Highlights missing context, squashed commits, or uncommitted local edits.
- **Token-Optimized Compact Prompts**: Prompts are optimized to use minimal input tokens (<350 tokens for common changes) while preserving all critical Git diffs and uncertainty rules.
- **Strict Fallback & Offline Resilience**: If Copilot is unavailable, if models are not registered, or if automatic analysis is disabled, local Git history is **100% accessible and preserved**.

### 3. ORIGINX Command Center & Simplified Command Palette
To keep your VS Code environment uncluttered, ORIGINX exposes **only two commands** in the main Command Palette (`Ctrl+Shift+P`):
1. **`ORIGINX: Why Was This Changed?`** (Primary code inspection command)
2. **`ORIGINX: Command Center`** (Interactive management and developer tools hub)

#### Command Center QuickPick Menu (`ORIGINX: Command Center`)
Selecting the Command Center opens an organized VS Code QuickPick menu:

##### GENERAL
- **`Explain Selected Code`**: Triggers immediate line history & AI analysis for the active editor selection.
- **`Explain Multiple Selected Files`**: Analyzes changes across multiple files selected in the Explorer file tree.
- **`Enable Automatic AI Analysis`**: Opt-in to automatic AI explanation on right-click (presents explicit privacy disclosure).
- **`Disable Automatic AI Analysis`**: Reverts right-click to instant local Git history only (zero network transmission).
- **`Multi-File Usage Confirmation`**: Toggle or restore the usage confirmation modal dialog before multi-file analysis.
- **`List Available AI Models`**: Discovers models registered with `vscode.lm` and displays details in a submenu (with Back navigation) and Output Channel.

##### DEVELOPER TOOLS
- **`Inspect Outgoing AI Payload`**: Previews the exact redacted JSON payload that would be sent to the model in a side editor without sending any data.
- **`View Technical Diagnostics`**: Shows active configuration, telemetry, security redactor status, and verified secret purge status.
- **`Open ORIGINX Output Channel`**: Focuses the dedicated ORIGINX logging channel for raw Git outputs and diagnostic logs.
- **`Show Extension Version / Environment Information`**: Displays extension version (0.2.0), VS Code host version, Node runtime, platform architecture, and `vscode.lm` API availability.

### 4. Configurable Keyboard Shortcut
- **Default Keybinding**:
  - **Windows / Linux**: `Ctrl+Alt+H`
  - **macOS**: `Cmd+Alt+H`
- **Context Condition**:
  - Operates when a text editor is active and a non-empty selection exists (`"when": "editorTextFocus && editorHasSelection"`).
  - Automatically reuses the identical Git analysis and Copilot explanation pipeline without creating duplicate handlers.
- **Customizing or Removing the Shortcut**:
  1. Open VS Code's Keyboard Shortcuts editor with `Ctrl+K Ctrl+S` (or `Cmd+K Cmd+S` on macOS), or navigate to **File** -> **Preferences** -> **Keyboard Shortcuts**.
  2. Search for `"ORIGINX"` or `"Why Was This Changed?"`.
  3. Click the edit pencil icon next to `ORIGINX: Why Was This Changed?` (or press `Enter`).
  4. Press your desired custom key combination and press `Enter` to confirm, or press `Delete` to remove the shortcut entirely.

### 5. Multi-File Selection & Usage Confirmation (Phase 4B.1)
- **Explorer Context Menu Integration**: Select one or multiple files in VS Code's File Explorer, right-click, and select **`ORIGINX: Why Were These Changed?`**.
- **Robust File Validation**:
  - Acceptable files: Local, readable, Git-tracked text files.
  - Safe Exclusions: Directories, duplicate selections, non-local URI schemes, broken symlinks, binary files (via extension check and 512-byte null-byte buffer inspection), and untracked files are excluded with transparent reasons recorded in the ORIGINX Output Channel.
  - Mixed Repository Awareness: If selected files originate from different Git repositories, ORIGINX flags this condition and discloses it in the usage confirmation.
- **Pre-Analysis Usage Confirmation Dialog**:
  - Displays selected file count and names.
  - Displays active AI model identifier and model context window capacity (if known).
  - Measures payload size using native `model.countTokens()` where supported, with clear labeled fallback to character approximation (~4 chars/token).
  - Discloses truncation or bounding warnings if diffs exceed safe limits (default 60,000 characters per file).
  - Provides **"Analyze"**, **"Don't Show Again"**, and **"Cancel"** actions.
  - Never claims knowledge of private remaining quota.
  - **Consent Boundary**: Skipping the confirmation dialog via "Don't Show Again" never bypasses the core `originx.enableAutomaticAnalysis` consent setting.
- **Preference Restoration**:
  - Controlled by `originx.showMultiFileConfirmation` setting (default `true`).
  - Users can restore or suppress the confirmation at any time via the Command Center or VS Code Settings.

---

## Security Model & Privacy Guarantees

1. **Automatic Secret Purge on Activation**:
   - In accordance with Phase 3B's Copilot-only architecture, any legacy Gemini API keys stored in VS Code `SecretStorage` are **automatically and idempotently purged** upon extension activation.
   - Deletion is actively verified via `hasApiKey() === false`.
   - Credentials are never logged, exported, or preserved.
2. **Zero External API Keys Stored**:
   - ORIGINX does not store, request, or require external cloud API keys. Authentication is managed securely and natively by GitHub Copilot and VS Code.
3. **Sensitive Token Scanning & Blocking**:
   - Before passing any repository content to the language model, ORIGINX scans the code snippet, commit messages, and diffs for sensitive credentials (unmasked Private Keys, AWS Keys, GitHub PATs, Slack Tokens, Stripe Keys).
   - If sensitive credentials are detected, transmission is **strictly blocked** with a clear explanation in the Output Channel.
4. **Prompt Injection & Instruction Defenses**:
   - All repository diffs and commit messages are wrapped in security fences instructing the model never to obey instructions contained inside user code.
5. **Restricted Webview CSP & HTML Escaping**:
   - Webviews enforce strict Content Security Policy (`default-src 'none'; style-src 'unsafe-inline'; script-src 'none';`) and escape all dynamic HTML to prevent XSS.

---

## Configuration Settings

| Setting | Default | Description |
|---|---|---|
| `originx.enableAutomaticAnalysis` | `false` | When `true`, right-clicking automatically sends code and diffs to GitHub Copilot for AI analysis. When `false` (default), only local Git history is displayed. |
| `originx.promptVariant` | `"compact"` | Prompt variant: `'compact'` optimizes for minimal token usage under 350 tokens; `'standard'` uses full prompt template. |
| `originx.showMultiFileConfirmation` | `true` | Show a usage and token estimation confirmation dialog before analyzing multiple files. |

---

## Setup & Running Tests

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile TypeScript:
   ```bash
   npm run compile
   ```

3. Run the offline automated test suite (85 tests running completely offline with zero live API calls):
   ```bash
   npm test
   ```

---

## How to Test in VS Code (Extension Development Host)

1. Open `originx-extension` in VS Code:
   ```bash
   code .
   ```
2. Press **`F5`** (or choose **Run and Debug** -> **Run ORIGINX Extension (Compile only)**).
3. In the new **[Extension Development Host]** window:
   - Press `Ctrl+Shift+P` -> type `ORIGINX: Command Center` to open the central hub.
   - Explore `List Available AI Models` or `Show Extension Version / Environment Information`.
   - Enable automatic analysis with `Enable Automatic AI Analysis`.
   - Open any file in a Git repo, select a few lines, and press **`Ctrl+Alt+H`** (or **`Cmd+Alt+H`** on macOS), or right-click -> **`ORIGINX: Why Was This Changed?`**.
   - Review the compact, VS Code theme-aware results panel with evidence-backed insights.
   - Test customization: Press `Ctrl+K Ctrl+S`, search for `"ORIGINX"`, and verify you can change or rebind the shortcut.
