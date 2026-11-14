# Development workflow

Status: development process, updated 2026-11-14. The first-release specification now admits a bounded native-research and offline-card implementation slice. This does not select the full product deployment or activate scheduled or paid-model integrations.

## Canonical records

| Record | Purpose |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Ownership, independence, privacy and engineering constraints |
| [PRODUCT.md](PRODUCT.md) | Product purpose, owner experience and requirements |
| [Design decisions](design/DECISIONS.md) | Confirmed choices, their conditions, superseded proposals and open questions |
| [Domain glossary](../GLOSSARY.md) | Domain meanings, without implementation instructions or a second task list |
| [First-release draft](design/FIRST-RELEASE.draft.md) | Automatic discovery/scoring workflow; the explicitly bounded trial slice is ready for implementation, with broader product acceptance still open |
| [Draft reference profile](design/reference-profile.draft.json) | The 21 item mappings, 100-point budget and revision-50 shared trial rules; not production configuration |
| [API migration](API-MIGRATION.md) | Historical capability and request/cost continuity constraints; not an adopted interface |
| `docs/research/` | Dated primary-source investigations and reuse comparisons |
| [STATE.md](STATE.md) | The single current task, evidence, blocker and recovery record |

Create an interface contract, design brief, architecture decision or acceptance specification when its concrete subject exists. Link it from the owning record. Keep proposals visibly separate from adopted decisions. Do not create duplicate task boards or fill architectural documents with assumed answers.

## Collaboration and document progression

The owner supplies needs, experience, preferences and final usefulness judgments. The selection seat actively investigates facts, surfaces overlooked cases, proposes alternatives, explains tradeoffs in plain language, and owns implementation, coordination and complete verification. Use Matt Pocock's `grill-with-docs` combination of grilling and domain modeling during the current clarification phase. Ask one material unresolved question at a time, with a concrete example and a recommendation; routine technical choices and facts are not homework for the owner. New evidence may refine a decision, with its reason and prior status preserved.

Record conclusions, rationale, limitations, corrections and open decisions in their owning files. Keep original conversation evidence private. The document chain is: requirements and decisions -> one first-release specification -> executable work -> acceptance evidence. Each later stage must point back to the decision or requirement it implements. Preserve existing identifiers such as Q31 and V1-01; add an identifier only when it enables a concrete reference or verification need.

Switching from Grill Me to Grill with Docs continues the same decision history. Inherit the reviewed Q1-Q32 decisions, later corrections, withdrawn proposals and open questions; use the current public records for development and consult preserved private source evidence only for a concrete ambiguity. The skill change does not restart the interview or require the owner to approve settled answers again.

The first-release document is currently a draft specification: workflows, acceptance subjects and all 21 item mappings exist, and revision 50 adopts the shared scoring and Q31 reference conventions. Actual source feasibility, implementation choices and measured operating limits remain open. Mature this existing draft as evidence arrives instead of creating a competing SPEC. Once consequential blockers for a concrete development slice are resolved, it must state user-visible behavior, code/AI responsibilities, inputs/outputs, error and missing-data behavior, scope and observable acceptance. Only then mark that slice ready for implementation. A bounded source-feasibility experiment and an implementation-ready specification are different milestones; neither establishes readiness of the whole application.

STATE owns the current plan, task status, dependencies, blockers, validation evidence and exact next step. When implementation can be broken into complete end-to-end tasks, add the necessary detail and links there; introduce issue records only for concrete tasks, without a second independently maintained TODO/PLAN/status board. Domain modeling uses GLOSSARY and the existing decision record. A separate ADR is appropriate for a real consequential architectural tradeoff, not every term or routine choice.

Before resuming after context loss or a handoff, read STATE, inspect the current checkout, then read the requirement/decision/spec sections governing the next task. Preserve settled and withdrawn decisions; ask again only for a new conflict or a genuine remaining choice. At a milestone, update the records and actual acceptance evidence. This is a recovery procedure, not a claim that file presence guarantees automatic context loading.

During execution, use those same governing sections before each consequential stage, not only at handoff. At a milestone, record the adopted decision, what the run actually did, any deviation and its reason, and the evidence needed to close the gap in STATE or its linked private run record. Surface consequential counterevidence and overlooked alternatives proactively; distinguish a proposed improvement from an adopted rule. Do not silently replace a settled business rule or create a second checklist that drifts from the owning records. Routine conforming tool calls need no repetitive documentation entry.

Publish sanitized methods, design and development records to this repository through reviewable changes under the owner's publication instruction. Preserve a visible distinction between local edits, committed changes, remote publication and accepted implementation. Keep business evidence, raw conversations and secrets local under the existing boundary. A document can be published as a draft while its unresolved decisions remain explicit; publication is not production readiness.

## Reuse before architecture

Before adopting a workbench, research runtime or substantial framework, compare relevant maintained implementations against an actual user workflow. Inspect current source, version, license conditions, recent development and releases, extension interfaces, data dependencies and operational requirements. Record what was inspected and what remains untested. Stars and recent pushes are discovery signals; inspect actual commits and distinguish prereleases from stable releases.

Follow the owner-confirmed order: find an existing solution, verify its fit, adapt/reuse it, then fill necessary gaps. Look for actual usage evidence as well as maintenance; do not equate popularity with market validation or suitability here. Before proposing custom work, identify the specific gap in maintained alternatives and why owning that code is justified. Explain important choices in plain language: what they solve, what can be used directly, what changes, who maintains it and how acceptance will be demonstrated.

Compare direct use, supported extension, focused module reuse, and independent implementation informed by mature product designs. Product-reference value and source-reuse permission are separate findings: a project may be worth studying even when its source cannot be incorporated. Inspect publicly available workflows, interactions and architecture; preserve applicable restrictions on copying code and assets. Prefer a treatment that preserves useful upstream updates and minimizes the amount this project must maintain. A large fork is justified only when its concrete benefit exceeds its recurring adaptation burden.

Evaluate maintenance by actual relevant code and dependency changes, releases and current platform compatibility, not just stars, README edits or the most recent repository push. A recent AI wrapper may become unnecessary when the underlying runtime gains the same capability; check current native platform support before adopting another layer. Visual similarity does not prove equivalent data correctness, state recovery or cost accounting.

Research transferable engineering and product patterns across domains, including automation, API integration, recovery, interfaces and delivery. Prefer available source and official documentation. Use REA or another implementation-analysis tool only for a concrete unanswered question and an appropriate target; record observations separately from inferred or inaccessible backend behavior.

Inspect a candidate without installing or running it first. Prototype and runtime validation require an appropriate isolated environment and the task's existing authorization. Reuse neither transfers credentials nor grants another provider allowance.

## Delivery stages and evidence

1. **Define the useful first release.** Begin with the inherited decisions and current corrections, then describe the complete daily discovery/research/scoring/card-delivery cycle and the owner's review. Do not make a new owner prompt or manually selected category/candidate a prerequisite. Resolve only genuine remaining ambiguities with examples. Record acceptance conditions and unknowns before architecture selection.
2. **Compare reuse and interaction options.** Use source-backed options and a bounded synthetic walkthrough where it can resolve a real uncertainty. Mark prototypes and synthetic business values clearly. A prototype answers a question; it does not establish provider integration or business effectiveness.
3. **Select the minimum implementation.** Explain the selected reuse boundary, supported extension points, persistence, research execution, errors, missing data and recovery. Separate user interface, research runtime and deployment decisions. Record a durable architecture decision only for a consequential tradeoff that a future maintainer needs to understand.
4. **Build a complete vertical workflow.** Implement the smallest agreed path through the real caller, domain behavior, evidence storage and user-visible result. Add focused tests at meaningful interfaces for plausible failures. Preserve one writer per file set and deliver reviewable changes from the API worktree.
5. **Verify and release the agreed scope.** Check actual publishable files, relevant tests, clean-checkout offline operation, current interface behavior, authorized real-card output, and the desktop/mobile flows that the product claims to support. Track source adoption, runtime acceptance and later business outcomes separately in STATE.

Review each stage when new evidence changes a consequential assumption. Requirements become clearer through prototypes and real feedback; do not pretend all future details can be finalized in advance. Keep decisions current during development, with the reason for changes and the affected acceptance evidence.

Write acceptance before implementation, exercise meaningful behavior and error cases during implementation, and finish with integrated workflow acceptance. Do not defer all testing until the application is built. The authorized bounded source-to-score feasibility trial informs the design before major implementation; it is not a production release or an excuse to leave required dimensions unavailable. Use the existing [first-release acceptance](design/FIRST-RELEASE.draft.md) and [pretrial review](reviews/20261113-scoring-pretrial.md) to distinguish unresolved business decisions, source limitations, routine engineering work and later product choices. Reuse unchanged reviewed definitions and recheck changed dependencies rather than restart the entire interview or audit.

## Assign work to code and AI deliberately

Follow Product-P3: use ordinary code for settled deterministic transformations, arithmetic, validation and state handling; use AI for evidence interpretation, synthesis and adaptive research where it adds value. AI may call existing tools rather than reproduce their logic. Reuse a maintained implementation before writing a new script when it fits the agreed need.

For each implemented workflow step, make its inputs, outputs, source/unknown semantics and verification clear. Validate AI-produced requests and results at the application boundary; a valid schema does not prove factual correctness. Preserve existing authorization, request identity, recovery and spending requirements across both paths. Tests should verify agreed deterministic behavior and relevant failure cases; AI evaluation should examine evidence grounding and task quality. Do not convert unresolved scoring choices into defaults or create a large rule engine merely to avoid AI.

## Feasibility and calibration before expansion

Owner correction, 2026-11-12: clarify remaining business meanings and group-level scoring tradeoffs now, but stop decomposing every numerical edge case into another interview question or mandatory research step. The owner deferred new MCP testing until the later SellerSprite recharge. The accepted scoring draft is a trial baseline, not a reason to finish every algorithm branch before validating a bounded complete path. After that trial, use actual returned fields, coverage, effort, latency and card usefulness to simplify acquisition and scoring where justified. Routine technical adaptation belongs to selection; material changes to what a score rewards must be explained as a coherent before/after proposal. Preserve confirmed boundaries, source uncertainty and the distinction between missing evidence and poor performance. This correction enables neither new calls today nor arbitrary score changes.

For each proposed stage, identify the existing retrieval capability, required fields and their actual grain/window, code versus AI responsibilities, user-visible result, and what remains unknown when a source is unavailable. Tool metadata is a candidate capability, not proof of account access, response quality, speed or sustainable throughput. Prefer structured supported interfaces; use public search or a permitted browser for a concrete gap, not as an unbounded alternative collection system. Confirm the chosen execution entry actually exposes the required tools; a tool available in this design chat is not automatically available to another runner.

After the relevant definitions are settled, verify a bounded complete discovery-to-scored-card path with synthetic or reusable local evidence first. A later explicitly authorized real-data trial must measure stage time, actual request/usage totals, data coverage, saved cards and decision-relevant errors before promising daily output or selecting concurrency. Offline checks cannot validate current provider access or predict live throughput. Reuse shared observations within their applicable freshness windows; do not query the same market separately for every related form. Define research stop conditions and how incomplete work carries forward without forcing arbitrary scores. Widen the existing workflow only after its bottlenecks and value are understood; do not create a general service platform or a fleet of specialized agents for hypothetical future needs.

Keep fixed calculations and score mappings separate from provider field conversion and AI-supported judgments. Use the simplest representation that supports current accepted rules; extensions may add, revise or remove a metric without scattering its logic across tools and screens. This does not require a generic scoring language or plugin framework. On owner feedback, first identify whether the problem is evidence, grouping, inference, mapping or a changed preference. Propose the smallest justified correction, retain before/after versions and reasons, and replay varied prior cases plus later unseen cases. Do not tune every rejection into a new rule, silently self-adjust business weights, or count owner agreement as verified commercial success.

The owner's 2026-11-13 clarification reinforces that experience is useful but fallible. Keep an observed fact, the owner's explanation or preference, the implementer's inference, and a later measured outcome distinguishable. Discuss disagreement with concrete evidence and alternatives. Record a changed decision and its scope when adopted; neither a brainstorming suggestion nor general agreement with a data interpretation approves every pending rule in a neighboring proposal.

## Task-specific use of Matt skills

Use a skill when its question is present; do not run the entire catalog as a mandatory ceremony.

Treat the owner as a design partner. Their early descriptions may be sketches: proactively identify missing cases, counterexamples and better alternatives, and explain disagreements through concrete consequences in plain language. Do the factual and engineering investigation rather than asking the owner to choose unfamiliar algorithms. Ask one consequential unresolved question at a time after checking prior answers; preserve confirmed decisions, exceptions and withdrawals. The purpose of preparation is an understandable, testable workflow, not a larger document inventory or a promise that every future detail can be predicted.

The installed v1.3.1 package was checked directly. Its user-invoked main flow includes skills that are not all listed in the host's exposed catalog: `grill-with-docs`, an optional `prototype` detour, `to-spec`, `to-tickets`, `implement` or `implement-spec` with TDD, `code-review`/PR, and `retro`. `ask-matt` routes between these; `wayfinder` organizes unresolved decisions when an effort is too large and uncertain for a single planning session. Reading these workflows does not itself invoke publication, a new tracker, parallel execution or implementation.

| Stage | Required useful output in this project | Completion boundary |
| --- | --- | --- |
| `grill-with-docs` (`grilling` + `domain-modeling`) | Agreed needs and constraints in PRODUCT, decisions and unresolved questions in DECISIONS; a glossary or focused ADR when its concrete subject warrants one | The owner understands consequential choices; unresolved choices remain explicit |
| `research` / necessary `prototype` | Cited investigations and an inspectable demonstration addressing a specific question, with its verdict | Evidence or demonstrated behavior informs a decision; a demonstration is not a production release |
| `to-spec` | One coherent first-release specification: problem, solution, user stories, settled business and implementation decisions, code/AI responsibilities, inputs/outputs/errors, testing and acceptance, out-of-scope work and open blockers | It describes a complete useful workflow and how to verify it; unresolved business choices cannot be silently filled in |
| `to-tickets` | Reviewable end-to-end work items with acceptance criteria, ownership and real dependencies, linked from STATE | Each item delivers a verifiable path through the required layers; no competing task/recovery board |
| `implement` / `implement-spec` and `tdd` | Agreed behavior, focused red-green evidence at meaningful seams, integration and failure handling | Work follows settled requirements and the two-seat file ownership; generic orchestration does not create extra permanent seats |
| `code-review` / `pr` | Fixed-scope standards/spec review, resolved findings and relevant acceptance evidence | Code adoption, offline operation, native integration, real-card usefulness and visual acceptance stay distinct |
| `retro` | Evidence-based improvements to checks, navigation or engineering conventions | Improvements address observed problems; they do not automatically install tooling or create more process |

Keep STATE as the single maintained task/recovery record. Use existing repository documents and issue conventions; do not mechanically reproduce a skill's sample tracker structure. Write a real spec once its scope is understandable, rather than creating a complete-looking document from unsettled assumptions. The owner-authorized bounded discovery-to-card slice in FIRST-RELEASE is now being implemented and tested; broader application interaction and deployment remain open. Historical clarification-only checkpoints do not block this adopted slice.

| Skill | Applicable work |
| --- | --- |
| Grilling | Explain and resolve consequential product choices, one manageable round at a time; reuse existing answers |
| Research | Investigate facts, implementations and tradeoffs against primary sources, then record cited findings |
| Prototype | Test a specific interaction or state-model question with a clearly marked throwaway artifact |
| Domain modeling | Clarify product terminology and relationships; maintain a glossary only when resolved terms warrant one |
| Codebase design | Choose understandable module interfaces and testable seams after checking useful existing implementations |
| Writing for agents | Keep maintained instructions and recovery pointers precise, scoped and free of duplicated authority |
| TDD | Protect important agreed behavior with meaningful regression or integration tests; do not add mirrored tests for harmless prose |
| Diagnosing bugs | Reproduce a concrete failure, test explanations and make the smallest adequate correction |
| Code review / PR | Review a frozen change against project standards and its actual specification, then explain the change and validation |
| Wizard | Guide genuinely human-only setup steps when the agent cannot perform them; not ordinary automated development |

Use the relevant frontend/design workflow for usability and visual acceptance, and current official documentation for changing platform capabilities. Skills guide the work; their templates do not turn proposals, prototypes or passing tests into owner decisions or business results.
