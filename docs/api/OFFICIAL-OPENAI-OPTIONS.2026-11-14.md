# Official OpenAI options for one closed-evidence review

Checked: 2026-11-14. Status: documentation research and a proposal; no implementation or live acceptance.

Integration readback, 2026-11-14: selection adopted this research and its contract from the API seat's fixed delivery, but not the proposed Python runtime. The bounded scoring/card slice now uses dependency-free Node.js 24. A future commissioned review adapter should fit that caller; adding a second runtime has no demonstrated need here. The SDK inspection below remains dated research evidence. No SDK, model, paid review or API fallback is activated by adopting this document.

Official documentation was searched and fetched, including Markdown reference bodies. Official SDK metadata, release, license, README and relevant source were separately inspected through GitHub. No provider/model/account API request occurred; credentials, account configuration and live ledgers were outside this research.

## Single recommendation

Add one optional **comparison-subject and evidence-consistency review over the Responses HTTP API**, using the maintained official Python SDK. Send a bounded, anonymous evidence packet once and request a strict JSON result. This is the best fit for explanations, citations, contradictions and gaps in a custom object; OpenAI explicitly directs that use case to Responses Structured Outputs. This fit is an engineering inference, not measured quality improvement. [Structured Outputs][structured], [Decisions guide][decisions]

Subscription-backed Codex remains the main workflow. Disabled, unavailable, refused, incomplete, invalid or uncertain enhancement results leave its task available to Codex and must never silently become a completed review. The enhancement neither scores products nor changes weights, authorizes procurement, contacts suppliers, retrieves external evidence or performs tool actions.

## Contract summary

The [canonical evidence-review contract](EVIDENCE-REVIEW-CONTRACT.draft.md) owns the DTO, admission limits, caller behavior and acceptance requirements. The following is a capability summary, not a competing contract.

- Input: anonymous specification; an explicit list of possible comparison subjects; fixed `evidence_id` summaries with source/date/window/grain/limitations; and named questions. Treat evidence text as data, including any embedded instructions.
- Output: every supplied `subject_id` exactly once with `included`, `excluded` or `pending`; reasons linked to supplied evidence IDs; cited contradictions; unresolved questions and required evidence; a short conclusion. These dispositions concern membership in this comparison sample, not purchase or overall product acceptance.
- Local validation: reject invented IDs, duplicate/omitted subjects, unsupported included/excluded decisions, factual additions and instructions for external action. A genuinely absent source may leave a gap without citations, as the canonical contract specifies. An evidence ID establishes traceability, not truth; human/Codex source assessment remains necessary.
- One original generation attempt; no tools, retrieval, files, persistent conversation or automatic follow-up generation. Use `tools: []` and the canonical input/output bounds with an explicitly configured model. Exact storage/background settings remain unresolved until allowed disclosure, retention and original-ID recovery are reconciled. No account setting is selected or changed here. [Responses create][responses]

## Endpoint fit: verified documentation and interpretation

| Option | Verified capability | Fit for this exact task |
| --- | --- | --- |
| Responses, `POST /v1/responses` | Custom `text.format` JSON Schema; tools are separately configured; status, errors, incomplete details, model and usage are returned. Schema adherence covers completed, non-refusal output; business rules still require validation. [Create][responses], [Structured Outputs][structured] | Direct fit for a single explanatory review. HTTP avoids adding a durable agent session or orchestration layer. |
| Native Agents API, `POST /v1/agents/sessions` | Managed Codex harness, durable sessions and asynchronous turns; `environment.type: "none"` and `agent.text.format` JSON Schema are documented. Current examples/reference use `client.beta.agents`. [Overview][agents], [Create session][agent-create], [Sessions][sessions] | Technically capable, but sessions/events/turn recovery add work without a demonstrated benefit for this bounded, tool-free review. It is distinct from the client-side Agents SDK. No native activation is needed here. |
| Decisions, `POST /v1/decisions` | GA; current guide names only `gpt-6-luna`. Returns predicate, fixed choice or rubric score answers and per-question refusals. JSON input does not make the output an arbitrary schema. [Guide][decisions], [Create][decision-create] | A choice can classify one subject as included/excluded/pending, but cannot supply the requested free-form reasons, citations, contradictions and conclusion in one custom object. Do not add a second endpoint just for triage. |

## Lifecycle and recovery boundaries

Responses acceptance must check terminal status, refusal/error/incomplete content, complete JSON, local semantic rules, returned model and usage. An HTTP success alone is insufficient. Keep the original bounded request identity and available receipt privately. `max_output_tokens` bounds visible plus reasoning output; it is not a dollar limit. [Create][responses], [Structured Outputs][structured]

The SDK retries connection errors, timeouts and selected HTTP errors twice by default. Disable automatic retries for this paid create operation (`max_retries=0`) and set a deliberate timeout. A timeout, lost body or ambiguous 5xx after submission is **unknown**, not zero cost or permission to submit another review. Preserve the existing reservation, stop further paid enhancement submissions and reconcile the original operation; Codex's subscription workflow can continue. [SDK README][sdk-readme], [Retry source][sdk-base], [Project migration boundary](../API-MIGRATION.md)

The fetched Responses create reference and Decisions create reference did not establish a server-side deduplication or original-request lookup contract for an ambiguous create POST. This is a limit of the inspected evidence, not proof that no such capability exists. SDK retry machinery and a client correlation ID do not prove server deduplication. `store:false` is an option with a recovery tradeoff: it must not be presented as preserving later original-response retrieval. A stored/background option may support recovery within its retention period, subject to compatible disclosure and retention policy. Neither option guarantees recovery of a lost create acknowledgement without an original resource ID. [Responses create][responses], [Decisions create][decision-create], [SDK source][sdk-base]

Native Agents follow-up message submission has an explicitly documented `Idempotency-Key` procedure: preserve and reuse the same key/session/message after a timeout. Session streams do not replay missed events; recover saved session/items and inspect the turn outcome, since `idle` alone does not mean success. These guarantees must not be extrapolated to initial session creation or to Responses/Decisions. [Sessions][sessions]

Current beta create-session documentation places `spend_control` at the session level: `limit` is positive USD cents; omission/null makes the session unlimited; returned `consumed` is best-effort spend floored to cents and can be unknown. The earlier unaccepted native payload does not establish current field absence. The current documented shape does not establish acceptance of that historical payload, correct version/header/account access, or an independently verified hard billing ceiling. A new native compatibility task would need those checks; this review does not. [Create session][agent-create], [Migration status](../API-MIGRATION.md)

## Retention and billing caveats

- Responses storage defaults to enabled, with the documented retention exceptions. `store:false` does not itself grant Zero Data Retention: default abuse-monitoring retention can still apply. Background mode has separate temporary storage behavior. These are policy/recovery tradeoffs for the eventual execution policy, not a selected minimal-storage default. [Create][responses], [Data controls][data]
- Native Agents retains application state until deletion, is currently US-only for data residency and does not support ZDR; self-hosting its sandbox does not change that eligibility. [Overview][agents], [Data controls][data]
- Decisions is documented without persistent application state, subject to the data-control exceptions and abuse-monitoring policy. That is not a recovery guarantee. [Data controls][data]
- API pricing depends on the selected model, input/output, caching and service tier; reasoning output counts toward output usage. Native Agents uses model API rates, standard tool rates and hosted-container rates where applicable. No tools/container are proposed here. Usage/reservations are not a posted bill or credit balance. [Pricing][pricing], [Overview][agents], [Create][responses]
- The reported `$200/month` gift is owner-supplied context, **not verified balance, expiry, model eligibility, funding coverage or spending authorization**. No account entitlement, billing setting or model permission was checked. No model is selected by this report.

## Tiny maintained reuse proposal

`openai/openai-python` was public and non-archived when inspected; repository metadata reported its last push at `2026-11-13T21:12:48Z` and 32,153 stars. Stars indicate visibility, not audited production adoption. Latest non-prerelease returned by GitHub was **v3.51.0**, published `2026-11-13T21:12:49Z`; the license is **Apache-2.0**. Its README requires Python 3.10+, compatible in principle with this project's recorded Python 3.12+ baseline. Dependency installation and isolated runtime compatibility were not tested. [Repository metadata][sdk-meta], [Release][sdk-release], [License][sdk-license], [README][sdk-readme]

Reuse this SDK for HTTP/types and its structured-output support, behind one small project-owned review adapter. Its tagged Responses source exposes `create`, `parse` and retrieval methods; its README documents public request IDs, exceptions, retries and timeout controls. Preserve the project's own budget, evidence and unknown-request rules. Do not port the inactive legacy HTTP/agent stack wholesale or add an Agents SDK runtime, service platform, scheduler or fallback-provider chain. The maintained client already covers the transport need. [Tagged Responses source][sdk-responses], [README][sdk-readme], [Migration status](../API-MIGRATION.md)

## Material gaps before implementation or live use

1. Finalize the bounded packet/schema and caller seam with selection development; verify ID coverage, citations and unsupported-claim handling against synthetic fixtures. No actual card or business result was reviewed here.
2. Adapt only necessary request/reservation/receipt handling to this independent repository. Cover refusal, incomplete output, malformed payload, missing/zero usage, model mismatch, transport ambiguity and preservation of unknown reservations with offline fixtures; obtain independent review for spending/recovery/privacy changes.
3. Confirm the configured model supports the schema/settings and is eligible under the actual account/funding terms. Reconcile existing spending and in-flight state before separately authorized paid acceptance. The historical model policy is not a current default.
4. Resolve exact storage/background settings and private evidence retention against the canonical original-response recovery requirement before live execution. This is an implementation/activation gap, not a request for an owner decision now. Do not silently choose a weaker recovery policy, enable server storage, replay an unknown POST, release its reservation or equate a parsed result with useful business impact.

This report establishes current documented fit and a minimal proposal. It establishes no installed SDK, accepted standalone implementation, native Agents compatibility, live API acceptance, verified credit, or measured improvement.

## Fetched primary sources

[structured]: https://developers.openai.com/api/docs/guides/structured-outputs
[responses]: https://developers.openai.com/api/reference/resources/responses/methods/create
[decisions]: https://developers.openai.com/api/docs/guides/decisions
[decision-create]: https://developers.openai.com/api/reference/resources/decisions/methods/create
[agents]: https://developers.openai.com/api/docs/guides/agents-api/overview
[agent-create]: https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/methods/create
[sessions]: https://developers.openai.com/api/docs/guides/agents-api/sessions
[data]: https://developers.openai.com/api/docs/guides/your-data
[pricing]: https://developers.openai.com/api/docs/pricing
[sdk-meta]: https://api.github.com/repos/openai/openai-python
[sdk-release]: https://github.com/openai/openai-python/releases/tag/v3.51.0
[sdk-license]: https://github.com/openai/openai-python/blob/v3.51.0/LICENSE
[sdk-readme]: https://github.com/openai/openai-python/blob/v3.51.0/README.md
[sdk-base]: https://github.com/openai/openai-python/blob/v3.51.0/src/openai/_base_client.py
[sdk-responses]: https://github.com/openai/openai-python/blob/v3.51.0/src/openai/resources/responses/responses.py
