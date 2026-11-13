# Suggested-bid pressure: confirmed 15-point trial

Updated: 2026-11-13. The owner explicitly accepts the complete trial package. Profile revision 47 records the mapping for relevant_purchase_entry_bid. Seventeen of 21 item mappings are now recorded; four remain incomplete. This is a design approval, not implemented production scoring, calibration or an advertising instruction.

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

Use compatible SellerSprite monthly search volumes for one common period. Do not mix in SIF weekly counts or scale them into invented monthly values. For the chosen main-entry set M:

a_i = v_i / sum(v_j for j in M)
B = sum(a_i * b_i for i in M)

These are research-importance weights, not orders, actual candidate traffic or future ad allocation. Keep computation precision until display. Calculate B first, then apply the capped curve.

If required main-entry bid evidence or weighting volume is missing, retain that entry and leave the item pending; do not drop it and renormalize the remaining set to produce a complete score. Supported zeros require their source meaning to be valid; placeholders are not observed zeros.

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

Private live responses and the source comparison: .local/reviews/20261113-exact-bid-two-source/.
Private real-input worked arithmetic and original unadopted proposal: .local/reviews/20261113-bid-two-source-scoring-proposal/.
Revision-46 before-snapshots, this approval and readback: .local/reviews/20261113-bid-adoption-q31-closure/.

The earlier three-query demonstration used genuine observations but did not establish a complete main-entry set for any actual candidate. No source, competitor or model request was made to adopt this mapping.

## Acceptance still required

Check native-field selection, both/single/missing-source behavior, consistent weighting scope, clipping and arithmetic; preserve all other rules and weights. Later real samples must test relevant-entry selection, source differences, missingness, score strictness and combined influence across categories. Formal runtime, full-card acceptance and business outcomes remain separate. Production eligibility and import activation stay false.
