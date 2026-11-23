# Product selection development tools

An independent, open-source product-selection tool for personal use and optional self-hosting.

**Current stage: Revision 58/59 offline scoring/economics engine, Curatorial Studio (`01 视觉策展室`) HTML report, Phase 2/3 SQLite multi-channel operations, deterministic `ingest-trial` raw-receipt provenance ingester, and Scheme A `src/openai/` + subscription `Codex CLI` integration complete.** The offline runner applies 21 trial mappings (8 groups, 100 points) to explicit local evidence and produces self-contained script-free Chinese decision cards. Revision 58 (`docs/design/reference-profile.draft.json`) unifies authoritative card `qualification` (`comparable` flat 12-month annual or non-holiday-dependent `seasonal_eligible`), enforces pre-declared `expected_primary_scenarios` and isolated `stress_scenarios[]`, aligns `r_refund` vs `r_physical` excess returns processing, adds deterministic 2027 US common Standard-size FBA rate lookups (`src/fba-rates-2027.mjs`) with Gate 1A landed-domestic caps (`>= USD 29.99`, `order_units >= 100`, non-promo `sku_lines[]`), and adopts exact-rational `4 + 1` Q31 newcomer scoring with deterministic 5-quintile stratification; Revision 59 (`docs/design/reference-profile.r59.draft.json`) extends this with 3-Tier Progressive Suggested Bids, crossing-`30%` linear margin slope extension, all 36 official 2027 return-rate categories + 4 Bulky tiers, `target_child_units` grain, `private_mold_reserved` pooling, and zero-glue raw-receipt ingestion (`src/raw-ingest.mjs`). Phase 2/3 adds an offline built-in `node:sqlite` WAL store (`src/store.mjs`, `src/contracts.mjs`, `src/history-import.mjs`, `src/pipeline.mjs`, `src/phase2-cli.mjs`) for multi-channel discovery planning, Stage-1 mainstream price-band denoising, Stage-2 `4x4` contact sheets, idempotent 4-lane request/quota ledgers, PII/token redaction, immutable evaluations, and non-blocking Gate 1A -> Gate 1B (`CAPTCHA_PAUSED`) -> Gate 2/3 orchestration. Under Scheme A (`src/openai/`), deterministic code retains 100% authority over FBA fees, margins, carton/MOQ math, and 21-item scoring (`Product-P3`), while optional AI adapters cover `gpt-6-luna` `/v1/decisions` triage, `gpt-6.1-terra` (`effort: "xhigh"`) `/v1/responses` & 50%-discount `/v1/batches` structured tasks, `$0`-API-spend local subscription `Codex CLI` (`gpt-6.2-astra` `xhigh`/`max`) Gate-4 `evidence-review-draft-v1` red-team audits, and SQLite `$200/month` conservative-cent budget/recovery fencing (`enabled: false` by default). Frozen revisions 50–58 remain byte-for-byte replayable with their matching profiles. Importing modules or the profile never starts external requests.

## Run the offline examples

Use Node.js 24 or newer; this repository has zero third-party npm dependencies and no embedded credentials.

```sh
node --test
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --output outputs/example
```

Open `outputs/example/index.html`. These cards are explicitly synthetic. For genuine research use the [input contract](docs/design/TRIAL-INPUT.md), keep batches, databases, ledgers, and outputs in ignored local directories (`.local/`, `data/`, `outputs/`), and retain original evidence. A missing total stays unknown; supported points are not scaled to 100. `src/cli.mjs` and the offline/read-only `src/phase2-cli.mjs` subcommands only read supplied local files and never collect fresh external data, spend API credits, contact suppliers, or change stores (`redteam-review` invokes local subscription `codex exec` when run without `--dry-run` or `--offline`).

To include the reviewed source-word-to-form trail, add the optional discovery bundle:

```sh
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --discovery fixtures/synthetic-discovery.json --output outputs/example-linked
```

To inspect the Phase 2/4 local SQLite store, OpenAI budget status, offline Terra `xhigh` Batch `.jsonl` builder, and dry-run Gate-4 red-team packet validator on synthetic fixtures (without touching live provider accounts or spending credits):

```sh
node src/phase2-cli.mjs init --db outputs/example-phase2.sqlite
node src/phase2-cli.mjs replay --db outputs/example-phase2.sqlite --batch fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --discovery fixtures/synthetic-discovery.json
node src/phase2-cli.mjs status --db outputs/example-phase2.sqlite
node src/phase2-cli.mjs openai-status --db outputs/example-phase2.sqlite
```

OpenAI budget reconciliation, offline Batch `.jsonl` construction, and Gate-4 red-team review CLI subcommands (paid OpenAI HTTP policy remains `enabled: false` by default; `redteam-review` runs strictly offline when `--dry-run` or `--offline` is supplied, and invokes local subscription-backed `codex exec` when run live):

```sh
node src/phase2-cli.mjs openai-reconcile --db outputs/example-phase2.sqlite --legacy-budget .local/legacy-budget.sqlite3 --monthly-limit-cents 20000
node src/phase2-cli.mjs openai-batch-build --task rights-prescreen --input outputs/rights-items.json --output outputs/rights-batch.jsonl
node src/phase2-cli.mjs redteam-review --packet outputs/packet.json --output outputs/review.json --effort xhigh --dry-run
```

This keeps original source rows and their separate metrics, validates explicit research dispositions and concrete-offer references, records immutable evaluation receipts, and shows the trail beside the existing scores. It does not classify words automatically or add discovery bonuses. Actual research and supplier authentication still run through authorized tools; a successful offline replay is not unattended discovery acceptance.

## Start here

For a fresh selection batch, `node src/phase2-cli.mjs --help` lists the operator commands and required files.

- `dedupe-forms` checks proposed titles, keywords, buyer tasks and identifiers against persisted leads and forms. Overlaps are review candidates. `luna-triage` takes a listings array or `{listings, target_spec, options}`. A single PNG contact sheet uses the supplied tile order and supports 16 candidates. Metadata-only runs support 200. Only Gate-0-allowed exact peers contribute to the price band.
- `solve-min-price` accepts the ordinary 2027 fee scenario and either a landed unit cost or a `quote` containing `goods_cny_total`, `domestic_freight_cny_total` and `actual_sets`. The optional `mature_price_band` accepts `p25_usd` and `p75_usd`. Gate 1B also persists this calculation on verified quotes.
- `openai-task` runs one validated workflow task and writes its spend receipt alongside the result. Rights screening uses background polling by default. A monitor can read `--progress-file` while the command runs. Repeating the same background task with its original inputs resumes a known response. `openai-cancel --attempt` targets the bound request and retains any unresolved charge for reconciliation.
- `funnel-ledger --since` reports known OpenAI costs and search/token counts, four provider quota lanes, and conversion among forms discovered in the window. Outstanding holds are shown regardless of their age. Unknown billing and incomplete historical evidence appear separately. See the [budget and recovery policy](docs/API-MIGRATION.md).
- `ingest-trial --input <spec.json> --profile docs/design/reference-profile.r59.draft.json --output <out.batch.json>` verifies raw-receipt ASIN provenance, auto-builds 3-tier progressive bids and Stage-1 qualitative judgments, and constructs paired `off_peak` + `peak` seasonal operating periods offline without hand-edited glue scripts.

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

Use this checkout as the single primary repository (`Scheme A`: selection engine, SQLite store, `r58` Curatorial Studio report, and `src/openai/` + `Codex CLI` integration live together in one checkout). Start new chats here and read `AGENTS.md` and `docs/STATE.md`. Do not attach the retired operations repository as a prerequisite. Parallel contributors or subagents editing concurrently should use isolated branches/worktrees with explicit file ownership.

The current owner handoff prepares review and possible continuation in AntiGravity/Gemini; it does not establish that platform's tool access or completed adoption. On this owner's machine, existing ignored evidence enables the real-card replay in STATE. A GitHub-only clone has source, specifications and synthetic examples; it does not contain genuine cards, supplier quotations or live request ledgers. Preserve that boundary when transferring work.

In the Codex app, add this folder as a local project; existing chat membership and folder access are separate from cloning. Use the offline example above to verify the calculation and reading path without any external account.

Licensed under [Apache 2.0](LICENSE).
