# Codex Native Goal External-Only 一次性构建与验收文档

日期：2026-09-10
主工作区：`D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace`
目标：让“当前网页端 ChatGPT”成为唯一推理模型，通过 DevSpace 驱动本机 Codex Native Goal 的持久化、状态、lease、checkpoint、handoff、resume 与最终完成；禁止 Codex 模型、OpenAI API 模型、本地模型、subagent 和后台模型执行任务。

## 0. 执行原则

这是一个“从当前 M1 状态直接连续施工到完整候选版本”的冻结施工合同。执行者必须连续执行，普通编译错误、测试失败、路径问题和实现细节都自行定位、修复、复测，不逐步询问是否继续。只有以下情况允许暂停：真实目录/系统权限卡、必须由用户本人作出的业务选择卡、费用确认、或者产品定义要求存在一个真实的新用户 turn。

不可违反的限制：

1. 当前网页 ChatGPT 是唯一推理模型。
2. 禁止启动或调用 Codex CLI Goal、`codex exec`、OpenAI API、Ollama、vLLM、local-agent、subagent、后台模型和自动续发 Chat 消息。
3. 允许运行无模型的编译器、测试、SQLite、隔离 app-server 和本地状态服务，但它们不得发起模型推理请求。
4. 不得把现有 `chat_goal_*` 改名后称为 Codex Native Goal。
5. 不得用 fixture、模拟回执、手写 JSON 或影子数据库冒充 Native Goal 端到端成功。
6. 不直接修改当前正式 Codex/DevSpace 安装来试错；所有原生改造先放 D 盘隔离 fork/profile。
7. 不读取、复制或迁移现有 Codex/OpenAI 凭据到测试 profile。
8. 所有大型 Cargo target、临时文件、候选二进制、测试状态和证据尽量放 D 盘。
9. 保留既有 Git 未提交修改，不把无关修改混入本任务。
10. 未通过硬验收门槛前，production deployment 必须保持 blocked。

## 1. 当前基线

必须先读取：

- `AGENTS.md`
- `docs/native-external-goal/PLAN.zh-CN.md`
- `docs/native-external-goal/NATIVE-PATCH-SPEC.md`
- `docs/native-external-goal/STATUS.md`
- `docs/native-external-goal/tasks.json`
- `src/native-external-goal-contracts.ts`
- `src/native-external-goal-client.ts`
- `src/native-external-goal-journal.ts`
- `src/native-external-goal.test.ts`

当前状态固定为：

- M0：完成。
- M1：完成，范围仅为客户端 + SQLite intent journal + protocol fixture。
- M1 最终证据：`docs/native-external-goal/evidence/run-20260910-170420-118/result.json`。
- 已知结果：31/31 tests passed；isolated typecheck=0；full typecheck=0；offline audit=0。
- `nativeEndToEnd = not_run`。
- `productionDeployment = not_performed`。
- M2.1/M2.2/M2.3/M3 未完成；M4 未完成。

开始施工前固定检查并记录：

```text
DevSpace buildId / toolSchemaVersion / serverVersion
git status --short
git branch --show-current
git remote -v
git log -15 --oneline
git diff --stat
```

## 2. 完整完成的定义

只有全部满足以下条件才能报告“项目完成”：

```text
ChatGPT Web（唯一模型）
  ↓
DevSpace MCP
  ↓
NativeExternalGoalClient
  ↓
受监督的本地 transport
  ↓
Patched Codex Native Goal
  ↓
GoalService / GoalStore / native persistent state
```

真实生命周期必须跑通：

```text
create
→ status
→ claim
→ checkpoint
→ handoff
→ runtime restart
→ status
→ explicit resume
→ claim
→ checkpoint
→ complete
```

全过程要求：

- threadId 不变。
- goalId 不变。
- `external_only` 持久化，重启不丢。
- revision 单调递增。
- fence 正确递增。
- 旧 lease 被拒绝。
- checkpoint 可恢复。
- 同 requestKey 不重复执行。
- 正常 external-only 流程 `provider outbound model requests = 0`。
- 不产生自动 Chat 消息。
- 不使用其它模型。

## 3. M2.1：隔离 Codex fork + 模型硬门禁

第一优先级是“先禁止模型，再开放 external Goal”。不能反过来。

建议隔离目录：

```text
D:\DevSpace-Native-Goal\codex-external-only
D:\DevSpace-Native-Goal\target
D:\DevSpace-Native-Goal\cargo-home
D:\DevSpace-Native-Goal\tmp
D:\DevSpace-Native-Goal\profile
```

固定上游提交：

```text
b348fc26674189f758d5941cdab3f78f258b2aa7
```

如果需 clone，克隆 `openai/codex` 后 checkout 该提交；若使用已有源码，必须记录来源和 commit。不要改当前正在使用的 Codex 安装。

设置构建环境到 D 盘：

```text
CARGO_TARGET_DIR=D:\DevSpace-Native-Goal\target
CARGO_HOME=D:\DevSpace-Native-Goal\cargo-home
TMP=D:\DevSpace-Native-Goal\tmp
TEMP=D:\DevSpace-Native-Goal\tmp
```

在原生侧新增持久化执行策略：

```text
NativeModel
ExternalOnly
```

ExternalOnly 必须绑定 `thread_id + goal_id` 并落盘，不能只存在于内存、prompt 或 DevSpace 客户端。首版禁止将正在运行的 NativeModel Goal 在线切换成 ExternalOnly，只允许创建新的 ExternalOnly Goal。

必须审计并修补所有自动续轮入口，包括至少：

```text
apply_external_goal_set
continue_if_idle
on_thread_idle
on_thread_resume
start_turn_if_idle
其它 Goal continuation 入口
```

规则：

```text
execution_policy == ExternalOnly
→ 不创建模型 turn
```

读取策略失败时 fail closed，不回落 NativeModel。

还必须在真正发出 provider 请求之前增加第二道模型 dispatch 门禁。ExternalOnly thread 命中后返回明确错误，例如：

```text
EXTERNAL_ONLY_MODEL_DISPATCH_BLOCKED
```

不得 fallback 到其它 provider、subagent、review agent 或后台 continuation。

加入可测试计数器/事件：

```text
goalModelTurnStarted
modelDispatchAttempted
modelDispatchBlockedExternalOnly
providerOutboundRequestStarted
providerOutboundRequestCompleted
```

M2.1 必须验证：

- idle 不启动 turn。
- resume 不启动 turn。
- status/get 不启动 turn。
- external status mutation 不启动 turn。
- 故意 `turn/start` 被拒绝。
- fallback/subagent/review 路径被拒绝。
- 重启后 external-only 策略仍存在。
- stock/旧 binary 不认识该 profile 时由启动器拒绝打开。

正常流程验收：

```text
modelDispatchAttempted = 0
providerOutboundRequestStarted = 0
```

危险入口测试允许 attempt 增加，但必须：

```text
modelDispatchBlockedExternalOnly >= 1
providerOutboundRequestStarted = 0
```

M2.1 未通过，不得进入 M2.2。

## 4. M2.2：原生 GoalStore 扩展

Goal 状态必须以 Codex 原生状态为权威，不在 DevSpace 复制第二份 Goal。

原生执行元数据关联：

```text
thread_id + goal_id
```

至少包含：

```text
execution_policy
external_state
revision
fence
lease_hash
lease_expires_at
checkpoint_ref
owner binding
workspace binding
created_at
updated_at
```

operation 记录至少包含：

```text
principal
workspace
request_key
request_fingerprint
state = pending/applied/rejected
error_code
revision_after
```

checkpoint 仅保存可交接工作事实，不保存隐藏 chain-of-thought：

```text
checkpoint_ref
goal_id
revision
fence
summary
next_action
artifact evidence refs
created_at
```

### create

必须在一个原生事务里完成：

```text
验证外部 profile / 授权 / workspace
检查 requestKey
检查无冲突 writer
创建 paused Native Goal
原子绑定 external_only
revision=1
fence=0
external_state=ready
记录 applied operation
COMMIT
```

严禁：

```text
先 active
→ 后 external_only
```

### claim

输入：goalRef、expectedRevision、requestKey、leaseDuration。

成功：

```text
revision += 1
fence += 1
external_state = leased
native_status = active
```

lease token 必须随机且不可预测；服务端只保存 token hash。lease duration 限制 15–300 秒。

### checkpoint

必须校验 token hash、fence、expiry、goal identity、owner、workspace、expectedRevision。成功后：

```text
revision += 1
fence 不变
external_state = leased
native_status = active
生成 checkpointRef
```

### handoff

必须有有效 lease，且 checkpoint 属于同一 Goal。成功：

```text
revision += 1
fence += 1
撤销 lease
external_state = handoff
native_status = paused
```

### resume

只能在真实新的用户请求中显式触发。不能因 runtime restart、发现 handoff 或网页 turn 结束而自动 resume。

成功：

```text
revision += 1
external_state = ready
native_status = paused
```

随后再显式 claim。

### complete

必须有有效 lease、有效 checkpoint 和真实验证过的 artifact evidence。成功：

```text
revision += 1
fence += 1
撤销 lease
external_state = completed
native_status = complete
```

### 幂等与未知结果

相同 requestKey + 相同 fingerprint 不重复执行；相同 key + 不同 fingerprint 返回 `REQUEST_KEY_CONFLICT`。

写入后回包丢失时保留 pending，不自动重发。只能显式查询 operation/reconcile。`notFound` 不是“可以重发”的证明。

## 5. M2.3：新增 patched app-server RPC

不要偷偷改变旧 `thread/goal/set` 语义承担全部功能。新增 namespace：

```text
devspace/nativeGoalExternal/capabilities
devspace/nativeGoalExternal/create
devspace/nativeGoalExternal/status
devspace/nativeGoalExternal/claim
devspace/nativeGoalExternal/checkpoint
devspace/nativeGoalExternal/handoff
devspace/nativeGoalExternal/control
devspace/nativeGoalExternal/complete
devspace/nativeGoalExternal/operation
```

协议固定：

```text
devspace.codex-native-goal-external/v1
```

与 `src/native-external-goal-contracts.ts` 对齐。

capabilities 至少返回：

```text
implementation = codex-native-patched
executionPolicy = external_only
nativeGoalPersistence = true
atomicExternalBinding = true
durableExecutionPolicy = true
modelDispatchFence = true
revisionCas = true
leaseFencing = true
operationDeduplication = true
checkpointPersistence = true
automaticModelTurns = false
implicitResume = false
```

这些自报字段不是安全证明；M3 仍需由本地监督器验证实际 binary SHA-256、source commit 和 runtime identity。

schema 必须从原生源类型生成，不手改生成文件冒充功能。

M2.3 必须直接连接 patched app-server 跑：

```text
capabilities
create
status
claim
checkpoint
handoff
restart
status
resume
claim
complete
```

这一步不能再用 fixture 判定成功。

## 6. M2 原生硬验收 N01–N06

N01：确认真实 GoalService、GoalStore、thread_goals、threadId 和 goalId。

N02：跑完整 external-only 生命周期，确认 same threadId/same goalId，且 `providerOutboundRequestStarted=0`。

N03：主动测试 `turn/start`、idle continuation、resume continuation、provider fallback、subagent/review，全部在模型出站前拒绝。

N04：强制终止隔离 runtime 并重启。确认 external_only 不丢、旧 lease 无效、checkpoint 可读、不会自动续跑。

N05：对 create/claim/checkpoint/complete 在“写前、commit 后回包前”等位置做故障注入，确认不重复建 Goal、不重复推进、operation 可对账。双客户端并发只能一个 claim 成功。

N06：错 revision、错 fence、错 token、错 goalId、错 principal、错 workspace、expired lease、撤销授权全部拒绝。

每阶段执行适用的：

```text
cargo fmt --check
cargo test <targeted>
cargo clippy <targeted>
cargo build <patched app-server>
```

不得删除安全测试换取通过。

## 7. M3：DevSpace 真正接线

M2 全通过后才开始。

实现 `NativeExternalGoalTransport`，职责仅为受监督地连接 patched app-server；不得提供任意 raw RPC passthrough，不启动模型。

监督器信任信息来自本地实际检查：

```text
binary path
binary SHA-256
source commit
runtime instance nonce
protocol version
```

使用隔离 profile，不复用现有 Codex 登录/凭据。

DevSpace 正式工具建议注册：

```text
native_external_goal_preflight
native_external_goal_create
native_external_goal_status
native_external_goal_claim
native_external_goal_checkpoint
native_external_goal_handoff
native_external_goal_control
native_external_goal_complete
native_external_goal_reconcile
```

模型不可直接传：

```text
principalRef
trustedBinaryHash
runtimeInstanceId
arbitrary executorMode
raw RPC method
```

这些由 DevSpace 内部绑定。

每个 status/mutation 都重新验证 authenticated principal、canonical workspace grant 和 runtime trust。workspace 权限与卡片通道权限不能相互推断。

执行 write/exec/git/Computer Use 前检查当前 goalId/revision/fence/lease/workspace authorization。pause/stop 不能仅改数据库就宣称命令停止；必须确认真实进程退出或真实 interrupt acknowledgement。

DevSpace 侧继续跑：

```text
targeted tests
isolated typecheck
full typecheck
relevant full tests
```

## 8. 真实网页跨-turn验收

第一真实用户 turn：

```text
preflight
→ create Native Goal
→ claim
→ DevSpace 执行 Task A
→ 验证真实产物
→ checkpoint
→ handoff
→ 返回状态
```

随后必须结束回复，不自动发送下一条 Chat 消息。

第二真实用户 turn只能在用户本人主动再次发消息后：

```text
preflight
→ status
→ 验证 same threadId/goalId
→ 验证旧 lease 已失效
→ explicit resume
→ claim
→ 继续任务
```

因此，“跨真实用户 turn”这一项不能在单个用户消息里伪造。单次施工会话应完成所有其它内容并停在：

```text
M3-cross-turn-part1-complete
```

用户下一轮只需发送：

```text
继续原生 Goal 跨 turn 验收
```

再完成 part2。

## 9. M4：任务 DAG 与真实业务卡片

M3 通过后继续。架构固定：

```text
Goal = Codex Native Goal
Task DAG = 现有 Shrimp
Executor = ChatGPT Web
Tools = DevSpace
```

不要再建影子 ChatGoal。

固定验收：

```text
Task A
→ 用户本人卡片选择
→ Task B
→ checkpoint + handoff
→ 真实下一用户 turn
→ Task C
→ complete
```

卡片不得模型代答、默认选择、超时猜测或自动重发聊天消息。

## 10. 失败处理

普通编译/类型/测试错误：直接修复→复测→继续，不询问。

出现真实权限卡、业务选择卡或费用确认：暂停给用户本人处理。

原生 API 不存在：实现 patch，不换 ChatGoal。

模型门禁无法证明：candidate 保持 blocked，不声称完成。

未知写结果：reconcile，不自动 replay。

跨 turn：保存 checkpoint + handoff，等真实下一用户消息，不模拟用户 turn。

## 11. 证据与候选部署

证据统一写：

```text
docs\native-external-goal\evidence\run-YYYYMMDD-HHMMSS\
```

至少包含：

```text
result.json
commands.jsonl
test logs
source commit
binary SHA-256
runtime info
schema version
goal snapshots
checkpoint snapshots
model dispatch counters
fault injection results
```

不得覆盖旧证据。

只有 M2 全部通过后才能创建 candidate；只有 M3 除必须跨真实用户 turn 的 part2 外全部通过后才能暴露测试 MCP。不得直接替换当前正式服务。

候选版本可用类似：

```text
buildId = native-external-goal-preview-20260910-01
toolSchemaVersion = 2026-09-10.native-goal.1
```

实际编号应遵循当前项目版本规则并记录。

以下任一为 false：

```text
nativeRuntimeImplemented
nativeEndToEndPassed
modelOutboundZeroPassed
restartRecoveryPassed
faultInjectionPassed
workspaceAuthorizationPassed
mcpCatalogPassed
crossTurnPassed
```

则：

```text
productionDeployment = blocked
```

## 12. Git 规则

施工开始前记录脏工作树。若主目录已有大量无关修改，优先使用隔离 fork/worktree。

建议提交拆分：

```text
feat: add codex native external-only execution fence
feat: add native external goal persistence and rpc
feat: connect native external goals to devspace
test: add native external goal end-to-end acceptance
docs: record native external goal deployment evidence
```

不把无关用户修改纳入 commit。用户未明确要求 push 时不要 push。

## 13. 最终一次性报告

最终报告必须至少给出：

1. DevSpace buildId / toolSchemaVersion / serverVersion。
2. Codex fork 路径和固定上游 commit。
3. patched source commit。
4. candidate binary path + SHA-256。
5. external_only 是否持久化。
6. model dispatch fence 是否生效。
7. 正常流程 model dispatch attempt 数。
8. provider outbound model request 数。
9. N01–N09 每项结果。
10. Native threadId / goalId。
11. 最终 revision / fence。
12. checkpointRefs。
13. restart 前后状态。
14. 旧 lease 被拒绝的证据。
15. fault injection 结果。
16. MCP 新工具目录。
17. Task A/B/C 状态（若执行 M4）。
18. 用户卡片实际选择（若存在）。
19. TypeScript/Cargo 构建测试结果。
20. 证据目录。
21. Git diff / commit。
22. candidate 是否部署。
23. production 是否部署。
24. `nativeEndToEnd`、`crossTurnPassed`、`providerOutboundModelRequests` 明确值。
25. 已知问题和下一步。

## 14. 下一会话直接使用的启动提示词

```text
@DevSpace Local（固定域名）

请一次性继续完成 Codex Native Goal external-only executor。

主工作区：
D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace

先读取：
docs\native-external-goal\ONE-SHOT-BUILD.zh-CN.md
docs\native-external-goal\PLAN.zh-CN.md
docs\native-external-goal\NATIVE-PATCH-SPEC.md
docs\native-external-goal\STATUS.md
docs\native-external-goal\tasks.json

当前状态：
M0 已完成。
M1 已完成，31 项客户端/SQLite 测试通过。
M2.1/M2.2/M2.3/M3/M4 尚未完成。

严格遵守 ONE-SHOT-BUILD.zh-CN.md：
当前网页 ChatGPT 是唯一模型；禁止 Codex 模型、codex exec、OpenAI API、本地模型、subagent、local-agent 和后台模型。
可以运行无模型的编译器、测试、SQLite、隔离 patched app-server。
所有 fork/构建/缓存尽量放 D 盘，不读取或迁移现有 Codex/OpenAI 凭据。
不把 Chat Goal 当 Native Goal，不用 fixture 冒充原生端到端。
从实际 Git/运行状态检查开始，按 M2.1→M2.2→M2.3→M3→M4 连续执行。
普通错误自行修复并继续；只有真实用户权限卡、业务卡、费用确认或真实跨-turn边界才暂停。
第一真实用户 turn 完成 handoff 后必须等用户本人下一条消息，不伪造跨 turn。
每阶段保存真实证据；全部硬门槛通过前禁止 production deployment。
最终按文档第 13 节一次性汇报。
```

## 15. 当前状态声明

本文档是施工合同，不是运行中的 Goal 或 scheduler。当前真实状态仍是：

```text
M0 complete
M1 complete_for_declared_scope
M2.1 not_started
M2.2 not_started
M2.3 not_started
M3 not_started
M4 not_started_optional
nativeEndToEnd not_run
crossTurn not_run
productionDeployment blocked
```
