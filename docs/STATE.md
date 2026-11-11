# Project state

Updated: 2026-11-11. Phase: selective migration and design alignment.

## Objective and settled scope

Build an independent product-selection tool for the owner's personal use. Source, methods, and reference settings are public under Apache 2.0; actual business data and secrets remain local. Local operation is the initial direction; owner-only self-hosting may follow. A publicly hosted multi-user service is not requested.

The previous whole-store automation project is no longer a development target. Other useful workflows may be extracted separately later; they are outside this migration.

## Ownership

The owner chose two ongoing chats on 2026-11-11. This replaces the earlier three-seat migration arrangement.

| Area | Owner | Current boundary |
| --- | --- | --- |
| Product design, application development, repository integration and final acceptance | Selection development seat | Inherits the Radar decisions and unresolved questions; sole writer of the integration checkout |
| Provider APIs, Agent workflows, request recovery and cost continuity | API and Agent integration seat | Develops in a separate worktree/branch against agreed input/output contracts; no concurrent edits to the integration checkout |

The former coordinator and former Radar chat become historical handoff sources after the new seats take over; they are not additional concurrent developers. Do not auto-close or archive those chats. The API chat's migration package remains private reference material.

Use this record as the single project task/recovery entry. Coordinate assignments, actionable interface or cost changes, blockers and deliveries; batch routine progress. Reusable API modules may serve other projects when concrete callers exist. This handoff does not commission a central hosted service, another repository, a new allowance or provider activation.

## Progress and remaining work

| Item | State | Acceptance evidence / next step |
| --- | --- | --- |
| New remote and local checkout | Migration baseline adopted | PR #1 is merged; the independent checkout retains the original Apache 2.0 license |
| Privacy and usage scope | Confirmed | Migration Q1: public methods/configuration, private business data. Migration Q2: owner-use open source, not a public hosted service |
| Radar design handoff | Reviewed v2 adopted locally | Q1-Q32 reconciled; Q11/Q31 relationship, confirmed trial budgets, pending mappings, and superseded proposals preserved. Two independent material reviews passed |
| Public design files | Reviewed migration baseline | Requirements and profile use Radar v2; decision notes include all five semantic corrections. Public file scope, links, profile invariants and privacy checks passed |
| Legacy code inventory | Prepared locally | 53 Python source files retained as hash-verified local reference copies; external dependencies recorded. These are not installed application modules |
| Provider/Agent migration | Reference handoff received and verified | Six API sources match the preserved copy; ten tests, three dependencies and four historical documents retained locally. Independent reference-transfer review passed. Live state remains disabled and unchanged; standalone adoption is pending |
| Independent application | Not implemented | Architecture and remaining product choices must be aligned; then verify from an isolated checkout |
| Public publication | [Delivery PR #1](https://github.com/Wekhoh/Product-selection-development-tools/pull/1) | Use the PR merge record and remote commit as the publication receipt; this is a design baseline, not an application release |
| App project / future chats | Owner will open two new chats | Selection uses the integration checkout; API implementation uses its own worktree. App registration and actual new-chat adoption require readback |

## Next work

1. Verify this checkout against the delivery PR and remote main before resuming. API technical continuation is in `API-MIGRATION.md`.
2. Use the two reviewed local handoff prompts when the owner opens the new selection and API chats. Confirm each actual working directory and file ownership before editing.
3. The selection development seat continues the unresolved Q11/Q31 substance and Q32, then mapping, missingness and end-to-end acceptance; the API seat continues only compatible authorized preparation.
4. Adopt or rewrite a module only when it serves that agreed design. Verify a bounded offline path before live integration.

No numerical mapping, current provider fee, or complete scoring algorithm has been approved merely by transferring these files. Live scans and paid research remain inactive.

## New-chat recovery

Read this file, then `PRODUCT.md`, `design/DECISIONS.md`, and the draft profile. State what is implemented versus proposed before choosing work. For an ambiguity that requires original evidence, the owner machine has an ignored `.local/migration/README.md` handoff index, reviewed per-question records, and selected original evidence copies; it is not required to understand the public design or run future software. Do not import private paths into code.

Historical question IDs Q1–Q32 refer to the selection design. Migration Q1/Q2 refer only to publicity and usage scope. They are separate decisions.

## Transfer versus implementation

The reviewed public design, selected local source references, decision evidence and API handoff have been transferred. Wider historical evidence remains indexed at its original locations where a local copy was not selected. Credentials, live budget/request ledgers and operation locks intentionally remain at their canonical private locations; copying a folder cannot create a second allowance or independent run authority.

Source adaptation and clean-checkout runtime acceptance remain development work. Existing source packages retain former imports and path assumptions and must not be installed wholesale. UI/trigger architecture, scoring mappings and real-card acceptance are unresolved. The account privacy decision is future-only email protection; history rewriting is not authorized.
