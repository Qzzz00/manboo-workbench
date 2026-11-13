import AppKit
import WebKit
import ServiceManagement

/// 标准标题栏窗口本该天然 canBecomeKey,这里仍然显式覆盖并保留子类——历史上
/// 无边框模式靠它把 key/main 资格找回来,单一模式后继续沿用同一个类型,
/// 不给 AppKit 留任何"这个窗口该不该抢焦点"的默认判断空间。
final class ShellWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// A1(真机实测,Ben"切换要点两下"):底座层工作台常态非 key window(降半级 level 也让它
/// 更容易失去 key 状态),macOS 对非 key 窗口默认吞掉第一次点击(`acceptsFirstMouse`
/// 缺省 false)——那一下只负责把窗口变成 key/激活 App,真正的点击要等第二下才生效。
/// 覆盖成 true 后第一下点击既激活窗口也直接命中里面的元素,不用先"焦点热身"。
final class ClickThroughWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    /// 网页发来的 `titlebar_drag` 是异步 WKScriptMessage:等壳收到,`NSApp.currentEvent`
    /// 有可能已经不是那一下 leftMouseDown(尤其全屏网页刚切换过界面)。留一份最近的按下,
    /// `performDrag` 才有得用 —— 拿到的是同一次按下,不是随手抓一个不相干的事件。
    private(set) var lastMouseDownEvent: NSEvent?
    override func mouseDown(with event: NSEvent) {
        lastMouseDownEvent = event
        super.mouseDown(with: event)
    }
    override func mouseUp(with event: NSEvent) {
        lastMouseDownEvent = nil
        super.mouseUp(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var socket: HelperSocket!
    var control: WindowControl!
    /// 光圈(2026-09-10):一扇透明、忽略鼠标的浮窗,只画一圈发光边框。跟 control 平级——
    /// 它不碰 AX,自己也就不需要辅助功能授权(同 screen_info)。
    var highlight: HighlightOverlay!
    /// 替网页做浏览器本该做的事(2026-09-25):选文件、新窗口交给浏览器、alert/confirm、下载、
    /// 拖进来的文件不许把整页换掉。判断在 WebPolicy.swift,WebKit 那一半在 WebHost.swift。
    var webHost: WebHost!
    /// 「有一家被叫到前面」是真切过去还是临时叫一下(2026-09-25,卡 P:截图快捷键把企业微信叫出来)。
    /// 判断在 ActivationSense.swift,取样在 ActivationWatch.swift;结论经 socket 发给服务端,窗口槽跟不跟由服务端定。
    var activationWatch: ActivationWatch!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 主菜单(真机反馈):壳原来完全没有 NSApp.mainMenu,标准快捷键(粘贴/刷新/退出等)
        // 全体失灵——AppKit 靠菜单项的 keyEquivalent 才知道该把 ⌘C/⌘V/⌘X/⌘A/⌘R/⌘Q
        // 这些键路由给谁,不需要真的露出来给人看,程序化建、挂到 mainMenu 上就够了。
        buildMainMenu()

        // 这一趟是他自己点开的,还是热更新换完壳之后自动拉起来的(2026-09-21)。
        // 判断全在 ShellRelaunch(纯逻辑,run-tests.sh 里有用例);这里只用它的两个结论。
        let startup = ShellRelaunch.startup(arguments: CommandLine.arguments)

        let config = AppConfig.load()
        pageURL = config.pageURL

        // 落屏与大小(2026-09-18 起):不再写死显示器名,也不再无条件铺满。
        // 顺序是 screen_hint(配了才有)→ 上次待过的屏 → (没记忆时只挑横屏)鼠标所在的横屏 → 主屏;
        // 那块屏有记忆就还原记忆,没有(第一次在这块屏上出现)才铺满它的 visibleFrame。
        // 全部判断在 WindowPlacement 里(有单测),这里只负责把 NSScreen 折成快照再摆。
        windowFrames = AppConfigStore.loadWindowFrames()
        let pairs = Self.screenPairs()
        let picked = WindowPlacement.chooseScreen(screens: pairs.map(\.snapshot),
                                                  hint: config.screenHint,
                                                  lastScreenKey: windowFrames.lastScreen,
                                                  mouse: NSEvent.mouseLocation,
                                                  mainScreenKey: NSScreen.screens.first.map { ScreenSnapshot($0).key })
        // picked 为 nil 只可能是「一块屏都没有」(NSScreen.screens 空)。那种机器上窗口
        // 摆哪都一样,给个固定矩形别崩就行,不记 currentScreenKey(没有屏就没有记忆键)。
        let screen = picked.flatMap { hit in pairs.first(where: { $0.snapshot.key == hit.screen.key })?.screen }
        let initialFrame = picked.map { WindowPlacement.frame(for: $0.screen,
                                                              remembered: windowFrames.frames[$0.screen.key]) }
            ?? CGRect(x: 0, y: 0, width: 1280, height: 800)
        currentScreenKey = picked?.screen.key

        // 单一模式(真机反馈后统一,spec S1):标准标题栏窗口。
        // 不再区分竖屏无边框/主屏可拖动两套——无边框模式下 WKWebView 输入框在部分真机上
        // 判断不到自己在前台,且两套逻辑徒增分支;标准标题栏本身可拖动可关闭,已经满足两边诉求。
        //
        // 2026-09-25(卡 TB,维护者「顶部空隙难受」):仍然是 `.titled` 窗口(无边框那个坑不许回来),
        // 只是标题栏透明、标题隐藏、styleMask 多一个 `.fullSizeContentView` —— 网页内容顶到窗顶、
        // 红绿灯浮在网页顶栏上,顶上不再叠两层标题。常量与判断在 ShellTitleBar(纯逻辑,有用例)。
        window = ShellWindow(contentRect: initialFrame,
                              styleMask: NSWindow.StyleMask(rawValue: ShellTitleBar.styleMask),
                              backing: .buffered, defer: false, screen: screen)
        window.title = "工作台"
        // 标题文字与标题栏底色都不要(标题「工作台」改由网页顶栏那一行小字说)。
        window.titleVisibility = ShellTitleBar.titleHidden ? .hidden : .visible
        window.titlebarAppearsTransparent = ShellTitleBar.titlebarAppearsTransparent
        // 标题栏透明之后拖拽落点只剩网页顶栏;全屏界面(登录 / 启动弹窗 / 首次引导)连顶栏
        // 都没有。原生侧这一条让 WKWebView 没吃掉的窗口空白也能按住拖,与网页那条不冲突。
        window.isMovableByWindowBackground = ShellTitleBar.movableByWindowBackground
        // contentRect 认内容区、setFrame 认整窗矩形:`.fullSizeContentView` 之后两者本该一样大,
        // 这一下仍然留着 —— 它同时把「铺满 visibleFrame」落实一次,不依赖 AppKit 对 contentRect 的换算细节。
        window.setFrame(initialFrame, display: false)
        // 可视区记忆(卡 TB ④):菜单栏改成「自动隐藏和显示」之后 visibleFrame 会长高一截,
        // 屏参数变化那一下得知道「刚才铺满的是多大」才能决定跟不跟着重新铺满(WindowPlacement.refit)。
        lastVisibleFrame = picked?.screen.visibleFrame

        // 绿色按钮只放大铺满(zoom),不许进原生全屏(spec S1):原生全屏会把这个 App
        // 独占进它自己的 Space,贴合编排(W1–W9)靠 AX 坐标把别的应用窗口摆到这块屏幕上,
        // 一旦独占了 Space,那些窗口摆过来也看不见——贴合直接报废。
        window.collectionBehavior = [.fullScreenNone]
        // A1:用 ClickThroughWebView 而不是裸 WKWebView——首击穿透依赖 acceptsFirstMouse
        // 覆盖,不是这里单独再写一遍判断。
        // 壳身份标记(2026-08-26 矩形投毒案二审):`?ben-workbench=app` 这个 URL 参数谁都能
        // 加——真机实证有并行会话在真实浏览器里带着它开工作台页做小视口验证,页面按壳的
        // 身份把 1240×120 的假槽位矩形报进服务端,点谁的标签谁被踢。URL 参数只配管样式,
        // 身份得用浏览器页面伪造不了的通道:壳给自己的 WKWebView 打专属 UA 标记
        // (applicationNameForUserAgent 会拼在默认 UA 之后),服务端 /slot/rect(及同类
        // 几何上报)对 source:'app' 的请求校验这个标记。
        let webConfig = WKWebViewConfiguration()
        webConfig.applicationNameForUserAgent = "BenWorkbenchShell/1"
        // 加载占位(2026-09-23,见 LoadingCover.swift):插件挂上后发 ready 才揭开,盖住上游的「Loading plugins…」。
        webConfig.userContentController.add(WeakScriptMessageHandler(self), name: LoadingCover.handlerName)
        let bounds = window.contentView!.bounds
        webView = ClickThroughWebView(frame: bounds, configuration: webConfig)
        webView.autoresizingMask = [.width, .height]
        // 以前壳没有 uiDelegate:输入框的 + 点了不弹选文件框、target=_blank 的链接点了没反应、
        // window.confirm 直接当「取消」(移除设备、重置账号悄悄不做)。见 WebHost.swift 顶上那张表。
        webHost = WebHost(page: config.pageURL)
        webHost.window = window
        webView.uiDelegate = webHost
        // 真机录性能(2026-09-24 第五轮):默认不可检查;统筹要用 Safari「开发」菜单连这块 WKWebView 录 Performance 时,
        // 先 `defaults write ai.ben.workbench WorkbenchInspectable -bool true` 再开壳。用户那边永远是关的。
        if #available(macOS 13.3, *) {
            webView.isInspectable = UserDefaults.standard.bool(forKey: "WorkbenchInspectable")
        }
        loadingCover = LoadingCoverController(frame: bounds)
        let container = NSView(frame: bounds)
        container.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        container.addSubview(loadingCover.view)
        window.contentView = container
        // 以前 contentView 就是 webView,键盘焦点天然落在它上面;垫了一层容器之后要明说一次。
        window.initialFirstResponder = webView
        window.makeFirstResponder(webView)
        loadingCover.cover()
        loadingCover.onRetry = { [weak self] in self?.beginLoad(why: "他点了「重试」") }
        // 加载失败自动重试(见下面 WKNavigationDelegate 三个方法的注释)。
        webView.navigationDelegate = self
        /**
         * **先探工作台的服务在不在,再让页面开始加载**(2026-09-26,卡 U6)。
         * 直接 load 的那一版会在"DSH 起来了、插件还没挂上"那一刻把一张空页面提交进来 ——
         * 盖板等不到插件的 ready,20 秒兜底一到就揭开,整窗一片白(09-26 真撞上)。
         * 探针地址与退避规则在 ShellReadiness.swift。
         */
        readinessProbe = ShellReadiness.probeURL(helperWS: config.helperWS)
        beginLoad(why: "壳启动")
        // 窗口代理最后才挂:初始 setFrame 也会发 windowDidMove/DidResize,挂早了会把
        // 「启动落屏」这一下当成「用户拖动」记一笔(值一样,只是白写一次盘)。
        window.delegate = self
        // 窗口层级:分「前台 / 桌面」两档,判断在 ShellWindowMode(纯枚举、有单测)。
        //
        // 桌面档(原来写死的那一档)——工作台本身只是个底座,认领窗口(贴合编排摆过来的
        // 普通层窗口)必须永远浮在它上面:.normal 层级点哪都会被 NSApp.activate() 顶到
        // 最前,反而把已经贴好的认领窗口压到身后,变成"点一下工作台就把窗口盖住"这种
        // 体验。降半级(normal-1)后工作台仍然收得到点击/键盘输入(canBecomeKey 见
        // ShellWindow 覆盖,跟窗口层级是两回事),但普通层的窗口天然排在它前面。
        //
        // 前台档(2026-09-18 新增,Ben:「登录和引导的时候,应该是和其他应用一样,能在
        // 顶部的,现在写死是底部」)——第一次打开时屏幕上既没有窗位也没有认领的窗口,
        // 压在底下的唯一后果就是人看不见它。**启动时默认就是前台档**:那一刻还没连上
        // 工作台、不知道人走到哪一步,先让人看见;连上之后由网页发 window_mode 决定
        // (见下面 applyWindowMode)。
        //
        // 屏变自愈(handleScreenParametersChanged)只挪现有窗口的 frame,不重建窗口,
        // level 不会被重置,不用在那边重复设置。
        applyWindowMode(windowMode)

        // 屏变自愈(spec S2):真机实测 UU 远程虚拟屏会整体顶替物理双屏,壳的窗口坐标
        // 会指向不存在的区域,贴合目标全部作废——屏变必须重定位,不能指望窗口还留在原处。
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScreenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)

        // 可视区自己会变,而通知不一定来(2026-09-26 卡 TB 真机回访:菜单栏改成自动隐藏之后
        // 窗口没跟着长高)。除了上面那条通知,壳自己每两秒核对一次 —— 见 reconcileVisibleFrame。
        startVisibleFrameWatch()

        // 辅助功能:**启动时只静默查,不弹系统框**(2026-09-23 从零重装验收)。
        //
        // 以前这里是 AXIsProcessTrustedWithOptions(prompt: true):壳一打开、工作台页面都还没出来,
        // 系统那个「“工作台”想控制这台电脑」就先跳了出来 —— 新用户根本不知道为什么要给。
        // 现在弹框只在他**自己点了「去授权」**的时候才发生(引导第 3 步「系统授权」、体检、
        // 顶上横幅、窗位槽红字,四处都是同一颗按钮 → POST /setup/open {pane:'accessibility'}
        // → 服务端经 helper 通道发 `request_accessibility` → 下面 requestAccessibilityPrompt)。
        // 那时候按钮旁边已经写着为什么要它(窗位、拖窗、认领、送话都要)。
        //
        // 授权状态变化没有系统回调,激活 App 时重查一次(授权完点回 App 就会刷新),不定时轮询。
        // 没授权的时候界面上那条共用的「还差一个授权」红字照出 —— 少的只是启动那一下弹框。
        let trusted = AXIsProcessTrusted()

        control = WindowControl()
        highlight = HighlightOverlay()
        socket = HelperSocket(url: config.helperWS, control: control, highlight: highlight,
                              authorized: trusted) { [weak self] in self?.screenInfoPayload() ?? [:] }
        // 插件换版自动重载(见下面 handleServerHello 的注释):要在 start() 之前挂好,
        // 第一次连接的 hello 才不会漏掉——漏掉了就没有"上次版本"可比,第一次换版会白过。
        socket.onServerHello = { [weak self] version in self?.handleServerHello(version: version) }
        // 前台 / 桌面两档:同上,要在 start() 之前挂好——网页可能在壳刚连上的头几毫秒
        // 就把当前阶段报过来,挂晚了那一条会掉在地上(网页只在状态变化时重发一次)。
        socket.onWindowMode = { [weak self] mode in self?.handleWindowMode(mode) }
        socket.onSystemAwake = { [weak self] enabled in self?.applySystemAwake(enabled: enabled) ?? false }
        // 「出门时电脑不睡」(2026-10-03):服务端算好「开关开着 + 手机在外面连着」后下发,
        // 壳只管让它立刻生效 —— 从这一刻起 shouldHold 不看前台。
        socket.onAwayAwake = { [weak self] active in self?.applyAwayAwake(active: active) ?? false }
        // 窗口槽成员表(2026-10-04,卡「常亮认窗口槽里的程序」):她点进槽里那扇真窗之后,
        // 最前面的 App 是那一家 —— 有了这张表,那一刻也算「工作台在前台」。
        socket.onSlotApps = { [weak self] bundleIds in self?.applySlotApps(bundleIds: bundleIds) ?? false }
        socket.onRequestAccessibility = { [weak self] in self?.requestAccessibilityPrompt() ?? false }
        // 系统通知(2026-09-25,卡 M):事务官有话问你 / 要你批一件事,壳不在前台时弹;点了回到前台、摊开那一张。
        // 通知到底弹没弹(卡 M 补):每一步都回给服务端(/state.helper.notify),壳日志里也有一行。先挂回调再 install。
        notifier.onStatus = { [weak self] payload in self?.socket?.sendNotifyStatus(payload) }
        notifier.install()
        notifier.onClick = { [weak self] key in self?.handleNotificationClick(key) }
        socket.onNotify = { [weak self] key, title, body, clear in
            guard let self else { return ["shown": false, "reason": "壳在退出"] }
            if clear { self.notifier.clear(key: key); return ["shown": false, "reason": "收掉了"] }
            let decision = self.notifier.show(key: key, title: title, body: body, appActive: NSApp.isActive)
            return ["shown": decision.show, "reason": decision.reason ?? ""]
        }
        socket.start()

        // ax_stale(1b):休眠/坏死上报要靠 socket 的出站消息,但 socket 比 control 晚
        // 创建,这根线只能在这里回填。闭包内 weak 引用 socket——socket 已经单向持有
        // control,这里再反向强引用回去就成环了。
        control.onAxStale = { [weak socket] bundleId, axErr, axCount, cgCount in
            socket?.sendAxStale(bundleId, axErr, axCount, cgCount)
        }

        // 被叫到前面的那一家(2026-09-25,卡 P):真切过去 / 临时叫一下,结论发给服务端。
        // 同上:socket 比 control 晚建,线在这里接;闭包里 weak,不成环。
        activationWatch = ActivationWatch(ownBundleId: Bundle.main.bundleIdentifier ?? "ai.ben.workbench")
        activationWatch.axUnavailable = { [weak control] bundleId in control?.isAxDead(bundleId) ?? false }
        activationWatch.onReport = { [weak socket] payload in socket?.sendActivation(payload) }
        // 遮罩一收、服务端预约过:壳当场藏回去(2026-09-25 卡 P 补),与 hide_app 同一个动作。
        activationWatch.onRehide = { [weak control] bundleId in _ = control?.hide(bundleId) }
        // 遮罩还开着就把被掀出来的那一家的普通窗口挪到屏外,藏好后挪回(卡 P 补二)。这两根在 ActivationWatch 自己那条队列上调。
        activationWatch.park = { [weak control] bundleId, frames, displays in
            control?.park(bundleId, frames: frames, displays: displays) ?? ([], "壳没接挪窗")
        }
        activationWatch.unpark = { [weak control] bundleId, windows in
            control?.unpark(bundleId, windows) ?? (windows, "壳没接挪窗")
        }
        socket.onArmRehide = { [weak activationWatch] bundleId in activationWatch?.arm(bundleId) ?? false }
        socket.onAppShown = { [weak activationWatch] bundleId in activationWatch?.cancelRehide(bundleId) }

        // A2(c):启动就把当前所有常规界面应用挂上观察者,不等服务端第一次下发 observe——
        // 拖入即认领是产品语义,壳自己就该知道该看哪些应用(NSWorkspace 启动通知会补
        // 未来新起的应用,见下面两个 observer)。
        // M5(review):这里的返回值(本次挂载失败的 bundle id)故意丢弃,不是漏接——
        // 此刻 socket 刚 start(),大概率还没走完 hello/authorized 握手,没有信道能把
        // 这份失败清单报给服务端(dockService.noteObserveFailures 挂在 WS 请求响应
        // 链路上)。不是永久丢失:这些失败的 bundle 没能进 watches,服务端一旦授权就会
        // 发第一次真正的 observe 请求,attachAllRunning() 对着同一批仍未挂上的应用
        // 重新尝试一遍,那次的失败清单会走 HelperSocket → noteObserveFailures 正常上报
        // (noteObserveFailures 那一侧现在只认"已认领或 registry 里有的" bundle,见
        // dock.ts 同一波修复——全量观察后大部分挂载失败是无关应用的噪音,不值得上屏)。
        control.attachToCurrentApps()

        // 登录项(spec W7):注册失败不致命(比如 App 不在 /Applications),不挡启动。
        try? SMAppService.mainApp.register()

        // 拖动落定事件(窗位叠 v2 Task 1,V8 已批的事件型 AX 观察):observe 名单里的
        // 应用如果还没启动,靠这两个 NSWorkspace 通知补挂/清理 AXObserver——不轮询
        // "这个应用起来了没"。
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(handleAppLaunched(_:)),
            name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(handleAppTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)

        // 激活即重挂(1a):用户点了某个应用意味着即将交互(拖拽必先点击),此刻无条件
        // 拆旧重挂能让老进程对 Chromium 系应用的坏死观察者在拖拽落定前恢复新鲜——
        // WHY 详见 WindowControl.handleAppActivated 顶上的注释。
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(handleAppActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)

        // 热更新换完壳之后自动拉起来的这一趟(2026-09-21):**强行**抬到最前面。
        // 判断在 ShellRelaunch(有单测);为什么不能只靠上面那一下 applyWindowMode(.front)
        // 里的 `NSApp.activate()` —— 见 ShellStartup.activateOnLaunch 的注释
        // (macOS 14 起无参那版是合作式的,别的 App 在前台时系统可以不理它)。
        // 窗口摆在哪儿不用管:旧壳退出前已经把那一帧同步落了盘,上面的落屏那一段读的就是它。
        if startup.activateOnLaunch {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }

        // 在前台就常亮(2026-09-27,卡 IN):启动这一下先算一次 —— 普通启动多半就是在前台,
        // 而 applicationDidBecomeActive 不保证一定会在启动后再发一次。
        refreshDisplayAwake()
        // 工作台开着时电脑不睡(2026-09-28,卡 AW):起来就按住,退出才放掉,中间不看前台后台。
        refreshSystemAwake()
        /*
         * 锁屏时窗口型的家送不进(2026-10-03):订上系统那两条锁 / 解锁通知 ——
         * 只为记一行日志 + 把那 200ms 的缓存立刻作废。「此刻锁没锁」每次都真去问
         * `CGSessionCopyCurrentDictionary()`(见 `ScreenLock.swift` 文件头:壳可能在锁屏之后才起来,
         * 那时一条通知都收不到)。
         */
        ScreenLock.start()
    }

    /// 系统通知(2026-09-25,卡 M)。
    private let notifier = ShellNotifier()

    /// 他点了「事务官有话问你」那条通知:壳回到前台、窗口置前,再告诉服务端是哪一张(页面切到事务官、摊开它)。
    private func handleNotificationClick(_ key: String) {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        socket?.sendNotificationClick(key)
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        socket?.updateAuthorized(AXIsProcessTrusted())
        // 回到前台 = 该按住那条「别让屏幕暗下去」的断言了(2026-09-27,卡 IN)。
        refreshDisplayAwake()
        // 他多半是刚从系统设置里点完什么回来(菜单栏、Dock、分辨率):立刻核对一次可视区,
        // 不用等定时那一轮(2026-09-26 卡 TB 真机回访)。
        reconcileVisibleFrame(reason: "回到前台")
    }

    /// 他点了「去授权」:这时候才让系统弹那个框(同时把「工作台」登记进辅助功能列表 ——
    /// 从没调过带 prompt 的这一下,系统设置那张表里压根没有「工作台」这一行,只能按 + 自己找)。
    /// 已经授权了就只是查一下,不会弹。返回此刻是否已授权。
    private func requestAccessibilityPrompt() -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(opts)
        socket?.updateAuthorized(trusted)
        return trusted
    }

    // MARK: - 前台 / 桌面两档窗口模式(2026-09-18,Ben:「登录和引导的时候……现在写死是底部」)

    /// 此刻是哪一档。**启动默认 .front**:还没连上工作台、不知道人在哪一步时,先让人看见。
    /// 网页一旦连上就会按阶段(登录 / 首次流程 / 引导)发 window_mode 覆盖它。
    private var windowMode: ShellWindowMode = .front

    /// 真正去动 AppKit 的那一半(哪一档、要不要置前的判断全在 ShellWindowMode 里,有单测)。
    ///
    /// 前台档要 activate + makeKeyAndOrderFront —— 没有这两下,光改 level 只是"允许它排在
    /// 前面",已经被别的应用盖住的窗口不会自己浮上来,Ben 看到的还是"要缩小一堆应用才找得到"。
    /// 桌面档只改 level、**不重排窗口**:那时候原生窗已经贴在窗位上了,再 order 一次只会
    /// 搅乱它们的前后关系(降级本身已经足够让它们浮到壳上面)。
    private func applyWindowMode(_ mode: ShellWindowMode) {
        windowMode = mode
        guard let window = window else { return }
        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue + mode.levelOffset)
        if mode.shouldActivate {
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        }
    }

    /// 网页经 helper 通道发来的 `window_mode`(HelperSocket 已经解析好并切到主线程)。
    /// 同一档重复发不做任何事:网页那边只在状态变化时发一次,这里再兜一道,免得
    /// 一次多余的 front 把正在用别的应用的人打断。
    private func handleWindowMode(_ mode: ShellWindowMode) {
        if mode == windowMode { return }
        applyWindowMode(mode)
    }

    // MARK: - 落屏与窗口记忆(2026-09-18,Ben:「一上来就撑满竖屏不对;拖到横屏也不变形」)
    //
    // 判断全在 WindowPlacement(纯函数、有单测),这一节只做三件事:把 NSScreen 折成快照、
    // 在合适的时机调用那些函数、把结果落到 app.json 的 window_frames。

    /// app.json 里 window_frames 的内存态。启动读一次,之后以内存这份为准往回写。
    private var windowFrames = WindowFrameStore()
    /// 窗口此刻在哪块屏(记忆键)。用键而不是 NSScreen 对象:屏参数一变 AppKit 会把
    /// NSScreen 全体换成新对象,拿旧对象去 `screens.contains` 永远是假。
    private var currentScreenKey: String?
    /// 拖动/缩放防抖:拖一次窗口会连发几十条 windowDidMove,不能每条都读写一次 app.json。
    private var pendingWindowSave: DispatchWorkItem?
    /// 正在由壳自己 setFrame(换屏重排/屏变收边)。这期间发出来的 move/resize 不是用户操作,
    /// 不再触发一轮防抖——否则「重排 → 通知 → 又一轮 → 又写一次盘」会多绕一圈。
    private var isApplyingPlacement = false
    /// 当前这块屏上次见到的可视区(卡 TB ④)。菜单栏改成自动隐藏、Dock 显隐都会让它变;
    /// 「刚才是不是正铺满」只能跟**旧的**可视区比,所以得记一份。
    private var lastVisibleFrame: CGRect?
    /// 定时核对可视区的表(2026-09-26 真机回访,见 reconcileVisibleFrame 顶上那段)。
    private var visibleFrameTimer: Timer?

    private struct ScreenPair {
        let screen: NSScreen
        let snapshot: ScreenSnapshot
    }

    private static func screenPairs() -> [ScreenPair] {
        NSScreen.screens.map { ScreenPair(screen: $0, snapshot: ScreenSnapshot($0)) }
    }

    /// 屏变自愈(spec S2):UU 远程虚拟屏会整体顶替物理双屏,壳的窗口坐标会指向不存在的
    /// 区域,贴合目标全部作废——屏变必须重定位,不能指望窗口还留在原处。
    ///
    /// 2026-09-18 改的只是「怎么重定位」:原来的那块屏还在就只做收边(分辨率变小、Dock
    /// 显隐都会让 visibleFrame 缩水,窗口可能被顶到屏外);那块屏没了才按新的落屏顺序
    /// 重新落一次,并且认那块新屏自己的记忆(而不是一律铺满)。
    @objc private func handleScreenParametersChanged() {
        guard let window = window else { return }
        let pairs = Self.screenPairs()
        guard !pairs.isEmpty else { return }

        if let key = currentScreenKey, let here = pairs.first(where: { $0.snapshot.key == key }) {
            // 2026-09-25(卡 TB ④):原来这里只 fit(收边)。菜单栏改成「自动隐藏和显示」之后
            // visibleFrame 长高一截,只收边的窗口会在顶上留一条空带 —— 刚才正铺满的就跟着铺满
            // 新的可视区(判断在 WindowPlacement.refit,有用例);他自己拖小过的只收边。
            let target = WindowPlacement.refit(window.frame, from: lastVisibleFrame, into: here.snapshot.visibleFrame)
            lastVisibleFrame = here.snapshot.visibleFrame
            // 只有真的动了才落盘:这条通知连 Dock 显隐都会发,窗口没动就别白写一次文件。
            if applyPlacement(target) {
                persistFrame(on: here.snapshot)
            }
            // 2026-09-26 真机回访:这条通知发出来的**那一刻** NSScreen 不一定已经换成新值
            // (上面读到的还是旧可视区,这一下就白过了)。隔一下再核对一次,不必等定时那一轮。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.reconcileVisibleFrame(reason: "屏参数通知之后 0.6 秒")
            }
            return
        }

        let config = AppConfig.load()
        let picked = WindowPlacement.chooseScreen(screens: pairs.map(\.snapshot),
                                                  hint: config.screenHint,
                                                  lastScreenKey: windowFrames.lastScreen,
                                                  mouse: NSEvent.mouseLocation,
                                                  mainScreenKey: NSScreen.screens.first.map { ScreenSnapshot($0).key })
        guard let snapshot = picked?.screen else { return }
        currentScreenKey = snapshot.key
        lastVisibleFrame = snapshot.visibleFrame
        applyPlacement(WindowPlacement.frame(for: snapshot, remembered: windowFrames.frames[snapshot.key]))
        persistFrame(on: snapshot)
    }

    // 三条都只是「窗口动过了」的信号,统一走防抖:真正判断换没换屏在 handleWindowSettled。
    // 特意**不**在 windowDidChangeScreen 里当场重排——那条通知在拖动**过程中**就会发
    // (窗口大半个身子过界的瞬间),当场改 frame 等于在人手上把窗口抽走。
    func windowDidMove(_ notification: Notification) { scheduleWindowSave() }
    func windowDidResize(_ notification: Notification) { scheduleWindowSave() }
    func windowDidChangeScreen(_ notification: Notification) { scheduleWindowSave() }

    // MARK: - 在前台就常亮(2026-09-27,卡 IN)

    /// 「工作台在最前面的时候别让屏幕暗下去」。要不要按住的判断在 `DisplayAwakePolicy`
    /// (纯逻辑,run-tests.sh 里有用例);真按住那条断言的在 `DisplayAwake`。
    ///
    /// 2026-10-03 起多一条理由:「出门时电脑不睡」(缺省关,见 `awayKeepAwake`)。
    private let displayAwake = DisplayAwake()

    /// 「出门时电脑不睡」此刻成不成立(2026-10-03,卡「出门时电脑不睡」)。
    ///
    /// **服务端算好的一个结论**:设置里那颗开关开着 **且** 此刻真有一台已配对手机经中转连着。
    /// 壳一个判断都不做(它既不知道那颗开关、也看不见房间里有谁),只收 `away_awake` op。
    /// **起来缺省假** —— 壳刚起来 / 没连上服务端时就是 2026-10-03 之前的行为;
    /// 服务端那一拍会在接上之后把此刻的结论补发一次(插件那边的 `awayAwake.pump`)。
    private var awayKeepAwake = false

    /// 此刻窗口槽里都有谁(bundle id)。**插件下发的那一份**(`slot_apps` op,源头是 dock.json 那一叠)——
    /// 2026-10-04,卡「常亮认窗口槽里的程序」。
    ///
    /// **一处主人**:谁在槽里只有 dock.json 知道(认领 / 除名 / 切换都在插件那边),壳不另造一张表、
    /// 也不从「我被叫去摆过谁的窗」反推(那会把弹层让路、截图遮罩底下挪的那几发也算进来)。
    /// **起来缺省空** —— 还没下发 / 旧插件不发这一格时就是 2026-10-04 之前的行为。
    private var slotBundleIds: Set<String> = []

    /// 把这一刻的六个事实交给策略,再把结论落实到系统上。
    /// 切走 / 藏起来 / 收进坞 / 退出 / **最前面那一家换了**都会走到它。
    private func refreshDisplayAwake(terminating: Bool = false) {
        displayAwake.apply(currentDisplayMoment(terminating: terminating))
    }

    /// 这一刻的六个事实。只在这一处从 AppKit 读 —— `refreshDisplayAwake` 与
    /// `applyAwayAwake` / `applySlotApps` 的回包必须是同一份事实,否则设置页显示的就不是系统里的实情。
    private func currentDisplayMoment(terminating: Bool = false) -> DisplayAwakePolicy.Moment {
        DisplayAwakePolicy.Moment(
            appActive: NSApp.isActive,
            windowVisible: window?.isVisible ?? false,
            windowMiniaturized: window?.isMiniaturized ?? false,
            terminating: terminating,
            awayKeepAwake: awayKeepAwake,
            // 现问现答,不存:`NSWorkspace` 这一格本来就是系统的权威答案,
            // 壳自己记一份只会在「切得太快」那几拍上和系统不一致。
            slotAppFront: DisplayAwakePolicy.slotAppFront(
                front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
                members: slotBundleIds))
    }

    /// 服务端下发「出门那一格」的新结论(`away_awake {active}`)。回此刻真按着没有,
    /// 好让设置页显示的就是系统里的实情(同 `applySystemAwake` 那条形状)。
    private func applyAwayAwake(active: Bool) -> Bool {
        awayKeepAwake = active
        refreshDisplayAwake()
        return DisplayAwakePolicy.shouldHold(currentDisplayMoment())
    }

    /// 插件下发窗口槽成员表(`slot_apps {bundle_ids}`,2026-10-04)。收完立刻重算一次 ——
    /// 她这会儿可能正用着槽里那一家,而壳上一拍还以为槽是空的。回此刻真按着没有(同上面那条形状)。
    private func applySlotApps(bundleIds: [String]) -> Bool {
        slotBundleIds = Set(bundleIds.filter { !$0.isEmpty })
        refreshDisplayAwake()
        return DisplayAwakePolicy.shouldHold(currentDisplayMoment())
    }

    // MARK: - 工作台开着时电脑不睡(2026-09-28,卡 AW)

    /// 「工作台在运行期间,整台电脑别因为闲着而睡过去」。判断在 `SystemAwakePolicy`
    /// (纯逻辑,run-tests.sh 里有用例);真按住那条断言的在 `SystemAwake`。
    /// 与上面那条「在前台就常亮」是两条独立的断言,互不替代(前者屏幕、后者整机)。
    private let systemAwake = SystemAwake()

    /// 设置里那颗开关此刻的值。启动时从 app.json 读一次(缺席 = 开),
    /// 她在设置里点一下时由服务端发 `system_awake` 过来当场改 —— 不用重开工作台。
    private var systemAwakeOn = SystemAwakePolicy.settingOn(AppConfigStore.read())

    private func refreshSystemAwake(terminating: Bool = false) {
        systemAwake.apply(SystemAwakePolicy.Moment(settingOn: systemAwakeOn, terminating: terminating))
    }

    /// 服务端把设置里那颗开关的新值发过来(app.json 由插件那边落盘,这里只管立刻生效)。
    /// 回此刻真按着没有,好让设置页显示的就是系统里的实情。
    private func applySystemAwake(enabled: Bool) -> Bool {
        systemAwakeOn = enabled
        refreshSystemAwake()
        return SystemAwakePolicy.shouldHold(SystemAwakePolicy.Moment(settingOn: systemAwakeOn))
    }

    func applicationDidResignActive(_ notification: Notification) { refreshDisplayAwake() }
    func applicationDidHide(_ notification: Notification) { refreshDisplayAwake() }
    func applicationDidUnhide(_ notification: Notification) { refreshDisplayAwake() }
    func windowDidMiniaturize(_ notification: Notification) { refreshDisplayAwake() }
    func windowDidDeminiaturize(_ notification: Notification) { refreshDisplayAwake() }
    func windowWillClose(_ notification: Notification) { refreshDisplayAwake(terminating: true) }

    private func scheduleWindowSave() {
        if isApplyingPlacement { return }
        pendingWindowSave?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.handleWindowSettled() }
        pendingWindowSave = work
        // 0.4 秒:拖动松手到手真正停下大约这个量级;再长人会看见窗口「迟到一下才变形」。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// 窗口停下来了:换屏了就按新屏重排,然后把当前 frame 记到这块屏名下。
    private func handleWindowSettled() {
        pendingWindowSave = nil
        guard let window = window else { return }
        let pairs = Self.screenPairs()
        // window.screen 是「此刻覆盖面积最大的那块屏」,正是人眼里「窗口在哪块屏上」。
        guard let here = window.screen.flatMap({ s in pairs.first(where: { $0.screen == s }) })
            ?? currentScreenKey.flatMap({ key in pairs.first(where: { $0.snapshot.key == key }) }) else { return }

        lastVisibleFrame = here.snapshot.visibleFrame
        if here.snapshot.key != currentScreenKey {
            currentScreenKey = here.snapshot.key
            applyPlacement(WindowPlacement.frameOnArrival(current: window.frame,
                                                          screen: here.snapshot,
                                                          remembered: windowFrames.frames[here.snapshot.key]))
        }
        persistFrame(on: here.snapshot)
    }

    // MARK: - 定时核对可视区(2026-09-26,卡 TB 真机回访)
    //
    // 维护者把系统设置「桌面与程序坞 → 自动隐藏和显示菜单栏」改成「始终」之后,2560×1440 那块屏的
    // 可视区从 2560×1410 变成 2560×1440,**壳窗口没跟着长高**,顶上仍旧空着 30 点。
    //
    // 壳原来只在 `didChangeScreenParametersNotification` 那一下核对可视区。这个设置在 macOS 26 上
    // 要么根本不发那条通知,要么发的时候 NSScreen 还停在旧值 —— 两种情形里那唯一的一次机会都白过,
    // 而且**再没有第二次**:窗口就一直空着那一条,只能手动重开壳。
    //
    // 所以改成机制:除了通知(上面 handleScreenParametersChanged,并在 0.6 秒后补一次),壳自己
    // 每 `WindowPlacement.visibleFramePoll` 秒核对一次。核对本身很便宜 —— 读一次 NSScreen.visibleFrame
    // 再比一个 CGRect,没变就立刻回去(常态);变了才交给 WindowPlacement.reconcile 算该不该挪。
    //
    // 什么时候不核对(免得在人手上把窗口抽走):壳自己正在 setFrame、拖动/缩放的防抖还没落定、
    // 鼠标键还按着(正在拖或正在拉边)。这三种情况下过一轮再说,反正每 2 秒还会再来。

    private func startVisibleFrameWatch() {
        visibleFrameTimer?.invalidate()
        let timer = Timer(timeInterval: WindowPlacement.visibleFramePoll, repeats: true) { [weak self] _ in
            self?.reconcileVisibleFrame(reason: "定时核对")
        }
        // .common 模式:拖窗口、菜单弹开这些「跟踪态」里定时器照样走(默认模式会被它们停住)。
        RunLoop.main.add(timer, forMode: .common)
        visibleFrameTimer = timer
    }

    private func reconcileVisibleFrame(reason: String) {
        guard let window = window, !isApplyingPlacement, pendingWindowSave == nil else { return }
        // 手按着(拖窗口 / 拉边框 / 在别处按着都算):这一轮不动它。
        if NSEvent.pressedMouseButtons != 0 { return }
        // 认记忆键那块屏,不认 window.screen:窗口正跨在两块屏之间的时候,「在哪块屏上」
        // 由拖动落定(handleWindowSettled)说了算,核对这一路不掺和。
        guard let key = currentScreenKey,
              let here = Self.screenPairs().first(where: { $0.snapshot.key == key }) else { return }
        let visible = here.snapshot.visibleFrame
        let previous = lastVisibleFrame
        defer { lastVisibleFrame = visible }
        guard let target = WindowPlacement.reconcile(window: window.frame,
                                                     previous: previous,
                                                     visible: visible) else { return }
        // 真动了才写一行日志(没变的那几百次不写):下次真机上再出「顶上空一条」,
        // 看这行就知道壳到底有没有看见可视区变化。
        NSLog("可视区变了(\(reason)):\(NSStringFromRect(previous ?? .zero)) → \(NSStringFromRect(visible)),窗口 \(NSStringFromRect(window.frame)) → \(NSStringFromRect(target))")
        if applyPlacement(target) { persistFrame(on: here.snapshot) }
    }

    /// 返回「真的动了」——调用方据此决定要不要落盘。
    @discardableResult
    private func applyPlacement(_ frame: CGRect) -> Bool {
        guard let window = window, frame != window.frame else { return false }
        isApplyingPlacement = true
        window.setFrame(frame, display: true)
        // 标志位在下一轮 runloop 才放开:setFrame 引发的 move/resize 通知这一轮发完了。
        DispatchQueue.main.async { [weak self] in self?.isApplyingPlacement = false }
        return true
    }

    private func persistFrame(on screen: ScreenSnapshot, sync: Bool = false) {
        guard let window = window else { return }
        windowFrames.frames[screen.key] = WindowPlacement.remember(frame: window.frame, on: screen)
        windowFrames.lastScreen = screen.key
        if sync { AppConfigStore.saveWindowFramesSync(windowFrames) }
        else { AppConfigStore.saveWindowFrames(windowFrames) }
    }

    /// 防抖还没到点就退出(拖完立刻 ⌘Q)的话那一下会丢,这里补一次同步落盘。
    func applicationWillTerminate(_ notification: Notification) {
        // 退出前把那条「别让屏幕暗下去」的断言放掉(2026-09-27,卡 IN)。
        // 进程死了系统也会回收,但不留一条没人管的断言是纪律。
        refreshDisplayAwake(terminating: true)
        // 「电脑别睡」那条也一起放掉(2026-09-28,卡 AW):工作台不在了,就没有理由按着它。
        refreshSystemAwake(terminating: true)
        pendingWindowSave?.cancel()
        pendingWindowSave = nil
        visibleFrameTimer?.invalidate()
        visibleFrameTimer = nil
        guard let window = window,
              let here = window.screen.flatMap({ s in Self.screenPairs().first(where: { $0.screen == s }) })
              else { return }
        persistFrame(on: here.snapshot, sync: true)
    }

    /// webview 的 AX 全局矩形(主屏左上原点,y 向下)。AppKit 的 frame 是主屏左下原点、y 向上,
    /// 换算:axY = 主屏高 - rect.maxY。
    /// 不能直接拿 window.frame——标题栏本身占一截高度,比 webview 实际可视区域高一截
    /// (借用 window.frame 会把 y、h 都算错);要先把 webView.bounds 转到窗口坐标,
    /// 再转到屏幕坐标,才是 webview 真正占据的那块矩形。
    func screenInfoPayload() -> [String: Any] {
        let boundsInWindow = webView.convert(webView.bounds, to: nil)
        let boundsOnScreen = window.convertToScreen(boundsInWindow)
        let primaryH = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? NSScreen.screens.first?.frame.height ?? 0
        return ["webview": ["x": Int(boundsOnScreen.origin.x.rounded()),
                            "y": Int((primaryH - boundsOnScreen.maxY).rounded()),
                            "w": Int(boundsOnScreen.width.rounded()),
                            "h": Int(boundsOnScreen.height.rounded())],
                "scale": 1]
    }

    /// 建主菜单:App/Edit/View 三个菜单,不需要真的好看,只是给标准快捷键一个落点。
    /// Edit 菜单项 target 特意留 nil——交给第一响应者链路由(WKWebView 的可编辑区域
    /// 天然实现 cut:/copy:/paste:/selectAll:/undo:/redo: 这些标准编辑动作),不用抢着
    /// 替 WKWebView 拿焦点,也不用关心当前焦点具体在哪个输入框上。
    private func buildMainMenu() {
        let mainMenu = NSMenu()

        // App 菜单:关于(可选)、隐藏、退出——退出显式走 NSApp.terminate(_:),
        // 不依赖 nil target 沿响应者链猜到 NSApplication 头上。
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于工作台", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        let hideItem = NSMenuItem(title: "隐藏工作台", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hideItem.target = NSApp
        appMenu.addItem(hideItem)
        appMenu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp
        appMenu.addItem(quitItem)
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit 菜单:标准选择器名(旧 IB "First Responder" 占位符用的同一批),
        // target 留 nil 让 AppKit 自己沿响应者链找到当前的可编辑视图。
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: Selector(("cut:")), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: Selector(("copy:")), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: Selector(("paste:")), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: Selector(("selectAll:")), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View 菜单:重新加载直接调 webView.reload(),target 是本类实例。
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let reloadItem = NSMenuItem(title: "重新加载", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadPage() {
        webView?.reload()
    }

    // MARK: - 插件换版自动重载(真机反馈 2026-09-14,「壳里看到的还是老版」)
    //
    // 插件每次发版都要 kickstart 重启 DSH。壳的 helper WS 断了会自己 3 秒一试重连,但
    // WKWebView 里的页面不会跟着刷新,前端代码还是旧版——0.2.22 修了内容居中,浏览器里
    // 刷新过是新版,壳里还是居中,只能重开壳或按 ⌘R。服务端每次连上都先发一条
    // `{kind:"hello", role:"server", version}`(插件版本号,构建时注入),壳记住上次连上时
    // 的版本:第一次连接只记录不重载;重连后版本变了 → 等 3 秒(DSH 重启后 8791 与 3080
    // 网页端不一定同时就绪,给网页端一点时间)再 reload 一次;同版本重连(壳自己断线、
    // DSH 没换版就重启)不重载——那种情况页面本来就是对的,白刷一次只会丢页面状态。
    // 重载失败(3080 还没起、被顶掉)走上面 WKNavigationDelegate 的加载失败自动重试,
    // 不另起一套;3 秒内又收到一次新版本(连着发两版)只保留最后一次,不叠加重载。
    private var lastPluginVersion: String?
    private var pendingVersionReload: DispatchWorkItem?

    private func handleServerHello(version: String) {
        // 服务端(重)连上了:把此刻的通知授权再报一次(卡 M 补),它那一格才不会一直是空的。
        notifier.reportStatus()
        guard let previous = lastPluginVersion else {
            lastPluginVersion = version
            return
        }
        if previous == version { return }
        lastPluginVersion = version
        pendingVersionReload?.cancel()
        /**
         * 2026-09-26(卡 U6):这里原来是「等 3 秒再 reload」—— 那 3 秒是个猜的数,
         * 猜短了就重演 09-26 那一幕(页面先于服务加载完成,整窗一片白)。
         * 现在走跟启动**同一条路**:探到 8791 答话了再加载,没答话就盖着盖板等。
         * 3 秒的等待留着一小截(0.5 秒):服务端刚喊完 hello,让它把那几条路由挂齐。
         */
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingVersionReload = nil
            self.beginLoad(why: "插件换版了(\(version))")
        }
        pendingVersionReload = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    // MARK: - 先探服务就绪再加载(2026-09-26,卡 U6;判断在 ShellReadiness.swift)
    //
    // 09-26 生产切换:热更新重启 DSH 之后壳里整窗一片白,View → 重新加载就好。
    // 成因是 3080 先起来、工作台插件还没挂上,壳把一张空页面提交了进来 —— 盖板等不到
    // 插件的 ready,20 秒兜底一到就揭开。所以**加载之前先探 8791**:它答话 = 插件真挂上了。
    //
    // 三条路都走这一个入口:壳启动、插件换版后的自动重载、他点「重试」。
    // 探不出探针地址(app.json 里 helper_ws 写成别的 scheme)就退回 09-26 之前的行为:直接加载。

    /// 探针地址(启动时从 `helper_ws` 推一次)。nil = 不探,直接加载。
    private var readinessProbe: URL?
    /// 这一轮已经探了几次(探到就归零)。
    private var readinessAttempts = 0
    /// 排着的下一次探测。新一轮开始时先把它取消 —— 不叠两条。
    private var pendingReadinessProbe: DispatchWorkItem?
    /// 这一轮是什么时候开始等的(算「连续多久没答话」用)。
    private var readinessSince = Date()
    /// 这一轮已经替它拉过几次服务(判断在 ShellReadiness.shouldKickstart)。
    private var readinessKicks = 0
    /// 上一次拉是什么时候。
    private var readinessLastKick: Date?

    /// 开一轮:盖上盖板,探到服务在了再让 WKWebView 去加载页面。
    private func beginLoad(why: String) {
        pendingReadinessProbe?.cancel()
        pendingReadinessProbe = nil
        readinessAttempts = 0
        readinessSince = Date()
        readinessKicks = 0
        readinessLastKick = nil
        NSLog("ShellReadiness: 开始等工作台就绪(\(why))")
        loadingCover?.cover()
        probeThenLoad()
    }

    private func probeThenLoad() {
        guard let probe = readinessProbe else {
            webView.load(URLRequest(url: pageURL))
            return
        }
        var request = URLRequest(url: probe)
        request.timeoutInterval = ShellReadiness.probeTimeout
        // 探的是"服务在不在",不是"上次答的是什么"——别让系统缓存替它答。
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            DispatchQueue.main.async { self?.readinessProbed(status: status) }
        }.resume()
    }

    private func readinessProbed(status: Int?) {
        if ShellReadiness.isReady(status: status) {
            readinessAttempts = 0
            webView.load(URLRequest(url: pageURL))
            return
        }
        readinessAttempts += 1
        kickstartIfLongGone()
        if ShellReadiness.gaveUp(attempts: readinessAttempts) {
            // 探到头了:**不再自动探**,摆一句人话 + 一颗「重试」。一扇无声转圈的窗跟白屏一样糟。
            NSLog("ShellReadiness: 探了 \(readinessAttempts) 次工作台还没起来,停下等他点「重试」")
            loadingCover?.showGaveUp()
            return
        }
        let delay = ShellReadiness.delay(afterAttempts: readinessAttempts)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingReadinessProbe = nil
            self.probeThenLoad()
        }
        pendingReadinessProbe = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - 8791 一直不答:壳自己把服务拉一次(2026-10-13,0.4.115「装完没自己起来」)
    //
    // 为什么该由壳做、为什么敢做(不带 `-k` 对还在跑的项什么都不做)、等多久、最多几次,
    // 全在 `ShellReadiness.swift` 那一节里;这里只负责真跑那条命令。
    // 跑不起来(launchctl 不在、launchd 里没这一项)只记一行日志 —— 探测照旧转下去,
    // 探到头还是出那句人话 + 「重试」。
    private func kickstartIfLongGone() {
        let waited = Date().timeIntervalSince(readinessSince)
        let since = readinessLastKick.map { Date().timeIntervalSince($0) }
        guard ShellReadiness.shouldKickstart(waited: waited, kicks: readinessKicks, sinceLastKick: since) else { return }
        readinessKicks += 1
        readinessLastKick = Date()
        let args = ShellReadiness.kickstartArguments(uid: getuid())
        NSLog("ShellReadiness: 8791 连续 \(Int(waited)) 秒没答话,替它拉一次服务(第 \(readinessKicks) 次):launchctl \(args.joined(separator: " "))")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = args
        do { try task.run() }
        catch { NSLog("ShellReadiness: 那一下没跑起来(\(error.localizedDescription))") }
    }

    // MARK: - 页面加载失败自动重试(真机反馈 2026-09-07,「重启后客户端一直打不开」)
    //
    // 登录项把壳拉起来的那一刻,DSH(launchd 同时在起,冷机要 20 秒以上,负载高时更久)
    // 还没在 3080 监听,WKWebView 第一次加载就失败;壳原来不重试,窗口停在错误页,
    // 看起来就是「客户端打不开」——只有人手 ⌘R 才能救。C1 的精神是 Agent 层没起来时
    // 展示层要自愈,所以失败就隔几秒再试,退避 2→4→8→10 秒封顶,直到工作台页真正加载
    // 成功为止;成功后退避归零。只在导航失败时触发,页面内正常导航不受影响;
    // NSURLErrorCancelled(-999)是被新一次加载顶掉的旧导航,不算失败,不重试。
    private var retryDelay: TimeInterval = 2

    // MARK: - dsh web 令牌(2026-09-23 从零重装验收:新机器上整屏只有一行 authentication required)
    //
    // 判断与读日志在 WebToken.swift(纯逻辑,有单测);这里只做 WebKit 那一半:
    //   ① 主框架拿到 dsh web 的 401 → 取消这次响应,去日志里取最新令牌,带着它加载一次;
    //   ② dsh 回 303 + Set-Cookie 跳回干净的 `/` → 截下来,改走原地址(`?ben-workbench=app`);
    //   ③ 之后都凭 cookie 进。dsh 重启换了令牌但 cookie 仍有效(签名 secret 持久)就不会再走这里,
    //      cookie 失效才会再遇到 401、再取一次。
    // 令牌只在内存里:不落盘、不打日志;WebKit 的历史里留下的是 303 之后的地址,不是带令牌那条。

    /// 配置里的原地址(启动时读一次;重试与换回都用它)。
    private var pageURL: URL = AppConfig.load().pageURL
    /// 正在用令牌换 cookie(已发出带令牌的请求,等 303 回来)。
    private var tokenHandshakeInFlight = false
    /// 连着吃了几次 401(成功进页面就归零)。决定下一次隔多久再取令牌。
    private var consecutiveAuthFailures = 0
    private var pendingAuthRetry: DispatchWorkItem?

    private var logsDir: String { NSHomeDirectory() + "/.dsh/logs" }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if tokenHandshakeInFlight, navigationAction.targetFrame?.isMainFrame ?? true,
           let url = navigationAction.request.url, WebToken.isBareRootRedirect(url, page: pageURL) {
            decisionHandler(.cancel)
            finishTokenHandshake()
            return
        }
        // 2026-09-25:<a download> 转下载、拖进来的文件不许把整页换掉、点外链交给浏览器(WebPolicy.decide)。
        decisionHandler(webHost?.decide(navigationAction) ?? .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame,
              let http = navigationResponse.response as? HTTPURLResponse,
              let url = http.url, WebToken.sameOrigin(url, pageURL) else {
            // 网页显示不了的(附件、压缩包)转成下载,别的照常(2026-09-25)。
            decisionHandler(webHost?.decide(navigationResponse) ?? .allow)
            return
        }
        if http.statusCode == 401 {
            decisionHandler(.cancel)
            handleUnauthorized()
            return
        }
        // 兜底:万一 WebKit 没把 303 那一跳交给上面的 navigationAction(不同系统版本行为不一),
        // 干净的 `/` 真的加载回来了,也在这里截下来换回原地址。cookie 已经在 303 那一下种上了。
        if tokenHandshakeInFlight, WebToken.isBareRootRedirect(url, page: pageURL) {
            decisionHandler(.cancel)
            finishTokenHandshake()
            return
        }
        decisionHandler(webHost?.decide(navigationResponse) ?? .allow)
    }

    // 导航变成了下载(<a download>、附件):交给 WebHost 落进「下载」。回应那一路是主框架
    // 已经开始换页(盖板已经盖上)之后才变的 —— 旧页原样还在,揭开过就照旧揭开(见 provisionalAbandoned)。
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        webHost?.adopt(download)
        loadingCover?.provisionalAbandoned()
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        webHost?.adopt(download)
        loadingCover?.provisionalAbandoned()
    }

    private func finishTokenHandshake() {
        tokenHandshakeInFlight = false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.webView.load(URLRequest(url: self.pageURL))
        }
    }

    /// dsh web 说「没登录」。第一次立刻去取令牌;连着再来说明日志里那条是旧的
    /// (dsh 刚重启、新的还没打印)或者还没有,按退避再取。
    private func handleUnauthorized() {
        tokenHandshakeInFlight = false
        let delay = WebToken.delay(afterConsecutiveFailures: consecutiveAuthFailures)
        consecutiveAuthFailures += 1
        pendingAuthRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingAuthRetry = nil
            // 取不到令牌(日志还没有):照原地址再来一次,会再 401、再按退避回到这里。
            guard let token = WebTokenReader.latestToken(logsDir: self.logsDir),
                  let url = WebToken.authenticatedURL(page: self.pageURL, token: token) else {
                self.webView.load(URLRequest(url: self.pageURL))
                return
            }
            self.tokenHandshakeInFlight = true
            self.webView.load(URLRequest(url: url))
        }
        pendingAuthRetry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetryLoad(after: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetryLoad(after: error)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryDelay = 2
        consecutiveAuthFailures = 0
    }

    // MARK: - 加载占位(2026-09-23,判断在 LoadingCover.swift)
    //
    // 主框架每开始换一页就盖上(热更新 reload、⌘R 都不露出上游的「Loading plugins…」);
    // 提交了就开始算兜底时间;插件发来 ready 就揭开。
    private var loadingCover: LoadingCoverController!

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loadingCover?.cover()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        loadingCover?.noteCommitted()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // 同一条通道两件事(按 body 里的 type 分流):插件挂上了(揭开占位)/ 网页顶栏上按了一下(拖窗口)。
        if let titleBar = ShellTitleBar.message(name: message.name, body: message.body,
                                                isMainFrame: message.frameInfo.isMainFrame) {
            handleTitleBarMessage(titleBar)
            return
        }
        guard LoadingCover.isReady(name: message.name, body: message.body, isMainFrame: message.frameInfo.isMainFrame) else { return }
        loadingCover?.reveal()
    }

    // MARK: - 表头当标题栏用(2026-09-25,卡 TB)
    //
    // 标题栏透明之后窗口顶上那一条就是网页自己的顶栏。拖动不能没有:网页在顶栏空白处
    // mousedown 时发 `titlebar_drag`(哪里算空白由插件那侧判断,见 client/topbarDrag.ts),
    // 壳把这一下交回给系统的窗口拖动。

    private func handleTitleBarMessage(_ message: ShellTitleBar.Message) {
        guard let window = window else { return }
        switch message {
        case .drag:
            // performDrag 要「此刻正在处理的那个鼠标事件」。网页的 mousedown 经
            // WKScriptMessageHandler 过来时,NSApp.currentEvent 通常还是那一下 leftMouseDown
            // (拖动事件要等手真的动了才产生),用它 performDrag 走的就是原生标题栏同一条
            // 系统路径 —— 手感、贴边吸附、拖到另一块屏全是系统在做,壳不自己算 frame。
            //
            // 消息是异步的,偶尔到这里 currentEvent 已经换了(全屏界面切换、WebKit 内部
            // 多派一轮)。那就退回 WebView 记下的**同一次按下**:不至于整扇窗一下都拖不动。
            // 两个都拿不到时什么都不做:宁可这一次拖不动(再按一下就好),也不要拿一个
            // 不相干的事件让窗口跳一下。
            let current = NSApp.currentEvent
            let usable = (current?.type == .leftMouseDown || current?.type == .leftMouseDragged) ? current : nil
            guard let event = usable ?? (webView as? ClickThroughWebView)?.lastMouseDownEvent else { return }
            window.performDrag(with: event)
            // performDrag 是同步的:手松开才回来。松手时鼠标在另一块屏上 → 挪到那块屏并按它铺好
            // (铺满大屏的窗往小屏拖,系统按覆盖面积永远认原屏,人就「拖不过去」;2026-09-27)。
            let pairs = Self.screenPairs()
            if let target = WindowPlacement.screenForDragEnd(pointer: NSEvent.mouseLocation,
                                                             screens: pairs.map { $0.snapshot },
                                                             windowScreenKey: currentScreenKey) {
                currentScreenKey = target.key
                lastVisibleFrame = target.visibleFrame
                applyPlacement(WindowPlacement.frameForScreenSwitch(target))
                persistFrame(on: target)
            }
        case .moveScreen:
            // 顶栏「换屏」(2026-09-27):搬到下一块屏,按那块屏记住的大小(没来过就铺满)。
            let pairs = Self.screenPairs()
            let here = window.screen.flatMap { s in pairs.first(where: { $0.screen == s }) }?.snapshot.key ?? currentScreenKey
            guard let target = WindowPlacement.nextScreen(after: here, in: pairs.map { $0.snapshot }) else { return }
            currentScreenKey = target.key
            lastVisibleFrame = target.visibleFrame
            applyPlacement(WindowPlacement.frameForScreenSwitch(target))
            persistFrame(on: target)
        case .doubleClick:
            // 照系统设置「桌面与程序坞 → 连按标题栏来」那一项走(判断在 ShellTitleBar,有用例)。
            // UserDefaults.standard 的搜索链包含 NSGlobalDomain,读的就是那一项。
            switch ShellTitleBar.doubleClickAction(setting: UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")) {
            case .zoom: window.zoom(nil)
            case .miniaturize: window.miniaturize(nil)
            case .ignore: break
            }
        }
    }

    /// WebKit 的「被策略打断」(我们自己在上面 decisionHandler(.cancel) 的那几下)。
    /// 那是换令牌流程的一部分,不是加载失败,不能再触发一轮重试。
    private static let frameLoadInterruptedByPolicyChange = 102

    private func scheduleRetryLoad(after error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == Self.frameLoadInterruptedByPolicyChange { return }
        // 3080 连不上(dsh 还没起来)时,正在换令牌的那一次也算作废,等下一次 401 重新来。
        tokenHandshakeInFlight = false
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, 10)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self else { return }
            // 2026-09-26(卡 U6):重试也**先探一次 8791** 再加载 —— 加载失败十次里九次
            // 就是"服务还没起来",直接再 load 一次只是再失败一次,而且会把一张错误页提交进来。
            self.probeThenLoad()
        }
    }

    @objc private func handleAppLaunched(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        control?.handleAppLaunched(app)
        forwardAppEvent("launched", app)
    }

    @objc private func handleAppTerminated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        control?.handleAppTerminated(app)
        forwardAppEvent("terminated", app)
    }

    @objc private func handleAppActivated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        control?.handleAppActivated(app)
        // 同一条激活通知,两件互不相干的事:上面是重挂观察者,这里是「真切过去还是临时叫一下」(卡 P)。
        activationWatch?.handleActivated(app)
        forwardAppEvent("activated", app)
        /*
         * 第三件(2026-10-04,卡「常亮认窗口槽里的程序」):最前面那一家换了 → 重算「别让屏幕暗下去」。
         * 原来只在工作台**自己** active / resign / hide / miniaturize 时刷,于是「她从 Codex 切到
         * 槽里的 Claude」「从 Safari 切回槽里的 Codex」这两拍一次都刷不到 —— 恰好就是她的常态。
         * `activationPolicy` 不筛:菜单栏小工具被激活同样会把工作台挤下去,那一拍也该重算。
         */
        refreshDisplayAwake()
    }

    /// Agent 自动发现(2026-09-25,卡 Q):App 起来 / 切到前台 / 退出,告诉工作台一声。
    /// 只报常规界面应用(菜单栏小工具、后台进程不算),不报工作台自己;只带身份,不碰它的窗口。
    private func forwardAppEvent(_ event: String, _ app: NSRunningApplication) {
        guard app.activationPolicy == .regular || event == "terminated",
              let bundleId = app.bundleIdentifier, !bundleId.isEmpty,
              bundleId != Bundle.main.bundleIdentifier else { return }
        socket?.sendAppEvent(event, bundleId: bundleId, name: app.localizedName, pid: app.processIdentifier)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

extension ScreenSnapshot {
    /// NSScreen → 纯数据快照。AppKit 那一侧的换算只在这一个地方发生,WindowPlacement
    /// 里全是纯 CGRect,单测才造得出来。
    init(_ screen: NSScreen) {
        let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        self.init(name: screen.localizedName,
                  frame: screen.frame,
                  visibleFrame: screen.visibleFrame,
                  displayID: displayID)
    }
}
