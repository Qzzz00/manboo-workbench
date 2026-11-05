import Foundation

/// 壳里网页能力的**纯判断**(2026-09-25,卡 fix/shell-web-capabilities)。
///
/// 维护者 09-24 20:00:「明明有 + 号,上传文件和图片是没有弹出来选择内容的,我尝试拖拽一些文件,
/// 直接显示不支持」。查下来是一整类问题:浏览器(Chrome)自己会做的一批事,WKWebView 都要**宿主**
/// 来做 —— 宿主不做,网页那一侧就是「点了没反应」,而且不报错:
///
/// | 网页里 | Chrome | WKWebView 没有宿主时 |
/// |---|---|---|
/// | `<input type=file>`(输入框 +、粒子设置导入) | 弹系统选文件框 | 什么都不发生 |
/// | `target=_blank` / `window.open`(DSH 聊天里的链接、网页型应用、官网/下载) | 新标签 | 什么都不发生 |
/// | `window.confirm`(移除设备、重置账号) | 系统确认框 | **直接当成「取消」**,动作悄悄不做 |
/// | `<a download>`(导出粒子配置) | 存进「下载」 | 什么都不发生 |
/// | 文件拖到没人接的地方 | 当网页打开(有后退键) | **整个工作台被换成那个文件**,没有后退键 |
///
/// 这个文件只放判断(不 import AppKit / WebKit,`run-tests.sh` 里有用例);WebKit 那一半在
/// `WebHost.swift`,对照表与真引擎实测在 `docs/交接-0925-壳里的网页能力.md`。
enum WebPolicy {

    // MARK: - 导航

    /// 一次导航该怎么办。
    enum Navigation: Equatable {
        /// 照常走。
        case allow
        /// 不走,也不做别的(拖进来的文件没被网页接住时 WebKit 想「打开」它 —— 不许)。
        case cancel
        /// 转成下载(`<a download>`)。
        case download
        /// 交给系统:默认浏览器 / 邮件 / 系统设置。壳里只有一页,没有标签页可开。
        case openExternally(URL)
    }

    /// 从 `WKNavigationAction` 折出来的几样事实(值类型,测试里造得出来)。
    struct NavigationFacts: Equatable {
        var url: URL?
        var isMainFrame: Bool
        /// `navigationType == .linkActivated`:人点了一个链接(不是脚本跳转、不是重载、不是重定向)。
        var isLinkActivated: Bool
        var shouldPerformDownload: Bool
    }

    /// 能交给系统打开的协议。其余一律不交:聊天里的链接来自模型输出,不能让它随手拉起任意 App
    /// (`vscode://`、`weixin://` 这类自定义协议)。
    static let externalSchemes: Set<String> = ["http", "https", "mailto", "x-apple.systempreferences"]

    /// 主框架里的一次导航。`page` 是工作台页的原地址(`http://127.0.0.1:3080/?ben-workbench=app`)。
    ///
    /// 规则(按顺序):
    /// 1. `<a download>` → 下载。
    /// 2. `file:` → **不走**。WebKit 对「拖进来但网页没接住的文件」的默认动作是把主框架导航到那个文件
    ///    (PDF 就整页显示 PDF,认不得的类型就加载失败) —— 工作台整页被换掉,壳又没有后退键。
    ///    工作台从来不会主动去打开本地文件,所以一刀切掉不误伤。
    /// 3. 人点了链接、主框架、目标是**别的源**的 http(s) → 交给默认浏览器(同 Chrome 里点外链,只是
    ///    壳里「新标签」换成「浏览器」)。同源的照常走(那是 DSH 自己的页面)。
    /// 4. 人点了链接、主框架、`mailto:` / 系统设置 → 交给系统(WebKit 自己不认这两种,点了会加载失败)。
    /// 5. 其余照常。
    static func decide(_ facts: NavigationFacts, page: URL) -> Navigation {
        if facts.shouldPerformDownload { return .download }
        guard let url = facts.url, let scheme = url.scheme?.lowercased() else { return .allow }
        if scheme == "file" { return .cancel }
        guard facts.isMainFrame, facts.isLinkActivated else { return .allow }
        if scheme == "http" || scheme == "https" {
            return sameOrigin(url, page) ? .allow : .openExternally(url)
        }
        if externalSchemes.contains(scheme) { return .openExternally(url) }
        return .allow
    }

    /// `target=_blank` / `window.open(url)` 想开的新窗口 → 交给系统打开的那个地址;不该开的回 nil。
    ///
    /// 壳没有标签页,也不开第二扇网页窗(第二扇窗没有工作台的登录态、窗位、加载占位,开出来只会是
    /// 一扇孤零零的半成品)。所以 http(s) **不分同源异源**都交给默认浏览器 —— 与 Chrome「新标签」
    /// 的意思最接近。`about:blank`(先开空窗再往里写)与别的协议不开。
    static func newWindowTarget(_ url: URL?) -> URL? {
        guard let url, let scheme = url.scheme?.lowercased(), externalSchemes.contains(scheme) else { return nil }
        if (scheme == "http" || scheme == "https") && (url.host ?? "").isEmpty { return nil }
        return url
    }

    /// 一次导航拿到的回应要不要转成下载(同浏览器口径):
    /// - 服务端明说是附件(`Content-Disposition: attachment`)→ 下载,哪怕是网页显示得了的 txt/json ——
    ///   不然主框架会把工作台整页换成那段文字;
    /// - 网页显示不了的类型(压缩包、二进制)→ 下载;
    /// - 但 204/205(本来就不换页)和出错的回应(非 2xx)不转:那不是文件,转了只会落一个空文件或错误页。
    /// `statusCode` 为 nil = 不是 HTTP(blob: / data:)。
    static func responseIsDownload(canShowMIMEType: Bool, statusCode: Int?, contentDisposition: String?) -> Bool {
        if let status = statusCode, !(200..<300).contains(status) || status == 204 || status == 205 { return false }
        if let disposition = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased(),
           disposition.hasPrefix("attachment") { return true }
        return !canShowMIMEType
    }

    /// 协议、主机、端口都一样才算同源(端口缺省按协议补)。
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let sa = a.scheme?.lowercased(), let sb = b.scheme?.lowercased(), sa == sb,
              let ha = a.host?.lowercased(), let hb = b.host?.lowercased(), ha == hb else { return false }
        return effectivePort(a) == effectivePort(b)
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    // MARK: - 选文件

    /// 选文件框要长什么样。字段来自 `WKOpenPanelParameters`(accept 那一份走 WebKit 的 SPI,
    /// 拿不到就是空 = 不限类型)。
    struct OpenPanelRequest: Equatable {
        var allowsMultipleSelection: Bool
        /// `<input webkitdirectory>`:选的是**文件夹**,WebKit 自己把里面的文件一个个列给网页。
        var allowsDirectories: Bool
        /// `accept` 折成的扩展名(不带点、小写、去重)。空 = 不限。
        var allowedExtensions: [String]
    }

    /// NSOpenPanel 的三个开关。
    struct OpenPanelOptions: Equatable {
        var canChooseFiles: Bool
        var canChooseDirectories: Bool
        var allowsMultipleSelection: Bool
        /// 空 = 不限类型。
        var allowedExtensions: [String]
    }

    /// 选文件夹那一种(webkitdirectory)**只给选文件夹**:与 Chrome 的「上传文件夹」一致,
    /// 选中一个文件交回去 WebKit 也列不出目录结构。文件夹不按类型过滤。
    static func openPanelOptions(for request: OpenPanelRequest) -> OpenPanelOptions {
        if request.allowsDirectories {
            return OpenPanelOptions(canChooseFiles: false, canChooseDirectories: true,
                                    allowsMultipleSelection: request.allowsMultipleSelection, allowedExtensions: [])
        }
        return OpenPanelOptions(canChooseFiles: true, canChooseDirectories: false,
                                allowsMultipleSelection: request.allowsMultipleSelection,
                                allowedExtensions: normalizedExtensions(request.allowedExtensions))
    }

    /// 「.JSON」「json」「 png 」→ 「json」「png」;通配(`*`)与空串扔掉;保序去重。
    /// 只要出现一个通配就当不限(`accept="*/*"` 那一类)。
    static func normalizedExtensions(_ raw: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for item in raw {
            var ext = item.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            while ext.hasPrefix(".") { ext.removeFirst() }
            if ext.contains("*") { return [] }
            if ext.isEmpty || ext.contains("/") { continue }
            if seen.insert(ext).inserted { out.append(ext) }
        }
        return out
    }

    // MARK: - 下载

    /// 下载落到「下载」文件夹时用的文件名:去掉路径分隔与控制字符,不许以点开头(不做隐藏文件),
    /// 空了就叫「下载」;重名依次加「 (1)」「 (2)」…(同 Safari / Chrome),永不覆盖已有文件。
    static func downloadFileName(suggested: String, exists: (String) -> Bool) -> String {
        let base = sanitizedFileName(suggested)
        if !exists(base) { return base }
        let ns = base as NSString
        let ext = ns.pathExtension
        let stem = ext.isEmpty ? base : ns.deletingPathExtension
        for n in 1...9_999 {
            let candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            if !exists(candidate) { return candidate }
        }
        return "\(stem) (\(UUID().uuidString))" + (ext.isEmpty ? "" : ".\(ext)")
    }

    /// 只换 C0/C1 控制字符(不用 `CharacterSet.controlCharacters`:它连 Cf 类的零宽连接符也算进去,
    /// 会把「👨‍💻」这种带零宽连接符的表情拆坏)。
    private static let bannedInFileName: CharacterSet = {
        var set = CharacterSet(charactersIn: "/:\\")
        set.insert(charactersIn: Unicode.Scalar(0x00)!...Unicode.Scalar(0x1F)!)
        set.insert(charactersIn: Unicode.Scalar(0x7F)!...Unicode.Scalar(0x9F)!)
        set.formUnion(.newlines)
        return set
    }()

    static func sanitizedFileName(_ raw: String) -> String {
        let banned = bannedInFileName
        var name = String(raw.unicodeScalars.map { banned.contains($0) ? "_" : Character($0) })
            .trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "下载" }
        // 文件名超长(APFS 上限 255 字节)时截短主干、保住扩展名。
        if name.utf8.count > 200 {
            let ns = name as NSString
            let ext = ns.pathExtension
            var stem = ext.isEmpty ? name : ns.deletingPathExtension
            while stem.utf8.count > 180 { stem.removeLast() }
            name = ext.isEmpty ? stem : "\(stem).\(ext)"
        }
        return name
    }

    // MARK: - 网页弹框(alert / confirm / prompt)

    /// 弹框上那一行标题。消息是网页原话;空消息给一句兜底,不弹一个空框。
    static func dialogMessage(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "工作台" : text
    }
}
