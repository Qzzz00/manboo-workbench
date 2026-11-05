import AppKit
import UniformTypeIdentifiers
import WebKit

/// 壳里网页能力的**真 WebKit 引擎**测试(2026-09-25,卡 fix/shell-web-capabilities)。
///
/// 为什么不只在 Chrome 里验:维护者 09-24「明明有 + 号,上传文件和图片是没有弹出来选择内容的」——
/// 之前各卡都在无头 Chrome 里验,真壳(WKWebView)里一堆东西不工作。这里起一个真的 WKWebView,
/// 装上**壳自己的 WebHost**(与 AppDelegate 用的同一份代码),对着 Tests/web/index.html 真点、
/// 真拖、真下载,读网页那一侧实际拿到了什么。
///
/// 不碰真东西:没有 AppDelegate(不注册登录项、不写 ~/.dsh/workbench/app.json、不连 8791)、
/// bundle id 不是工作台(就是个裸可执行文件,不撞正在跑的壳)、窗口摆在屏幕外且不激活、
/// 数据存储用 nonPersistent、「真弹框 / 真打开浏览器 / 真的下载文件夹」全换成假的
/// (WebHost 的可注入闭包)、拖放用私有命名的粘贴板(不是系统剪贴板)。
///
/// 跑法:../run-web-tests.sh(它起一个只绑 127.0.0.1 的临时静态服务、备好测试文件再调这个)。

// MARK: - 断言

var failures: [String] = []
var checks = 0
var facts: [String] = []

func expect(_ condition: Bool, _ what: String, line: UInt = #line) {
    checks += 1
    if !condition { failures.append("\(what)  (Tests/web/main.swift:\(line))") }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ what: String, line: UInt = #line) {
    checks += 1
    if actual != expected { failures.append("\(what)\n      期望 \(expected)\n      实得 \(actual)  (Tests/web/main.swift:\(line))") }
}

// MARK: - 参数

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

guard let baseString = arg("--base"), let base = URL(string: baseString),
      let filesPath = arg("--files"), let downloadsPath = arg("--downloads") else {
    print("用法:web-harness --base http://127.0.0.1:PORT/ --files <测试文件目录> --downloads <假下载目录> [--no-guard]")
    exit(2)
}
let filesDir = URL(fileURLWithPath: filesPath)
let downloadsDir = URL(fileURLWithPath: downloadsPath)
let hasGuard = !CommandLine.arguments.contains("--no-guard")
let pageURL = URL(string: "index.html?ben-workbench=app", relativeTo: base)!.absoluteURL

// MARK: - 跑起来

func spin(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

@discardableResult
func waitUntil(_ timeout: Double = 5, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        spin(0.02)
    }
    return condition()
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不进程序坞、不抢前台

/// 与 AppDelegate 同一套装配:WKWebView + 壳自己的 WebHost + 盖板(同一个容器里、盖在上面)。
final class Rig: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let container: NSView
    let webView: WKWebView
    let host: WebHost
    let cover: LoadingCoverController

    var finished = 0
    var provisionalStarts = 0
    var fileNavigationsCancelled = 0

    // 假的「真动作」记下来的东西
    var panelRequests: [WebPolicy.OpenPanelRequest] = []
    var panelAnswer: [URL]? = nil
    var holdPanel = false
    var heldPanel: (([URL]?) -> Void)?
    var opened: [URL] = []
    var dialogs: [WebHost.Dialog] = []
    var dialogAnswer: (Bool, String?) = (true, nil)
    var downloaded: [URL] = []
    var downloadErrors: [String] = []

    init(page: URL) {
        let size = NSRect(x: 0, y: 0, width: 900, height: 700)
        window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 900, height: 700),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "BenWorkbenchShell/1" // 同壳
        config.websiteDataStore = .nonPersistent()                  // 测试不落任何网站数据
        webView = WKWebView(frame: size, configuration: config)
        webView.autoresizingMask = [.width, .height]
        cover = LoadingCoverController(frame: size)
        container = NSView(frame: size)
        container.addSubview(webView)
        container.addSubview(cover.view)
        window.contentView = container
        host = WebHost(page: page)
        super.init()
        host.window = window
        host.presentOpenPanel = { [unowned self] request, _, done in
            self.panelRequests.append(request)
            if self.holdPanel { self.heldPanel = done; return }
            let answer = self.panelAnswer
            DispatchQueue.main.async { done(answer) }
        }
        host.openExternally = { [unowned self] url in self.opened.append(url) }
        host.presentDialog = { [unowned self] dialog, _, done in
            self.dialogs.append(dialog)
            let answer = self.dialogAnswer
            DispatchQueue.main.async { done(answer.0, answer.1) }
        }
        host.downloadsDirectory = { downloadsDir }
        host.downloadFinished = { [unowned self] url in self.downloaded.append(url) }
        host.downloadFailed = { [unowned self] message in self.downloadErrors.append(message) }
        webView.uiDelegate = host
        webView.navigationDelegate = self
        window.orderFrontRegardless() // 在屏幕外;不 makeKey、不激活
    }

    // 与 AppDelegate 的 WKNavigationDelegate 同一套调用(去掉换令牌那一段)。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let decision = host.decide(navigationAction)
        if decision == .cancel, navigationAction.request.url?.isFileURL == true { fileNavigationsCancelled += 1 }
        decisionHandler(decision)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(host.decide(navigationResponse))
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        host.adopt(download)
        cover.provisionalAbandoned()
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        host.adopt(download)
        cover.provisionalAbandoned()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisionalStarts += 1
        cover.cover()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { cover.noteCommitted() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished += 1 }

    // MARK: 小工具

    func js(_ code: String, timeout: Double = 5) -> Any? {
        var done = false
        var result: Any?
        webView.evaluateJavaScript(code) { value, error in
            result = value
            if let error { facts.append("js 出错:\(code.prefix(60))… → \(error.localizedDescription)") }
            done = true
        }
        waitUntil(timeout) { done }
        return result
    }

    func load(_ url: URL) -> Bool {
        let before = finished
        webView.load(URLRequest(url: url))
        return waitUntil(10) { self.finished > before }
    }

    /// 页面 CSS 坐标(左上原点)→ 窗口坐标(左下原点)。
    func windowPoint(_ css: CGPoint) -> NSPoint { NSPoint(x: css.x, y: webView.frame.height - css.y) }

    func center(of id: String) -> CGPoint {
        let r = (js("rect('\(id)')") as? [Double]) ?? [0, 0, 0, 0]
        return CGPoint(x: r[0] + r[2] / 2, y: r[1] + r[3] / 2)
    }
}

/// 从 Finder 拖文件过来时,AppKit 交给落点视图的那份信息。粘贴板用私有命名的一块(不是系统剪贴板),
/// 内容照 Finder 的样子:每个文件一条 public.file-url,再补一份老式的 NSFilenamesPboardType。
final class FakeFileDrag: NSObject, NSDraggingInfo {
    let pasteboard: NSPasteboard
    var location: NSPoint
    weak var window: NSWindow?
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop: Int
    let sequence = Int.random(in: 1_000...999_999)

    init(files: [URL], window: NSWindow, at point: NSPoint) {
        pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.ben.workbench.webtest.drag.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.writeObjects(files as [NSURL])
        let legacy = NSPasteboard.PasteboardType("NSFilenamesPboardType")
        if pasteboard.propertyList(forType: legacy) == nil {
            pasteboard.addTypes([legacy], owner: nil)
            pasteboard.setPropertyList(files.map(\.path), forType: legacy)
        }
        self.window = window
        location = point
        numberOfValidItemsForDrop = files.count
    }

    var draggingDestinationWindow: NSWindow? { window }
    var draggingSourceOperationMask: NSDragOperation { [.copy, .link, .generic, .move] }
    var draggingLocation: NSPoint { location }
    var draggedImageLocation: NSPoint { location }
    var draggedImage: NSImage? { nil }
    var draggingPasteboard: NSPasteboard { pasteboard }
    var draggingSource: Any? { nil } // 从别的 App 拖来(不是网页自己里面拖)
    var draggingSequenceNumber: Int { sequence }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?,
                                classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}

struct DragOutcome {
    var operation: NSDragOperation
    var performed: Bool
}

/// 照 AppKit 的顺序喂一次拖放:进来 → 移动(几次)→ 看落点回的操作 → 有操作才松手,没有就离开。
/// WKWebView 的 draggingUpdated 回的是**上一次**网页进程的答复(异步往返),所以每一步都等一拍再问一次。
func drag(_ rig: Rig, files: [URL], path: [CGPoint], drop: Bool = true) -> DragOutcome {
    let info = FakeFileDrag(files: files, window: rig.window, at: rig.windowPoint(path[0]))
    defer { info.pasteboard.releaseGlobally() }
    _ = rig.webView.draggingEntered(info)
    var op: NSDragOperation = []
    for point in path {
        info.location = rig.windowPoint(point)
        _ = rig.webView.draggingUpdated(info)
        spin(0.35)
        op = rig.webView.draggingUpdated(info)
        spin(0.05)
    }
    var performed = false
    if drop && !op.isEmpty {
        if rig.webView.prepareForDragOperation(info) { performed = rig.webView.performDragOperation(info) }
    }
    else {
        rig.webView.draggingExited(info)
    }
    spin(0.4)
    return DragOutcome(operation: op, performed: performed)
}

// MARK: - 测试

let rig = Rig(page: pageURL)
expect(rig.load(pageURL), "测试页加载成功(\(pageURL.absoluteString))")
if hasGuard { expect(waitUntil(5) { (rig.js("window.guardReady === true") as? Bool) == true }, "插件那道拖放守卫(guard.js)加载成功") }
rig.cover.reveal() // 同壳:工作台挂上后揭开盖板
spin(0.4)
expect(rig.cover.view.isHidden, "盖板揭开了(之后的拖放要落到网页上)")

let a = filesDir.appendingPathComponent("a.txt")
let png = filesDir.appendingPathComponent("图片.png")
let json = filesDir.appendingPathComponent("preset.json")
let folder = filesDir.appendingPathComponent("folder")

// ── 0. WebHost 真的被 WebKit 当成 uiDelegate 用(签名差一点就不会被调,编译器只给个警告)
expect(rig.host.responds(to: #selector(WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:))), "WebHost 实现了 runOpenPanel")
expect(rig.host.responds(to: #selector(WKUIDelegate.webView(_:createWebViewWith:for:windowFeatures:))), "WebHost 实现了 createWebView")
expect(rig.host.responds(to: #selector(WKUIDelegate.webView(_:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))), "WebHost 实现了 confirm")

// ── 1. 输入框的 +:<input type=file multiple hidden>,不限类型
rig.panelAnswer = [a, png]
_ = rig.js("document.getElementById('multi').click(); true")
expect(waitUntil(5) { rig.js("window.results.multi !== undefined") as? Bool == true }, "★点 + 之后网页收到了选中的文件(以前壳里点了没反应)")
expectEqual(rig.panelRequests.first, WebPolicy.OpenPanelRequest(allowsMultipleSelection: true, allowsDirectories: false, allowedExtensions: []),
            "选文件框:能多选、不是文件夹、不限类型")
let multi = rig.js("JSON.stringify(window.results.multi)") as? String ?? ""
expect(multi.contains("\"name\":\"a.txt\"") && multi.contains("\"text\":\"hello from a.txt\""), "文本文件交到网页手里、内容读得出来:\(multi)")
expect(multi.contains("\"name\":\"图片.png\""), "中文名的图片也交到了:\(multi)")
if let request = rig.panelRequests.first {
    let panel = WebHost.makeOpenPanel(request)
    expect(panel.canChooseFiles && !panel.canChooseDirectories && panel.allowsMultipleSelection, "真 NSOpenPanel:能选文件、能多选、不选文件夹")
    expect(panel.allowedContentTypes.isEmpty, "真 NSOpenPanel:不限类型")
}

// ── 2. 粒子设置「导入配置 JSON」:accept 过滤
rig.panelRequests = []
rig.panelAnswer = [json]
_ = rig.js("document.getElementById('json').click(); true")
expect(waitUntil(5) { rig.js("window.results.json !== undefined") as? Bool == true }, "accept 那种也收到了文件")
let jsonRequest = rig.panelRequests.first
expect(jsonRequest?.allowedExtensions.contains("json") == true, "accept=.json,application/json 折成了 json 扩展名:\(jsonRequest?.allowedExtensions ?? [])")
expect(jsonRequest?.allowsMultipleSelection == false, "没写 multiple 就只能单选")
if let jsonRequest {
    let panel = WebHost.makeOpenPanel(jsonRequest)
    expect(panel.allowedContentTypes.contains(.json), "真 NSOpenPanel 只给选 JSON:\(panel.allowedContentTypes.map(\.identifier))")
}

// ── 3. 点了取消:网页那边什么都不变,下一次还能再开
rig.panelRequests = []
rig.panelAnswer = nil
_ = rig.js("window.results.multi = undefined; document.getElementById('multi').click(); true")
expect(waitUntil(3) { rig.panelRequests.count == 1 }, "取消那次也弹了框")
spin(0.5)
expect(rig.js("window.results.multi === undefined") as? Bool == true, "取消:没有 change,不塞空文件")
facts.append("取消时 WebKit 发不发 input 的 cancel 事件:\(rig.js("window.results['multi:cancel'] === true") as? Bool == true ? "发" : "不发")")
rig.panelAnswer = [a]
_ = rig.js("document.getElementById('multi').click(); true")
expect(waitUntil(5) { rig.js("window.results.multi !== undefined") as? Bool == true }, "取消之后再点 + 照样能选(框没卡在「开着」)")

// ── 4. 框还开着又点了一次 +(WebKit 的坑,决定了真框必须是 app 级模态,见 WebHost.systemOpenPanel)
rig.panelRequests = []
rig.holdPanel = true
_ = rig.js("window.results.multi = undefined; document.getElementById('multi').click(); true")
expect(waitUntil(3) { rig.panelRequests.count == 1 }, "第一次点开了框")
_ = rig.js("document.getElementById('multi').click(); true")
spin(0.5)
expectEqual(rig.panelRequests.count, 1, "框开着再点一次 + 不会开第二个框")
rig.holdPanel = false
rig.heldPanel?([png])
rig.heldPanel = nil
spin(0.8)
let lost = rig.js("window.results.multi === undefined") as? Bool == true
facts.append("框开着时同一个 input 再点一次,框里选的文件还交不交得到:\(lost ? "交不到(WebKit 把正在等的那次作废了)→ 真框必须是模态的,不让人点第二次" : "交得到")")
rig.panelAnswer = [a]
_ = rig.js("document.getElementById('multi').click(); true")
expect(waitUntil(5) { rig.js("window.results.multi !== undefined") as? Bool == true }, "那之后再点 + 照样能选(壳这边没卡在「框开着」)")

// ── 5. 选文件夹(webkitdirectory)
rig.panelRequests = []
rig.panelAnswer = [folder]
_ = rig.js("document.getElementById('dir').click(); true")
expect(waitUntil(5) { rig.js("window.results.dir !== undefined") as? Bool == true }, "选文件夹也交到了网页")
expectEqual(rig.panelRequests.first?.allowsDirectories, true, "webkitdirectory → 选文件夹的框")
let dir = rig.js("JSON.stringify(window.results.dir)") as? String ?? ""
expect(dir.contains("folder/x.txt") && dir.contains("folder/sub/y.txt"), "文件夹里的文件连同相对路径都列给了网页:\(dir)")

// ── 6. 拖文件进输入框(Composer 的落点)
expect(rig.webView.registeredDraggedTypes.contains(.fileURL) || rig.webView.registeredDraggedTypes.contains(NSPasteboard.PasteboardType("NSFilenamesPboardType")),
       "WKWebView 登记了接文件拖放")
let zoneCenter = rig.center(of: "zone")
let hit = rig.container.hitTest(rig.windowPoint(zoneCenter))
expect(hit === rig.webView || hit?.isDescendant(of: rig.webView) == true, "盖板揭开后,输入框那块的点击 / 拖放落在 WKWebView 上(不是盖板)")
rig.cover.cover()
let covered = rig.container.hitTest(rig.windowPoint(zoneCenter))
expect(covered === rig.cover.view, "盖板盖着时挡住网页(对照组)")
rig.cover.reveal()
spin(0.4)

var outcome = drag(rig, files: [a, png], path: [CGPoint(x: zoneCenter.x + 100, y: zoneCenter.y + 50), zoneCenter])
expectEqual(outcome.operation, .copy, "★文件拖到输入框上:落点回「复制进来」(光标带绿色加号)")
expect(outcome.performed, "松手真的落下去了")
expect(waitUntil(3) { rig.js("window.results.drop !== undefined") as? Bool == true }, "★输入框的 drop 收到了文件")
expectEqual(rig.js("JSON.stringify(window.results.drop)") as? String, "[\"a.txt\",\"图片.png\"]", "收到的就是拖进来的那两个")
expectEqual(rig.js("JSON.stringify(window.lastTypes)") as? String, "[\"Files\"]", "dragover 里 types 是 ['Files'](Composer 就靠这一条判断)")
expectEqual(rig.fileNavigationsCancelled, 0, "落在输入框上时没有去「打开」文件")

// ── 7. 离开进子元素:WebKit 给不给 dragleave 的 relatedTarget(决定 Composer 那句「松手放进来」闪不闪)
_ = rig.js("window.zoneEvents = []; true")
let childCenter = rig.center(of: "zchild")
_ = drag(rig, files: [a], path: [CGPoint(x: zoneCenter.x + 120, y: zoneCenter.y + 60), childCenter, CGPoint(x: zoneCenter.x + 120, y: zoneCenter.y + 60)], drop: false)
let zoneEvents = rig.js("JSON.stringify(window.zoneEvents)") as? String ?? ""
facts.append("输入框内移进子元素时的 dragenter/dragleave(类型, target, relatedTarget):\(zoneEvents)")

// ── 8. 复现维护者看到的「不支持」:DSH 压在下面的对话栏在 document 上截走文件拖放
_ = rig.js("window.results.drop = undefined; installDshMimic()")
outcome = drag(rig, files: [a], path: [CGPoint(x: zoneCenter.x + 100, y: zoneCenter.y + 50), zoneCenter])
expect(outcome.operation.isEmpty, "★复现:上游那套在 document 上把 dropEffect 压成 none —— 拖到输入框上也「放不下」")
expect((rig.js("window.dsh.overlay") as? Int ?? 0) > 0, "★复现:整屏盖出「当前无法添加图片」(他看到的「不支持」)")
expect(rig.js("window.results.drop === undefined") as? Bool == true, "★复现:输入框一个文件都没收到")

if hasGuard {
    _ = rig.js("window.dsh.overlay = 0; document.getElementById('dsh-overlay').style.display = 'none'; installGuard()")
    outcome = drag(rig, files: [a, png], path: [CGPoint(x: zoneCenter.x + 100, y: zoneCenter.y + 50), zoneCenter])
    expectEqual(outcome.operation, .copy, "★装上守卫:拖到输入框上「可以放」")
    expect(waitUntil(3) { rig.js("window.results.drop !== undefined") as? Bool == true }, "★装上守卫:输入框收到了文件")
    expectEqual(rig.js("window.dsh.overlay") as? Int, 0, "★装上守卫:上游那层「当前无法添加图片」不再出现")
    expectEqual(rig.js("window.dsh.drops") as? Int, 0, "装上守卫:文件没有被塞进上游那个看不见的草稿")

    // 没有落点的地方:明确「放不下」,不开文件
    let outside = rig.center(of: "outside")
    outcome = drag(rig, files: [a], path: [outside])
    expect(outcome.operation.isEmpty, "装上守卫:拖到没有落点的地方 = 放不下(不出加号)")
    expectEqual(rig.fileNavigationsCancelled, 0, "放不下就不会走到「打开文件」那一步")
    expectEqual(rig.js("window.marker") as? String, "index", "工作台页还在")

    // 浮层关了(进了 DSH 原生会话页):拆掉守卫,上游拖图照常
    _ = rig.js("window.uninstallGuard(); true")
    outcome = drag(rig, files: [a], path: [outside], drop: false)
    expect((rig.js("window.dsh.overlay") as? Int ?? 0) > 0, "拆掉守卫后上游那套照常工作(浮层关着时 DSH 原生页的拖图不受影响)")
}
_ = rig.js("removeDshMimic(); document.getElementById('dsh-overlay').style.display = 'none'; true")

// ── 9. 拖到没人接的地方、也没有守卫:WebKit 的默认动作是把整页换成那个文件 —— 壳不许
let outside = rig.center(of: "outside")
outcome = drag(rig, files: [a], path: [outside])
facts.append("没有任何落点时 WebKit 回的拖放操作:\(outcome.operation.rawValue)(非 0 = 它打算「打开」这个文件)")
if outcome.performed {
    expect(waitUntil(3) { rig.fileNavigationsCancelled > 0 }, "★WebKit 想把主框架导航到拖进来的文件 —— 被壳拦下")
}
spin(0.5)
expectEqual(rig.js("window.marker") as? String, "index", "★工作台页没有被换成那个文件")
expect(rig.webView.url?.isFileURL == false, "地址还是工作台:\(rig.webView.url?.absoluteString ?? "nil")")

// ── 10. target=_blank / window.open / 外链 / mailto:交给系统,工作台不动
rig.opened = []
_ = rig.js("document.getElementById('blank').click(); true")
expect(waitUntil(3) { !rig.opened.isEmpty }, "★target=_blank 的链接交给了默认浏览器(以前壳里点了没反应)")
spin(0.3)
expectEqual(rig.opened, [URL(string: "https://example.com/blank")!], "只开一次、开的就是它")

rig.opened = []
let openResult = rig.js("String(window.open('https://example.com/open', '_blank', 'noopener'))")
expect(waitUntil(3) { !rig.opened.isEmpty }, "★window.open(web_login、官网)交给了默认浏览器")
spin(0.3)
expectEqual(rig.opened, [URL(string: "https://example.com/open")!], "window.open 只开一次")
facts.append("window.open 在网页里的返回值:\(openResult ?? "nil")")

rig.opened = []
_ = rig.js("window.open('about:blank'); true")
spin(0.5)
expect(rig.opened.isEmpty, "about:blank 空窗不开")

rig.opened = []
_ = rig.js("document.getElementById('plain').click(); true")
expect(waitUntil(3) { !rig.opened.isEmpty }, "没写 target 的外链也交给浏览器")
spin(0.5)
expectEqual(rig.js("window.marker") as? String, "index", "★点外链不把工作台换成别的网站(壳没有后退键)")

rig.opened = []
_ = rig.js("document.getElementById('mail').click(); true")
expect(waitUntil(3) { !rig.opened.isEmpty }, "mailto 交给邮件")
rig.opened = []
_ = rig.js("document.getElementById('custom').click(); true")
spin(0.8)
expect(rig.opened.isEmpty, "不认的自定义协议不交给系统")
expectEqual(rig.js("window.marker") as? String, "index", "点了不认的协议,页面照旧")

// ── 11. alert / confirm / prompt
rig.dialogs = []
rig.dialogAnswer = (true, nil)
expectEqual(rig.js("confirm('移除这台电脑?这台工作台会退回登录页,要重新登录一次。')") as? Bool, true,
            "★confirm 点「确定」→ 网页拿到 true(以前壳里永远是 false,移除设备 / 重置账号悄悄不做)")
expectEqual(rig.dialogs.first, .confirm("移除这台电脑?这台工作台会退回登录页,要重新登录一次。"), "弹框里就是网页那句原话")
rig.dialogAnswer = (false, nil)
expectEqual(rig.js("confirm('重置?')") as? Bool, false, "点「取消」→ false")
rig.dialogAnswer = (true, nil)
_ = rig.js("alert('好了'); true")
expect(rig.dialogs.contains(.alert("好了")), "alert 弹出来了")
rig.dialogAnswer = (true, "Ben")
expectEqual(rig.js("prompt('怎么称呼你?', '老板')") as? String, "Ben", "prompt 填了字 → 拿到那段字")
expect(rig.dialogs.contains(.prompt("怎么称呼你?", defaultText: "老板")), "prompt 带着默认值")
rig.dialogAnswer = (false, "Ben")
facts.append("prompt 点取消网页拿到:\(String(describing: rig.js("String(prompt('x'))")))")

// ── 12. 下载:<a download>(导出粒子配置,原样照抄那段代码:点完立刻在微任务里 revoke)
rig.downloaded = []
_ = rig.js("exportPreset()")
expect(waitUntil(5) { !rig.downloaded.isEmpty || !rig.downloadErrors.isEmpty }, "导出配置有了结果")
expectEqual(rig.downloadErrors, [], "下载没出错")
expectEqual(rig.downloaded.map(\.lastPathComponent), ["butler-swarm-v4.json"], "★<a download> 存进了「下载」文件夹、用的是网页给的名字")
if let file = rig.downloaded.first {
    let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    expect(text.contains("\"v\":4") && text.contains("粒子"), "存下来的就是那段 JSON:\(text)")
}
_ = rig.js("exportPreset()")
expect(waitUntil(5) { rig.downloaded.count == 2 || !rig.downloadErrors.isEmpty }, "再导一次")
expectEqual(rig.downloaded.last?.lastPathComponent, "butler-swarm-v4 (1).json", "★重名不覆盖,加 (1)")
expectEqual(rig.js("window.marker") as? String, "index", "下载不把页面换掉")

// ── 13. 服务端回「附件」:转下载;盖板不把好好的旧页一直盖着
rig.downloaded = []
let startsBefore = rig.provisionalStarts
_ = rig.js("document.getElementById('attach').click(); true")
expect(waitUntil(5) { !rig.downloaded.isEmpty || !rig.downloadErrors.isEmpty }, "附件有了结果")
expectEqual(rig.downloaded.first?.lastPathComponent, "报告.bin", "★附件存进「下载」、用服务端给的中文名")
facts.append("点附件时主框架有没有先开始换页(盖板会不会先盖上):\(rig.provisionalStarts > startsBefore ? "有" : "没有")")
spin(0.5)
expect(rig.cover.view.isHidden, "★附件下完,盖板没有盖死在旧页上")
expectEqual(rig.js("window.marker") as? String, "index", "附件不把页面换掉")

rig.downloaded = []
_ = rig.js("document.getElementById('attach-text').click(); true")
expect(waitUntil(5) { !rig.downloaded.isEmpty || !rig.downloadErrors.isEmpty }, "json 附件有了结果")
expectEqual(rig.downloaded.first?.lastPathComponent, "notes.json", "★网页显示得了的 json,标了 attachment 也存成文件")
spin(0.5)
expectEqual(rig.js("window.marker") as? String, "index", "★没有把工作台整页换成那段 json")
expect(rig.cover.view.isHidden, "盖板照旧揭开")

// ── 14. 其它:安全上下文、剪贴板、自动播放、麦克风(只记事实,不写系统剪贴板)
facts.append("isSecureContext(http://127.0.0.1)= \(rig.js("window.isSecureContext") as? Bool ?? false)")
facts.append("navigator.clipboard.writeText:\(rig.js("typeof (navigator.clipboard && navigator.clipboard.writeText)") as? String ?? "?")")
facts.append("navigator.mediaDevices:\(rig.js("typeof navigator.mediaDevices") as? String ?? "?")")
facts.append("Notification:\(rig.js("typeof Notification") as? String ?? "?") / permission=\(rig.js("typeof Notification === 'function' ? Notification.permission : 'n/a'") as? String ?? "?")")
facts.append("requestFullscreen:\(rig.js("typeof document.documentElement.requestFullscreen") as? String ?? "?")")
facts.append("自动播放要不要手势(mediaTypesRequiringUserActionForPlayback):\(rig.webView.configuration.mediaTypesRequiringUserActionForPlayback.rawValue)")
expectEqual(rig.js("window.isSecureContext") as? Bool, true, "http://127.0.0.1 是安全上下文(剪贴板等 API 可用)")

// ── 15. 同源链接照常走(放最后:它会换页)
rig.opened = []
_ = rig.js("document.getElementById('same').click(); true")
expect(waitUntil(5) { rig.js("window.marker") as? String == "second" }, "同源链接照常在壳里走")
expect(rig.opened.isEmpty, "同源链接不交给浏览器")

// MARK: - 汇总

print("── 记下来的事实 ──")
for fact in facts { print("  · \(fact)") }
if failures.isEmpty {
    print("✅ 壳网页能力(真 WebKit):\(checks) 条断言全绿")
    exit(0)
}
print("❌ 壳网页能力(真 WebKit):\(failures.count)/\(checks) 条不过")
for failure in failures { print("  - \(failure)") }
exit(1)
