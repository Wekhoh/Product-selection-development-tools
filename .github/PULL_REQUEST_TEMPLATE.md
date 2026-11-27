## Summary

<!-- Plain-language summary of what changed and why. -->

Closes #<issue_number>

## Before-After Evidence

<!-- Concrete before/after diff, test output, or verified behavior (synthetic fixtures only in public PRs). -->

- **Before:**
- **After:**
- **Tests run:**

## GPT-6.2 Astra Dual-Axis Review & Three-Tier Independent Ruling

<!-- Every GPT-6.2 review finding MUST be independently ruled before code changes:
     - `[采纳 · 真问题]` — real money/gate/data-shape/IP/PII defect -> fixed cleanly
     - `[极简修]` — real issue with over-heavy GPT proposal -> simplest adequate fix
     - `[驳回 · 过度防御]` — extreme hypothetical in a single-person local tool -> rejected with rationale, zero defensive lines added -->

### Review Tier & Mandatory Trigger
- [ ] **Tier 1 — Routine Small PR Focused Review** (Standards + Spec dual-axis via `gpt-6.2-astra`, `service_tier="default"` + `max`, `$0` API spend, max 1 remediation round / `<= 2` calls)
- [ ] **Tier 2 — Major Checkpoint Holistic Audit** (Pause Point 1 / Pause Point 2 / major architectural refactor; raw transcripts + specs + `.local/trials/` real cards)
- [ ] **Docs / Hygiene-Only Exemption** (pure non-spec docs or hygiene with zero code/economics/PII/ledger changes)
- [ ] **Mandatory Trigger Check:** Does this PR touch **PII / raw-review redaction**, **OpenAI spending / budget ledgers**, **request recovery**, or **core economics / scoring / gate logic**? (If **YES**, Tier 1 `GPT-6.2 Astra` dual-axis review is **MANDATORY**.)

### Single-Person Local Tool Non-Goals & Fowler 4 Bad Smells
- [ ] **Single-Person Local Tool Non-Goals:** Verified zero multi-tenant, distributed, in-process-hostile-tamper, SSRF, or speculative quota-lock bloat contradicting a single-person local tool.
- [ ] **Fowler 4 Bad Smells:** Checked changed scope & boundaries for `Divergent Change`, `Shotgun Surgery`, `Speculative Generality`, and `Duplicated Code`.

- Review model & mode: `gpt-6.2-astra` (default speed + `max`, local subscription `$0` API spend, read-only)
- Rulings:

## Merge Danger

- **Door:** <!-- Reversible / Hard-to-reverse -->
- **Blast Radius:** <!-- Exact affected modules, callers, and data/replay impact -->
