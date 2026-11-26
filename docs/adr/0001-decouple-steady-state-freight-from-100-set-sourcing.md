---
status: accepted
date: 2026-11-26
---

# 0001: Decouple Steady-State Multi-Warehouse Ocean Freight From 100-Set Sourcing

Formal pre-ad margin evaluates profitable steady-state replenishment (`>= 5` identical cartons qualifying for `$0` Amazon-optimized inbound placement) paired with Kaiqi's nationwide multi-warehouse sea-truck base rate (`¥10.0/kg`, Guangdong origin, 50KG+ tax-included, before `+¥1/kg` carrier bond and material surcharges), rather than coupling placement eligibility or `< 50 kg` / `< 8 kg` test-batch penalties to the `100`-set 1688 wholesale quote quantity.

## Considered Options

- **Keep 100-set carton count coupled to `$0` placement (rejected):** Many Standard-size items pack 20–50 units/carton (`2–4` cartons per 100 sets), falsely penalizing steady-state margin with single-warehouse placement fees and `< 50 kg` small-shipment surcharges.
- **Pair `$0` placement with pure US-West `¥8.48/kg` (rejected):** Double-counts best-case savings; Amazon-optimized placement routes cartons across US-West (`ONT8/LGB8` `¥8.48`), US-Central (`HOU` `¥9.98` / `MDW2` `¥10.48` / up to `MCI4` `¥12.48`), and US-East (`TEB` `¥9.98` / `JAX/CLT` `¥10.38` / up to `MCO2/TPA` `¥12.88`).
- **Use `¥9.8/kg` or dynamic `US-West + ¥1.5/kg` (rejected in favor of `¥10.0/kg`):** Owner selected `¥10.0/kg` as a pragmatic single base rate (`¥11.0/kg` with bond before material surcharge, one number to update on new tariff sheets). Because even a `3 US-West + 1 Central + 1 East` split varies from `~¥9.08–¥9.30/kg` on cheaper hubs up to `¥10.16/kg` before bond on pricier `MCI4 + MCO2/TPA` hubs, `¥10.0/kg` is treated as a planning estimate rather than a guaranteed cushion, and real shipment freight is re-verified against assigned FBA destinations and weights.

## Consequences

- `100`-set quotes remain the conservative wholesale price anchor; small-shipment `< 50 kg` warnings fire as an advisory note (showing the replenishment units needed to reach `50 kg+` per destination) only when a SKU is too light or slow-moving to clear `50 kg` per destination warehouse in realistic replenishment.
- Non-oversize `$0` placement still rejects pure US-West single-warehouse headhaul rates to prevent accidental double-counting.
