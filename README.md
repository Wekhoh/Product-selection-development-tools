# Product selection development tools

An independent, open-source product-selection tool for personal use and optional self-hosting.

**Current stage: bounded discovery-to-card implementation and real-data trials.** The offline runner applies the 21 adopted revision-50 mappings to explicit local evidence and produces Chinese cards. Native research still runs through the authorized Codex tools; daily scheduling and full application acceptance remain open. Importing modules or the profile never starts requests.

## Run the offline example

Use Node.js 24 or newer; this slice has no package dependencies or credentials.

```sh
node --test
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --output outputs/example
```

Open `outputs/example/index.html`. These cards are explicitly synthetic. For genuine research use the [input contract](docs/design/TRIAL-INPUT.md), keep the batch and outputs in ignored local directories, and retain original evidence. A missing total stays unknown; supported points are not scaled to 100. The CLI only reads supplied files and does not collect fresh data, spend credits, contact suppliers or change stores.

## Start here

- [Project state and next steps](docs/STATE.md) — the single task and recovery record.
- [Product requirements](docs/PRODUCT.md) — intended workflow and acceptance.
- [Decisions and unresolved questions](docs/design/DECISIONS.md) — confirmed preferences, exceptions, and superseded proposals.
- [Reference profile](docs/design/reference-profile.draft.json) — 21 adopted trial item mappings and revision-50 shared scoring rules; real-world validation and calibration remain open.
- [Migration boundaries](docs/MIGRATION.md) — what is retained and what needs redesign.
- [Provider integration handoff](docs/API-MIGRATION.md) — preserved API behavior, unresolved compatibility, and cost continuity.

The public repository contains methods, design documents, reviewed reusable code when adopted, and synthetic examples. Each installation owns its credentials, research results, quotations, spending records, and other private data. Those do not belong in public Git history.

The first version is for its owner's use. Other developers may inspect, fork, or adapt the source. A hosted multi-user service is outside the current scope.

## Development workspace

The project has adopted trial definitions and a bounded implementation. Its documents distinguish confirmed decisions, proposals, source limitations and verified behavior.

| Start here | Purpose |
| --- | --- |
| [Current state](docs/STATE.md) | Current outcome, plan, evidence, blockers and exact next step |
| [Product requirements](docs/PRODUCT.md) and [decisions](docs/design/DECISIONS.md) | What the tool must do, why, and what remains open |
| [Domain glossary](GLOSSARY.md) | Shared meanings for discovery, candidates, evidence and scores |
| [First-release draft](docs/design/FIRST-RELEASE.draft.md) | Complete workflow and acceptance; bounded offline-card slice ready, broader product choices open |
| [Scoring profile](docs/design/reference-profile.draft.json) | Confirmed trial weights and 21 item mappings; not active runtime configuration or a calibrated model |
| [Development workflow](docs/DEVELOPMENT.md) | Matt Pocock skill usage, specification, task breakdown, review and recovery |

Use this checkout as a separate project's primary folder. Start new chats here and read `AGENTS.md` and `docs/STATE.md`. Do not attach the retired operations repository as a prerequisite. Additional contributors should use separate branches/worktrees with explicit file ownership.

In the Codex app, add this folder as a local project; existing chat membership and folder access are separate from cloning. Use the offline example above to verify the calculation and reading path without any external account.

Licensed under [Apache 2.0](LICENSE).
