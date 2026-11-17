# Suggested-bid pressure: confirmed 15-point trial

Updated: 2026-11-17. Revision56 adds the owner-approved equal-entry mean when every main entry has a usable exact point and only monthly search volume is missing. Complete compatible monthly weights remain preferred; revision55's genuine sole-entry rule and the 15-point curve remain unchanged. All 21 mappings are maintained in the current profile. This is trial-rule adoption, not production calibration or an advertising instruction. Earlier revisions remain available for matching historical replay.

## Accepted inputs and source treatment

Use the same marketplace, currency and literal query, taking explicitly exact-match native point and bound fields. SellerSprite supports exactPpc/minExactPpc/maxExactPpc or ppc.exact.value/min/max. SIF uses supporting_signals.cpc_fixed_exact/cpc_fixed_exact_low/cpc_fixed_exact_high. Do not substitute generic bid, phrase or broad fields.

SIF fixed/exact is selected. The tested SellerSprite batch does not state bidding strategy; its exact values are accepted as approximate trial inputs with this limitation visible. Keep available date/period and strategy labels. The average does not harmonize different strategies, establish source accuracy or turn a stored observation into a real-time quote. Known incompatible strategies must not be silently pooled.

For a main query:
- Both usable points returned: b_i = (b_SS_i + b_SIF_i) / 2.
- One usable point: use it with a single-source label and preserve the other source's gap.
- Neither usable point: needs evidence; no zero, invented midpoint or endpoint substitution.

Equal source weights are a transparent trial convention, not measured accuracy or independence. The combined value is project-derived; retain both native points and ranges.

## Main-entry aggregation

Identify supported main purchase entries relevant to the candidate's actual use and specification before choosing terms by bid. Important longtails can be main entries. Keep cheaper peripheral opportunities visible separately; their count must not dilute the main pressure. No fixed core/longtail 9/6 allocation or keyword quota is introduced.

For exactly one genuine main purchase entry, use its usable exact point directly: B = b_1. The same two-source mean or labeled single-source treatment above still applies. Monthly search volume and its period are not prerequisites for this case; retain unavailable volume as unknown. This does not infer demand scale or permit calling the only returned point the only genuine entry. Source research must support the selected entry set and retain consequential unresolved additional entries.

For two or more main entries, use compatible SellerSprite monthly search volumes for one common period. Do not mix in SIF weekly counts or scale them into invented monthly values. For the chosen main-entry set M:

a_i = v_i / sum(v_j for j in M)
B = sum(a_i * b_i for i in M)

These are research-importance weights, not orders, actual candidate traffic or future ad allocation. Keep computation precision until display. Calculate B first, then apply the capped curve.

If every selected main entry has a usable exact point but at least one monthly search volume is missing, revision56 uses equal weights across the entire selected set: a_i = 1 / |M| and B = sum(b_i) / |M|. First combine the sources within each query as above, then average entries. Do not average all provider rows together, overweight the entries with returned volumes or drop the unweighted entries. Keep observed volumes and unknowns visible and label the result as equal-entry trial weighting, not measured demand shares.

For example, three main-entry combined points of USD 1, 1.50 and 2 with unavailable monthly weights give B = 1.50 and 9/15 points. Two entries of USD 2 and 1 with complete monthly weights of 100 and 300 still give B = 1.25 and 10.5/15. If either entry instead lacks a usable exact point, neither example qualifies for equal-entry scoring.

Missing any required main-entry exact point leaves the item pending. Supplied invalid numbers, incompatible units/periods, unresolved conflicts or unsupported evidence require correction; they are not a missing-volume exception. An observed all-zero volume set still has no usable positive weighting total. A common volume period is unnecessary when all volumes are absent; supplied numeric volumes still need compatible common-period evidence. Supported zeros require valid source meaning; placeholders are not observed zeros. Never trim a multi-entry set to invoke the sole-entry rule. Frozen revisions50–54 retain their original volume requirement, and revision55 retains its multi-entry volume requirement.

## Accepted curve

score = 15 * min(1, max(0, (3.00 - B) / 2.50))

| Derived USD reference | Points / 15 |
| ---: | ---: |
| 0.50 or below | 15 |
| 1.00 | 12 |
| 1.50 | 9 |
| 2.00 | 6 |
| 2.50 | 3 |
| 3.00 or above | 0 |

Between anchors the score decreases continuously. These are owner-approved trial preferences requiring real-sample calibration, not industry thresholds. Zero here does not exclude the candidate. Profit retains its own budget; no invented new-product CVR, CPA or profitability multiplier is added.

## Ranges, conflicts and display

Show each provider's original point and bounds beside the derived reference. Bounds can supply separately labeled scenarios, not confidence intervals, actual CPC forecasts or a replacement point. Source disagreements and range width do not add an automatic penalty. If input validity or scope is materially wrong, flag the affected input rather than disguising it with an average.

Suggested bids remain references, not observed CPC. The [SellerSprite explanation](https://www.sellersprite.com/cn/v3/knowledge/feature/realtime-bid-tracker-for-beginners) makes this distinction. Its real-time query product does not establish that the tested keyword_batch_info path returned real-time quotes.

## Acquisition workload and current evidence

Reuse competitor/keyword evidence already obtained during discovery and competition research. Review relevance and consequential omissions, then use deterministic field extraction, deduplication and arithmetic. The previously discussed three-to-five listings and twenty-to-thirty queries are optional first-batch guidance when more evidence is needed, not a mandatory investigation per card or a completeness threshold.

Current declarations allow multi-ASIN reverse queries and up to twenty keywords per batch in each provider. Small live batches returned exact point/bound data, with partial coverage and disagreements. These observations do not establish full-card speed, useful daily output or reverse-query live acceptance. Context isolation and parallel work are whole-workflow design questions, parked while scoring closes.

On 2026-11-17 a bounded real-card query validated a distinct acquisition path: the authenticated SellerSprite real-time bidding website returned native SP exact points for the complete previously selected query set whose static MCP fields were incomplete. The website groups the applicable strategy as `仅降低/固定`; preserve that literal label and use only its exact column, which explicitly includes fixed bidding. Do not substitute its adjacent up-and-down, broad or phrase columns. Retain the ASIN, task ID, actual query time, query count, literal queries, original bounds, and completed row count in private evidence. Listing or weekly-context dates are not the quote timestamp or monthly search-volume period.

This is source acquisition under the existing rule, not a new fallback score. The latest applicable same-provider quote replaces its older snapshot; it is not a second provider observation to average. Preserve the older response and SIF gaps. A missing common monthly weighting set can then use the already approved revision56 equal-entry calculation. Website task allowance is separate from MCP allowance; record actual consumption and reconcile a submitted task before any retry. Manual UI transcription must be labeled as such, not represented as a raw API response or exported file. This successful bounded query does not establish an automated website adapter or universal keyword coverage.

Private live responses and the source comparison: .local/reviews/20261113-exact-bid-two-source/.
Private real-input worked arithmetic and original unadopted proposal: .local/reviews/20261113-bid-two-source-scoring-proposal/.
Revision-46 before-snapshots, this approval and readback: .local/reviews/20261113-bid-adoption-q31-closure/.

The earlier three-query demonstration used genuine observations but did not establish a complete main-entry set for any actual candidate. No source, competitor or model request was made to adopt this mapping.

## Acceptance still required

Check native-field selection, both/single/missing-source behavior, consistent weighting scope, clipping and arithmetic; preserve all other rules and weights. Later real samples must test relevant-entry selection, source differences, missingness, score strictness and combined influence across categories. Formal runtime, full-card acceptance and business outcomes remain separate. Production eligibility and import activation stay false.
