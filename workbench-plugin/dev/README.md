# dev/ —— 手动真跑用的东西(不进构建,不进测试)

## `假会议-测试音频.m4a`

**这是假数据。** 一段 74.3 秒的中文音频,内容是我编的一场假会议(议题是会议模式本身),
由本机 8792 的火山 TTS 念出来、再用 ffmpeg 拼成一段、转成 AAC/m4a(单声道 64kbps)。
**不是真会议,没有任何真人的声音,里面提到的「小王」不是任何人。**

md5 `c0dac9c8abff26fe741f14c10a805c6d`,672KB。

## `meeting-realrun.ts`

会议模式的一次**真跑**:真的火山识别(经本机 8792 `/api/asr`)+ 真的模型
(走 modelService 定的那一家)+ 真的落盘(写在临时目录里)。
自动化用例里这两样都是打桩的,这个脚本是用来量真实数字的。

```bash
# 前提:butler-server(8792)在跑,而且火山识别凭据配好了;模型服务已经接上。
cd workbench-plugin && node dev/meeting-realrun.ts
```

它**只读** `~/.dsh/workbench/model.json` 与 `credentials.json`,一个字节都不写;
产物落在 `--out`(缺省是系统临时目录里新建的一个),不碰 Ben 的工作目录。
真跑量到的数字记在 `docs/交接-0921-会议模式.md` 第五节。

## `whisper-简繁-realrun.ts`

爆款拆解那条**转写 → 繁简**的一次真跑(2026-09-21):真的 ffmpeg、真的 whisper.cpp
(命令与参数与 `src/server/xhsBreakdown.ts` 里那一条一模一样)、真的 `parseSrt` /
`simplifyCues` / `renderTranscriptMd`、真的落盘。打桩的只有下载与模型两样,**脚本自己在输出里标着**。

```bash
cd workbench-plugin
node dev/whisper-简繁-realrun.ts --whisper <whisper-cli 的路径> --model <ggml-base.bin> --audio <一段中文音频>
node dev/whisper-简繁-realrun.ts ... --params    # 多跑一组提示词对比(交接那张表)
```

`whisper-cli` 这台机器上**没有装**(打包是另一张卡的事),路径要自己给。
真跑量到的数字记在 `docs/交接-0922-转写简繁.md` 第一、五节。

## `readability-sample/`

工作台可读性的**整版样张页**(2026-10-21):挂真的 `WorkbenchOverlay`(产品研发布局),`/state` 由假 fetch 答,
数全是 `fixture.ts` 里编的,不读 8791、不读任何真账。审计、规矩、样张见 `docs/交接-1021-工作台可读性/` 与
`docs/设计-工作台可读性规矩-2026-10-21.md`。

- `?ben-workbench=app` 壳模式;`?theme=dark` 深色;`?v=a` / `?v=b` 盖上样张 A / B 的原型层(`aStyle.ts` + `aText.ts` + `aFold.ts`);
  `?template=ops` 同一份夹具换成自媒体布局,核对原型层在那边一条都不生效。
- `cells.html`:余额 / 额度、消耗数据两格按桌面宽度不限高地摆开(整版里只有 196px 高,滚动区下半截截不进去);`?open=1` 把计数那几行点开。
- `FIG_REF=<提交>`:`src/` 整个从那个提交读(`git show`)。「数字格换画法」A 版还没合进 main 时,样张那一侧用它的提交,
  四个数字格就是那张卡的真组件;合进 main 之后不用再带。

```bash
cd workbench-plugin
node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/readability-sample/vite.config.mjs
# 另开一个终端:样张那一侧
PORT=4197 FIG_REF=8d39f927 node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/readability-sample/vite.config.mjs
# 再开一个:出「现在 / A」「现在 / B」整版对照与「格子全貌」,亮暗各一
sh dev/readability-sample/shoot.sh ../docs/交接-1021-工作台可读性
```

## `acceptance-three-entrances/`

**三入口验收**(2026-10-22 起,每张卡合并前跑):同一组句子(`sentences.json`)打电话、电脑对话框、手机文字三个入口,
结果并排成一张表落到 `docs/验收-三入口同一组句子-<日期>.md`。一条命令起隔离实例(临时 HOME、自己的端口、假 launchctl,
不碰真 `~/.dsh`、不停 8791)、绑中转测试账号、配假手机、跑完停掉。怎么跑、它碰了什么、怎么判,见该目录 `README.md`。

```bash
cd workbench-plugin && node dev/acceptance-three-entrances/run.ts
```

## `user-layer-run/`

用户层加载口的**真跑**(2026-10-21,卡「分层第一刀」):`server.ts` 起一台真的工作台服务,用户层是一个真目录(扫描、取代码、
「在访达中打开」都是真的,别的服务一律不接,不碰 `~/.dsh`);页面挂真的 `WorkbenchOverlay`(自媒体布局,看板数据借
`readability-sample/fixture.ts`),`/state.user_layer` 与 `/user-layer*` 经 vite 代理打到那台服务。

```bash
cd workbench-plugin && pnpm build            # 起步层要先拷进 lib/starter-layer
node dev/user-layer-run/server.ts <临时目录> starter 4291      # empty / starter / broken 三种
node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/user-layer-run/vite.config.mjs
# 对照「搬家之前」:同一页用 main 的源码起
PORT=4297 FIG_REF=main node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/user-layer-run/vite.config.mjs
```

`broken` 故意弄坏三格(发布计划 widget.json 写坏、数据复盘语法错、随手记画的时候抛错)。结果记在 `docs/交接-1021-分层第一刀.md`。

## `collab-board/`

协作区的看样页(2026-10-21):**全是假数据**,页面里拦下 fetch(不连 8791、不读写任何真文件),给人看画布的样子与点章 / 拖便签 / 开详情的手感。

```bash
cd workbench-plugin && node_modules/.bin/vite --config dev/collab-board/vite.config.mjs
```
