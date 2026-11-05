# 协作核心真实验收

在 `workbench-plugin/` 执行：

```sh
node dev/collab-core-acceptance/run.mts
```

复用现有正常 Codex CLI 认证，创建独立临时项目、随机输入与真实结果文件。真实 WorkbenchServer → 原邀请 API → DispatchRunner/Engine/CLI → 自然活动事件与精确回执 → 独立核验产物 → 条件核验/交付 → 重开失效。输出目录包含任务账、原运行事件和 `evidence.json`；不读取或复制个人 auth/model 文件，不调用 Kimi，不触碰日用服务。

同时验证桌面作者当前生产 React 面板时，明确给 UI 源码目录：

```sh
COLLAB_UI_ROOT=/absolute/path/to/desktop-source/workbench-plugin/src/client/collab node dev/collab-core-acceptance/run.mts
```

该目录只读载入，不复制或改写 UI 作者代码。最小 Vite/独立 Chrome 仅用于 QA；模型执行后由生产 GoalPanel 实际点击核验与交付，随后检查重开、活动回执与运行记录。截图在同一证据目录。外部 UI source 若在编写中，可先待其源码稳定；`COLLAB_QA_REUSE=/已有证据目录` 可复用**尚未完成条件交付/重开**的真实执行，避免因 QA 页面错误重复模型执行。已经重开的目录保持原轮次，不拿旧产物冒新一轮执行。

LAN 独立验收：

```sh
pnpm exec vitest run tests/collab-lan-channel.test.ts
```

使用两个受控本机实例，走真实设备配对、同项目消息、逐消息回执与报告、重试及权限拒绝。只证明协议同机往返，不声称实体双机或手机真机。
