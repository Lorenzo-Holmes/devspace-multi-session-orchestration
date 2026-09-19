# Native external-only 补丁合同（M2/M3）

日期：2026-09-10。本文是待实施的补丁规格，不是已存在的 Codex API 文档。

## 2026-09-10 v1 草案修订：丢失创建回包后的身份恢复

原草案 operation 只返回状态，丢失 create 回包的客户端无法找回原生 threadId/goalId。
在原生 RPC 尚未实现前，schema/client/tests 同步追加 capabilities.creationIdentityRecovery=true；
operation.createdRef 为必填 nullable，只有 applied create 返回原始不可变 ref，其他情况必须为 null。
缺少能力或身份的旧响应必须失败关闭，不清除 pending；operation 不返回历史 lease，也不隐式恢复工作。
客户端把不可变标识与 intent 终态在同一 SQLite 事务提交，经 createdGoalRef(requestKey) 读取。
这个传输结果记录不保存 objective、status、revision、fence、checkpoint 正文或 lease，
不成为第二份 Goal 状态；当前状态仍必须通过原生 status 获取。
实现必须与 src/native-external-goal-contracts.ts 对齐；协议变更须先更新 schema、客户端及测试，不能在服务端静默增加语义。

## A. 原生复用边界

基线为 openai/codex@b348fc26674189f758d5941cdab3f78f258b2aa7。

| 原生位置 | 已核查职责 | 需要的改变 |
|---|---|---|
| codex-rs/ext/goal/src/api.rs | GoalService::set_thread_goal 与 GoalSetOutcome::apply_runtime_effects 分开 | 添加专用 external 命令路径，复用验证与原生状态；不调用会启动模型的运行时副作用 |
| codex-rs/state/src/runtime/goals.rs | GoalStore、thread_goals、goal_id 与状态写入 | 同一 GoalStore 事务中写入 external 策略、revision、fence、操作记录和 checkpoint 引用 |
| codex-rs/ext/goal/src/runtime.rs | apply_external_goal_set、continue_if_idle、start_turn_if_idle | 读到 external_only 时不得调度；检查与实际启动必须共享现有同步边界，策略读取失败时拒绝 |
| codex-rs/ext/goal/src/extension.rs | start/resume/idle 生命周期 | 创建时先装载策略；恢复时不得丢失策略；idle 不得为 external Goal 续轮 |
| codex-rs/app-server/src/request_processors.rs | 原生 Goal 请求入口 | 绑定 authenticated connection、workspace 与 external API 路由；旧 set/clear 不得绕过模式约束 |
| codex-rs/app-server-protocol | 原生请求/响应的源类型和生成 schema | 新增 namespace；从源类型生成 JSON/TypeScript，不手改生成文件冒充功能 |
| codex-rs/core 内实际模型 dispatch 入口 | 尚需在 fork 中逐条定位，不能猜测单一函数 | 在 HTTP/WebSocket/重试/fallback/子代理开始前统一检查 external-only 执行策略；拒绝模型请求 |

GoalService 的名字中出现 external mutation，指外部修改目标状态，并不表示它已实现 external executor。跳过一次 apply_runtime_effects 也不能替代上述生命周期和 dispatch 检查。

首版只支持新建、没有活跃 turn 的 external Goal。拒绝把旧运行线程在线转换，拒绝复用可能残留自动任务的 profile。保留 stock/native-codex 模式旧行为，但它不进入本次 external-only 测试进程。

## B. 安装和进程边界

fork、CARGO_HOME、CARGO_TARGET_DIR、临时文件与候选 profile 全放 D 盘已授权目录。不要为方便修改 C 盘既有 Codex 安装或迁移其凭据。尚未创建这些目录，创建时先通过 DevSpace 获取对应工作区权限。

先做 external-only profile 启动门禁与模型 dispatch 拒绝，再开放 create。启动器校验实际可执行文件 SHA-256、fork source commit、profile schema 版本及实例 nonce。由监督器将可信 identity 提供给 M1 transport；不得只相信服务端自报 hash。

使用隔离 CODEX_HOME，不读取用户现有认证，不配置任何模型 provider fallback。必要时增加进程网络限制作为纵深防护，但网络限制不是代码门禁的替代；TCP 失败也不能被算作“未尝试调用模型”。

启动器必须拒绝将 external-only profile 交给不认识该策略的旧/stock binary。不能假设旧 binary 会自动识别一个新 marker。该方案不声称能阻止用户绕过启动器手工改数据库或自行启动另一个进程。

M1 客户端本身不启动进程，也尚未提供真实 transport。连接器、fork binary 和运行时身份验证属于 M2/M3，不能用测试夹具身份替代。

## C. 原生数据与事务

原生 thread_goals 是 objective、native status、goal_id 的唯一权威。新增执行元数据关联 (thread_id, goal_id)，不能只绑定 thread_id，以免目标被替换后误用旧 lease。具体 SQL migration 编号、唯一约束和外键按 fork 实际数据库验证后决定。

新增数据概念：

- executor binding：external_only（不可在运行期改为 codex）、authenticated owner、canonical workspace、revision、fence、external state。
- lease：随机不可预测 token 的哈希、到期时间、fence。token 只在受保护的内部接口中交付，不回显到模型可见状态、卡片、常规日志。
- checkpoint：摘要、明确下一动作、产物相对路径和 hash、验证命令 session/exit 引用、当前 fence/revision。只保存可交接工作事实，不保存隐藏推理。
- operations：按 authenticated owner + workspace + requestKey 唯一，记录请求指纹和 pending/applied/rejected。receipt 与状态变更必须同事务提交。

外部 create 的必要事务顺序：

```text
验证原生 external-only profile 和真实连接授权
确保新线程无活跃 turn、工作区没有冲突写者
BEGIN（沿用原生 GoalStore，不由 DevSpace 直写原生库）
  检查 requestKey/指纹、原生目标身份和预期 revision
  创建 paused 原生 Goal，原子绑定 external_only
  创建 execution ready / revision 1 / fence 0
  落盘 applied operation receipt
COMMIT
发送状态通知，不创建模型 turn
```

若现有 GoalStore 方法自行开事务，需要抽取 transaction-aware 内部方法，由原生服务复用。不得在 DevSpace 使用先 set active、后补写 mode 的两次 RPC；两次写之间存在危险调度窗口。

所有 mutations 都需要 authenticated binding、requestKey，非 create 还要 expectedRevision。claim/checkpoint/handoff/complete 必须在同一事务检查 lease/状态/旧 revision。策略未知、数据库读取失败或 schema 不支持时拒绝，不默认 codex。

请求同 key 同指纹：不重复执行。重复调用可以返回协议错误 OPERATION_REPLAY_USE_STATUS，由客户端显式查询 operation；不得重新发放历史 lease。相同 key 不同指纹直接冲突。原生操作查询需要可靠返回终态，notFound 必须保留“不确定”而不是促使客户端盲重发。

## D. 首版状态转换

| 命令 | 前置条件 | 原生 status / externalState | revision / fence |
|---|---|---|---|
| create | 全新、无活跃 turn、外部 profile 已保护 | paused / ready | revision=1，fence=0 |
| claim | ready；没有有效 lease；真实当前请求内调用 | active / leased | revision+1，fence+1，返回短 lease |
| checkpoint | token、fence、期限与 expectedRevision 全部有效 | active / leased | revision+1，fence 不变；返回 checkpointRef |
| handoff | 有效 lease，指定 checkpoint 存在且属于同一 Goal | paused / handoff | revision+1，fence 增加并撤销 lease |
| control pause | owner 有权；已有命令已停或已收敛 | paused / paused | revision+1，撤销 lease、提升 fence |
| control resume | 用户明确新请求；无待答决策；非终态 | paused / ready | revision+1，旧 lease 不复活；随后需显式 claim |
| control stop | owner 有权；已有命令已停或已收敛 | paused / stopped | revision+1，撤销 lease；终态不可 resume |
| complete | 有效 lease；指定 checkpoint 和真实产物验证完成 | complete / completed | revision+1，撤销 lease、提升 fence |

status 与 operation 查询必须只读，不能顺带创建线程、续租或恢复 Goal。nativeStatus=active 在本模式下只表示目标工作中，永久不表示“允许 Codex 自行续轮”。

原生进程重启必须先撤销/提升旧 lease 的 fencing generation，再接受新写入。用户下次真实请求先 connect→status→核对证据→control resume→claim。不能从“lease 尚未到期”推断网页模型仍活跃。

首版不包含 lease heartbeat 和自动续租；最长 300 秒 lease 不足时，提前 checkpoint/handoff，随后在仍存在的真实用户请求内显式 resume/claim。M3 必须将运行中命令纳入收敛管理，不能靠刷新 lease 伪造长时间 host 存活。

## E. 工具与副作用边界

M3 新 MCP 工具建议：native_external_goal_preflight、create、status、claim、checkpoint、handoff、control、complete、reconcile。名称尚未注册。所有工具默认关闭；不覆盖现有 chat_goal_* 或 goal_*。

外部 lease 只限制调度/提交，不会自动撤销已经启动的 PowerShell、Git 或 GUI 操作。DevSpace 要在发出副作用前检查 fence/授权，并把实际 command sessionId 关联到 Goal。暂停/停止先禁止新操作，再确认已有进程退出或获得实际中断结果；未收敛不能报告 paused/stopped。已经发生的副作用不能声称被回滚。

证据路径先词法校验，再由真实工作区服务 realpath 校验根目录、junction/symlink、大小及文件 hash。模型提交一个 sha256 字符串不是验证；原生完成操作必须消费可信 DevSpace 验证回执或在受授权执行层独立重验。

审批不能从本协议的 executor/principal 字符串推断。工作区权限、Computer Use approval、费用审批和业务卡片沿用真实用户决策，不因 external-only 模式放宽。

## F. 必须通过的原生验收（当前均未执行）

N01：真实原生 GoalService/GoalStore 创建 paused Goal；读回 thread_id/goal_id 相同，策略与目标原子落盘。不是 SQLite 中另建相似表的测试替代。

N02：正常 create→claim→checkpoint→handoff→resume→claim→complete 流程中，模型 dispatch 尝试计数为 0，provider 出站请求为 0；原生目标进入 complete。

N03：显式测试 turn/start、idle、恢复、错误重试、子代理与 provider fallback 的危险入口。故意触发的尝试允许计数增加，但必须被门禁拒绝，出站请求仍为 0；没有模型响应参与测试。

N04：强制终止隔离测试 runtime 并重启，持久化策略不丢失；旧 token/fence 被拒绝；不启动模型、不自动执行下一任务。

N05：在 create、claim、checkpoint、complete 的写前/提交后/回包前注入断连；只有一个状态改变，不重建 Goal；operation 可以对账。两客户端并发只能一个 claim 成功。

N06：lease 过期、错 revision、错 goal_id、错 principal、错误 workspace、已撤销授权和未回答卡片都拒绝写入。权限拒绝后不得自动换模型或放宽 root。

N07：进程运行期间的 pause/stop 不伪报收敛；命令实际退出码与证据路径可核验。

N08：M3 真实网页 MCP 目录出现新工具，第一次用户请求执行并 handoff，用户主动下一次请求恢复。两个请求的 goalId 相同；没有自动发送新 Chat 消息。

N09：版本不兼容、缺少 native 能力或未批准 binary 时，客户端停在 preflight。legacy goal_start、ThreadGoalSetParams 加未知字段、永远挂起一个假审批等方案全部拒绝。

## G. 测试证据和上线决定

M1 的 NativeExternalGoalClient 测试使用明确命名的 protocol fixture，只证明客户端在相应输入下遵守合同；真实 SQLite 证明 intent 持久化/互斥，不证明 native scheduler、MCP 目录、真实 lease 服务器或模型出站计数。

M2 完成前 deployment=blocked。M3 完成前只能隔离候选发布，不能替换运行中的 chat-goal-card-preview-20260910-08。候选部署必须有实际 buildId、schema version、binary SHA-256、源码 commit、原生测试日志和跨 turn 证据。
