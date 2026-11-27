# Development workflow

Status: development process, updated 2026-11-26. The bounded native-research, offline-card, SQLite multi-channel operations, Curatorial Studio (`01 视觉策展室`) report (`src/report.mjs`, `src/report-studio-css.mjs`), Scheme A `src/openai/` + subscription `Codex CLI` layer, 3-layer 2027 FBA/economics consolidation (`src/rates/`, `src/fba-calculator.mjs`, `src/economics.mjs`), provider/Keepa adapters (`src/adapters/`), daily single-item/small-batch CLI entrypoints, and audited `src/business-thresholds.mjs` registry are implemented; STATE records current cards, verification evidence, and remaining live-activation gates. Full deployment and unattended operation remain separate. For another agent's review or a refactor, follow [CONTEXT-ROUTER](CONTEXT-ROUTER.md) without restarting settled design questions. Never invent or hardcode unconfirmed business threshold numbers without explicit owner confirmation (`src/business-thresholds.mjs` + `test/business-thresholds.test.mjs`).

## Canonical records

| Record | Purpose |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Ownership, independence, privacy and engineering constraints |
| [SPEC.md](SPEC.md) | Single active business specification, 4-step workflow blueprint, model boundaries, and permanent Non-Goals |
| [Architecture decision records](adr/0001-decouple-steady-state-freight-from-100-set-sourcing.md) | Concise records of hard-to-reverse architectural and business-boundary tradeoffs (options, rationale, consequences) |
| [Archived PRODUCT.md](archive/PRODUCT.md) | Frozen historical product requirements baseline (superseded by `SPEC.md`) |
| [Archived DECISIONS.md](archive/DECISIONS.md) | Frozen dated decision chronology, Q1–Q32 history, and superseded proposals (superseded by `SPEC.md` + `adr/`) |
| [Domain glossary](../GLOSSARY.md) | Pure domain meanings (no implementation details or second task list) |
| [Active reference profile (`r59`)](design/reference-profile.r59.draft.json) | Sole active runtime profile: 21 item mappings, 100-point budget, unified 85-pt core ranking, 3-Tier Progressive Bids, crossing-`30%` slope extension, and 36-category/Bulky/Oversize 2027 FBA schedules (`r50–r58` frozen replay archived on Git tag `archive/r50-r58-frozen-replay-20261125` and [reference-profile.r58.archived.json](archive/design/reference-profile.r58.archived.json)) |
| [Business thresholds registry](../src/business-thresholds.mjs) | Single audited frozen registry of all owner-confirmed business cutoffs with `confirmed_at` dates and provenance |
| [API migration](API-MIGRATION.md) | Scheme A single-checkout `src/openai/` routing, `$200/mo` natural-month realized-spend guardrails, and `GPT-6.2 Astra` (default speed + `max`) rules |
| [Historical archive](archive/) | Archived early drafts ([FIRST-RELEASE](archive/design/FIRST-RELEASE.draft.md), [TRIAL-INPUT](archive/design/TRIAL-INPUT.md)), dated research (`archive/research/`), and reviews (`archive/reviews/`) |
| [STATE.md](STATE.md) | The single current task, evidence, blocker and recovery record (paired with GitHub Issues for active vertical slices) |
| [CONTEXT-ROUTER.md](CONTEXT-ROUTER.md) | Causal background and topic-triggered routes to planning, rules, code, tests and original evidence; not a second task board |

Create an interface contract, design brief, architecture decision or acceptance specification when its concrete subject exists. Link it from the owning record. Keep proposals visibly separate from adopted decisions. Do not create duplicate task boards or fill architectural documents with assumed answers.

## Collaboration and document progression

The owner supplies needs, experience, preferences and final usefulness judgments. The selection seat actively investigates facts, surfaces overlooked cases, proposes alternatives, explains tradeoffs in plain language, and owns implementation, coordination and complete verification. Use Matt Pocock's `grill-with-docs` combination of grilling and domain modeling when a consequential design clarification is needed. Ask one material unresolved question at a time, with a concrete example and a recommendation; routine technical choices and facts are not homework for the owner. New evidence may refine a decision, with its reason and prior status preserved.

Record conclusions, rationale, limitations, corrections and open decisions in their owning files. Keep original conversation evidence private. The document chain is: requirements and decisions -> one first-release specification -> executable work -> acceptance evidence. Each later stage must point back to the decision or requirement it implements. Preserve existing identifiers such as Q31 and V1-01; add an identifier only when it enables a concrete reference or verification need.

Switching from Grill Me to Grill with Docs continues the same decision history. Inherit the reviewed Q1-Q32 decisions, later corrections, withdrawn proposals and open questions; use the current public records for development and consult preserved private source evidence only for a concrete ambiguity. The skill change does not restart the interview or require the owner to approve settled answers again.

[SPEC.md](SPEC.md) is the single active business and workflow specification (superseding the archived early draft [FIRST-RELEASE.draft.md](archive/design/FIRST-RELEASE.draft.md)); keep `docs/SPEC.md`, [GLOSSARY.md](../GLOSSARY.md), and [docs/adr/](adr/0001-decouple-steady-state-freight-from-100-set-sourcing.md) current as decisions evolve instead of creating competing specs. Once consequential blockers for a concrete development slice are resolved, record user-visible behavior, code/AI responsibilities, inputs/outputs, error and missing-data behavior, scope, and observable acceptance before coding. A bounded source-feasibility experiment and an implementation-ready specification are different milestones; neither establishes readiness of the whole application.

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
4. **Build a complete vertical workflow.** Implement the smallest agreed path through the real caller, domain behavior, evidence storage and user-visible result. Add focused tests at meaningful interfaces for plausible failures. Preserve one writer per disjoint file set and land reviewed changes cleanly inside this single primary repository under Scheme A.
5. **Verify and release the agreed scope.** Check actual publishable files, relevant tests, clean-checkout offline operation, current interface behavior, authorized real-card output, and the desktop/mobile flows that the product claims to support. Track source adoption, runtime acceptance and later business outcomes separately in STATE.

Review each stage when new evidence changes a consequential assumption. Requirements become clearer through prototypes and real feedback; do not pretend all future details can be finalized in advance. Keep decisions current during development, with the reason for changes and the affected acceptance evidence.

Write acceptance before implementation, exercise meaningful behavior and error cases during implementation, and finish with integrated workflow acceptance. Do not defer all testing until the application is built. The authorized bounded source-to-score feasibility trial informs the design before major implementation; it is not a production release or an excuse to leave required dimensions unavailable. Use the existing [archived first-release acceptance](archive/design/FIRST-RELEASE.draft.md) and [archived pretrial review](archive/reviews/20261113-scoring-pretrial.md) to distinguish unresolved business decisions, source limitations, routine engineering work and later product choices. Reuse unchanged reviewed definitions and recheck changed dependencies rather than restart the entire interview or audit.

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

The installed v1.3.2 package was checked directly. Its user-invoked main flow includes skills that are not all listed in the host's exposed catalog: `grill-with-docs`, an optional `prototype` detour, `to-spec`, `to-tickets`, `implement` or `implement-spec` with TDD, `code-review`/PR, and `retro`. `ask-matt` routes between these; `wayfinder` organizes unresolved decisions when an effort is too large and uncertain for a single planning session. Reading these workflows does not itself invoke publication, a new tracker, parallel execution or implementation.

| Stage | Required useful output in this project | Completion boundary |
| --- | --- | --- |
| `grill-with-docs` (`grilling` + `domain-modeling`) | Agreed needs and constraints in PRODUCT, decisions and unresolved questions in DECISIONS; a glossary or focused ADR when its concrete subject warrants one | The owner understands consequential choices; unresolved choices remain explicit |
| `research` / necessary `prototype` | Cited investigations and an inspectable demonstration addressing a specific question, with its verdict | Evidence or demonstrated behavior informs a decision; a demonstration is not a production release |
| `to-spec` | One coherent first-release specification: problem, solution, user stories, settled business and implementation decisions, code/AI responsibilities, inputs/outputs/errors, testing and acceptance, out-of-scope work and open blockers | It describes a complete useful workflow and how to verify it; unresolved business choices cannot be silently filled in |
| `to-tickets` | Reviewable end-to-end work items with acceptance criteria, ownership and real dependencies, linked from STATE | Each item delivers a verifiable path through the required layers; no competing task/recovery board |
| `implement` / `implement-spec` and `tdd` | Agreed behavior, focused red-green evidence at meaningful seams, integration and failure handling | Work follows settled requirements and disjoint per-worker file ownership under Scheme A; generic orchestration does not create extra permanent seats |
| `code-review` / `pr` | Fixed-scope standards/spec review, resolved findings and relevant acceptance evidence | Code adoption, offline operation, native integration, real-card usefulness and visual acceptance stay distinct |
| `retro` | Evidence-based improvements to checks, navigation or engineering conventions | Improvements address observed problems; they do not automatically install tooling or create more process |

Keep STATE as the single maintained task/recovery record. Use existing repository documents and issue conventions; do not mechanically reproduce a skill's sample tracker structure. Write a real spec once its scope is understandable, rather than creating a complete-looking document from unsettled assumptions. The initial bounded discovery-to-card slice (originating in archived [FIRST-RELEASE](archive/design/FIRST-RELEASE.draft.md) and now governed by [SPEC.md](SPEC.md)) is implemented and undergoing real-data trials; broader application interaction and deployment remain open. Historical clarification-only checkpoints do not block this adopted slice.

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

## Adversarial review steering, Two-Tier Review System, Three-Tier Independent Ruling Gate & UI preview conventions

- **Two-Tier Review System (`GPT-6.2 Astra` via local subscription `Codex CLI`, `$0` API spend):**
  - **Runtime defaults:** Every fresh-context `codex exec` review runs `-m gpt-6.2-astra -c model_reasoning_effort="max" -c service_tier="default"` at **normal/default speed** (explicitly overriding any host `~/.codex/config.toml` `ultrafast` setting per `2026-11-26 21:12 +08:00` owner override unless re-enabled later, `$0` API spend), passing direct raw file/log/transcript paths without second-hand compression.
  - **Tier 1 — Routine Small PR Focused Review:** Lightweight, fast Standards + Spec dual-axis check on a frozen single-PR diff, capped at **1 remediation round (`<= 2` calls)**. **Mandatory** for ANY PR touching **private-data handling or redaction (including PII, raw reviews, and private business evidence/quotes)**, **OpenAI spending / budget ledgers**, **request recovery**, or **core economics / scoring / gate logic**. Pure typo/non-spec doc hygiene PRs may use ordinary diff and link verification.
  - **Tier 2 — Major Checkpoint Holistic Business-Logic Audit:** Fixed **1-round** full-context `GPT-6.2 Astra` audit (`serviceTier: 'default'`, `max` reasoning, `web_search: 'live'`, `$0` API spend) passing raw main/sidechat transcripts, living specs (`docs/SPEC.md`, `docs/STATE.md`, `docs/adr/`, `src/business-thresholds.mjs`), and `.local/trials/` real benchmark cards at **Pause Point 1**, **Pause Point 2**, and **before major architectural refactors**, explicitly inviting first-principles business-logic challenge against single-person local Amazon FBA tool reality, followed by primary-agent **Three-Tier Independent Ruling** (`[采纳 · 真洞察]` / `[极简补]` / `[驳回 · 脱离单人卖家现实]`) and explicit owner sign-off before starting implementation work. (Subsequent core/architecture **code remediation** uses its own max **3 rounds** limit below.)
- **Single-PR `GPT-6.2 Astra` Review Prompt Template (copy-pasteable):**
  Use the standard **"目标 + 验收标准 + 两条边界 + 自由发挥"** structure for Tier 1 PR reviews:

  ```text
  【目标】
  请以“单人本地亚马逊美站 FBA 选品工具”的第一性原理，对本 PR（Issue #<id> / 分支 <branch> / commit <sha>）做 Standards + Spec 双轴独立审查。
  请直接读取以下原始文件与 diff（禁止依赖二手摘要）：
  - 当前阶段与原始需求：<current stage / milestone & ORIGINAL_REQUEST.md path>
  - 规格与约束：docs/SPEC.md、AGENTS.md、src/business-thresholds.mjs
  - 本次改动文件：<exact changed file paths>
  - 验证命令与原始输出：<raw test output path or reproducible `node --test` command>

  【验收标准】
  1. 真实缺陷拦截（BLOCKER）：是否引入资金/毛利算错、误杀蓝海、漏拦 IP/侵权冲突、真实外部 API 载荷崩溃、未确认业务阈值硬编码，或 PII/密钥/原评论泄露。
  2. 单人本地工具 Non-Goals 检查：明确标出任何违背“单人本地桌面/CLI 工具”前提的过度防御（例如：多租户、分布式锁、防进程内 JS 原型篡改、SSRF 过度防护、重复平台 $200 硬上限的核弹级额度锁、或脱离真实调用链的冗余测试）。
  3. Fowler 四大坏味道检查（仅针对本次改动及直接耦合边界）：
     - Divergent Change（发散式变化：一个模块承担过多不相关变化轴）
     - Shotgun Surgery（霰弹式修改：一个业务规则变动被迫散改多处）
     - Speculative Generality（臆测性泛化：为假想未来需求提前搭空架子/抽象层）
     - Duplicated Code（重复代码：同源规则或逻辑在多处各自维护）
  4. 合规与可独立裁决输出：每条发现必须给出精确文件路径、行号与可复现证据，便于主代理执行独立三档裁决（`[采纳 · 真问题]` / `[极简修]` / `[驳回 · 过度防御]`）；严禁为凑 PASS 建议堆砌防御性代码。

  【两条边界】
  1. 严禁修改主工作区任何文件或 SQLite 账本（`.local/state/selection.sqlite` 等仅只读）。
  2. 严禁执行任何亚马逊店铺/广告真实写操作；全程走本地订阅 `Codex CLI`（`service_tier="default"`、`max` 推理），保持 `$0` 付费 API 消耗。

  【自由发挥】
  除上述检查项外，如发现本次改动存在未覆盖的真实边界失效、回归风险或更极简的结构改法，请直接指出原因、利弊与最小可行方案；禁止阿谀奉承。
  ```

- **Highest engineering discipline — Three-Tier Independent Ruling Gate (anti-bloat barrier):** Never blindly accept all `GPT-6.2` review comments. Before modifying any code after a `GPT-6.2` audit (Tier 1 or Tier 2), the primary agent MUST independently judge every single comment from first principles of a **single-person local Amazon FBA product-selection tool**, assign one of three verdicts with a one-sentence rationale, and act strictly accordingly:
  1. **`[采纳 · 真问题]`** — genuinely miscalculates money/margin, falsely kills blue oceans, misses IP/counterfeit conflicts, crashes on real provider payload shapes, or leaks PII/secrets -> fix cleanly at the structural seam and apply the Poteto ratchet (structural/interface prevention > deterministic guard test with fix instructions > minimal prose deleted once guarded).
  2. **`[极简修]`** — real defect exists, but GPT's proposed design is over-engineered -> apply the simplest adequate fix without creating complex new subsystems (e.g., flat columns in an existing table instead of event sourcing).
  3. **`[驳回 · 过度防御]`** — extreme hypothetical absent from a single-person local tool (in-process caller JS prototype/`Proxy` tampering, local disk hardlink races, imaginary local attackers, nuclear-grade local settlement locks duplicating platform `Auto-recharge OFF` + `$200` hard cap, heavy shared-Buy-Box attribution/blind-test subsystems for front-end lead sourcing, or redundant tests) -> explicitly reject with rationale and add **zero** defensive lines; never pile up bloat merely to chase a GPT `PASS`.
  - When genuinely uncertain whether to adopt or reject a comment, present one-sentence arguments from both sides to `主人` for a decision. Enforce a hard ceiling of **1 remediation round (`<= 2` calls) for routine small PR / card reviews** and **3 rounds maximum for major core/architecture code remediation** (separate from Tier 2's fixed **1-round** pre-code holistic business-logic audit).
- **Global check first & sustained disciplined slimming:** Never halt delivery for a full-repo rewrite, and never impose arbitrary "delete X% lines" quotas. Instead, track verified over-defensive bloat (such as abolished lock/tamper/hardlink layers in `src/openai/` and monolithic command routing in `src/phase2-cli.mjs`) on the cleanup roadmap, verify all real callers and test dependencies before removing dead code, and keep core business behavior and `node --test` 100% green.
- **Curatorial Studio (`01 视觉策展室`) UI invariants & local preview:** Future HTML report or workbench updates must preserve the anti-AI-slop editorial aesthetic (`0` Impeccable warnings), unboxed typographic navigation (zero pill-box tag clutter), and high-contrast CJK ink legibility (`--ink-2: #1c1d22`, `--muted: #383a42`, `>= 11:1` contrast, body weight `>= 460`). Never hand the owner a bare local `.html` file path to click in chat (which opens raw HTML source in the editor); always serve and link a rendered `http://127.0.0.1:<port>/...` local preview URL with refresh instructions.

## Long-term maintainability, test pragmatism & periodic signal-vs-noise hygiene

Adopted 2026-11-26 as permanent stage & `retro` engineering discipline (executed continuously alongside each delivery stage rather than halting delivery for one-off rewrites):

1. **Design code and tests for long-term evolution (low coupling, zero bloat):**
   - Keep every new module and refactor cleanly decoupled with narrow interfaces so adding new discovery channels, updating 2028+ annual fee schedules, or swapping AI models stays low-friction.
   - Apply the **Three-Tier Independent Ruling Gate (`[采纳 · 真问题]` / `[极简修]` / `[驳回 · 过度防御]`)** to **both source code and tests** — reject redundant, brittle, or hostile-in-process over-testing detached from single-person local tool reality. Test real ledgers, real interface contracts, and realistic boundaries so future refactors stay unblocked.
2. **Maintain repository docs, files, branches, and local hygiene by signal-vs-noise (no arbitrary size caps):**
   - Write useful Matt/Poteto living docs (`docs/SPEC.md`, `docs/adr/`, `GLOSSARY.md`, `docs/STATE.md`, issue plans, and TDD/acceptance evidence) as thoroughly as needed — never impose artificial KB or line limits on high-signal records.
   - Periodically prune duplicated copy-pasting, stale contradictions, and obsolete noise with one clear benchmark: **a brand-new AI with zero prior chat history reading only the repository's living docs and `.local/state/` can resume work seamlessly with zero ambiguity or misreading.**
3. **Mandatory per-stage `retro` hygiene checklist:**
   - **Single source of truth:** Write each active rule completely in one owning record (`docs/SPEC.md` for active business rules, `docs/DEVELOPMENT.md` for workflow discipline); link from other docs instead of duplicating prose (continuously reducing duplicated rules between `AGENTS.md` and `docs/SPEC.md`).
   - **Condensed rejection memory:** Never retain massive logs of overturned proposals; condense *"why it was rejected so future AIs do not repeat it"* into `docs/SPEC.md` §2 (`Non-Goals`) or `docs/adr/`.
   - **Archived legacy mega-docs & periodic STATE compaction:** Overlapping `docs/PRODUCT.md` and `docs/design/DECISIONS.md` are retired/archived into `docs/archive/` as read-only historical archaeology (zero new PR appends; `docs/SPEC.md` is the sole active business spec), while settled historical blocks in `docs/STATE.md` are periodically condensed into compact milestone anchors.
   - **Code / script / branch / local hygiene:** On every stage `retro`, audit and safely remove confirmed unused temporary scripts, obsolete early drafts, and already-merged GitHub/local branches. **Mandatory safety gate:** verify zero repo-wide references before deleting any tracked file or script, and **STRICTLY NEVER delete or modify `.local/secrets/`, SQLite ledgers, or core `.local/state/` files.**
