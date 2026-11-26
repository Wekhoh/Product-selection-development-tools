---
status: accepted
date: 2026-11-26
---

# 0002: Screen 1688 Initial Quotes on Bare-Goods Price Without a Domestic Freight Table

Initial product screening and 1688 cost-to-floor-price checks use 1688's `100`-set regular repeat-order **bare-goods price (`裸货价`)** without gating the `30%` margin floor on volatile 1688 page domestic shipping templates, and without building a domestic China LTL rate table or invented `¥2.5/¥3/kg` cutoffs.

## Considered Options

- **Gate 30% margin on `goods + 1688 page domestic freight` (rejected):** 1688 sellers routinely attach small-parcel express templates to bulk listings (causing multi-fold quoted-freight distortion on the same bulk item), triggering false eliminations and extra browser address/quantity interactions that provoke 1688 sliders, whereas typical 100-set domestic LTL freight on ordinary goods accounts for only `~0.5%–1.5%` of retail price.
- **Maintain a custom China domestic LTL rate table or fixed `¥2.5–¥3.0/kg` cap (rejected):** Cannot generalize reliably across heavy, bulky, and volumetric categories without endless unconfirmed thresholds.

## Consequences

- Cards and 1688 floor-price outputs MUST display `"当前按 1688 裸货价算，未含国内到深圳运费（常规约占 0.5%～1.5%，超大超重抛货拿样下单前实询）"`.
- Visible free-shipping or reasonable page freight may be recorded as advisory reference metadata, never blocking margin or scoring; prior Issue `#4` (closed on `f112890` under the previous landed-freight gate) is superseded by bare-goods initial screening.
- The `~0.5%–1.5%` omitted domestic freight is transparently disclosed on every card and verified directly with factories before sampling or bulk orders (never assumed automatically offset by international ocean headhaul).
