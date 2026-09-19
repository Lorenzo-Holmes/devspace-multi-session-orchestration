# Codex 原生 Goal 外部执行器：实施方案

日期：2026-09-10。状态：M0 核查与 M1 客户端实现；未接通原生 external-only runtime，未发布。

## 1. 需求解释与不可变约束

本项目不是安装一个“本地 Goal 大模型”。目标是让当前网页 ChatGPT 作为唯一推理模型，通过 DevSpace 操作本机 Codex 原生 Goal 的持久化与状态服务。不得把已有 DevSpace Chat Goal 改名后称为 Native Goal，也不引入 Ollama、OpenAI API、Codex 模型 turn、local-agent、子代理或自动续发聊天消息。

这一版默认执行器为 chatgpt_web。未来接入其他模型必须另立需求，不能作为本次缺少原生能力时的 fallback。

跨 turn 恢复的含义是：用户下次发出请求后，网页模型读取已落盘状态，确认文件证据，再领取新 lease。结束的网页请求不会因为数据库有 lease 而自动恢复；不推测额度、在线状态或下一条用户消息。

## 2. 已核查的事实与前文需要修正之处

上游核查固定在 openai/codex 的 b348fc26674189f758d5941cdab3f78f258b2aa7，而不是把浮动 main 或本机安装版本视为同一个版本。

原生公开 ThreadGoalSetParams 只有 threadId、objective、status、tokenBudget。本机 2026-09-08 的历史 schema 快照也是这四个字段。历史快照不等于当前运行时能力检测。

原生 GoalService 已有可复用边界：set_thread_goal 处理状态并返回 GoalSetOutcome，apply_runtime_effects 单独应用运行时副作用。但是只跳过它还不够：线程 idle 事件也会调用 continue_if_idle，后者可以 start_turn_if_idle。因此需要持久化执行策略、所有续轮入口的检查，以及底层模型请求拦截。

原生 Goal 的目标状态不是完整任务 DAG。现有 DevSpace 的任务列表、依赖、任务验证属于 Shrimp 集成；外部 lease、请求去重、checkpoint 的可调用协议仍需新增。方案明确区分这些来源，不将它们描述成原生现成功能。

本机实际源目录是 D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace。原有 GoalManager 经 CodexAppServerRuntime 和 openGoalSession，最后将原生 Goal 设为 active；该路径不能直接作为本次执行入口。工作树有大量既有未提交修改，本次只新增 native-external-goal 相关文件，不覆盖原代码。

## 3. 目标结构

```text
当前网页 ChatGPT（唯一模型，只在真实用户请求内工作）
        |
        | DevSpace MCP：真实授权、卡片、工作区、文件与命令证据
        v
NativeExternalGoalClient（本次 M1 已实现；没有模型/进程启动能力）
        |
        | 受监督的本地 RPC + 固定二进制校验 + 能力握手
        v
Patched Codex Native Goal（M2 待实现）
  GoalService + 原生 thread_goals：目标、状态的唯一权威
  原生扩展元数据：external_only、revision、fence、lease、checkpoint、operation
  调度层禁止自动续轮 + provider 发送前再次拒绝模型请求
        |
        +-- 可选 M4：现有 Shrimp 任务图；不再创建另一套 ChatGoal
```

DevSpace 的 SQLite intent journal 仅保存请求 key、指纹、方法和结果状态，不保存另一份 Goal/Task 状态，也不保存 prompt、完整请求体、lease token 或凭据。原生状态库不能由 TypeScript 直接写 SQL 冒充原生 API。

## 4. 分阶段实施与退出条件

### M0：边界核查（已执行）

核查服务版本、实际源目录、Git 工作树、原生桥接路径与固定上游源码。为每个结论标明“本地源码”“历史 schema”“上游固定提交”或“测试夹具”，不混用为实时验收证据。

退出条件：找到原生状态与调度的切口，并确认旧的 goal_start/GoalManager 不适用于单网页模型要求。

### M1：外部执行协议和拒绝危险回退的客户端（本轮已实现）

新增严格 Zod schema、受限 RPC 客户端、真实 SQLite 请求日志和自动化测试。必须先完成能力检查与本地可信二进制绑定；缺一项即拒绝写入。新客户端不能调用 thread/start、thread/resume、thread/goal/set、turn/start 或旧 GoalManager 作为 fallback。

写前记录 pending intent。超时、断连、错误返回、错 Goal、错 revision、错 store 或 runtime identity 都不能被当作成功。结果不明后不自动重试；显式查询 operation，只有 applied/rejected 才解除写入阻塞。notFound 不是“请求永远不会提交”的证明。

退出条件：协议、日志持久化/重开、并发互斥、输入校验与危险路径拒绝测试通过；类型检查通过。这里通过不代表原生 runtime 已通过。

### M2：Codex 原生 external-only 补丁（下一实施阶段）

在 D 盘新的隔离 fork 固定上游提交；不要修改正在使用的 Codex 安装。先实现全局 external-only 启动保护和 provider dispatch 拦截，再实现原生数据库扩展、状态事务及新 RPC。顺序不能反过来。

保留现有 GoalService、thread_goals 与状态事件；为新创建且无活跃 turn 的线程原子写入 external_only 策略。不支持把正在运行的 Codex Goal 在线转换成外部 Goal。策略不能仅放在内存或提示词里，重启必须仍生效。

具体文件、状态转换、事务与 Rust 验收见 NATIVE-PATCH-SPEC.md。M1 协议是要实现的新接口，不是宣称 stock Codex 已经支持的接口。

退出条件：隔离 binary 的原生创建、领取、checkpoint、handoff、重启、显式恢复、完成均通过；模型请求尝试与实际出站请求有可信计数和拒绝测试。仅接口宣称 automaticModelTurns=false 不足以验收。

### M3：DevSpace 正式工具接入与真实跨 turn 验收（依赖 M2）

新增受监督 transport，实际校验启动文件 SHA-256 和运行实例身份。不能拿 RPC 返回的 hash 自证可信。使用隔离 CODEX_HOME、状态目录和日志目录；不读取或复制现有账号凭据。

工具输入只接收用户工作所需参数；principal、canonical workspace、二进制信任、lease token 均由宿主内部绑定。每次读写重查授权。请求期限到达、卡片待答或用户停止时不继续调度，不伪造 host liveness。

登记新的 native_external_goal_* 工具到 schema、handler、tool-surface、运行时元信息与 host 实际目录；默认关闭。现有 chat_goal_* 不改名，不作为新功能后备执行器。卡片展示层与 ChatGoal 专属存储必须解耦后才能复用，不能为显示卡片新建影子 ChatGoal。

退出条件：真实网页会话第一次创建/执行/保存 handoff，下一次由用户主动发消息后恢复；goalId 不变，旧 lease 被拒绝，证据可核验。发布到隔离候选服务验证目录刷新，不能仅通过单元测试就覆盖当前服务。

### M4：任务 DAG 与真实用户决策（可选扩展，不冒充 M1 已完成）

若需要 A→B→C 的任务依赖，复用现有 GoalShrimpClient/Shrimp 状态与 next task 逻辑。原生 Goal 保持目标权威，Shrimp 保持任务权威；统一用原生 lease/fence 限制写入，不在 DevSpace 再建第三份任务状态。

跨存储操作必须有可恢复 intent、任务快照 hash 和确定的完成证据。不能声称两个独立数据库具有单事务一致性。验证任务状态改变后才能提交原生 checkpoint；中断后先对账，不重复执行已验证任务。

语言选择/权限卡等只接受实际用户回传。待答记录落盘后暂停；卡片超时不默认选择、不重复等待、不自动新发消息。此功能需要追加经过版本协商的原生决策协议与真实卡片测试。

## 5. 当前可直接执行的验证

在源目录的 PowerShell 中运行：

```powershell
.\scripts\test-native-external-goal.ps1
```

脚本显式使用 D:\DevSpace\node-v24.20.0-win-x64\node.exe，先检查 SQLite ABI，再运行协议/真实日志测试、隔离类型检查、全项目类型检查与离线源码/schema 审计。每次将真实退出码与日志写入 docs/native-external-goal/evidence/run-*。

默认不会调用 Codex、模型、API、后台执行器、服务重启、Git commit/push 或生产数据库。-SkipFullTypecheck 只跳过全项目类型检查，不可拿它的结果声称做了完整类型检查。

最初使用 PATH 中 Node 时出现 ABI 127/137 不匹配；使用已有 Node 24 后测试通过。没有重装共享依赖。这是测试环境问题，不是原生 Goal 的模型行为证据。

## 6. 发布、回滚与不可声称的结果

本轮不改变 server.ts、不启用新工具、不升级运行服务、不创建 Native Goal、不启动另一个模型、不自动 commit/push。代码模块处于未接线的预发布状态。

M2/M3 未通过前，任何“网页 ChatGPT 已驱动原生 Goal 全链路”的结论都不成立。M1 测试用的是明确标注的原生协议夹具，只有 SQLite 日志和客户端是真实执行。

上线采用新 buildId + 独立状态 profile + opt-in 工具开关。回滚先禁止新 claim、等待/对账未决命令、持久化 handoff、撤销 lease，再切回原服务；不删除 checkpoint，不把 external_only Goal 自动交给原生模型续跑。外部 profile 一旦写入新策略，启动器必须拒绝让未识别策略的旧/stock binary 打开它，不能假设旧 binary 自己会认识新 marker。

## 7. 来源坐标

固定仓库 openai/codex，提交 b348fc26674189f758d5941cdab3f78f258b2aa7：

- codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalSetParams.ts：公开原生参数。
- codex-rs/ext/goal/src/api.rs：GoalService、GoalSetOutcome、apply_runtime_effects 的分层。
- codex-rs/ext/goal/src/runtime.rs：apply_external_goal_set、continue_if_idle、start_turn_if_idle 路径。
- codex-rs/ext/goal/src/extension.rs：线程启动、恢复与 idle 生命周期入口。
- codex-rs/state/src/runtime/goals.rs：原生 GoalStore 与 continuation deferral。

continuation deferral 是已有的可清除状态，不能拿它伪装永久禁止模型执行的模式。以上文件已通过 GitHub 连接器读取；具体版本与本机安装版本仍需在 M2/M3 单独对齐。
