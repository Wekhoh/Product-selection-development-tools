# Offline revision-50 trial input

This is the input/output contract for `src/scoring.mjs`. It implements the bounded trial in [FIRST-RELEASE](FIRST-RELEASE.draft.md), using [revision 50](reference-profile.draft.json). It does no I/O and makes no provider or model calls. Importing the profile does not activate a production workflow.

`scoreCandidate(candidate, profile)` scores one concrete form. `scoreBatch(batch, profile)` scores and orders `{ schema_version: 1, profile_revision: 50, candidates: [...] }`. The caller loads the frozen profile. Unsupported profile revision/activation flags, invalid group/item budgets or required margin mappings, malformed batches, missing candidate IDs and duplicate candidate IDs throw `TypeError`. This is a bounded scorer for the maintained profile, not a general profile-schema validator. Missing or invalid item evidence produces a null item and an explicit reason instead of throwing or filling a zero.

## Evidence and observations

A candidate has a stable `id`, a nonempty concrete `form`, optional `label`, and an `evidence` array. Each evidence entry has a unique `id`, nonempty `source`, and ISO `observed_at`; it may retain a local path/URL, scope and limitations. Real inputs and generated cards belong in ignored local directories. Public examples must be synthetic.

When combining research packets, normalize local evidence paths to the project root and verify they resolve; a child packet's `raw/...` path cannot be copied without its original directory context. Preserve source IDs, original files and hashes. The runner validates declared evidence metadata, not file existence or source truth.

An observation is `{ value, unit, evidence: ["evidence-id"], reason? }`. `value` is a JSON number, boolean or null, never a numeric string. Referenced evidence must exist and have valid source/date metadata. `supported: false` or `material_conflict: true` withholds the observation. Nulls should give a specific `reason`. Zero is usable only as an actual supported observation. The caller is responsible for the source meaning, applicability, coherent costs and factual interpretation of the referenced evidence; code validates the declared boundary and does not certify those facts.

Units are `fraction`, `USD`, `count`, `units`, `searches_per_month`, or `boolean` as specified below. Fractions are 0–1; rating/keyword counts are nonnegative safe integers. Sales-unit estimates and search volumes are nonnegative finite numbers. Invalid units, nonfinite values, out-of-range fractions and missing references remain unscored. Evidence dates must be valid ISO calendar dates or ISO timestamps with a timezone; impossible dates and duplicate evidence IDs are unusable.

## Candidate fields

- `screening.reference_price_usd`: positive `USD` observation with `matched_spec: true`. The existing price condition is strictly greater than USD 30.
- `screening.strong_date_dependency`: `boolean` observation. A supported true value defers this form under the reference profile.
- `metrics.purchase_demand_scale`: `units` observation with `niche`, `period`, `grain`, `coverage_supported: true` and `deduplicated: true`, for the declared comparable niche's latest 30 days. Set `window_days: 30` and `window_basis: "latest_30_days"`.
- `metrics.low_return_preference`: `fraction` observation with `category`, `period` and `applicable: true`. It is the labeled category return proxy used for initial economics, not realized candidate returns.
- `judgments`: objects keyed by `supported_opportunity`, `purchase_entry_match`, `existing_solution_fit`, `feasible_light_differentiation`, `storage_tolerance`, `transport_tolerance`, `routine_complexity`, `specific_design_rights`, and `applicable_public_requirements`. Each judgment is `{ anchor: number|null, evidence: [...], reason: "...", contrary_evidence?: [...], unknowns?: [...] }`. The anchor must exactly match that item's adopted points; no interpolated rubric judgments. A nonzero opportunity anchor also needs `route: "stable_demand" | "sustained_growth" | "demand_side_supply_gap"`. Zero can use `route: "none"`. The output retains the adopted anchor meaning, reason, evidence and supplied counterevidence/unknowns. Rights anchor 0 means an actually confirmed exact-form conflict and excludes that specification; unknown rights remain null.

### One native market report

`market` has `provider: "sellersprite"`, `report_id`, `relevant: true`, `population`, `family_basis`, `period`, `head_group`, and `evidence`. `concentrations.product`, `.brand` and `.seller` are `fraction` observations from that one report. An optional observation `report_id` must match the declared report.

`market.newcomer_age_months` is 3; `newcomer_sales_window` is `"latest_30_days"`. `market.newcomer.count_share` and `.unit_sales_share` are native `fraction` observations from the same report. A supplied `denominator` must be a positive finite number; a zero or explicitly unknown denominator leaves the ratio unscored. Unit share is not revenue share. These first 3/2 points remain separate from the qualified niche cohort below. The declared population is not relabeled a current BSR list.

### Exact bid points and separate ranges

`bids` has `marketplace: "US"`, `currency: "USD"`, `match_type: "exact"`, a common `volume_period`, `selection_reason`, `evidence`, and nonempty `entries` for the supported main purchase-entry set. Other marketplaces remain unscored even if labeled USD. Each entry has a unique normalized `query`, `volume` (`searches_per_month` observation from SellerSprite), and optional `sellersprite` / `sif` observations. A source observation has `value`, `unit: "USD"`, `evidence`, `match_type: "exact"`, `strategy`, and optional nonnegative `low` / `high` with `low <= high`.

SIF strategy must be `"fixed"`. SellerSprite `"fixed"` or `"unspecified"` is usable; the latter retains the adopted strategy limitation. Known incompatible strategies are not averaged. Optional per-source `marketplace`/`currency` must match the batch. One usable native point is labeled single-source; two usable points receive equal weight within that entry. Every selected entry needs a usable point and usable volume; missing entries are not dropped and reweighted. Total volume must be positive. Duplicated exact queries invalidate the item until deduplicated.

The main bid score uses only original native points, then monthly-search weighting. Each provider's complete low/high ranges are separately weighted and displayed as source-labeled bid/score scenarios. Ranges never supply an invented native midpoint, main-score penalty or automatic CPC forecast. Incomplete or invalid ranges do not invalidate an otherwise usable point.

### Qualified normal-newcomer reference

`newcomer_cohort` has `observation_basis: "current_latest_30_days"`, `observation_date`, `period`, `niche`, `grain`, `relevant_bsr_node`, `reference_supported: true`, `evidence`, and `members`. The assertion means the declared observed reference is sufficiently supported and stage compatible, not exhaustive. Materially unresolved scope/coverage should set it false with a reason.

Each member has frozen `family_id` and `asin`, `status: "qualified" | "excluded" | "pending" | "auxiliary"`, a `reason`, and `evidence`. `qualified` explicitly asserts genuinely substitutable form, supported normal start within three months at the observation date, documented relevant BSR-top-100 observation, and compatible stage/current observation coverage. Supported historical entrants now exited can qualify. New-Releases-only records are auxiliary. An explicit `old_reviews_predate_launch: true` overrides qualification and records exclusion without attributing its cause. Preserve current/exit/history fields as context.

Qualified members have `ratings` (`count`) and `units_30d` (`units`) observations on the common basis. Medians use the entire observed qualified cohort, including weak/exited cases. A missing required member value leaves its median unsupported; it is not silently removed. Family duplicates are represented once with frozen identity ordering; incompatible duplicate observations make the reference pending. `shared_launch_id`, when supplied, also prevents shared launch histories from supplying two exemplars. All member records remain in diagnostics.

Optional `natural` is a SIF overall modeled natural-exposure `fraction` observation with `scope: "overall"`, identified `period`, and `relevant_entries_evidence`. `material_conflict: true` withholds it. Optional `natural.keyword_counts.sellersprite` and `.sif` hold `organic`/`ad` count observations for corroboration; they never replace exposure shares or add points. Missing SellerSprite counts allows a labeled SIF-only result. Ordinary count disagreement alone has no penalty.

Complete low-rating examples use the adopted actual-count/relative-count components and sales ceiling, including weak-sales examples. Select the top two unrounded scores with family ID, then ASIN ascending ties. Natural visibility uses that exact pair. One complete example is retained as single-case evidence, with no direction score. True-zero rating median leaves the relative component unscored; nonpositive sales median supplies no sales ratio. A fixed valid pair with one usable natural score keeps a null item plus the adopted conditional range; its lower bound is not earned points.

### Coherent economics scenarios

`economics` has a common `saleable_unit` and nonempty `scenarios`. Each scenario has unique `id`, the identical `saleable_unit`, `coherent: true`, nonempty `assumptions` (array of strings), and `margin` (`fraction`, finite and at most 1; losses may be negative) plus `contribution_usd` (`USD`) observations. Null values retain their explicit reasons. The caller's economics calculator must account for every applicable cost and preserve original evidence; this core does not calculate monetary costs or treat a missing cost as zero.

The margin and contribution must come from the same supported economic record with positive net revenue. Supported values must have matching signs, including zero; a positive margin with zero contribution or a negative margin with nonnegative contribution is contradictory and stays pending. Consistent negative losses remain usable for the existing margin exclusion, without an eligible contribution score. No revenue amount is invented when it is absent. Only otherwise eligible scenarios receive the eligible profit curves. A wholly supported margin range below 30% excludes; a crossing range is pending, with failed scenarios never scored using the eligible-margin curve. One unresolved scenario prevents pretending that the other scenarios exhaust the supported set. Shared scenario IDs preserve dependence between margin and contribution: total bounds use each declared scenario's combined score, rather than summing mutually incompatible item extrema. The core does not interpolate new cost plans between scenarios or claim that their range is an exhaustive real-world bound. When margin is pending, the whole-card conditional profit allowance remains the broad 0–30 mathematical allowance, not earned profit points.

Scenario diagnostics expose `coherence_supported`, `margin_eligible` and `eligibility_reason`. The first checks the declared record shape, unique identity, common unit, explicit assumptions and absence of a supported sign contradiction; it does not independently prove costs or source truth. Invalid records retain their raw observations but have no eligible diagnostic scores. The renderer requires both flags to be explicitly true before stating a margin pass; a stale eligibility flag alone is insufficient.

## Output and ordering

The separate `economics.mjs` helper keeps every applicable cost explicit and distinguishes a complete conditional estimate from sensitivity-only arithmetic or pending costs. `collectionFromDisbursement` applies an explicitly supplied rate to the nonnegative payout estimate after Amazon cash deductions; procurement, external freight and noncash recoveries are not Amazon deductions. No rate, shipping divisor or inventory assumption is a runtime default. `observations.mjs` preserves category-average and selected-market returns separately, and converts declared daily missing sentinels without claiming complete calendar coverage. Neither helper retrieves data or certifies a source's applicability.

Each candidate result has the 21 `items` in profile order, `groups`, `screening`, scenario/cohort/bid `diagnostics`, `supported_range`, `covered_weight`, `unscored_weight`, `total`, `total_range`, `conditional_total_range`, and `queue`. Each item retains its input, evidence, status, reasons, weight and applicable point/range or conditional range. The supported subtotal includes only fully supported scored items; partial component observations remain visible without being promoted into an earned item score. A supported interval has `status: "scored"`, `score: null` and a usable `score_range`; callers must use status/range rather than treating every null point as a missing item. `scoring_complete` means all items are supported, while a complete comparable result additionally requires resolved eligible screening.

`total` is a number only for a complete eligible point result. `total_range` is the coherent supported range for a complete eligible result (also `[total,total]` for a point). A supported interval does not receive a midpoint. Missing evidence or unresolved screening leaves both complete-total fields null. `conditional_total_range` is a mathematical possibility bound conditional on remaining eligible, never an earned score or forecast. Excluded/deferred forms do not receive that range.

Batch results return `candidates` in comparable, pending, deferred, excluded order; `order` lists IDs per queue. `summary` has `candidates`, `complete` (eligible comparable), `complete_points`, `complete_ranges`, `all_items_supported`, `partial`, `pending`, `deferred` and `excluded` counts. Comparable results sort by the lower complete endpoint descending. Pending results sort by the lower supported subtotal, then covered weight descending. Exact ties retain input order. A pending result can flag `may_exceed_comparable_leader` only from a valid conditional bound above the leader's conservative lower endpoint, without treating the upper bound as priority or proving an advantage over an overlapping interval. No total-score cutoff, normalization, AI adjustment, extra source bonus or duplicate penalty is added.

`scoreNumericValue(itemId, value, profile)` is also exported for direct mapping checks. It validates numeric domains but carries no evidence qualification and cannot produce an earned candidate total.

## Optional report presentation

`renderReport(result, batch)` in `src/report.mjs` is a pure, script-free Chinese HTML renderer. It joins scored candidate IDs back to the original batch for optional presentation. Presentation changes never modify scores or evidence eligibility. Unknown optional shapes are ignored or rendered as escaped text, without hiding scoring gaps.

Candidate `presentation` may contain:

- `summary`, `image_alt`, `image_caption`: plain strings.
- `image_data_uri`: a base64 PNG/JPEG/WebP data URI, at most 12,000,000 characters. Remote images, SVG and other data schemes are omitted. Use authentic, provenance-backed reference images for real candidates; the synthetic fixture invents no product photo.
- `blockers`: `{ problem: string, next_step?: string }[]`. These supply concise main-card tasks; every actual unscored item remains visible in the 21-item detail section.
- `procurement` and `economics_details`: `{ label: string, value: string|number|null, unit?: string, note?: string, source?: string, url?: string }[]`. Null remains unknown. These are sourced presentation records, not additional calculation inputs.

Batch `presentation` may contain `title` and `summary` strings; `discovery` rows `{ label, detail?, source?, url?, observed_at?, status? }`; `timings` rows `{ label, seconds: number|null, note? }`; and `limitations` strings. Timings describe the explicitly supplied collection/research stages; an unknown duration is not zero or a throughput claim.

The report shows concise main cards plus native expandable details for all 21 items and eight groups, source references, economic scenarios, the fixed newcomer pair and supporting keyword/bid observations. All external strings are escaped. Untrusted links accept HTTP(S) only and reject embedded credentials; local paths remain text. The CSP blocks scripts, connections, remote fonts, frames and objects, and permits only embedded raster images plus the trusted inline stylesheet. The layout uses system fonts, wrapping source text, keyboard focus, responsive rows and print styling. Native desktop/mobile inspection remains separate acceptance evidence.

## Offline CLI and receipt

Run with Node.js 24 or later; no package installation or network access is needed:

```powershell
node src/cli.mjs --input fixtures/synthetic-batch.json --profile docs/design/reference-profile.draft.json --output .local/synthetic-trial
npm test
```

`--input`, `--profile` and `--output` are required. `--help` prints usage. The CLI reads UTF-8 JSON, scores the batch, and writes `result.json`, self-contained Chinese `index.html`, and `receipt.json`. Repeated input/profile bytes produce identical score JSON and HTML; the receipt intentionally changes its run identity, timestamps and timings. The public fixture contains only three explicitly synthetic point/range/pending examples. Real inputs and outputs stay in ignored local directories.

The receipt records input SHA-256/byte counts, actual output readback hashes/byte counts, Node/profile versions, counts, wall timestamps and measured read/score/render/write stages. `elapsed_ms` ends at primary output readback before final receipt publication; it does not claim to measure live collection or its own final write. The receipt does not hash itself. Provider/model/network request counts are zero for this runner, which contains no request client.

The named output files are replaced on a successful rerun; input/profile paths are protected from accidental overwrite. All computation precedes publication. Owned temporary files are written exclusively and each file is published by rename. A `writing` receipt invalidates an older success before primary replacement; a publication failure records `failed`, known published files and expected hashes when possible, cleans owned temporary files, and returns exit code 2. It does not report a completed report or silently retry publication. Inspect the receipt and resulting files after a failure. Filesystem errors that prevent even a failed receipt are reported explicitly on stderr. Exit code 0 plus a complete receipt with matching output hashes identifies a successful local run; source correctness, native workflow acceptance and business usefulness remain separate.
