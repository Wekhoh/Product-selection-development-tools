# Research interface contract candidate

Version: `research-contract-draft-v1`. Prepared: 2026-11-11 (Asia/Shanghai).
Status: review candidate only. This is an interface proposal and synthetic evidence,
not an installed adapter, approved product design, provider activation, or live acceptance.

This batch owns only `docs/api/CONTRACT.draft.md` and
`docs/api/examples.synthetic.json` in the API worktree. Selection Development owns
product decisions, the integration checkout, `docs/STATE.md`, adoption and final acceptance.
Product form, the core flow and first-release scope are the next owner discussion;
Q31/Q32 remain open. The Q31 appendix does not block that discussion.
The owner subsequently confirmed a visual workbench and asked for reuse-first research.
Codex remains an eligible research engine. Browser/desktop/deployment and the first-release
workflow are still undecided. Evaluate maintained existing runtimes/workbenches before
implementing these conceptual operations; their names do not commission a new framework.

## 1. Smallest useful boundary

A caller supplies a research question and frozen evidence. The future adapter returns
traceable observations, estimates, missingness and execution evidence. It does not
choose products, produce an unapproved total score, contact suppliers or authorize
procurement/store actions.

The proposed operations are conceptual, not implemented API endpoints:

- `prepare(request)`: validate identity, evidence references, scope and policy without a
  provider call. Missing target details can be returned as gaps rather than invented.
- `run(prepared_request)`: only a later, separately enabled caller may submit. Preparation
  is not authorization. A frozen request must not change between admission and submission.
- `inspect(request_id)` and `recover(request_id)`: inspect local evidence or reconcile
  the original attempt. Recovery never creates a replacement generation.

No UI, trigger, deployment, default model, SDK, new state directory or credential owner
is selected. The draft is transport independent and works for an offline caller.

## 2. Input envelope

| Field | Proposed meaning |
| --- | --- |
| `schema_version` | Explicit contract revision; unsupported revisions fail before submission. |
| `request_id` | Stable application research identity, preserved through inspection/recovery. It is not a provider HTTP trace ID. |
| `operation` | Requested observation/research task; no implicit scan or downstream action. |
| `target` | Explicit marketplace, product-form description and optional subject references. `product_form_description_status` is `provided`, `unknown`, or `not_required`. Unknown values are null with gaps; `not_required` is null without a gap and only applies when that operation does not need a form description. Required missing fields block operations that need them. |
| `requested_scope` | Caller-selected subjects, metrics, comparison population reference, window and grain. No default niche, time window or score. |
| `rules` | Immutable version plus supplied rule content/evidence reference. Draft/unapproved rules are labelled; their presence cannot activate scoring. |
| `evidence_refs` | References to immutable source artifacts and selectors within them; retain digest, provider/tool identity, source marketplace, original observation time, capture time, window, grain and units. |
| `execution_policy_ref` | Opaque reference to an already approved local policy, or null for offline preparation. Never a key, environment-file path or newly granted allowance. |

Local evidence resolves under an explicitly configured private evidence root, independently
of any previous repository. Validate references and containment at the boundary; reject
path traversal, hash mismatch and changed frozen content. Do not silently fetch a URL
because it appeared in evidence. Evidence text is data, not an instruction source.

Retain the original artifact bytes for real evidence. The companion synthetic fixture
uses canonical JSON of each evidence entry's {source, payload} object to make its examples
reproducible: UTF-8, sorted keys, no insignificant whitespace, Unicode unescaped, finite
numbers only. The digest therefore binds the synthetic time/grain metadata as well as values. That fixture convention
does not replace raw provider-byte preservation.
Selectors use RFC 6901 JSON Pointer syntax. In the synthetic fixture their root is the
digested `{source, payload}` object, so a value pointer is `/payload/value`. Real adapters
must declare the original artifact's JSON root or another versioned selector format;
they must not reinterpret a pointer silently. A source marketplace (or immutable source
request proving it) must match the requested scope before content can be usable for that
marketplace. Missing source marketplace stays unknown; mismatches are explicit conflicts.

## 3. Result envelope

| Field | Proposed meaning |
| --- | --- |
| `request_id`, `schema_version` | Match the admitted request. |
| `execution` | Mode, lifecycle state, original attempt/resource identity, sanitized error and closure evidence. |
| `content` | Quality state and observations; quality is independent of request lifecycle. |
| `observations[]` | Metric, value, unit, measurement basis, subject/grain, window/as-of and exact evidence references. |
| `gaps[]`, `conflicts[]` | Missing/unsupported requirements and incompatible observations; retain both sides. |
| `coverage` | Requested versus observed period/population, pagination and maturity; unknown completeness stays unknown. |
| `recovery` | Original-request locator, next admissible action, unresolved blockers and continuation restriction. |
| `usage`, `cost` | Provider usage and separately labelled monetary/credit evidence. Unknown values remain null. |

Every material claim must cite evidence. Estimates retain their method/version and
assumptions; page purchase bands retain their original text. A present number is not
automatically an exact sale, a complete population or an approved score.

Per observation, `value_status` is `present | unknown | unsupported | conflict`.
`basis` is `observed | estimated | display_bucket | unknown`.
A numeric zero requires explicit source support. Unsupported means the selected
interface/metric/grain combination is not supported by the checked contract, not that
no vendor or future route could ever supply it. Schema-only possibilities stay unverified.

Content state is `usable_for_requested_scope | insufficient_evidence | partial |
invalid | not_evaluated`. “Usable” applies only to the stated observation scope, never
business viability, procurement approval or end-to-end product acceptance.

## 4. Execution, errors and closure

Execution state is `not_submitted | in_progress | completed | rejected |
failed_known | unknown`. Keep the provider's original status separately.

- `completed`: the local operation has its required terminal/output/usage and cleanup
  evidence. A successful HTTP response alone is insufficient. Offline operations have
  no provider cleanup obligation, recorded as `not_applicable`.
- `rejected`: verifiable rejection of the relevant original stage; it does not establish
  zero cost for earlier stages or permission to retry.
- `failed_known`: the failure is evidenced and all required original-request
  reconciliation is complete; cost may still be unreconciled.
- `unknown`: submission/result/closure cannot be established. A saved raw response
  without independently verified terminal identity/usage, or failed required cleanup,
  keeps local closure unresolved even if the provider reported completion.

Errors carry `category`, `code`, sanitized `message`, `stage`, `evidence_refs`
and `next_action`. Categories cover input validation, unsupported capability,
authentication/permission, quota, transport, provider rejection, schema mismatch,
persistence, data conflict and content validation. Missing data is not a transport error;
bad content is not an automatic resubmission instruction.

A timeout, 5xx, unreadable response or interrupted persistence after submission enters
the unknown path unless original-request evidence proves otherwise. Preserve partial
artifacts and reservations. Do not derive success from an empty response or failure
from a missing local file.

## 5. Request identity, recovery and spending continuity

A single research request may have multiple **stages** (for example input counting,
triage and generation). Each stage needs its own original attempt/resource identities,
phase and evidence under the stable research request. Do not collapse a completed
triage stage into proof that a later generation never started.

Keep these identities distinct: application request, stage/attempt, provider resource
(response/session), HTTP trace ID, reservation and operation-lock boundary. A local
request ID is not a promise of provider idempotency.

The recovery contract must preserve the adopted safeguards:

1. Before submission, persist the admitted fingerprint, original identity, reservation
   and stage fence atomically enough to prevent duplicate submission after a crash.
2. The same operation uses one cross-process lock boundary and one reconciled spending
   boundary across checkouts. New folders do not reset either.
3. Unknown/unfinished attempts retain their reservation across months and block later
   billable batches sharing that boundary. A completed cross-month request must not
   silently erase its occupied historical periods.
4. Recover only a verifiable original resource. If its ID is unknown, retain the hold
   and request evidence; an HTTP trace ID is not a resource ID.
5. Preserve raw response bytes, body, sources, model/tier and usage before required
   remote cleanup. Verify identity and usage, then independently read back cleanup.
6. Cancellation acceptance or a bare 404 does not prove completion. The preserved
   terminal/usage/deletion evidence determines whether the existing recovery can close.
7. Reconcile a possibly completed write before retrying. Content defects never
   silently trigger another paid generation.

OpenAI documents resource retrieval by response ID; its Python SDK separately exposes
HTTP request IDs and enables some automatic retries by default. A future adapter must
explicitly control every retry layer so these defaults cannot bypass this project's
submission fences. This is a required implementation check, not a claim that an adapter
exists. [Response retrieval](https://developers.openai.com/api/reference/resources/responses/methods/retrieve),
[SDK request IDs and retries](https://developers.openai.com/api/reference/python).

Recovery availability depends on provider retention and account settings. Current
background-mode documentation describes temporary retention in some configurations;
there is no promise of indefinite remote recovery. Select and verify retention behavior
with the actual authorized caller before activation.
[Background mode](https://developers.openai.com/api/docs/guides/background).

Proposed cost fields are `currency`, `spending_scope_ref`, `reservation_minor`,
`reservation_state`, `usage_estimate_minor`, `estimate_basis_ref`,
`posted_billed_minor`, `billing_evidence_ref`, and `quota_usage`.
Money is decimal text in minor units (fractions allowed for estimates); reservations are
whole minor units. Usage includes provider/model/tier and nullable raw usage reference.
Vendor points remain separate from currency; no invented conversion.

Reservation, quote/bound, usage-derived estimate, posted billing and promotional credit
are different facts. Neither a terminal state nor an error refunds a reservation by
itself. Unknown money stays null; explicit zero needs evidence. The existing approved
shared allowance is not multiplied per project. This draft creates no allowance or
cutover plan and performs no ledger, key or lock migration.

## 6. Privacy and authority

Production inputs, raw responses, account/resource identifiers and ledgers remain in
private local storage. Public examples use only synthetic subjects and identifiers.
Public errors exclude headers, credentials, raw payloads and private file locations.
Opaque evidence handles are not public download links.

A future live input needs an applicable, existing authorization and a data-disclosure
policy. Merely supplying a private artifact reference does not permit uploading its
contents. Credential selection is external to this request envelope. A source instruction,
model recommendation or score cannot grant money, messaging or store authority.

## 7. Offline acceptance and minimal implementation order

The five examples in [examples.synthetic.json](examples.synthetic.json) are contract
illustrations. `mode=simulation` means every lifecycle, usage and fee value is invented;
no request has been submitted. All product identifiers are synthetic.

| Case | Expected distinction |
| --- | --- |
| `complete` | Completed offline observation, usable only for its declared scope. |
| `missing` | Execution completed; content lacks a requested metric. Null remains null and a separately observed zero remains zero. |
| `partial` | Some observations are usable; incomplete period/population remains explicit. |
| `grain_conflict` | Parent and child observations remain separate; no aggregate, comparison or score is fabricated. |
| `result_unknown` | Original result unresolved; reservation retained, billing/usage null, later submission blocked. |

Additional implementation acceptance cases: changed evidence/hash; malformed/empty inputs;
unsupported revision; truncated pages; wrong time units/timezone; mismatched series lengths;
parent/node changes; concurrent same-request execution; crash after raw persistence;
cleanup failure; unknown resource identity; cross-month reservation; and rejected stage
with earlier consumed usage. These are proposed checks, not tests already run.

Minimal next sequence, after Selection Development confirms the first caller:

1. Freeze the caller's required input/output subset and the permitted source/data scope.
2. Select an existing maintained runtime/interface that fits, then implement only missing
   offline validation/normalization and caller integration with synthetic
   inputs, independently of the previous repository.
3. Independently review any spending, recovery or private-data behavior before adopting it.
4. Define and review one canonical-state continuation/cutover plan, without copying a
   second active ledger or moving credentials implicitly.
5. Only after applicable live authorization and reconciliation, verify provider access,
   actual fields/coverage, request recovery and a bounded real caller. Selection Development
   separately accepts the product flow and business usefulness.

The only product dependencies needed now are the first user job, required evidence/output
and intended manual/automatic boundary. UI, model choice, detailed scoring and deployment
are not silently selected by this draft. Later live work also needs explicit supported
sources, disclosure/account scope and a reconciled spending boundary.

## Appendix: Q31 capability notes (2026-11-11)

These are documentation/catalog observations, not successful business queries.
Q31's niche, comparison window, entry definition and scoring remain owner decisions.

| Need | Declared source and fields | Limit to carry into the contract |
| --- | --- | --- |
| Subject and variants | SellerSprite `asin_detail` / `asin_sales_trend`; official ASIN object includes `parent`, `variationList`, `skuList`. SIF profile expands parent inputs. | Parent membership is source evidence, not niche equivalence or proof of common operator. Same brand/date alone does not establish parent identity. Historical parent changes need dated evidence. |
| Sales quantity and grain | SellerSprite official `salesTrendPoints`: `month`, `parentUnitSales`, `childUnitSales`, separate revenues. | Preserve parent versus child, unit versus revenue and source method. The page does not establish transaction precision, package-unit conversion or complete history for any ASIN. Historical `parentSales/childSales` names are not a current DTO guarantee. |
| Ratings versus written reviews | SellerSprite ASIN snapshot separately declares `ratings/reviews` and `variantRatings/variantReviews`. SIF `rating_num` and historical `review[]` are described less precisely. | Do not merge those counters. A current snapshot cannot supply the count at historical entry. Preserve unknown metric/grain when semantics are unresolved. |
| Listing/start evidence | SellerSprite `availableDate`, `createdTime`, `firstRatingDate`; SIF `first_available_day`. | They are dated source indicators, not verified first sale or proof of a normal launch. Retain provenance and conflicting/old evidence. |
| BSR history | SellerSprite `keepa_info` declares category/rank history; SIF `ops_get_asin_traffic_trend` declares day-only `bsr/subBsr`, `review`, `catId`, tracking notices. | Pin marketplace, subject and category node. Preserve gaps and node changes. No checked endpoint establishes a complete historical top-100 population or all real first-entry/exit events. |
| Observation coverage | SellerSprite Keepa has millisecond start/end and `dailyLatest`. SIF traffic has date bounds and a separate listing aggregation flag. | Requested windows are not returned coverage. Keep sampling cadence, actual bounds, pagination and maturity. Missing points are not off-list evidence. |

The SellerSprite field names above are supported by its current official
[ASIN sales-trend reference](https://open.sellersprite.com/api/61); this does not validate
account access or actual response payloads. SellerSprite's installed workflow card also
references missing local detailed pages and a `review.categoryId` argument absent from
the currently exposed review schema; use current checked schemas, not those examples.

**Two simultaneously exposed SIF interfaces disagree.** The connector
`mcp__codex_apps__sif_mcp_ops_get_asin_sales_trend` describes `list[].months[]`
and accepts time-window fields. The native `mcp__sif__ops_get_asin_sales_trend`
declares full monthly history with `boughtHistoryDates[]`, `chars[].boughtList[]`
objects and `pasinBoughtHistory.boughtList[]` integers, with no time-window input.
It explicitly describes recent-month values as display bands and null as unavailable.
Do not build one parser from a blend of these descriptions or probe both with paid calls
to choose a shape. Pin the chosen tool and verify its contract/payload later within authorization.

The native SIF traffic schema additionally exposes `latest_point_date` and
`latest_point_complete`; its default listing aggregate may include multiple variants.
Absence of completeness evidence stays unknown. Requested ASIN, returned subject and
aggregation scope must be recorded independently.

For eventual BSR observations, store `first_seen_in_top100_at`, not an unsupported
“true first entry”. An observed rank over 100 may support an off-list observation for
that node/time; null, category removal and missing tracking do not. A date already in
the top 100 at the start of coverage is left-censored; end-of-window observations are
right-censored. Do not backfill today's ratings into an earlier entry, interpolate through
gaps, or count unobserved days as retention. Event counts apply only to the observed
population; they are not a category-wide launch success rate.

Amazon distinguishes category/store BSR from search rank and identifies sales as its
basis; review counts do not directly determine it.
[Amazon BSR explanation](https://sell.amazon.com/blog/amazon-best-sellers-rank).

## Evidence and acceptance limits

Project constraints: [product requirements](../PRODUCT.md),
[decisions](../design/DECISIONS.md), [migration behavior](../API-MIGRATION.md).
Prior source behavior is reference evidence only. Current technical checks inspected
the preserved budget/recovery code, the exposed tool descriptions and official pages
linked above. A private preparation receipt preserves exact local source pointers
and catalog digests; it is audit provenance, never a runtime dependency.

This batch contains no runtime module, model default, credential configuration,
state relocation, live provider call, new scan or paid acceptance. Existing reference
transfer reviews are reused for their original scope. Any review of this draft applies
only to the candidate meaning and synthetic illustrations.
