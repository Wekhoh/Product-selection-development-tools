## Summary

<!-- Plain-language summary of what changed and why. -->

Closes #<issue_number>

## Before-After Evidence

<!-- Concrete before/after diff, test output, or verified behavior (synthetic fixtures only in public PRs). -->

- **Before:**
- **After:**
- **Tests run:**

## GPT-6.2 Astra 1-Round Review & Zero-Edit Owner Approval Gate

<!-- R1 Review Rules:
     - Strict 1-round hard cap on ALL GPT reviews (no multi-round retries).
     - Prompt uses "目标 + 验收标准 + 两条边界" (no nitpick triggers, no GPT pre-labeling).
     - Strictly ZERO code edits after ANY GPT review (even routine engineering findings — no maintainer/agent bypass) until the primary agent presents a plain Simplified Chinese two-bucket summary (`桶 A: 真问题·建议修` / `桶 B: 过度防御·建议驳回`, `大白话`) to `主人` and edits ONLY items approved by `主人`. -->

### Review Tier, Exemption & Mandatory Trigger
- [ ] **1-Round Focused PR Review** (Standards + Spec dual-axis via `gpt-6.2-astra`, `service_tier="default"` + `max`, `web_search="live"`, `$0` API spend, strict 1-round cap)
- [ ] **1-Round Full-Scope Closeout Audit** (M6 after Step 1 & Step 2 complete, or major checkpoint; full project context + read-only full-repo access)
- [ ] **Docs / Hygiene-Only or Owner-Approved Slimming Exemption** (pure docs/hygiene-only PRs or owner-approved slimming PRs covered by offline tests + verification wave; final 1-round full-scope GPT review runs in M6)
- [ ] **Mandatory Trigger Check:** Does this non-exempt PR touch **private-data handling / redaction (PII, raw reviews, private business evidence/quotes)**, **OpenAI spending / budget ledgers**, **request recovery**, or **core economics / scoring / gate logic**? (If **YES**, 1-round `GPT-6.2 Astra` dual-axis review is **MANDATORY**.)
- [ ] **Zero-Edit Owner Two-Bucket Approval Gate:** Confirmed strictly ZERO code edits were made after GPT review until `主人` reviewed plain Chinese `桶 A: 真问题·建议修` / `桶 B: 过度防御·建议驳回` and approved specific edits (or N/A if exempt).

### Single-Person Local Tool Non-Goals & Fowler 4 Bad Smells
- [ ] **Single-Person Local Tool Non-Goals:** Verified zero multi-tenant RBAC, distributed lock, in-process prototype-tampering, symlink/hardlink, SSRF, or speculative quota-lock bloat contradicting a single-person local tool.
- [ ] **Fowler 4 Bad Smells:** Checked changed scope & boundaries for `Divergent Change`, `Shotgun Surgery`, `Speculative Generality`, and `Duplicated Code`.

- Review model & mode: `gpt-6.2-astra` (default speed + `max`, `web_search="live"`, local subscription `$0` API spend, read-only, 1-round max)
- Owner Two-Bucket Approval (`桶 A` / `桶 B`):

## Merge Danger

- **Door:** <!-- Reversible / Hard-to-reverse -->
- **Blast Radius:** <!-- Exact affected modules, callers, and data/replay impact -->
