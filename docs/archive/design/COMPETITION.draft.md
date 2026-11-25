# Competition: accepted trial allocation and concentration scoring

Updated: 2026-11-13. Profile revision 45 records product dispersion **3**, brand dispersion **3**, and observed seller dispersion **4**, with the owner's revised common trial anchors: **40% or below earns full points, 60% earns half the item's maximum, and 80% or above earns zero**. The owner delegates the intermediate conversion and directs decreasing points across all three dimensions; use continuous linear interpolation. The owner also rejects the extra small-population exception, so there is no entity-count override. The separate entry-barrier item stays retired. These are trial point mappings, not live data or workflow acceptance.

The owner's subsequent simplification is part of this decision: cover common, practical scenarios first and use the three native concentration values from one relevant SellerSprite market report. Preserve its source basis as a label; do not make BSR-top-100 reconciliation, complete member recovery, custom market reconstruction or exceptional-population analysis prerequisites for these three point conversions. Real trials, rather than additional hypothetical branches, should expose material adaptation needs. This competition-specific simplification does not silently rewrite Q31's separately agreed newcomer sample.

## Provider definitions and selected trial view

The owner explicitly requires source metrics to retain SellerSprite's meanings. The project chooses score mappings; it does not redefine a provider's concentration, sample, period or unit. Any local regrouping or filtered recalculation must be labeled as such rather than presented as an unchanged native metric.

SellerSprite distinguishes its web market-research sample from a browser-extension analysis launched on an Amazon BSR page. Its [official explanation](https://cn.sellersprite.com/v3/knowledge/feature/user-defined-category-for-amazon-marketing-research) says web market research takes the category's top-selling products, whereas analysis opened by the extension on a BSR page uses that page's then-current top 100. Its [product-history explanation](https://www.sellersprite.com/cn/blog/inspiration-source-of-marketing-research) separately identifies monthly-sales top 100 as the web market basis. These are different populations. Current MCP declarations identify head samples and expose sample/head settings, but membership must be checked against the actual response before claiming a current BSR census. The Q31 current in-list BSR requirement is not silently replaced by a sales-ranked sample.

For a common supported sample and period, the provider's head-group concentration meanings are:

| Native dimension | Numerator for a head-ten view | Denominator |
| --- | --- | --- |
| [Product](https://open.sellersprite.com/api/31) | Estimated unit sales of the ten largest product records in the sample | Estimated unit sales of all eligible sample records |
| [Brand](https://open.sellersprite.com/api/32) | Estimated unit sales attributed to the ten largest brands across their sample products | The corresponding sample's total estimated unit sales |
| [Seller](https://open.sellersprite.com/api/33) | Estimated unit sales attributed by the provider to the ten largest seller groups across their sample products | The corresponding sample's total estimated unit sales |

Neither the number of brands/sellers nor their share of listing counts is this sales concentration. With a 100-product sample there need not be 100 brands or 100 sellers. The legacy API examples use fractional `totalUnitsRatio` values, separately from revenue ratios; retain the endpoint-specific units and verify current MCP transformations rather than assuming every field uses the same scale. The seller reference uses `name`/`asinSet` in its field table but `sellerName`/`asins` in its example: inspect real keys before writing an adapter. The documentation examples for different endpoints are not a verified common-period dataset and must not be combined into a real candidate score.

Use the three native values from the same relevant market report and observation period. This report includes established products and newcomers; it is not a newcomer-only sample. Preserve the provider's sales basis, sample label and period without relabeling a broad category as an exact niche or a calendar month as the latest 30 days. Recording these labels does not require reconstructing the sample or resolving every underlying record before trial scoring.

The head-ten view explains the native default discussed with the owner and the example below. Native head-count settings and underlying sample size are different: ten selected head entities are the numerator, not automatically the whole population denominator. Each dimension identifies its own head group after grouping by its applicable entity. Ten brands can contain many more than ten products. Keep the source view consistent during later trials, without introducing a separate entity-count scoring branch or rebuilding a valid native metric.

SellerSprite's [official market API reference](https://open.sellersprite.com/api/29) documents sample counts, total estimated units, and explicit head-group unit totals. The following is reference material for an adapter when needed, not a mandatory per-card reconstruction or a claim that each field has been returned by the current MCP:

| Purpose | Documented market fields | Use |
| --- | --- | --- |
| Scope and denominator | `topProducts`, `brands`, `sellers`, `totalUnits` | Check the source's actual sample and total estimated units; preserve applicable counts and coverage. |
| Product head units | `top10ProductSales` | Divide by the compatible sample total units. |
| Brand head units | `top10BrandSales` | Divide by the same sample total units. |
| Seller head units | `top10SellerSales` | Divide by the same sample total units, retaining provider seller attribution. |

Prefer the currently exposed native `category_report_detail` route when suitable: its declaration supports a shared category/sample, `LAST_30_DAYS`, `sampleCount`, explicit `topN: 10`, `familyMerge`, optional `asins`, and requested `competition`, `brandConcentration`, `sellerConcentration`, `sampleProducts`, `brands`, `sellers` and `totalSales` fields. This is a candidate one-report route to consistent inputs, not live acceptance of every option or its units. Do not infer actual membership or period solely from request parameters.

For head-list inspection, native `category_top_list` supports a dimension and `topN`, returning ranked items with `sales`, `salesShare`, and actual period fields. The legacy concentration tools also expose a head-count parameter. If those are the usable route, add the ten eligible source shares only after verifying their unit, denominator and consistent population, or use supported head-unit totals divided by a separately verified compatible population total. Do not divide by the sum of a top-ten-only response or invent the missing tail. Do not assume a generic concentration field uses ten heads; another endpoint/default may use a different group size. Prefer explicit head-ten fields or a verified explicit head-ten request.

Use the provider's reported market basis for this initial trial and retain the label. A materially wrong market selection should be corrected as ordinary research, but custom ASIN-set reconstruction is not part of this score conversion. The available ASIN filter remains an unverified optional capability, not an added first-version task or requirement. Seller-account identity is scoped to available IDs/names and records; no hidden-company tracing or seller-order reconstruction is added.

## Accepted common trial curve

Let `c` be the supported head-ten unit share expressed as a fraction and `w` the accepted maximum weight, 3, 3 or 4:

`score = w * min(1, max(0, (0.80 - c) / 0.40))`, for valid supported `0 <= c <= 1`.

The owner changes the earlier proposal to **40% or less: full points; 60%: half points; 80% or more: zero**. Interpret "half" in the preceding full/half/zero discussion as half of the item's maximum, not an absolute 0.5 points for each item. The owner explicitly leaves the 50% value to the implementer and asks for the three dimensions to decrease every ten percentage points. Linear interpolation therefore gives 75% of each maximum at 50% and 25% at 70%; each ten-percentage-point increase from 40% to 80% removes one quarter of the maximum. Intermediate concentrations are continuous, not rounded into buckets. These are project preference anchors, not SellerSprite scores or an industry standard. Actual strictness still requires real-sample calibration.

| Head-ten unit share | Product / 3 | Brand / 3 | Seller / 4 |
| ---: | ---: | ---: | ---: |
| 40% or below | 3.00 | 3.00 | 4.00 |
| 50% | 2.25 | 2.25 | 3.00 |
| 60% | 1.50 | 1.50 | 2.00 |
| 70% | 0.75 | 0.75 | 1.00 |
| 80% or above | 0.00 | 0.00 | 0.00 |

Keep full arithmetic precision internally; displayed rounding does not change the rule. A low or zero component is not an additional candidate-exclusion rule. Do not award separate bonuses for the same source concentration appearing in multiple views or for corroborating providers.

## Complete synthetic example

This is generated teaching data, **not a SellerSprite response or a real market result**. Assume the population has been validated as comparable, deduplicated and observed over one common period. It contains 100 product records, 30 brands, 25 observed seller accounts and 10,000 estimated sales units. The fixture can be generated from 100 consistent listing rows; the three head totals are not invented independently of each other.

| Dimension | Own top-ten unit total | Common sample units | Concentration | Trial points |
| --- | ---: | ---: | ---: | ---: |
| Product | 4,000 | 10,000 | 40% | 3.00 / 3 |
| Brand | 6,000 | 10,000 | 60% | 1.50 / 3 |
| Seller | 7,000 | 10,000 | 70% | 1.00 / 4 |
| Competition group | | | | **5.50 / 10** |

For example, brand points are `3 * (0.80 - 0.60) / 0.40 = 1.5`; seller points are `4 * (0.80 - 0.70) / 0.40 = 1`. A 55% concentration earns 1.875/3 or 2.5/4 before display rounding. The meaning is a relatively dispersed product view, more concentrated brands, and more concentrated seller attribution. It is not a verdict that the product is profitable, viable or approved. Other groups remain part of the overall evaluation.

## Necessary input checks

Apply the same curve to supported, compatible native concentrations without an additional minimum-entity-count rule, a special score for a small population, or a different formula selected case by case. A valid concentration at or above 80% receives zero for that component; this is not a whole-candidate rejection or proof of a market monopoly. Retain actual values and source counts for later real-sample calibration. Do not claim that any theoretical population or percentage is empirically impossible.

Missing data, invalid units/ranges, or materially incompatible scope/period leaves the affected component unscored. A zero sales denominator is not zero concentration. If brand/seller fields are missing or a partial list cannot support its claimed denominator, do not invent a value or redistribute the missing points. These basic input checks must not expand into exhaustive ownership or hypothetical-edge-case research. A supported provider summary does not require reconstructing every underlying transaction.

## Superseded proposal record

Revision 44 proposed 40% full / 70% half / 100% zero and a separate unscored branch when a dimension contained no more than ten entities. Neither was adopted. The owner's subsequent messages replace the numerical anchors and reject the extra entity-count branch. The historical share-square proposal was also never adopted and is not a fallback. Preserve the revision-44 documents and synthetic 7/10 arithmetic as historical proposal evidence in the ignored before-snapshot; the current example is 5.5/10 under revision 45.

## Execution and remaining acceptance

Codex selects a relevant market during ordinary research and explains meaningful source mismatches. Ordinary code reads the three native values, checks basic presence/units/range and applies the accepted trial curve; it does not let the model choose points freely. Reuse the same market evidence across applicable candidate forms. Supplier contact, corporate-control research and a complete historical market census are not initial prerequisites.

No new selection-data request or formal scorer was implemented for this curve update. Reuse the official-source and native-declaration checks from the preceding turn; the revised anchors, interpolation, unchanged sample aggregates and absent count override are checked offline. A later bounded authorized trial must establish usable native fields/units, the shared report basis, error/missing-data behavior, elapsed time and useful scoring. It need not establish a complete member census. The native general MCP guide timed out in the source check; only the successfully retrieved official market reference and live tool declarations were treated as inspected source material.

Next: present the revised table as one coherent group and continue the remaining material scoring definitions. Do not reopen these anchors or restore the withdrawn entity-count exception without concrete new evidence. Later authorized real-market trials must check whether this curve is too strict or too lenient. A synthetic 5.5/10 does not establish live acceptance; the profile remains design material, with production/import activation false.
