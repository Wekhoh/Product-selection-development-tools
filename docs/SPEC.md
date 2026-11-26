# Active Business Specification & Workflow Blueprint (`Revision 59+`)

Updated: 2026-11-26. This is the single active business and workflow specification for the US Amazon FBA product-selection engine. For causal history see [DECISIONS.md](design/DECISIONS.md); for domain vocabulary see [GLOSSARY.md](../GLOSSARY.md); for irreversible architectural tradeoffs see [docs/adr/](adr/0001-decouple-steady-state-freight-from-100-set-sourcing.md); for live task state and recovery see [STATE.md](STATE.md).

## 1. Outcome & Immutable Red Lines

Proactively discover, screen, evaluate, and rank high-margin evergreen US Amazon FBA product forms for a curated multi-product (`精铺`) business, delivering inspectable Chinese Curatorial Studio (`01 视觉策展室`) selection cards without artificial batch caps (`10`, `20`, `30`, `50+` qualifying cards as yield allows). Operational rollout prioritizes stabilizing a clean, accurate **10-card end-to-end workflow** first before opening live `20/30/50+` Batch waves at Pause Point 2 (Stage 6).

### Immutable Red Lines (Never Alter Without Explicit Owner Re-Approval)
1. **Scoring system intact:** All 21 scoring item weights, anchor curves, 100-point budget (`docs/design/reference-profile.r59.draft.json`), and the 15-point 3-tier USD suggested-bid scheme remain byte-for-byte untouched. Full score is always **100 points**; post-sample items (`15` pts) stay honestly `null` only when unverified before sampling, and the shared **85-point objective core** (`core_85_range`) exists strictly to rank complete and `sample_pending_qualifying` cards fairly.
2. **Veteran age floor intact:** Mature veteran listings require **`>= 365` days** (1 full year) on Amazon US. The 90-day dated Keepa window validates recent price steadiness on those `>= 365d` veterans; it never lowers the veteran age threshold to 90 days.
3. **Strictly 4 hard kill lines:**
   - ① Matched-spec reference price `>= $29.99`;
   - ② Single-factory complete-kit refund-adjusted pre-ad margin upper bound `>= 30%`;
   - ③ CPSC/CPSIA statutory `<= 12y` children's product (retaining adult-installed storage/nursery-shelf exemptions) or proven IP infringement;
   - ④ Strong date/holiday dependency (items that turn into dead stock after a specific date/year/holiday, e.g., `"2027 calendar"`, `"Christmas ornament"` — never ordinary year-round evergreen goods).
4. **Zero AI-invented business thresholds:** Every cutoff number (days, percentages, multiples, millimeters, USD/CNY rates) MUST be owner-confirmed and registered in `src/business-thresholds.mjs` with `confirmed_at` and `provenance` (enforced by `test/business-thresholds.test.mjs`).
5. **Zero autonomous store writes:** All Amazon Seller Central / Ads write actions remain strictly prohibited without per-item owner approval, and browsers never open authenticated Amazon seller/ads consoles.

---

## 2. Explicit Non-Goals & Rejected Alternatives (`已否决 / 不做清单`)

Never re-propose or re-implement any item below unless the owner explicitly reopens it:

1. **No TikTok / TikTok Shop integration:** Explicitly rejected by the owner; permanently excluded from discovery channels and batch planners.
2. **No X (Twitter) integration:** Permanently deferred (`active: false`) due to login-wall/crawler restrictions.
3. **No Vine Month-2 sustained-traction channel (`ss_vine_sustained_traction`):** Too costly and unreliable to verify; retire from active discovery registry.
4. **No reliance on public crowd lists as primary 0→1 discovery:** Do not treat Amazon public Movers & Shakers or 1688 Cross-Border Hot New Product rankings as primary discovery engines (once a product hits public hot lists, margin/competition window is typically late).
5. **No separate cloud-hosted OpenAI Platform Agent:** OpenAI visual `Agent Builder` sunsets `2026-11-30`, and cloud agents cannot access local authenticated browsers (1688/Reddit/Pinterest/Etsy), local SellerSprite/SIF/SP-API MCPs, local Kaiqi freight tariffs, or SQLite ledgers. Keep all orchestration local.
6. **Never reverse-solve domestic procurement caps from Amazon competitor prices to pre-screen/eliminate candidates:** Competitor prices fluctuate due to launch losses, coupons, and clearance. Code lock remains permanent. (The separate forward calculator from an existing 1688 quote to minimum 30%-margin Amazon price is renamed **"按 1688 成本算保底定价"** to prevent confusion.)
7. **No domestic China logistics rate table and no invented `¥2.5/kg` or `¥3/kg` domestic-freight cutoff:** Cross-category domestic parcel/LTL pricing cannot be generalized safely without endless rule bloat; initial screening uses 1688 bare-goods cost instead.
8. **No feature bloat, over-defensive infrastructure, or low-ROI AI gimmicks:** Do not add Capital ROI projections, multi-tier TACoS tables, multi-marketplace abstractions (US only), 30-day 1688 quote expiry nags (`expires_at: null`), cross-factory split-kit acceptance as ready-stock complete kits, forced per-batch category-dispersion quotas, spring/summer seasonal hard rules, `< 90d > 100`-review hard kills, AI voice/TTS briefings, autonomous AI 1688 messaging/haggling (account ban risk), indiscriminate concept-image generation on every card, heavy shared-Buy-Box revenue-splitting attribution engines or blind control-group systems for front-end storefront lead mining, complex event-sourcing architectures for calibration tracking (`#9` stays flat fields), or extreme hypothetical local defenses (JS prototype/`Proxy` tampering, disk hardlink races, or nuclear settlement locks duplicating platform `$200` hard cap + `Auto-recharge OFF`).

---

## 3. Unit Economics, 2027 FBA & Sourcing Specification

### 3.1 Decoupled Steady-State Replenishment vs. 100-Set Sourcing ([ADR-0001](adr/0001-decouple-steady-state-freight-from-100-set-sourcing.md))
Formal pre-ad margin models **steady-state profitable replenishment** (ocean slow-boat sea-truck, controlled stock, `>= 5` identical cartons qualifying for `$0` Amazon-optimized inbound placement), NOT small test-batch air/under-5-carton shipping:

- **1688 procurement unit basis (conservative anchor):** Regular non-first-order repeat-order quote for `order_units >= 100` complete saleable sets (retaining `sku_lines[]` carton/MOQ integer math). `100` sets anchors conservative wholesale unit price; it NO LONGER blocks steady-state `>= 5` carton placement eligibility.
- **Inbound placement fee (`amazon_optimized` default):** **`$0.00`** on Standard, Bulky, and Oversize steady-state primary margin scenarios (paired mandatory with the nationwide multi-warehouse sea-truck rate below — never paired with pure US-West single-warehouse `¥8.48/kg`).
- **Ocean headhaul rate (Kaiqi nationwide multi-warehouse sea-truck):**
  - Owner-confirmed base rate (2026-11-26, derived from Kaiqi 2026-10-19 SVIP tariff: Guangdong origin, 50KG+ tax-included sea-truck, US-West `ONT8/LGB8` `¥8.48/kg`, US-Central `HOU` `¥9.98` / `MDW2` `¥10.48` / up to `MCI4` `¥12.48/kg`, US-East `TEB` `¥9.98` / `JAX/CLT` `¥10.38` / up to `MCO2/TPA` `¥12.88/kg`): **`¥10.0/kg`** before `+¥1/kg` carrier bond and applicable material surcharges (`¥11.0/kg` with bond before material surcharge).
  - Real-world variance note: Even when shipment plans refresh into `3 US-West + 1 Central + 1 East`, blended cost varies by assigned warehouse (`~¥9.08–¥9.30/kg` on cheaper hubs vs `¥10.16/kg` before bond on pricier `MCI4 + MCO2/TPA` hubs). Treat `¥10.0/kg` as a pragmatic screening estimate — not a guaranteed buffer — and verify actual destination rates and carton weights before real replenishment.
  - **Origin unification:** All initial screening unifies on Guangdong/Shenzhen consolidation hub (`广东深圳`).
  - **Small-shipment (`< 50 kg`) & small-carton (`< 8 kg`) penalties:** Removed from penalizing steady-state primary margin solely because a `100`-set test order splits into `< 50 kg` per warehouse or `< 8 kg/carton`. Because `>= 5` cartons alone neither guarantees `>= 50 kg` per destination warehouse nor guarantees Amazon offers a free placement option, surface the replenishment quantity needed to reach `50 kg+` per destination as an advisory note for ultra-light or slow-moving SKUs. Still enforce exact `weight_per_carton_kg * carton_count` vs volumetric weight (`L*W*H/6000`) when carton weight and count are provided (GitHub Issue `#5`).
- **2027 FBA schedules & windows (unchanged):**
  - Default off-peak fulfillment/sales window: `2027-02-01..2027-10-14`; independent off-peak storage window: `2027-02-01..2027-09-30`; unpublished Q4 peak (`2027-10-15..2028-01-14`) stays explicitly `null`/blank (`"待亚马逊公布 2027 旺季费率后补充"`).
  - Standard and Bulky default to non-SIPP (merging `round(base * 1.035) + $1.51–$4.04` Bulky packaging fee).
  - Ongoing coupons evaluate FBA tier (`$10 / $50`) on `list_price_usd` and deduct `$5/100 + 2.5%` coupon fees; `< 20% OFF` routine coupons use post-coupon net price while `>= 20% OFF` heavy coupons isolate pre-coupon distortion.
  - `<= 10 mm` single-side compression crossing an official 2027 FBA tier to `>= 30%` routes to `packaging_redesign_shortlist` (`"改包装可救提醒池"`).
  - Pre-finalist read-only SP-API calibration (`catalogItems`, `productFees`, `listingsRestrictions`) remains primary before final profit lock.

### 3.2 Bare-Goods 1688 Initial Screening ([ADR-0002](adr/0002-bare-goods-initial-sourcing-without-domestic-freight-table.md))
- **Initial margin & 30% kill-line basis:** Uses **1688 100-set regular repeat-order bare-goods price (`裸货价`)** only. Volatile 1688 page domestic express templates are NOT required to pass the 30% floor and never pause or kill scoring.
- **Mandatory transparent disclosure:** Every card and 1688 cost-to-floor-price readout explicitly displays:
  > `"当前按 1688 裸货价算，未含国内到深圳运费（常规约占 0.5%～1.5%，超大超重抛货拿样下单前实询）"`
- **Optional freight note:** If free shipping (`包邮`) or a normal domestic freight figure is visible on the page, store it strictly as advisory reference metadata without gating margin or pausing scoring.
- **Calculator rename:** Rename user-facing `reverse-1688` descriptions to **"按 1688 成本算保底定价"** (1688 bare-goods cost -> minimum US selling price for 30% steady-state margin).

### 3.3 1688 Multi-Factory Sourcing & Two-Stage AI Vision Guardrails
- **Factory-count boundary:**
  - **AI automated browsing:** Keeps the **`1–3` valid complete-kit distinct `factory_id`** limit (stop immediately after the 1st reliable complete-kit factory clears `>= 30%` across the full margin interval to prevent 1688 sliders; check a cheaper 2nd, at most 3rd, if crossing or `< 30%`; clicked listings discovered to be wrong material, bare parts, or incomplete kits are tagged `rejected_spec` / `incomplete_cross_factory_kit` and do NOT consume the 3-factory quota).
  - **Manual owner override (`manual_owner_entry: true`):** Explicitly permitted to append/supersede a 4th+ cheaper complete-kit source factory discovered by the owner (never blocked by the AI anti-slider cap).
  - **Single-factory complete-kit parity (GitHub Issue `#6`):** Both `store.mjs` and standalone `scoreBatch` share the exact same single-factory complete-kit check.
- **Stage 1 — 1688 search-page triage (`POST /v1/decisions`, `gpt-6-luna`):**
  - After loading a 1688 search result page (`以图搜款` + keyword), bundle 20–40 visible candidates (contact-sheet thumbnails + title + price + MOQ) into one `Decision API` call to demote/skip obvious bare parts, plastic lookalikes, completely different forms, or overpriced resellers, ranking the top 1–3 complete-kit source factories to open.
  - **Strict guardrail:** `Luna` ONLY ranks and filters individual 1688 offers on the search page; it NEVER rejects or eliminates the candidate product itself.
- **Stage 2 — 1688 detail-page spec verification (`POST /v1/responses`, `gpt-6.1-terra`):**
  - Every opened 1–3 candidate factory detail page routes high-resolution SKU images, mm-dimension drawings, material callouts, and accessory lists to `gpt-6.1-terra` to block spec mismatches (e.g., walnut vs ABS wood-grain, missing pouches/boxes, incompatible slot diameters).

### 3.4 Written-Review Origin Classification (Owner Confirmed 2026-11-26)
- **Written reviews only:** Newcomer review-origin sampling (`Q31`) inspects **written text reviews only**; star-only ratings without review text are not sampled and remain separate from the listing's total rating count.
- **Strictly 3 categories on complete provider records:** Using native provider fields (including SellerSprite `reviews[]` with `vine` and `purchased` booleans), every complete written review maps to one of **3 categories**:
  1. **`Vine`** (`vine === true`);
  2. **`VP`** (Verified Purchase: `purchased === true` / `verified_purchase === true`);
  3. **`直评`** (unverified direct review: neither Vine nor VP, i.e., `vine === false && purchased === false`).
- **Card display & missing-field boundary:** Display `"抽查 N 篇文字评：Vine X · VP Y · 直评 Z"` with explicit sample scope/denominator. Reserve `"来源字段缺失"` strictly for cases where the upstream provider payload genuinely omits origin flags — never misclassify normal unverified direct reviews (`直评`) as unknown origin.

---

## 4. 0→1 Discovery Channels, 4-Step Uncapped Funnel & AI Routing ([ADR-0003](adr/0003-local-multimodel-orchestration-and-luna-non-overreach.md), [ADR-0004](adr/0004-early-alpha-discovery-scope-and-non-goals.md))

### 4.1 Active 0→1 Discovery Channels
All active channels feed ONE deduplicated SQLite `raw_leads` / `candidate_forms` pool (cross-channel hits boost priority via `track_a_resonance`, never duplicate cards):

1. **Boutique Multi-Product Storefront Mining (`ss_boutique_storefront_mining` / 精铺反挖 — Confirmed 2026-11-26 First-Round Observational Trial Baseline):**
   - Powered by native SellerSprite `asin_list` (`searchType: SELLER` / `sellerInclude` / `brandInclude` + `bestSellingVariant: true`) + SIF traffic verification.
   - **Layer 1 (Storefront health — excludes mega-catalog drop/mass listers):** `5–50` parent listings + `>= 50%` active selling listings + storefront monthly revenue **`>= $30,000`**.
   - **Layer 2 (Single recent breakout launch — cross-category revenue yardstick):** Launched within **`<= 180` days**, price **`>= $30`**, single-listing monthly revenue **`>= $5,000`** (excluding old-review merges; organic share verified via SIF).
   - **Trial-baseline & lightweight denominator rule (NO heavy attribution system):** Treat these numbers strictly as a **first-round observational trial baseline** (never hardcoded as a global hard kill line; calibrate after observing real output from the first trial round). Keep denominator anti-distortion lightweight: paginate to obtain full parent counts, exclude multi-thousand-ASIN mass-listing stores, and flag storefronts with incomplete pagination or ambiguous multi-seller shared Buy Box attribution as **`"待核"`** for owner review — explicitly rejecting heavy shared-Buy-Box revenue-splitting engines or blind control-group comparison systems.
2. **Overseas Crowdfunding Early Signals (`crowdfunding_kickstarter_indiegogo`):**
   - Powered by existing Exa search (`site:kickstarter.com`, `site:indiegogo.com`), focusing on funded early-bird physical concepts with simple mechanics suitable for non-infringing companion accessories or original light differentiation.
3. **SellerSprite ABA 6-Mode Keyword Screen (`ss_aba_six_modes`):**
   - Native `keyword_aba_list` (`searchModel 1..6`) combined with `titleDensity` and `monopolyClickRate` as a reference discovery input.
4. **Early-Alpha Non-Crowd Angles (Existing Tools Deepened):**
   - **Etsy handmade high-ticket (`$50–$120`) -> industrial improved substitute** (avoiding design patents/artwork, improving durability/packaging);
   - **Reddit & vertical hobbyist forum complaint / dupe requests** (woodworking, miniatures, espresso, gardening, camping, sewing, equestrian, pet training);
   - **Amazon incumbent supply-gap screens**: `3.4–4.1★` low-rating high-sales (`>= $35`) and high-ticket FBM/low-LQS mismatches;
   - **Flagship ecosystem companion accessories / dedicated organizers / protective cases** (`$30–$60`, riding non-brand functional demand around popular mainstream gear);
   - **1688 source factory cold-start** (for novel items with parent-functional proxy bidding when no US term exists yet).

### 4.2 4-Step Uncapped Closed-Loop Workflow & OpenAI `$200/month` API Routing
Monthly `$200` API credits expire at cycle end without rollover; deploy them wherever marginal ROI is strictly positive while keeping `$0`-API deterministic code in charge of all arithmetic and gates. Discovery and browser sourcing operate as **agent-driven semi-automated collaboration** (the CLI validates, schedules, scores, and persists; it is NOT an unattended headless crawler), and user-facing card labels prefer plain Chinese **`"1688 问厂"`** over `"旺旺"` (migrated in Stage 5 while keeping the internal key `wangwang_questions` backwards-compatible). All 4 embedded API points slot into the existing 4 steps with zero extra pipeline phases and `$0` spend on eliminated candidates:

| Step | Responsibility | Engine / Model | Strict Boundary & Acceptance Check |
| --- | --- | --- | --- |
| **Step 0 — Multi-Channel Discovery & Embedded Seed Expansion (`发现进水`)** | Pull raw signals across active channels (Boutique Storefront Mining, Crowdfunding, Etsy, Reddit, ABA 6 Modes, low-star/FBM supply gaps, 1688 cold-start) into one deduplicated SQLite pool with cross-channel resonance. **Embedded Point ① (Batch 2 / Stage 7):** immediately *after* reading raw Reddit/Etsy/crowdfunding threads (`SocialBridgeExtractor`) and *before* SellerSprite/SIF keyword demand lookup, expand idiomatic native-English long-tail pain-point phrases and flagship companion-accessory phrases. | SellerSprite / SIF / Exa / Authenticated Browser + `POST /v1/responses` (`gpt-6.1-terra` for ①) + deterministic SQLite | Zero invented demand numbers; preserve origin URL/receipt; `CAPTCHA_PAUSED` immediate stop on login/slider walls; every ①-expanded phrase still enters real SellerSprite/SIF verification and strictly separates host demand from accessory demand. |
| **Step 1 — Red-Line Triage, Mature Price Band & 1688 Bare-Goods 30% Gate (`快筛 + 1688 算账`)** | (a) Bulk-screen leads & peer contact sheets with `Luna` red-line triage; (b) build 3-tier listing-age price band (`<= 90d` newcomer / `>= 365d` dated-90d Keepa-steady veteran / `91–364d` supplement only if `< 2` veterans) + pre-finalist read-only SP-API calibration; (c) rank 20–40 1688 search-page offers via `Luna` + verify 1–3 opened factory detail pages via `Terra` HD vision; (d) calculate deterministic `30%` steady-state bare-goods + Kaiqi `¥10.0/kg` (`placement=$0`) margin gate. | `POST /v1/decisions` (`gpt-6-luna`, no `reasoning` param) + `POST /v1/responses` (`gpt-6.1-terra` detail vision) + deterministic Node.js 24 ESM (`src/rates/`, `src/fba-calculator.mjs`, `src/economics.mjs`, `src/adapters/keepa.mjs`) | **`Luna` non-overreach iron rule:** ONLY hard-filters undisputed statutory `<= 12y` children's products (preserving adult-storage exemptions) and strict year/holiday-dated disposables (ordinary apparel & generic phone-case/cable leads may be skipped at discovery intake with logged skip reasons, never turned into a 5th global hard kill line). **NEVER** rejects powered/electronic items, uncertain niches, suspected patents, or whole product candidates on 1688 search pages — must pass through as `needs_review`. **Uncapped yield:** EVERY product clearing the 4 hard kill lines (`10`, `20`, `30`, `50+`) proceeds to Step 2. |
| **Step 2 — Uncapped Deep Mining, Patent Pre-Screen & 21-Item Scoring (`过关品满配深挖`)** | (a) Deep review + Q&A + main-image/A+ + Reddit pain-point mining including **Embedded Point ② (Batch 1 / Stage 5): True Return-Cause Diagnosis** (binding verbatim quotes to variants, separating fixable listing/manual/packaging opportunities vs structural-defect traps, marking missing Q&A text honestly when only counts exist, never back-calculating refund rates); (b) uncapped web-search US patent/compliance pre-screening with **Embedded Point ④ (On-Demand / Stage 7): Design-Patent Drawing (`USD...`) vs. 1688 Photo HD Visual Lookalike Check** ONLY when an actual patent drawing is obtained (`$0` otherwise; initial screening alert only, legal counsel required before bulk orders); (c) deterministic 21-item scoring (100-pt full, 85-pt objective core rank). | `POST /v1/responses` + **50%-discount `POST /v1/batches`** (`gpt-6.1-terra`, `effort: "xhigh"`) + deterministic `src/scoring.mjs` | Use 50%-discount Batch API for `20/30/50`-card waves after Pause Point 2; `Terra` never alters deterministic scores; `$200` natural-month realized spend cap, `max_retries = 0`, PII/secret redaction. |
| **Step 3 — Qualifying-Card Audit, 1688 Inquiry Prep & HTML Card Delivery (`入围卡交付与拿样衔接`)** | (a) Gate-4 independent evidence audit strictly on qualifying cards (`counts_toward_target === true`); (b) **Embedded Point ③ (Batch 1 / Stage 5): Copy-Paste Chinese 1688 Factory Inquiry & Sample Checklist** (5 concrete plain-Chinese bullets reusing `wangwang_questions` — covering `100/300 套发深圳实际含运价格与大货交期`, spec/material/packaging confirmation, return-cause fixes, `<= 10 mm` rescue if triggered, and post-sample gaps — generated automatically on qualifying cards and also runnable on demand for owner-picked 3–5 cards, displayed below `"拿样／1688 问厂待核清单"` strictly for manual owner copy-paste); (c) render deduplicated offline Curatorial Studio HTML report (`http://127.0.0.1:<port>/...`). | Local subscription `Codex CLI` (`gpt-6.2-astra`, default speed + `max`, `$0` API spend) + `gpt-6.1-terra` (for ③) + deterministic `src/report.mjs` | `Astra` never mutates deterministic scores (confirmed disputes trigger deterministic recomputation); **AI NEVER sends messages to 1688 factories**; Gate-4 runs strictly on qualifying cards (`counts_toward_target === true`). |

**Confirmed phased rollout order for the 4 embedded OpenAI API points (2026-11-26):**
- **Batch 1 (Stage 5):** **② True Return-Cause Diagnosis** (variant-bound verbatim quotes, honest missing-Q&A disclosure, zero refund-rate back-calculation) + **③ Copy-Paste Chinese 1688 Factory Inquiry & Sample Checklist** (5 concrete bullets including `100/300 套发深圳实际含运价格与大货交期`, automatic on qualifying cards and on-demand for owner-picked 3–5 cards; AI NEVER messages suppliers).
- **Batch 2 (Stage 7):** **① Native-English Pain-Point & Flagship Ecosystem Parasite Keyword Expansion** in Step 0 (separating host vs. accessory terms; every expanded phrase verified via SellerSprite/SIF).
- **On-Demand (Stage 7):** **④ Design-Patent Line-Drawing (`USD...`) vs. 1688 Physical Photo Visual Lookalike Comparison** in Step 2 — triggered strictly on demand when real patent drawings are obtained (initial screening alert only).

---

## 5. Engineering Workflow, Three-Tier Independent Ruling Gate & 7-Stage Delivery Roadmap

Every iteration follows the closed-loop **Matt Pocock + Poteto + `GPT-6.2` Dual-Review + Three-Tier Independent Ruling Gate + GitHub** workflow:

1. **Living docs first:** Update `docs/SPEC.md`, `GLOSSARY.md`, and `docs/adr/` immediately when a decision crystallizes; keep `docs/STATE.md` + GitHub Issues as the sole task/status source (zero parallel drift-prone TODO files).
2. **Pre-implementation full-scope blueprint review (`GPT-6.2 Astra`):** Before opening implementation issues or editing code on major changes, feed full project context, `docs/SPEC.md`, `docs/adr/`, current source code, real test artifacts, open GitHub Issues, and raw conversation transcripts to local subscription `gpt-6.2-astra` (default speed + `max`, `$0` API spend) to audit business-logic coherence, edge-case contradictions, missed owner confirmations/rejections, and test-design efficacy. Align findings with the owner first.
3. **Vertical Tracer Bullet GitHub Issues:** Split approved changes into end-to-end testable GitHub Issues declaring prerequisites, owner checkpoints, and observable acceptance criteria (integrating remaining verified open issues `#5`–`#12` and revised Draft PR `#13` cleanly).
4. **Per-issue Branch -> TDD -> Poteto Ratchet -> Dual-Axis Review -> Three-Tier Independent Ruling -> Standard PR -> Auto-Close:**
   - One branch per issue (`git checkout -b ...`);
   - Write failing acceptance/regression tests first (Red -> Green -> Refactor);
   - Apply Poteto priority: (1) structural/interface prevention > (2) deterministic guard test with fix instructions (ratcheting legacy debt down only) > (3) minimal prose only if unavoidable, deleting prose once guarded;
   - Run fresh-context `gpt-6.2-astra` **Standards + Spec** dual-axis review (default speed + `max`, `$0` API spend, direct raw file paths);
   - **Mandatory Three-Tier Independent Ruling Gate (anti-bloat discipline):** BEFORE editing code after any `GPT-6.2` review, the primary agent MUST independently label every finding from first principles of a single-person local Amazon FBA tool with a one-sentence reason:
     - **`[采纳 · 真问题]`** — real money/margin miscalculation, blue-ocean false kill, missed IP/counterfeit conflict, real API payload crash, or PII/secret leak -> fix cleanly at the structural seam;
     - **`[极简修]`** — genuine issue with an over-heavy GPT proposal -> apply the simplest adequate fix without building extra subsystems;
     - **`[驳回 · 过度防御]`** — extreme hypothetical absent from a single-person local tool (in-process JS prototype/`Proxy` tampering, disk hardlink races, imaginary attackers, nuclear local settlement locks duplicating platform `$200` hard cap + `Auto-recharge OFF`, heavy front-end attribution engines, or redundant tests) -> reject explicitly with rationale and add zero defensive lines; escalate genuine uncertainty to `主人` with one-sentence pros/cons;
   - Open PR using Matt's `Summary / Before-After Evidence / Merge Danger (Door + Blast Radius)` template (`.github/PULL_REQUEST_TEMPLATE.md`) with `Closes #<id>`, verify green GitHub Actions CI, and merge cleanly.
5. **Sustained disciplined slimming & post-stage `retro`:** Never halt work for a full-repo rewrite or arbitrary `%`-deletion quotas; instead, clean verified over-defensive bloat cleanly alongside feature stages (checking callers & tests first, keeping `node --test` 100% green), capture `retro` lessons into automated guards, and refresh `docs/STATE.md`.

### Confirmed 7-Stage Execution Roadmap & Mandatory Pause Points (2026-11-26)
- **Prep:** Commit & merge living docs (including Three-Tier Independent Ruling Gate) onto `main`.
- **Stage 1 (parallelizable):** `#12` (clean Keepa public test real fingerprints), `#10` (consolidate 2027 apparel returns fee into single annual table), revise Draft PR `#13` (SellerSprite `reviews[]` + `purchased`, written reviews only, 3-way `Vine / VP / 直评`, verified `3 / 50 / 2` on 3 local raw bundles -> merge & close `#7`).
- **Stage 2 (unit economics + dead-branch trim):** `#5` (carton weight × carton count) + new issue for 100-set bare-goods + steady-state `>= 5` cartons `$0` placement + Kaiqi `¥10.0/kg` multi-warehouse (blocking pure US-West `¥8.48` + `$0` placement) + rename `"按 1688 成本算保底定价"` + bare-goods disclosure; trim adjacent residual `r50–r58 / isR58` dead branches in `fba-calculator.mjs` / `economics.mjs`.
- **Stage 3 (sourcing parity + anti-false-kill + dead-branch trim):** `#6` (unified single-factory complete-kit across store & `scoreBatch`, remove auto `owner_crossing_override` on 30%-crossing intervals, allow manual owner `4th+` factory entry) + new issue for 1688 search-page 20–40 offers `Luna` ranking (fixing `"Baby Grand Piano Cover"` / `"Nursery Plant Pots"` false kills + `Luna` non-overreach) + detail-page `Terra` HD vision; trim adjacent legacy dead branches in `scoring.mjs` / `pipeline.mjs`.
- **Stage 4 (steady pricing + real dispute revocation):** `#11` (read mature-peer count threshold from registry) + new issue for `>= 365d` dated-90d Keepa + SP-API official package calibration + `#8` (revoke confirmed wrong-item scenario from independent review and recompute margin & qualifying count).
  - **【Pause Point 1】** Stop after Stage 4 merges: replay the real local benchmark candidates archived under `.local/` through the new-rule ledger and confirm with `主人` before continuing.
- **Stage 5 (useful qualifying cards + minimal calibration):** new issue for **② True Return-Cause Diagnosis** + **③ 1688 Chinese Inquiry Checklist** (`"1688 问厂"` UI label); `#9` minimal fix (`[极简修]`: split `"系统建议 / 主人确认决定 / 样品实测"` flat fields in existing table — NO event sourcing).
- **Stage 6 (scale-up loop + major `src/openai/` & `phase2-cli.mjs` slimming):** wire `daily-batch` to real executors, fix Batch upload param mismatch + minimal reliable disconnect recovery (save `batch_id`, merge success/error by `custom_id`, invalidate old scores on quote/fee-table changes), fix 50-card HTML shared-image deduplication & thumbnails; systematically trim over-defensive bloat from `src/openai/{budget-ledger,client,codex-runner}.mjs` and split monolithic `src/phase2-cli.mjs` by subcommand while strictly preserving the 5 core guardrails (**natural-month `$200` realized spend ceiling + `0` retries on billable POST + PII/secret redaction + paid Astra blocked + `codex exec` local subscription `$0` API spend**).
  - **【Pause Point 2】** Stop after Stage 6 end-to-end new-lead verification & offline 50-card stress test: report slimming & stress-test results to `主人` and wait for approval before activating live data & paid Batch scale-up (stabilizing the clean 10-card workflow first before scaling to 20/30/50+ live waves).
- **Stage 7 (0→1 discovery expansion + on-demand patent comparison):** formally retire rejected `ss_vine_sustained_traction` (Vine Month-2) first, then advance Boutique Storefront Mining (`精铺反挖`), ABA 6 Modes, Crowdfunding + **①**, and on-demand **④**.
