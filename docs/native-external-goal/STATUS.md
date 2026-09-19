# 执行状态与交接

日期：2026-09-10。

## 当前施工状态：M2.1 进行中

2026-09-10 本次继续已打开经用户批准的 `D:\DevSpace-Native-Goal`，在
`D:\DevSpace-Native-Goal\codex-external-only` 创建隔离源码分支 `devspace/external-only-m2`。
固定上游为 `b348fc26674189f758d5941cdab3f78f258b2aa7`，未修改正式安装。

已加入原生 GoalStore 执行策略迁移、原子 paused/external_only 创建原语、策略/身份保护，
以及 profile、Core 提交、Goal 恢复/idle、HTTP、Responses WebSocket、Realtime WebSocket 门禁。
external-only profile 暂时在 app-server 认证/常规模型初始化之前拒绝启动；专用原生 RPC 尚未实现。

已取得的实际结果：

- `codex-state` 编译通过，证据：`D:\DevSpace-Native-Goal\evidence\run-20260910-195311-214-check-state`。
- 门禁生产模块独立 Rust 测试 5/5 通过，证据：`D:\DevSpace-Native-Goal\evidence\run-20260910-195249-846-gate-run`。
- 原生状态库完整回归 201/201 通过，证据：`D:\DevSpace-Native-Goal\evidence\run-20260910-200947-037-test-state-full`。
- 仓库 `just fmt` 通过。一次测试依赖错误已修复；`codex-client` 原有 `lib.test=false` 导致的一次零测试退出已保留，已新增独立测试目标，待读取复跑结果。

所有测试结果只代表各自源码/存储/门禁测试范围。M2.1 尚未整体验收，不能进入 M2.2。
M2.2/M2.3/M3/M4 尚未实施；Native app-server 端到端、真实用户跨 turn、正式 provider 出站计数均未验收。
没有创建业务 Native Goal，也没有用 ChatGoal 替代。测试临时 Goal 不是可供业务恢复的 Goal。
`nativeRuntimeImplemented=false`、`nativeEndToEnd=not_run`、`crossTurnPassed=false`、`productionDeployment=blocked`。

隔离构建入口为 `D:\DevSpace-Native-Goal\tools\Invoke-M2Build.ps1`；构建、缓存、临时数据放 D 盘。
便携 PowerShell 7.6.6 位于隔离 tools 目录，官方发布包 SHA-256 已核对；不改系统安装。
这是施工交接记录，不是已创建的 Native Goal、lease 或 checkpoint。

## M1 历史结论

M0 核查完成，M1 客户端/请求日志/验证脚本完成。当前未实现 patched Codex native runtime、真实 transport 或新的 MCP 工具注册；原生端到端验收未执行。production deployment 保持关闭。

这不是把 DevSpace Chat Goal 改名后的结果。新代码没有引用 GoalManager 或 CodexAppServerRuntime，没有启动模型或原生 Goal，SQLite 只保存 transport intent，不保存第二套 Goal/Task 状态。

## 已新增文件

```text
src/native-external-goal-contracts.ts
src/native-external-goal-client.ts
src/native-external-goal-journal.ts
src/native-external-goal.test.ts
scripts/audit-native-external-goal.ts
scripts/test-native-external-goal.ps1
tsconfig.native-external-goal.json
docs/native-external-goal/PLAN.zh-CN.md
docs/native-external-goal/NATIVE-PATCH-SPEC.md
docs/native-external-goal/tasks.json
docs/native-external-goal/STATUS.md
```

以上文件位于 D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace。没有修改原来的 server.ts、GoalManager、Codex adapter、Chat Goal、卡片或 Computer Use 文件。既有 Git 未提交修改予以保留。

## 真实验证结果

命令：powershell -NoProfile -File scripts\test-native-external-goal.ps1。

最终复跑证据目录：docs/native-external-goal/evidence/run-20260910-170420-118。

| 项目 | 实际结果 |
|---|---|
| Node | v24.20.0，ABI 137，项目已有可执行文件 |
| SQLite 原生模块加载 | exit 0 |
| 测试 | 31 tests，31 passed，0 failed，exit 0 |
| 隔离 TypeScript 检查 | exit 0 |
| 全项目 TypeScript 检查 | exit 0；不是全项目测试套件 |
| 离线源码/历史 schema 审计 | exit 0；不是在线 native capability 测试 |
| 总执行脚本 | exit 0，passed_for_declared_scope |
| Native Goal 实际创建/运行 | 未执行 |
| 跨用户 turn 原生恢复 | 未执行 |
| Codex/provider 模型出站计数验收 | 未执行；没有启动原生模型进行测试 |
| 服务替换、Git commit、push | 未执行 |

result.json 由执行脚本依据真实命令退出码生成；tests.tap 是测试框架输出，不是手写验收结果。最终版本统一使用 UTF-8 无 BOM 保存 JSON/TAP/日志，便于后续工具直接读取。此前 run-20260910-170036-639 的成功记录保留，不覆盖历史证据。

测试中的原生响应来自显式标注的 protocol fixture；真实部分是客户端逻辑、输入校验、错误处理以及 SQLite 日志的落盘、关闭重开和双连接互斥。没有将这些结果冒充原生 Rust 调度器、真实 lease 服务器或网页跨 turn 的结果。

第一次使用 PATH 中的 Node，因 ABI 127 与共享 better-sqlite3 的 ABI 137 不符，28 个用例均停在环境初始化。随后显式使用已有 Node 24，最初 28 项通过；补充 3 项错误/连接状态测试后，本次完整脚本的 31 项均通过。未重装依赖或改动运行服务。

## 已验证的拒绝与恢复路径

无 preflight、缺失 capability、未批准 binary、撤销授权、注入 executor 字段和目录穿越均被拒绝。协议响应必须匹配 store、runtime、goal、revision 和 fence。错回执或断连后保留原 requestKey 和指纹，第二次写入不发出。

操作对账每次只读取一次；pending/notFound 不解除阻塞；已确定 applied/rejected 才解除。历史请求不能被静默重放，旧 lease 不从对账结果恢复。日志不保存完整请求体、业务摘要或 token。新客户端不提供通用 RPC passthrough 或模型 fallback。

## 下一实施入口

读取 PLAN.zh-CN.md、NATIVE-PATCH-SPEC.md 和 tasks.json，执行 M2.1：在隔离 fork 上先做 external-only 启动保护及底层模型请求拦截，随后才能执行 M2.2 原生状态事务和 M2.3 RPC 接线。

继续时先重新验证 DevSpace preflight 与真实目录权限、检查 Git 修改，保留本轮文件及证据。不要运行现有 goal_start/GoalManager 代替 M2，不把当前服务直接升级为未验收候选，不用另一个模型替代当前网页执行器。
