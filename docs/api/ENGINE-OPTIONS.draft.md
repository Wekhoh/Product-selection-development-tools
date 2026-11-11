# 研究运行时复用调查：Codex、Agents SDK 与直接 API

调查日期：2026-11-11（Asia/Shanghai）。状态：供产品选型使用的技术候选，未采用、未安装、未真实调用。

本报告只比较研究运行时。可视工作台与选品领域项目由选品开发席另行调查；唯一任务记录仍为 [STATE.md](../STATE.md)。主人已确认需要方便频繁使用的可视工作台，并要求先研究成熟实现；浏览器、桌面、部署方式和第一版流程尚未定案。

## 建议

**先复用现成执行循环、会话和工具机制，只开发本项目必要的选品数据与证据适配。** 若第一版需要持续对话、过程可见、人工干预，优先把 Codex app-server／官方 Python SDK 作为验证对象；若只是固定输入到研究结果的任务，比较官方 Codex SDK、Agents SDK 和直接 Responses 的最小实现成本。这是条件性建议，不是架构决定。

不建议此时同时引入几套编排框架，也不建议照搬旧仓的运行控制。现有接口草案的 `prepare/run/inspect/recover` 是业务边界，最终应映射到选中运行时已有机制，不能据此新建一套通用 Agent 框架。参见 [接口候选](CONTRACT.draft.md)。

高星项目是候选来源；采用还要比较近期实际代码及发布、许可证、维护成本、扩展位置、数据去向与恢复行为。不能直接引入源码的项目，也可以研究其工作流和交互，再独立实现适合本项目的部分。

## 已检查的开源实现

元数据快照约为 2026-11-11 15:42（Asia/Shanghai）。星数随时间变化；`pushed_at`、默认分支提交和正式发布不是同一件事。源码判断尽量固定到正式发布标签。

| 项目 | 当时状态 | 可复用部分与证据 |
| --- | --- | --- |
| [openai/codex](https://github.com/openai/codex) | 134,824 stars；未归档；最近 push 为 2026-11-11T07:39:37Z；根许可证 Apache-2.0 | 正式版 [rust-v0.167.1](https://github.com/openai/codex/releases/tag/rust-v0.167.1) 于 11 月 10 日发布；会话、执行循环、工具、审批、技能与客户端协议已有实现。[元数据](https://api.github.com/repos/openai/codex)、[许可证](https://github.com/openai/codex/blob/rust-v0.167.1/LICENSE) |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 30,609 stars；未归档；最近 push 为 2026-11-11T07:39:11Z；根许可证 MIT | 正式版 [v0.24.0](https://github.com/openai/openai-agents-python/releases/tag/v0.24.0) 于 10 月 15 日发布；执行循环、工具、Session、RunState、审批与 Codex 扩展已有实现。默认分支最近的翻译更新不算运行时新能力。[元数据](https://api.github.com/repos/openai/openai-agents-python)、[许可证](https://github.com/openai/openai-agents-python/blob/v0.24.0/LICENSE) |

上述许可证是根项目证据；采用具体依赖或复制文件前仍需检查其许可证及保留义务。本报告未复制第三方实现，也未审计依赖许可证全集。

## 接入方式不能混为一谈

| 接入方式 | 已确认事实 | 对本项目的含义 |
| --- | --- | --- |
| Codex TypeScript SDK | 包装 `codex exec` 子进程和 JSONL；`resumeThread(id)` 可续接本地会话。它不是 app-server 客户端。[exec.ts](https://github.com/openai/codex/blob/rust-v0.167.1/sdk/typescript/src/exec.ts#L94)、[codex.ts](https://github.com/openai/codex/blob/rust-v0.167.1/sdk/typescript/src/codex.ts#L29) | 固定任务或简单后台接线可先比较；不能从 SDK 名称推断拥有全部交互协议能力。 |
| Codex app-server | JSON-RPC 支持会话、审批、流式事件与认证；有 `thread/start/resume`。动态工具注册仍有 experimental 标记。[官方说明](https://learn.chatgpt.com/docs/app-server)、[工具字段](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L145) | 富交互工作台的优先验证对象；需要版本固定和断线恢复验证。官方 MCP 移除说明仍标明 app-server 实验性且不支持生产工作负载，不能凭完整文档就认定生产成熟。[限制来源](https://learn.chatgpt.com/docs/mcp-server) |
| 官方 Python Codex SDK `openai-codex` | 当前文档称稳定发布，Python 3.10+，通过 JSON-RPC 控制本地 app-server；发布包带固定运行时依赖。[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk) | Python 接入不必自行写协议客户端。SDK 发布状态与底层 app-server 的上述支持声明须分别核对；本次未安装验收。 |
| Agents SDK Python | `Runner.run()` 接受 Session、RunState、previous response/conversation 身份；有工具和 MCP 生命周期接口。[Runner](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run.py#L281)、[MCP](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/agent.py#L201) | 适合比较受限、可编程的研究流程。已有机制满足时，不再自写基础循环、Session 和审批框架。 |
| Agents SDK 的 Codex 扩展 | v0.24.0 已含 `extensions.experimental.codex`，支持 start/resume thread、`codex_tool()` 和 stream 回调；仍为实验扩展。[实现](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/extensions/experimental/codex/codex.py#L21)、[工具包装](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/extensions/experimental/codex/codex_tool.py#L203) | 若确实需要由 Python Agent 委托 Codex，可先验证此桥接。不要仅为“可能以后会用”同时引入两层编排。 |
| 直接 Responses API | 支持以原 `response_id` 查询；HTTP 跟踪 request ID 是另一种身份。[取回接口](https://developers.openai.com/api/reference/resources/responses/methods/retrieve)、[Python SDK](https://developers.openai.com/api/reference/python) | 可作为固定、有界研究任务的比较基线。已有旧参考实现不代表应继续维护自研完整编排器；需比较实际缺口。 |
| 原生 Agents API | 官方文档描述托管会话、工具和运行时；它与 Agents SDK 是不同产品接口。[概览](https://developers.openai.com/api/docs/guides/agents-api/overview) | 历史账户兼容问题仍未通过新实测解决；保留为独立候选，不用文档存在替代账户及费用验收。 |

官方还给出以 Codex 为领域应用运行时的模式：应用提供领域上下文、工具和控制，Codex 负责执行循环。这支持复用方向，但示例不是已经适配本项目的成品。[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)

## 什么能复用，什么尚未证明

**技能与连接器。** Codex 已有技能搜索路径和插件加载；Agents SDK 已有 sandbox `Skills`、懒加载和本地目录来源。这不能证明新进程自动拥有当前桌面的全部技能、MCP、连接器或登录权限。后续须在所选运行时验证实际加载清单、配置作用域与可调用状态。[Codex 加载器](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/ext/skills/src/host_roots.rs#L80)、[SDK sandbox 技能](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/sandbox/capabilities/skills.py#L154)

**认证与费用。** Codex API-key 路径按 Platform 计费，不包含在 ChatGPT 订阅额度中。现有 app-server 认证文档对 local/open-source 与 commercial/hosted 有不同适用说明；任何将来托管方案都须按当时选中的认证路径核对，不能搬用当前桌面令牌。`account/rateLimits/read` 的配额窗口、`account/usage/read` 的 token 活动、API 费用账本是不同口径。[认证说明](https://learn.chatgpt.com/docs/auth?surface=cli)、[app-server 认证与用量](https://learn.chatgpt.com/docs/app-server)

**会话恢复不等于业务请求去重。** Codex 保存 thread/turn，不自动证明能满足项目原请求身份、未知提交保留、共享预留和跨月占用要求。稳定版公开普通通知提供 thread/turn 用量；携带底层 Responses `response_id` 的 `RawResponseCompletedNotification` 明确为 internal-only，不能把它写进普通客户端的能力承诺。[协议实现](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L2002)

**完成与用量必须核验。** Codex TS `run()` 汇总完成事件并在 `turn.failed` 抛错，但该函数结束路径未显式要求见到 `turn.completed`。集成仍需用终态证据区分成功、失败与结果未知。Agents SDK 区分 response ID、HTTP request ID、标准化 usage 与可选 raw usage；`preserve_raw_usage` 需在原始字段尚可用时启用，不能从默认零反推原始缺失。[Codex thread.ts](https://github.com/openai/codex/blob/rust-v0.167.1/sdk/typescript/src/thread.ts#L118)、[SDK ModelResponse](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/items.py#L705)、[raw usage 设置](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/model_settings.py#L205)

**SDK 已有恢复与重放保护。** `RunState` 保留待确认 Session 写入等状态；恢复需原 Session 和排他历史，不能并发恢复同一快照。模型重试实现检查流输出、状态及副作用，并有禁用底层 SDK 重试的路径。应复用并核验这些机制，不应假设库只有简单无条件重试；但它们仍未证明满足本项目的统一费用边界。[RunState](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run_state.py#L842)、[重试实现](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run_internal/model_retry.py#L419)

**本地运行也要核对数据去向。** Agents SDK 默认 tracing 开启，敏感输入输出默认可包含在 trace 中（环境配置可改变）。私有候选接入前需明确禁用或适当删减；不能因应用放在本机就视为没有额外遥测。[默认值](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run_config.py#L53)、[RunConfig](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run_config.py#L414)

**原生 Agents API 的恢复另有语义。** 会话流断开后不能假定原事件自动重放，应按保存的 session 身份查询状态/items；逻辑消息应在提交前固定 Idempotency-Key，并按文档范围复用，不能推广为所有创建操作恰好一次。`spend_control` 的 limit/consumed 与 usage 可能为 best-effort，不能代替已核账金额或跨项目统一限额。[Sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions)、[创建接口](https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/methods/create)

## 后续最小验证顺序

以下是后续建议，尚未执行，也不新增付费或启用授权。

1. 由选品开发席先明确第一版真实使用流程；结合其工作台/领域项目比较，缩小到一个主运行时及必要的对照方案。
2. 用本项目五个[合成场景](examples.synthetic.json)映射其输入、结果、缺失、粒度冲突、结果未知。优先适配现成 Session/状态接口；记录不能表达的实际缺口。
3. 针对固定依赖版本做隔离离线验证：终态证据、进程或网络中断、同请求排他、重新读取状态、缺失用量、私有数据去向。不要用“重新生成一次”通过恢复验收。
4. 仅在确需真实集成且已有相应授权时，核对统一账本、原未结请求与账户能力，再做有界实测。会话可续接、工具能调用、费用能对账、真实选品有用应分别验收。

如果某运行时不能提供迁移合同要求的原始响应或原请求核对能力，应明确提出接口差异与替代保证，交由负责人审查；不能悄悄放宽 [API-MIGRATION.md](../API-MIGRATION.md) 的要求。

## 本次验证范围

本次检查了官方文档、公开仓库元数据、根许可证和上述稳定标签源码；独立核对了关键原始请求身份、默认 tracing 与 Codex 桥接实现。Windows 支持目前只有依赖/源码证据：TS SDK 要求 Node.js 18+ 且有 Windows 二进制分支；Agents SDK 要求 Python 3.10+。[TS SDK](https://github.com/openai/codex/blob/rust-v0.167.1/sdk/typescript/README.md#L13)、[Windows 分支](https://github.com/openai/codex/blob/rust-v0.167.1/sdk/typescript/src/exec.ts#L386)、[Python 依赖](https://github.com/openai/openai-agents-python/blob/v0.24.0/pyproject.toml#L3)

未安装新依赖、未迁移凭据、未改费用账本或运行开关、未发起付费模型或业务数据调用；未验证账户权益、现有连接器继承、独立 Windows 运行、生产支持或业务效果。来源快照和推荐不是采用回执。
