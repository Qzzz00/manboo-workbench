# 三入口验收:同一组句子打电话、电脑对话框、手机文字

2026-10-22 起,**每张卡合并前跑一遍**(决策记录同日「全局视角」第 0 步「验收成制度」)。同一组句子打三个入口,
结果并排成一张表:三列都过才算过。句子与期望是数据(`sentences.json`),判法是代码(`judge.ts`),两样都有用例
(`tests/acceptance-three-entrances-*.test.ts`)。

## 一条命令

```bash
cd workbench-plugin
node dev/acceptance-three-entrances/run.ts
```

跑完写两个文件:`docs/验收-三入口同一组句子-<日期>.md`(表 + 逐格细节)与同名 `.json`(原始观察)。
退出码 0 = 每一格都过(n/a 不算);1 = 有不过的;2 = 跑不起来(实例没起来、账号没登上)。
整趟在这台 Air 上约 30–50 分钟:起实例 3 分钟左右;每句跑完要等它开出的事务官会话收住(最多两分钟);
电话一句一通;`--call both` 再加一列文字口,那一列每轮要等工人测试口收尾(无人听的虚拟来电里一轮约 90 秒)。

常用选项:

| 选项 | 用处 |
|---|---|
| `--only desk,phone,call` | 只跑这几个入口 |
| `--sentences s1,s4` | 只跑这几句 |
| `--call both` | 电话打两遍:真音频一列 + 「电话·文字口」一列(字塞在工人识别定稿那一格,识别 / 收音不走)。两列对照分得清是听错了还是办错了;`--call text` 只打文字口;缺省 `audio` |
| `--noisy` | 电话那一列垫一层噪声(「嘈杂」那一遍) |
| `--keep` | 跑完不停实例,看现场;收尾 `node dev/acceptance-three-entrances/stop.ts <临时目录>` |
| `--attach <临时目录>` | 接上 `--keep` 留下的那台(不重起,调脚本时省三分钟;不当正式结果) |
| `--out <文件>` | 报告写别处(试跑时用,别覆盖 docs 里那份) |
| `--no-build` | 不重打插件,用 `lib/` 现有的产物 |

## 它起了什么、碰了什么

**一个都不碰维护者那一套**:真 `~/.dsh` 只读(克隆用),8791 / 8792 / 3080 / 8796 不碰,launchd 里的服务不碰。

- **隔离实例**:临时 HOME(系统临时目录下 `wb-accept-*`),`~/.dsh/node`、`~/.dsh/runtime` 与连接器的依赖目录用 APFS 克隆
  (`cp -c`,不占盘);插件是**这份检出现打的包**(`pnpm build` + `npm pack`),经安装内核 `scripts/install-from-bundle.ts`
  装四步(profile、plugin、work_repo、scripts)。端口:DSH 3093、工作台 8893、模块 8894、语音后端 8892、连接器 8896、
  工人测试口 8897。`app.json` 写 `audience: internal`(同维护者那台,实验开关按内部);`routines.json` 三条例程都关
  (开机露面就跑的开工汇报办完会在通话里插一句,搅进她的回话);交代框的档位保持新装的缺省(`ask`)。
  pnpm 的包仓库用本机共享的 `~/Library/pnpm/store`(临时 HOME 里那份是空的,这台机器上从 npm 现下只有十几 KB/s)。
- **假 `launchctl` / `osascript` / `open`**:放在 PATH 最前面,只记一行(`<临时目录>/blocked.log`)、退 1。同一个用户下
  launchd 的服务名是共用的,不拦的话隔离实例会重启真机的 DSH、连接器、语音后端。
- **自己的语音后端**:仓库的 `butler-server` 起在 8892,HOME 指临时目录,音色库从真机克隆一份(换音色只改克隆),
  语音钥匙回环问隔离实例的 8893 要(`BUTLER_WORKBENCH_URL`)。
- **中转测试账号**:线上中转(`api.aibooo.cn`),名字 `wb-accept-test-…`,第一次跑现注册,之后登录;账号与密码只在本机
  `~/Library/Application Support/workbench-acceptance/relay-account.json`(600),不进仓库、不进交接。房间按账号分,
  与维护者真机那间不是一间。跑完撤掉这台在中转上的设备、退出登录(账号本身中转没有删除接口,留着复用)。
- **通话工人**:跑这份检出的 `channel-worker`(`CHANNEL_WORKER_DIR`),走中转那间房;文字回合测试口开在 8897,口令文件在临时目录。
  **通话护栏关着**(`WORKBENCH_CHANNEL_LOAD_GUARD=off`):开着的话通话期间会把这台 Mac 上别的卡的 vite / tsc 调到后台档,
  验收不碰别人的进程;代价是负载高时识别比装好的产品更容易丢音(报告抬头记着当时的负载)。
- **假手机**:配对一台(`/pair/start` → `/pair/claim`,同手机 App),拿设备令牌。

## 三个入口各怎么打

| 入口 | 怎么打 | 「回话」取的是 |
|---|---|---|
| 电脑对话框 | `POST /butler/item`,请求体照 `client/ButlerInbox.tsx`(`itemBody` + `can_meeting_plan`),带页面的 `Origin` | 框下那条回执,照 `ButlerInbox.tsx` 拼(`receipts.ts`,对照用例读源头核) |
| 手机文字 | `POST /butler/item`,请求体照 `butler-app/src/chat/useSendItem.ts`(`can_file_ask`、`can_meeting_plan`、`client_key`),带设备令牌 | 手机上这一句底下最后显示的那句:直接调手机自己的 `chatModel.ts`(`buildThread` + `mergePending`) |
| 电话 | 假手机进房(`fakePhone.ts`):进房 → `playing` → `call.start` → 开麦,把 macOS「婷婷」念的句子当麦克风放出去;旁人插话拼成「她说半句 → Reed 插一句 → 她说完」一段 | 她说的每一段(房间里的 `butler` 字幕)连起来;识别成什么记在细节里;工具名从工人日志「她调了工具」那一行读 |
| 电话·文字口 | 工人的文字回合测试口 `POST /say`(`channel-worker/src/textTurn.ts`),字塞在识别定稿那一格;旁人插话塞 `asrMixed`(识别拼成一句的样子) | 测试口回的 `said`;工具名与结果也是它回的 |

Pixel 接在这台 Mac 上时可以改用 adb 往手机 App 里打字(`adb shell input text` 不收中文,要装 ADBKeyboard 广播);
今天没接,手机文字一列按设备令牌直打,报告里写明。

每句前后各取一份 `/state`:多出来的卡就是这一句建的。有的句子会开一条事务官会话(「派出去办」),会话在后台接着干、
过一阵自己再建几张卡 —— 所以一句跑完先等这一句开出来的会话不再「在跑」(连着 6 秒,最多两分钟),期间多出来的卡都算这一句的;
等不完的在细节里写明。然后停掉那几条会话(`/butler/item/stop`)、删卡、拒掉挂着的单子,免得下一句被「看板上已有同一件」
「接着上一件说」接走。第 4 句之前把音色换回一个男声,才看得出「换个女声」换没换。

停实例前把工人日志与 DSH 日志拷到临时目录的 `logs/`(识别成什么、调了哪件工具都从这两份来);临时 HOME 删掉。

## 判法(`judge.ts`)

尺子是维护者 10-22 定的:**记一笔一轮完成、推回 0 次、卡的数量和标题对、回话一句说全**。一格只给一句原因,最要紧的在前:

1. 张数与哪几张:期望的卡与新卡一一配对。`todo` = 没派(状态 todo / backlog、没开会话、没有派活记录);`dispatch` = 派了,
   负责人对得上。标题必须含 `must` 里的词、不许含 `mustNot` 里的词(空格不算差别)。
2. 铺垫(第 3 句):第一句必须先问一句,第二句「好,去建吧」才建。
3. 推回:回话里有问号 / 句尾「吗」、或多出「等她批 / 等她回答」的单子,都算推回一次。
4. 回话:`groups` 每组至少命中一个词,`none` 一个都不许有。
5. 音色:第 4 句跑完当前音色得是女声。

格子里的记号:✔ 过;✘ 不过 + 原因;n/a(这一句不走这个入口,比如旁人插话只在电话里);⚠ 出错(跑的时候出了错,不是判不过);
— 没跑(这一列今天打不了,后面写卡在哪)。

## 改句子 / 改期望

改 `sentences.json`,在那张卡的交接里写清改了哪句、为什么;判法跟着改的话先改用例。句子只增不删:删一句等于少验一件。
