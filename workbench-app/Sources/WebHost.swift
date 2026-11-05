import AppKit
import UniformTypeIdentifiers
import WebKit

/// 壳替网页做的那一批「浏览器本该做的事」(2026-09-25,卡 fix/shell-web-capabilities)。
///
/// 判断全在 `WebPolicy.swift`(纯逻辑,`run-tests.sh` 有用例);这里只做 AppKit / WebKit 那一半:
///
/// - **选文件**(`<input type=file>`:输入框的 +、粒子设置的导入)→ `NSOpenPanel`;
/// - **新窗口**(`target=_blank` / `window.open`)→ 交给默认浏览器;
/// - **网页弹框**(`alert` / `confirm` / `prompt`)→ `NSAlert`;
/// - **下载**(`<a download>`、服务端回「附件」)→ 存进「下载」文件夹,在访达里选中它;
/// - **导航**:拖进来没被网页接住的文件不许把工作台整页换掉;点外链交给浏览器。
///
/// 每一处「真的弹框 / 真的打开 / 真的写盘」都是**可注入的闭包**:真引擎测试(`run-web-tests.sh`)
/// 换成假的,不弹任何东西、不拉起浏览器、不碰真的「下载」文件夹。
///
/// 拖文件进网页**不在这里**:WKWebView 自己就是拖放目标,文件会原样交给网页的 drop 处理。
/// 维护者看到的「直接显示不支持」是网页那一层的事(DSH 压在工作台下面的对话栏抢了文件拖放),
/// 修在 `workbench-plugin/src/client/fileDropGuard.ts`,查证过程见交接文档。
final class WebHost: NSObject, WKUIDelegate, WKDownloadDelegate {
    /// 网页弹框的三种。
    enum Dialog: Equatable {
        case alert(String)
        case confirm(String)
        case prompt(String, defaultText: String?)
    }

    /// 工作台页原地址(判同源用)。
    let page: URL
    /// 弹框、选文件框跟着哪扇窗(壳的主窗)。
    weak var window: NSWindow?

    // MARK: 可注入的「真动作」(默认值就是真的;测试里换掉)

    /// 弹选文件框。回调 nil = 他点了取消。
    var presentOpenPanel: (WebPolicy.OpenPanelRequest, NSWindow?, @escaping ([URL]?) -> Void) -> Void = WebHost.systemOpenPanel
    /// 交给系统打开(默认浏览器 / 邮件 / 系统设置)。
    var openExternally: (URL) -> Void = { url in
        // 这一下也是「开一个 App」(默认浏览器 / 邮件 / 系统设置),所以也记一行(2026-10-02)。
        // **只记协议头**,不记整条地址:地址里可能带 token、带她的账号。
        AppOpenLog.note(bundleId: "(系统默认打开)", op: "web_open_external", why: url.scheme)
        if !NSWorkspace.shared.open(url) { NSLog("WebHost: 系统打不开 \(url.absoluteString)") }
    }
    /// 弹网页弹框。回调 (点了确定, prompt 里填的字)。
    var presentDialog: (Dialog, NSWindow?, @escaping (Bool, String?) -> Void) -> Void = WebHost.systemDialog
    /// 下载落在哪个文件夹。
    var downloadsDirectory: () -> URL = {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
    }
    /// 下载完了:默认让「下载」叠跳一下,并在访达里选中它 —— 壳里没有下载栏,不给个看得见的交代,
    /// 人不知道东西去哪了。
    var downloadFinished: (URL) -> Void = WebHost.revealDownloaded
    /// 下载失败:默认弹一句人话。
    var downloadFailed: (String) -> Void = { message in
        WebHost.systemDialog(.alert("没下载成功:\(message)"), nil) { _, _ in }
    }

    /// 开着的选文件框选完之后回给谁(nil = 没有框开着)。一次只开一个框,见 runOpenPanel 里那段。
    private var pendingOpenPanel: (@MainActor ([URL]?) -> Void)?
    /// 在路上的下载(WKDownload 的 delegate 是弱引用,自己拿住)与它们要落的地址。
    private var downloads: [ObjectIdentifier: (download: WKDownload, destination: URL?)] = [:]

    init(page: URL) {
        self.page = page
        super.init()
    }

    // MARK: - 导航(AppDelegate 的 WKNavigationDelegate 调这两个)

    static func facts(of action: WKNavigationAction) -> WebPolicy.NavigationFacts {
        // targetFrame 为 nil = 要开新窗口(target=_blank)。按主框架算:要么在这里就交给浏览器,
        // 要么放行后走 createWebViewWith,也是交给浏览器 —— 不会开两次。
        WebPolicy.NavigationFacts(url: action.request.url,
                                  isMainFrame: action.targetFrame?.isMainFrame ?? true,
                                  isLinkActivated: action.navigationType == .linkActivated,
                                  shouldPerformDownload: action.shouldPerformDownload)
    }

    /// 一次导航的去留;该交给系统打开的,顺手在这里交出去。
    func decide(_ action: WKNavigationAction) -> WKNavigationActionPolicy {
        switch WebPolicy.decide(Self.facts(of: action), page: page) {
        case .allow:
            return .allow
        case .cancel:
            NSLog("WebHost: 不在工作台里打开本地文件(多半是拖进来的文件没落在能接的地方)")
            return .cancel
        case .download:
            return .download
        case .openExternally(let url):
            openExternally(url)
            return .cancel
        }
    }

    /// 附件、网页显示不了的回应转成下载;别的照常(规矩在 WebPolicy.responseIsDownload)。
    func decide(_ response: WKNavigationResponse) -> WKNavigationResponsePolicy {
        let http = response.response as? HTTPURLResponse
        return WebPolicy.responseIsDownload(canShowMIMEType: response.canShowMIMEType,
                                            statusCode: http?.statusCode,
                                            contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition"))
            ? .download : .allow
    }

    /// 导航变成了下载(两条路都走这里):接管它。
    func adopt(_ download: WKDownload) {
        download.delegate = self
        downloads[ObjectIdentifier(download)] = (download, nil)
    }

    // MARK: - WKUIDelegate:选文件

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let request = WebPolicy.OpenPanelRequest(allowsMultipleSelection: parameters.allowsMultipleSelection,
                                                 allowsDirectories: parameters.allowsDirectories,
                                                 allowedExtensions: Self.acceptedExtensions(parameters))
        if let previous = pendingOpenPanel {
            // 兜底(真框是 app 级模态,人点不到第二次;见 systemOpenPanel)。万一又来一次请求:
            // WebKit 的 UI 进程收到第二次时会把第一次的回调作废(WebPageProxy::runOpenPanel),所以开着的
            // 那个框改成回给**这一次**,作废的那个按取消回掉 —— 每个回调都必须回一次,否则 WebKit 抛
            // 「completion handler was not called」。不叠第二个框。
            pendingOpenPanel = completionHandler
            previous(nil)
            return
        }
        pendingOpenPanel = completionHandler
        presentOpenPanel(request, window ?? webView.window) { [weak self] urls in
            guard let self, let done = self.pendingOpenPanel else { return }
            self.pendingOpenPanel = nil
            done(urls)
        }
    }

    /// `accept` 折成的扩展名。公开 API 没有这一项,走 WebKit 的 SPI(Safari 用的同一个):
    /// `_allowedFileExtensions` 已经把 MIME(`image/*`、`application/json`)展开成扩展名。
    /// 哪天 WebKit 拿掉了它,就退回「不限类型」—— 宁可多给选,不能一个都选不了。
    static func acceptedExtensions(_ parameters: WKOpenPanelParameters) -> [String] {
        for key in ["_allowedFileExtensions", "_acceptedFileExtensions"] {
            guard parameters.responds(to: NSSelectorFromString(key)),
                  let list = parameters.value(forKey: key) as? [String] else { continue }
            return list
        }
        return []
    }

    /// 按请求配好一个选文件框(不弹)。测试直接看它的开关。
    static func makeOpenPanel(_ request: WebPolicy.OpenPanelRequest) -> NSOpenPanel {
        let options = WebPolicy.openPanelOptions(for: request)
        let panel = NSOpenPanel()
        panel.canChooseFiles = options.canChooseFiles
        panel.canChooseDirectories = options.canChooseDirectories
        panel.allowsMultipleSelection = options.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.canCreateDirectories = false
        let types = options.allowedExtensions.compactMap { UTType(filenameExtension: $0) }
        if !types.isEmpty { panel.allowedContentTypes = types }
        // 只做深色(维护者 09-24「先不做浅色」):系统浅色时也别弹一块白的。
        panel.appearance = NSAppearance(named: .darkAqua)
        return panel
    }

    /// 真的弹:**app 级模态**的独立面板。两条都是踩出来的:
    /// - 不挂成主窗的 sheet(Safari 的做法):工作台在「桌面档」时主窗降在普通层下面半级
    ///   (`WindowMode.swift`),sheet 跟着低半级,会被窗位里认领来的窗口压住 —— 人看不见,
    ///   主窗又被 sheet 锁住,等于卡死。模态面板在模态层,一定在最前。
    /// - 不做成非模态(`begin`):真引擎实测(run-web-tests.sh 第 4 段),框开着时人再点一次同一个
    ///   `<input type=file>`,WebKit 会把正在等的那次作废(FileInputType 换了一个新的 FileChooser),
    ///   框里选的文件交回去就掉在地上。模态期间网页点不到,这个坑就踩不到。
    /// 放到下一轮 runloop 再开模态:不在 WebKit 的回调里嵌一层模态循环。
    static func systemOpenPanel(_ request: WebPolicy.OpenPanelRequest, _ window: NSWindow?,
                                _ done: @escaping ([URL]?) -> Void) {
        DispatchQueue.main.async {
            let panel = makeOpenPanel(request)
            NSApp.activate()
            let response = panel.runModal()
            done(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - WKUIDelegate:新窗口(target=_blank / window.open)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = WebPolicy.newWindowTarget(navigationAction.request.url) {
            openExternally(url)
        }
        else {
            NSLog("WebHost: 不开新窗口(\(navigationAction.request.url?.scheme ?? "空地址"))")
        }
        return nil
    }

    // MARK: - WKUIDelegate:alert / confirm / prompt

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        presentDialog(.alert(message), window ?? webView.window) { _, _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        presentDialog(.confirm(message), window ?? webView.window) { ok, _ in completionHandler(ok) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        presentDialog(.prompt(prompt, defaultText: defaultText), window ?? webView.window) { ok, text in
            completionHandler(ok ? (text ?? "") : nil)
        }
    }

    /// 真的弹。放到下一轮 runloop 再开模态:不在 WebKit 的回调里嵌一层模态循环。
    /// 用 app 级模态(`runModal`)而不是 sheet,理由同选文件框(桌面档的主窗低半级)。
    static func systemDialog(_ dialog: Dialog, _ window: NSWindow?, _ done: @escaping (Bool, String?) -> Void) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.window.appearance = NSAppearance(named: .darkAqua)
            var field: NSTextField?
            switch dialog {
            case .alert(let message):
                alert.messageText = WebPolicy.dialogMessage(message)
                alert.addButton(withTitle: "好")
            case .confirm(let message):
                alert.messageText = WebPolicy.dialogMessage(message)
                alert.addButton(withTitle: "确定")
                alert.addButton(withTitle: "取消")
            case .prompt(let message, let defaultText):
                alert.messageText = WebPolicy.dialogMessage(message)
                alert.addButton(withTitle: "确定")
                alert.addButton(withTitle: "取消")
                let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
                input.stringValue = defaultText ?? ""
                alert.accessoryView = input
                alert.window.initialFirstResponder = input
                field = input
            }
            NSApp.activate()
            let ok = alert.runModal() == .alertFirstButtonReturn
            done(ok, field?.stringValue)
        }
    }

    // MARK: - WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = downloadsDirectory()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        catch {
            NSLog("WebHost: 建不了下载文件夹 \(dir.path):\(error.localizedDescription)")
            downloads.removeValue(forKey: ObjectIdentifier(download))
            downloadFailed("「下载」文件夹用不了")
            completionHandler(nil)
            return
        }
        // 同名的两个下载前后脚到(文件还没落盘):在路上的也算占用,不让第二个撞上第一个。
        let pending = Set(downloads.values.compactMap { $0.destination?.lastPathComponent })
        let name = WebPolicy.downloadFileName(suggested: suggestedFilename) { candidate in
            pending.contains(candidate) || FileManager.default.fileExists(atPath: dir.appendingPathComponent(candidate).path)
        }
        let destination = dir.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = (download, destination)
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = downloads.removeValue(forKey: ObjectIdentifier(download)),
              let destination = entry.destination else { return }
        NSLog("WebHost: 下载完了 \(destination.lastPathComponent)")
        downloadFinished(destination)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        NSLog("WebHost: 下载失败 \(error.localizedDescription)")
        downloadFailed(error.localizedDescription)
    }

    /// 让程序坞里的「下载」叠跳一下(Safari / Chrome 发的同一条通知),再在访达里选中它。
    static func revealDownloaded(_ url: URL) {
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"),
                                                     object: url.path)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
