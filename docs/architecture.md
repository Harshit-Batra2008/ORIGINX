# Code Continuity architecture

| Responsibility | Source and disposition |
|---|---|
| Extension activation and workflow | Retain `extension.ts` for existing analysis and graph commands. Consolidate memory and handoff command registration in `continuity/commands.ts`. |
| Repository evidence | Retain `git/` for blame and log evolution. Share working-tree status parsing, source-path filtering and bounded Git co-change retrieval. |
| Graph indexing and retrieval | Retain `neo4j/` and the Neo4j driver. Index repository-scoped commits and changed paths. Checkpoint retrieval checks the current HEAD before using graph evidence. |
| Developer intent | Retain the decisionMemory and contextCheckpoint serializers, validators, storage locations and record schemas. Use repository-contained paths for reads, writes and panel navigation. |
| Context and impact | Consolidate suggested checkpoint targets in `context/` and co-change aggregation in `impact/`. Review, investigation, multi-file and unified services remain available. |
| AI reasoning | Retain the VS Code model transport and evidence-grounded prompts. The historical `gemini/` module uses the VS Code model API. Legacy credential cleanup remains available. |
| Interface | Consolidate the command palette into four actions. The former command-center ID opens Understand & Continue. Retain Explorer multi-file analysis, SCM review, and the focused-history shortcut. |
| Security and diagnostics | Retain credential scanning, SecretStorage, diagnostics and output-channel reporting. Explicit decision verification remains a human action. |

## Repository inventory

Retain the extension manifest, lockfile, TypeScript and editor configuration, license, test suites, example environment file, icon sources and the canonical Marketplace preview. Retain the icon generator, source archive helper and optional live Neo4j connectivity check. The latter reuses the compiled environment loader. Remove the byte-identical alternate extension preview and unused historical transport/comparison types. The website has its own package and independent assets. Historical VSIX files and source archives are local release artifacts.

The old submission checklist described the 0.2.0 release. These architecture notes replace it on the development branch. The separate change-impact branch retains its experimental scoring and full interface. This baseline uses historical co-changes and current working-tree status when suggesting files to inspect.

## Verification and next milestone

Run `npm test` for Git, review, investigation, language-model fixtures, graph integration, decisions and checkpoint regressions. Use a disposable configured Neo4j database to verify a live import and resume. Existing local-only or non-GitHub indexes may need reimport under the repository-scoped identifier. Existing GitWhisper Markdown records require no migration.

The next milestone is a read-only handoff brief that cites a checkpoint, decision IDs and commit hashes for each proposed next step. Evaluate it against a second developer picking up a fixture repository.
