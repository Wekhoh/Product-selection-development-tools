# Product selection development tools

An independent, open-source product-selection tool for personal use and optional self-hosting.

**Current stage: Revision 59 (`r59`) sole active runtime, 3-layer 2027 FBA/economics engine (`src/rates/`, `src/fba-calculator.mjs`, `src/economics.mjs`), Curatorial Studio (`01 视觉策展室`) HTML report (`src/report.mjs`, `src/report-studio-css.mjs`), provider & Keepa adapters (`src/adapters/`), daily single-item/small-batch CLI entrypoints (`src/phase2-cli.mjs`), audited business-threshold registry (`src/business-thresholds.mjs`), and Scheme A `src/openai/` + subscription `Codex CLI` (`GPT-6.2 Astra`) integration complete.** The offline runner applies 21 mappings (8 groups, 100 points) to explicit local evidence, ranks all qualifying cards (`complete`, `seasonal_eligible`, and `sample_pending_qualifying`) on a unified 85-point objective core, and produces self-contained script-free Chinese decision cards. Historical `r50–r58` frozen replay is archived intact on Git tag `archive/r50-r58-frozen-replay-20261125` (and `docs/archive/design/reference-profile.r58.archived.json`). Importing modules or the profile never starts external requests.

## Run the offline examples

Use Node.js 24 or newer; this repository has zero third-party npm dependencies and no embedded credentials.

```sh
node --test
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.r59.draft.json --output outputs/example
```

Serve and preview rendered HTML reports locally via `serve-report` (`http://127.0.0.1:<port>/...`) rather than opening raw `.html` source in an editor:

```sh
node src/phase2-cli.mjs serve-report --dir outputs/example --port 4179
```

These cards are explicitly synthetic. For genuine research use the [active specification](docs/SPEC.md), [archived input contract](docs/archive/design/TRIAL-INPUT.md), and [archived decisions](docs/archive/DECISIONS.md), keep batches, databases, ledgers, and outputs in ignored local directories (`.local/`, `data/`, `outputs/`), and retain original evidence. A missing total stays unknown; supported points are not scaled to 100.

To include the reviewed source-word-to-form trail, add the optional discovery bundle:

```sh
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.r59.draft.json --discovery fixtures/synthetic-discovery.json --output outputs/example-linked
```

To inspect the SQLite store, daily single-product / batch workflows, OpenAI budget status, offline Terra `xhigh` Batch `.jsonl` builder, and dry-run Gate-4 red-team packet validator on synthetic fixtures (without touching live provider accounts or spending credits):

```sh
node src/phase2-cli.mjs init --db outputs/example-phase2.sqlite
node src/phase2-cli.mjs replay --db outputs/example-phase2.sqlite --batch fixtures/synthetic-batch.json --profile docs/design/reference-profile.r59.draft.json --discovery fixtures/synthetic-discovery.json
node src/phase2-cli.mjs status --db outputs/example-phase2.sqlite
node src/phase2-cli.mjs openai-status --db outputs/example-phase2.sqlite
```

Minimal offline `daily-batch` smoke example (clean checkout, `:memory:` SQLite, synthetic input, zero network; `gate1a_scenarios` and `asin` are pre-supplied, while 1688 sourcing / deep research executors are omitted so `batch_report.gate1b` reports `"gate1b_pending"` and `batch_report.evaluations` stays `[]`; also shows `--from-store --limit 10` on-demand store queue pull):

```sh
node --input-type=module -e "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('outputs', { recursive: true }); writeFileSync('outputs/example-daily-batch.json', JSON.stringify({ as_of_date: '2026-11-27', items: [{ form: { form_id: 'example-desk-tray', product_family_key: 'example-desk-tray', label: 'Synthetic Desk Tray', buyer_task: 'Sort desk tools', saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }] }, asin: 'B0SYNTRAY1', gate1a_scenarios: [{ id: 'sc-40', price_usd: 40, available_date: '2025-05-01', pkg: { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 }, headhaul_usd: 2.0, collection_rate: 0.005, other_applicable_usd: 0, sales_window: { from: '2027-02-01', through: '2027-10-14' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-10-14' } }] }] }, null, 2));"
node src/phase2-cli.mjs daily-batch --db :memory: --input outputs/example-daily-batch.json --limit 10
node src/phase2-cli.mjs daily-batch --db outputs/example-phase2.sqlite --from-store --limit 10
```

OpenAI budget reconciliation, offline Batch `.jsonl` construction, and Gate-4 red-team review CLI subcommands (paid OpenAI HTTP policy remains `enabled: false` by default; `redteam-review` runs strictly offline when `--dry-run` or `--offline` is supplied, and when run live uses local subscription-backed `codex exec` on `gpt-6.2-astra` at normal/default speed with `max` reasoning):

```sh
node src/phase2-cli.mjs openai-reconcile --db outputs/example-phase2.sqlite --legacy-budget .local/legacy-budget.sqlite3 --monthly-limit-cents 20000
node src/phase2-cli.mjs openai-batch-build --task rights-prescreen --input outputs/rights-items.json --output outputs/rights-batch.jsonl
node src/phase2-cli.mjs redteam-review --packet outputs/packet.json --output outputs/review.json --effort max --dry-run
```

## Daily operator entrypoints & core commands

For a fresh selection run, `node src/phase2-cli.mjs --help` lists all operator commands:

- `single-product` accepts a bare ASIN/keyword/post seed (registering the lead + derived `form_id` in SQLite), a Gate 1A/1B/scored single-product workflow spec, or a raw-receipt `ingest-trial` spec, and exports V4 `01 视觉策展室` HTML directly when `--report-dir <dir>` is supplied (with optional Gate-4 `GPT-6.2 Astra` review on qualifying cards).
- `daily-batch` has two explicit modes: (1) `--input <daily-batch.json>` ingests and screens an **uncapped** batch funnel by default (slicing only when `--limit <n>` is explicitly supplied), and (2) `--from-store [--limit 10]` pulls up to 10 unconfirmed, non-drill, non-rejected/reserved, non-`owner_confirmed`/archived cards on demand from SQLite—skipping already-shown undecided cards ("待拍板池") by default unless `--pending-pool` or `--include-shown` is passed (resumable after `CAPTCHA_PAUSED` via `resume-1688`). Note `src/cli.mjs` scores standalone Phase 1 batch fixtures, `single-product` runs a single-item workflow/seed, and `daily-batch` runs multi-item Phase 2 workflows or store queue pulls.
- `calibration-track` records and summarizes 4-item post-card calibration outcomes (`ip_clearance`, `factory_quote_accuracy`, `package_tier_match`, `owner_verdict`) across real cards in SQLite.
- `sp-api-calibrate` extracts read-only SP-API `catalogItems`, `productFees`, and `listingsRestrictions` calibration before finalist profit evaluation (distinguishing peer brand-gating from white-label category restrictions).
- `dedupe-forms` checks proposed titles, keywords, buyer tasks and identifiers against persisted leads and forms. `luna-triage` screens up to 200 metadata rows or a 16-tile `4x4` PNG contact sheet via `/v1/decisions`.
- `solve-min-price` & `reverse-1688` (*"按 1688 成本算保底定价"*) solve exact cent-rounded 2027 breakeven US selling prices for the `30%` margin floor from a 1688 `100`-set regular bare-goods (or explicit landed-freight) quote under decoupled steady-state `>= 5` cartons `$0` placement + Kaiqi nationwide `¥10.0/kg` multi-warehouse headhaul, emitting mandatory bare-goods disclosure per [docs/SPEC.md](docs/SPEC.md).
- `openai-task` runs one validated Terra `xhigh` workflow task with resumable background polling (`--progress-file`) and `DELETE + 404` cleanup; `openai-cancel --attempt` cancels a bound background request.
- `funnel-ledger --since` reports realized OpenAI costs, four provider quota lanes (`ss_mcp`, `ss_web`, `sif`, `exa`), and funnel conversion.
- `ingest-trial --input <spec.json> --profile docs/design/reference-profile.r59.draft.json --output <out.batch.json>` verifies raw-receipt ASIN provenance, normalizes SellerSprite/SIF/SP-API/Keepa receipts (`src/adapters/`), auto-builds 3-tier progressive bids, and constructs evergreen `2027-02-01..2027-10-14` off-peak + blank Q4 peak operating periods.

## Documentation map

| Start here | Purpose |
| --- | --- |
| [Active specification](docs/SPEC.md) | Single active business & workflow specification, model boundaries, and permanent Non-Goals |
| [Architecture decisions](docs/adr/0001-decouple-steady-state-freight-from-100-set-sourcing.md) | Concise records of hard-to-reverse architectural and business-boundary tradeoffs (`ADR-0001..0004`) |
| [Current state](docs/STATE.md) | Single current outcome, evidence, blockers, and next step |
| [Context router](docs/CONTEXT-ROUTER.md) | Causal history, code/test map, and private source routing |
| [Archived requirements & decisions](docs/archive/PRODUCT.md) | Frozen historical [PRODUCT.md](docs/archive/PRODUCT.md) and [DECISIONS.md](docs/archive/DECISIONS.md) ledgers (superseded by `docs/SPEC.md`) |
| [Active scoring profile (`r59`)](docs/design/reference-profile.r59.draft.json) | 21 item mappings, 100-point budget, 85-pt core ranking, and 3-tier USD CPC curves |
| [Business thresholds registry](src/business-thresholds.mjs) | Single audited frozen source of truth for all owner-confirmed business cutoffs |
| [Provider & OpenAI routing](docs/API-MIGRATION.md) | Scheme A `src/openai/` + subscription `Codex CLI` routing and `$200/month` guardrails |
| [Development workflow](docs/DEVELOPMENT.md) | Engineering conventions, anti-bloat ratchet, and review rules |
| [Domain glossary](GLOSSARY.md) | Shared meanings for discovery, candidates, evidence, and scores |
| [Historical archive](docs/archive/) | Archived `r50–r58` profile (`reference-profile.r58.archived.json`), early drafts, research, and migration notes |

Use this checkout as the single primary repository (`Scheme A`). Start new chats here and read `AGENTS.md` and `docs/STATE.md` (plus `.local/state/CANDIDATE-PROGRESS.md` and `.local/state/OWNER-OPERATING-NOTES.md` when `.local/` is present). Public clones contain source, specifications, and synthetic examples; genuine cards, supplier quotations, credentials, and live SQLite ledgers stay strictly in git-ignored `.local/` storage.

Licensed under [Apache 2.0](LICENSE).
