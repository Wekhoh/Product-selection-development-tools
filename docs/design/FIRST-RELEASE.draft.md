# 第一版需求与验收草案：承接原雷达的主动发现流程

## Implementation-ready slice: bounded discovery-to-card trial (2026-11-14)

The owner authorizes executing the complete bounded workflow and implementing the reusable deterministic parts now. This slice reuses native SellerSprite/SIF and the permitted browser tools, the existing revision-50 profile and saved evidence. It adds a small offline Node.js runner and self-contained local HTML cards; no UI framework, hosted service, model orchestration platform or new provider credential is needed. The concrete gap is reproducible application of this project's approved mappings and a readable source-linked result; upstream market tools provide observations, not these owner-specific rules. Broader runtime/deployment/reuse selection remains separate.

Inputs are a versioned local batch: discovery leads with source/date and disposition; concrete candidate form/bundle; evidence references; one declared market/cohort; normalized metric observations; bounded AI rubric judgments with supporting/contrary evidence; and coherent economics scenarios. Observations use explicit unknown reasons rather than zero. Public fixtures must be synthetic; real batch inputs and generated cards remain local.

The calculation module exports deterministic item scoring, whole-card aggregation and ordering. It accepts explicit trial inputs and the frozen profile; importing it performs no I/O, requests or production activation. It applies all 21 adopted mappings, validates units/ranges and preserves null versus observed zero. Qualitative values must name an adopted rubric anchor and evidence references; code validates and maps the anchor but does not claim to verify the underlying judgment. Newcomer cohort selection and shared-pair aggregation follow r50, with source-native 3/2 ratios kept distinct from qualified-cohort 4/1 evidence. Economics scenarios share a saleable unit and assumptions; full totals, conditional bounds and queue ordering follow the existing profile without renormalization or invented midpoint.

The runner reads local inputs, writes JSON plus Chinese HTML cards and a measured execution receipt, and supports a clean-checkout synthetic example without network access or another repository. Saved-card viewing and recomputation must not submit provider requests. Each card shows discovery provenance, concrete form, screening state, item input/evidence/reason, supported versus missing points, scenario assumptions, unresolved retrieval actions and rule/evidence versions. Pending cards cannot display a complete quality score.

Acceptance: a fresh sourced discovery path and the saved real cohort are traceable through research to cards; all 21 items are attempted with an actual value or an evidence-backed specific blocker. Fully scored cards and partial cards are counted separately. Focused tests exercise ordinary mapping boundaries, invalid/missing data, shared cohorts/scenarios and ranking. Repeated offline computation is stable, a clean checkout runs the synthetic fixture, local desktop/mobile layouts are readable, and the exact publishable set passes privacy plus independent economics/recovery review. Actual native calls, data coverage, stage timing and unresolved gaps are recorded separately from source adoption or business usefulness. Failure to obtain a required metric remains an open product gap, not a silent waiver or a claim of completed full-score acceptance.

Current scoring checkpoint (2026-11-13, profile revision 50): all 21 item mappings and the coherent shared total/interval/missingness/order package are accepted for trial, including the revised native-market 3/2 reference, current-basis 4/1 comparison, stable exemplar ties and two-source keyword corroboration. The owner directs continuation from saved real products. Weights, curves and exclusions remain unchanged; acquisition/judgment, calibration, whole-flow performance and business effects remain unverified, with production/import activation false.

Earlier allocation checkpoint (2026-11-13, profile revision 43; superseded by revision 44): the owner accepted removal of standalone entry barriers. The 10-point competition group now has three active concentration items with replacement weights pending; the 2/2/6 proposal and subsequent 3/3/4 recommendation are not adopted. Observable seller scope and all unrelated formulas remain unchanged.

Earlier seller-scope checkpoint (2026-11-13, profile revision 42; its weight snapshot is superseded above): use observed seller IDs/names, brands and product records supported by the available tools. Hidden cross-shop company tracing is outside this version's scope and is not a prerequisite for scoring or initial cards. Verify same-account grouping, parent-family deduplication and niche applicability separately; a listing's seller field is not an actual order-allocation ledger. The bounded two-request seller probe passed field/linkage checks, not whole-flow or scoring acceptance. The 4.5-point weight and unresolved concentration/entry-barrier mappings are unchanged.

Earlier whole-product checkpoint (2026-11-13): broader implementation and acceptance choices remained open. The bounded slice above supersedes that readiness restriction only for its stated scope; it does not establish complete real-card or scheduler acceptance.

本文承接 [产品要求](../PRODUCT.md)、[已定与待定决策](DECISIONS.md)、[试评配置草案](reference-profile.draft.json) 和 [领域术语](../../GLOSSARY.md)。唯一任务与恢复记录是 [STATE.md](../STATE.md)。下面区分已经确定的需求与仍需设计的实现，不要求主人重新批准旧决定。

Latest staging clarification (2026-11-13): after the trial definitions, run a bounded real workflow to expose time/data/judgment obstacles. Suitable deeper checks may move after owner retention if they hinder useful card output. Keep initial evidence, material gaps and exclusions visible; this is not a blanket waiver; revision 50 separately adopts the shared ordering rules. Measure fully supported and partially scored cards separately without hiding the latter or calling either business acceptance.

## Execution readiness and test boundary

This is the single first-release specification in progress. Distinguish unresolved decisions, empirical feasibility and implementation readiness; the remaining work is not a backlog of 21 unanswered score formulas.

| Subject | Current definition and completion condition |
| --- | --- |
| Product purpose and business limits | Proactive discovery, code/AI cooperation, owner review, the 100-point trial budget, initial-versus-deep research and existing action/privacy boundaries are recorded. Reuse them. |
| Item scoring | All 21 mappings and shared conventions exist at revision 50. Real input availability, grouping and judgment quality require verification; an adopted curve is not a passed data path. |
| Shared scoring choice | Revision 50 adopts totals, supported versus conditional ranges, missing inputs, ordering and Q31 comparison conventions. Native-market 3/2 replaces the prior narrow ratio basis; qualified genuine-niche 4/1 remains separate. Validate implementation and real inputs against these accepted rules. |
| Bounded feasibility trial | Reuse the saved real returns and request identities identified in STATE. Freeze the form, comparison membership, grain/window and applicable rule version before calculation. Explain every material unavailable item and its remedy. This experiment can demonstrate source-to-score feasibility before a production application exists. It cannot pass complete economics while required matched procurement or other applicable cost inputs remain missing. |
| Formal first-release development | Settle the end-to-end release behavior and consequential shared rules, select a maintained implementation/reuse boundary, verify that the actual Codex execution entry can access needed tools, and define the selected workbench interaction and recovery behavior. Turn that scope into complete tasks and observable acceptance in STATE. A data probe does not select desktop/browser/deployment or enable daily execution. |
| Performance and later calibration | Measure useful distinct output, first-batch wait, stage effort, errors and cross-batch stability before setting realistic throughput targets. Review strong, weak and pending cases across later categories. No arbitrary daily card quota, accuracy target or universal research timeout is introduced here. |

Write acceptance before coding. During development, test at the highest useful boundary that exposes the intended behavior: supported evidence through normalization/judgment inputs to calculations, saved cards and readback. Use focused failure cases for missing/conflicting data and interrupted or duplicate work. At the end, exercise the real selected entry and workbench together, plus clean-checkout offline operation and authorized desktop/mobile checks. Tests run throughout development; final acceptance is an additional check of the whole result.

### Information each stage must hand over

These are required business contents, not an adopted transport, database or module framework. The implementer defines concrete field names and supported interfaces from actual sources; routine schema choices do not need another interview. A material change to what is scored, what the owner sees or what may be spent still needs its applicable decision.

| Handoff | Required content | Verification target |
| --- | --- | --- |
| Discovery to research | Original signal/source/date, intended buying use, provisional form/bundle when known or explicitly unresolved, why it merits investigation, collection coverage | A sourced keyword or use lead may enter research before a specific product is known. Freeze the concrete saleable form/bundle before its economics, comparable-sample calculation or scoring; never invent them merely to satisfy a handoff (V1-02, V1-12). |
| Sources to analysis | Original field and local evidence reference, source population, observation window, units, family/variant scope, missing/conflict state | Preserve the actual meaning before conversion; sales-ranked samples are not relabeled BSR snapshots, and dimensions/load claims are not assumed packed measurements (V1-04, V1-12). |
| AI judgment to scoring | Included/excluded/pending comparators and reasons, rubric anchor, supporting and contrary evidence, material unknowns | The score follows a traceable bounded judgment; correct grouping errors before changing weights (V1-04, V1-13). |
| Scoring to card | Candidate/evidence/rule version, coherent economics scenarios, item inputs and results, screening state, explicit gaps, adopted total/order behavior | Repeated calculation on the same validated inputs is consistent; no invented zero, midpoint or renormalized total; incomplete work is visibly incomplete (V1-03, V1-04). |
| Card to review and continuation | Saved card, owner disposition and reason, changed evidence/version, unfinished work and next action | Readback works and continuation targets the right candidate/version; viewing a saved result does not resubmit research (V1-05, V1-06). |

When a required score cannot be supported, distinguish not yet queried, failed retrieval, incompatible source meaning and genuinely absent data. Retain evidence and a concrete repair/retrieval action in the existing task record. Present a consequential new proxy or deferral to the owner, then recompute dependent results after resolution. Persistently unavailable important dimensions remain a product gap. The owner's separate 1688-browser investigation does not itself establish a working procurement path or permit an alternative foreign-platform cost.

For calibration, keep the observed fact, the owner's experience-based explanation, the implementer's inference and the later measured outcome separate. A high native newcomer share describes the sampled links' age composition; broader causal interpretations are hypotheses to investigate. Record agreed rule changes with their reasons and test other cases, rather than silently training the score to agree with every individual reaction.

## 已确定的日常主流程

**系统每日主动从真实市场资料发现方向 → 明确具体款式 → 初筛和简卡 → 优先项精筛、补证与重排 → 按确定后的多维规则评分、交卡 → 主人审选并留下反馈。**

广选简卡与优先项深查承接 Q1；综合打分承接 Q2；按综合分呈现、每页十个不同方向承接 Q20。初筛已有的有据评分可随补证更新，不要求先等主人点选才开始市场分析、经济测算或评分。十个是每页展示量，不是每天必须凑足的产出数量，也不是研究或采购上限。

主人不必每天发送启动消息、指定类目或关键词。主人可以另外提出专项需求、追问卡片及改变研究方向，但这些是补充入口。每日主动工作的要求已确定；具体时点、可用运行环境、发现覆盖与研究资源安排还未定，也没有授权现在启用调度或发起业务请求。

本项目是继续改造原雷达。此前固定词池的执行记录和未接通的主动发现入口，不能代表没有市场机会；新流程也不能把随机想到一个词再反查包装成市场发现。

## 发现从哪里开始

| 入口 | 要找的线索 | 必须保留的判断边界 |
| --- | --- | --- |
| 关键词词库，主入口 | 有来源的需求规模、热门或异动词、持续增长、细分购买用途与属性 | 不先编固定词表；低基数、短期事件、节日与不完整窗口不能当持续增长 |
| 商品库、榜单和市场记录 | 有销售记录的具体款式、新品、垂直细分及相邻机会 | 排名只是线索；宽 BSR 节点与直接细分市场分开，核真实起步 |
| 有据商品的反查 | 流量词、相邻款式、公开同店产品 | 起点须有来源；不能把关联商品都当独立成功样本 |
| 评论与使用场景 | 反复出现的任务、痛点和现成方案的不匹配 | 同时可发现新方向；痛点不自动证明有购买需求或我们能低成本解决 |
| X、Reddit、Pinterest 等辅助入口 | 新用途、购买诉求、趋势与痛点 | 保留原文来源、时间和阅读范围，回到站内验证需求、供给和经济性 |

增长型、稳定型、供给缺口型均可研究。一个词可能对应多个实质款式，多个词也可能指向同一个款式；颜色小变不能虚增机会数量。每张卡须能回答“从哪里发现、为什么值得研究、对应什么具体方案”。

卖家精灵、SIF 是拟使用的主要市场资料来源，实际能力逐项核实。历史接口声明支持部分无关键词起始的检索，不等于已验证当下权限、返回质量、分页、覆盖或费用。具体筛选条件、扩展与刷新办法、各入口分配和研究优先级仍需设计；不能偷偷恢复最低评论数、固定 CPC 或宽类目新品比例硬线。

## 一轮日常工作中各方做什么

以下是职责说明，不是已选定的技术架构或新业务规则。

| 环节 | 主人的操作和结果 | Codex / AI 的工作 | 脚本及项目工具的工作 | 可能的外部调用 |
| --- | --- | --- | --- | --- |
| 周期开始与恢复 | 无须当天发消息；之后可看本轮状态 | 读取项目策略、既定偏好、上轮决定与待研究事项 | 识别周期和执行身份，读检查点，核对原未知请求、权限和额度边界，避免重复执行 | 读取本机记录不需模型 API；恢复查询依提供方能力 |
| 主动发现 | 不需要先想类目或给种子词 | 从上述入口判断需求、用途与可继续追查的线索 | 执行已有授权内的数据查询、分页及可确定的去重，保存来源和覆盖 | 市场数据或公开资料工具；具体服务额度单独核算 |
| 定义款式并初筛 | 后续能查看来源、研究理由及初筛结果 | 定义用途、材质、结构、尺寸、功能和组合，判断可替代性与证据适配 | 校验单位、窗口和缺项；按已定条件检查具体方案，不以未知填零 | 必要且已获准的补证；初卡不依赖供应商消息、样品或实际发货 |
| 优先项精筛与重排 | 不需要先点选才发生；不同方向可同时保留 | 研究同细分竞争、正常新品、购买入口、成本匹配、权利与准入线索，解释反证 | 固定对应证据版本，按已批准规则复算经济模型与分项；记录变动及未完成项 | 按实际缺口取数；不是对所有线索无上限深查 |
| 评分与交卡 | 工作台呈现有据评分、排序、扣分原因及待补证项，再由主人审选 | 对需要判断的指标给出依据、推断和限制 | 使用最终确定的权重、映射和缺证规则；持久化卡片、分项和本轮完成情况 | 查看已保存结果及纯计算不需要另一次模型调用 |
| 审选与反馈 | 主人比较、保留多个方向、暂缓或要求继续研究，并保留理由 | 回答追问，结合新证据继续研究，后续读取既有决定 | 将操作绑定明确候选及版本，记录反馈和后续证据变化 | 只有具体补证才产生适用的新调用；询价等仍遵守独立授权 |

发现起点可以没有候选和候选证据；取得线索后才形成相应证据快照。不能把后续分析需要冻结证据的技术约定，变成发现之前先由主人提交候选材料。

“先研究谁”是研究优先级，“这个产品有多适合”是机会评分；两者不能互换。缺证处理和重排已按修订50确认，缺项仍不能假装已有完整总分；也不能因此把第一版改成只有未评分卡片的资料查看器。完成评分定义和校准仍是交付要求。

## 主人看中方向之后怎样接续

主人随后重申的完整经营流程继续保留：**AI 主动发现、筛选、估算和打分交卡 → 主人逐项审看数据并复算 → 看中的方向进一步核实 → 核准后小批下单、发货测款 → 按实际反馈决定是否补大货。**

初卡前的精筛，是凭可取得的公开资料和有来源估算研究市场与具体款，给出费用项目、毛利估算、依据和待核项。主人选中后的深入核实，则包括具体款的权利情况、供应商真实供货规格、完整包装的重量体积、实际报价与费用，再由主人复算。两段工作衔接，不能把后段必须联系供应商或实测才能取得的证据，变成初卡的前置条件。

初选仍保留已有的公开权利和准入风险初查；进一步核实不能倒推成初卡已获全面安全结论。小批测款和补货是后续经营阶段，需保留真实反馈；这里记录的是成果如何被使用，不表示已经下单，也不把采购、发货或补货自动化加入第一版实现范围。

## 工作台与 Codex、脚本和 API 的关系

主人已确认独立可视化工作台，重视高频使用的方便程度和视觉体验。浏览器、本机应用或仅供主人使用的部署形态尚未选择；另建一个模型聊天框也未批准。如何让 Codex 读取工作台所选对象和证据，需要实际实现与验证，不能假设会话自动看见页面。

主人已选择订阅 Codex 作为主研究方向。固定计算、校验、保存、状态恢复等用脚本或普通代码；需要理解与调查的工作使用 AI。市场数据 API 与单独的 OpenAI 模型 API 是不同调用，前者可能消耗第三方额度，后者仅用于具体选定且获准的辅助能力。订阅不可用时，不自动改走付费模型 API。

API 席已交付原生周期执行的技术调查，建议优先验证现成入口与项目工具的组合。该调查是选型输入，不是本项目已经每日运行的证据。实际认证和用量、订阅包含额度与额外 credits、电脑及应用可用性、休眠或离线期间的行为仍需在所选入口验收。

候选可以长期接续；每次页面选择或后续研究须绑定任务、候选及可核对的版本或证据快照。旧页面、其他会话改选、候选更新或版本缺失，不能静默串用对象。新的补证可形成关联的新执行身份，但不能覆盖正在恢复的旧请求和冻结输入，也不能借新身份绕过原未知请求的阻断。

## 本轮供主人评估的执行路线

状态：2026-11-11 的实现路线。主人听取说明后，接受分阶段、代码与 AI 配合的方向，要求先明确并记录必要定义，再试跑完整流程、按交付质量调整。阶段原则已定，具体运行架构、算法细节与性能仍未选定或验收；不重新选择产品形态，也不取消每日主动发现的目标。

建议先验证一个主流程：**Codex 使用现成 MCP 取市场资料 → 调用本项目普通代码校验、计算和保存 → 对需要理解的证据作判断、提出必要补查 → 固定规则计算分项与排序 → 工作台读取保存的卡片。** MCP 是取得资料的接口，Codex 负责分析，脚本负责可重复的计算；三者是分工，不是互斥的三种产品。不能假定独立脚本天然能调用当前聊天的 MCP，也不能假定将来周期入口自动拥有本聊天的工具。具体入口的可用性必须单独验证。

| 步骤 | 建议怎样取得资料、怎样执行 | 交给下一步什么 | 尚需验证 |
| --- | --- | --- | --- |
| 1. 主动发现 | Codex 调卖家精灵的关键词选品、ABA 周／月选品或商品筛选 MCP，按约定条件取得列表。当前声明中产品词为可选输入，因此可从市场筛选开始。增长、稳定和供给缺口保留不同研究理由；脚本保存来源、周期、分页和标识。 | 有来源的词、商品或用途线索，尚非推荐购买的产品。 | 实际账号访问、可用字段、分页和覆盖；查询条件与研究量尚未定。工具的“潜力”标签不等于通过项目判断。 |
| 2. 初筛与款式归组 | 脚本核日期、单位、重复 ASIN／父体及明确筛选条件；Codex 判断购买用途、对应实物及是否明显不匹配，辨认季节／事件等解释。 | 明确具体款式、保留／排除／待补证的原因，以及继续研究的价值。 | 语义分组质量和缺字段处理。不得用关键词平均售价直接淘汰其中可能符合条件的高价具体款，不采用工具自带利润值代替完整毛利。 |
| 3. 优先项精筛 | 对同细分复用同一份适用市场样本；按缺口调用商品详情、父子销量、BSR／评分历史、流量词和 SIF 曝光资料。Codex 比较替代关系、正常起步与反证，查同规格公开供货／包装及适用费用证据；脚本核对口径并计算经济模型。 | 可回溯的经济估算、竞争与新品证据、判断理由、冲突和缺口。 | 公共成本资料匹配和完整性、历史覆盖、父子归属；是否需要再补查由该证据能否改变判断决定。初卡不等询价或样品；不要求查全隐蔽关联与所有失败者。 |
| 4. 评分与重排 | 数值项由脚本执行批准后的映射；需要语义判断的项，Codex 按明确锚点给出证据、反证及判断，脚本核验输入并换分。补证后重算，再按约定缺证规则排序。 | 每项依据、得分或未知、规则版本、与上次变化及完整／部分状态。 | 修订50已有21项完整试评规则，并已确认整卡总分、区间、缺证排序及新品参照调整。取数与判断质量、跨类目校准仍需实测。研究优先级不能冒充最终总分，AI 不临场改权重。 |
| 5. 保存与交卡 | 工作台读取本地保存结果，展示多个方向、分项、经济测算、来源与未完成原因；主人审选并留下具体理由。 | 可继续追问、补证、复算和比较的卡片与反馈。 | 实际持久化、恢复、用户操作和电脑／手机阅读验收；现阶段没有已运行的独立应用。 |

评论与社媒是可触发新方向的辅助入口，不要求每张卡在所有平台重复跑一遍。建议先用现有公开搜索／页面读取找具体讨论，再回到站内验证；只有具体缺口需要交互时才考虑符合当前权限的浏览器操作。X、Reddit、Pinterest 的实际访问和覆盖尚未验收，不承诺完整抓取，也不因缺一个社媒来源而无限等待。这里没有新增爬虫平台、账号接入或抓取授权。

上述先验证主链的建议不删除其余已保留的发现路径，也不批准一个缩水的最终版本；各路径怎样接入与分配研究量仍需按实际价值、资源和需求确定。默认不为每个阶段建立一个常驻 Agent 或单独服务。优先复用现成能力，只有具体缺口才适配代码。

主人已接受研究深度分阶段：出卡前完成有依据的市场研究、经济估算和评分；保留卡片后，再针对复杂关联、异常原因、运营打法等做更深入的联合研究。已发现的异常与缺口仍须在初卡上显示。AI 在出卡前就参与款式识别和证据判断；后续也继续使用脚本整理、校验和复算。每阶段的最低证据与补证停止条件仍需定义，不能以留到后面代替实质分析。

### 分组在哪个阶段完成

2026-11-12，主人在听完分工说明后确认阶段安排：**初筛轻量归组 → 优先项精筛核实比较样本 → 出卡前脚本计算与评分 → 主人保留后做更深验证。** 发现阶段从有据线索开始，不要求先完整研究所有产品。初筛由 Codex 利用已经取得的用途、标题、规格等做暂定归组，脚本检查标识、单位与明确条件；不为所有线索立即逐页深读。进入优先精筛后，Codex 才针对会改变入组结论的材质、功能、尺寸和使用证据补查，保留明确可比、非直接可比及待核的依据，脚本按相同版本的成员与日期计算分子分母。生成评分卡前必须处理影响结论的分组缺口或如实呈现未完成状态，不能等主人选中后才第一次判断细分市场。此处确认的是阶段设计，实际分组质量、取数覆盖与耗时仍待 V1-12 验证。

主人选中后，再深入核实材料真实性、实测承重／耐用性、完整包装和供应商承诺，必要时修正归组与依赖它的评分。初卡使用有来源、标明限制的公开证据，不将宣传承重当实测结论，也不把样品验证变成所有初卡的前置条件。同一细分复用适用证据和样本；脚本与 LLM 都不应重复研究已核对且未变化的内容。

材质判断的证据顺序建议：先确认买家的必要用途、性能和是否指定材质，再核对具体款规格、说明、图片及可得使用反馈；材料名本身不决定入组。无规格或相互矛盾时保留待核。Codex 承担语义分析，代码执行已明确的检查和计算；二者的实际准确率、速度和资源消耗均需测试。该安排细化现有混合路线，未选择新的模型 API、框架或独立 Agent 服务。

### 一条合成线索怎样经过这条链

假设市场查询返回与水槽下收纳有关的真实数据记录，这里只演示处理方式，没有查询或认定该市场存在机会。Codex 要区分固定隔板、抽拉篮与可绕管结构；颜色小变归组，影响使用和成本的实质款式分别研究。不能把整个收纳类目当成这些款式的同规格参照，也不能只凭标题里都出现 organizer 就合组。

如果一个父体同时销售固定架与抽拉架，其总件数可以支持父体层面的观察，却不能证明目标抽拉款获得了同样的销售进展。若取得的历史评分与进榜观测不是同一时刻，就保留时间差；查不到对应历史时不拿今天的评分回填。这个例子说明部分工作适合程序核对，部分需要证据解释；当前还没有实测自动判断正确率。

### 评分如何可追查、如何校准

每项应能沿着“来源和日期 → 原始字段及单位／对象 → 必要的解释与反证 → 当时采用的规则 → 分项得分”回查。数值数据由固定计算转换；定性项先定义可检查的判断锚点，再交给 Codex 判断。多维联合解释用于发现矛盾和重复信号，不能变成 AI 随意给整体印象分。

主人对联动判断与因果追溯的可行性提出疑问，实施方建议把验证拆到具体错误上：先确认真实接口是否能提供所需对象和同期数据，再检查归组、正常起步参考和评分依据，最后检验相同证据与规则下的判断稳定性、出卡质量及耗时。选取清楚、边界模糊、缺证和相互冲突的案例；数量、容差及正式通过标准仍待约定。复用已有且适用的历史材料或合成材料只能验证相应部分，不能替代当前真实返回与完整自动流程。此处是验证方案，未开始试跑。

Traceability means recovering the adopted evidence, judgment and formula; it does not establish the true cause of a competitor's success. Few ratings, sales progress and natural visibility do not prove no external promotion, low acquisition cost or repeatable profit. Store shared evidence once and reuse it where applicable. If a mixed family was grouped incorrectly, correct the sample and recompute affected metrics rather than adding a generic suspicion penalty. The accepted item-specific overlap boundaries are consolidated in [the existing overlap review](../reviews/20261113-scoring-overlap.md). Money is counted once, source agreement adds no points, and distinct adopted preferences retain their weights without an extra interaction adjustment. Their combined sensitivity still needs real-sample calibration. These rules require neither an agent per metric nor a general causal-inference framework.

上述验证方向参考 [OpenAI 的任务评估建议](https://developers.openai.com/api/docs/guides/evaluation-best-practices)：采用具体任务案例、记录实际过程并结合人工反馈，不能以结果看起来合理代替测试。这仅支持方法选择，不证明本项目已具备所需质量，也不选用新的托管评估服务或产生付费调用。

主人否定一张卡时，先定位原因：拿错数据、款式混组、推断不足、映射不合适，还是偏好发生变化。比如误把固定架的销量当抽拉款销量，应修证据适配，而不是先提高竞争权重。确需调整指标、配分或锚点时保留版本和理由，重放有不同特点的旧案例，再看未参与调整的新案例；不把“这次意见一致”说成未来盈利已经得到证明。

主人进一步要求不同类目、多轮真实样本校准，防止过严漏掉潜力款或过松导致虚高。每轮除审高分卡，还应复核有合理机会线索的低分、排名靠后和待补证案例，检查它们在哪一步被漏掉；不能只展示最终高分结果证明评分有效。保留规则版本、原始依据、主人审选理由及后续可得的供应链／测款反馈，区分市场判断、数据错误、供应不匹配和实际经营结果。调整后的规则需在未参与调参的案例上再检查，不为某一个已知答案反复改权重。具体类目、轮数、研究量及合格标准仍待约定，此要求不启动实际扫描。

主人明确：后续供应链匹配不属于当前选品交付要求，没找到合适供应商，本身不证明选品错误；如果初始采购成本或规格证据取错，仍要修正相应证据与计算。首批实际件数由主人结合资金决定，不作为出卡的前置问题。2026-11-13 已确认取消独立“首批货物投入”6 分，将其转入需求，按规模4／机会证据6／购买入口匹配6试评。原配分保留为历史；单件采购、包装、头程等成本仍须计算，后续按主人决定的数量核算资金。随后已确认需求整组试评规则，记录于修订38及[需求试评规则](DEMAND.draft.md)；实际取数、判断质量和多类目真实样本校准仍待验证。

### 耗时与产能怎样回答

2026-11-13 主人补充：多智能体的考虑针对整条发现到出卡流程，同时解决持续产量和上下文负担，不只针对关键词算分。二三十个词批量处理原则上可行，但尚未确认固定词数、并发数或具体计分公式。必须持续提供足够多、互不重复且有证据的选择；“一百张可能也选不中一张”是对筛选命中率的提醒，不是每天一百张的承诺。供应链未匹配、主人未选中和研究判断错误分别记录。

受控试跑应同时记录首批等待、单位时间新增可审选卡数、重复率、缺证和判断／算分错误，并比较前后批次是否漏规则、串候选或丢证据。按候选或可复用的市场任务隔离上下文、保存中间证据并交回结构化结果，是待验证的方案；主席继续整合和最终核验，不增加常驻席位。必要时用相近任务和同一规则版本比较串行与小规模并行，不能只看最快一批，也不能靠遗漏必要分析增加产量。具体编排、并发数和验收数值需根据试跑及既有方案研究确定，本次没有启动智能体或实际流水线。

当前只能确认若干字段和工具入口的声明，**整条流程每轮要多久、能处理多少线索、能交付多少合格卡，以及语义判断质量均未实测**。关键词数、具体款数、精筛完成数和可用卡数分开计，不能把“接口返回 100 行”报告为“分析完 100 个产品”。

在必要定义完成后，建议先用合成材料或已保存的本机证据走通有限的完整流程；随后在另有明确取数授权的情况下做真实小批验证。记录各阶段耗时、实际请求与可观察用量、复用的数据、有效字段覆盖、完成／待补证数量，以及影响判断的错误。先测瓶颈，再确定批量、并发与每日容量，不能靠无限重试或无限深挖满足出卡目标。离线验证不证明当前接口可用、真实速度或商业效果。

必要的运行边界包括每轮研究范围、时长／请求资源、补证停止条件和未完成任务接续方式；具体值尚待确定，不沿用旧固定数量。到边界时保存已完成证据并说明剩余缺口，不能假装研究完成。这里描述的是待验收方案，没有启动扫描、调度、供应商消息或付费请求。

主人已确认先定义、再试跑、按实际交付决定修正或换方案，并要求记录下来；这不意味着当前已满足试跑前提或已确定真实取数范围。每页十个方向是展示规则，不是每轮研究量、每天产卡量或压力测试结论。先验证有限完整流程能否交付可信卡片，再根据瓶颈与资源逐步增加负载；质量、错误恢复和资源使用一并检查。具体规模和验收数值仍待确定。

## 卡片必须保持的业务含义

- 沿用当前修订50的八组共100分、21项完整试评规则。Q31内部3／2／4／1、Q32内部3／2配分不变；竞争已改为商品3／品牌3／可观察卖家4，独立进入障碍项已撤下。不能采用未批准的旧示例函数作为默认。耐储、运输、日常复杂度暂按“复用已有资料、关键缺口再查、有依据初评、事实与推断分开”处理；主人已暂时接受这个方式，但来源覆盖、判断质量和每款耗时仍需实测，不能宣称批量流程已跑通。整卡共用规则与已确认的新品参照调整见 DECISIONS；本段只同步已定记录，没有新增评分决定。
- 参考价按同规格竞品，严格高于 30 美元，无上限或价格档位，不预设首发优惠。退款后广告前商品毛利低于 30% 排除当前方案；先收窄同规格成本证据，仍跨线则待补证，缺成本不是零。
- 毛利核全适用成本，沿用旧主表的费用类别而非旧参数，交叉核对同规格包装、公开采购数量价、当期运价和计算器的适用费用组件。完整包装的实际重与体积重、物流与 FBA 规则分别核。成熟期广告情景先扣参考售价 15% 的金额，再除以退款后净收入，不能直接减 15 个百分点；一次性公司费用不摊入常态单品毛利或货物投入评分。
- 建议竞价不是实际 CPC；主购买入口压力优先，便宜小入口另列。相同原生点按同一映射得相同主分，区间另列，不因宽就扣分，不编 CVR、CPA 或原生中点。
- 正常新品销量主看件数、优先父体；少评价的入榜时证据与已准许的当前观察替代口径分别保留，自然可见度保留自然／广告词数和曝光结构。四项映射已定；实际样本、同期历史覆盖与正常起步判断须实测。本轮跨卡已确认统一当前评价数与近30天件数，历史进榜证据另存。保留已观察的失败、退出和未成熟样本，不承诺找全历史。“少评价”指数量少，不是星级低；评分数量、文字评论条数、星级分开。Vine 正常，其好评不保证后续真实销售和退货表现；评价增长不要求直线，自然可见度不是自然订单，曾讨论的 50% 不是准入线。
- 权利冲突按具体款处理，疑似或未查不能称安全；材质或带电标签不直接淘汰。现阶段暂缓强节日/日期依赖款，不排除普通淡旺季。
- 初选无需先询价、拿样或实际发货。后续 1688 询价须先审具体对象与完整话术，主人明确准发后才能发送。评分不构成采购、广告或店铺操作授权。

这份摘要不替代完整 [决策与例外](DECISIONS.md) 和 [参考口径](reference-profile.draft.json)。未知不填 0 或 50，已知权重不放大到 100；部分分、区间与完整总分按修订50分别展示与排序，未知总分不填数。

Q31 修订50已确认前3／2分使用同一相关原生市场报告及三个月新品参数，替代旧的榜内同细分比例输入，不能混用或择高。少评价4分的合格参照包括当前在榜和仍符合条件的已退出新品，其他榜外记录保留相应竞争、销量与后续观察用途。历史轨迹按实际覆盖记录，不要求找全。跨材质按实际替代关系和必要性能判断。卡片保留卖家精灵原生三个月新品占比的真实样本口径和可得细分观察；相关视图不新增分数。多来源佐证与趋势观察分别标记；共用底层数据不冒充独立来源，同一时点多处一致不证明趋势。实际样本核实与来源充分性待测，已确认的换分规则不重问，详见 [Q31 草案](Q31-NORMAL-NEWCOMER.draft.md)。

## 不顺利时怎样呈现

- **没有有据的新方向：** 如实说明本轮覆盖和结果。与“尚未研究完成”“数据源不可用”分开，不凑每日固定数量，也不把旧词冷却导致的空跑当成市场没有机会。
- **缺成本或数据口径不合：** 保留已有成果、具体缺口、来源与适用范围，不猜成本、混用父子销量或拼接不同时点的评分人数。
- **外部请求结果未知：** 保留原请求身份、冻结输入、锁和适用额度预留，只恢复可核验的原请求。缺资源身份或提供方不可查询时继续保持未知，不能把查不到当未提交。按既有边界阻断共享费用边界的后续收费批次；换任务、换日、换月或余额变化都不自行解除。已有结果仍可读。
- **Codex、权限、网络或额度不可用：** 保留已完成结果，明确本轮未完成原因；不暗中切换付费模型，不承诺关闭应用或休眠后必然继续、自动补跑。
- **同一周期重复唤醒或并行执行：** 核对已有批次和请求后接续，不能重做全部研究来掩盖未知结果。
- **新增证据或调整情景：** 保留前后版本与改变理由；情景值不能覆盖成观测事实，技术调用完成不能代替业务卡片完成。

## 后续验收需要证明什么

Scoring-feasibility acceptance clarification (2026-11-13; applies to V1-03, V1-04 and V1-10): document each active dimension's real source-to-input-to-score evidence and demonstrate genuinely fully accounted scored cards or supported total ranges under the accepted 100-point scheme. Measure actual coverage, stage time and unresolved retrieval/judgment gaps; do not invent a pass rate or time target before the trial. Individual incomplete cards remain valid intermediate evidence, but recurring unavailability of important dimensions cannot pass as a working scoring workflow merely because blanks/ranges are displayed correctly. Resolve actual data-path defects and use approved alternatives first; any new proxy, shifted scoring stage or changed weight needs an evidence-backed owner decision. No requirement that every candidate be fully observed is added. The latest synthetic missing-Q31 example is not a live failure, and the revision-50 ranking convention is now accepted; within-item/data-path verification and complete-card acceptance remain distinct.

下面承接已定目标和授权边界，具体验收实施仍待规格确定。当前均未执行，不是新增业务批准。

| 标识 | 要证明的行为 | 可观察证据 |
| --- | --- | --- |
| V1-01 | 每日主动开始发现，无需主人新消息、种子或点选 | 先用合成材料验证完整链路；在日后获准启用时，观察实际到点触发，读取正确项目策略和原状态 |
| V1-02 | 发现来自市场证据并落到具体款式 | 可回溯入口、原始来源、日期和研究理由；一词多款、多词一款及颜色变体样例正确处理；不偷用固定臆造词池 |
| V1-03 | 主人审选前已有研究和有据评分 | 自动经过初筛、优先精筛、经济核查及确定后的评分规则；不依赖人工选择才能启动实质评价；缺证和重排按届时确定的规则处理 |
| V1-04 | 固定计算可复核，AI 判断有依据 | 独立复算核对经济模型与映射；检查来源适配、反证和推断，未定规则不生成假总分；纯查看和重算不额外请求模型 |
| V1-05 | 结果真正保存且可继续使用 | 卡片、证据、版本、主人决定和未完成阶段可读回；页面选择传给 Codex 时不串任务、候选或版本；重读不自动再研究 |
| V1-06 | 错误、未知与重复执行得到正确处理 | 合成覆盖不可查询、缺资源 ID、共享额度、重复唤醒、重叠及跨日/月；保留原请求与预留，不重复收费提交；可区分无机会、部分完成和受阻 |
| V1-07 | 实际入口遵守订阅主研究与费用边界 | 核验该入口的认证、工具和实际用量口径；区分包含额度、额外 credits、Platform 与第三方数据；无未获准付费切换 |
| V1-08 | 高频操作和电脑、手机阅读可用 | 在选定呈现路径上实际检查结论、分项、来源展开、不同款式比较和留决定；页面十个方向不变成研究数量上限 |
| V1-09 | 项目独立、隐私边界有效 | 干净检出可用合成材料离线走通完整约定路径，不依赖旧仓或私有迁移目录；公开文件无真实候选、报价、原始对话、凭据及活动账本 |
| V1-10 | 运行成功、选品判断与商业效果分别成立 | 调用结束、卡片保存、真实卡的证据质量、主人采用和后续真实测款效果分别留证；不以合并文件或合成卡替代实际可用 |
| V1-11 | 持续产能和上下文质量有实际依据 | 记录首批等待、单位时间新增不重复且有据的可审选卡数、各阶段耗时和缺证／错误；区分线索、完成精筛、可用卡、主人愿意深研、供应链匹配与测款结果。连续批次检查漏规则、串候选和丢证据；有必要时用相近任务比较串行与小规模并行的质量、耗时、限流和恢复。不能用重复卡或遗漏必要分析增加产量，每页十个方向也不是处理上限。具体测试规模与目标尚未定 |
| V1-12 | 分组、原生比例与证据覆盖可核验 | 用跨材质可替代／不可替代、指定材质、颜色小变、缺规格、混合父体案例检查错分与漏分；回查成员及入组理由，纠错后重算关联指标。另测三个月新品参数、真实样本是 BS 榜还是近期销量样本、实际返回量及缺失、观察到的进出榜范围。区分共用数据、多来源冲突和时间序列，记录各阶段耗时／用量。先离线验证，再按届时授权做真实小批测试；案例数量、质量标准和性能目标尚未定，当前未执行 |
| V1-13 | 多类目、多轮校准同时检查虚高和漏选 | 按固定规则版本重放并在不同类目检查高分、低分及待补证案例，记录有潜力却未进入优先队列的原因，以及被高估的原因；区分来源／归组错误、映射问题与供应链不匹配。修正规则后检查未参与调整的案例，保留主人判断与后续经营结果的区别。具体轮数、类目、数量及验收容差未定；真实请求须在届时授权内，当前未执行 |

当前21项完整试评映射均已记录，包括Q31少评价销售表现、自然可见度和Q32权利与适用要求。整卡共用约定及Q31参照调整也已在修订50确认；实际证据充分性和校准仍需验证。首批件数由主人决定；原首批投入6分已转入需求4／6／6。Q31的3／2／4／1、Q32的3／2，以及少数有据样本也有参考价值的原则不再重问。竞争10分已采用3／3／4，三项按≤40%满分、60%半分、≥80%零分连续试评；不恢复旧7.5分集中度加2.5分进入障碍方案。系统发现策略、完整实现、实际产能与跨类目业务效果仍需验证。

## 本次纠正与后续工作方式

原稿要求主人先提出“厨房收纳”等领域、先选中候选再做实质评价，并把自动调度排在首版承诺之外。主人已明确否定这条主流程，Release-Q1 已回答，不再重问。原稿的 API 审查只检查费用、能力和请求恢复措辞，不能证明它符合选品目标；其中有效的版本绑定、未知请求和共享额度边界已保留。

本轮已完成恢复和补充交接对照，按主人最新要求继续 Grill Me。产品形态可以讨论，但必须承接既定业务目的，不能把原来的发现、评分和未决问题清空重做。沿 [DEVELOPMENT.md](../DEVELOPMENT.md) 的 Matt 流程推进：先查已有答复与事实，主动补盲点、给有依据的建议，重大未决取舍用大白话和具体例子逐个对齐，再形成规格和完整纵向任务，实施后完成对应验收。当前没有启动扫描、付费调用、供应商消息、采购、店铺动作或调度变更。
