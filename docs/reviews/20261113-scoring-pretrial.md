# Pretrial scoring and business-definition review

Date: 2026-11-13. Scope: the current 21 trial items, reference populations, measurement meaning, screening and discovery-to-card handoffs, plus the unadopted total/missingness/ordering proposal. This is a design review, not product, live-data or business acceptance. Recovery remains in [STATE](../STATE.md); proposed choices remain in [DECISIONS](../design/DECISIONS.md).

The owner explicitly requested a fresh-context independent challenge. The critic received a frozen 13-document snapshot without the implementation conversation. The initial independent findings preceded the lead's proposed repairs. The owner then clarified that ordinary business scenarios and reference/data semantics matter more than merely checking arithmetic; the same review was extended on that basis. Original snapshots, the full independent report and exact saved-provider evidence remain private under `.local/reviews/20261113-scoring-pretrial-adversarial/` and `.local/reviews/20261113-real-scoring-r49/`.

## Consequential findings and dispositions

| Finding | Ordinary failure and consequence | Disposition |
| --- | --- | --- |
| Cross-card observation basis | One card uses ratings/sales at BSR entry while another uses current ratings/latest-30-day sales. A common formula alone does not make the observations comparable. | Proposed: use the current observation basis across this batch; retain entry history for qualification and context. Explicitly awaiting owner confirmation because this departs from entry-time preference for the batch view. |
| Count-share versus sales-share member set | Consistent numerator/denominator wording still allows one evaluator to use current in-list comparables and another to add off-list comparables for the 2-point share. | Proposed: explicitly use the same current in-list comparable BSR set for the 3-point count and 2-point sales items. Off-list/history observations retain their other approved roles. Awaiting confirmation. |
| Age anchor in a current comparison | A product was new when it entered a historical list but is older than three months now. Reusing its former age would contaminate a current newcomer pool. | State the observation date and evaluate current newcomer age at that date; retain event-time age in historical evidence. Included in the pending batch convention. |
| Tied exemplar selection | Several qualifying examples share the same capped low-rating score; selecting different pairs changes natural visibility or whether it can be scored. | Proposed mechanical rule: unrounded score, then frozen canonical family identity and ASIN. Never select ties by natural share or data availability. |
| Current referenced JSON contains obsolete pending flags | A reader following the current natural-score reference could incorrectly reject already permitted SIF-only evidence. | Fixed three status/reference fields to match accepted revision-48 rules. Revision 49, the 21 item mapping objects, weights, screening, economics and inactive flags are unchanged. |

These findings do not justify changing weights or withdrawing adopted curves. Preserved dated history is not itself a defect; conflicting text on an active reference path is.

## Business-scenario interpretation

| Ordinary scenario | Current interpretation and remaining work |
| --- | --- |
| Two-tier/three-tier racks, one/two-piece bundles, or metal/plastic alternatives | Classify by actual buyer substitution, use and consequential constraints. Material/layer/bundle labels alone neither force a shared market nor force separation. Distinct candidate forms retain their own costs and scores. Record inclusion/exclusion reasons before arithmetic. This adopted principle needs case validation, not a new universal taxonomy. |
| One parent contains several forms | Parent totals can describe only the supported family scope. They are not exact sales for the proposed SKU or bundle; a new child does not make an old family new. Verify scope and deduplicate both numerator and denominator. Mixed incompatible totals stay context or pending, rather than being apportioned by assumption. |
| Current list, exited entrants and New Releases | The count item uses current relevant in-list comparables. Low-rating medians have their separate observed qualified BSR-newcomer pool, potentially including exited cases that still qualify. New-Releases-only records remain auxiliary. The selected two examples never replace the full supported reference pool. |
| A short launch beside a mature 30-day observation | Keep actual supported units and launch coverage. Seek comparable exposure/stages, or leave the affected comparison pending. Do not extrapolate, impose a new minimum launch age or invent fixed age bins merely for this review. |
| Vine, a parent change, an old seller or sparse ads | Inspect observable timing, family, review and traffic evidence. These labels alone do not prove abnormal operation. Material unresolved qualification clues require targeted verification; absence of all offsite support or hidden common ownership is not a prerequisite. |
| A cheaper genuine competitor | The candidate's matched-price screening condition does not automatically remove a genuinely substitutable competitor from market evidence. Keep its actual price, bundle and relevance visible instead of improving the comparison by deleting competition. |
| An initial card versus owner-retained deep research | Initial source-backed market/economic/rights/requirements checks still apply. Supplier contact, physical measurements and comprehensive legal clearance are not silently required for every initial card. Missing material inputs remain explicit and prevent unsupported full-score claims. |

For each actual comparison, record the target form, comparator role, observed members, family/unit scope, source window, eligibility reasons and unresolved cases. These records make AI judgments reviewable; they do not turn every judgment into a fixed script rule.

## Shared scoring proposal

Keep all original weights. Sum complete supported item scores; retain coherent supported scenario ranges. Keep a null complete total when an item or screening condition is unresolved, with supported points, covered weight and specific gaps shown separately. A conditional possible range from missing inputs is not an earned score, confidence interval or prediction. No normalization, midpoint, extra suspicion deduction or total-score exclusion line is added.

Keep comparable and pending cards visible in the ordinary review flow. Proposed comparable ordering uses total score or the lower endpoint of a supported interval. Proposed pending ordering uses supported points, then covered weight for ties, with stable remaining order. This is follow-up priority, not a quality ranking of incomplete candidates. Inspect pending cards that might exceed a leading comparable card after evidence arrives, including those farther down the queue; do not assume a wide upper bound makes them good or allow them to disappear through neglect.

The procurement example uses separate P-series identifiers: P1 is a supported 76; P2 is a supported 74-80; P3 has 55 supported points across 70 covered points and lacks profit's 30. P3's complete total is null, with a broad conditional possibility of 55-85 if it remains eligible. Later profit of 25 gives 80; profit of 18 gives 73. These are teaching values, not results for the paused real candidates. Existing margin and specific-form rights exclusions remain independent of ranking.

## What the real trial must establish

- Correct reference membership and actual subcategory BSR evidence; a provider's 100 sales-ranked rows are not automatically a BSR top-100 snapshot.
- Actual periods, units and entity grain, including category-average versus market return rates and packaged measurements versus product dimensions or load-capacity claims.
- Source-to-judgment-to-score evidence for all active items, reasons for unusable inputs, and inspection of ordinary weak/pending cases as well as attractive examples.
- Stage time, actual request outcomes/usage, distinct reviewable forms and which recurring gaps prevent fully supported cards. No invented throughput target or automatic pass for honest blanks.

Domestic matched procurement and other applicable cost evidence remain necessary to validate full economics. The saved trial can continue testing independent paths when authorized, but partial cards cannot establish complete 100-point workflow acceptance. Product deployment, automatic scheduling, interface selection and final throughput targets remain later decisions; they are not reasons to restart all settled scoring questions.

## Execution-document readiness follow-up

The owner's subsequent request concerns preparation, fallible experience, clear execution documents and a comprehensive check before formal development. This follow-up reuses the original independent review instead of repeating unchanged scoring analysis. A byte comparison against the frozen 13-document snapshot found ten unchanged files before this follow-up; the changed files were STATE, DECISIONS and the previously reconciled three profile status/reference fields. Hash equality establishes version identity, not additional semantic review. The lead reread the active requirements, development process and first-release workflow/acceptance, and checked the current decision, Q31 and profile entry points. The independent critic continued a bounded document-readiness review. Original source conversations and every historical paragraph were not re-audited.

The first-release execution table, card requirements and closing checkpoint still contained active revision-47 descriptions saying that only 17 mappings existed and four were unfinished. Those entry points are corrected to the existing revision-49 decisions; the current profile itself is unchanged. Current-reading notes separate chronological discussion from active rules, and the open-questions section no longer presents revision-43 replacement weights as unresolved. Pre-edit copies of the affected documents are retained in the existing private review directory. No new scoring choice is adopted by these corrections.

The critic caught one new handoff ambiguity: requiring a fully concrete form/bundle at discovery would incorrectly reject or force an invented product for a sourced keyword/use lead. The handoff now permits a provisional or unresolved form during discovery and requires the concrete saleable configuration before its economics, comparable-sample calculation or scoring. This preserves the existing proactive-discovery workflow without adding a new field framework or an owner question.

| Readiness question | Current result and remaining work |
| --- | --- |
| Have the individual trial scores been specified? | Yes: eight groups, 21 mappings, 100 points. Their correctness on real inputs and calibration are separate. |
| Can the pending shared package be treated as approved? | No. Native-ratio interpretation and a desire for later calibration do not answer every total/order, population and observation-basis choice. Keep the specific proposal and its alternatives visible. |
| Is a bounded feasibility trial the same as building the application? | No. Reuse existing returned evidence, resolve applicable definitions and inspect actual source-to-score paths. Such a trial may identify a concrete missing field or infeasible rule before formal implementation. |
| Are the execution handoffs and verification subjects documented? | The first-release draft now groups required stage contents, meaningful verification boundaries and existing V1-01 through V1-13 acceptance subjects. This is a semantic contract; actual provider field adapters, application interfaces and runtime access remain implementation-design work. |
| What still blocks a complete real card? | Required source/judgment coverage, including qualified Q31 evidence and matched domestic procurement plus all other applicable economic inputs. Persisting blanks alone does not resolve this. Use the existing gap-to-remedy recovery process. |
| What remains before formal first-release implementation? | Settle the consequential shared rules and release behavior, select the supported runtime/workbench/reuse boundary, and define complete tasks with actual interfaces, recovery and acceptance. Ordinary engineering choices belong to the implementer; new material business, cost or access choices go to the owner. |
| When does testing happen? | Acceptance is written before code; source feasibility is tested early, meaningful behavior and failures during implementation, and the full selected workflow at final acceptance. Throughput targets follow measured trials rather than invented commitments. |

The independent critic's final readback found no remaining defect in this document-change scope after the two repairs. The lead separately checked local links, changed-line whitespace and Git whitespace checks, and confirmed byte-identical numerical profile and real-request ledger against the before copies. The receipt remains in the same private review directory. This verdict does not establish a finished spec, tested runtime, correct real grouping, complete card, publication or business effect. No new market, model, browser or supplier request was made.


## Revision 50 adoption and bounded feasibility follow-up

The owner explicitly adopted the shared total, missingness, ordering and revised newcomer-reference package, including two-provider keyword corroboration, and authorized continuation from saved real products. Independent incremental readback found and resolved one stale current observation-basis summary; all existing numerical curves, weights, screening and economic parameters remain unchanged and production flags remain false. The document-delta verdict is ship within that scope.

The bounded continuation has also produced a reproducible provisional newcomer score from real local evidence. Independent semantic and arithmetic review accepted that observed-cohort trial, with source-estimation, functional-comparability and coverage limitations. Native young-link proportions are not normal-start success rates, and first observed rank events are not complete histories. Real candidates, values, source payloads and the detailed review stay in the ignored trial directory referenced by STATE. Neither verdict establishes a complete product card, general market validity, daily throughput or whole-tool acceptance.
