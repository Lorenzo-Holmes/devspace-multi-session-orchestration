# ChatGPT Chat 驱动 Goal：隔离预览版

## 2026-09-10 网页模型跨 Turn handoff/resume（05，已部署）

现用版本为 `chat-goal-card-preview-20260910-05`，工具目录 `2026-09-10.2`。执行主体固定为当前 ChatGPT Chat 模型；DevSpace 只提供确定性 Goal 编排、任务/依赖状态、租约、文件检查、Git 证据和本地工具执行。`chat_goal_*` 控制器不启动原生 Codex Goal、Codex/API/local model、subagent 或后台 Chat turn；返回字段继续声明 `executor=chatgpt_chat`、`additionalModelCalls=0`。这只描述 Chat Goal 控制器自身，不能承诺 ChatGPT 宿主的账号级计量或用户通过通用 shell 主动启动的其他程序。

新增两个 host-visible 工具：

| 入口 | 行为 |
| --- | --- |
| `chat_goal_handoff` | 当前 host turn 必须结束但 Goal 未完成时，保存 30 分钟的短期 handoff cursor；不执行任务、不创建/续期 lease、不发送消息、不调用模型 |
| `chat_goal_resume` | 仅在后续明确的新用户“继续”请求后消费同一 handoff；已有 task lease 时续期并返回**原 lease token**，不会领取第二个任务；无 lease 时只恢复到同一 pending successor，再由 `chat_goal_next` 正常领取 |

同一 host turn 仍应连续执行 `claim → DevSpace 工具执行 → complete → successor`，不要在每个 Task 后等待用户再次发送“继续”。只有 host turn 必须结束而 Goal 尚未完成时才调用一次 `chat_goal_handoff`。后续 turn 先读 `chat_goal_status` / `chat_goal_status_by_path`；`nextAction=resume_handoff` 时使用返回的 handoff ID 调用 `chat_goal_resume`。Handoff 不会唤醒已经结束的 Chat turn，也不是后台调度器。

发布验收：源码全量 `211 tests / 199 pass / 0 fail / 12 skip`；候选 packaged HTTP `8/8` 通过。完整 HTTP 链实际执行了 `Task A complete → handoff → MCP 断开/重连 → status=resume_handoff → resume → Task B → Task C → completed`，同时保持 `extraModelCalls=0`。无数据库迁移，既有 Shrimp task 数据、OAuth、工作区权限和历史 Goal 状态均由部署 guard 验证未被修改。

## 2026-09-09 接口规范与诊断修复（05，已部署）

14 个目标及卡片工具补齐 `outputSchema`，增加脱敏的入口、校验、持久化与返回追踪；90 项源码回归和 5 项发布包接口测试通过。用户授权后于 10:24 切换为 05，新 PID 35724；本机及固定域名健康检查为 200，未认证访问仍为 401，保护检查通过。输入参数、安全标注、认证和应用专用可见性均未改变。详见[接口修复报告](../../CHAT-GOAL-INTERFACE-REPAIR-RESULT.md)。

真实网页验收已发生部分进展：目标 `chatgoal_3a9a56378f50e836e072ffdc19f0a1f8` 已保存，revision=2、ready，无 lease，三个任务 pending；本轮前后保持不变。原网页回复提到安全拦截，但尚无对应原始工具错误记录，不能将其写成已确认根因。下方 04 发布时的“尚未运行/未创建”描述属于当时记录。

## 2026-09-09 真实目标卡片已部署（04）

已新增真实业务卡片入口，85 项最终源码回归和 5 项最终发布包接口测试通过；04 已切换，PID 8740，健康检查通过，原配置、授权和旧目标数据未变，详见[本轮报告](../../CHAT-GOAL-DECISION-INTEGRATION.md)。真实网页完整 Goal 尚未验收。下方旧版的 `form_required`、无参数 preflight 与“诊断尚未接入业务”仅记录历史，不代表 04 的当前合同。

当前 `chat_goal_preflight` / `chat_goal_create` / `chat_goal_next` 可接收可选 `cardChannelId`。无原生表单时，必须先 `chat_goal_card_connect` → `chat_goal_card_ready`，由应用专用接口回传私有令牌后才能通过门禁；模型提供的“已支持卡片”声明不能替代真实回执。连接回执有效期 15 分钟，按认证 OAuth 所有者和 clientId 绑定、跨 MCP 传输，不证明同一聊天或后续模型在线。原生表单仍可使用。

业务路径：`chat_goal_ask_card` 保存待决并显示卡片 → `chat_goal_wait_decision` 只等待一次、最多 45 秒 → 用户本人点击 → 重新读取目标 → 仅已接受且 ready 才领取下一项。应用专用 `chat_goal_card_status` / `chat_goal_card_submit` 不暴露给模型，不关联显示模板，不授予目录/命令权限。超时、断连、取消或平台拦截停止本次尝试，不自动代答或追加聊天消息。明确的新用户恢复请求可用 `chat_goal_show_decision` 重新展示未过期问题，旧卡立即失效。

本轮没有新增数据库迁移、模型运行时或后台续轮。业务选择写入既有控制器与请求日志；任务和依赖仍使用原版 Shrimp。新隔离验收项目只预置 PRD，由用户本人在普通 Chat 发起和点击，不由本地测试替代网页验收。

## 早期版本历史记录

最新状态（2026-09-09）：`chat-goal-card-preview-20260909-01` 已部署详细字段校验诊断，模板 v2-1；73 项回归通过。指定 Sol／高的真实普通 Chat 报告平台安全状态检查拦截，未获得编号，尚未采集到旧错误的实际坏字段。详见[最新进展](../../CHAT-GOAL-CARD-FIELD-DIAGNOSTIC-RESULT.md)，下文为历史实现背景。

2026-09-09 最新验收：现用已切换至 03，status/submit 不再关联模板且保持 app-only；真实网页模板警告已排除诊断工具。但单条普通 Chat 中新卡片初始回执校验失败，按钮锁定，wait 返回 timeout。业务门禁保持；以下 02 部署描述为历史记录。见 [最新报告](../../CHAT-GOAL-CARD-METADATA-FIX-RESULT.md)。

本实现对应 PRD v3.9 的预览。入口是普通 ChatGPT Chat；当前 Chat 模型负责规划、文件修改、命令选择和语义验收。DevSpace 只提供确定性控制与执行能力。完成有限目标后返回 `nextAction=stop`。现用 `chat-goal-card-preview-20260908-02` 已部署七个 Goal 入口与四个诊断工具，诊断配置缺省关闭、本机现用配置显式开启。网页已刷新工具及 V2 模板，但仍显示隐藏工具关联模板的兼容性警告；本次未发送消息验证卡片运行。诊断尚未接入 Goal 业务决策。

## 架构与数据归属

Chat 模型 → DevSpace `chat_goal_*` → 官方 MCP SDK Client → 原版 Shrimp。

任务状态、依赖和任务历史只存于独立 Shrimp DATA_DIR。DevSpace 现有 SQLite 增加第 10 版迁移：`chat_goal_bindings` 保存目标契约、租约、决策、证据与状态摘要；`chat_goal_requests` 保存请求指纹及结果。不复制一套可修改的任务状态，不启动原生 Codex Goal，不增加模型调度器，不修改 Shrimp 核心或自写协议桥。

每个目标使用独立 `chatgoal_…` 标识与数据子目录；旧原生目标不迁移、不重新绑定。配置必须关闭 `goals.enabled` 和 `subagents.enabled`，否则 Chat 预览入口拒绝启动。

## 七个入口（已部署预览版本）

| 入口 | 行为 |
| --- | --- |
| `chat_goal_preflight` | 已认证且只读；无需工作区，检查当前连接是否声明必需的表单能力 |
| `chat_goal_create` | 先强制执行当前连接门禁，再固定目标、验收标准、依赖和检查；不会启动模型 |
| `chat_goal_status` | 查询目标；不提供 goalRef 时列出此工作区的目标 |
| `chat_goal_next` | 每次领取和续期均重查当前连接门禁；返回 10 分钟租约，续期仍需原令牌 |
| `chat_goal_complete` | 验证真实文件、生成 Git 恢复点、完成 Shrimp 任务，返回下一项上下文 |
| `chat_goal_control` | 暂停、恢复、停止任务控制状态；不终止通用命令进程 |
| `chat_goal_ask` | 保存业务选择，探测客户端能力后请求 MCP 表单；不提供模型可调用的代答接口 |

写操作需要 `requestKey` 与 `expectedRevision`。不确定响应必须使用相同参数、相同 key 重试；历史重放结果带 `replayed=true`，执行前重新读取状态。一次请求可能包含多个工具调用，但请求次数如何核算仍由宿主决定。

## 启动前能力检查

`chat_goal_preflight` 不接收参数，只检查服务端 SDK 已解析的当前客户端能力，并核对可信 OAuth 所有者。它不访问工作区、不修改 Goal 数据、不启动 Shrimp、不发起询问。此预览使用固定 `form_required` 策略，没有模型可以设置的“忽略卡片”或“已经检测通过”开关。

| 检查结果 | 含义 | 后续 |
| --- | --- | --- |
| `status=blocked`、`canCreateOrClaim=false` | 当前连接未声明表单；包括无 elicitation、只有 URL elicitation | 停止创建和领取，先解决宿主兼容；不要重复相同请求 |
| `status=capability_declared`、`canCreateOrClaim=true` | SDK 解析到表单能力，包括规范化后的旧式空声明 | 只是必要条件；目录授权、契约、版本等原有校验仍生效 |
| `formDelivery=unverified`、`sameTurnContinuation=unverified` | 没有实际展示卡片或证明原轮继续 | 必须另行真实宿主验证 |
| `permissionCardSupport=not_checked`、`chatUsageAccounting=unknown_host_controlled` | 本检查不验证权限卡或平台计量 | 不作权限或免计量承诺 |

服务说明前部要求先检查；创建和领取处理器也会在进入控制器前强制检查，即使调用者跳过检查工具亦不能绕过。能力不足时返回 `ok=false`、`error.code=HOST_FORM_UNSUPPORTED`、`data.goalMutationAttempted=false` 和详细 preflight。被拒调用不占用创建 key、不写请求日志、不生成数据目录或 Git。已有同 key 的历史请求也不会被重置；当前连接可通过 status 查询历史，不能把本次拒绝解释为历史目标不存在。

检测不持久化，换连接或再次领取时重新判断，原目标契约与请求指纹不变，不新增数据库迁移。已有目标的查询、控制和完成处理保持原有校验；resume 仅改变任务协调状态，后续领取仍须当前连接通过门禁。旧目标遇到不支持表单的 ask 仍保留待决状态，不自动代答。

范围限于 `chat_goal_create` / `chat_goal_next`：通用文件和命令工具不是由此获得系统级沙箱，也不会被门禁全局禁用。模型仍应遵循“先检查，再进行 Goal 工作”的约定。

## 状态、验证与恢复

1. 创建时检查名称唯一、依赖存在且无环。预览版只接受新目录及可选的输入 Markdown 文档，不能把已有 Git 项目自动纳管。
2. SQLite 请求日志在外部写入前占位，原版 Shrimp 写入另有单写者锁。并发或中断请求不能被当成未执行后盲目重放。
3. 只允许当前依赖就绪任务被领取、完成。过期租约不自动分配给另一个会话；已领取任务的状态查询要求检查现场，不指示直接重做。
4. 每项至少一个真实、非空、无别名的项目文件；可约束包含文本或 SHA-256。检查文件范围、大小、Git 配置、索引与实际提交内容。文件证据和项目提交保存在 DevSpace 元数据，任务提交保存在 Shrimp。
5. 最后一项完成前重新检查全部冻结的文件条件，随后自动标记完成。已完成或已停止目标不能恢复成运行。
6. 正常服务重启后，已完成 A、待执行 B 的状态可直接恢复。中断的外部写入保留为待核对；不自动删除锁、回滚数据或再执行任务。

文件检查不是独立语义评审。模型提交的 assessment 是宿主模型的判断，不伪装成另一位评审者。预览版没有服务器可信的任意测试命令成绩单绑定；实际调用者必须读取真实命令结果后提交判断。

## 询问与权限

业务询问使用标准 `elicitation/create` 表单，在支持该能力的客户端内，同一 `tools/call` 中等待回答，最长 50 秒。用户回答可回到该工具调用；这不等于证明 Chat 网页一定继续后续模型执行。重复调用不会并发打开两个同一决策表单。

2026-09-08 早期部署实测：普通 Chat 成功完成 A，但询问工具在能力门禁处返回 `host_form_unsupported`，没有实际展示标准表单。当前 SDK 已兼容旧式空 elicitation 声明，测试验证该形式能够通过；因此不是简单漏判旧式 `{}`。完整客户端原始能力声明未保存在历史日志中，不进一步推断所有 Chat 客户端或未来版本永久不支持。后续新增的启动前检查现已部署，属于提前拒绝不兼容连接，并没有补出宿主缺失的表单能力；本次没有新建或领取 Goal 进行重测。

不支持表单、超时或传输失败时，保留待决状态，返回明确的 interaction 状态。不会自动选默认项，不发送后续 Chat 消息，也不会无限等待维持连接。决策 10 分钟失效；失效后先暂停旧问题，再用新的请求 key 重新询问。暂停、停止后到达的旧回答不能重新启动目标。未回答的问题不能通过普通 resume 绕过。

目录权限仍走已有独立的授权入口。业务选择不能获得目录、进程、凭据或危险操作权限。不得把密码、令牌放进业务选择表单。本轮没有宣称修复历史网页权限卡的全部兼容问题。

依据：[官方 MCP 服务与 elicitation 文档](https://developers.openai.com/plugins/build/mcp-server)、[官方 ChatGPT UI 与 MCP Apps 文档](https://developers.openai.com/plugins/build/chatgpt-ui)。

## 独立卡片候选通道

`scripts/card-lab` 为独立模拟宿主。`src/server.ts` 在本地配置 `diagnostics.chatCard=true` 时复用 `src/chat-card-probe.ts`，将诊断注册到现有认证路径；默认不注册。使用官方 SDK、AppBridge 与 App，不自写 MCP 协议桥。现用 02 版本返回 `ui://devspace/chat-card-probe-v2.html`，连接元数据已刷新为 V2；V1 仅保留历史证据。只有 show 返回 nextAction=wait_once 才发起一次等待；历史重放不再启动 wait。没有 `ui/message`、后续聊天消息、sampling 或模型执行。

实验分别验证没有 elicitation 声明的客户端能完成上述应用协议，以及真实浏览器能显示与操作该卡片；不能推论真实 Chat 也支持，更不能自动放宽 `form_required` 门禁。只读能力检查、目录权限和 Goal 业务选择依然是不同边界。

旧独立实验服务仅监听本机随机端口，使用临时实验凭据，20 分钟自动关闭；不能将其公开。最新接入复用 DevSpace 已有 OAuth，仍最多 32 个内存回执、10 分钟有效期和默认 45 秒单次等待；20 分钟关闭仅属于旧实验服务，不适用于共用 DevSpace。诊断回执在各 MCP 连接间共享、按可信所有者隔离，停止服务时清理等待并拒绝后续写入，不做持久化。

启用诊断必须同时满足 `ui.enabled=true`、`goals.enabled=false`、`subagents.enabled=false`；仅修改配置不会热启用，需获准后重启。配置与卡片静态文件在启动时读取，模型不能指定资源路径或启用开关。卡片编译为 `dist/chat-card-probe.html`，没有外部资源和嵌入的认证秘密；读取资源也必须经过现有认证。V2 四个工具均声明输出结构与认证元数据；提交令牌只出现在工具结果 `_meta`，实际宿主的应用专用可见性及 `_meta` 隔离仍需网页验收。

V2 新增 app-only `chat_card_probe_status`，验证同一所有者与卡片令牌。卡片最多 6 次有界状态查询、60 秒观察期；服务器最多接受每个诊断 32 次读取，不开始或延长等待。展示的倒计时依据快照保守估算，意外中断不保证实时显示，错误时锁定并停止查询。状态请求可能被宿主计量，不承诺零用量。

回执包含 revision、serverNow、createdAt、waitStartedAt、waitDeadlineAt、waitEndedAt、submittedAt 和 receiptPhase；before_wait 的答案由首次 wait 读取，after_wait 仅保留诊断迟到回执。即使计时器未及时调度，服务端截止后也不能报告 activeWaitAtSubmission=true。浏览器 clientTiming 为严格字段校验后的不可信自报，不用于决策或跨时钟延迟计算；浏览器收到响应的时间在卡片本地时间线中展示。诊断事件复用现有日志开关，只记录白名单快照，不含所有者、认证秘密或卡片令牌。

版本 `chat-goal-card-preview-20260908-02` 已部署，399 个文件哈希和旧状态保护通过。23:32:48 的网页元数据显示四个诊断工具与 V2 资源，但同时提示 `approve_workspace_access`、`chat_card_probe_status`、`chat_card_probe_submit` 被隐藏，关联模板将不可用。此提示必须作为兼容性待核对项，不能直接认定真实运行已失败或已经通过，也不能把 app-only 入口公开给模型作为修复。本次没有创建诊断或发送 Chat 消息。详见 [V2 部署与下一步](../../CHAT-GOAL-CARD-V2-DEPLOYMENT.md)；隔离测试历史见 [V2 实施](../../CHAT-GOAL-CARD-V2-RESULT.md)。

构建、操作及旧浏览器证据见 [独立实验指南](../scripts/card-lab/README.md) 与 [候选通道验收](../../CHAT-GOAL-CARD-ADAPTER-RESULT.md)；最新认证、打包和切换前要求见 [候选发布报告](../../CHAT-GOAL-CARD-RELEASE-RESULT.md)。

## 明确未覆盖的产品能力

- Chat 网页真实模型能否在一次请求中完成整个目标、表单回答后是否继续：本轮含表单的 A→B→C 测试受阻，完整目标未完成；无中途询问的整链网页测试尚未单独执行。
- Chat 次数零扣减、点击继续零扣减：没有本地可实现的保证或可靠计量证据。
- 服务重启不代表结束的 Chat 请求会被唤醒；没有实现网页自动续轮。
- 租约管的是任务状态，不是操作系统沙箱，也不强制拦截所有通用文件/命令调用。暂停或停止任务控制不意味着已运行的命令已停止。
- 已事先 `chat_goal_handoff` 的正常 turn 边界可在后续明确用户继续请求中恢复原 lease token；未 handoff 的租约丢失、中途未知外部写入或任务文件被外部更改仍需要人工核对，未实现任意崩溃/未知副作用的自动接管。
- 不支持运行中改目标、已有 Git 项目纳管、无文件产物目标、独立模型评分、所有权限类型统一卡片。
- SQLite 使用现有 WAL/NORMAL 配置；正常进程重启测试不能替代断电耐久性验证。

## 构建、配置与回退

隔离源码：`D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace`。

本机该目录的 node_modules 是现有依赖的目录联接，原生依赖对应 Node 24。不要在此执行自动安装或 rebuild；直接使用已存在的兼容运行时。构建不需要密钥或模型额度。

执行 `scripts/test-chat-goals.ps1 -NodeExe <本机 Node 24 完整路径>` 可完成类型检查、构建、确定性 MCP/HTTP 测试及相关回归。脚本仅更改本进程环境变量并在退出时恢复；测试资料留在隔离目录，HTTP 服务绑定随机空闲端口，结束后关闭。

启用时需在独立配置中设置以下字段，路径必须实际存在且获得精确授权：

```json
{
  "goals": { "enabled": false },
  "subagents": { "enabled": false, "providers": [] },
  "chatGoals": {
    "enabled": true,
    "shrimpEntryPoint": "D:/DevSpace-Goal-PoC/dist/index.js",
    "dataRoot": "D:/AgentState/_poc/shrimp/chat-goals-preview"
  }
}
```

这是配置片段，不是替换现用配置的完整文件。2026-09-08 20:16（UTC+8）首次切换六入口版；22:13 在新授权下切换至 `chat-goal-card-preview-20260908-01`，同时仅新增 `diagnostics.chatCard=true`；23:23 在本次授权下切换至版本 02，本次未改配置。身份认证、既有授权目录、隧道及历史数据保持。七入口与诊断现已部署，业务表单门禁未放宽。V1 真实普通 Chat 曾显示卡片，但单次等待未收到答案而超时；V2 未进行新的网页诊断，先核对模板兼容性警告。最新记录见 [V2 部署](../../CHAT-GOAL-CARD-V2-DEPLOYMENT.md)，历史记录见 [V1 网页卡片验收](../../CHAT-GOAL-CARD-HOST-RESULT.md)、[首次部署](../../CHAT-GOAL-DEPLOYMENT-RESULT.md) 和 [启动前检查](../../CHAT-GOAL-PREFLIGHT-RESULT.md)。保留旧版本和配置副本，不删除 SQLite 元数据或 Shrimp 目录。版本 02 回退到 01 时先核对兼容指针及配置，不盲目恢复数据库，不自动切回原生 Codex 执行方式。
