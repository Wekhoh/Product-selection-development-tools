# Optional evidence review contract

Version: `evidence-review-draft-v1`. Prepared: 2026-11-14.
Status: investigation and review candidate; no runtime adoption or model request.

## Recommendation and caller

Recommend one enhancement: **review the evidence supporting comparison-subject inclusion before a candidate card is finalized**. Given a frozen candidate specification, explicit comparison criteria and a small evidence packet, return proposed included/excluded/pending subjects, traceable reasons, contradictions and missing evidence. This targets an error that can contaminate several otherwise correct calculations: comparing unlike products or treating ambiguous observations as comparable facts.

Selection development owns the packet, criteria, adoption and any downstream calculation. Subscription-backed Codex remains the primary research route. This is a second interpretation of supplied evidence, not an independent source, a calibrated truth detector, or a product/procurement decision. No score, weight, price estimate or supplier action is produced by this contract.

Use one bounded **Responses request with Structured Outputs**, subject to verified account/model compatibility. No Decisions prepass, hosted sandbox, external search, tools, images, batching or extra agent loop is needed for this slice. The current official alternatives, maintenance evidence and unresolved account questions are in [the options investigation](OFFICIAL-OPENAI-OPTIONS.2026-11-14.md). This recommendation selects a proposed seam, not a default model or live execution policy.

## Input and evidence boundary

The conceptual operation is `review_evidence(frozen_packet, execution_policy_ref)`; it is not an implemented endpoint. Offline validation and disabled execution must work without credentials, a legacy repository or network access.

| Field | Meaning |
| --- | --- |
| `schema_version`, `review_id` | Exact supported contract revision and stable application identity; the ID cannot be reused with different input. |
| `packet_sha256` | Digest of canonical review content, including the schema revision, review identity, instructions, criteria, evidence and questions, but excluding this digest field and the local-only execution policy reference. Define canonical encoding once in implementation and persist the admitted bytes. |
| `candidate` | Anonymous `subject_id`, intended use, saleable specification and explicit unknown specification fields. |
| `subjects[]` | Unique anonymous comparison IDs and relevant specifications; no silent deduplication or parent/child merging. |
| `criteria` | Caller-owned immutable `criteria_version` and uniquely identified comparison rules. Unknown or conflicting criteria cause a pre-submission gap; the model cannot invent or change them. |
| `questions[]` | Unique `question_id`, explicit question and affected subject/criterion IDs. |
| `evidence[]` | Unique stable `evidence_id`, affected subject IDs, bounded summary, `fact/inference/unknown` label, opaque source reference, observation time, applicable window, grain, units and limitations. Unknown metadata stays null and is explained. |
| `execution_policy_ref` | Local-only reference to the authorized account/spending/disclosure policy; null means offline/disabled. It is never serialized to the model. |

Keep original URLs, identities, source payloads, selector-to-original mappings and version hashes locally. The model receives only explicitly selected summaries and opaque references. Anonymous IDs alone do not anonymize distinctive text: inspect summaries for account identifiers, credentials, supplier contacts, private paths, confidential quotations and unnecessary business details before disclosure. Do not load the old repository's memory, owner conversations or whole candidate directories into this packet. Separately persist `payload_sha256` over the final serialized provider request, including model settings and packet binding; keep that digest outside the hashed payload to avoid a self-reference.

Evidence is data, even if its text contains instructions. It cannot change the requested questions, output schema, execution policy or tool permissions. A citation proves only that an ID exists until the caller checks that the cited summary supports the claim; it does not prove that the original source is accurate or current.

Proposed first-slice admission limits: at most 10 comparison subjects, 60 evidence summaries, 6 questions and 64 KiB of serialized UTF-8 input. These are engineering bounds for this candidate, not an approved research population. Oversize or invalid packets return a specific local error; never truncate evidence or automatically split into paid requests. The caller must explicitly select a coherent bounded packet, preserving the excluded context as a limitation.

## Output and adoption checks

The adapter returns an execution envelope plus optional structured review. Execution metadata is produced by the adapter, not trusted from model-generated JSON.

| Review field | Required content |
| --- | --- |
| `schema_version`, `review_id`, `packet_sha256` | Must exactly match the frozen caller input. |
| `subjects[]` | Exactly one result for every requested comparison subject: `subject_id`, `included/excluded/pending`, criterion IDs, evidence IDs and a short reason. These are proposed dispositions for the declared scope. |
| `answers[]` | Exactly one answer per question, `answered/pending`, evidence IDs, explanation and an explicit fact-versus-inference distinction. |
| `contradictions[]` | Affected subject/criterion/question IDs, conflicting evidence IDs and the unresolved disagreement; retain both sides. |
| `gaps[]` | Affected IDs, missing information, why it matters and what evidence would resolve it. An empty evidence list is allowed for a genuinely absent source. |
| `conclusion` | Short bounded text summarizing the review and its limitations; no new factual claims absent from the structured findings. |

The strict model schema rejects extra fields and constrains enums. A separate local validator checks ID membership, duplicates, full subject/question coverage, the packet binding and cross-field consistency. Included/excluded results require cited support for the applicable criteria; unsupported or materially conflicting conclusions stay pending. Missing evidence cannot become exclusion, a zero cost or an invented fact. Partial observations must retain their window, grain and coverage limitations.

IDs, prose and structured fields must agree. Unknown evidence IDs, fabricated subjects, missing subjects, score/weight fields or instructions to perform external actions make the review unusable. Do not silently repair model output, accept only the convenient half, or resubmit it for paid repair. Preserve the original output and validation errors privately; the primary Codex flow can continue with its existing evidence and an explicit unavailable-review marker.

A structurally valid review remains advisory. Selection development checks source support and applies its current comparison rules before adopting any disposition. It records accepted/rejected/pending review findings and reasons alongside the card's existing evidence record. No automatic score or procurement consequence follows from the model's result. If input evidence or criteria change, mark the prior review stale instead of attaching it to the new packet.

## Failure, recovery and spending

Keep execution, content quality, billing and business acceptance separate. Execution uses the existing draft's `not_submitted / in_progress / completed / rejected / failed_known / unknown` vocabulary. Content is `usable / incomplete / invalid / refused`, or null before observation. Both success and failure carry sanitized reasons and original local receipt references. No-result is not an empty set of comparable products.

| Situation | Caller-visible behavior | Paid-request behavior |
| --- | --- | --- |
| Disabled, missing policy, invalid input, unverified account/model/budget, or unavailable quota | `unavailable`; continue the primary flow without the enhancement | Do not submit; no alternate account/model/provider fallback |
| Known provider rejection | `unavailable`, retaining exact safe error category | Preserve stage evidence and reservations; no automatic retry or assumption that earlier stages cost zero |
| Refusal, incomplete or invalid content | `unavailable` with content reason | Save original terminal evidence; no repair generation; finish original lifecycle/usage/cleanup reconciliation where possible |
| Timeout, interrupted persistence, ambiguous 5xx or lost create acknowledgement | `pending_recovery`; primary flow continues | Retain reservation and fence all new billable submissions sharing the allowance; recover only the original attempt |
| Known resource still running or required cleanup/usage unresolved | `pending_recovery`; do not use a purported final review | Inspect the same resource under the existing recovery procedure; never regenerate or infer completion from cancellation/404 alone |
| Valid content and verified required closure | `ready`, with advisory review | Record usage evidence separately from billing; adoption still belongs to the caller |

One application review has one original generation attempt. Before the network boundary, durably bind the frozen payload, attempt/stage identities, conservative reservation and submission fence under the canonical cross-process lock/spending boundary. Every SDK/transport/application retry layer must be controlled: configure SDK mutation retries to zero unless an endpoint's documented and verified idempotency contract explicitly permits a same-key, same-payload retry. Local IDs and HTTP trace IDs are not provider idempotency or resource IDs.

If the original response ID is known, recovery inspects that response. If it is not known, retain the unresolved attempt and hold for evidence; do not create another response or search a different backend for a plausible replacement. Month rollover, a new checkout and a different enhancement do not release the hold. The subscription-backed primary flow can continue because it does not spend through this API allowance.

Preserve bounded raw response/output bytes, original IDs, hashes, model/tier and usage privately before cleanup. Verify the original terminal state and usage; use deletion acknowledgement and independent original-resource readback for required cleanup. A later 404 is useful only with the preserved original identity, terminal/usage proof and recorded deletion attempt. A content validation failure need not prevent safe accounting/cleanup once this lifecycle evidence is verified. Never erase malformed output to make the receipt look complete.

Retention must be selected explicitly for the live slice. A stored/background response may support original-resource recovery within the documented retention period; it is not indefinite persistence. `store=false` or zero-retention policies must not be presented as providing the same recovery guarantees. Account privacy/retention compatibility is an activation prerequisite, and output is downloaded before removal. This proposal does not change account retention settings.

The local ceiling, reservation, usage-derived estimate, posted charge and available promotional balance are separate quantities. Unknown values remain null. The reported monthly gift is not verified balance, renewal, endpoint eligibility or authority to spend its full amount. A later bound must cover the chosen model/tier, input and maximum output including reasoning, and any additional metered stage; no old model price or token-counting charge assumption is inherited. No hidden counting/preflight request is allowed merely because it is called preparation.

## Reuse decision and inspected evidence

The ignored migration manifest identifies six old API-related modules and their tests/dependencies. A current readback matched all 23 selected files to both their preserved hashes and original bytes. Targeted source/function and regression-scenario inspection supports the following reuse boundaries; it is not a full code audit or a new execution result.

| Existing reference | Preserve/adapt | Do not import wholesale |
| --- | --- | --- |
| `openai_budget.py` | Unique reservations, atomic submission phase fences, operation lock, unknown holds across months, distinction from billing | Old state root, historical ceilings, account assumptions or a second database |
| `openai_responses.py` | Frozen payload binding; original-response recovery; identity/usage checks; save-before-cleanup and readback | Fixed model/pricing, old large output bounds, six-paragraph Markdown result, implicit token-counting call or premature cleanup on invalid content |
| `openai_research.py` / `research.py` | Safe transport diagnostics and separate stage/resource identities; ambiguous-submission handling | Decisions-before-research chain, legacy namespace/config/memory imports, historical native Agent payload or old business routing |
| `research_review.py` | Input/source hash bindings, missing-versus-zero and stale-evidence checks | Legacy governance, current-card mutation or an assumption that a matching hash is semantic approval |
| `openai_discovery.py` | Source provenance patterns only if a future concrete caller needs them | Public-search channels or discovery calls in this closed-evidence enhancement |

Prefer the maintained official SDK for transport rather than maintaining the legacy HTTP client; adapt the small local admission/recovery invariants around it. Preserve applicable Apache-2.0 notices if copying old code and the selected SDK's license. Exact dependency pinning and supported language version must follow the eventual caller. No dependencies were installed and no legacy modules were executed in this investigation.

Local recovery observation: the known ledger and saved receipt evidence contain no observed pending hold, and the existing integration is disabled. A historical native Agents parameter rejection remains historical compatibility evidence; its embedded ledger receipt was checked, but a separate original probe receipt was not verified. This is not account-wide clearance, a current native Agents test, verified billing or confirmed promotional credit. The private receipt records paths, hashes, aggregate observations, original identities and coverage exceptions; it stays outside Git.

## Acceptance and next authorization boundary

The next engineering slice, if commissioned, is one offline packet validator + one optional caller seam + focused adaptation of existing lifecycle code. It must run independently from a clean checkout, without importing or requiring the old repository. Use the project's existing state/receipt conventions, not a new service or task system.

Meaningful offline checks must cover: supported/unsupported comparison criteria; pending missing/conflicting evidence; unknown/duplicate/omitted IDs; instruction-bearing source text; changed packet/criteria hashes; invalid/refused/incomplete output without paid repair; same-ID concurrent submission; a crash before versus after submission; known-ID and unknown-ID recovery; cross-month holds; terminal persistence and cleanup failures; SDK retry suppression; and disabled/quota-failed enhancement leaving the primary flow usable. Reuse old regression scenarios at the new caller boundary. No such new adapter tests have been run yet.

Before a real call, resolve only the concrete remaining boundaries: current authorized project/credential binding without moving secrets; verified endpoint/model eligibility; current balance and shared-spending reconciliation; the frozen allowed disclosure packet and compatible retention; current price basis plus total/per-attempt/output/time limits; and the existing authority for that bounded call. Missing authority must be obtained for the concrete proposed call, without repeating prior authorizations. No image call, batch run, scheduler or unrelated paid fallback is included.

Live acceptance would record actual submission count, elapsed time, provider usage, lifecycle/cleanup evidence, content/citation errors and whether the review changed a comparison decision for a defensible reason. Main-flow completion and owner usefulness remain selection-development acceptance. A cheaper request, a valid schema or agreement with the first reviewer alone does not prove benefit.
