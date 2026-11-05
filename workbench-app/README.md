# 工作台.app

窗口编排壳。纯执行器:不含任何业务判断,收到的 `op` 与 `WindowControl` 的 AX 原语一一对应。
决策全在 workbench-plugin(TS 侧,已测);这里只负责把 AX 调用真正打出去。

## 构建

```bash
cd workbench-app
./build.sh
```

产物是 `build/工作台.app`。脚本做的事:`swiftc -O` 编译 `Sources/*.swift`、拷贝 `Info.plist`、
把 `AppIcon.icns` 拷进 `Contents/Resources`(缺了不挡构建,没图标只是难看)、最后**用一张固定的签名身份**
签名(见下)。构建全程不需要网络或 Apple 开发者账号。

## 图标

`AppIcon.icns` 是粒子球,和手机 APP 图标是同一颗球、同一份代码,**产物进 git**,构建时只 cp。
要改样子(或改了 swarm 调参想让图标跟着变)就重跑:

```bash
cd workbench-app
node scripts/render-mac-icon.mjs      # 只要 node + 系统自带 iconutil,不装依赖
```

覆盖写 `AppIcon.icns` 与 `../docs/assets/mac-app-icon-{1024,128}.png`(预览,记得一起提交)。
「安装工作台.app」用的是同一个 icns。细节见 `docs/交接-0918-Mac应用图标.md`。

## 测试

```bash
cd workbench-app
./run-tests.sh
```

壳没有 SwiftPM 工程(build.sh 是 swiftc 直编),所以也没有 `swift test`;测试是一个断言脚本:
把 `Sources/WindowPlacement.swift` 和 `Tests/main.swift` 编到一起跑,全绿退出码 0。
只测纯逻辑(落屏顺序、窗口记忆的读写与失效、收边)——`WindowPlacement.swift` 故意不 import
AppKit,就是为了这一条;AppKit 那半截(NSScreen 换算、拖动通知)造不出来,不在测试里。

### 网页能力的真引擎测试(2026-09-25)

```bash
cd workbench-app
nice -n 15 ./run-web-tests.sh
```

起一个**真 WKWebView**,装上壳自己的 `WebHost`(选文件、新窗口、alert/confirm、下载、导航去留),
对着 `Tests/web/index.html` 真点 +、真往输入框上拖文件、真下载,读网页那一侧实际拿到了什么;还原样
复现了「DSH 对话栏截走文件拖放」再装上插件的守卫(`workbench-plugin/src/client/fileDropGuard.ts`)。
不起完整的壳、不碰任何真东西(不注册登录项、不写 app.json、不连 8791、不弹框、不写真「下载」),
要在有图形会话的 Mac 上跑。对照表与实测记下的 WebKit 行为见 `docs/交接-0925-壳里的网页能力.md`。

## 网页能力(WebHost,2026-09-25)

WKWebView 里不少事要**宿主**来做,宿主不做网页那边就是「点了没反应」且不报错。壳在 `Sources/WebHost.swift`
接住这些(判断在 `Sources/WebPolicy.swift`,有单测):

- `<input type=file>` → 选文件框(app 级模态、深色;accept 过滤、多选、选文件夹);
- `target=_blank` / `window.open` / 主框架里人点的跨源链接 → 交给默认浏览器;
- `alert` / `confirm` / `prompt` → 系统弹框(以前 confirm 永远当「取消」);
- `<a download>`、附件 → 存进「下载」(重名加编号),完成后在访达里选中;
- 主框架不许导航到 `file:`(拖进来没被接住的文件不能把工作台整页换掉)。

## 安装

把 `build/工作台.app` 拖到 `/Applications/` 下最省心——`SMAppService.mainApp.register()`
注册登录项时,不在 `/Applications` 里的 App 更容易被系统拒绝(拒绝也不致命,只是不挡启动,
App 本身照常运行)。不装到 `/Applications` 也能直接双击运行,只是不会开机自启。

## 首次授权(辅助功能)

首次启动时 App 会调用 `AXIsProcessTrustedWithOptions` 触发系统的「辅助功能」授权弹窗。
去「系统设置 → 隐私与安全性 → 辅助功能」里把「工作台」打开,然后点回 App 一次
(`applicationDidBecomeActive` 会重查一次授权状态并把最新值通过 WS 的 `authorized`
消息报给服务端,不会定时轮询系统状态)。

未授权时,`app_info` / `set_window_frame` / `raise_window` 等依赖 AX 的 op 都会失败;
`screen_info` 不需要 AX 权限,始终可用。

## 更新不会丢授权(2026-09-18)

macOS 的 TCC(「辅助功能」那张表)记的**不是路径,是签名** —— 准确说是签名里那条
designated requirement。所以只要签名身份不变,重构建多少次系统都认得这还是同一个 App,
授权跨更新保留。

**每台机器只要做一次:**

```bash
bash deploy/codesign-identity.sh
```

它在登录钥匙串里建一张长期的自签代码签名证书「工作台本机签名」。之后 `./build.sh`
自己会找到它。构建时那两行输出就是证据:

```
签名:工作台本机签名(DFEC52EAF2AC63532DFBBE20E6F8A1A7AB07897A)
designated => identifier "ai.ben.workbench" and certificate leaf = H"dfec52ea…"
```

**第二行两次构建打出来一模一样 ⇒ 授权不会掉。** 要是打出来是
`# designated => cdhash H"…"`,那就是退回了 ad-hoc 签名(证书没建起来),
它每次构建都变,系统当成新 App,授权必掉 —— 这时候要去
「系统设置 → 隐私与安全性 → 辅助功能」把「工作台」关一次再开。

签名身份可以用 `WORKBENCH_CODESIGN_IDENTITY` 换成别的(以后有了 Apple Developer ID
就设它,构建脚本一个字不用改)。

**签名稳定 ≠ 公证。** 第一次从别人手里拿到这个 App 时,Gatekeeper 仍然会拦一道
(要右键 → 打开)—— 那要 Developer ID + 公证才治,见
`docs/交接-0918-壳稳定签名.md` 第五节。

## 窗口在第几层(前台 / 桌面,2026-09-18)

两档,判断在 `Sources/WindowMode.swift`(纯枚举、有测试),AppKit 那半截在
`AppDelegate.applyWindowMode`:

| 档 | 层级 | 什么时候 |
|---|---|---|
| `front` | 普通应用层(`normal`),切过去时还会 `activate` + 置前 | 登录 / 注册 / 首次流程 / 引导 |
| `desktop` | `normal - 1`,原生窗天然排在它前面(原来写死的那一档) | 工作台本体 |

**壳启动默认 `front`** —— 那一刻还没连上工作台、不知道人走到哪一步,先让人看见
(Ben:「安装完……层级已经在底部了,导致我缩小了很多应用才看到页面」)。连上之后由网页
按阶段发 `{"kind":"req","op":"window_mode","mode":"front"|"desktop"}` 覆盖;
判断在工作台那边(`workbench-plugin/src/client/shellWindowMode.ts`,纯函数、有单测)——
只有网页知道此刻屏上渲染的是哪一屏。

`window_mode` **不需要辅助功能授权**(同 `screen_info` / `highlight_region`:只动壳自己这扇窗,
不碰别人的窗口)。服务端那边也据此把它放行在授权门之外——第一次开机时授权多半还没点过,
而登录屏恰恰是最该被看见的那一屏。

切回 `desktop` 时**只改层级、不重排窗口**:那时候原生窗已经贴在窗位上了,再 order 一次只会
搅乱它们的前后关系。前台档不是"总在最前"——别的应用照样盖得住它,那是有意的。

细节与验收清单见 `docs/交接-0918-壳登录时置顶.md`。

## 插件换版自动重载(2026-09-14)

插件发版要 `launchctl kickstart -k` 重启 DSH,壳的 helper WS 会自己重连,但 WKWebView 里的页面
不会跟着刷新,前端代码还是旧版。所以服务端(workbench-plugin `helperChannel`)每次连上都先发
`{"kind":"hello","role":"server","version":"<插件版本>"}`(版本号构建时从 package.json 注入),
壳(`AppDelegate.handleServerHello`)记住上次连上时的版本:

- 第一次连接:只记录,不重载。
- 重连后版本变了:等 3 秒(给 DSH 的网页端起完)再 `webView.reload()` 一次;重载失败沿用
  加载失败自动重试(退避 2→4→8→10 秒),不另起一套。
- 同版本重连(壳自己断线、DSH 没换版就重启):不重载,页面状态不丢。

旧插件不发这条消息,壳就永远停在「只记录」之前,行为与以前一致(⌘R 照旧可用)。

## 配置文件

默认配置(2026-08-21 实测环境写死)是:

- 页面地址:`http://127.0.0.1:3080/?ben-workbench=app`
- 辅助服务 WS:`ws://127.0.0.1:8791/helper`

如需覆盖,在 `~/.dsh/workbench/app.json` 写:

```json
{
  "page_url": "http://127.0.0.1:3080/?ben-workbench=app",
  "helper_ws": "ws://127.0.0.1:8791/helper",
  "screen_hint": "UP2716D"
}
```

三个字段都可选,缺的字段用默认值。**`screen_hint` 没有默认值**(2026-09-18 起):
配了才生效,意思是「不管怎样都把窗口开在名字含这几个字的那台显示器上」。
以前它写死成 `UP2716D`,于是工作台一启动就去铺满那块竖屏——这正是这次要修的毛病。

## 窗口落在哪、摆多大(2026-09-18)

判断都在 `Sources/WindowPlacement.swift`(纯函数、有测试,见上面「测试」一节),
AppDelegate 只负责把 `NSScreen` 折成快照、在合适的时机调用它们。

**启动时挑哪块屏**,按顺序:

1. `screen_hint` 配了且匹配得上 → 那块屏(明确指定,压过下面全部);
2. 上次窗口待过的那块屏,**如果它还接着** → 那块屏;
3. 鼠标此刻所在的那块屏(人刚点开工作台,手就在那块屏上);
4. 主屏;都问不到才退到第一块屏。

**摆多大**:那块屏**第一次**出现工作台 → 铺满它的 `visibleFrame`(不含菜单栏/Dock);
之后 → 还原上次在**这块屏**上的大小和位置,并收进可视区(不超出、不裁切)。

**拖到另一块屏**:松手停稳后(0.4 秒防抖,不在拖动过程中动手),那块屏没来过就铺满它;
来过就还原那块屏记住的**大小**,位置留在刚松手的地方。

**记在哪**:`~/.dsh/workbench/app.json` 的 `window_frames`,按屏分开:

```json
"window_frames": {
  "last_screen": "DELL UP2716D@1440x2560",
  "screens": {
    "DELL UP2716D@1440x2560": { "dx": 0, "dy": 0, "w": 1440, "h": 2535 },
    "27N3F@2560x1440": { "dx": 0, "dy": 0, "w": 2560, "h": 1410 }
  }
}
```

键是「显示器名@整屏分辨率」(名字取不到的虚拟屏退回 `display-<id>@宽x高`);
`dx/dy` 是相对**那块屏** `visibleFrame` 原点的偏移,不是全局坐标——显示器在「排列」里
挪个位置,记忆不会把窗口还原到别的屏上去。这份文件是壳与插件共用的,双方都只改自己那几个键、
不认识的键原样保留(读整份 → 改一个键 → tmp + rename 原子写回)。

删掉 `window_frames` 就回到「每块屏第一次那样铺满」。

**网页布局不需要壳额外做什么**:WKWebView 铺满窗口内容区、跟着窗口一起变,页面里
CSS 媒体查询(`(orientation: landscape)` / `(min-aspect-ratio: …)`)与 `ResizeObserver`
拿到的就是真实宽高;helper 的 `screen_info` 也一直回着 webview 的 `w`/`h`,服务端要
宽高比直接除即可。横屏布局本身是另一张卡(`feat/landscape-layout`)。
