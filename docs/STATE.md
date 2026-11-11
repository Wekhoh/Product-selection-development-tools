# Project state

Updated: 2026-11-11. Phase: selective migration and design alignment.

## Objective and settled scope

Build an independent product-selection tool for the owner's personal use. Source, methods, and reference settings are public under Apache 2.0; actual business data and secrets remain local. Local operation is the initial direction; owner-only self-hosting may follow. A publicly hosted multi-user service is not requested.

The previous whole-store automation project is no longer a development target. Other useful workflows may be extracted separately later; they are outside this migration.

## Ownership

| Area | Owner | Current boundary |
| --- | --- | --- |
| New repository, integration, migration acceptance | Coordinator | Sole writer of the integration checkout |
| Product requirements, scoring design, unresolved questions | Radar | Supplies reviewed candidates; no concurrent writes to the integration checkout |
| Provider APIs, Agent workflows, request recovery and cost state | API integration chat | Owns only the ignored `.local/migration/api-integration/` handoff directory; public integration remains with the coordinator |

Use separate worktrees if implementation is delegated. Do not use the old operating task board as this project's backlog.

## Progress and remaining work

| Item | State | Acceptance evidence / next step |
| --- | --- | --- |
| New remote and local checkout | Prepared | Public repository with its original Apache 2.0 license; separate migration branch |
| Privacy and usage scope | Confirmed | Migration Q1: public methods/configuration, private business data. Migration Q2: owner-use open source, not a public hosted service |
| Radar design handoff | Reviewed v2 adopted locally | Q1-Q32 reconciled; Q11/Q31 relationship, confirmed trial budgets, pending mappings, and superseded proposals preserved. Two independent material reviews passed |
| Public design files | Reviewed baseline in local checkout | Requirements and profile use Radar v2; decision notes include all five semantic corrections. Final publication readback remains pending |
| Legacy code inventory | Prepared locally | 53 Python source files retained as hash-verified local reference copies; external dependencies recorded. These are not installed application modules |
| Provider/Agent migration | Reference handoff received and verified | Six API sources match the preserved copy; ten tests, three dependencies and four historical documents retained locally. Independent reference-transfer review passed. Live state remains disabled and unchanged; standalone adoption is pending |
| Independent application | Not implemented | Architecture and remaining product choices must be aligned; then verify from an isolated checkout |
| Public publication | Pending | Record the actual commit/PR after verification |
| App project / future chats | Local folder ready; app registration pending | New chats must use this folder as the independent project's primary folder |

## Next work

1. Complete publication readback of the reviewed migration baseline. API technical continuation is in `API-MIGRATION.md`.
2. Register this local folder as an app project and use the prepared local new-chat entry when the owner opens a new chat.
3. Continue the product discussion from the unresolved Q11/Q31 substance and Q32, then mapping, missingness, and end-to-end acceptance.
4. Adopt or rewrite a module only when it serves that agreed design. Verify a bounded offline path before live integration.

No numerical mapping, current provider fee, or complete scoring algorithm has been approved merely by transferring these files. Live scans and paid research remain inactive.

## New-chat recovery

Read this file, then `PRODUCT.md`, `design/DECISIONS.md`, and the draft profile. State what is implemented versus proposed before choosing work. For an ambiguity that requires original evidence, the owner machine has an ignored `.local/migration/README.md` handoff index, reviewed per-question records, and selected original evidence copies; it is not required to understand the public design or run future software. Do not import private paths into code.

Historical question IDs Q1–Q32 refer to the selection design. Migration Q1/Q2 refer only to publicity and usage scope. They are separate decisions.
