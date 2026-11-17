# Context router for review, continuation and refactoring

Updated: 2026-11-17. This is a reading map and causal index, not another task board or scoring specification. [STATE](STATE.md) owns current progress and next work; the linked documents own their decisions. The owner requested this route so a new agent can understand what happened, why the implementation exists, and what evidence to inspect before changing it.

## Start with the owner outcome

The owner is an Amazon US seller, not a software developer. The intended product proactively discovers real opportunities, researches and estimates them, and presents multiple inspectable choices. The owner then judges usefulness, checks supply and detailed rights/compliance, tests small quantities and decides whether to replenish. Asking the owner to supply every keyword or candidate would miss the discovery role.

The business favors supported unit economics and accessible competition, including modest-volume markets. It does not require a blockbuster or a different market for every card. More leads matter because many forms fail supply, margin or later tests. The long-term target is ten fully scored qualifying cards, with rejected forms shown separately. STATE records actual implementation and acceptance; the target and passing CI do not prove automated production or commercial success.

The owner expects the agent to investigate, challenge consequential assumptions, explain tradeoffs in plain language and preserve decisions. They also reject endless interviews, extreme hypothetical cases, unsupported scores and an expanding architecture that cannot produce cards. Investigate facts; use the existing Grill with Docs history for genuinely unsettled business choices. See [PRODUCT](PRODUCT.md), [DEVELOPMENT](DEVELOPMENT.md) and [GLOSSARY](../GLOSSARY.md).

## First reading pass

1. Read [AGENTS](../AGENTS.md) and [STATE](STATE.md); inspect branch, remote, dirty files and ownership. The user is preparing AntiGravity/Gemini to review and potentially continue selection development, not claiming it has already adopted the code or tools.
2. Read the current-rule openings of [PRODUCT](PRODUCT.md), [DECISIONS](design/DECISIONS.md) and [FIRST-RELEASE](design/FIRST-RELEASE.draft.md). Later explicit decisions supersede only their stated scope. Older "pending", "not executed" or "proposal" labels are dated evidence, not reasons to reopen settled questions.
3. Read the current card report, acceptance receipt and source audits in STATE if local evidence is available. Separate implementation success, source support, initial-card eligibility and business results.
4. Select a topic below. Read its rule, actual source/input, implementation and focused checks together. Retrieve original dialogue when a consequential interpretation remains ambiguous.
5. For a change, state the observed failure, affected decision, smallest useful correction, counterexample and replay plan. Preserve frozen inputs and approved meaning. A major refactor remains a possible future choice, not this handoff's completed work.

## Why the workflow took its current shape

| Problem or owner correction | Resulting approach and boundary | Read next |
| --- | --- | --- |
| Earlier handoffs lost context and treated the project as starting over. | One current STATE, preserved sources and explicit accepted/superseded decisions. Retrieve the reason instead of repeating the interview. | [Decision history](design/DECISIONS.md), [continuity review](reviews/design-continuity-20261111.md), private source index below |
| Research returned to a few imagined words or only growth lists. | Five evidence-led routes; growth/stable/gap hypotheses are not exhaustive. Social evidence can originate a direction. Share applicable research without visiting every route for every card. | PRODUCT, [methods reuse](research/20261114-discovery-methods-reuse.md), [brainstorming](research/20261114-discovery-opportunity-brainstorm.md) |
| Many keywords do not equal many viable products. | Retain signals, buyer intent and inclusion/exclusion reasons; map to actual offers and concrete forms. One word can yield several forms and several words can identify one form. | FIRST-RELEASE, [TRIAL-INPUT](design/TRIAL-INPUT.md), `src/discovery.mjs` |
| Detailed niche and historical exited-newcomer reconstruction made cards slow and incomplete. | Revision51 uses relevant current-category evidence, native newcomer ratios and bounded normal-start examples. Detailed operating/legal/supplier research follows owner selection. Observed zero still needs a checked population. | [Q31](design/Q31-NORMAL-NEWCOMER.draft.md), simplification decisions, current-newcomer tests |
| A missing-data sample could win an otherwise equal example tie. | Revision52 favors complete evidence under its defined equal-upper-bound conditions. Keep unresolved members and the same example pair for linked natural visibility. | Q31, `test/current-newcomers.test.mjs` |
| Owner calculator checks exposed fee-version, season and saleable-unit confusion. | Revision53 separates periods. Revision54 derives economics from dated ledgers rather than cached margins. Validate each fee's applicability and retain unknown future holiday rates. | [PROFITABILITY](design/PROFITABILITY.draft.md), [fee research](research/us-fba-fee-basis-20261114.md), economics/fee-basis/seasonal tests |
| Domestic freight omission and generic freight assumptions overstated profit. | Later decisions require a quantity-specific domestic quote, retail-unit allocation and applicable carrier-bond supplement once. Keep package/material/route evidence and promotion limits. | PROFITABILITY, dated decisions, private owner comparison |
| One returned bid was mistaken for one genuine purchase entry. | Revision55's sole-entry rule requires a researched sole entry. The owner rejected scoring multiple entries from only the available quote. Expand relevant competitors/words and retain exclusions. | [SUGGESTED-BID](design/SUGGESTED-BID.draft.md), query audits, single-entry tests |
| Main-entry quotes and monthly weights had different coverage. | Revision56 permits equal means only when all selected entries have native exact points and monthly volume alone is missing. Complete compatible monthly weighting remains preferred. | SUGGESTED-BID, `test/equal-entry-bid.test.mjs`, frozen revision55/56 replays |
| Static MCP fields did not provide complete bids. | An authenticated SellerSprite real-time bidding task supplied native `仅降低/固定` exact points. Retain original columns, task/date and allowance use. This is source acquisition, not a new curve or an automated adapter. | SUGGESTED-BID acquisition note, original AX/DOM/screenshot in STATE |
| Requested BSR filters returned the wrong products or population. | Official-contract readback required `filterSub=Y` and plural `nodeIdPaths`; complete pagination and verify actual node/rank/family scope. Successful transport alone does not validate population. | Q31 acquisition note, `router-source-audit.json`, saved responses |
| Login success was confused with a later site-policy denial. | Keep tool identities and the actual error distinct. An old login does not establish current access; another QR does not resolve a policy denial. This handoff does not establish receiving-platform access. | STATE blocker, `browser-policy-readback-20261117.md` |
| Framework/API work could grow before a usable card existed. | Reuse the deterministic core and evidence first. Research execution, UI and deployment are separate choices; optional API review remains inactive. | [Reuse/workbench study](research/reuse-and-workbench-20261111.md), DEVELOPMENT, API references below |

These rows explain changes; owning documents define exact conditions. An example, withdrawn proposal or research option is not a newly approved score. Verify changing external facts against current documentation before new acquisition or implementation; dated research is a starting point, not current API/fee proof.

## Trace a change through code and checks

The local path is `src/cli.mjs` -> optional discovery preparation/attachment -> `scoreBatch` -> economics/fee and item checks -> HTML/result/receipt persistence. Research and native-tool collection precede it. The CLI does not discover products, classify buyer intent, inspect supplier pages or authenticate fee sources by itself.

| Review topic | Owning specification | Implementation and existing checks |
| --- | --- | --- |
| Input, evidence IDs, source dates and zero semantics | TRIAL-INPUT | `src/observations.mjs`, `test/observations.test.mjs`, affected scoring/CLI checks |
| Word/form/source linkage | FIRST-RELEASE and TRIAL-INPUT | `src/discovery.mjs`, `test/discovery.test.mjs`, `test/discovery-flow.test.mjs` |
| All21 mappings, bounds and ordering | [Profile](design/reference-profile.draft.json), DECISIONS, [DEMAND](design/DEMAND.draft.md), [COMPETITION](design/COMPETITION.draft.md) | `src/scoring.mjs`, `test/scoring.test.mjs`, topic-specific fixtures |
| Exact bids and entry weighting | SUGGESTED-BID | `src/scoring.mjs`, `test/single-entry-bid.test.mjs`, `test/equal-entry-bid.test.mjs` |
| Current newcomers and linked examples | Q31 | `src/scoring.mjs`, `test/current-newcomers.test.mjs` |
| Unit costs, refunds/collection and dates | PROFITABILITY and TRIAL-INPUT | `src/economics.mjs`, `src/fee-basis.mjs`, `test/economics.test.mjs`, `test/fee-basis.test.mjs`, `test/seasonal.test.mjs` |
| Displayed claims, conditional values and receipts | FIRST-RELEASE and TRIAL-INPUT | `src/report.mjs`, `src/cli.mjs`, `test/report.test.mjs`, real report/readback in STATE |

Use Node.js24+ and README/STATE commands. Public synthetic fixtures and the [offline workflow](../.github/workflows/offline.yml) need no credentials or provider calls. Select affected checks, then required CI; replaying arithmetic does not require fresh live requests. Reuse unchanged acceptance, and verify changed dependencies and the resulting real card.

## Private history and source routing

Paths below are repository-root-relative. They are pointers, not published business evidence. `.local/trials/20261116-next-cards/resumed-flow/agent-handoff-20261117/source-index.json` records source existence and file hashes; a new clone does not contain `.local`. Original conversations, quotations, screenshots, account data and request ledgers stay private. Missing local evidence means a transfer gap, not that earlier work never happened.

| Question | Existing private source |
| --- | --- |
| What was agreed in earlier Grill Me rounds, including corrections? | `.local/migration/radar/active-discovery-grillme-20261111/补充交接-主动发现与GrillMe-20261111.txt` and `GrillMe交接复核-逐题与差异-20261111.md`; question records in `.local/migration/radar/current-and-question-history/scoring-demo-20261109/` |
| Which upstream discovery methods were read and adapted? | `.local/migration/radar/two-seat-supplement/upstream-read-20261109/method-adaptation-map.json`; `.local/migration/radar/two-seat-supplement/scoring-demo-20261109/discovery-tool-entrypoints-20261109.json` |
| What was transferred and where did it originate? | `.local/migration/radar/radar-assets.manifest.json`, `.local/migration/radar/audit-v2/radar-assets.manifest-v2.json`, `.local/migration/api-integration/source-manifest.json`; [MIGRATION](MIGRATION.md) owns the boundary |
| Why did fees and earlier passing labels change? | `.local/trials/20261116-next-cards/owner-competitor-check/`, `.local/trials/20261116-next-cards/fee-basis-implementation/`; owner comparison, calculator sources and dated replays, then current PROFITABILITY |
| Why did query selection and quote/weight rules change? | `.local/trials/20261116-next-cards/resumed-flow/bid-research/`, `single-entry-r55/`, `equal-entry-r56/`; query audit, owner readout, frozen inputs, independent review and publication receipts |
| What is the latest real result and replay? | Current `card-completion-20261117/` paths and command in STATE, plus adjacent `discovery-bundle.json` |
| Which requests are already saved or ambiguous? | `.local/trials/20261116-next-cards/request-ledger.json`, adjacent `resumed-flow/request-reconciliation.json`, `.local/trials/20261115-next-cards/request-recovery.json` |

Original external handoff locations requested by the owner are preserved in the ignored handoff source index. Use migrated local sources first and compare originals for a provenance or interpretation conflict. Earlier Autopilot material is historical evidence, never a runtime prerequisite or an instruction to restart it.

## Planning and choices still open

Discovery studies contain reusable ideas, not an all-channels-per-card requirement or new scoring bonuses. FIRST-RELEASE defines the full target; STATE names actual acceptance. Useful throughput, multi-category calibration, unattended startup/recovery, final workspace interaction and owner-decision writeback remain separate subjects.

For an API proposal, read [API-MIGRATION](API-MIGRATION.md), [optional evidence-review contract](api/EVIDENCE-REVIEW-CONTRACT.draft.md) and [dated OpenAI options](api/OFFICIAL-OPENAI-OPTIONS.2026-11-14.md). They retain investigated options and recovery constraints; no new live API stack, promotional-credit budget or model call is activated. The API branch is not the current product-state authority. Coordinate a concrete interface task instead of importing its older STATE over main.

The owner is open to optimization and possible major refactoring after review. Compare proposals against the working path: evidence completeness, maintainability, recovery, changed-rule risk and measured qualifying-card yield. Distinguish access restrictions, implementation defects, business tradeoffs and acquisition throughput. Retain simple adequate behavior, explicit gaps and versioned real replay; a framework needs an evidenced gap rather than the availability of another model.

At closeout, record what was read/verified, affected assumptions, proposed or implemented scope, remaining blockers and the next action in STATE. Report actual receiving-agent execution/adoption separately from file publication.
