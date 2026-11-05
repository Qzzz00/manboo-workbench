# c03125 隔离浏览器生命周期验收

`serve.mjs` 在显式临时 HOME 中组装当前生产 `startWorkbenchServer`、本机账号、模型配置、引导阶段机、首次有用、配对与事项服务；Vite 挂当前生产 `WorkbenchOverlay`，手机兼容页挂生产 `OnboardingCall`。没有浏览器 fetch 替身，没有截获业务 API 后伪造回包，没有直接写 done 或调用跳过/重置引导接口。

真实边界：DSH 宿主的 workspace/session 席位为空；本地会话适配器只发阶段机的既有问句并记录浏览器输入，不调用模型。模板与点子两项由驱动作为明确的测试工具输入，提交真实 `/onboarding/answer`，仍通过回答证据护栏和阶段校验。**缺省（三个开关都不给）模型服务使用隔离配置、外部请求禁止**；因此早报与文字派活验证的是缺门、实际错误、重试及落盘，**不代表真模型生成或 CLI 交付通过**。没有安装 DSH、注册系统服务、打开本人 App/账号或配对实体设备。

真实模式（2026-10-27，全部由统筹/维护者显式打开，每次开新证据目录，只跑 `no-device`）：

- `C03125_REAL_MODEL=1`：模型配置**只读引用**本机 `~/.dsh/workbench/model.json` 与 `credentials.json`（run 进程经 `C03125_REAL_HOME` 把原始 HOME 传给 serve；路径不复制、不打印、不进证据，只读不写）。模型 fetch 真发并计数（次数进证据）；`POST /qa/break-model` 把下一击模型调用掐断一次，供「断一次再恢复」验收。真实例程接上：早报真生成（日报四段走真模型），证据只记 `status` 与生成了几段，不记正文；费用走现有中转额度。
- `C03125_REAL_DISPATCH=1`：派活引擎真接（登记表 + 命令行通道 + 动作闸 + 任务账），驱动把卡派给**本机 Kimi CLI**（隔离临时项目目录里真开 git 工作树；执行者名片时长上限 10 分钟），核交回（回执「做完:/有异议:/卡住:」开头）与卡挪到「等确认」。CLI 环境里的 `HOME` 指回真实家目录，用维护者既有登录态，**不克隆、不展示凭据**。此开关由统筹在机制过了之后打开跑。
- `C03125_STUB_DISPATCH=1`：同一派活机构下起 node 替身（真改 README、打印替身回执），自测开关机构本身，不跑 Kimi、不花额度。
- 真实模式停在「卡建好、负责人与类型对、待派」（REAL_DISPATCH 再走到交回与等确认），证据记 `*-real-evidence.json`；凭据、模型正文、回执正文不进证据。

需要现有 Chromium 和现有 `playwright-core`，不 install、不改共享依赖。示例（路径按 host 已有工具位置指定）：

```sh
C03125_EVIDENCE="$PWD/docs/验收-1026-电脑引导/new-run" \
C03125_PLAYWRIGHT_MODULE=/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs \
node workbench-plugin/dev/desktop-onboarding-acceptance/run.mjs
```

可选 `C03125_CASE=no-device,later-pair,existing-device` 选择场景，`C03125_CHROME` 指定浏览器。每次使用新的证据目录，保留此前原件。驱动创建自己的临时 HOME、账号与浏览器上下文；不记录密码/cookie/设备令牌。失败错误中的请求 cookie 会脱敏（仅测试会话）。请求证据仅含方法、路径、HTTP 状态和服务代数。配对截图中的码来自短时测试配对，不是个人设备或账号的访问令牌。

三场景都验：本地注册、无二维码前置、配置入口、称呼/分岔、浏览器刷新、API 关闭重建、明确工具答案完成阶段、早报/文字活真实失败和重试、首次有用失败落盘、最后可选配对、进入工作台、完成标记及设置补配。无设备场景另关停真实 API，再恢复并重试保存；手机兼容页用窄屏浏览器检查提示和关闭（非真手机）。已有设备场景通过真实 pair/start + pair/claim 建测试设备，在引导做到一半时**退出 Node 子进程，再以同一临时 HOME 启动新进程**，验证称呼、阶段、配对和后续完成状态。所有驱动子进程在 finally 中有界退出，不停止别人的服务。

`qa/restart`/`qa/stop` 只负责隔离实例生命周期，不改业务状态。`qa/evidence` 不在生产包中。没有永久后台服务或公网发布；LAN 配对测试只对临时实例开关，mDNS 不广播，结束即关闭。

## 目录布局回归（2026-10-27 Root 退修）

驱动通过 `dependencies.mjs` 从当前插件已安装的包解析 store 导出的源码入口及 Vitest 的 Vite，`fs.allow` 跟随真实包根，不依赖工作树深度。`node --test workbench-plugin/dev/desktop-onboarding-acceptance/dependencies.test.mjs` 检查实际主检出与 worktree 的解析；`node workbench-plugin/dev/desktop-onboarding-acceptance/verify-layouts.mjs` 以 `write:false` 分别构建两边生产 WorkbenchOverlay（不改主检出、不开监听）。这些检查不替代上面的三场景真实浏览器运行。
