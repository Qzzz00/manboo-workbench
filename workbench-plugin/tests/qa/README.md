# 协作区真实生命周期验收

在 `workbench-plugin` 运行：

```sh
node tests/qa/collab-desktop-lifecycle-1024.mjs
```

这是主动运行的验收，不属于 vitest 默认套件。使用生产 React、真实 WorkbenchServer、真实 engine/CLI adapter，以及已有正常认证的 Codex（`gpt-6.1-sol` / medium）；仅在临时 Git 项目读取三行整数，不修改项目源码、不启动研发代理。认证由 CLI 自己使用，脚本不读取或复制认证文件。

需要本机 Google Chrome 和空闲的 9991–9994 端口。脚本只关闭自己创建的进程与服务，不操作 8791 或已有 4193。

覆盖主事项真实执行、精确邀请子事项与自然回执、三条能力条件共用一件承接事项、核验退回后的真实再执行、逐项核验/交付与重开、两受控本地实例的配对/LAN 消息/报告回执/去重/失联恢复、身份改名与冲突、生产浏览器导航/时间线/断线草稿恢复，以及 1024 宽度条件和频道表单。双实例协议验证不等于实体双机验收。

结果路径在 stdout 最后一行 `Evidence:`。保留的临时目录含服务端私有配对记录，交付时只复制 `evidence.json`、命名截图和脱敏命令输出，不归档整个目录。脚本不向日志输出配对码或令牌。

## 固定 66 独审修复 delta（不调用模型）

```sh
COLLAB_QA_FIX_66=1 COLLAB_QA_PRIOR_DIR=<原真实验收输出目录> node tests/qa/collab-desktop-lifecycle-1024.mjs
```

只从受控临时目录白名单复制 primary/peer 的 tasks.json、jobs.jsonl 到新的临时目录，记录来源 SHA256；不复制认证、配对或浏览器资料，不改原证据。本模式不注册执行引擎，复用原自然回执验证回复对象。新增 ask 走真实消息/子事项链并如实执行失败，不冒充新的模型成功。

浏览器在真实 HTTP 服务落盘后注入丢响应/迟到响应，断言原动作包与请求号、唯一消息/子事项、跨速览/详情/刷新恢复和后写草稿；另验跨目标/三层/收起定位、父组详情与画布只读、固定条件摘要、真实失联及长报告。输出包含所验事项的 API 快照、条件 board 前后响应、恢复的草稿版本和定向截图。`prior-evidence-provenance.json` 可逐项复核原证据未变。此模式只覆盖原66独审 delta，不替代新 Agent 执行或整产品验收。

排查 UI 时可以用 `COLLAB_QA_REUSE_DIR=<脚本生成的临时目录>` 复用已经实际执行的产物；`COLLAB_QA_LAN_ONLY=1` 跳过已完成的三条件退回流程，避免再次调用模型。它不是完整验收通过的替代。`COLLAB_QA_CORE_ROOT` 可指定原 core 候选的 plugin 路径；正式交回使用本树固定后端。`COLLAB_QA_INVITE=0` / `COLLAB_QA_LAN=0` 可供单路排查，最终验收不得关闭这些路径。
