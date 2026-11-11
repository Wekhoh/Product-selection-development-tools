# Product selection development tools

An independent, open-source product-selection tool for personal use and optional self-hosting.

**Current stage: requirements alignment and selective migration.** The project is not yet a working automated selection application. The design profile is a discussion artifact; importing it does not activate scoring, research, or external requests.

## Start here

- [Project state and next steps](docs/STATE.md) — the single task and recovery record.
- [Product requirements](docs/PRODUCT.md) — intended workflow and acceptance.
- [Decisions and unresolved questions](docs/design/DECISIONS.md) — confirmed preferences, exceptions, and superseded proposals.
- [Reference profile](docs/design/reference-profile.draft.json) — confirmed trial budgets with unresolved values preserved as null.
- [Migration boundaries](docs/MIGRATION.md) — what is retained and what needs redesign.
- [Provider integration handoff](docs/API-MIGRATION.md) — preserved API behavior, unresolved compatibility, and cost continuity.

The public repository contains methods, design documents, reviewed reusable code when adopted, and synthetic examples. Each installation owns its credentials, research results, quotations, spending records, and other private data. Those do not belong in public Git history.

The first version is for its owner's use. Other developers may inspect, fork, or adapt the source. A hosted multi-user service is outside the current scope.

## Development workspace

Use this checkout as a separate project's primary folder. Start new chats here and read `AGENTS.md` and `docs/STATE.md`. Do not attach the retired operations repository as a prerequisite. Additional contributors should use separate branches/worktrees with explicit file ownership.

In the Codex app, add this folder as a local project; existing chat membership and folder access are separate from cloning. The current source baseline contains design documents only, so no application install or launch command is advertised yet.

Licensed under [Apache 2.0](LICENSE).
