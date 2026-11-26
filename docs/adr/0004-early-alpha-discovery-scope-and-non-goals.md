---
status: accepted
date: 2026-11-26
---

# 0004: Early-Alpha Discovery Scope, Boutique Storefront Mining & Permanent Non-Goals

Focus 0→1 discovery on early-alpha channels that surface profitable evergreen forms before crowd saturation — adding Boutique Multi-Product Storefront Mining (`精铺反挖`: `5–50` parent listings, `>= 50%` active selling, storefront monthly revenue `>= $30,000`; single `<= 180d` `>= $30` launch with monthly revenue `>= $5,000` as initial trial baseline), Overseas Crowdfunding (`Kickstarter / Indiegogo` via Exa), SellerSprite ABA 6 Modes, and deepened Etsy/Reddit/low-star/FBM/flagship-accessory angles — while permanently rejecting TikTok, X (Twitter), Vine Month-2 tracking, and crowd-exposed public hot lists as primary channels.

## Considered Options

- **Integrate TikTok / TikTok Shop or X (Twitter) (rejected):** TikTok was explicitly rejected by the owner; X remains blocked by login/crawler walls.
- **Track Vine post-review Month-2 organic traction (`ss_vine_sustained_traction`) (rejected):** High verification cost and unreliable attribution.
- **Make Amazon Movers & Shakers or 1688 Cross-Border Hot New rankings primary 0→1 engines (rejected):** Products on public surging lists are already widely visible, eroding margin windows.
- **Cap qualifying cards per batch to a small number (rejected):** Passing yield is uncapped (`10`, `20`, `30`, `50+` cards routed through 50%-discount `Batch API` as needed), while operational rollout prioritizes stabilizing a clean 10-card end-to-end flow before scaling live runs to `20/30/50+` cards after Stage 6 / Pause Point 2.
- **Build a heavy shared-Buy-Box revenue-splitting attribution engine or blind control-group system for front-end storefront mining (rejected):** Over-engineered for a front-end lead-sourcing entry; paginating full parent counts, excluding multi-thousand-ASIN mass listers, and flagging truncated catalogs or ambiguous shared Buy Box storefronts as `"待核"` is sufficient.

## Consequences

- `ss_vine_sustained_traction` will be retired from active discovery planning; `tiktok` and `x_twitter` remain explicitly excluded in `docs/SPEC.md` and `src/discovery-channels.mjs`.
- Boutique storefront thresholds (`5–50` parent listings, `>= 50%` active selling, `>= $30,000` store revenue, `<= 180d >= $30` launch `>= $5,000`) are **owner-confirmed (2026-11-26) as a first-round observational trial baseline** — NOT hardcoded as a global hard kill line — with lightweight `"待核"` flagging for incomplete pagination or ambiguous shared-Buy-Box attribution, to be calibrated after the first live run.
