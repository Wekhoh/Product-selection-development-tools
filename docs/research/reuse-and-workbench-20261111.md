# 成熟项目复用调查与工作台方向

调查日期：2026-11-11。状态：第一轮源码与文档调查完成，未选定底座，未安装或运行候选项目。星数是当天快照，日期按 UTC；默认分支代码与发布版本分别记录。本文是研究与产品建议，不是已批准的架构或业务评分。

同日后续约束：主人明确主要研究使用 Codex 订阅，OpenAI API 仅作有边界的辅助，并质疑为何需要另建 AI 聊天框。因此下述仓库比较继续作为参考，优先增加“现有 Codex 会话 + 选品工具与可视化记录”的最小方案；自建聊天侧栏不属于已定需求。相关决定见 Product-P3/P4，具体使用流程仍待对齐。

## 结论与建议

值得学习的实现不限于亚马逊选品项目。现成项目已经处理了许多通用问题：会话接续、任务进度、文件预览、工具调用、交互页面和工作流观察。我们应优先复用这些能力，把自有实现集中在可比市场、经济模型、证据与未知项、候选比较和决策保留上。

当前值得继续比较两条路线：

| 路线 | 能省下什么 | 必须证明什么 |
| --- | --- | --- |
| 扩展一个现成 AI 工作台，加入选品页面和数据模块 | 会话、工具接入、窗口与部分交互能力 | 候选池可以持续保存和直接打开；业务操作不被聊天线程生命周期限制；上游升级可维护 |
| 自建选品界面，接入官方现成 AI 运行能力 | 保持专用产品流程，同时复用执行循环和会话机制 | 所需认证、工具、恢复和费用语义真实可用；没有重新造一套通用 Agent 框架 |

这是待验证的比较范围，不是同时建设两套产品。完整 fork 一个通用平台仍可比较，但目前没有证据说明其收益足以抵消持续合并上游及维护额外功能的成本。先用同一条具体选品流程判断路线，再选择浏览器、桌面和部署方式。

**独立工作台与 Codex 可以共存。** 官方文档明确支持由自有应用提供领域上下文、工具与界面，由 Codex 承担执行循环。不能据此推断新应用自动继承当前桌面聊天的登录、连接器、技能或额度；具体接口及恢复能力仍须验证。[官方应用模式](https://developers.openai.com/blog/codex-as-a-platform)、[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)

后续核对的官方认证说明区分 ChatGPT 登录的订阅访问与 API Key 的按量计费；自有界面也有经授权使用 ChatGPT plan 的 Codex app-server 接入方式。因此“在自有界面讨论”不必然等于“使用 API Key 另行付费”。但这条路线仍需要实际接入、权限与恢复验证，不能用文档存在代替本项目验收。现有 Codex 会话配合选品工具，应先作为更小的比较基线。[认证与计费](https://learn.chatgpt.com/docs/auth?surface=cli)、[自有应用的订阅授权接入](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

## 工作台与通用平台

### 优先研究的三个工作台

| 项目 | 维护与发布证据 | 值得研究的能力 | 本项目的适配判断 |
| --- | --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | 约 5.61 万 stars，未归档；所查 [commit](https://github.com/pingdotgg/t3code/commit/950c34226cc08ca4d9fc0e387b059a30463a1e47) 为 11 月 11 日；正式 [v0.1.8](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8) 于 11 月 9 日发布；[MIT](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/LICENSE) | 实际 Codex app-server 接入、会话控制、HTML 展示和 MCP Apps | 优先验证“现成工作台 + 选品交互页面”的可行性；不能把会话中的卡片直接当持久候选库 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | 约 3.42 万 stars，未归档；所查 [commit](https://github.com/iOfficeAI/AionUi/commit/e108b6b56b1a6eb99a00904878d0582f657b2908) 为 11 月 5 日；正式 [v2.2.2](https://github.com/iOfficeAI/AionUi/releases/tag/v2.2.2) 于 9 月 9 日发布；[Apache-2.0](https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/LICENSE) | 桌面与 Web 共享界面，研究文件与报告预览，多种 Agent 后端 | 重点学习证据阅读体验；整套采用要承担前端与独立后端的版本配套 |
| [CloudCLI](https://github.com/siteboon/claudecodeui) | 约 1.46 万 stars，未归档；所查 [commit](https://github.com/siteboon/claudecodeui/commit/4e20c29c313071baef2d973051e8ac272afb6b4a) 为 11 月 9 日；正式 [v1.37.8](https://github.com/siteboon/claudecodeui/releases/tag/v1.37.8) 于 11 月 7 日发布；[AGPL 与附加条款原文](https://github.com/siteboon/claudecodeui/blob/4e20c29c313071baef2d973051e8ac272afb6b4a/LICENSE) | 独立插件页、插件后端、项目/会话上下文与 Codex SDK 接入 | 插件边界尤其值得参考；直接引入代码与独立实现需分别判断 |

元数据来源：[T3 Code](https://api.github.com/repos/pingdotgg/t3code)、[AionUi](https://api.github.com/repos/iOfficeAI/AionUi)、[CloudCLI](https://api.github.com/repos/siteboon/claudecodeui)。这些指标说明关注度和维护活动，不能证明适合本项目或已有商业效果。

**T3 Code 的可取与限制。** 源码实际启动并初始化 Codex app-server，不只是 README 声称支持。其 MCP App 能调用本服务器工具、回传上下文并展开显示；但交互需要创建它的 Agent 仍在运行，移动端重新展开也可能重建页面状态。HTML 页随线程删除。因此若使用它承载选品界面，候选、证据和决策必须有自己的持久存储；聊天记录不能成为唯一业务记录。[Codex 接入](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/apps/server/src/provider/CodexProvider.ts#L487-L526)、[视觉回复与 MCP Apps](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/docs/user/html-renders.md)、[界面实现](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/apps/web/src/components/chat/McpAppFrame.tsx#L154-L175)

T3 的内部适配包使用工作区依赖，并标为 private，不能当成稳定独立 SDK。其内部事件日志还有裁剪策略，不能假设可永久重放全部业务证据。当前开发分支的能力也不自动等于 v0.1.8 已打包提供。[内部包](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/packages/effect-codex-app-server/package.json)、[架构与事件记录](https://github.com/pingdotgg/t3code/blob/950c34226cc08ca4d9fc0e387b059a30463a1e47/docs/internals/overview.md#L45-L77)

**AionUi 的可取与限制。** 同一 React 界面可用于 Electron 桌面与 Web，但会话、模型、MCP、技能和数据库由另一仓库的 aioncore 后端承载。预览面板已有 Markdown、HTML、表格、PDF、Office 和图片等类型，适合学习“研究结果旁边直接读证据”的体验。整套 fork 会带来两个实现栈及后端打包版本管理，不应只按一个前端仓库估算成本。[架构](https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/docs/architecture/overview.md)、[预览面板](https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx#L32-L43)、[后端获取](https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/packages/shared-scripts/src/prepare-aioncore.js#L4-L10)

**CloudCLI 的可取与限制。** 插件页面有明确的挂载接口、主题/项目/会话上下文、变化订阅和 RPC；插件后端可独立运行。这样的扩展边界比到处修改主聊天组件更值得研究。源码也实际调用 Codex SDK 的启动、恢复和流式执行，但这仍不等于我们的统一费用与未知请求恢复已得到满足。[插件界面](https://github.com/siteboon/claudecodeui/blob/4e20c29c313071baef2d973051e8ac272afb6b4a/src/modules/plugins/PluginTabContent.tsx#L15-L119)、[插件后端](https://github.com/siteboon/claudecodeui/blob/4e20c29c313071baef2d973051e8ac272afb6b4a/server/modules/plugins/plugin-process.service.ts#L50-L103)、[Codex 接入](https://github.com/siteboon/claudecodeui/blob/4e20c29c313071baef2d973051e8ac272afb6b4a/server/modules/providers/list/codex/codex-runtime.provider.ts#L326-L373)

### 跨领域平台的比较价值

| 项目 | 当前证据 | 借鉴重点与取舍 |
| --- | --- | --- |
| [Open WebUI](https://github.com/open-webui/open-webui) | 约 15.83 万 stars；实际默认分支 [commit](https://github.com/open-webui/open-webui/commit/b0e6098e940942281d9c83f3529ea117287a3a22) 为 11 月 8 日，不能把 11 日 push 当成新主线代码；[v0.13.3](https://github.com/open-webui/open-webui/releases/tag/v0.13.3) 同日发布 | 工具接入与 MCP App 请求/超时处理已有实现，适合作通用 AI 宿主对照；所查路径不能证明已有本项目需要的原生 Codex 工作流。[工具路由](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/backend/open_webui/routers/tools.py#L246-L322) |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 约 4.70 万 stars；所查 [commit](https://github.com/LibreChat-AI/LibreChat/commit/e6567c7a681ce67869dce31486a21d3a25d6931b) 为 11 月 10 日；[v0.8.9-rc1](https://github.com/LibreChat-AI/LibreChat/releases/tag/v0.8.9-rc1) 为 10 月 26 日预发布。所查 [v0.8.8](https://github.com/LibreChat-AI/LibreChat/releases/tag/v0.8.8) 也标为预发布，不能只凭版本名认作稳定版 | 研究 MCP/插件注册与交互应用，现有 Compose 包含多项存储和检索服务；个人使用的收益要与运维量比较。[MCP 初始化](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/api/server/services/initializeMCPs.js)、[应用配置](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/librechat.example.yaml#L693-L723)、[部署组成](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/docker-compose.yml) |
| [Dify](https://github.com/langgenius/dify) | 约 16.09 万 stars；所查 [commit](https://github.com/langgenius/dify/commit/0ef2566c2a5a30d18ace02152b6927a85cb49418) 为 11 月 11 日；正式 [1.19.0](https://github.com/langgenius/dify/releases/tag/1.19.0) 于 11 月 4 日发布 | 重点学习可视工作流、工具编排和运行观察；完整平台具有 API、后台任务、数据库、缓存、插件和沙箱等组成，可选 profile 不能全部算作最低依赖。现阶段尚无必要把这些全部带进个人选品工具。[产品能力](https://github.com/langgenius/dify/blob/0ef2566c2a5a30d18ace02152b6927a85cb49418/README.md)、[部署组成](https://github.com/langgenius/dify/blob/0ef2566c2a5a30d18ace02152b6927a85cb49418/docker/docker-compose.yaml) |

元数据：[Open WebUI](https://api.github.com/repos/open-webui/open-webui)、[LibreChat](https://api.github.com/repos/LibreChat-AI/LibreChat)、[Dify](https://api.github.com/repos/langgenius/dify)。三者的源码复用条件不同：LibreChat 是 MIT；Open WebUI 有自己的许可与品牌条款及例外；Dify 是附加条件的 Apache 许可，涉及多租户和前端标识。保留其产品参考价值，不把它们一概当作可直接并入本仓 Apache-2.0 的代码。[LibreChat 许可](https://github.com/LibreChat-AI/LibreChat/blob/e6567c7a681ce67869dce31486a21d3a25d6931b/LICENSE)、[Open WebUI 许可](https://github.com/open-webui/open-webui/blob/b0e6098e940942281d9c83f3529ea117287a3a22/LICENSE)、[Dify 许可](https://github.com/langgenius/dify/blob/0ef2566c2a5a30d18ace02152b6927a85cb49418/LICENSE)

维护筛选还发现：[1code](https://api.github.com/repos/21st-dev/1code) 当时已归档；[CodexMonitor](https://github.com/Dimillian/CodexMonitor) 未归档，但所查最近实际 [commit](https://github.com/Dimillian/CodexMonitor/commit/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5) 为 3 月 26 日、[v0.7.67](https://github.com/Dimillian/CodexMonitor/releases/tag/v0.7.67) 为 3 月 24 日。因此没有放入首轮优先验证组；这不是断言其永远不可用。

## 选品领域实现

### Omniscient：保留完整流程参考，不能视为已验证成熟产品

[amazon-omniscient](https://github.com/Umair706/amazon-omniscient) 当时约 50 stars、未归档；所查最近实际 [commit](https://github.com/Umair706/amazon-omniscient/commit/6154250f8549f6e8292d7f5bbc684f1c628568d4) 为 10 月 3 日，涉及财务、推荐与数据缺口；[Releases](https://api.github.com/repos/Umair706/amazon-omniscient/releases?per_page=3) 为空。源码有以下可借鉴流程：

- 宽泛关键词先发现方向，再选择细分市场深入研究；进度按阶段呈现。[发现页](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/app/discover/page.tsx#L86-L175)、[研究阶段](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/components/analyze-dialog.tsx#L155-L228)
- 保存任务 ID，刷新后查询已有任务；这个做法值得参考，但不等于后端付费提交已实现完整去重。[恢复入口](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/components/analyze-dialog.tsx#L51-L151)
- 简报按市场、竞品、评论、经济模型等主题展开，显示数据缺口，并保存当次评分规则快照。[主题页](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/app/recommendations/%5Bid%5D/page.tsx#L142-L154)、[缺口显示](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/app/recommendations/%5Bid%5D/page.tsx#L410-L421)、[规则快照](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/frontend/src/app/recommendations/%5Bid%5D/scored-under.tsx#L25-L64)

但它会给缺失搜索量、回本周数和卖家收入等填入假设值，部分 BSR 缺失由评分默认值处理。即使同时提示缺口，这些规则仍与本项目未知项语义冲突。不能因界面完整就采用其评分或预测。[假设实现](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/backend/app/workers/pipeline_steps/assumptions.py#L24-L98)

README 使用开源措辞，但实际 [LICENSE](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/LICENSE) 保留全部权利，未授予任意使用、复制或修改源码的权限。保留公开流程参考，适合的部分独立实现，不引入其受限代码或资产。[README](https://github.com/Umair706/amazon-omniscient/blob/6154250f8549f6e8292d7f5bbc684f1c628568d4/README.md) 截图仍待提供；本轮未验证实际部署、用户采用或商业效果，不能给它加上“成熟成品”的结论。

### Nexscope：任务与计算模块有参考价值，业务默认值需重审

[Amazon-Skills](https://github.com/nexscope-ai/Amazon-Skills) 当时约 861 stars，[eCommerce-Skills](https://github.com/nexscope-ai/eCommerce-Skills) 约 1,376 stars，均未归档、MIT。11 月 11 日的最新提交是文档链接调整；抽查的关键词脚本最近变动在 3 月 10 日、利润计算器当前路径在 3 月 20 日。不能把最近文档更新表述为计算模块近期维护。[Amazon commit](https://github.com/nexscope-ai/Amazon-Skills/commit/2bcb8cb019cfac6a1e420b11f86209df5ea47686)、[eCommerce commit](https://github.com/nexscope-ai/eCommerce-Skills/commit/c5ba892a1cc3178626577aed1dbde5e62a82f1ac)、[脚本变动](https://github.com/nexscope-ai/Amazon-Skills/commit/200dd328cee96640b20f6c95234ea688cb89de90)、[计算器路径变动](https://github.com/nexscope-ai/eCommerce-Skills/commit/eede46ad1c39a3754ace3b86d5e8a06eb18ae01d)

任务拆分与标准库计算模块可以选择性评估，但不是完整工作台。利润代码使用自己的费用、退货损失比例和等级规则，CSV 缺失成本默认零；利基 Skill 包含固定评论数及结果数区间，不能直接带入本项目。关键词建议脚本取得的是 autocomplete，不是测得搜索量、销量或 CPC。[计算器](https://github.com/nexscope-ai/eCommerce-Skills/blob/c5ba892a1cc3178626577aed1dbde5e62a82f1ac/profit-margin-calculator/profit-margin-calculator-amazon/scripts/calculator.py#L481-L499)、[退货处理](https://github.com/nexscope-ai/eCommerce-Skills/blob/c5ba892a1cc3178626577aed1dbde5e62a82f1ac/profit-margin-calculator/profit-margin-calculator-amazon/scripts/calculator.py#L190-L211)、[利基规则](https://github.com/nexscope-ai/Amazon-Skills/blob/2bcb8cb019cfac6a1e420b11f86209df5ea47686/amazon-niche-finder/SKILL.md#L97-L118)、[关键词脚本](https://github.com/nexscope-ai/Amazon-Skills/blob/2bcb8cb019cfac6a1e420b11f86209df5ea47686/amazon-keyword-research/scripts/research.sh#L32-L75)

### Sorftime seller-agent：技术适配比业务筛选更值得比较

[sorftime-seller-agent](https://github.com/DannylydST/sorftime-seller-agent) 当时约 44 stars、未归档、MIT；最近实际 [commit](https://github.com/DannylydST/sorftime-seller-agent/commit/f08fbe963497c87e795a1cb0f5fa198d13c84bd9) 为 11 月 10 日，同日有实际 [Schema/参数兼容修复](https://github.com/DannylydST/sorftime-seller-agent/commit/063e082a64380109931b9f30f05148cec50f0763)。SQLite TTL 缓存、Schema 版本保存与 MCP 参数适配值得与 API 席现有模块比较。[缓存](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/scripts/utils/cache.py#L20-L78)、[Schema](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/scripts/utils/schema_store.py#L35-L103)、[MCP 适配](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/scripts/utils/mcp_client.py#L130-L191)

它需要服务方凭据并按调用消耗额度；缓存缺失时仍请求数据端。其入门模式还使用 15–40 美元、评论数不超过 500 等条件；这些业务规则不能继承。缓存不等于完整离线能力，也不能替代统一费用账本与未知请求恢复。[额度说明](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/README.md#L80-L82)、[筛选与调用](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/scripts/picker.py#L148-L183)、[入门参数](https://github.com/DannylydST/sorftime-seller-agent/blob/f08fbe963497c87e795a1cb0f5fa198d13c84bd9/scripts/picker.py#L250-L274)

其他抽查结果也需留意：约 1,113 stars 的 [amazon-sorftime-research-MCP-skill](https://github.com/liangdabiao/amazon-sorftime-research-MCP-skill) 有报告生成实现，但所查 [评分函数](https://github.com/liangdabiao/amazon-sorftime-research-MCP-skill/blob/99c65df845e3f63f17865122fb5ea3076304e849/SKILLS/skills/category-selection/scripts/analyze_category.py#L285-L355) 把缺项转零、用平均售价推断利润空间；README 标称 MIT，所查树未见正式许可文件。约 22 stars 的 [amazon-1688-selector](https://github.com/xiaodong-l/amazon-1688-selector) 最近所查提交/发布在 3 月 27 日，部分 [趋势判断](https://github.com/xiaodong-l/amazon-1688-selector/blob/1996c0bfba03f254489bfc7ec04a22eada3cec2d/src/analysis/trend_analyzer.py#L259-L278) 由累计评论数分档，不能当成历史销量增长。

结论限定于本轮样本：没有足够证据推荐某个选品项目整套直接采用，不代表 GitHub 没有其他合适实现。领域调查包含 16 组仓库检索，按相关度与关注度初筛，再检查选中项目的元数据、实际提交、发布、许可证和具体源码；没有穷尽 GitHub，也没有逐项审计所有搜索结果。

## REA 的研究位置

已核对 [morluto/rea 官方说明](https://github.com/morluto/rea)。它支持对 JavaScript/Electron 应用、网站和本地二进制作分析，并保留结论的证据与限制。因此可以针对明确问题，例如“某应用如何保存研究任务”“如何组织文件预览”，帮助理解可观察实现，再形成独立适配方案。

有公开源码时先读源码和官方文档；只有具体问题需要时才增加 REA 调查。看到前端、IPC 或请求不能推出未观察到的后端算法，更不能证明数据正确性、付费请求不会重复或实际商业效果。公开产品研究、源码复用和独立实现分别记录；REA 不是绕过许可或访问控制的授权。

当前会话未发现可直接调用的 REA 工具，本机 PATH、所查主配置及常见包入口也未确认其当前安装入口；这不等于证明机器上不存在其他安装。本轮只核官方能力，未安装、更新、注册或对目标应用执行 REA，不阻塞公开源码调查。

## 早期体验候选：已被后续业务纠正取代

2026-11-11 修正：以下为当时的交互提案，**不能再作为第一版主流程或下一轮提问依据**。主人已明确要求每日主动发现、研究、评分排序后交卡；不能先由主人提供领域或选中候选才实质研究。原仓库调研事实保留，当前需求见 [纠正后的首版草案](../design/FIRST-RELEASE.draft.md) 与 Product-P5。保留下列内容仅说明该提案曾包含哪些交互想法，不代表主人采用。

1. **打开工作台。** 先看到待研究方向、正在补证的候选、上次未完成的工作和近期有变化的证据。每页 10 个方向仍只是展示量，不变成每日扫描或产出承诺。
2. **进入一个方向。** 例如某类厨房收纳产品，先界定用途、结构、材质和尺寸，查看真正可比的市场；颜色变化归组，实质差异分开。
3. **看简卡并选择深入。** 第一层说明为什么值得看、主要风险与缺口；展开后查看需求、竞争、新品、经济模型及来源时间。缺成本显示待补证，不生成假利润。
4. **围绕当前证据与 AI 讨论。** 对话自动带入当前候选及所选证据。例如提出“这两个规格为什么成本差距大”，得到可检查的解释、冲突与下一步所需资料。执行新的取数任务时，应显示范围、状态和适用费用约束。
5. **比较并留决策。** 两个方向都可保留；记录继续研究、暂缓或具体方案排除的理由。尚未批准的总分映射不用于制造完整排名。
6. **下次接着处理。** 候选、来源、决定及未完成任务可恢复；断线后先检查原任务，不用自动重新生成掩盖未知状态。询价、采购和店铺动作继续受各自授权边界约束。

原提案偏向“候选与证据为中心、AI 对话随内容联动”，但未正确落实自动发现和评分交卡的先后关系。页面布局、部署和具体交互仍未选定；另建 AI 聊天框没有获准。每日主动工作已经是业务要求，实际后台执行能力尚待验证。

## 下一步与验收边界

后续选型和演示须服从已恢复的主动发现、研究、评分、交卡与主人反馈流程；不能只验证一个等主人输入方向的资料查看页面。实际下一步及暂停状态以 [STATE.md](../STATE.md) 为准，本研究不单独派生任务。开发文档按 [DEVELOPMENT.md](../DEVELOPMENT.md) 随具体决策维护。

当前证据是官方文档、固定 commit 源码、许可证及发布记录；选定材料经过主席抽查。没有安装候选、运行其测试或完成浏览器视觉验收，没有使用 REA 分析目标，没有请求市场数据、付费模型调用、移动凭据、发送供应商消息或执行店铺操作。源码存在、可运行、集成可用、用户采用和商业有效仍是不同验收状态。
