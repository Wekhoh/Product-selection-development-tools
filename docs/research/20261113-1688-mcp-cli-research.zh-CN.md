# 1688 MCP / CLI 现有方案调研

核查日期：2026-11-13。范围：公开的一手文档、GitHub 仓库及 npm 包信息，随后按要求补做青虎 CLI 本地启动/免费报价预检与官网定价页查看。未全局安装、注册、提交凭证、购买额度或调用商品数据接口。本文是候选方案调查及有限预检，不是商品取数或采购核价验收。

**结论：有现成 MCP 和 CLI。** 当前会话的连接器目录没有出现专用 1688 工具，不代表市面上不存在。已找到商用远程 MCP、依赖商业服务的 CLI、浏览器自动化 CLI，以及通过通用平台调用的抓取服务。它们的数据来源、授权要求和运行条件不同，不能只按名称选择。

| 候选 | 已核实的实现或文档能力 | 对本项目的意义 | 尚未通过的验收 |
| --- | --- | --- | --- |
| Nexscope | 有远程 MCP；文档提供关键词、图片搜索和商品详情工具 | 详情字段覆盖 SKU、起批量、阶梯价等核价输入，值得优先核验 | 实际字段完整性、时效、数据来源授权、费用及稳定性 |
| 青虎 qhkit / LinkPix skills | 有发布的 CLI 包，以及调用数据工具的 1688 关键词、图片搜索、详情技能 | 可作为商业数据服务的接入候选 | 命令实际返回、后台数据来源、收费、规格/价格单位覆盖 |
| superjack2050/1688-cli | 有 TypeScript / Playwright 实现、CLI 命令和测试；MIT | 有实际代码可研究，不能把它当成独立于网页的正式数据 API | 浏览器访问条件、登录与页面变化、发布版本差异、真实数据质量 |
| Apify 的 1688 Actor | 已有商业抓取服务，平台提供 CLI / API / MCP 调用入口 | 证明存在现成集成形式，可比较字段与商业条件 | 抓取服务的访问与授权条件、真实输出、全部费用；不是 1688 官方 API 的证明 |

## 1. Nexscope：字段较贴近需求的远程 MCP

公开文档列出 `nexscope_1688_product_search`、`nexscope_1688_search_by_image` 和 `nexscope_1688_product_detail`。连接地址为 `https://api.nexscope.ai/mcp`，文档说明 OAuth 及 API key 两种认证方式。[关键词工具](https://www.nexscope.ai/mcp-map/1688-product-search)、[图片工具](https://www.nexscope.ai/mcp-map/1688-search-by-image)、[MCP 说明](https://www.nexscope.ai/mcp)

商品详情声明 SKU、`minOrderQuantity`、`saleInfo.priceRanges`、销售单位及部分物流字段。多数为可选字段，不能据此保证每个商品都有完整规格或包装资料。页面当前标注详情调用参考消耗为 10 credits；返回字段 `cost` 表示处理耗时，不是账单额度。[详情字段与调用说明](https://www.nexscope.ai/mcp-map/1688-product-detail)

其公开商品数据接口与采购授权接口需要分别判断。采购授权文档涉及让买家授权 LinkFox Agent，授权令牌由 Nexscope 后端托管；这属于新增第三方账户授权边界，不能由此前“允许浏览器登录 1688”直接推导。当前未进行这类授权。[1688 授权说明](https://www.nexscope.ai/api-docs/1688-authorize-url)

公开定价入口与帮助站显示的套餐信息未能一致核实，因此不固定人民币或美元报价；接入提案应以届时实际套餐和工具消耗为准。[价格入口](https://www.nexscope.ai/pricing)、[帮助站](https://learn.nexscope.ai/)

判断：**列入优先核验候选，不认定已稳定可用，也不认定其底层一定采用 1688 官方开放接口。**

## 2. 青虎 qhkit：有 CLI 和 1688 数据技能，许可需分开看

作者维护的 `autoagc/linkpix-skills` README 列出：

- `qinghu-1688-keyword-search`：关键词找货。
- `qinghu-1688-image-search`：以图搜货。
- `qinghu-1688-goods-detail`：按商品 ID 查询详情。
- 对应工具列为 `qhkit mcp`；另有 `qinghu-1688-sourcing` MCP 选品技能。

这些是作者发布的接口使用资料，不是本项目已经连接成功的证据。[技能仓库](https://github.com/autoagc/linkpix-skills)

核查时仓库有 33 stars、3 forks，最近推送为 2026-11-06；技能仓库采用 MIT。npm 包 `@iqinghu/qhkit` 当前版本为 0.15.0，发布时间为 2026-10-16，包元数据的许可证字段为 `UNLICENSED`。**技能文件的 MIT 不等于 CLI 包也采用 MIT。** 使用服务与复制其实现是不同问题。[仓库元数据](https://api.github.com/repos/autoagc/linkpix-skills)、[npm 包元数据](https://registry.npmjs.org/@iqinghu%2Fqhkit)

源码/包检查发现数据命令入口，但本轮没有完成对其后台服务、计费和全部字段映射的验证。不能承诺只安装命令行就能免费取数，也不能把它描述为已经验收的本地自包含工具。

判断：**与 Nexscope 一起列入候选，先核服务和真实返回，再决定是否值得适配。**

### 当日追加：费用核查与有限试用

作者的[关键词搜索说明](https://github.com/autoagc/linkpix-skills/blob/main/skills/qinghu-1688-keyword-search/SKILL.md)和[详情说明](https://github.com/autoagc/linkpix-skills/blob/main/skills/qinghu-1688-goods-detail/SKILL.md)均将对应业务工具列为收费工具，单次基价参考约 **1 青虎积分**，明确是 2026-10 快照。`describe` 与 `estimate` 标注免费；实扣以业务返回为准，不能把基价当成每个产品的固定价格。CLI 的 `estimate` 实现也说明，按结果量计费时实际消耗可能高于基价。

通过正常 Chrome 页面查看[官方定价](https://www.iqinghu.com/pricing)，确认页面显示未登录；普通会员新用户赠送 **10 积分**，月付白银 **68 元 / 200 积分**、黄金 **128 元 / 400 积分**、钻石 **188 元 / 600 积分**。这是 **LinkPix 会员与积分套餐**；没有证据确认赠送/会员积分用于 1688 MCP 的适用性、是否还需数据接口权限，以及独立充值价格。因此不把这些套餐折算为已确定的 1688 查询人民币单价，也不建议为这项测试先购买会员。

本地从 npm 官方 registry 取得 `@iqinghu/qhkit@0.15.0` 包，核对完整性和解包路径，未执行安装生命周期脚本或全局安装。Node 24.14.0 下 CLI 版本与配置查询正常执行；免费 `mcp estimate` 请求在本地返回 `stage: config`，原因为没有青虎配置。配置文件及相关环境变量均未发现可用密钥。没有提交商品查询，也没有青虎积分扣费；最新基价与实际数据质量仍未验证。启动成功不等于接口验收成功。

随后用户明确选择 **先不注册，只了解费用**。停止账户/密钥接入及后续试调用，保留以上报价适用范围和未知项。私有预检回执保留在现有项目任务记录指向的位置，不公开账号或原始运行信息。

## 3. superjack2050/1688-cli：确实有实现，但依赖浏览器

仓库核查时有 144 stars、34 forks，MIT，未归档；最近推送为 2026-08-27 UTC。它通过 Chrome / Playwright 操作网页并获取页面/接口结果，包含关键词搜索、图片搜索、详情和供应商研究等命令，提供结构化输出。依赖本地浏览器和登录状态，不是官方开放 API 客户端。[仓库及 README](https://github.com/superjack2050/1688-cli)、[仓库元数据](https://api.github.com/repos/superjack2050/1688-cli)、[package.json](https://github.com/superjack2050/1688-cli/blob/main/package.json)

发现一个需要保留的发布差异：

- GitHub main 的包版本为 **0.1.48**，HEAD 简写 `5585466`。
- 近期实质修复 `690fc36` 处理以图搜索旧 URL 返回个性化推荐的问题，并补了 mock 回归测试。
- npm `latest` 仍为 **0.1.47**，发布于 2026-06-27；GitHub Releases 最新为 **v0.1.45**，发布于 2026-06-16。

因此，不能把 main 中的修复当成默认 npm 安装版已经具备，也不能把 mock 测试当成当前网页端到端通过。[代码提交](https://github.com/superjack2050/1688-cli/commits/main/)、[npm 发布信息](https://registry.npmjs.org/1688-cli)、[GitHub Releases](https://github.com/superjack2050/1688-cli/releases)

仓库还提供购物车、订单和卖家沟通等能力，这些不属于本次研究或既有核价授权。浏览器依赖也意味着：它不能被用来绕过当前工具明确拒绝的站点访问。本轮没有安装或运行它。

判断：**适合研究其数据结构和命令设计；不是当前访问问题的直接修复方案。** 星数、近期推送和已有测试均不等于业务准确性验收。

## 4. Apify：现成服务，但应识别其抓取性质

`webdata_labs/1688-scraper` 的作者页面声明支持关键词、商品 URL/ID 和店铺查询，涉及 SKU、起订量、价格档位、图片及供应商信息；API 页提供 CLI 和 MCP 等入口。核查时页面展示 457 总用户、111 月活用户、约两个月前更新、0 条评价；起价为每千条商品 3.50 美元。这是页面快照，不是完整费用承诺或稳定性验收。[Actor 页面](https://apify.com/webdata_labs/1688-scraper)、[调用方式](https://apify.com/webdata_labs/1688-scraper/api/python)

该服务明确属于 scraper。通用平台支持 MCP 并不能证明其数据来源获得了 1688 官方接口授权，也不能使已被拒绝的页面访问自动变成允许的替代路线。本轮只读了公开服务资料。

## 官方路线与未选入的项目

[1688 开放平台](https://aop.alibaba.com/)确实存在商品和采购相关能力入口。本轮部分细分文档为动态空内容或读取失败，个人接入资格、商品数据权限和当前收费未完成核验。**没有核实到可直接供个人安装使用的官方 MCP / CLI，不等于断言官方绝对没有。**

另查看了 [limengwork/1688MCP](https://github.com/limengwork/1688MCP)：核查时仅 1 star、MIT，主要为初始实现和 README 更新，未发现测试或 CI 文件；详情输出偏 SKU 摘要，未建立逐 SKU 价格映射，不作为优先候选。第三方 [TMAPI 详情接口](https://tmapi.top/zh-cn/docs/ali/item-detail/get-item-detail-by-id)可作为 REST API 线索，但原生 MCP、数据授权及接入条件没有完整核实。

## 本项目建议与最小验收

优先进一步核验 **Nexscope 和青虎的数据服务**。理由是其声明能力更接近“关键词或图片找到货源，再读取具体 SKU 价格”的现有需求；这只是技术匹配判断，不代表选择供应商、购买服务或授权账户。

后续若进入试接，沿用已有商品样本，小范围验证以下事项：

1. 商品与 SKU 能否对应目标用途、结构、尺寸和颜色；不能只看标题相近。
2. 报价到底按一件、一套还是一个包装；两件套要有对应证据。
3. 币种、数量档位、起订量与有效价格是否完整，并保留取得时间和原始来源。
4. 包装尺寸/重量若无返回，明确缺失；不能拿商品尺寸冒充包装尺寸。
5. 实际费用、失败状态和重试条件可核对；未知结果先恢复，不盲目重发。

以上字段成立后，才把合格采购输入交给现有毛利计算。MCP/CLI 只是接入形式，不能自动解决规格混淆、缺数或报价过期。

本轮没有改变评分、采购成本或毛利结论；没有全局安装插件、调用商品取数服务、发送供应商消息或操作店铺。青虎有限预检的范围与失败阶段见上文。当前商品的同规格国内采购价仍待证据，不能因找到了候选工具而宣告核价或独立应用完成。
