# 隔离卡片实验：构建与复现

此目录不是现用 DevSpace 的启动器，不是 ChatGPT 网页，也不是 Goal 执行器。它只使用本机浏览器和官方 MCP SDK / MCP Apps 验证三个动作：先显示卡片、单次有界等待、卡片提交固定诊断标记。

后续状态：诊断模块现已通过默认关闭的配置开关接入隔离 DevSpace 的已有认证；本目录的实验 HTTP 服务和临时凭据方式不随之对外部署。最新候选包与认证测试见 [发布准备报告](../../../CHAT-GOAL-CARD-RELEASE-RESULT.md)。

## 范围与前置条件

- 仅从 `D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace` 运行；实验服务校验此精确位置。
- 使用已安装的 Node 24。当前 node_modules 联接现有依赖，禁止为本实验安装依赖或 rebuild 共享依赖。
- 仅监听 `127.0.0.1` 的随机空闲端口，不配置隧道，不改变认证或授权根。
- 实验凭据只允许本次诊断，无生产 OAuth、工作区、命令、Shrimp 或模型权限。不得把 `/lab-config` 或实验 HTTP 服务公开部署。

## 构建与测试

在上述目录运行：

```powershell
& 'D:\DevSpace\node-v24.20.0-win-x64\node.exe' 'scripts/card-lab/build.mjs'
& 'D:\DevSpace\node-v24.20.0-win-x64\node.exe' 'node_modules/typescript/bin/tsc' -p 'scripts/card-lab/tsconfig.json'
& 'D:\DevSpace\node-v24.20.0-win-x64\node.exe' 'node_modules/typescript/bin/tsc' -p 'tsconfig.build.json'
& '.\scripts\test-chat-goals.ps1' -NodeExe 'D:\DevSpace\node-v24.20.0-win-x64\node.exe'
```

浏览器打包复用已存在的 tsx 依赖中的 esbuild；仅写入本目录下被 Git 忽略的 `.card-lab-build`。不修改全局环境或共享依赖。完整测试脚本的环境更改限于当前进程并会恢复。

启动实验：

```powershell
& 'D:\DevSpace\node-v24.20.0-win-x64\node.exe' 'scripts/card-lab/server.mjs'
```

浏览器打开启动输出中的 `labUrl`，不能猜固定端口。页面明确标为“不是 ChatGPT 网页”。实验最多运行 20 分钟；停止时将已脱敏的回执和观察记录写入启动输出中的 evidenceDirectory。可向本实验的 `/lab-stop` 发起带本实验凭据的 POST 提前关闭；不要停止现用 DevSpace。

## V2 浏览器样例

每个样例只点一次“开始一次诊断”，没有模型或 Chat 消息。

| 样例 | 操作 | 预期 |
| --- | --- | --- |
| 正常回答 | 显示卡片后，在 45 秒内点击蓝色标记 | 一次等待返回 BLUE；仅证明服务端等待收到答案 |
| 取消 | 新诊断中点击取消诊断 | 返回 CANCEL，未启动或停止任何真实 Goal |
| 提交失败 | 勾选模拟故障，开始后点击绿色标记 | 显示可读模拟错误；答案未提交；等待自然超时，无自动重试 |
| 超时锁定 | 关闭故障，新诊断中不回答直至超时 | 卡片锁定并显示 timeout，不能再点颜色 |
| 历史重放 | 已完成后点击“重放上次测试” | 同编号、历史标识、不重新等待 |
| 提前回答 | 勾选延迟 5 秒开始等待，显示后立即选择 | before_wait；首次 wait 读取已记录答案 |
| 提交排队 | 实验以 8 秒等待启动，勾选提交排队 8 秒，显示后选择 | 点击在先、接收在后；原 wait 超时，迟到回执不唤醒请求 |

快速验证可在启动命令末尾加 `--wait-ms=8000`；只影响这个本机实验，真实候选默认等待仍是 45 秒。页面“停止本地实验”只关闭本次临时服务并保存回执。不要用进程号猜测或停止现用 DevSpace。

错误、超时与正常回答不能共用一个“成功”文案。故障开关仅用于实验；实际未知提交结果不能简单当作未执行后盲目重试。

## 协议与边界

| 工具 | 谁使用 | 约束 |
| --- | --- | --- |
| chat_card_probe_show | 诊断客户端 | 立即返回卡片；同一所有者和 requestKey 幂等 |
| chat_card_probe_wait | 诊断客户端 | 每个回执最多一次等待，默认 45 秒；不轮询续命 |
| chat_card_probe_submit | 应用卡片 | app-only 元数据；核对可信所有者、专属随机令牌和有效期 |
| chat_card_probe_status | 应用卡片 | app-only、同样认证；有界状态快照，不启动或延长等待 |

卡片最多 6 次短查询，观察期 60 秒；服务器每个诊断最多 32 次读取。新测试使用随机 UUID，旧 key 只作幂等重放。倒计时是快照的保守估算，不是实时宿主续跑承诺。点击后的提交结果不明时锁定，不自动重试。浏览器时间线明确为自报，不能用它决定授权或跨时钟计算网络延迟。

App 与 AppBridge 使用官方协议实现。私密提交令牌只放在工具结果 `_meta`，不放入正文或 structuredContent。真实宿主必须正确隔离 `_meta` 并执行应用专用工具可见性；本地 SDK 客户端能读取原始结果，因此本实验不能独立证明真实宿主上的“只能由人点击”。

服务器 `activeWaitAtSubmission=true` 不等于 Chat 模型仍在同一轮运行；`sameTurnContinuation` 固定标为 `unverified`。超时后答案仍可在有效期内记录，但没有任何重启模型的行为。该内存诊断不是业务持久化，不支持重启后续答旧诊断。

后续若接入现用 DevSpace，必须另行验证 OAuth 所有者隔离、资源权限、实际宿主工具可见性与结果隔离、请求状态和超时。若再用于 Goal 业务问题，还需对接既有待决记录、revision、暂停/停止及旧卡片保护，不能直接把颜色诊断变成业务授权入口。

最新实测及下一轮真实网页验收计划见 [V2 报告](../../../CHAT-GOAL-CARD-V2-RESULT.md)。旧版历史见 [卡片候选通道报告](../../../CHAT-GOAL-CARD-ADAPTER-RESULT.md)。
