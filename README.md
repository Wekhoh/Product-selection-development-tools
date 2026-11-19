# Product selection development tools

An independent, open-source product-selection tool for personal use and optional self-hosting.

**Current stage: Revision 58 offline scoring/economics engine and Phase 2A local SQLite operations chassis complete; bounded Phase 2B live acceptance next.** The offline runner applies 21 trial mappings (8 groups, 100 points) to explicit local evidence and produces self-contained Chinese cards. Revision 58 unifies authoritative card `qualification` (`comparable` flat 12-month annual or non-holiday-dependent `seasonal_eligible`), enforces pre-declared `expected_primary_scenarios` and isolated `stress_scenarios[]`, aligns `r_refund` vs `r_physical` excess returns processing, adds deterministic 2027 US common Standard-size FBA rate lookups (`src/fba-rates-2027.mjs`) with Gate 1A landed-domestic caps (`>= USD 29.99`, `order_units >= 100`, non-promo `sku_lines[]`), and adopts exact-rational `4 + 1` Q31 newcomer scoring with deterministic 5-quintile stratification. Phase 2A adds an offline built-in `node:sqlite` WAL store (`src/store.mjs`, `src/contracts.mjs`, `src/history-import.mjs`, `src/pipeline.mjs`, `src/phase2-cli.mjs`) for idempotent request/quota ledgers, permanent request locking, PII/token redaction, structured short-context validators, immutable evaluations, and non-blocking Gate 1A -> Gate 1B (`CAPTCHA_PAUSED`) -> Gate 2/3 orchestration. Frozen revisions 50–57 remain replayable with their matching profiles without retroactive fee-policy acceptance. Calibration, daily scheduling, and live Phase 2B acceptance remain open. Importing modules or the profile never starts external requests.

## Run the offline examples

Use Node.js 24 or newer; this repository has zero third-party npm dependencies and no embedded credentials.

```sh
node --test
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --output outputs/example
```

Open `outputs/example/index.html`. These cards are explicitly synthetic. For genuine research use the [input contract](docs/design/TRIAL-INPUT.md), keep batches, databases, ledgers, and outputs in ignored local directories (`.local/`, `data/`, `outputs/`), and retain original evidence. A missing total stays unknown; supported points are not scaled to 100. The CLIs only read supplied local files and never collect fresh external data, spend credits, contact suppliers, or change stores.

To include the reviewed source-word-to-form trail, add the optional discovery bundle:

```sh
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --discovery fixtures/synthetic-discovery.json --output outputs/example-linked
```

To inspect the Phase 2A local SQLite store on synthetic fixtures (without touching live provider accounts):

```sh
node src/phase2-cli.mjs init --db outputs/example-phase2.sqlite
node src/phase2-cli.mjs replay --db outputs/example-phase2.sqlite --batch fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --discovery fixtures/synthetic-discovery.json
node src/phase2-cli.mjs status --db outputs/example-phase2.sqlite
```

This keeps original source rows and their separate metrics, validates explicit research dispositions and concrete-offer references, records immutable evaluation receipts, and shows the trail beside the existing scores. It does not classify words automatically or add discovery bonuses. Actual research and supplier authentication still run through authorized tools; a successful offline replay is not unattended discovery acceptance.

## Start here

- [Project state and next steps](docs/STATE.md) — the single task and recovery record.
- [Review and takeover context](docs/CONTEXT-ROUTER.md) — causal history, planning/decision/source routes, code and verification entry points; use with STATE when another coding agent reviews or refactors the project.
- [Product requirements](docs/PRODUCT.md) — intended workflow and acceptance.
- [Decisions and unresolved questions](docs/design/DECISIONS.md) — confirmed preferences, exceptions, and superseded proposals.
- [Reference profile](docs/design/reference-profile.draft.json) — 21 trial items, unchanged 100-point budget and current-category newcomer simplification; real-world calibration remains open.
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

The current owner handoff prepares review and possible continuation in AntiGravity/Gemini; it does not establish that platform's tool access or completed adoption. On this owner's machine, existing ignored evidence enables the real-card replay in STATE. A GitHub-only clone has source, specifications and synthetic examples; it does not contain genuine cards, supplier quotations or live request ledgers. Preserve that boundary when transferring work.

In the Codex app, add this folder as a local project; existing chat membership and folder access are separate from cloning. Use the offline example above to verify the calculation and reading path without any external account.

Licensed under [Apache 2.0](LICENSE).
