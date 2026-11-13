# Project working agreement

This is an independent product-selection project. Start each task with `docs/STATE.md` and the files relevant to the requested outcome.

## Product decisions

For discovery, economics, scoring, or product-flow changes, read `docs/PRODUCT.md` and `docs/design/DECISIONS.md`. The reference profile under `docs/design/` is incomplete design material, not runtime configuration. Confirmed trial weights do not approve mapping functions, live execution, or an overall product design.

For project-design clarification, use Matt Pocock's Grill with Docs approach: combine grilling with domain modeling and maintain the existing records as decisions become clear. Ask one consequential unresolved question at a time after checking existing answers. Explain the impact and recommend a choice; factual investigation and routine engineering remain the implementer's responsibility. Keep question namespaces explicit so migration questions do not overwrite historical design questions.

For product planning, reuse/architecture selection, implementation or release, follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Investigate maintained existing solutions before adding substantial infrastructure; record the evidence, selected reuse boundary and actual gaps. Use the applicable Matt skills at their relevant stages, not the entire catalog for every task. Domain terms are in [GLOSSARY.md](GLOSSARY.md). Product-P3/P4 require deterministic code where appropriate and subscription-backed Codex as the primary research direction; concrete integration and deployment remain unselected.

## Delivery and coordination

Keep one maintained task/recovery record in `docs/STATE.md`: outcome, current evidence, remaining work, blockers, and next step. Update it at milestones, not after every tool call. Source transfer, code adoption, isolated execution, live integration, and useful business results are separate states.

Use two ongoing chats. Selection development owns product design, implementation, integration and final acceptance, including direct calls to selection-data MCPs such as SIF/SellerSprite, data validation and workflow integration. The API and Agent integration seat owns OpenAI API tool development and compatibility, with OpenAI-specific input/output, error, cost and recovery contracts as commissioned. This reflects the owner's 2026-11-12 clarification; earlier broader provider ownership is historical. There is no separate permanent coordinator chat. API implementation uses a separate worktree/branch; shared accounts and budgets still require explicit coordination.

One writer owns a checkout/file set. Other chats supply candidates in their own directories or use separate branches and worktrees. Coordinate assignments, actionable changes, blockers, and deliveries; batch ordinary progress and avoid acknowledgement loops.

Use small coherent commits and reviewable changes. Preserve existing edits. Run checks that can expose plausible errors in changed behavior; reuse valid evidence and avoid unrelated whole-project testing. Public releases require inspection of the actual publishable files. Changes affecting spending, request recovery, or private-data handling need independent review.

## Independence and privacy

Runtime, imports, configuration, tests, and project recovery must work from this repository without another operations repository or its services. Historical references are evidence only. Reuse old implementations only after checking their current assumptions, dependencies, license, and fit to the agreed design.

Keep credentials, original conversations, raw provider payloads, genuine candidate/business data, supplier quotations, spreadsheets, and live request/budget ledgers outside tracked files. `.local/`, `data/`, and `outputs/` are ignored local locations; ignore rules are not a substitute for staged-file review.

Before activating a migrated paid integration, reconcile existing in-flight/unknown requests and spending state. A new folder does not reset the budget or authorize another submission. Migration does not enable scans, schedules, supplier messages, procurement, advertising, or store writes.

Prefer offline validation and standard hosted CI runners. Do not trigger paid provider calls from CI. Use PowerShell 7 on Windows and UTF-8 Python execution. Keep project instructions in English and preserve source identifiers and original evidence where needed.
