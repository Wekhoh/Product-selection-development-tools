# Provider integration migration status

Status: inactive reference material; standalone runtime adoption is pending.

The preserved selection workflow supports public-signal discovery, evidence-bound candidate research, Decisions triage, bounded Responses generation, and local review. Its former default model policy uses `gpt-6-luna` for Decisions and `gpt-6.1-sol` for research/discovery. These are historical implementation values, not a current model recommendation or an approved new product default. Native Agents creation/spending-control compatibility remains unverified; the implemented research path uses Responses.

The six core modules cover HTTP transport, budget reservations and operation locks, response lifecycle/recovery, discovery provenance, research orchestration, and evidence review. The migration preserves seven direct test files and three caller/integration test references. Existing adoption and CI results apply to the former application; no standalone port has been accepted.

Before adopting code, replace the former package/configuration/data-root coupling with the new project's agreed contracts. Preserve missing versus zero, source integrity, request identity, output bounds, model/usage verification, and evidence persistence. Keep ambiguous submissions unfinished, retain their budget reservation across accounting boundaries, halt later submissions, and recover only the original request. Preserve complete raw responses before cleanup and require independent terminal/usage/cleanup readback. A moved folder or an error does not refund a reservation or authorize a replay.

Use one reconciled spending state for any shared approved allowance. Reservation values are not posted bills or promotional-credit balances. Credentials, live ledgers, account identifiers, raw payloads, and real candidate records remain private local state. Migration does not activate providers, schedules, scans, or store operations. Paid acceptance requires its own current authorization and cost reconciliation.

Python 3.12 or later, requests, PyYAML, SQLite, and platform file locking are reference implementation dependencies. Later adoption must check actual supported versions, preserve applicable Apache 2.0 notices, validate isolated execution, and review the actual publishable files. This note does not decide the user interface, hosting, ownership of credentials, or product scoring design.
