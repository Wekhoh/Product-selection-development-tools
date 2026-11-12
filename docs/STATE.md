# Project state

Updated: 2026-11-12. API worktree checkpoint: ownership narrowed; no new implementation assignment.

## Current API-seat recovery checkpoint

The owner's 2026-11-12 clarification supersedes earlier broad provider ownership: the selection development seat owns SIF, SellerSprite and other selection-data MCP calls, data validation and workflow integration. This API seat owns OpenAI API tool development and compatibility, including OpenAI-specific input/output, error, cost and recovery contracts when commissioned. The clarification was received from the selection seat and checked against its current project working agreement and state record.

The selection seat completed its own bounded native SIF probe. No selection-data query, probe reconciliation or duplicate call is assigned here. The earlier API-seat Q31 capability investigation remains historical design evidence; it does not retain ownership of selection-data integration. This record update grants no new spending, access or development authority.

The integration checkout's `docs/STATE.md` remains the maintained project-wide recovery record. The migration baseline below is retained in this separate API worktree and does not mirror the latest business definitions. Before accepting a concrete OpenAI assignment, reconcile its scope with the current integration record and agreed first-release workflow. No OpenAI implementation task is currently queued here; no provider activation is implied.

## Objective and settled scope

Build an independent product-selection tool for the owner's personal use. Source, methods, and reference settings are public under Apache 2.0; actual business data and secrets remain local. Local operation is the initial direction; owner-only self-hosting may follow. A publicly hosted multi-user service is not requested.

The previous whole-store automation project is no longer a development target. Other useful workflows may be extracted separately later; they are outside this migration.

## Ownership

The owner chose two ongoing chats on 2026-11-11. This replaces the earlier three-seat migration arrangement.

| Area | Owner | Current boundary |
| --- | --- | --- |
| Product design, application development, repository integration and final acceptance, including selection-data MCP calls, data validation and workflow integration | Selection development seat | Owns SIF/SellerSprite and other selection-data work; sole writer of the integration checkout |
| OpenAI API tool development and compatibility | API and Agent integration seat | Owns commissioned OpenAI-specific input/output, error, cost and recovery contracts; develops in a separate worktree/branch without concurrent edits to the integration checkout |

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

1. Await a concrete OpenAI API development or compatibility assignment tied to the agreed product workflow; this ownership correction is not such an assignment.
2. Read the current integration checkout's project state and applicable working agreement before resuming implementation. Keep this API worktree separate and preserve other writers' changes.
3. Reuse existing OpenAI technical research and the inactive reference material in `API-MIGRATION.md` where relevant. Earlier SIF/SellerSprite findings are historical evidence, not pending API-seat queries or integration tasks.
4. Adopt or rewrite an OpenAI module only when it serves the agreed assignment. Verify a bounded offline path before separately authorized live integration, preserving shared-account, cost and request-recovery constraints.

No numerical mapping, current provider fee, or complete scoring algorithm has been approved merely by transferring these files. Live scans and paid research remain inactive.

## New-chat recovery

Read this file, then `PRODUCT.md`, `design/DECISIONS.md`, and the draft profile. State what is implemented versus proposed before choosing work. For an ambiguity that requires original evidence, the owner machine has an ignored `.local/migration/README.md` handoff index, reviewed per-question records, and selected original evidence copies; it is not required to understand the public design or run future software. Do not import private paths into code.

Historical question IDs Q1–Q32 refer to the selection design. Migration Q1/Q2 refer only to publicity and usage scope. They are separate decisions.

## Transfer versus implementation

The reviewed public design, selected local source references, decision evidence and API handoff have been transferred. Wider historical evidence remains indexed at its original locations where a local copy was not selected. Credentials, live budget/request ledgers and operation locks intentionally remain at their canonical private locations; copying a folder cannot create a second allowance or independent run authority.

Source adaptation and clean-checkout runtime acceptance remain development work. Existing source packages retain former imports and path assumptions and must not be installed wholesale. UI/trigger architecture, scoring mappings and real-card acceptance are unresolved. The account privacy decision is future-only email protection; history rewriting is not authorized.
