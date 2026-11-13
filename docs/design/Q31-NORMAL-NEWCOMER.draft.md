# Q31：正常新品 10 分试评建议

建立：2026-11-11；更新：2026-11-13。状态：3／2／4／1 分配与四项完整试评规则均已确认，具体真实样本、取数可得性、判断准确度和跨类目校准仍待验证。本稿不是正式算法实现或运行配置。原 2／2／3／3 未获采用。

Current numerical source: [reference-profile.draft.json](reference-profile.draft.json), revision 50. All 21 item mappings and the shared total/missingness/order package are accepted for trial. The owner also accepts the reference changes below and requests continuation from saved real products. Older dated sections preserve history; the single recovery entry is [STATE.md](../STATE.md). No production or real scoring acceptance follows merely from recording the rules.

## Accepted reference adjustment (revision 50)

Owner clarification, 2026-11-14: old reviews clearly predating a purported recent launch are sufficient to exclude that listing from the normal-from-zero reference. Do not spend further effort identifying the precise refurbishment/merge/seed-listing mechanism as a prerequisite to this exclusion. Preserve the observed history and exclusion reason as market evidence. This is distinct from missing dates, ordinary seller age or an unsupported accusation of a particular technique. The accepted native-report 3/2 inputs remain native labeled observations; do not silently replace their source population with the qualified 4/1 cohort. No weights or curves change.

Use one relevant SellerSprite native market report, explicitly three-month newcomers, for both count-share 3 and unit-sales-share 2. Keep the actual source population, latest-30-day window and family basis; a source sales-ranked sample is not a current BSR snapshot. These inputs supersede the prior niche-filtered current-list 3/2 basis for this trial. Select source relevance before scoring, preserve niche context separately, and do not switch inputs to obtain a higher score. All curves remain unchanged.

The 4-point reference remains the observed genuinely comparable, supported normal-start BSR-newcomer cohort, including current in-list and still-qualified exited entrants. For this batch use current rating counts and compatible latest-30-day sales consistently, with newcomer age at the observation date; keep entry-time history separate. The existing stage-comparability, no-extrapolation and unknown/zero rules remain. Rank complete example scores before rounding; resolve equality by frozen family identifier then ASIN ascending. The same pair supplies natural visibility, with both providers' keyword counts checked as described below. See [the accepted shared package](DECISIONS.md#accepted-shared-scoring-and-q31-references-revision-50).

## Bounded source feasibility observation (2026-11-13)

The saved real-product continuation has now returned relevant-node rank and rating history, observed exits, review-origin markers, complete requested-ASIN recent-30-day unit estimates, both providers' keyword counts and SIF overall exposure shares with relevant-query evidence. The four components are recomputable for the explicitly bounded provisional cohort; this establishes that the path is feasible for these observations, not universal coverage or automatic qualification accuracy. Direct parent-ID histories and source first-available dates require careful reconciliation, and native young-link counts are not certified normal launches. Preserve ordinary count/update differences; do not derive exposure shares from counts. The current native prediction endpoint declares requested-ASIN scope without automatic parent aggregation; estimation accuracy remains unvalidated against actual seller orders. All real details, unresolved records, source declarations and recomputation remain in the private trial directory referenced by STATE. No weight, curve or production flag changes follow from this observation.

## Accepted closure for the remaining 4 + 1 points (revision 48)

The owner explicitly accepts the coherent closure package on 2026-11-13. This accepts weaker but complete capped examples in pair selection and the practical source/missingness boundaries below. Earlier point curves remain unchanged; the two full Q31 mappings are now recorded. This does not establish actual source availability, reliable market grouping, calibrated scores or runtime acceptance.

### What the sample represents

Six products in the teaching table are synthetic, not retrieved products, a maximum, a required minimum or a claim that the niche contains only six. The niche is defined first by genuine buyer substitution in use/function and consequential specifications, including the accepted conditional cross-material comparison. BSR and New Releases are sources and observation filters, not automatic definitions of that niche.

- The earlier revision-48 niche-filtered count/sales reference is superseded by revision 50's same native report for 3/2. The separate genuine-niche qualification below still governs 4/1; it is not broadened to all source-designated newcomers.
- The low-rating 4-point primary reference contains all observed qualifying comparable normal newcomers with documented relevant BSR-top-100 observations and compatible evidence. Current and supported historical entrants retain their states; historical observations may participate only under the same valid observation basis. Do not pool current and entry-event records into one median.
- New-Releases-only and other off-list comparables remain discovery, competition, supporting-sales and follow-up evidence. They do not directly enter these primary newcomer medians unless they independently meet the accepted BSR qualification.
- Compute reference medians from the defined supported cohort, not only successful or finally selected examples. Report observed, usable and unresolved coverage. Do not stop merely at six, hide failed/weak cases, claim a census from partial results or require exhaustive historical retrieval.
- Two is only the accepted exemplar aggregation count after individual scoring. It is not the reference-cohort size. A larger available qualified cohort stays available for the reference; a smaller cohort is disclosed, with the accepted single-case/missingness treatment.

### Shared evidence basis

Use the already confirmed comparable normal-newcomer scope: three months or younger, genuinely substitutable use/specification, documented entry into the relevant BSR top 100, and supported launch/family/rating history without an unresolved contradiction that invalidates that qualification. Old sellers are not excluded merely for being old. Review available launch, earlier-review and family-change clues; do not require proving the absence of all offsite traffic or hidden corporate relationships. Disclose uncertainty and retain contrary observations. A suspicious clue is not proof of manipulation.

Choose one coherent observation basis before selecting the best examples. Revision 50 selects dated current ratings and latest-30-day sales across this batch, superseding its earlier entry-time preference while preserving historical observations separately. Do not mix the two bases into one median or select whichever gives the higher score. Similar launch stages and actual exposure/coverage must be comparable: a short launch is eligible, but its units are not extrapolated to a full month or compared blindly with a mature full-window record. Ordinary refresh differences may be labeled; a wrong family, materially mismatched period or ambiguous launch remains a substantive gap.

Compute sales median T and rating-count median M from the defined observed reference cohort, retaining membership and all observed weak, exited, immature or unknown records with their statuses. Missing records are not zeros. The medians do not come only from the two selected winners, and arbitrary two-product comparison is not market definition. Preserve existing zero-reference exceptions: unsupported/nonpositive T gives no sales ratio; a verified M = 0 leaves the relative-rating component unscored. Coverage is reported honestly without requiring exhaustive historical recovery.

### Four points: retain formulas, extend the eligible score pool

For a fully supported example, R is accumulated rating count and S is aligned sales units. Existing approved components remain:

- Actual-rating A: 3 for R <= 10; 3 - 0.05 * (R - 10) for 10 < R <= 40; 60 / R above 40.
- Relative-rating U: 1 for R <= M, otherwise M / R, requiring M > 0.
- Rating base P = A + U; sales ratio q = S / T with T > 0.
- Sales ceiling C: 6q through q = 0.50; 3 + (q - 0.50) / 0.30 between 0.50 and 0.80; 4 at or above 0.80.
- Complete example score E = min(P, C).

**Accepted in revision 48:** allow weaker-sales examples with complete supported inputs into the same eligible ranking after applying C. Remove the additional requirement that every pair member first meet q >= 0.80. That threshold still permits a maximum ceiling of 4; it ceases to be a second eligibility filter. This makes the already approved weak-sales curve usable in the direction-level item without requiring most newcomers to succeed.

Keep the approved mean of the two highest complete eligible E values, with distinct families/shared-launch histories and all observed counterexamples retained. Only one complete example remains a labeled single-case score, not the full direction score. Partial rating/sales inputs, unverified qualification, true-zero M or unsupported T do not become complete examples. Preserve supported components, label the affected item pending and do not fill a second example or renormalize weights. A supported zero-sales observation can score zero; a placeholder/unavailable zero cannot.

### One point: same pair, usable SIF share and targeted corroboration

Keep the accepted per-example min(p / 0.70, 1) and average for the same selected pair. SIF p is its source-defined overall natural exposure estimate, not the proportion of natural keyword counts. Do not choose another pair because its natural scores are higher or its data are easier to obtain.

**Accepted in revision 48:** a usable SIF share with known subject, period and meaningful relevant-query evidence can score even when SellerSprite corroborating counts are unavailable; label it single-source. When both providers supply counts, retain both. Ordinary count/update differences or opposite count directions alone do not invalidate the exposure share or deduct points. Check only consequential scope/period/entry contradictions. A supported wrong-variant/wrong-period observation or unresolved material contradiction makes the affected score pending; do not arbitrarily halve it. Never derive p from SellerSprite counts when SIF share is missing.

Owner reaffirmation, 2026-11-13: the normal evidence workflow uses both SellerSprite and SIF organic/ad keyword counts, alongside SIF's overall natural/ad exposure shares, for each selected example. Reuse compatible saved observations or retrieve the needed source fields; the SIF-only allowance is an explicit missing-source fallback, not an instruction to omit available SellerSprite evidence. The abbreviated numerical example omitted this corroboration step from its explanation, not from the adopted requirement. Examine whether meaningful buying entries support the natural-visibility interpretation and whether any discrepancy concerns the wrong product, family or period. Ordinary count differences need no penalty or forced agreement. The 1-point curve, same-pair average and material-conflict/missingness rules remain unchanged; counts do not add points or become exposure shares.

Current tool declarations were checked without a new business request: SellerSprite `keyword_asin_list` exposes organic/type statistics and per-keyword types; its summary aggregates the supplied ASIN set, so it is not a separate count for each example in a multi-ASIN query. Keep advertising-type scope explicit and do not sum overlapping SP/brand/video counts into a fabricated distinct total. SIF `ops_get_listing_keyword_distribution` with keyword-count display exposes natural/ad counts, while `ops_get_listing_traffic_overview` supplies the separately scoped exposure view. Match the selected example's actual product/family and observation window before comparing. Declaration availability is not proof that every real example returns populated fields; actual coverage remains part of the saved trial's continuation.

With a fixed eligible pair and one valid score s missing its partner, preserve the already accepted pending item and conditional range s/2 through (s+1)/2; no midpoint or earned lower bound. If both shares are missing, show pending and the gaps. If no eligible pair exists, retain any supported individual natural scores without inventing a direction average. A partial low-rating component does not erase valid natural observations.

### One coherent synthetic example and acceptance checks

The following six independent, qualified, same-stage observations are synthetic teaching data. They do not establish source access, actual products, a universal sales target or a fixed sample-size requirement. Their sales median is T = 100 units and rating median M = 30. Every row is retained; selecting two does not delete the others.

| Example | Ratings R | Sales S | Rating base P | Sales ceiling C | Final E | SIF natural share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 10 | 80 | 4.00 | 4.00 | 4.00 | 70% |
| B | 20 | 60 | 3.50 | 3.3333 | 3.3333 | 35% |
| C | 30 | 120 | 3.00 | 4.00 | 3.00 | 90% |
| D | 30 | 20 | 3.00 | 1.20 | 1.20 | 56% |
| E | 40 | 160 | 2.25 | 4.00 | 2.25 | 42% |
| F | 40 | 200 | 2.25 | 4.00 | 2.25 | 14% |

Under the accepted extension, select A/B: low-rating item = (4 + 3.333333...) / 2 = 3.666666... / 4. B is below the 80% sales-reference condition but has already received the sales cap; it is not excluded again. Under the old strong-sales-only pool the pair would have been A/C and 3.5/4. This trial preference change is now explicitly accepted; the original proposal remains in the private revision-47 snapshot.

Natural visibility follows A/B: (1 + 0.5) / 2 = 0.75/1, even though C has a higher natural share. Together these two items yield about 4.42/5. The other 3-point and 2-point Q31 mappings stay unchanged; this is not an overall product score.

Acceptance must verify the six-row medians, capped scores and A/B selection; keep C's 90% from replacing B; preserve the score when only SellerSprite counts are removed; leave B's natural score missing when SIF share is removed and show the valid 0.5–1.0 pair range; distinguish real zero sales from missing sales; prevent one family supplying both exemplars; and retain partial/single/zero-reference cases without a fabricated complete score. Data qualification and launch comparability require later real-case review in addition to arithmetic. No model may silently change weights, choose favorable observation bases or fill gaps. Revision 48 records these complete mappings and boundaries. Offline checks verify arithmetic/retention only; later real-case qualification, acquisition and complete-card acceptance remain required.

Latest owner scope (2026-11-13): normal-start research uses observable seller IDs/names, brands, parent-family links and available launch evidence. Hidden cross-shop company tracing is outside this version's scope and is not an eligibility or evidence-completeness requirement. Preserve known same-account/shared-listing context without inferring traffic transfer or manipulation from identity alone. The underlying Q31 budgets and accepted formulas are unchanged.

## Historical revision-31 summary and complexity context

本节保留 profile revision 31 时的历史状态；当时待定的较弱样本参与汇总、来源充分性和缺数处理，现以顶部 revision 48 的完整试评规则为准。下方逐轮原证据继续保留。

完整的取数、判断、计算和缺数示范见[一组完整合成算例](#从原始数据到分数一组完整合成算例)。

| 这 10 分的组成 | 已定的主要计算 | 仍需验证或决定 |
| --- | --- | --- |
| 新品数量占比 3 分 | 当前榜内可比样本的新品占比，20% 满分，以下连续 | 实际样本资格、去重与覆盖是否成立 |
| 新品销量占比 2 分 | 同口径新品销量件数占比，30% 满分，以下连续 | 是否拿到范围和期间相容的销量 |
| 少评价销售表现 4 分 | 实际评价 3 分与相对评价 1 分形成基础分；与已定销售进展上限取较低值。完整点值曲线已衔接 | 缺证／误差与部分分数；是否扩展两例汇总到较弱样本仍未批准 |
| 自然可见度 1 分 | 有据自然曝光占比 70% 满分；沿用选定同两款并平均；缺一款时按已定规则显示待补证和条件范围 | 实际相关覆盖、来源冲突与自然证据是否充分 |

这些计算适合由普通确定性代码执行。实现应复用同一份市场样本和来源证据，集中使用同一版本规则；不需要为每个分数区间建立一条研究流程。现有算例及连续性检查只支持数值规则内部一致，尚未构成应用实现或真实判断验收。

主人随后明确：第三方数据用于大概判断和看趋势，不要求亚马逊后台级精度。有来源、范围和大致时期依据的估算可以支持试评；不能把“不是精确值”一律变成不能用。保留估算／档位标记，不为无关紧要的差异无限追查。优先处理可能改变新品资格、可比市场或评分解释的冲突；缺失不补零、不同父子体与窗口不混算。对仅有档位的情况，具体怎样进入数值评分尚未另定，不借此自动引入中点或改动既有曲线。

复杂度集中在计算前：商品是否真的可替代、父子体是否混款、数据时期是否相容、新品是否正常起步，以及疑点是否足以影响该分数。这些需要来源和判断，不能靠增加公式变成已知。第一版沿用已接受的阶段安排：初筛轻量归组，优先项精筛核实必要证据，出卡前计算；昂贵的进一步经营主体／供应链等调查在主人保留方向后深化。初卡仍须有真实依据和必要风险初查。

初次能力检查中，SIF 两个入口为一个技术样本返回字段，指定卖家精灵连接的单次测试收到额度拒绝。后续已执行下方记录的真实多商品试跑，交付观察卡及部分公式复算，但完整10分、分组准确性、正常起步判断、每天产能和整个自动流程仍未验收。不能把有公式或个别字段返回推成全自动系统已经可靠。

实施方对最新复杂度顾虑的处理建议：先用本页和整体算例讲清已定规则，再把剩余问题集中到会改变业务取舍、证据含义或验收结果的选择；常规实现与事实核查由实施方承担，实际质量／耗时留给已规划的有界验证。无法核清的具体数据如实待补证，不为了输出完整分数无限增加推断层。该建议不替主人批准未决评分、删减 23 项、缩减主动发现交付或提前启动正式开发。

既有 [第一版验证安排](FIRST-RELEASE.draft.md) 和 [开发流程](../DEVELOPMENT.md) 继续适用。先前规则整理与合成算例之后，主人另行明确授权了下方的真实SIF小批试跑；其覆盖和评分缺口如实记录，尚无跨类目校准结论或正式产品实现。

## Real-data workflow update, 2026-11-12

The owner explicitly requests an SIF-only trial of these ten points while SellerSprite remains unfunded, including actual grouping, candidate coverage and entry/exit-history limits. A bounded multi-product discovery-to-observation-card run has now completed; the private result is `.local/reviews/20261112-sif-real-q31-workflow/RESULTS.md`. It includes observed-input formula checks, original returns, reconciled usage and source readback. This supersedes the earlier claim that only the two-field technical probe has run.

Complete Q31 scoring did not pass. The retrieved keyword competitor pool is not the approved current in-list BSR sample; the deliberately selected new/unknown/established card set must not become its denominator. Promising observed newcomers also lack verified entry/normal-start qualification for the accepted pair. The trial retains useful evidence without silently awarding the group score. This is not a new requirement to recover every historical entry or exit: partial historical observations remain acceptable, with coverage stated. The present gap is a sufficiently defined current scoring sample and its actual eligibility, rather than perfect third-party precision.

No decision, curve, weight or production flag changed. Later SellerSprite participation may add coverage, but its actual returns and sufficiency still require validation. The owner's plan to recharge later neither changes today's SIF-only scope nor enables an automatic future scan.


## Historical and individual-review follow-up, 2026-11-12

The same-product SIF history test is now complete. It returns partial day-level rank and rating-count evidence, including observed rank-threshold crossings, missing histories and a material start-date conflict. The private `history-followup/RESULTS.md` under the preceding run records the actual scope and scoring attempt. The returned category label has no node ID, so exact equivalence to the earlier profile node remains unverified. Missing individual histories are not zeros; an earliest observed point is not automatically the actual first entry or first review. Complete Q31 scoring remains pending, without changing revision 31.

The owner clarifies the observable normal-start investigation: check available rating/review growth, earlier review dates, family/merge clues and visible seller identity. Do not require proof that no offsite traffic or hidden common ownership exists. For individual written reviews, record the source link/ID, date, visible variant and relevance, plus Vine and Verified Purchase badges separately. Include neither-visible-badge reviews; absence of these badges alone is not an anomaly. Unread badge fields remain unknown rather than being counted as unmarked reviews. State the inspected sample and date coverage; total ratings and readable written reviews are different populations. This records evidence rather than adding badge points or a new hard gate.

SIF history supplied no individual review text or badge data. Initial anonymous retrievals failed or returned only summaries. A subsequent authorized read through an existing buyer-browser session retrieved individual written reviews and VP/Vine badges for one product; the private observation record states the actual sample and dates, separately from global ratings. Continued traversal reached Amazon human verification and stopped. Other products and unobserved ratings remain unknown. SellerSprite's current review declaration supports VP/Vine filters, but the unfunded route was not called. Review growth or badge composition alone cannot establish authenticity. Partial verification is useful evidence, not whole-market or full-Q31 acceptance.

Later continuation and owner correction: the second product's review page subsequently opened without a verification action; only its first displayed batch was read before the owner directed a return to scoring. The private continuation record preserves that limited observation. Review checks stay in the research workflow, not an extra score, an exhaustive pre-card audit or the current discussion frontier. The earlier challenge is a historical access result, not the present reason Q31 is unscored.

The offline blocker summary separates the four existing items: the 3-point item needs the current in-list comparable population; the 2-point item additionally needs aligned unit totals for that population; the 4-point item needs supported comparable references and the accepted eligible pair; the 1-point item has observed source inputs but inherits that same-pair dependency. A partial rating-count formula result is not the complete 4-point item. SellerSprite declarations provide candidate routes, not proven completeness. After the recharge update, test population and period/grain first, then targeted evidence, reusing valid SIF observations. If data remains unavailable or a valid sample has too few eligible examples, present the concrete case before changing aggregation. No rule, curve, weight or production flag changed.

## 有限实测更新：SIF 原生字段已返回

2026-11-12，主人明确要求先验证 SIF MCP 并确认额度足够。选品席直接执行两次业务查询，使用既有公开技术样本，取得整体自然／广告流量占比，以及对应 ASIN 的自然／广告词数。原始数据、时间、请求参数与额度回读只保存在本机忽略目录；[脱敏能力记录](../research/newcomer-brand-support-evidence-20261111.md)说明适配边界。

本次请求选择单 ASIN、近 30 天；返回了更新时间说明，但没有独立回显完整起止日与占比主体。词数接口同时列出多个变体，顶层 total 是行数，对应行 total 才是词数；自然与广告词会重叠，不能相加，多个子体也不能直接加成父体去重词库。占比从 overview 读取，词数接口中同名 ratio 字段可能为空。一个附带推荐渠道的比例越界，须单列待核，不能用它重算整体占比。

此次只证明这两个原生入口能为该样本返回所需字段，不证明新品都可取得、词的相关性、数据绝对准确、父体完整性、历史走势或实际自动评分质量。这个样本不作为合格新品或推荐品计分。本次实测结束时 profile 为 revision 25，70% 满分提案当时未获批准；主人随后明确批准该单样本曲线，revision 26 及下方自然可见度小节记录新决定。下文早期“未取数”的说明保留其当时范围；本次明确授权仅增加这次有限能力证据。

## 已确认的四项试评分配

| 指标 | 试评满分 | 要回答的问题 | 分值理由 |
| --- | ---: | --- | --- |
| 新品数量占比 | 3 | 在同一明确样本里，有多少商品是三个月以内的新品？ | 重视多个新品进入的广度；不会只因为一个爆款就判断整个细分容易进入。数量不等于新卖家成功率。 |
| 新品销量占比 | 2 | 同一批新品获得了样本内多少销量份额？ | 区分“新链接多”和“新品实际获得销售进展”；份额可能由少数款贡献，因此不能单独决定整组高低。 |
| 少评价积累下的新品销售表现 | 4 | 新品达到可比的销售进展时，已经积累了多少评分？ | 最直接服务于评价积累门槛的判断，是本组重点；必须同时看销售表现，不能只奖励评价少。 |
| 自然可见度发展 | 1 | 相关自然词与广告词有多少，自然／广告曝光占比和相关位置怎样发展？ | 是补充证据；词数、曝光和排名不是订单，也不能直接证明广告花费或盈利。 |
| 合计 | 10 | 四项分别取分，再按最终确定的办法汇总 | 单项不足可以由其他项优势补足；不要求四项都满分。 |

## 每项如何取分，以及仍未定义的部分

### 1. 新品数量占比：0—3 分

- 原始观察：同一站点、节点或可比细分、同一份有明确日期的样本中，新品数量占有效商品数量的比例。年龄边界沿用三个月，不设满 30 天才能参考的门槛。具体款式分组与样本分母需一致，不能只对分子去重。
- 计分方向：在可比口径下，占比更高应获得更高的本项分数。保留原始数量，避免只显示百分比而掩盖小样本。
- 不把品牌集中度、实际经营主体集中度再次塞成此项的额外处罚；已存在同细分产品的品牌与首次进入者的参考区别保留，具体怎样影响本组仍需对齐，不能随意把某个新品折算成半个。
- 已定主计分输入：指定 BSR 前 100 的当前样本中，真正可比的同细分新品占同口径可比商品的比例。榜外商品保留用于竞争、销量参照和后续进榜观察，不进入此项当前榜内分母。历史进榜、留榜和退出另作辅助记录，观察到多少如实记录多少并说明范围，不要求找全，也不把历史进入者加到当前分子里。
- **尚待确定：**具体节点、样本成员与新品资格核实；年龄或覆盖未知如何聚合，以及已确认曲线的真实样本校准。未取得数据不是 0 分。历史覆盖不全的处理已定，不意味着可以把不完整的当前样本称为完整榜单。

#### 已确认试评：20% 满分的连续曲线（待真实样本校准）

主人已明确同意先按此曲线试评、后续用不同类目多轮真实样本校准。在已确定的当前榜内可比样本中，记新品数量占比为 q（0 到 1）。已确认试评公式为 `得分 = 3 × min(q ÷ 0.20, 1)`：10% 得 1.5 分，20% 及以上得满分 3 分，区间内连续增加。分子、分母必须按相同规则去重并保留日期；这不是以完整 BSR 的 100 个席位直接作任何细分的分母。

| 当前榜内同细分新品数量占比 | 已确认曲线的试评分数 |
| --- | ---: |
| 0%（数据足以确认） | 0.00 |
| 5% | 0.75 |
| 8% | 1.20 |
| 10% | 1.50 |
| 12% | 1.80 |
| 15% | 2.25 |
| 20% 及以上 | 3.00 |

20% 的试评满分锚点先把当前可比席位中每五款有一款属于新品，视为本项较强的进入广度；新品实际拿到的件数份额由另外 2 分衡量。这个数值由本次明确答复确认，仍待真实样本校准，不是从旧 20 款例子推定的批准，也不是行业阈值、成功率或淘汰线。保持曲线简单，后续再用真实案例判断是否过早封顶；20% 以上仍展示原始比例。

合成算例：榜内已核实的同细分 20 款中有 3 款新品，则输入为 3／20＝15%，本项按建议得 2.25 分；榜单其余非直接可比商品不混入分母。卡片同时显示原始数量：1／5 与 20／100 虽然同为 20%，前者只观察到一个新品，不能包装成已有大量进入者。公式假设输入足以计分；小样本或覆盖不足是否足以正式赋分、怎样影响证据状态仍待明确，不在此暗加最低款数、零分或自动折扣。同品牌或确认同主体的多个新链接也不能被宣传成多个独立新卖家的成功，集中度与正常起步参考另按各自定义处理。

本项与已确认的销量项合看时，数量多但销量份额低的市场会在这 3 分得到较强信号、在另外 2 分得到较弱信号；二者不互相覆盖，也不能凭这 5 分决定完整产品好坏。参考配置 revision 8 已采用数量项映射。

### 2. 新品销量占比：0—2 分

- 已定主口径：新品的估算销量件数之和，占同一商品样本、同一销售窗口全部估算销量件数的比例；优先父体口径。售价不同会影响金额份额，销售额可另列参考，不新增第五个计分项。
- 已定观察窗口：最近 30 天作为本项主输入，近三个月的可比记录辅助观察。新品资格仍为三个月以内，不要求卖满 30 天；短历史只记录有依据的窗口内销量及实际上市天数，不按日均数外推整月。窗口实际可得性仍需验证，不能把自然月或累计销量直接当成最近 30 天。
- 父体默认不意味着任意家庭总销量都代表目标具体款。例如一个父体混有单层固定架与双层抽拉架，其总量不能证明抽拉架也卖得好；缺子款分布时保留这个限制。新增子体不能把老父体重新算成正常新品。同一父体不能按每个子体重复累计。
- 计分方向：同口径的新品销量份额越高，本项得分越高。说明份额由哪些新品贡献，不能从合计值推断每个新品都卖得好。
- 不把样本总销量在这一项再奖励一次；需求规模有既定评分位置。新品份额高不能代替商品、品牌和卖家集中度。
- **尚待确定：**可比样本、不同父体结构下的覆盖处理及缺失销量聚合；已确认曲线的真实样本校准尚未执行。不能用子体分子配父体分母，也不能将估算销量当成后台实测订单。接口声明支持父子销量，不等于已验证每个目标都能取到完整的最近 30 天数据。

#### 已确认试评：30% 满分的连续曲线（待真实样本校准）

主人已明确同意先按此曲线试评、后续用真实样本校准。先假设样本、正常新品资格、父体归属、窗口与数据覆盖足以支持这个比例，记新品销量份额为 p（0 到 1）。已确认试评公式为 `得分 = 2 × min(p ÷ 0.30, 1)`。0% 到 30% 按比例连续增加，达到 30% 后封顶 2 分；原始份额继续显示，不抹去 30% 与 50% 的实际差异。以下保留两位小数只是展示算例，尚未确定正式精度规则。

| 最近 30 天新品销量份额 | 已确认曲线的试评分数 |
| --- | ---: |
| 0%（数据足以确认） | 0.00 |
| 5% | 0.33 |
| 10% | 0.67 |
| 15% | 1.00 |
| 20% | 1.33 |
| 25% | 1.67 |
| 30% 及以上 | 2.00 |

选择这条曲线是为了让相同有效输入得到相同结果，避免硬分档在边界突然跳分，并减少未经验证的曲线参数。30% 是待校准的效用锚点：先把新品获得约三成件数视为本项足够强的信号，不要求新品拿走全部销量才满分；它不是统计推导出的最佳值、行业门槛或市场成功率。若满分锚点改为 20% 或 40%，15% 分别得 1.50 或 0.75 分；这个差异用于本轮解释取舍，不代表另外两条规则已采用。

本项只衡量销量份额，不保证多个新品都卖得好，也不证明我们可以盈利。保留各新品贡献明细，数量广度、集中度与正常起步参考按各自定义处理，不临时重复加扣分。缺数、未知新品资格或零总销量不能当成已确认的 0% 输入；缺证怎样聚合仍待定，不能靠此公式补成 0 分。近三个月辅助观察不自动产生额外分数或临时改权重。此处没有恢复 Q16 的跨产品直线优先提案；它是单独针对 Q31 这 2 分确认的试评规则。参考配置 revision 7 首先采用这一项映射，revision 8 又采用数量项，其余 21 项仍为空；这不代表整体算法已可运行。

### 3. 少评价积累下的新品销售表现：0—4 分

- 看的是评分数量，而不是星级高低。对同细分可比新品，联合记录销售进展与当时的评价积累；BSR 进入事件、同细分销量表现分别注明参照。
- 有利方向：在可比销售进展下，所需评价积累较少；在可比评价积累下，销售进展更好。评价少且销售也很少，不能仅凭低评价数拿高分。
- 本项看起步负担，不再仅因样本中新品更多或新品合计销量更多而重复奖励；多个样本如何汇总仍需定义。
- 主人选择优先参考新品进入相关 BSR 前 100 时积累了多少评分，并结合细分大盘展示观察范围；不设统一评论数量门槛。进入榜单容易仍可能只是市场小，需求规模和经济性继续按各自维度判断。有同期记录才记录入榜时评分数；只能识别首次观测到进榜时，不声称首次真正进榜，也不拿今天的评分数代替当时的数。
- **尚待确定：**节点与细分匹配、同期记录允许的采样误差、怎样的销售进展具有参照意义、绝对评价数与细分相对位置怎样结合、多个样本与资源背景如何汇总。旧示例的 80 件／40 评与下四分位规则未获批准；后续单独批准了可比新品销量中位数作为试评参照，见下文，不连带恢复旧整包提案。不能用销量除以评价数代替本项。

#### 已确认试评参照池：BSR 前 100 为主，新品榜独有样本作补充

主人指出真实零评价下已有销量、进入榜单的新款有正面参考价值，并提出星级也应考虑，随后明确追问参照池究竟只看 BSR 前 100，还是包含新品榜。解释两者区别并提出下述参照边界后，主人确认继续；profile revision 18 记录该边界。此前排序解释后的答复不单独批准零基准提案；后续单独讲明该例外并再次询问，主人明确确认，profile revision 19 记录其为已定试评规则。

已定范围须区分：新品数量占比 3 分使用指定 BSR 前 100 当前榜内的同细分可比样本；这里明确的是少评价销售表现 4 分及两种中位数的参照来源。后者以有据 BSR 进榜新品为主，不把新品榜独有样本直接合并，也不能把数量项的当前榜内分母机械复制过来。发现入口与主评分参照资格是不同问题。

已确认试评边界：这 4 分先以同一明确节点、有 BSR 前 100 观测记录、三个月内、同细分真正可比且正常起步与同期数据有依据的新品作主要参照。当前在榜、曾入榜而退出须分开标记并保留反例；观察时间、历史覆盖和哪些历史记录能合并成同一中位数仍需定义，不混算不同时间或承诺找全历史。新品榜独有样本继续用于发现、跟踪、竞争与销量补充，暂不直接混入主中位数。若同时满足主参照条件，按同一规则纳入并去重，不因上两个榜就计两次。未进入主参照不等于候选方向被淘汰；数量占比 3 分的当前榜内口径保持不变。

合成例子：A 是同细分的两个月新品，指定节点 BSR 第 80 且正常起步有据，可作主参照候选；B 新品榜第 8、同节点 BSR 第 350，值得研究，不能把新品榜第 8 写成 BSR 第 8；C 虽然 BSR 第 60，但用途／关键规格并非替代品，不因同处大榜就放入目标细分中位数。这些是边界说明，不是已取得的 ASIN 或保证存在的历史记录。

亚马逊的 BSR 说明将其定义为类目内销售排名，评分或评论并非直接排名输入；其员工对 New Release 标记的解释限定在类目新品之间的销售比较。[BSR 官方说明](https://sell.amazon.com/blog/amazon-best-sellers-rank)、[Amazon 员工说明](https://sellercentral.amazon.com/seller-forums/discussions/t/70eccc29-0108-4eab-a03e-4d2ebd1b4835)。方法判断：少评价下有据销售是正面线索，不能单凭任一榜名次推出固定销量门槛、利润或蓝海结论；需求规模、集中度、进入条件和经济性仍须合看。站点、节点、观测时间与提供方样本口径要分别记录，提供方新品标签不能自动代替真实起步核查。

星级与评价数量仍为不同字段。主人已确认采用目标细分市场的成熟款＋新品、去重后的展示星级等权平均作为主要参考。该参照只描述市场水平，不新增独立分数，也不改动少评价起步的 BSR 可比新品参照；之前的星级问题归入风险／轻改提案未获批准。

该来源边界已回答，不再重复提问。具体历史／当前样本的可合并时点、正常起步资格与覆盖仍待落实；本轮不启动扫描或付费取数。

#### 已确认：同细分市场样本平均星级，仅作参考

主人要求“给我一个平均星级就好了”，用于了解拟进入市场的平均水平，并希望以后做到该水平以上。本轮承接为描述性参照需求；不把这句话变成低于均值排除、预计自身星级必然达标或新增评分权重。上一轮按星级问题调整已有分项的提案未获批准，保留在下方历史段。

主人已确认主显示“目标细分市场样本平均星级”：比较当前观察到、已核实用途和关键规格真正可替代的在售商品，兼顾成熟款与新品、榜内与相关榜外商品。BSR 前 100 的整体均值反映该榜内畅销样本；若节点混有不同用途或结构，不代表本细分。新品榜均值只描述新进入者，不足以独自代表长期竞争对象。某个 BSR 节点若恰好与目标细分一致，则可作为重要样本来源；仍需说明覆盖。第一版不必强制并排提供三套均值。

这次是市场质量参考，不改动少评价起步 4 分已经确认的 BSR 可比正常新品主参照与两种中位数。目标不同，样本范围可以不同，必须分别命名。

已确认先对去重后独立可比商品的当前展示星级取等权算术平均，不按评论数量或销量重新加权。共享同一评分的颜色子体不能重复贡献；无法拆分到目标款式的混合评分须标明范围，不能复制成多个独立观测。无星级或缺失不填 0，也不只因评价少或星级低就删除；展示有效样本数、未纳入的具体原因与日期。按有据样本报告，不声称已找全市场。

合成算例：5 个有效评分单位为 4.1、4.2、4.3、4.4、4.5，等权平均为 4.3。五款只是计算演示，不是最低样本门槛；这不是实际市场数据。Amazon 展示的单品星级本身并非原始客户评分的简单平均，因此这里是“各商品展示星级的平均”，不是把所有客户评价合并后的真实均值。公开事实与来源见既有[研究记录](../research/newcomer-brand-support-evidence-20261111.md)。

高于参照均值可作为后续产品质量与运营目标，不能预先保证尚未上架的候选可以实现，也不能单凭高于均值认定能站稳市场。样本可靠性、实际可获得字段和适用覆盖后续验证；本轮不启动真实商品查询。

此问题已回答：主人确认“目标细分市场的成熟款＋新品、去重后的商品展示星级等权平均”作为主要参考，profile revision 20 已记录。星级参考不新增计分权重；实际样本资格、共享评分与覆盖仍需后续验证。

#### 历史提案，未采纳为本轮要求：星级问题用于解释机会与风险

以下保留上一轮具体提案与合成例子以便追溯。主人随后将当前需求收窄为平均星级参考，没有批准这套星级问题归入评分的处理；不因保留此段而执行。Profile 保持 revision 19。

建议第一版保留星级、对应评价数、商品范围、时间和可比细分背景；星级本身不另占权重，也不直接乘进少评价销售表现的 4 分。低星但卖得动既可能提示未解决的需求，也可能暴露产品问题或特殊销售背景；高星也不能单独证明机会小。有证据支持后，再把结论用于相应已有维度：可行的轻改证据进入轻改项，与我们方案相关的质量问题进入相应风险判断，不因同一个星级差重复加减分。

以下均为合成例子：假设是同一可比市场、起步阶段与观测口径的正常新品，均为 20 评，且已满足此前约定的销售参照条件；不凭这些假设替代实际资格核查。

| 观察情景 | 第一版建议怎样用 |
| --- | --- |
| 4.6 星，未发现可核实的重复问题 | 保留为销售与正常起步参照，继续按已定评价数规则处理；不因星高额外加这 4 分，也不据此判断我们没有进入空间 |
| 3.9 星，已有反馈反复指出组装说明不清 | 核是否确能通过修改说明解决、成本是否可接受；有据时作为轻改项输入，不只因低星仍有销量就加分 |
| 同为 3.9 星，已有反馈反复指出承重变形 | 核问题是否适用于我们拟做结构，作为相关商品风险的调查线索；不能直接换算退货率或认定不正常起步 |

三个示例的实际数量部分均沿用已确认的 20 评锚点；相对评价部分仍看评价数参照，不改成星级比较。少量评价、无星级、混合父体和时点错位须标明；无星级不等于 0 星。低星、高销量与可见流量之间的疑点可进入后续调查，但本方案不要求每张卡穷尽促销、站外或经营主体历史，也不把未查明写成已正常或已操纵。

此前问题是是否让星级问题证据影响已有轻改／风险判断。主人没有采用该提案，而是要求先提供平均星级参考；当前以本节上方的平均星级范围问题为准，不重复要求批准旧方案。

#### 已确认参照原则：少数有据的低评价起步样本也有价值

以下保留为历史合成算例，不是接口实测或已批准的评分锚点。原例为解释参照选择，直接假定五款新品的可比性、正常起步和同期记录已核实；该正常起步假设没有现实证据支持。主人后来指出高评价新品示例缺乏合理性，因此这里的较高评价背景也不能继续作为已经核实的正常新品参照。保留数字用于追溯讨论，不作为实际参考池、校准样本或正常增长分布；已经明确批准的参照原则和计算方法不因此回退。

| 参考新品 | 首次观测进榜时的评分数量 | 该观测时点对应最近 30 天估算销量件数 |
| --- | ---: | ---: |
| A | 8 | 120 |
| B | 14 | 140 |
| C | 65 | 135 |
| D | 120 | 160 |
| E | 180 | 145 |

这一组中，A、B 在较少评价积累下已取得与其余可比新品接近的销售进展。主人随后确认：少数样本只要确实可比、正常起步且有依据，就有参考价值，不要求多数新品都做到；同时不能只挑好的看。数量广度和销量份额已有独立位置。具体高分档怎样判定仍需明确，参照原则本身不自动给 3 分或 4 分，也不表示所有新品都容易成功。所有样本、已知反例和未知背景仍保留。

若较低评价的记录只有孤立且背景未知的一条，先作为待核线索；若只有当前评价数而没有进榜同期记录，本项证据不足，不能把当前数回填或记 0。若同样可比的实际起步记录显示需要较厚的评价积累，得分方向才更低；相对千评老品少，并不单独证明少评价起步。上述销量数不是通用门槛，8／14 评也不是满分阈值。下述 3／4 分业务区别已获认可，具体边界仍不是可直接执行的数值映射。

不要求多数样本的参照原则已确认，不再重问。多个样本最终怎样支持本项得分、需要多少独立佐证、各评价数量对应哪一档、绝对量与市场相对位置的权衡仍需逐步定义；该原则本身不批准下四分位、最高样本分或最低样本数规则。销量中位数的后续单独批准只解决参照销量，不等于选择了最终得分汇总函数。

#### 已认可的业务区别：3 分与 4 分按少评时已达到的销售进展区分

两档均以可比、正常起步、同期评分和销售证据足以支持判断为前提。本轮先固定示例中的较少评价积累，讨论销售进展的区别；不把证据多、观测时间长或样本数量多直接变成这 1 分的差异。

- **4 分方向：**低评价积累时已有可核实的样本达到或接近同细分、相近起步阶段普通可比新品的代表销售水平，为少评阶段能取得相近销售进展提供参考。无需多数新品都做到，不要求达到头部老款销量，也不声称已查明完整运营打法或成功原因。
- **3 分方向：**低评价积累时已有可核实的实质销售进展，但现有观测显示仍明显低于上述可比新品的代表水平。记录的是当前进展较弱，不推断其将来失败，也不因此排除候选。
- **证据不足：**关键同期评分、父体归属、销售窗口或正常起步条件未知时保留待核；3 分不是缺证时的保险分，不能把不确定直接扣成 3 分或填成 0 分。

历史同市场算例曾沿用 C、D、E 的 65／120／180 评与 135／160／145 件作为背景，再对比 A、B 在 8／14 评时达到 120／140 件或仅有 70／85 件的两种情景，以解释 4 分和 3 分的业务区别。该算例仅保留讨论历史：较高评价样本的正常起步资格并未验证，不能因算例写了“正常”就用于实际评分或证实可复制性。样本不因低评价而自动满分，本例也不确立两款最低数量。

较小细分的反例：若同样合格的参照新品通常只有 30—45 件，而少评样本已有 32—40 件，仍可按 4 分方向讨论。不能套用上一个市场的 100 件等统一门槛；绝对需求天花板在需求维度处理。此处的销量范围只是合成材料，不是正式参数；中位数参照的批准单独记录如下。

主人已认可上述业务差别，同时明确质疑实际分辨能力、联动复杂度、工作量与能否跑通；不能把认可业务意图写成自动评分验收通过。低评价的绝对／相对标准、代表新品的选取、已确认 80% 条件的误差和边界情况、0—2 分锚点及最终多样本汇总仍未定，4 分项的数值映射继续为 null。正常广告或 Vine 不因存在就使 4 分变成 3 分，未知历史不因缺失就证明高门槛。完成必要定义后，按第一版草案的有界验证办法检验数据覆盖、判断质量、关联项复算和耗时，并与两项份额检查重复信号；尚未执行该验证。

#### 已确认试评：代表销量采用可比参照样本的中位数

主人已明确接受用合格可比新品样本的销量中位数，作为上述“达到或接近”的试评参照，保留全部成员、原始值与分布。它只定义参照销量，既不定义低评价数量，也不要求多数新品都能少评价起步；不能据此判断整个品是否值得做。

合成例子先假设六款参照新品的细分替代关系、正常起步、相近阶段、相关 BSR 进榜及销售窗口均已核实，且没有按销量高低挑选成员。其同口径 30 天销量为 40、70、100、120、150、800 件。平均数约为 213 件；从小到大排列后，中间两款 100 和 120 的平均是 110 件，即中位数。按已确认的取法，本例参照为 110 件；800 件的样本仍保留，不因高销量就删除或认定异常。

中位数方法已确认，六款不是最低样本量，示例中的 30 天也不新增本项正式时间口径，110 件不是跨市场门槛；具体参照成员、历史时点和窗口的可得性、数量与覆盖充分性及正常起步资格仍需落实。“接近”的 80% 试评条件随后单独获批，见下文，估算误差处理仍未定。样本缺失、混组或不代表目标市场时，中位数不能补救这些问题，不能计算出一个数就当作可靠参照。排序和取中间值可由脚本完成，归组及证据质量仍需核实和测试。Profile revision 11 记录了中位数方法；完整 4 分映射仍未完成，未启动取数或实现。

#### 已确认试评：达到中位数的 80% 作为“接近”的销售条件

主人已明确接受“销售件数达到合格参照中位数的 80%”作为 4 分方向中的试评销售条件，包含恰好达到 80%，后续用多类目真实样本校准。这是试评参数，不是行业事实或成功概率。其他必要条件仍包括可比、正常起步、低评价积累及充分同期证据；满足销量条件不自动赋予整个方向 4 分。

沿用 110 件中位数的合成例子：80% 为 88 件。90 件约为中位数的 81.8%，达到该销售条件；70 件约为 63.6%，尚未达到，不因此自动给 3 分。3 分的下边界、低评价定义和多样本汇总仍需明确。较小细分中位数若为 40 件，同一参数对应 32 件；不设跨市场的固定销量门槛。

此处先按有据点值解释计算，不宣称第三方估算能可靠区分 87 和 88 件。来源误差、跨线区间或不明确的时间口径须显露，不能强行给精确档位；边界处理仍待定义。参照缺失、覆盖不足或中位数为零时，不能直接套比例发分。Profile revision 12 记录了 80% 条件，完整 4 分映射继续为 null，未修改两条已确认份额曲线或任何配分。

#### 已确认试评：中位销量一半时，最多 3 分

已经确认的是销量达到可比新品正中位数的 80% 时满足较强销售条件，实际评价数量 3 分与相对市场 1 分仍决定可得的评价基础分。不足 80% 的样本怎样计分尚未定义；先前的销量乘系数公式继续保留为不采用的历史，不恢复执行。

主人已明确接受先试用这一锚点：销量达到同阶段可比新品正中位数的 50% 时，这 4 分最多拿 3 分；有据的完整评价基础分若更低，保留较低值。恰好到 50% 时，样本试评分为 min(有据评价基础分, 3)。Profile revision 29 记录此批准；达到 80% 的既定销售条件仍保留，并不自动拿满 4 分。

合成例：已核实同细分、正常起步、相近阶段和相同观察基础，参照新品最近 30 天的销量中位数为 100 件、评价数中位数为 20。某样本有 10 评、售出 50 件，按既定评价组件可算出 4 分，但本次建议的销售上限是 3，因此该锚点的样本参考分为 3。另一样本同为 50 件、40 评，其评价组件为 1.5＋0.5＝2 分，因此仍为 2，不会只因达到 50 件就一律给 3。100 件和 20 评仅用于演示；其他市场使用各自的有据可比参照。

理由是为“已有实质进展、仍明显低于参照”提供一个中间锚点，允许潜力样本得到部分分数，同时避免仅凭少评价就满分。50%／最多 3 分最初由实施方提出，现获主人批准用于试评；它仍是待真实样本校准的参数，不是行业事实、成功概率或淘汰线。它可能过松或过严，须由跨类目真实样本校准；第三方估算在边界附近的误差不能冒充精确判断。

该轮只批准销量上限思路下的 50%／最多 3 分锚点；50% 至 80% 的连续连接随后另行确认，见下节。低于 50%、真实零销量、误差区间以及较弱样本能否进入当前两例汇总仍未定；不能推断整个 50%—80% 区间都封顶 3 分，不能在 80% 突跳一分，也不能现在改动原先只汇总满足较强销售条件的选择规则。自然可见度复用同一对样本，后续如果明确扩展低评分样本资格，须一并核对该依赖。真实零评价中位数的相对分未评分例外保持不变，不将不完整组件拼成完整分数。

解释进度：主人先追问“较强销量条件”及“参照的一半”的含义，并重申同等条件下评价越少、销量越高越有参考价值。随后用同细分、相近起步阶段正常新品的合成销量 50、80、100、120、150 件，说明中位数为 100、其中 50 件等于参照的一半；主人接受了这次解释。该答复当时紧接解释而非分值确认，不能把它追记为数值批准，也不新增固定件数线。实施方随后单独重问 50%／最多 3 分，主人明确接受并要求后续再看；本节的批准状态来自这次后续答复。

此问题已回答：先试用“销量达到可比新品中位数的一半时，这 4 分最多拿 3 分；评价基础分更低就取更低值”，后续用真实样本校准。

#### 已确认试评：50% 至 80% 之间，逐渐提高得分上限

主人已确认本段连接两个既定锚点的局部连续试评方法；profile revision 30 记录。它不恢复旧 Q16 的全局直线优先或先前未采用的销量乘系数公式。

已确认：从销量为参照一半时的最多 3 分，连续上升到销量达到参照八成时的最多 4 分。令 q 为同口径销售件数除以可比新品正中位数，在 0.50 至 0.80 之间，上限 C = 3 + (q - 0.50) / (0.80 - 0.50)，单样本分取 min(P, C)，P 为按既定评价组件得到的有据完整基础分。其他区间不由这条局部批准补全。

合成例继续使用正常起步、同细分、相近阶段且同期间的 100 件参照：

| 该样本销量 | 相对参照 | 已确认试评的本项最高分 |
| --- | --- | --- |
| 50 件 | 50% | 3 分（已定锚点） |
| 60 件 | 60% | 约 3.33 分 |
| 70 件 | 70% | 约 3.67 分 |
| 80 件 | 80% | 4 分（保留原条件，不自动满分） |

表中分数是上限；例如评价条件只支持 2 分，各行仍取 2，不由销量上限抬高评价分。中间小数仅演示换分，不承诺第三方销量估算有相应精度，也不锁定最终展示小数位。真实区间跨线、来源误差、起步阶段不匹配或参照缺失时仍需明确处理，不能把不确定值填成一个精确分。

这条已确认的试评段用渐变表达销售进展，避免临近 80% 时突然跨一整分；具体斜率仍需真实校准。50% 以下、真正零销量、较弱样本纳入汇总及自然可见度样本联动尚未定义。此时只保留并演示较弱样本的单样本试评，原先较强样本的两例选择规则不变。

此问题已回答：先把参照的 50%—80% 这一段，按“最多 3 分逐渐升到最多 4 分”试评，并保持评价基础分更低时取较低值。

#### 已确认试评：不足参照一半、可靠零销量与未知销量

主人进一步询问没销量或销量很少是否就是 3 分以下。本轮先解释：在此销售上限思路中，低于可比参照一半的有据销量，按现已批准的下段曲线对应低于 3 的上限；但最终少于 3 分也可能来自评价积累较多，因此不能倒推出每个低于 3 分的样本都销量低。绝对件数少也不自动意味着相对进展弱。

区分三种资料状态：有支持的真实零销量、有支持的少量销量、缺失／无覆盖／无法解释的返回零。缺失不能当零，接口里的 0 也需核实含义及有效观察覆盖，不能把未采到、四舍五入档位或空值占位写成已证实没有销售。新品上市短但有实际观察资料时，继续采用已定相近起步阶段参照；不补满 30 天、不新增最低上市天数。

主人已确认这一段先采用连续试评上限：在样本正常起步、比较范围和期间成立、参照销量中位数 T > 0 且数据充分时，令 q = S / T，在 0 <= q <= 0.50 内，C = 6q，单样本分为 min(P, C)，P 仍为有据完整评价基础分。Profile revision 31 记录；后续真实样本校准。不恢复先前把评价分乘销量系数的公式，也不取消评价基础分限制。

以下均为合成例，参照销量为 100 件：

| 该样本的有据销量 | 相对参照 | 已确认试评的本项最高分 |
| --- | --- | --- |
| 确有依据的 0 件 | 0% | 0 分，仅表示该观察期没有本项销售进展 |
| 10 件 | 10% | 0.6 分 |
| 20 件 | 20% | 1.2 分 |
| 40 件 | 40% | 2.4 分 |
| 50 件 | 50% | 3 分，与已定锚点衔接 |
| 查不到销量，或返回零的含义未核实 | 未知 | 待补证，不填 0 |

对照反例：同样卖 20 件，如果另一可比市场的中位数也只有 20 件，则已达到其参照，不因绝对件数小被归为低于 3 分；仍由已定评价组件及其他资格决定得分。需求规模另有自己的评分位置，不把小市场与起步进展混为同一含义。上限 0 只针对资格及数据有据的零销售观察；不能用它宣布产品未来失败、淘汰整张卡，或掩盖其他缺证。参照中位数本身为零时不使用比例，维持未定义／待补证状态。

本段已确认的是完整有据样本的分数；相对评价分因零中位数而未评分等部分证据情形，不由本轮补成完整 P。弱样本能否进入当前两例汇总、实际不确定区间和自然可见度选样联动仍待定。

此问题已回答：低于参照一半先按 0—3 分连续试评，查不到销量就待补证、不当 0 分，后续用真实样本校准。

至此，对完整、有据、同口径的单样本点值，销售上限的各段已可衔接：q 不超过 0.50 时为 6q，0.50 至 0.80 之间为 3 + (q - 0.50) / 0.30，达到 0.80 后最多 4；样本分仍取与完整评价基础分 P 的较低值。这里不补全缺证、估算区间、参照资格或多样本选择问题，完整 4 分项 mapping 仍为 null。

#### Earlier proposal, now accepted by revision 48: weaker complete examples in the pair

之前两例汇总的已定资格包括达到 80% 销量参照的较强条件。当时低于该条件的完整单样本曲线还未定。现在各段已经明确，实施方建议：保持正常起步、同细分、相近阶段、相同观察基础、两部分评价及销量均有据可计算等资格，只取消“必须先达到 80% 销量参照才可参与选样”这一项；让完整有据的较强、较弱及零分观察都先按已定规则计分，再按现有方式取最高两个完整样本分平均。80% 继续作为销售上限达到 4 的位置，不因此取消或移动。

这一资格变化尚未批准。未知和部分分数仍不能凑成完整样本；同父体／共享评分／重复起步轨迹的去重、原参照中位数的样本口径、只有一款完整样本时保留单例，以及全部已观察证据与反例的保留不变。两款有据观察不等于两款都成功，零分也不是未来失败判定。自然可见度按已定原则沿用更新后实际选出的同一对样本；自己的输入与缺数规则仍独立适用，不能由低评分样本可入池推出自然分自动可用。

合成例：三款均符合上述非销量门槛的资格，同期销量为 A=100、B=40、C=120 件，销量中位数是 100；评价数为 A=20、B=20、C=40，评价数中位数是 20。下表只比较少评价销售表现这一项，不判断整款产品：

| 新品 | 评价基础分 | 销售上限 | 完整单样本分 |
| --- | --- | --- | --- |
| A | 3.5 | 4 | 3.5 |
| B | 3.5 | 2.4 | 2.4 |
| C | 2 | 4 | 2 |

按当前尚未变更的资格，B 没有达到 80% 参照，只有 A、C 参与选样，均分为 2.75。按本轮新建议，B 的正常、有据低销售进展已体现在 2.4 分里，不再另设资格阻断；取 A、B 的 3.5 和 2.4，均分为 2.95。C 仍保留，不能把它从原始参照中位数或证据记录删掉。三款与这些件数只是算例，不建立最少样本量或跨市场销量线。

理由是让刚确认的低销售连续分数参与多维度的实际比较，允许“评价更少、销量较弱”的案例与“销量较强、评价较多”的案例按已定规则比较。仍可能随样本池扩大而出现偏乐观现象，须校准，不能把两例均分解释成市场平均或成功率。若日后扩展选样，需检查自然可见度同步换样，以及零销售／不足历史样本自身的自然证据是否充分；本轮不补造缺失自然分。

当前单一问题：是否允许销量不足参照八成、但正常可比且完整有据的样本，也按现有分数参与“选最高两款再平均”，不额外用 80% 拦在样本池之外？

#### 已确认原则：实际评价数量和细分相对位置都要考虑

主人已明确接受：判断少评价积累时，同时考虑实际评分数量和它在同细分、可比起步阶段中的相对位置。具体怎样合成分数、数值档位仍待打磨；这不新增产品淘汰线，也不预定绝对满分上限、评价中位数或下四分位规则。

已撤回的正常新品示例：实施方曾假设 A 市场参照有 40—60 评、少评样本有 10 评，B 市场参照有 500—700 评、少评样本有 150 评，并直接称两组均为正常起步。主人指出三个月内高评价增长的合理性没有论证。撤回这组例子作为正常新品的代表；错误在于把待查的起步资格当成既定事实，再据此抬高参照。原数字保留为纠错历史，不进入样本池或评分规则，不能借这组假设批准高评价或异常增长。

进一步更正：报名、领用和实际收到的 Vine 评价数量是不同记录，不能将报名 30 件当成已经获得 30 评，也不能自动补一个固定自然回评数。官方口径和访问限制见[研究记录](../research/newcomer-brand-support-evidence-20261111.md)。主人提供的常见起步经验留作后续校准线索，不改写为所有新品三个月内的总评价上限；当前也没有证据支持仅凭超过 40 或达到 100 就认定违规。

先核可见真实起步、同期评分增长、Vine／其他来源及父子体／旧评价历史，再决定能否作为正常起步参照。早期就带有高评价基础与三个月内逐步积累，不能混为一种轨迹；新子体或新显示上架日期不证明评价从零开始。未解释清楚的异常保留待核，不默认加入用于证明低门槛的正常参照，也不从真实竞争记录中抹掉。Vine 正常使用本身不扣分，评分数与文字评论数仍分开。此更正不启动逐品深查或建立固定评论数量淘汰线。

后续例子应以合理的小范围帮助理解，而非用未经核实的极高评价背景构造“相对少”。可用同样 10 评的样本，对比其他同期可比新品约 5—12 评和约 20—40 评的两个假设背景，说明相对位置可能不同；这些数值仍只是讨论材料，不是已证实市场分布或评分档位。正常样本前提的更正已说明，主人要求继续具体评分建议；以下为未批准的试评草案。

#### 当前方案：实际评价数量 3 分，市场相对位置 1 分（部分规则已确认）

为了具体讨论合成方式，以下均假设样本的正常起步、可比性和同期证据已经充分核实，且销售件数达到各自合格新品销量中位数的 80%。这里只演示这种销售条件下，评价积累如何支持本项得分；销售进展不足 80% 时怎样落入其他档位，以及多个起步样本如何汇成本方向的最终分数，仍未定。不得把一个样本的最高演示分直接当作市场最终分。

本项 4 分按实际评价积累 3 分、相对市场位置 1 分的方案逐项打磨。实际数量各段、正中位数相对转换及真实零中位数例外均已确认试评；较弱销售与完整样本汇总仍待明确。实际积累为主，相对位置补充市场背景；不增加总权重，也不把正常使用 Vine 另作扣分理由。Profile revision 22 保留已确认的组件规则，整个 4 分项 mapping 仍为 null。

实际数量部分已确认的试评锚点：

| 对应时点的实际评分数 R | 已确认试评的实际数量得分（最多 3） |
| --- | ---: |
| 0—10 | 3 |
| 20 | 2.5 |
| 30 | 2 |
| 40 | 1.5 |

10 到 40 之间按上述锚点连续计算，即 `3 - 0.05 * (R - 10)`；不因 10 变 11 就突然掉半分。主人已确认这段曲线先用于试评，后续用真实样本检查是否偏严。超过 40 的续段随后单独确认采用 `1.5 * 40 / R`，不直接归零或淘汰。40 不是正常与否的界线，不自动据评分数量认定违规。这是已确认试评、尚未实样校准的刻度，不是从真实数据拟合的规律。

#### 已确认试评：实际数量 0—40 评区间

主人此前接受保留取数限制和后续验证项，明确不默认数据都能取得；在实际数量算例说明后，现已明确批准 10 评以内 3 分、10—40 评每增加 10 评减 0.5 分用于试评，并要求真实样本检查是否过严。该批准仅覆盖这段实际数量曲线，不代表整套 4 分映射完成。两种中位数和销售 80% 条件继续保留，不再重问。

已确认规则意味着 15 评为 2.75 分，11 评为 2.95 分。满分段把个位数到约十个评价归为同一强参考范围；连续递减让 20—40 评的样本继续提供分值，且无突然跳档。10 及斜率 0.05 均是待校准的试评刻度，不是市场规律，也不是成功概率。不能因已写出直线，就擅自向 40 以上外推或新增归零阈值。

合成对照：假设各情景均为同细分、相近起步阶段的合格正常新品，同期评分与销售证据充分，所属参照组的销量中位数为 100 件；四种情景都有同口径 90 件销量，均满足已确认的 80% 销售条件。100／90 件仅为算例，不新增跨市场销量线或正式观察窗口。

| 假设情景 | 对应时点评分数 | 同口径销售件数 | 实际数量部分演示分（最多 3） |
| --- | ---: | ---: | ---: |
| A | 8 | 90 | 3 |
| B | 20 | 90 | 2.5 |
| C | 30 | 90 | 2 |
| D | 40 | 90 | 1.5 |

分差只描述在同样销售进展下，实际评价积累较少的观察更支持“少评价也有销售进展”；不证明销量由评价造成，不据此评判整款商品或整个市场。正常 Vine 不额外扣分，也不先从总评分数中扣掉一批假定 Vine 评价。0 评且没有相应销售证据不能因落在满分段就拿 3 分；评分数、正常起步或同期销售缺证仍待核。低于 80% 的销售如何计分、历史观测对齐和最终多样本汇总仍未定，不由这张表覆盖已接受的 3／4 分业务区别。

上述曲线已获采用，不再作为待答题。保留的校准风险是 30—40 评在此项得分可能偏严；后续须用多个细分市场的真实样本检查漏掉潜力款和虚高两种方向。超过 40 的续段也已在下一轮单独确认。相对市场 1 分的转换、整个 4 分项的组合与边界仍待逐项处理。

#### 已确认试评：超过 40 评的缓降续段

主人明确确认超过 40 评先按 `1.5 * 40 / R` 试评，后续用真实样本校准。适用前提仍是正常起步、可比性、同期评分／销售证据和销售进展条件充分；相对市场部分不加入本节示例。此续段与 40 评的 1.5 分连续衔接，评价越多分数越低，但下降变缓，不设新的有限评价数归零点，也不设固定保底分。

| 对应时点评分数 | 实际数量部分得分 | 状态 |
| --- | ---: | --- |
| 40 | 1.5 | 已确认前段终点 |
| 41 | 约 1.46 | 已确认续段的演示值 |
| 50 | 1.2 | 已确认续段的演示值 |
| 60 | 1 | 已确认续段的演示值 |
| 80 | 0.75 | 已确认续段的演示值 |

例如 40 评时 1.5 分，评价数翻倍为 80 时为 0.75 分；这些数字只是解释曲线，不声称三个月内这些评分数普遍、正常或已经找到真实样本。较高评价样本的正常起步仍须核实，不能因为能代入公式就认证其参照资格，也不能仅凭数量高认定黑帽。关键历史未知时继续待核，不自动按某个保底分、零分或正常样本计入；已知有不适合正常起步参照的历史时，保留其实际竞争记录，不能仅据此排除当前候选。

推荐理由：连续衔接已经确认的前段；保留合格较高评价样本的较弱参考价值；避免把此前每评减 0.05 的斜率直接外推，凭空在 70 评处产生归零边界。此处只界定“少评价销售进展”中实际数量的贡献，不判断整个产品好坏，不声称已知销售因果或真实成功概率。后续校准仍需同时检查过严与过松。

此续段已单独确认，profile revision 16 的 above_40_mapping 已记录，不再作为待答题。原先已确认的 0—40 规则保持不变；实际数量部分的数值曲线已定为试评，但整个 4 分项尚未完成。

#### 已确认试评：正中位数下的相对市场 1 分

主人已明确确认相对市场部分的试评取法：在中位数 M > 0、参照样本充分且口径可靠时，实际评分数 R 低于或等于 M 都给 1 分；高于 M 时给 `M / R` 分，后续用真实样本校准。它衡量同样有据销售进展下，评价积累是否高于可比新品的中间水平；不是市场成功概率，也不要求一定胜过中位数才能提供参考。M 的中位数取法与此转换分别已获批准，不再重问。

低于与等于都给满 1 分的理由：实际数量 3 分已区分较少评价的优势，相对部分用于补充市场背景。只要评价积累不高于参照，就不再要求比参照更少才能满分；达到中位数不会自动得到整个 4 分项满分。不要借此临时挑选高评价参照，完整样本及反例仍须保留。

固定参照的合成例子：假设同一合格参照组的评分数中位数为 20，以下各情景正常起步、可比阶段、同期数据与销售进展条件均已满足。20 是本例参照，不是所有市场的固定线。

| 实际评分数 R | 相对中位数 M = 20 | 已确认试评的相对分（最多 1） |
| --- | --- | ---: |
| 10 | 低于 | 1 |
| 20 | 等于 | 1 |
| 25 | 高于 | 0.8 |
| 30 | 高于 | 约 0.67 |
| 40 | 为中位数的两倍 | 0.5 |

例如 10 评与 20 评虽然相对部分都为 1，但已确认的实际数量部分分别为 3 和 2.5；按当前加和提案演示分别是 4 和 3.5。这只说明实际与相对部分各自提供什么信息，不批准完整市场汇总，不把单个样本最高分直接作为候选分。

中位数或评分数缺失、可比性／来源／时点不足仍待核，不填 0 或 1。主人明确要求真实零中位数也不能直接给 0 或默认满分；其已确认的试评例外见下方。正中位数公式不延伸到 M = 0，不擅自改分母为 1，也不把所有有评价样本自动记零。R 真实为 0 而 M > 0 时仍须先满足正常起步和销售证据条件，不能因零评价就自动发分。

正中位数情形的相对转换已获确认，profile revision 17 已记录，不再作为待答题。主人要求继续定义中位数为 0 的情况，且明确不接受直接给 0 分或默认满分。

#### 已确认试评例外：真实零中位数与缺失数据分开处理

首先辨别真实观测为 0、源字段缺失和口径错误。`空、空、空、6、12` 不能填成 `0、0、0、6、12`，也不能据此声称市场中位数为 0；这种情况是缺证，受影响的分项待核。真实且同口径的 `0、0、0、6、12` 中位数确为 0；这一事实应保留，不把真实零值删除后只用 6 和 12 算出 9 来替代已定参照。

若直接把正中位数分支延伸到 M = 0，则 R = 0 会自动得 1，任何 R > 0 都会因 0/R 得 0。这样 0 评到 1 评便跳过整整 1 分，1 评与 40 评又完全相同，不符合本项希望保留的渐进比较。数学上的已知零不等于数据缺失；问题是当前比值尺度在这个基准下不能按原意区分程度。

主人已确认第一版为真实 M = 0 保留例外：相对 1 分标为“真实零基准，暂不评分”，同时展示原始分布、实际评价数与销售证据。其他有充分证据的分项继续计算，候选保留；不填 0、0.5 或 1，不把这 1 分转移到别项或放大已有权重，也不把已知部分当成完整总分。Profile revision 19 的 zero_median_mapping 明确记录未评分结果，而非数值 0；完整 4 分项的 mapping 仍未完成。

| 合成情景 | 已核实的参照评分数 | 观察样本 | 已确认的试评呈现 |
| --- | --- | --- | --- |
| 部分真零，真实中位数为 0 | 0、0、0、6、12 | 3 评，其他正常起步、可比和销售条件均满足 | 实际数量部分按已定规则为 3 分；相对 1 分暂不评分，保留零基准与原始分布 |
| 全部真零 | 0、0、0、0、0 | 0 评，且确有充分销售进展及正常起步证据 | 可以描述其评价数与参照相同；相对 1 分仍不默认满分，实际部分仅在既有证据条件满足时计分 |
| 三个值缺失 | 空、空、空、6、12 | 无法确认完整参照 | 标为参照缺证，不冒充真实零中位数；受影响部分待核 |

第一行的呈现应为“实际数量 3 分已确定；相对 1 分未评分；这项 4 分尚无完整得分”，不能写成最终 3/4，也不能将已知 3 分归一到满 4。这里没有决定整个候选的缺证排名或市场级汇总方法；保留这项差异供后续统一设计。第二行的正销量和正常起步仅是合成前提，不宣称存在已验证的零评销售样本，更不能让刚上架零评零销量自动得分。

后续真实样本验证需记录真零基准出现频率、零值来源／采样时点可信度、销售证据及样本覆盖。如果该情形经常出现，再评估是否确有必要设计另一种相对比较尺度；不自行改用平均数、非零子样本或人为加 1。现阶段不新增实时取数或一套复杂替代算法。

零基准问题已回答：主人在具体例子与“保留实际已知分、相对 1 分未评分、不是完整 3/4、不因此淘汰”的说明后明确确认。少评价且有据销售的正面价值仍保留在实际数量部分与证据说明中；零基准不等于坏市场，也不单独证明蓝海。缺失值继续沿用既定待核原则，评分空位的总分／重排处理仍需后续统一定义，不把本例外当作已解决排名。

#### 历史提案：销量比例折算暂不采用，原 4 分保留

主人已明确澄清：星级只展示平均值，原来的少评价销售表现 4 分保留，下面的销量比例折算公式暂不采用。此前确认的评价数量曲线、两种中位数、80% 销售参照及真实零评价中位数例外均不撤回；不足 80% 怎样计分仍待定，不自动给 3 分或淘汰。以下只保留当时提案与算例，不能作为当前计算规则。

建议在正常起步、可比性、时点和输入证据充分，且两部分评价分均可计算时，先合成评价基础分 P = 实际数量部分 A + 相对部分 B，再按销售进展折算：单样本试评分 = P × min[S ÷ (0.80 × T), 1]。S 为该样本同口径销售件数，T 为已确认合格参照样本的正销量中位数。达到或超过 80% 时保留 P，不额外加分；低于时连续折算，不人为在边界突然扣掉一整分。这个新公式尚未批准，也不是恢复旧 Q16 的全局直线优先提案。

合成例子：假设 T = 100 件，观察样本 10 评且不高于正评价中位数，两部分评价分为 3＋1，P = 4；正常起步和同期可比性均仅为例子的前提。

| 样本销量 | 相对销量中位数 | 建议单样本试评分 |
| ---: | ---: | ---: |
| 80 件或更多 | 至少 80% | 4 |
| 79 件 | 79% | 3.95 |
| 60 件 | 60% | 3 |
| 40 件 | 40% | 2 |
| 20 件 | 20% | 1 |

100 件、80 件等只是演示，不是通用销量门槛；换到另一个细分，要使用它自己的有据正销量中位数。若评价基础分 P 只有 3，达到中位数 60% 时建议为 3 × 0.75 = 2.25，并非所有 60% 样本一律得 3。连续折算也不会因为低于 80% 将候选排除；整个产品还需其他维度和样本汇总。

这张表只演示完整证据下的单样本规则，不把最高个例分直接当作候选方向最终 4 分。缺失销量不是零；真实零销量与无完整销售观察不同。T 为零、无法对齐或证据不支持时不能用该公式，也不移植评价中位数为零的例外。已确认的真实零评价中位数仍保留相对 1 分未评分；本轮不把未知部分补齐或决定其总排序。部分得分与多样本汇总仍需统一定义，来源误差不靠编中点或额外固定扣分掩盖。

该延伸可能把低销量且评价较多的样本压得更低，因此后续跨类目试评需检查是否过严、漏掉潜力方向，并检查与新品销量占比是否重复放大同一信号。当前只有合成算术演示，没有真实样本校准、实现或外部请求。

该提案本轮不采用，不继续将其作为当前待确认问题。完整 4 分项仍待定义，不能因暂不采用这条折算曲线就取消该项、移走权重或编造默认分。

以下保留早先的组合算例，实际数量曲线与正中位数相对转换均已确认试评，完整市场汇总仍未定：

| 合成情景 | 实际评分数 R | 有据评价参照 M（本例假设） | 实际部分＋相对部分 | 演示合计 |
| --- | ---: | ---: | --- | ---: |
| A：少评且低于参照 | 10 | 30 | 3＋1 | 4 |
| B：实际仍少，但高于参照 | 10 | 5 | 3＋0.5 | 3.5 |
| C：积累更多，处于参照水平 | 30 | 30 | 2＋1 | 3 |
| D：积累更多，也高于参照 | 40 | 20 | 1.5＋0.5 | 2 |

这些是小范围的合成条件对照，不是两条真实 ASIN 就能推断一个市场；它们也不自动证明任何给定评价数量的真实性。正式参照仍需整组来源、反例和覆盖说明。全市场都在较少评价下取得销售进展时，不必再要求某个新品比其他所有新品更少，才能提供高分证据。

提出以上合成算例时，实际 3＋相对 1 的具体规则尚未确认，主人先询问参照定义。其后评价中位数、实际数量各段、正中位数相对转换及真实零中位数例外已分别确认。80% 以下销售进展、其他边界和最终样本汇总仍待打磨。未启动实际评分、扫描或正式工具开发。

#### 已确认试评：可比新品评价数量中位数

主人已明确确认：评价数也先用这批可比新品的中位数作参照，后续跑真实样本校准。“市场参照评价数”因此采用同一细分、可比起步阶段的一组有据正常新品，在一致观察口径下的累计评分数量中位数；它是本项目定义的比较量，不是提供方现成的原生评分字段。它回答“在这组可比新品中，这个评价数量处于什么位置”，不代表全市场起步必需评价数，也不证明评价导致销量。奇数样本取排序后的中间值，偶数样本取中间两个值的平均数；仍保留全部原始值和范围。

建议沿用预先确定的合格比较样本，与销量参照的成员对齐并逐条保留依据。上一提案的“销售进展相近”措辞不应变成每评价一款就临时筛出销量最接近的几款、只挑成功者或高评价者的规则；销量是否达到已确认的 80% 条件单独检查。不得因结果不利而删除原本合格的成员。完整观察记录继续保留表现较弱、退出、未成熟和历史待核的样本，并区分实际竞争记录与有据正常起步参照，不由这个新提案擅自改变各项样本口径。

评分数量保持来源与商品家庭口径一致；不要将文字评论条数、星级或重复子体混入。时间需要针对问题对齐：若比较进入相关 BSR 前 100 时的评价积累，就比较各自有证据的进榜时点评分数，并核对相应销售证据；今天的累计值不能代替历史值。首次观察到进榜不能写成真正首次进榜。主人偏好入榜时评价参照已记录，但本段不新增已批准的事件窗口、样本成员、覆盖门槛或历史取数能力。缺失、口径冲突或代表性不足时保留待核，不填零或自行补数。

合成说明：假设已核实且按同一口径记录的一组可比新品，评分数依次为 10、16、20、28、35，则中位数为 20。被观察样本为 8 评时低于该组中间水平，为 30 评时高于中间水平；这只是相对位置，单凭它不能确定完整 4 分项或整个候选的好坏。五款不是最低样本要求，20 也不是通用正常值或满分线。排序和取中位数适合脚本计算；样本归组、真实起步和数据可用性仍需有据判断及后续测试。

评价中位数经单独确认记入 profile revision 14，实际数量 0—40 评曲线与超过 40 的续段分别记入 revision 15、16，正中位数相对转换记入 revision 17，BSR 主参照与新品榜补充的来源边界记入 revision 18，真实零中位数未评分例外记入 revision 19，同细分市场平均星级参考记入 revision 20，缺入榜历史时可单列当前观察参照记入 revision 21，当前观察的最近 30 天及短历史口径记入 revision 22。历史数据可得性的能力与限制已说明，后续验证项保留。主人已明确暂不采用新增的销量比例折算提案，原 4 分及已定组件保留；当前转入多样本怎样支持候选方向得分。误差与最终多样本评分仍待打磨，参照成员／时点／覆盖充分性仍待验证，完整 4 分项 mapping 继续为 null。

#### 已说明的数据限制与后续验证：入榜时的评价数量

复用 API 席的固定 Q31 能力报告，并于 2026-11-12 再核当前暴露的 `mcp__codex_apps__sellersprite_mcp_keepa_info` 声明及[卖家精灵官方历史接口](https://open.sellersprite.com/api/22)。接口声明支持已知 ASIN 的大／小类排名历史和评分数历史，附带时间戳、实际返回 ASIN、父体和排名节点信息。因此存在查询历史数据的技术路线，不能说只能查当前值；但本轮未调用任何真实 ASIN，尚不能承诺实际返回率、覆盖、耗时或完整首次入榜数据。官方文档的示例本身也存在空的评分历史数组，示例不是本账户实测结果或总体缺失率。

拟议取证过程是先取得有据候选，再读取该 ASIN 历史；脚本按同一站点、排名节点和返回主体寻找有效在榜观测，并对齐评分观测时间。首次观察在榜不等于真正首次进榜；历史起点已在榜时更早入榜未知。只有邻近日期／时刻的评分时，必须标明时间差，不能称为进榜瞬间评分；允许时间差尚未定义。每日末条、空值、节点变化、父子体或合并评价口径都可能影响判断；不从文字评论列表反推完整评分总数，不用今天的评价数回填过去。

实际历史覆盖验证应是后续有界试跑的前置检查。精确首次入榜评价数尚未被批准为每张初选卡必备输入；不能因历史缺失自动给零分或排除候选。历史不足时单列当前观察参照的原则已获确认；具体窗口、匹配与充分性仍需定义，不能与入榜时点评价默默混用。当前只核说明和记录；未发起商品查询、扫描、付费请求或正式实现。

主人随后明确同意把上述数据限制与后续验证项记录下来，不默认全部可得，并要求回到实际评价数量部分继续设计。后续授权试跑须检查：

- 实际有多少样本返回可用排名／评分历史，多少为空、缺段或历史起点已经在榜；分别保留有效、邻近观测、缺失和冲突，不能只报告有数据的样本。
- 排名节点、站点、实际返回 ASIN 与父子体口径是否一致；采样起止、排名与评分的时间差是否足以支持所讨论的观察事件。
- 所称首次入榜究竟是历史中首次观察还是有充分更早覆盖；每日末条、类目变化或历史缺口是否影响判断。
- 形成中位数的样本成员、有效数量和覆盖缺口，以及实际调用量、耗时和对出卡效率的影响；样本数量、时间差容忍度和通过标准尚未选定。

这些是待验证项目，不是验证通过的报告，也不授权现在调用真实商品、扫描或付费取数；正常起步的归组判断和评分业务效果仍需分别验收。

#### 已确认：缺入榜时历史时，可单列当前观察参照

主人此前偏好观察新品进入相关 BSR 前 100 时的评价积累，并明确要求不默认历史数据都能获得。现在只讨论遇到这种缺口时的评分观察基础，不改变星级展示要求、不采用上方销量折算公式，也不把所有初选卡改为只展示数据。

主人已确认：在已确认的 BSR 可比正常新品主参照范围内，若入榜时评价历史缺失，但有证据支持当前评价数、同一销量观察期间的数据和可比起步阶段，允许单列“当前少评价销售表现”作为另一种明确标注的试评基础。它回答现在能否以较少评价获得销售进展，不回答起步或首次冲榜时需要多少评价。可用入榜历史仍保留为另一条证据；不能用当前数回填历史，不能把当前与入榜时的记录混成一个中位数，也不能默默把两个评分基础当作同一结果。

例如，一个新品当前 18 评，当前销售资料可核对，但首次观察进榜当时的评价数未知；按已确认原则，它可进入有据的当前观察比较，却不能写成“18 评就冲榜”，也不能推断早期的运营方式。比较样本须采用相同时间口径和可比起步阶段，不拿上市数天与三个月成熟程度的差异冒充商品优势。

主人已批准允许这个替代观察基础，profile revision 21 记录原则，revision 22 另行记录最近 30 天及短历史处理；具体阶段匹配办法、充分覆盖标准和不同基础结果怎样参与最终排序仍待定义。既定评价曲线的实际适用性仍须用真实样本校准；缺证仍待核，不因此淘汰候选或补成 0。当前不启动取数。

此问题已回答：缺少入榜时评价历史时，可在明确标注、同口径比较的条件下，使用“当前评价数＋同期销售资料”评价当前少评价销售表现；不宣称复原了入榜时的表现，也不与入榜事件样本混算。

#### 已确认：当前观察采用最近 30 天，并保留短历史差异

之前最近 30 天为主、近三个月辅助的决定，针对的是新品销量占比 2 分。主人现另行确认少评价表现 4 分的“当前观察”采用截至同一观察日期的最近 30 天销量，搭配有日期的当前评价数；profile revision 22 已记录。该确认不代表所有接口都能返回满足此口径的数据，实际能力仍需验证。

上架未满 30 天的新品仍可作为观察与比较对象。只记录有依据的窗口内销量、真实起步天数及实际覆盖，不按日均外推整月，不把未开售时段当作经过验证的零销量经营日，也不直接用它与已经完整销售 30 天的较成熟样本解释起步能力。应寻找起步时长和覆盖相近的可比新品；找不到有据参照时，该部分待补证，其他有据资料仍展示，不因年龄短给零或淘汰。

合成例子：一个上架 12 天的新品，窗口内观测销量为 60 件，记录为“最近 30 天口径下实际上市 12 天、60 件”；不外推成 150 件。优先与起步时长和有效覆盖相近的可比新品比较，不直接把上架 70 天商品完整 30 天的 60 件认作相同起步表现。这里不批准固定年龄分箱、最少样本数、日均标准化或隐藏的阶段权重；实际匹配办法与可用性须通过样本验证。

数据返回的实际日期、字段含义、估算或档位属性必须保留。已有 API 能力报告提示月度曲线、自然月与近月档位并非同一口径；本轮没有复测接口，不能承诺均能返回任意滚动 30 天的精确件数。若仅有自然月、累计数、区间或缺失，不冒充已符合本提案，也不编中点或拆造日销量。实际能力仍由后续授权取数验收。

此问题已回答：这 4 分的当前观察以最近 30 天为主，短历史新品记录实际天数、采用相近阶段的参照且不外推整月；无合适参照时保留数据与缺口，不因上市时间短给零或淘汰。

#### 已确认：两个较强有据样本的平均，作为试评汇总

不重问已定的“少数可比正常样本也有价值、不要求多数新品成功”。本轮确认这 4 分中完整合格样本的汇总函数，不据此判断整个候选或市场的好坏。

主人已确认试评时，在已观察且保留完整记录的样本中，先核同细分、起步阶段、观察基础、正常起步与销售证据；对已满足较强销售条件、两部分评价分可计算的样本，取较高的两个单样本参考分做算术平均。它表达已经找到的少评销售突破机会，不表达典型新品表现或成功概率。数字“两个”是本轮接受的试评佐证数量，不是已有行业标准；profile revision 23 记录此决定。

算例只为说明汇总：两款不同商品家庭的合格样本，按已定组件规则分别可形成 4 分和 3.6 分，则按本次确认的规则汇总为 (4＋3.6)÷2＝3.8 分。较低表现、退出、未成熟、历史不明以及未满足销售条件的观察仍须全部保留；不能只收集这两款，也不能将未定义的较弱销售或缺失项填 0 后参加平均。原来的两种中位数仍依其已定样本范围计算，不改为只用这两个好样本。

Same-parent color children, repeated source records and shared launch histories do not supply two independent examples. Under the later revision-42 scope, retain observable seller-ID/brand relationships and supported shared-launch evidence; hidden cross-shop corporate tracing is excluded, not a missing eligibility condition. Account identity alone does not prove traffic support or manipulation. Explain inclusion and material in-scope uncertainty, and address known evidence that undermines launch comparability before using an exemplar.

只有一个合格样本时，已确认保留其单样本分与“单例线索”的说明，不直接当成该方向完整 4 分项得分；不足两个不淘汰候选，不补零、不虚构第二例，也不放大其他权重。真正零评价中位数下相对 1 分未评分的既定处理不变，不能把不完整分数装成完整样本分来凑数。

这条规则会比全体平均更重视少数突破案例，也可能随可观察样本增多而偏高；后续跨类目校准须检查孤立高分、只剩单例、多个有关联样本和大量反例时是否过度乐观。当前／入榜事件基础不能混算，跨基础最终如何合并、反例的实际解释和缺证排序仍待明确。该汇总规则已获批准用于试评，但较弱销售、具体证据充分性、部分分数和跨观察基础的处理尚未完整定义，完整 4 分项 mapping 继续为 null；未发起实际取数或实现。

此问题已回答：先用两个较强且证据完整的合格新品样本取平均；只有一个时保留单例分和证据，不直接作为方向完整分。保留全部已观察样本与反例，后续校准是否过度乐观。

### 4. 自然可见度发展：0—1 分

- 主人再次明确多来源要求：保留 SIF 自己口径的自然／广告曝光占比与自然／广告流量词数量，同时列出卖家精灵自己口径的自然／广告流量词数量。来源、时间、父子体范围与缺失情况分别注明；相关位置与变化可补充解释，结合销量判断，不能只看占比或排名而漏掉词数。此答复确认要同时保留与核对多种证据，不代表接受刚才提出的换分曲线。
- 在同口径、相关词覆盖可比较时，自然覆盖更充分、自然曝光占比更强是有利证据；自然词多于广告词不自动代表转化更多。同一个词可能同时有自然与广告位置，不把两类词机械相加当不同购买入口，也不把两个提供方的词数相加。
- 广告可见度高不直接扣本项；自然可见度占比高也不自动拿满分。不能由 SIF／卖家精灵曝光估算推出自然订单、实际花费或利润。
- **尚待确定：**相关词的选择、怎样衡量发展或保持、时间参照、完整覆盖下的低分依据及具体换分。较长记录可以提高判断把握，但上市更久不自动加分；短历史或缺观测不能直接记 0。

#### 已明确：两家数据各自保留，不混成一个数字

同一个可比正常新品，在窗口与商品范围可比较的前提下，可以并列以下合成例子，数字仅用于解释展示与判读：

| 来源 | 自然曝光占比 | 广告曝光占比 | 自然词数 | 广告词数 |
| --- | --- | --- | --- | --- |
| SIF | 70% | 30% | 30 | 10 |
| 卖家精灵 | 本例未提供 | 本例未提供 | 45 | 18 |

两家词数不同，但都观察到自然词多于广告词，可以说明观察方向相容，不能声称它们统计了同一个完整词库、覆盖了所有购买入口或两票证明了自然订单占比。词数不能相加或平均后冒充更准确的数量，更不能拿自然词数除以两类词数之和充当曝光占比。若一边的观察明显指向相反判断，先核日期、变体、词的相关性与覆盖等实际原因，不挑有利数值；仅因数量不同不另扣分。缺一方数据须如实显示，不能默认两家每次都可取得。

#### 已明确：不要求精确对齐词数和更新时间

主人先接受根据两家大致的范围与方向综合判断，不要求每一个词数或刷新时点相同；随后明确接受下方的观测范围与方向综合方法。原始读数与日期应保留以便追查，卡片可以简明表达。普通覆盖或刷新差异不因此扣分、不给卡或判坏，但仍要辨认是不是同一款／同一父子体范围，以及观察期间是否具有可比性。此原则记入 profile revision 24，未批准数学平均、中点、固定误差带或新的分值。

SIF 的界面名称可以保留为“自然／广告流量占比”，并注明其口径是工具估算的有效曝光。[官方教程 §3.1](https://blog.sif.com/article/bl37ebc3d60b1649b2a64fbf4d14eae39f/%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B%EF%BC%9A%E5%8F%8D%E6%9F%A5%E6%B5%81%E9%87%8F%E8%AF%8D) 明确区分了曝光与点击、转化；它不是竞品后台实测点击／订单份额，也不等于原始实际展示次数。接口实际字段与分母仍须后续验证。

#### 已确认：展示观测范围，再解释是否相互支持

沿用上表合成例，若商品范围和期间可比较，可简写为“自然词：两工具观察约 30—45 个；广告词：约 10—18 个；两家都观察到自然词多于广告词；SIF 自然流量占比约 70%（曝光估算口径）”。这给出一条有来源的综合解释，不伪造一份精确合并词库，也不把 30—45 当成真实词数必在其中的保证或统计置信区间。

只在相同含义的词数之间报告来源差异；SIF 的占比仍单列，不与另一家的词数平均。精确刷新时点不一致可以如实注明，不必因此停止判断；若实际是上周与上月、不同变体或严重缺失，则不能用一个区间掩盖不兼容。明显相反的证据应先检查日期、商品范围及相关词覆盖，解释原因或保留分歧；不能只挑好看的来源，不能用任意中点解决分歧。具体时间容差和何种冲突足以妨碍计分，仍需后续定义与样本验证。

此问题已回答：主人明确接受这种综合方法，两家数据不必完全一致。profile revision 25 记录已定方法；具体分值、时间容差、充分证据标准和多新品汇总仍待确定。

#### 保留的未采纳提案：占比直接换成 0—1 分

先前在保留两家数据后，实施方曾建议这一分以同口径 SIF 整体自然曝光占比直接对应数值：有据的 20% 对应 0.2 分，60% 对应 0.6 分，80% 对应 0.8 分，上方合成例的 70% 对应 0.7 分；自然词与广告词数量继续显示，用于核对相关购买入口的覆盖及变化，不再额外加分。理由是词数同时受市场词库大小、长尾数量、工具覆盖和实际相关性影响，直接再按词多给分会偏向词库丰富的方向；不能因词少就推定自然销售能力弱。这是当时未获批准的建议；其中直接按占比换成 0—1 分的数值方案未获采用。主人随后批准的是下方 70% 满分曲线，以及词数用于交叉核对、不另外加分。这里先定义单个合格正常新品的换分；不能擅自把之前少评价项的两个最高分样本或其缺证条件复制成这一分的选择规则。

提议以与销售观察相容的近期 30 天数据作为当前水平的基础，保留实际日期、父子体范围及短历史覆盖，不外推缺失时段。自然曝光占比需要核清整体分母；例如原生 SIF 的层级比例相对于上一层，不能把广告子渠道中的一个比例当成全商品自然曝光比例。卖家精灵自然词／广告词可能重叠，不能用“自然词数÷两类词数之和”冒充曝光占比，也不能将两家的不同口径简单平均。能力说明不等于真实返回已验收。

这条提案评价当前观察到的曝光结构，不单凭一个快照宣称自然曝光在增长、已稳定或自然订单占比高。相关自然词、曝光量或排名轨迹可作解释；占比上升也可能源于广告减少。广告占比高不另加处罚，更不推出亏损。实际范围不足、时间或商品范围不兼容、分母未知或缺数时，本项仍待补证，不给零。来源只显示少量词的 100% 不能自动拿满分；词数少也不设一刀切低分线，要核它是否覆盖该细分的重要购买入口。

此先前提案及其时间口径尚未获批准，未写入 profile 的自然可见度 mapping；主人对近似综合的补充不能作为其数值批准。如何确认覆盖足以计分、怎样汇总多个新品、是否需要另行量化发展轨迹，以及它与少评价样本的关系仍待明确；缺少可计算的评价数中位数，不自动抹掉已有的自然曝光证据。提出该方案时没有真实 ASIN、卖家精灵或 SIF 请求；随后获准的 SIF 有限实测见本稿开头，未扩为选品扫描。

此前“70% 得 0.7 分”的提案未获批准，保留为讨论历史。综合方法确认后，实施方另提下方 70% 满分的连续试评曲线，主人现明确接受用于试评。保留这条变更历史，不能写成主人曾批准后又撤回旧曲线。

#### 已确认试评：70% 自然流量占比满分，以下连续换分

本轮先定义一个合格可比正常新品的单样本参考分，再衔接市场内多个新品的汇总；此前少评价项的两个较强完整样本取平均，不自动成为本项规则。

主人已确认单样本试评曲线 `min(p / 0.70, 1)`，其中 `p` 是有据的同口径 SIF 整体自然流量占比小数值，按其曝光估算含义解读。35% 得 0.5 分，70% 及以上得 1 分；两家词数用于交叉核对，不因词多、来源多另加分。70% 是待真实样本校准的设计锚点，不是行业门槛；数值连续并在 1 分封顶。商品、时期、分母、相关覆盖和同期销售资料的具体充分性仍需定义，不能把曲线批准扩成任意原始占比都可直接计分。

| 有据的自然流量占比（曝光估算） | 已确认的单样本试评分 | 说明 |
| --- | --- | --- |
| 14% | 0.2 | 观测自然可见度较弱，只影响这一分，不是淘汰线 |
| 35% | 0.5 | 已有自然可见度，但相对占比仍有限 |
| 56% | 0.8 | 曲线中的高分例子，不建立新的“高分”筛选线 |
| 70% | 1.0 | 达到试评满分锚点，仍须有可解释的相关覆盖证据 |
| 85% | 1.0 | 达到上限，不重复奖励更高占比 |

满分合成例：同一个已核可比、正常起步的新品，SIF 自然词 30／广告词 10，卖家精灵自然词 45／广告词 18；核对可见自然词确实覆盖相关购买用途，SIF 自然流量占比 75%，同时有相容期间的销售资料，没有未解释且足以改变判断的范围冲突。按已确认曲线为 1 分；本例的证据充分性判断仍是待实测的说明，不能视为所有操作门槛均已批准。这里只用销量确认观察有意义，不再按销量大小加分，也不推断自然订单或盈利。自然词多于广告词不是满分必要条件：少量重要自然词也可能承担较大曝光，词数少本身不扣分。

反例：工具显示自然占比 95%，却只有范围不明的零碎词记录，或者对应旧变体／错误时期，且覆盖与销量无法核对，则不能直接给满分。保留该原始数和待核状态，不补 0 或任意中间分。反过来，若少量词足以覆盖这个细分的主要购买入口且有据，不能仅因词少否定它。两家正常的数量／刷新差异不属于这种实质缺口。

原生点值与范围保持各自含义：若来源只有占比范围，分别换算边界，不发明中点；已确认的词数观测范围也不能代入占比公式。分数表示当前有据的自然可见度结构，不要求新增固定次数／天数的历史记录才能拿满分，也不把一个快照称为持续增长。现有历史和自然词／曝光变化可辅助解释；占比增长不能单独证明自然曝光增长，广告占比高也不另加惩罚。具体观察窗口与可用性仍待核，不在这里默认为已批准。

profile revision 26 已将这条批准的单样本曲线写入 `measurement.newcomer_natural_visibility_example_score`。完整分项 mapping 仍为 null：同两款完整样本的平均已由 revision 27 另行确认，但操作性的相关词／覆盖标准、时期容差、单一来源、实质冲突、边界误差及不完整样本处理尚未完成。后续不同类目的试评须检查 70% 满分是否太宽或太严，以及是否错误抬高稀疏记录、忽视有潜力的广告期新品。曲线批准不追加实测或扫描权限；本稿开头的有限原生实测已经结束。

此问题已回答：先按 70% 满分、35% 得 0.5 分的连续曲线试评，两家词数用于交叉核对，后续真实样本校准。

#### 来源分歧的处理建议与已确认的同样本汇总

以下保留针对来源分歧的处理建议；主人随后明确接受本节的“沿用少评价项同两款合格新品，分别算分后平均”作为暂定试评汇总。该确认不代表下列所有操作性冲突细节或不完整样本方案都已定案。

先分清词数与曝光贡献。两家自然／广告词数方向相反，不能直接推出 SIF 的自然曝光占比错误；少量主要自然词可能贡献多于大量小流量广告词，同一词也可能同时有自然和广告记录。SIF [官方释义](https://blog.sif.com/article/bl37ebc3d60b1649b2a64fbf4d14eae39f/%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B%EF%BC%9A%E5%8F%8D%E6%9F%A5%E6%B5%81%E9%87%8F%E8%AF%8D)把流量占比定义为曝光估算，考虑位置、出现时长和搜索量等；它不等于词数比例。不能把两个数量范围当成同一个精确词库，或用两家投票选择一个占比。

| 合成场景（词数均为自然／广告） | 建议处理 |
| --- | --- |
| SIF 90／60，卖家精灵 100／65 | 商品和时期可比时，保留两家读数与大致范围；普通差别不扣分，不要求完全相同。 |
| SIF 90／100，卖家精灵 100／90 | 都接近持平，轻微差别就会翻转大小关系；不能夸大成一个判断自然强、另一个判断广告强。 |
| SIF 30／100，卖家精灵 100／30，同时 SIF 自然曝光占比 70% | 记录明显词数分歧，先核站点、父子体、日期、广告类型，再针对影响最大的相关购买词核自然位置／曝光贡献。若能解释为覆盖差异，且该占比仍有据，单样本仍可得 1 分；不能仅因方向相反扣分。 |
| 占比实际来自错误变体／时期，或关键购买入口的可比观察出现未解释且足以动摇占比可信度的矛盾 | 保留原始数据，受影响的本项标待核，不强给 1 分、不填 0，也不擅设折扣；其他有据分数和卡片继续保留。另一家没有采到某词，本身不能证明自然位置不存在。 |

检查范围以解释会影响评分的关键差异为限，不要求逐一核尽整份词库，也不因一个固定差异百分比自动认定冲突。解释未完成时明确标注“词数方向分歧”；若 SIF 的占比输入仍有可用依据，可保留按其口径换算的来源参考分，不能称为双源已验证。是否足以纳入完整汇总仍取决于相关覆盖与冲突影响，不能用折中平均或补零制造完整结果。单一来源缺失与已证实的反证不同，具体充分性仍待定义。此处无新增取数，所举原因只是可能解释，不是假定任一真实差异已查清。

已确认的多个新品试评汇总（profile revision 27）：当少评价项已经按其已定规则选出两款完整合格的较强新品，且两款自然可见度资料均足够支持计分时，本项沿用同一对样本，各自按已批准曲线换分，再等权取算术平均，不另挑自然占比最高的两款。合成例：A 为 70% → 1 分，B 为 35% → 0.5 分，汇总为 0.75 分。第三款 C 即使为 90%，也不只为提高本项分数而替换 B；C 的有据表现及全部其他观察仍保留供解释。若原样本的资格被新证据推翻，应按原规则透明重选并同步检查相关分项，不能只替换低分。

这样能核对同一批少评、有销售进展的新品是否也形成自然可见度，减少不同分项各挑一组赢家造成的过度乐观。代价是可能未充分代表其他有效的自然起步路径，真实校准须检查这一点。它表达这对有据突破样本的可见度，不是全市场平均或成功率；其他新品、低表现、退出及未成熟记录仍保留。相同父体／共享起步轨迹不能重复凑两款，已知资源关系披露，不把未知关联写成已证实独立。

若该对样本某款自然数据缺失或存在实质未解冲突，建议先展示支持的单样本分及缺口，不自动换成更高分样本、不填 0、不把一个分冒充完整两例平均。若少评价项尚未选定一对完整样本，仍可独立计算有据的自然单样本分；评价中位数为 0 等别项缺口不抹掉自然证据。此类情况下方向汇总的替代样本选择仍待定，不借本建议强加评价完整性作为自然数据的资格条件。

此问题已回答：主人接受先沿用少评价项选出的同一对合格新品，各自算自然分后取平均，用真实样本再校准。不再重复询问该汇总选择。

#### 已确认：缺一款自然数据时，待补证并辅助展示可能范围

沿用既定缺证原则：未知不补 0、不默认 0.5、不直接使用单款分数替代两款平均，也不只为凑齐数据而替换成另一款高分样本。保留有据单样本值、缺口和其他分项，不能据此淘汰整张卡。主人已确认这种辅助展示，profile revision 28 记录；不决定总分排序。

合成例：A、B 已选定且资格有据；A 的自然可见度参考分为 1，B 的自然占比暂时没有可用数据。在 A 仍然有效、同一对样本不变、B 后续可按 0—1 分曲线计分的前提下，这一对的平均分可落在 0.5—1.0：B 若为 0，平均为 0.5；B 若为 1，平均为 1。这是由缺失值的允许范围推出来的边界，不代表 B 实际为 0 或 1，不是统计置信区间，更不能取中点 0.75 当作主分。

主人已确认先展示：“自然可见度：待补证；A 单样本 1 分，B 缺数；该对样本可能范围 0.5—1.0 分”。完整项分仍为空，0.5 不自动作为已得分计入总分；不借此放大其他权重。若 A 或该对样本的资格也受实质冲突影响，以上边界不成立，应撤掉这段区间并说明原因。两个都缺、仅有一款可选、来源不全但已有可用 SIF 输入等其他情形不由这个例子自动定义。

此问题已回答：先按“待补证＋可能范围”展示，实际得分留空，不取中间值。对已知单样本分 s，同一适用条件下的两例均分范围为 s／2 至 (s＋1)／2；这只是上述边界的通用算式，不扩大到样本资格未知、两个都缺或总分排序。

## 从原始数据到分数：一组完整合成算例

2026-11-12，主人要求先把正常新品 10 分的完整过程连起来解释，再继续关键取舍。本例仅复用 profile revision 31 的已定试评规则，没有新增数据请求、真实校准、正式实现或弱样本入池批准。数据全部虚构，20 款／4 款新品不是抽样要求，60 件不是通用销量门槛。

### 1. 数据从哪里来，谁负责什么

假设系统从真实关键词／市场信号发现“橱柜内双层抽拉收纳架”方向，主人不需要先提供这个词。以下只演示该方向的正常新品 10 分；需求、竞争、毛利等另外 90 分不由此推断。

计划通过现有卖家精灵／SIF MCP 等受支持的结构化入口获取数据，保留来源、参数、实际日期、原始值、对象范围和失败状态。先用现有入口，不为演示另建采集平台；哪些接口能完整提供目标字段仍须实际验证。Codex 调用数据工具不等于已有一个能无人值守稳定运行的产品。固定算术不需要模型 API。

| 环节 | 脚本／确定性代码 | Codex 的判断工作 |
| --- | --- | --- |
| 接收并整理数据 | 保存来源，校验字段、单位、日期和错误，按明确标识去重；不把空值写成零 | 判断返回内容是否回答了当前问题，决定还缺什么可查证据 |
| 确定可比商品 | 按已核实的成员清单处理父子体、颜色重复与同口径分子／分母 | 根据用途、结构、尺寸、功能和真实替代性核实分组；材质差异是否改变需求不能只靠标签判断 |
| 核实新品参照 | 对齐上市时间、可得历史、销量／评价日期，标记跳变和父体变化 | 结合旧评、父子体、同品牌支持等证据判断是否适合做正常起步参照，写明理由和未知；无异常不等于因果证明 |
| 计算和呈现 | 计算中位数、四项分数与已定汇总；回溯到输入、规则版本和缺口 | 解释结果、反例和限制，不能为了凑分临时改公式 |

初筛轻量归组，优先项精筛核实计分必需证据，出卡前脚本计算；昂贵的进一步经营主体、供应链或实物调查仍按既定阶段深化。无法核清的关键条件保留缺口，不因初卡阶段就假装已经完成调查。

### 2. 本例已获得哪些数据

合成前提：某个已注明站点、节点和日期的完整当前 BSR 前 100 快照中，有 20 个经核实真正可比、同口径去重后的商品单位，其中 4 个是三个月以内的正常起步新品。其它 80 个不属于该细分，不混入本项分母；榜外和 New Releases-only 记录保留辅助用途。没有把未核实的供应商性能宣称当作实物验证。

这 4 个新品处于相近起步阶段，均有完整相容的最近 30 天销量和当前评价观察；为排除算例中的隐藏口径问题，假设每个是独立且不混款的单一比较对象，销量、评分和曝光范围相容。它们符合正常起步参照所需证据只是合成前提，不说明实际资格标准、来源充分性和自动判断已验收；不能仅凭当前评价少或没有明显异常就确认正常起步。

本例采用已允许的当前观察口径，不是首次进榜时点：今天的累计评价数与最近 30 天的估算销量配对。这里的评价数指累计 ratings 数量，不是文字评论条数或星级。

| 新品 | 真实上市天数（合成） | 最近 30 天估算销量／件 | 当前累计评价数 | SIF 自然流量占比（其建模曝光口径） |
| --- | ---: | ---: | ---: | ---: |
| A | 70 | 100 | 10 | 70% |
| B | 65 | 80 | 20 | 35% |
| C | 75 | 40 | 30 | 85% |
| D | 60 | 20 | 40 | 90% |

四款新品合计 240 件；另外 16 款老品同窗口合计 1,360 件；20 款总计 1,600 件。老品逐条记录在真实流程中需要保存，本算例只汇总展示。所有销量都是为说明公式设定的数字，不是任何实际市场或后台订单数据。

### 3. 先算数量与销量的 5 分

- 数量项：4／20＝20%，按已定 20% 满分曲线得 **3／3**。
- 销量项：240／1,600＝15%，按已定 30% 满分曲线得 **1／2**。

这两个信号一起读：当前可比席位里新品不少，但新品只拿到 15% 的样本销量。不能从数量项满分推出新人普遍成功，也不能把宽榜原生占比直接替代 4／20。卖家精灵原生三个月占比应另带来源和口径展示，不重复加分。

### 4. 再算少评价销售表现的 4 分

脚本先使用整个合格参照组计算两个中位数，不先删掉 C、D：

- 销量从低到高：20、40、80、100；中位数 T＝(40＋80)／2＝**60 件**。
- 评价从低到高：10、20、30、40；中位数 M＝(20＋30)／2＝**25 评**。

每款先计算评价基础分 P：实际评价数量最多 3 分，加相对评价中位数最多 1 分；再与销售进展上限比较，取较低值。上限沿用已定曲线：销量为参照的 0% 到 50%，上限连续从 0 增到 3；50% 到 80%，从 3 增到 4；达到 80% 后最多 4 分。

| 新品 | 实际评价部分 | 相对评价部分 | 评价基础分 P | 销量相对 60 件参照 | 销售上限 | 完整单款试评分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 3 | 1 | 4 | 166.7% | 4 | 4 |
| B | 2.5 | 1 | 3.5 | 133.3% | 4 | 3.5 |
| C | 2 | 25／30≈0.833 | ≈2.833 | 66.7% | ≈3.556 | ≈2.833 |
| D | 1.5 | 25／40＝0.625 | 2.125 | 33.3% | 2 | 2 |

显示近似值仅方便阅读；计算使用未舍入的数，本例不决定正式界面的显示精度。A 既少评又达到销售参照，得 4 分；B 虽销量也够，但评价基础分只有 3.5，不被补成 4；C 取两者较低值，保留约 2.833；D 的销售上限将 2.125 限到 2。

现行已批准的方向汇总仍是：从达到参照 80% 销量条件、其余资格和证据齐备的样本中，选完整单款分最高的两款，取均值。本例资格池为 A、B，因此得到 **(4＋3.5)／2＝3.75／4**。C、D 的记录和单款分保留，也已经参与原参照中位数；不能为了抬高结果删除它们或改算中位数。

近期才补齐了低销量单款曲线。是否让 C、D 这样的较弱完整样本参与最后两例选取，仍是未批准的业务选择，不能借本算例暗中放宽。这个 3.75 表示观察到的少评价销售机会，不是所有新品的平均成绩或市场成功率。只有一个合格例子时，既有规则只保留单例证据，不能自动报完整方向 4 分。

### 5. 最后算同一对新品的自然可见度 1 分

沿用 A、B，不另外挑自然占比更高的 C、D：

- A：70%／70%＝**1 分**。
- B：35%／70%＝**0.5 分**。
- 本项：(1＋0.5)／2＝**0.75／1**。

两家工具的自然／广告词数用来交叉核对，不重复加分。例如 A 的 SIF 词数可以是自然 120、广告 80，卖家精灵是自然 110、广告 75；保留来源和日期，不能用 120／(120＋80)＝60% 去替代 SIF 的 70% 建模曝光占比。词覆盖和曝光权重不是一个量，词数也可能重叠。

对普通更新时间／覆盖差异不直接罚分；若期间、父子体范围或关键相关词证据存在足以影响可信度的未解冲突，受影响项待补证，不选更好看的来源或编平均数。这些具体充分性、冲突与单来源边界尚待试验和定义。自然曝光占比不能写成自然订单占比，当前高占比也不能单凭快照宣称自然流量持续增长。

### 6. 卡片最后展示什么

| 正常新品分项 | 本例试评分 |
| --- | ---: |
| 新品数量占比 | 3／3 |
| 新品销量占比 | 1／2 |
| 少评价销售表现 | 3.75／4 |
| 自然可见度 | 0.75／1 |
| 合计 | **8.50／10** |

卡片需要让主人回看：4／20、240／1,600、A 至 D 全部观察、为何选 A／B、为何可比和可作正常起步参照、来源与日期、规则版本和待核点。实际市场平均星级按既定规则只展示参考，不加入这 10 分。

8.50 是这些合成前提下的 Q31 部分成绩，不是商品的 100 分总分、置信度、进入成功率或投资建议。假设全部 20 款只卖 1,600 件，也仍需在需求、竞争和利润等各项判断价值。算术成立不说明这套权重和曲线已被真实市场校准。

### 7. 缺数或证据不够时，在哪停

| 情况 | 已定处理与限制 |
| --- | --- |
| 仅 B 的自然占比缺失，A 的 1 分和已选双样本资格仍成立 | 自然项实际分数留空，显示“待补证；条件可能范围 0.5—1”。另外三项支持的合计为 7.75，其对应权重为 9；不写完整 7.75／10、不折算满分、不取范围中点。若已知分数或选对资格也不可靠，该范围也不应展示 |
| 某款销量缺失或工具返回的零值含义不清 | 不当零销量；检查对销量占比、销量中位数及依赖分数的影响。不能悄悄用剩余样本冒充完整原样本。年龄／数量证据若仍完整，独立支持的数量项可以保留；完整缺证排序仍未定 |
| 找不到首次进 BSR 前 100 时的评价数 | 可采用已定、清楚标注的当前观察方式；不得将今天评价回填成进榜时评价，也不把两种观察基准混成一个参照 |
| 正常起步或可比性缺少关键证据 | 保留真实竞争和线索记录，不能冒充已核实的正常起步例子。受影响的资格、参照和分数待核，不给任意折扣或直接认定违规 |
| 评价中位数经核实确实为 0 | 保留既定例外：相对 1 分未评分，其余有据部分保留，不能拼成完整 4 分或自动满分 |

只有一个完整合格例子、没有选定双样本、来源缺失／实质冲突及部分结果怎么参与整体排序仍有未决边界。这里保留缺口，不宣布“缺数处理全部完成”，也不因无法报完整分数自动排除潜力方向。

### 8. 哪些验证成立，哪些还不成立

- 已确认的只是试评规则；本轮用独立算术复核了合成输入的总件数、中位数、单款分、原资格池与四项合计，没有实现评分应用。
- SIF 的两个原生入口曾为一个技术样本返回整体份额和词数。主人随后另行授权一个商品的补测，商品资料与销量列表也成功返回；其中销量档位与数值快照不同、上架日期与较早月历史有冲突、关联子体含不同尺寸、父体历史为空。这些说明估算可用但须按实际含义解释，不是正常新品样本、父体完整性或完整评分验收。真实返回与计费仅留在本机 `.local/reviews/20261112-sif-q31-field-*`。
- 指定卖家精灵连接的单次测试返回额度拒绝，未取得商品资料；不能由此声称榜单、历史评价和完整 30 天销量已经取得或永远不可得。本轮未重试、换连接或新增付费调用。
- 当前完整榜单和目标细分覆盖、历史与滚动窗口可得性、正常起步判断稳定性、来源冲突处理、真实卡质量、全流程运行和每天产量／耗时仍未验收。

后续把样本资格／汇总和缺证呈现作为成组业务问题打磨，常规取数、字段核查与实现由选品席负责。沿用“必要定义齐备后验证有限完整路径，再按授权用真实样本校准”的顺序；本例不要求主人再次确认已定公式。

## 已确认：当前占比计分，历史轨迹辅助

以下是合成例子，并假设榜单对应的正是拟做细分，以便只讨论时间口径：

- 最近一份完整 Best Sellers 前 100 快照中，有 12 款符合三个月新品定义。
- 一段明确观察期间，另有 18 款符合相应新品条件的商品曾经进榜，当前已不在榜。

当前新品占比是 12／100；不能直接把历史进入者加进去写成 30／100。期间曾进入多少款是另一种事件统计，分母和可观察机会须另定；退出不自动等于失败。

**主人已确认：数量项以当前明确日期的可比样本占比作为计分输入；历史进榜、留榜和退出按实际可观察范围辅助记录，找不全不妨碍保留已知记录。** 主人指出新品进出榜和市场变化是常见现象，因此退出本身不等于失败，老链接的稳定也不能据此变成对新品的额外处罚。12% 是合成样本的原始输入示例，不是门槛、得分或满分锚点。四项权重和所有未决映射保持不变。

随后明确的样本范围：在榜单混有多个细分时，本项先统计榜内可比商品；榜外商品保留用于竞争和销量研究及后续进榜观察。主人已在 2026-11-12 明确选择这一方向，不再重问榜内／榜外分母选择。实际节点、成员判定与未知处理仍待核实；后续答复已确认本项试评换分，真实样本校准另行进行。

保留用于说明的合成例子：假设样本已核实可比并去重，混合榜单前 100 中有 20 款属于目标细分，其中 3 款新品；榜外另外找到 30 款可比商品，其中 12 款新品。榜内同细分新品占比为 3／20＝15%；合并后的已观察可比样本占比为 15／50＝30%，两者不代表同一统计对象。主人先有条件接受榜内方向，要求解释分组可靠性，随后明确采用榜内范围。15% 当时只用于解释输入，不是分数批准；按之后明确确认的数量曲线，这一有效输入可试评为 2.25 分。选择榜内计分不建立榜外商品淘汰条件。

## 当前依赖：怎样划分可比市场、发现错分

主人重申优先观察进 BSR 榜的新品，正常起步越有可核对依据，参考价值越高。具体参考权重及其进入分项的方式仍待定义；没有发现异常不能直接认证白帽，不依据单个流量或评价信号贴黑帽标签。

已有原则保持：按用途与真实替代关系判断，颜色小变归组，实质不同的款式分别评分。以下是实施席解释这些原则的操作建议，尚未验证分组质量或形成新计分规则：

1. 先用一句话写明候选要满足的用途、必要功能和使用限制，再提取结构、材质、尺寸、容量、组合等证据。必要条件须来自有来源的需求，不能为了缩小竞争范围临时添加，也不能看完得分再修改分组边界。
2. 使用当前实际可获得的规格、产品图、说明及使用反馈；标明来源和对应款式。标题、同一个关键词、同一个类目都只能帮助找候选，不能单独证明可替代性。尺寸缺失、单位冲突或混合父体时保留缺口，不猜测。
3. 记录直接可比、非直接可比及待核项，并保留入组或不入组的具体理由。非直接可比者仍可能属于相邻竞争；待核项不能静默当作无关、老品或零。若待核项会影响比例解释，应明确其影响和未完成状态，不能展示假完整的市场结论；如何进入总分仍服从待定的缺证规则。
4. 脚本负责标识去重、单位换算、已定条件检查和计算；Codex 负责提取与解释实际替代关系，回到原始证据核验边界项。先用有限样本验证分组，记录错分和漏分，再谈吞吐；不能以模型自己声称高置信度代替验证。
5. 保存样本成员及证据版本。发现错分后修正归组，并重算依赖该样本的数量、销量、集中度等结果；不能只改说明文字，也不应通过临时改权重掩盖错分。

合成例子：研究“放在水槽下、需要绕管、能抽拉、适配目标柜体空间的收纳架”。只换黑白颜色沿用归组原则；放不进该空间、用途不同或缺少必要功能的产品不直接同组；尺寸或功能信息不明则待核。主人已确认金属和塑料等不同材质在用途、功能相近且买家确实会比较时，可属于同一竞争市场，但各自费用、风险与评分分开。若材质影响所需承重、耐用性，或者买家指定材质，不得硬合组。具体判断须找需求与商品证据，不能把“外形类似”或商家宣称当成实测性能。

当前尚无真实样本的错分率或自动判断验收证据。以上建议没有启动取数，也没有让主人承担日常逐款归组工作。

## 同时展示的观察与后续测试

主人要求同时展示卖家精灵原生三个月新品占比、榜内同细分的本地计算，以及实际观察到的历史进出榜记录。每项标明来源、节点／对象、日期或窗口、新品定义、样本量和覆盖；原生宽样本与同细分样本不共用分母、不平均成一个数，也不新增计分项。若原生接口实际返回近期销量排序样本，就照实命名，不能冒充当前 BSR 前 100。卖家精灵对“新品”的标记也不等于核实正常起步。

主人要求多来源佐证。实施上须区分独立来源、共用底层数据的多个视图，以及多个时点的可比观察：前两者涉及交叉核验，趋势还需要时间证据。不同来源发生冲突应解释对象、窗口和字段差异，不机械平均。单一可靠来源是否足以计分、需要多少覆盖仍待明确，不能暗填默认或为凑来源增加无边界请求。

分组的阶段安排、原生指标验证、错分／漏分检查、多来源与时间序列区别已加入 [第一版验收草案](FIRST-RELEASE.draft.md) 的 V1-12。这些是后续待执行检查，保留不完整历史也可以测试；本次没有执行实际选品或压力测试。

## 已解释执行分工，继续定义未决项

主人要求的执行路线已说明，并接受先明确必要定义、再试跑、按实际交付调整。2026-11-12 又确认具体阶段安排：初筛轻量归组，自动优先精筛核实比较样本，出卡前计算和评分，保留卡片后继续更深验证；AI 和脚本在两段中配合。具体路线与未验证能力见 [第一版流程](FIRST-RELEASE.draft.md)。当前榜内同细分占比、历史轨迹辅助及跨材质比较条件已回答；继续核实样本、观察窗口、正常起步参考处理、来源充分性与映射，不跳去选择浏览器或桌面形态，也不现在启动实际取数。每轮处理量、可用卡数、耗时和承载能力需要后续测试，不能由每页展示十个方向推定。

已知 ASIN 的历史排名查询，不等于枚举某节点所有曾进榜又退出的 ASIN；不能承诺补齐全部历史。可比细分先看买家的用途与真实替代关系，再看影响选择的结构、材质、尺寸、功能和组合；颜色归组，实质款式独立评分。AI 可提出并解释分组，脚本可检查标识、单位和计算一致性；都不能凭关键词相同就宣布可比，拿不到关键规格时保留待核。当前没有验证大规模自动分组质量或真实吞吐量。

主人先明确确认销量占比项以最近 30 天为主、近三个月辅助，随后确认销量项 15% 得 1 分／30% 满分，以及数量项 10% 得 1.5 分／20% 满分的连续试评曲线。实际数据可得性和效果仍需验证；多类目真实样本校准须同时检查过严与过松，不把分项低分变成未经批准的淘汰线。少数有据样本原则、3／4 分业务区别、两种中位数、80% 销售条件及实际／相对评价共同考虑已确认；正常样本和 Vine 回评假设更正、数据限制与后续验证项保留。实际数量各段、正中位数相对转换、BSR 主参照／新品榜补充及真实零中位数未评分例外均已确认用于试评。剩余定义清单已说明，主人要求加速继续；同细分市场的平均星级参考已确认；主人明确保留原 4 分，并暂不采用新提出的销量比例折算。缺入榜历史时单列当前观察参照已确认；该基础的最近 30 天与短历史处理已确认；两个较强完整合格样本取平均、单例保留证据的汇总规则已确认；当前继续自然可见度 1 分；多来源、近似判断及具体综合方法已确认；主人已确认自然流量占比 70% 满分、35% 得 0.5 分的单样本试评曲线及词数交叉核对作用；同一对合格新品的自然分平均已确认用于试评；缺一款数据时“待补证＋可能范围、实际分留空、不取中点”的辅助展示已确认；少评价项在销量为参照 50% 时最多 3 分的锚点已确认；50% 至 80% 之间上限从 3 连续增至 4 已确认；低于参照一半时 0—3 分连续上限及未知销量不补零也已确认；当前讨论是否让完整有据的较弱样本参与两例汇总，来源分歧与其他不完整样本处理仍需落实。较弱销售处理、参照成员与时点、证据充分性与误差、部分分数及跨基础比较仍待完成。记录设计不启动实际取数或正式工具开发。
