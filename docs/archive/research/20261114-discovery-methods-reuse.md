# Discovery methods reuse review — 2026-11-14

Status: source research, with proposed adaptations below. No package was installed and no product, supplier, store or model request was made by this research subtask. Current owner decisions and execution status remain in [STATE](../../STATE.md), not this report.

## Finding and reuse boundary

Existing methods support broader discovery without adding more initial scoring dimensions. The project already preserves five routes and three opportunity hypotheses in [PRODUCT](../../PRODUCT.md#discovery-and-analysis). Reuse focused research moves that produce concrete product hypotheses, then test purchase demand and economics. Source diversity is a batch property; each lead need not traverse every route.

The upstream SeaLeap default-branch head inspected on 2026-11-14 was `1283764556e61cbe56c600bbe504b8731b2254cb`, authored 2026-10-16, matching the retained migration map. The repository was not archived. A later metadata update is not a later code release. This focused review reused unchanged migration work rather than auditing the whole library again. [Commits](https://api.github.com/repos/xjli360/sealeap-amazon-skills/commits?per_page=2), [repository metadata](https://api.github.com/repos/xjli360/sealeap-amazon-skills)

SeaLeap's original software/documentation uses MIT licensing, including notice-retention requirements. Its adaptations do not establish permission to republish third-party original content. [License](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/LICENSE), [README](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/README.md)

The inspected generic MCP client accepts a provider, discovered tool and arguments. It is not an accepted automatic discovery-to-card engine. It requires credentials/current schemas and `jsonschema >= 4.18`; its dry-run receipt explicitly says the client does not enforce a spending limit. Source inspection did not include execution or adoption. Existing native connectors are sufficient for the immediate workflow trial; importing this client would not close the business-research gap. [Client](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-audience-first-product-discovery/scripts/mcp_research.py)

## Reusable research moves

| Move | Proposed project use | Important limit |
| --- | --- | --- |
| People and task journeys | Start with a recurring observed activity/problem, identify the work involved, and discover several useful forms before checking purchase vocabulary. | A demographic label is not demand evidence. |
| Cross-category attributes | Expand a sourced construction, material, function or use expression into adjacent categories and group useful physical forms. | Source example thresholds are not universal screening rules. |
| Review problems and scene fit | Distinguish concrete fit/size/structure problems from vague dissatisfaction; check whether an existing form can serve the unmet task. | Complaints do not establish feasible improvement or profitable demand. |
| Explainable recent entrants | Use current category/newcomer observations to find forms and buying reasons, retaining basic launch checks. | Successful examples alone do not measure failure rates; historical exit reconstruction is no longer an initial requirement. |
| Supply capability and tasks | When a verified purchasable form/process is already known, investigate adjacent uses. | Supply is not demand; supplier contact must not become an initial-card prerequisite. |

Primary playbooks: [audience](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-audience-first-product-discovery/references/playbook.md), [attribute expansion](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-cross-category-attribute-keyword-research/references/playbook.md), [review problems](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/youtube/fenghuang/sealeap-fenghuang-amazon-product-exclusion-review-mining/references/playbook.md), [scene fit](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-scenario-led-differentiation/references/playbook.md), [entrants](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-low-review-new-entrant-validation/references/playbook.md), [capability matching](https://github.com/xjli360/sealeap-amazon-skills/blob/1283764556e61cbe56c600bbe504b8731b2254cb/amazon-skills/douyin/xiezhi/sealeap-xiezhi-amazon-factory-capability-market-matching/references/playbook.md).

## Current service methods

Amazon's Product Opportunity Explorer describes demand niches built from searches and subsequent viewing/purchasing. Category, product and suggested-niche entry points need not begin with an owner-provided keyword. Below-benchmark conversion can supply an unmet-demand lead, but does not establish that the proposed product can fix it. Account access and project integration were not tested; no Seller Central browser session was opened. [Official overview](https://sell.amazon.com/tools/product-opportunity-explorer)

Google Trends uses sampled, normalized interest. Low-volume terms can show zero, and isolated low-volume spikes can be statistical noise. Use it to investigate region, season and events after obtaining a sourced expression; it is not an Amazon sales proxy. Stable demand can remain useful without a spike. [Official FAQ](https://support.google.com/trends/answer/4365533?hl=en)

## Implementation implications and verification

Use one compact lead record across routes: source/time, concrete task/form, reason to investigate, purchase-demand evidence, possible fit gap, approximate economics and decisive unknown. Raw leads are not finished cards. The owner's initial cards still require the adopted scoring scope; moving detailed research after retention does not authorize calling unscored leads complete.

Measure distinct reviewable directions per research hour, source diversity, time to supported scores and later rejection reasons. More keywords alone is not evidence of better discovery. Try source-led attribute/task expansion alongside keyword-library retrieval before adding orchestration infrastructure.

Coverage: retained migration method map, current project requirements, repository/commit/license metadata, six focused original playbooks, one method skill and one generic client, plus the two official service pages above. The full upstream catalog, live throughput and commercial usefulness were not evaluated. The reviewed methods are available references, not a claim that each route is already automated.
