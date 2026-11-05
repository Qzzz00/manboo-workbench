import AppKit
import ApplicationServices

/// 「Agent 自动发现与统一接入」(2026-09-25,卡 Q)里**真去读窗口的那一半**。
///
/// 三个原语,**全都只读**:不点、不打字、不切对话、不激活、不取消隐藏、不动焦点。
/// 判断一条都不在这里下(像不像对话窗口、哪一行是最新一句、它还在不在跑),全在插件那一侧,有单测;
/// 这里只把窗口**长什么样**、**写着什么**如实读回去,读法有上限(节点数 + 毫秒),读不完就说读不完。
///
/// | op | 读什么 | 什么时候 |
/// |---|---|---|
/// | `running_apps` | 正在跑的常规 App:名字、包标识、类别、出品方、是不是 Electron。**不碰辅助功能** | 工作台启动扫一遍、低频巡检 |
/// | `agent_probe` | 窗口**结构**:有没有输入框(只读占位提示,**不读框里的字**)、发送 / 停止 / 新对话、列表、字块数。**不读对话内容** | 发现一家、判它像不像对话窗口 |
/// | `agent_read` | 窗口标题、有没有「停止」键、对话区尾巴上那几块字、侧栏那几行 | **只对登记表里接上了的那几家**(服务端把着) |
///
/// 人跟人聊天的应用(微信、企业微信)**永远不读**:服务端那一侧先按名字判、判出来就连结构都不看;
/// 壳这一侧 `AgentWindowPolicy.neverRead` 是第二道门。
///
/// 辅助功能授权认的是壳的签名 —— 这几个原语走的就是壳那条 `/helper` 长连,不另起进程、不要新授权。
/// Electron 的应用(Manus、Kimi、Claude……)要先写一次 `AXManualAccessibility` 才看得到网页那一层,
/// 写这一下不改变它界面上的任何东西(同 `TextInsert` 里送话前的那一下)。
enum AgentWindow {

    // MARK: - icon_colors

    /// 各家 App 图标的主色(2026-09-25,卡 Q:头像、小灯、手机上那一家的颜色从它自己的图标来,不写死)。
    /// 按包标识找装着的那一份(开没开都行),把图标画进一小块 48×48 的位图,主色由 `IconColor` 挑。
    /// **不碰辅助功能、不碰窗口**;没装的那一家不回(插件那一侧用中性灰,不猜)。
    static func iconColors(bundleIds: [String]) -> [String: Any] {
        var colors: [String: String] = [:]
        for bundleId in bundleIds.prefix(40) where !bundleId.isEmpty {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { continue }
            if let color = sampleIcon(NSWorkspace.shared.icon(forFile: url.path)) { colors[bundleId] = color }
        }
        return ["ok": true, "result": ["colors": colors]]
    }

    // MARK: - app_icon

    /// 壳内存里那份图标缓存(2026-09-26,卡 LG)。图标一个进程周期里基本不变,渲一次就够;
    /// 键是 `AppIconPolicy.cacheKey`(包标识 + 边长),**同样的问第二次回的是同一份**(幂等)。
    /// 没装 / 渲不出的那一家也记下来(记的是「没有」),免得每一拍都去问一遍 LaunchServices。
    private static var iconCache: [String: [String: Any]] = [:]
    private static let iconCacheLock = NSLock()

    /// 一个 App 的**整张图标**(2026-09-26,卡 LG:窗口槽标签、顶栏小灯、「N 家 Agent 客户端」那一条上的小图标)。
    /// 按包标识找装着的那一份(开没开都行),`NSWorkspace.shared.icon(forFile:)` 按 `AppIconPolicy` 的边长 @2x 渲一次,
    /// 回 PNG 的 base64。**不碰辅助功能、不碰窗口**;只认包标识、不认任意路径(服务端只拿登记表里有包标识的那几家来问)。
    ///
    /// 没装 / 渲不出来 → `{ found: false, why }`,不是错误:插件那一侧界面退回色点(现有样子),不猜一张图。
    static func appIcon(bundleId: String, size: Int?) -> [String: Any] {
        let trimmed = bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ["ok": false, "error": "要带 bundle_id"] }
        let side = AppIconPolicy.side(size)
        let key = AppIconPolicy.cacheKey(bundleId: trimmed, side: side)
        iconCacheLock.lock()
        let cached = iconCache[key]
        iconCacheLock.unlock()
        if let cached { return ["ok": true, "result": cached] }

        var result: [String: Any]
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed) {
            if let png = iconPng(NSWorkspace.shared.icon(forFile: url.path), side: side) {
                result = [
                    "found": true, "png": png.base64EncodedString(), "bytes": png.count,
                    "w": side * AppIconPolicy.scale, "h": side * AppIconPolicy.scale, "side": side,
                ]
            }
            else { result = ["found": false, "why": "渲不出它的图标"] }
        }
        else { result = ["found": false, "why": "这台电脑上没装这个应用"] }
        iconCacheLock.lock()
        iconCache[key] = result
        iconCacheLock.unlock()
        return ["ok": true, "result": result]
    }

    /// 把图标渲成 (side×scale)² 像素的 PNG。渲出来的不是 PNG 就当没取到(`AppIconPolicy.isPng` 把一道)。
    static func iconPng(_ image: NSImage, side: Int) -> Data? {
        let pixels = side * AppIconPolicy.scale
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: pixels * 4, bitsPerPixel: 32
        ) else { return nil }
        rep.size = NSSize(width: side, height: side)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
        return AppIconPolicy.isPng([UInt8](data)) ? data : nil
    }

    /// 把图标画进 side×side 的 RGBA(预乘)位图,交给 `IconColor.dominant`。
    static func sampleIcon(_ image: NSImage, side: Int = 48) -> String? {
        var rect = CGRect(x: 0, y: 0, width: side, height: side)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        return drawn ? IconColor.dominant(rgba: pixels) : nil
    }

    // MARK: - running_apps

    static func runningApps(ownBundleId: String) -> [String: Any] {
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        var apps: [[String: Any]] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let bundleId = app.bundleIdentifier, !bundleId.isEmpty, bundleId != ownBundleId else { continue }
            var row = identity(app)
            row["active"] = bundleId == front
            row["hidden"] = app.isHidden
            apps.append(row)
        }
        return ["ok": true, "result": ["apps": apps]]
    }

    /// 一个 App 的身份:名字(连同它自己带的中文名)、包标识、类别、出品方、版本、是不是 Electron。
    /// 全是它包里 Info.plist 写着的,**不碰辅助功能、不碰窗口**。
    static func identity(_ app: NSRunningApplication) -> [String: Any] {
        let bundleId = app.bundleIdentifier ?? ""
        var row: [String: Any] = ["bundle_id": bundleId, "name": app.localizedName ?? bundleId, "pid": Int(app.processIdentifier)]
        if let url = app.bundleURL {
            if let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) as? [String: Any] {
                if let category = info["LSApplicationCategoryType"] as? String { row["category"] = AgentWindowPolicy.clip(category, 80) }
                if let vendor = (info["NSHumanReadableCopyright"] as? String) ?? (info["CFBundleGetInfoString"] as? String) {
                    row["vendor"] = AgentWindowPolicy.clip(vendor, 80)
                }
                if let version = info["CFBundleShortVersionString"] as? String { row["version"] = AgentWindowPolicy.clip(version, 30) }
            }
            // 它自己带的中文名(豆包的包里 zh_CN 那一份写着「豆包」,系统是英文时 localizedName 是 Doubao)。
            for folder in ["zh-Hans", "zh_CN", "zh-CN", "zh"] {
                let strings = url.appendingPathComponent("Contents/Resources/\(folder).lproj/InfoPlist.strings")
                if let dict = NSDictionary(contentsOf: strings) as? [String: Any],
                   let zh = (dict["CFBundleDisplayName"] as? String) ?? (dict["CFBundleName"] as? String),
                   !zh.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    row["name_zh"] = AgentWindowPolicy.clip(zh, 40)
                    break
                }
            }
            let electron = url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path
            row["electron"] = FileManager.default.fileExists(atPath: electron)
        }
        return row
    }

    // MARK: - 一个节点一次取回的那几格

    /// 一个节点一次 IPC 取回来(`AXUIElementCopyMultipleAttributeValues`)。一格一格地问,
    /// 一个节点就是七八次来回;Electron 应用一次来回要上百微秒,几千个节点就是好几秒。
    private static let baseAttrs: [String] = [
        kAXRoleAttribute as String, kAXSubroleAttribute as String, kAXTitleAttribute as String,
        kAXDescriptionAttribute as String, kAXPositionAttribute as String, kAXSizeAttribute as String,
        kAXChildrenAttribute as String, kAXSelectedAttribute as String,
    ]

    private struct Node {
        let role: String
        let subrole: String?
        let title: String?
        let desc: String?
        let frame: CGRect?
        let children: [AXUIElement]
        let selected: Bool?
    }

    private static func node(_ element: AXUIElement) -> Node? {
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(element, baseAttrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard err == .success, let list = values as? [AnyObject], list.count == baseAttrs.count else { return nil }
        func value(_ i: Int) -> AnyObject? {
            let v = list[i]
            // 取不到的那一格回的是一个 kAXValueAXErrorType 的 AXValue,当它不存在。
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            if v is NSNull { return nil }
            return v
        }
        func string(_ i: Int) -> String? {
            guard let s = value(i) as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        var frame: CGRect?
        if let pos = value(4), let size = value(5),
           CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
            var p = CGPoint.zero
            var s = CGSize.zero
            if AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) {
                frame = CGRect(origin: p, size: s)
            }
        }
        var selected: Bool?
        if let sel = value(7), CFGetTypeID(sel) == CFBooleanGetTypeID() {
            selected = CFBooleanGetValue((sel as! CFBoolean))
        }
        return Node(role: string(0) ?? "", subrole: string(1), title: string(2), desc: string(3),
                    frame: frame, children: (value(6) as? [AXUIElement]) ?? [], selected: selected)
    }

    private static func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success, let s = value as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    private static func isSettable(_ element: AXUIElement, _ attr: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, attr as CFString, &settable) == .success else { return false }
        return settable.boolValue
    }

    // MARK: - 找那扇窗

    private enum Located {
        case ok(app: NSRunningApplication, appEl: AXUIElement, window: AXUIElement, frame: CGRect, windows: Int, minimized: Bool)
        case fail([String: Any])
    }

    /// 那家此刻的主窗。**只读**:主窗 → 焦点窗 → 第一扇标准窗;一扇都没有就如实说。
    private static func locate(_ bundleId: String) -> Located {
        if AgentWindowPolicy.neverRead(bundleId) {
            return .fail(["ok": false, "error": AgentWindowPolicy.neverReadMessage(bundleId)])
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return .fail(["ok": true, "result": ["running": false]])
        }
        // Chromium / Electron 的 AX 通道默认关着;写一次就是敲门(一处写、处处用,见 AXWake)。
        let appEl = AXWake.app(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        var windowsRef: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef)
        if err != .success {
            return .fail(["ok": true, "result": ["running": true, "windows": 0, "ax_err": Int(err.rawValue),
                                                 "active": app.isActive, "hidden": app.isHidden]])
        }
        let all = (windowsRef as? [AXUIElement]) ?? []
        let standard = all.filter { stringAttr($0, kAXSubroleAttribute as String) == kAXStandardWindowSubrole as String }
        let windows = standard.isEmpty ? all : standard
        guard !windows.isEmpty else {
            return .fail(["ok": true, "result": ["running": true, "windows": 0, "active": app.isActive, "hidden": app.isHidden]])
        }
        var chosen = windows[0]
        for attr in [kAXMainWindowAttribute as String, kAXFocusedWindowAttribute as String] {
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(appEl, attr as CFString, &ref) == .success, let w = ref,
               CFGetTypeID(w) == AXUIElementGetTypeID(), windows.contains(where: { CFEqual($0, w) }) {
                chosen = w as! AXUIElement
                break
            }
        }
        AXUIElementSetMessagingTimeout(chosen, 0.5)
        guard let info = node(chosen), let frame = info.frame, frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0 else {
            return .fail(["ok": true, "result": ["running": true, "windows": windows.count, "active": app.isActive, "hidden": app.isHidden,
                                                 "note": "那扇窗读不出大小"]])
        }
        var minimized = false
        var minRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(chosen, kAXMinimizedAttribute as CFString, &minRef) == .success,
           let m = minRef, CFGetTypeID(m) == CFBooleanGetTypeID() {
            minimized = CFBooleanGetValue((m as! CFBoolean))
        }
        return .ok(app: app, appEl: appEl, window: chosen, frame: frame, windows: windows.count, minimized: minimized)
    }

    // MARK: - agent_probe:只看结构

    /// 窗口**结构**:输入框在哪(只读占位提示)、有没有发送 / 停止 / 新对话、有几张列表、字块在哪一带(**只数不读**)、
    /// 输入区那一排按钮叫什么、菜单栏顶上那几项。服务端据此判「像不像一个对话窗口」。
    ///
    /// ★ **2026-09-26(卡 MQ):看一眼不行就等一拍再看一眼。**
    ///
    /// Chromium / Electron 系的应用等有辅助功能客户端来读的时候才建网页那一层的树,而且**不是当场就好**。
    /// 头一眼常常只看得到窗口壳那几个节点 —— 一个输入框都没有,于是登记表把一家明明有聊天窗的 App
    /// 判成「没有输入框、没有发送键」(2026-09-26 Grok Bot、Antigravity 就是这么被冤枉的;
    /// 维护者原话:「有聊天窗口呢,我都用上了」)。`locate` 每次都敲门(`AXWake`),
    /// 所以第二眼是在**门已经敲过、树正在建**之后看的 —— 实测这一眼就看得见输入框和发送键了。
    ///
    /// 只多看一眼;判在 `AgentWindowPolicy.worthSecondLook`(纯函数,有单测)。
    /// 第二眼**找着输入框**才用第二眼那一份,否则还回第一眼的 —— 不拿一份更空的去盖掉它。
    static func probe(bundleId: String) -> [String: Any] {
        let first = probeOnce(bundleId: bundleId)
        // `visited` 只有**真走过一扇窗**的那一份才有 —— 没在跑 / 一扇窗都没有的那几种直接回,
        // 再看一眼也没有窗可看(白等一拍)。
        guard let result = first["result"] as? [String: Any], let visited = result["visited"] as? Int,
              AgentWindowPolicy.worthSecondLook(
                  inputs: (result["inputs"] as? [[String: Any]])?.count ?? 0,
                  visited: visited,
                  capped: result["capped"] as? Bool ?? false)
        else { return first }
        Thread.sleep(forTimeInterval: Double(AgentWindowPolicy.treeWakeWaitMs) / 1000)
        let second = probeOnce(bundleId: bundleId)
        guard var again = second["result"] as? [String: Any],
              ((again["inputs"] as? [[String: Any]])?.count ?? 0) > 0
        else { return first }
        // 记一笔「这一份是第二眼看到的」:以后谁看见登记表里某家忽好忽坏,一眼能看出是不是这件事。
        again["second_look"] = true
        return ["ok": true, "result": again]
    }

    private static func probeOnce(bundleId: String) -> [String: Any] {
        let started = CFAbsoluteTimeGetCurrent()
        let located = locate(bundleId)
        guard case let .ok(app, appEl, window, winFrame, windowCount, minimized) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        let winW = winFrame.width
        let winSize = winFrame.size
        var inputs: [[String: Any]] = []
        var inputFrames: [CGRect] = []
        var send: [[String: Any]] = []
        var stop: [[String: Any]] = []
        var newChatButtons: [String] = []
        var lists: [[String: Any]] = []
        var textFrames: [CGRect] = []
        var linkFrames: [CGRect] = []
        var sidebarCandidates: [CGRect] = []
        var buttons: [(label: String, frame: CGRect)] = []
        var visited = 0
        var capped = false
        var sheet = false
        /// 各角色各数到几个(2026-10-01,诊断用)。**只数不读**:角色名是系统常量,不是它窗口上的字。
        var roleCounts: [String: Int] = [:]

        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var head = 0
        while head < queue.count {
            if visited >= AgentWindowPolicy.probeMaxVisited
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.probeMaxMs {
                capped = true
                break
            }
            let (element, depth) = queue[head]
            head += 1
            visited += 1
            guard let n = node(element) else { continue }
            if !n.role.isEmpty { roleCounts[n.role, default: 0] += 1 }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            if depth == 1, n.role == "AXSheet" { sheet = true }
            if SendTextPolicy.inputRoles.contains(n.role) {
                // **不读框里的字**(那可能是他没发出去的草稿),只读占位提示。
                if let r = rel, r.width >= SendTextPolicy.minInputSize.width, r.height >= SendTextPolicy.minInputSize.height, inputs.count < 6 {
                    var row: [String: Any] = ["role": n.role, "settable": isSettable(element, kAXValueAttribute as String)]
                    if let ph = stringAttr(element, kAXPlaceholderValueAttribute as String) ?? n.desc ?? n.title {
                        row["ph"] = AgentWindowPolicy.clip(ph, 60)
                    }
                    row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                    inputs.append(row)
                    inputFrames.append(r)
                }
                continue
            }
            if n.role == kAXButtonRole as String || n.role == "AXPopUpButton" || n.role == "AXMenuButton" {
                let label = n.title ?? n.desc ?? ""
                if let r = rel {
                    if SendTextPolicy.looksLikeComposerButton(title: label), inputs.count < 6 {
                        // 整个输入区画成一颗按钮(只能点、不能写)。它就是输入框。
                        var row: [String: Any] = ["role": n.role, "settable": false, "composer": AgentWindowPolicy.clip(label, 80)]
                        row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                        inputs.append(row)
                        inputFrames.append(r)
                        continue
                    }
                    if SendTextPolicy.looksLikeStopButton(title: n.title, description: n.desc), stop.count < 4 {
                        stop.append(AgentWindowPolicy.rectJSON(r))
                    } else if SendTextPolicy.looksLikeSendButton(title: n.title, description: n.desc), send.count < 4 {
                        var row: [String: Any] = ["label": AgentWindowPolicy.clip(label, 30)]
                        row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                        send.append(row)
                    } else if SendTextPolicy.isNewConversationItem(label), newChatButtons.count < 4 {
                        newChatButtons.append(AgentWindowPolicy.clip(label, 30))
                    }
                    if !label.isEmpty { buttons.append((label: label, frame: r)) }
                }
                // 按钮里面的字是界面字,不往下看。
                continue
            }
            if n.role == kAXStaticTextRole as String {
                // **只记位置,不读字**。
                if let r = rel { textFrames.append(r) }
                continue
            }
            if let r = rel {
                if n.role == "AXLink" { linkFrames.append(r) }
                if AgentWindowPolicy.looksLikeSidebar(r, windowSize: winSize) { sidebarCandidates.append(r) }
                if ["AXList", "AXOutline", "AXTable"].contains(n.role), lists.count < 6 {
                    var row: [String: Any] = ["role": n.role, "rows": n.children.count]
                    row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                    lists.append(row)
                }
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { queue.append((child, depth + 1)) }
        }

        // 最靠下的那个输入框就是聊天输入框(同 SendTextPolicy.pickInput 的第二条)。
        let chatInput = inputFrames.max { $0.midY < $1.midY }
        let sidebar = AgentWindowPolicy.pickSidebar(sidebarCandidates)
        let counts = AgentWindowPolicy.textCounts(frames: textFrames, sidebar: sidebar, inputTop: chatInput?.minY)
        let leftLinks = linkFrames.filter { AgentWindowPolicy.inSidebar($0, sidebar: sidebar) }.count
        let toolbar = AgentWindowPolicy.toolbarLabels(buttons: buttons, input: chatInput)
        let menus = menuBar(appEl)
        let ms = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
        var result: [String: Any] = [
            "running": true, "windows": windowCount, "active": app.isActive, "hidden": app.isHidden,
            "window": ["w": AgentWindowPolicy.int(winW), "h": AgentWindowPolicy.int(winFrame.height), "sheet": sheet, "minimized": minimized],
            "inputs": inputs, "send": send, "stop": stop,
            "new_chat": ["menu": menus.newChat, "buttons": newChatButtons],
            "lists": lists, "left_links": leftLinks,
            "texts": ["total": counts.total, "left": counts.left, "above_input": counts.aboveInput],
            "toolbar": toolbar, "menus": menus.top,
            "visited": visited, "capped": capped, "ms": ms,
            // 这扇窗的结构摘要(2026-10-01):各角色各几个 + 读之前敲过 AXManualAccessibility 没有。
            // 老服务端不认得这两格,多两格无害;新服务端把它写进诊断包(只有数,没有内容)。
            "roles": AgentWindowPolicy.roleHistogram(roleCounts), "ax_manual": true,
        ]
        if let sidebar { result["sidebar"] = AgentWindowPolicy.rectJSON(sidebar) }
        return ["ok": true, "result": result]
    }

    /// 菜单栏:顶上那几项的名字,以及「新对话」一类的那一项(只回这两样 —— 「窗口」菜单里可能列着对话标题,不带)。
    private static func menuBar(_ appEl: AXUIElement) -> (top: [String], newChat: [String]) {
        var barRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &barRef) == .success,
              let bar = barRef, CFGetTypeID(bar) == AXUIElementGetTypeID() else { return ([], []) }
        var top: [String] = []
        var newChat: [String] = []
        for item in children(bar as! AXUIElement).prefix(14) {
            if let title = stringAttr(item, kAXTitleAttribute as String) {
                top.append(AgentWindowPolicy.clip(title, 20))
            }
            for menu in children(item).prefix(2) {
                for entry in children(menu).prefix(40) {
                    if let title = stringAttr(entry, kAXTitleAttribute as String), SendTextPolicy.isNewConversationItem(title),
                       !newChat.contains(title) {
                        newChat.append(title)
                    }
                }
            }
        }
        return (top, newChat)
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
              let list = ref as? [AXUIElement] else { return [] }
        return list
    }

    // MARK: - agent_read:状态、标题、最新一句、侧栏

    /// 只对登记表里**接上了**的那几家(服务端把着)。回:窗口标题、输入框在哪、「停止」键在哪、
    /// 侧栏里一项列表项的名字先押着,等它里面走完再看用不用(见 `AgentWindowPolicy.sideReadInsideRoles`)。
    private struct SideFallback {
        let row: [String: Any]
        let frame: CGRect
        let mark: Int
    }

    /// 对话区**尾巴上**那几块字(从后往前读,读够就停 —— 长对话不从头读到尾)、侧栏在哪、侧栏那几行。
    /// 哪一行是标题、哪一行是最新一句、它在不在跑,由服务端判。
    static func read(bundleId: String) -> [String: Any] {
        let started = CFAbsoluteTimeGetCurrent()
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, windowCount, minimized) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        let winW = winFrame.width
        let winSize = winFrame.size

        // ① 侧栏:从前往后,只看左边那一截(右边整枝不看);先找出侧栏容器的真实边界,再收它里面那几行。
        var sideItems: [(row: [String: Any], frame: CGRect)] = []
        var sidebarCandidates: [CGRect] = []
        var sideVisited = 0
        // 第四格:外面最近那一层列表项 / 键的角色(`in`,服务端据此分会话行与导航、账号区)。
        // 第五格不为空 = 这一格是「那一项里面走完了」的记号:里面一块字都没收到,才拿那一项自己的名字顶上。
        var sideStack: [(AXUIElement, Int, Bool, String?, SideFallback?)] = [(window, 0, false, nil, nil)]
        while let (element, depth, selectedAbove, enclosingAbove, fallback) = sideStack.popLast() {
            if let fallback {
                if sideItems.count == fallback.mark { sideItems.append((row: fallback.row, frame: fallback.frame)) }
                continue
            }
            if sideVisited >= AgentWindowPolicy.sideMaxVisited || sideItems.count >= AgentWindowPolicy.sideMax * 2
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.sideMaxMs { break }
            sideVisited += 1
            guard let n = node(element) else { continue }
            guard let r = n.frame.map({ AgentWindowPolicy.relative($0, to: winFrame) }) else { continue }
            if depth > 0, AgentWindowPolicy.beyondSidebarSearch(r, windowWidth: winW) { continue }
            if SendTextPolicy.inputRoles.contains(n.role) || AgentWindowPolicy.sideSkipRoles.contains(n.role) { continue }
            if AgentWindowPolicy.looksLikeSidebar(r, windowSize: winSize) { sidebarCandidates.append(r) }
            var selected = selectedAbove || n.selected == true
            if !selected, AgentWindowPolicy.sideItemRoles.contains(n.role) {
                // 当前那一条:网页里是 aria-current(辅助功能里叫 AXARIACurrent),原生列表里是 AXSelected。
                if let current = stringAttr(element, "AXARIACurrent"), current != "false" { selected = true }
            }
            let enclosing = AgentWindowPolicy.sideEnclosing(role: n.role, above: enclosingAbove)
            if n.role == kAXStaticTextRole as String {
                if let value = stringAttr(element, kAXValueAttribute as String) ?? n.title {
                    var row: [String: Any] = ["t": AgentWindowPolicy.clip(value, 80)]
                    if selected { row["sel"] = true }
                    if let enclosing { row["in"] = enclosing }
                    row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                    sideItems.append((row: row, frame: r))
                }
                continue
            }
            if AgentWindowPolicy.sideItemRoles.contains(n.role), let label = n.title ?? n.desc {
                var row: [String: Any] = ["t": AgentWindowPolicy.clip(label, 80), "r": n.role]
                if selected { row["sel"] = true }
                row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                if AgentWindowPolicy.sideReadInsideRoles.contains(n.role), !n.children.isEmpty, depth < AgentWindowPolicy.maxDepth {
                    sideStack.append((element, depth, selected, enclosing, SideFallback(row: row, frame: r, mark: sideItems.count)))
                    for child in n.children.reversed() { sideStack.append((child, depth + 1, selected, enclosing, nil)) }
                    continue
                }
                sideItems.append((row: row, frame: r))
                // 链接 / 行自己有名字就不再往里看(里面那块字是同一句)。
                continue
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children.reversed() { sideStack.append((child, depth + 1, selected, enclosing, nil)) }
        }
        let sidebar = AgentWindowPolicy.pickSidebar(sidebarCandidates)
        // 没认出侧栏就一行都不带(不按位置猜)。
        let side = sideItems.filter { AgentWindowPolicy.inSidebar($0.frame, sidebar: sidebar) }.prefix(AgentWindowPolicy.sideMax).map(\.row)

        // ② 从后往前(最后一个孩子先看):输入区在最后,再往前就是对话区从最新往旧。侧栏那一枝整枝不看。尾巴收够就停。
        let tailStarted = CFAbsoluteTimeGetCurrent()
        var input: [String: Int]?
        var stop: [[String: Int]] = []
        var tail: [[String: Any]] = []
        var visited = 0
        var capped = false
        var stack: [(AXUIElement, Int, Bool)] = [(window, 0, false)]
        while let (element, depth, inControl) = stack.popLast() {
            if visited >= AgentWindowPolicy.readMaxVisited
                || (CFAbsoluteTimeGetCurrent() - tailStarted) * 1000 > AgentWindowPolicy.readMaxMs {
                capped = true
                break
            }
            visited += 1
            guard let n = node(element) else { continue }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            if depth > 0, let r = rel, AgentWindowPolicy.inSidebar(r, sidebar: sidebar) { continue }
            if SendTextPolicy.inputRoles.contains(n.role) {
                // 输入框里的字**不读**(可能是他的草稿),只记它在哪。
                if input == nil, let r = rel, r.width >= SendTextPolicy.minInputSize.width { input = AgentWindowPolicy.rectJSON(r) }
                continue
            }
            let isButton = n.role == kAXButtonRole as String || n.role == "AXPopUpButton" || n.role == "AXMenuButton"
            if isButton {
                if SendTextPolicy.looksLikeComposerButton(title: n.title), input == nil, let r = rel {
                    input = AgentWindowPolicy.rectJSON(r)
                    continue
                }
                if SendTextPolicy.looksLikeStopButton(title: n.title, description: n.desc), let r = rel, stop.count < 4 {
                    stop.append(AgentWindowPolicy.rectJSON(r))
                }
            }
            if n.role == kAXStaticTextRole as String {
                if let r = rel, let value = stringAttr(element, kAXValueAttribute as String) ?? n.title {
                    var row: [String: Any] = ["t": AgentWindowPolicy.clip(value, 300)]
                    if inControl { row["ctl"] = true }
                    row.merge(AgentWindowPolicy.rectJSON(r)) { a, _ in a }
                    tail.append(row)
                    if tail.count >= AgentWindowPolicy.tailMax { break }
                }
                continue
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            let control = inControl || isButton || n.role == "AXLink"
            for child in n.children { stack.append((child, depth + 1, control)) }
        }
        // 收的时候是从后往前,回去之前掉个头(按阅读顺序)。
        tail.reverse()

        let title = stringAttr(window, kAXTitleAttribute as String).map { AgentWindowPolicy.clip($0, 120) }
        let ms = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
        var result: [String: Any] = [
            "running": true, "windows": windowCount, "active": app.isActive, "hidden": app.isHidden,
            "window": ["w": AgentWindowPolicy.int(winW), "h": AgentWindowPolicy.int(winFrame.height), "minimized": minimized],
            "stop": stop, "tail": tail, "side": Array(side),
            "visited": visited, "side_visited": sideVisited, "capped": capped, "ms": ms,
        ]
        if let title { result["title"] = title }
        if let input { result["input"] = input }
        if let sidebar { result["sidebar"] = AgentWindowPolicy.rectJSON(sidebar) }
        return ["ok": true, "result": result]
    }

    // MARK: - agent_pick / agent_stop:切到那条对话、按停止键(2026-09-28,卡 WR)

    /**
     **在侧栏里点他点名那条对话**(`agent_pick`)。

     为什么要这一下:窗口型那几家(Manus / 豆包办公 / Muse / Grok Bot / Antigravity)没有
     「开到某一段对话」的深链,而维护者 09-27 点的第二个场景就是「在**停下的已有会话**发信息」——
     要往那条已有的对话里送话,先得切到它。

     **纪律**:
     - 认那一行只认 `AgentWindowPolicy.matchConversationRow`(整行相等,或被截断的那一头是另一头的开头)——
       **不做模糊匹配**:点错一条 = 把他的话打进别的对话里;
     - 两条以上都对得上 → **一条都不点**,如实回 `many`(调用方据此不送);
     - 点之前把那家叫到台前(Electron 那几家在后台时 `AXPress` 与鼠标事件都不作数,同 `TextInsert.frontForSubmit`);
     - 点完再读一次:侧栏里选中的那一条是不是它。读不出选中标记的家就如实回 `selected: false` —— 不假装切成了。
     */
    static func pick(bundleId: String, title: String) -> [String: Any] {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else {
            return ["ok": false, "error": "agent_pick 缺 title"]
        }
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, _, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        let rows = sidebarRows(window: window, winFrame: winFrame)
        var exact: [(AXUIElement, CGRect, String)] = []
        var prefix: [(AXUIElement, CGRect, String)] = []
        for row in rows {
            switch AgentWindowPolicy.matchConversationRow(row: row.text, wanted: title) {
            case .exact: exact.append((row.element, row.frame, row.text))
            case .prefix: prefix.append((row.element, row.frame, row.text))
            case nil: continue
            }
        }
        let hits = exact.isEmpty ? prefix : exact
        if hits.isEmpty {
            return ["ok": true, "result": ["found": false, "rows": rows.count,
                                           "note": "侧栏里没有叫这个名字的一条对话"]]
        }
        if hits.count > 1 {
            return ["ok": true, "result": ["found": false, "many": hits.count,
                                           "note": "侧栏里有 \(hits.count) 行都叫这个名字,一条都没点"]]
        }
        let (element, frame, matched) = hits[0]
        // 后台点不动(同 TextInsert.frontForSubmit 那一条):叫不到台前就**不点**,如实说。
        guard TextInsert.frontForWindowAction(app) else {
            return ["ok": true, "result": ["found": true, "pressed": false, "selected": false,
                                           "note": "叫不到台前,这一下没点(点不动,还可能点到别人窗口上)"]]
        }
        var how = "none"
        if actionNames(element).contains(kAXPressAction as String),
           AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            how = "ax_press"
        } else {
            // 相对坐标换回屏幕坐标,点它正中间。
            let center = CGPoint(x: winFrame.origin.x + frame.midX, y: winFrame.origin.y + frame.midY)
            TextInsert.clickAt(center)
            how = "click"
        }
        wait(ms: 900)
        // 点完核一眼:侧栏里选中的那一条是它。
        let after = sidebarRows(window: window, winFrame: winFrame)
        let selected = after.contains { $0.selected && AgentWindowPolicy.matchConversationRow(row: $0.text, wanted: title) != nil }
        return ["ok": true, "result": ["found": true, "pressed": how != "none", "how": how,
                                       "matched": matched, "selected": selected]]
    }

    /**
     **按那家的停止键**(`agent_stop`,2026-09-28 卡 WR)。他说「打断它 / 先停下」时先走这一下。

     认停止键只认 `SendTextPolicy.looksLikeStopButton`(卡 GB / BB2 那一套,与判「它在不在跑」同一份判据)——
     **认不出就回 `found: false`**,一个键都不按:调用方据此如实说「认不出它的停止键,没敢替你按」。
     按完等一拍再读一次:停止键没了 = 真停下了(`stopped: true`);还在就如实回 `stopped: false`。
     */
    static func stop(bundleId: String) -> [String: Any] {
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, _, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        let buttons = stopButtons(window: window, winFrame: winFrame)
        if buttons.isEmpty {
            return ["ok": true, "result": ["found": false, "note": "这扇窗上认不出「停止」键(它可能已经停下了)"]]
        }
        guard TextInsert.frontForWindowAction(app) else {
            return ["ok": true, "result": ["found": true, "pressed": false, "stopped": false,
                                           "note": "叫不到台前,这一下没按"]]
        }
        let (element, frame) = buttons[0]
        var how = "none"
        if actionNames(element).contains(kAXPressAction as String),
           AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            how = "ax_press"
        } else {
            TextInsert.clickAt(CGPoint(x: winFrame.origin.x + frame.midX, y: winFrame.origin.y + frame.midY))
            how = "click"
        }
        wait(ms: 1200)
        let left = stopButtons(window: window, winFrame: winFrame)
        return ["ok": true, "result": ["found": true, "pressed": how != "none", "how": how,
                                       "stopped": left.isEmpty]]
    }

    /**
     **替他点那家弹的框上的一项**(`agent_press`,2026-09-28 卡 WQ)。

     维护者原话:「它现在几个选项给出来了,给完之后我还不能选,我还得回那个会话窗口回……
     那这个功能的意义就变成了:我告诉你有事,但是我帮你传不了话。」所以这一下是链上第 ④ 环里
     「点它弹的选项」那一格(设计-派活到收回一条链 第二节),与 `send_text` 同一套台前核实。

     **纪律**(比 `agent_pick` 更严,因为点错 = 替他答错一道题,没有撤销):
     - 认那一项只认 `AgentWindowPolicy.matchOptionLabel`(归一化之后**整行相等**,连省略号的便宜都不给);
     - 对得上两处 → **一处都不点**,回 `many`;
     - 只点**按得下去的东西**(AXButton / AXRadioButton / AXCheckBox / AXCell / AXLink / AXMenuItem,
       或者它底下那行字的可按祖先)—— 对话区里只是复述了一遍那几个字的静态文本不算;
     - 点之前把那家叫到台前(同 `TextInsert.frontForWindowAction`:Electron 那几家在后台按了不作数);
     - 点完 **⑤ 核实**:重读一次,那一项还在不在。`gone: false` 时调用方如实说「点了,没看到它收下」,
       **绝不说成已替他答了**。

     **选项收在一颗键后面时先把它点开**(2026-09-28,卡 AQ):真机上 Codex 在对话区里只画了问句 +
     一颗 `Answer question`,四个选项要点开才弹出来 —— 于是这一问「没找到川菜」,手动点开之后同一个
     请求就答进去了。所以找不到那一项时**先找那颗展开键**(`AgentWindowPolicy.looksLikeExpandAsk`
     按形状认,不写死一家的叫法;两颗都像就一颗都不点),**只点一次**,点完重新找选项;
     还是找不到就照旧如实说(回包带 `expanded: true`,免得看日志的人以为压根没试)。
     */
    /// `role`(2026-10-12,演示卡「出图进可灵」):给了就**只认这个角色**的元素 —— 可灵那一页的「生成」键(`AXButton`)
    /// 与左侧导航里同名的「生成」(`AXLink`)两处都叫这个名字,不给角色就是「两处都像、一处都不点」。缺席 = 老行为。
    static func press(bundleId: String, label: String, options: [String] = [], role: String? = nil) -> [String: Any] {
        guard !label.trimmingCharacters(in: .whitespaces).isEmpty else {
            return ["ok": false, "error": "agent_press 缺 label"]
        }
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, _, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        /*
         * ★ **先叫到台前,再找那一项**(2026-09-28 21:1x 维护者真机):手机上点的时候 Codex 不在前台,
         * 它在后台不把那个选项框露给辅助功能 —— 于是「框不在了」,其实东西还在;电脑上点时它本来就在前面,
         * 所以点得进。找之前先叫到台前、等它把那一层画出来。叫不到台前照旧往下找(找不着就如实说)。
         */
        if TextInsert.frontForWindowAction(app) { wait(ms: 500) }
        var hits = optionItems(window: window, winFrame: winFrame, label: label, options: options, role: role)
        /// 选项收在一颗键后面(Codex 的 `Answer question`):点开它一次,再找一遍。
        var expanded = false
        if hits.isEmpty {
            let openers = expandButtons(window: window, winFrame: winFrame)
            // 认不出 / 两颗都像 → 一颗都不点(在她窗口里乱按一颗键比「没答上」坏得多)。
            if openers.count == 1, TextInsert.frontForWindowAction(app) {
                let (opener, frame) = openers[0]
                if actionNames(opener).contains(kAXPressAction as String),
                   AXUIElementPerformAction(opener, kAXPressAction as CFString) == .success {
                    expanded = true
                } else {
                    TextInsert.clickAt(CGPoint(x: winFrame.origin.x + frame.midX, y: winFrame.origin.y + frame.midY))
                    expanded = true
                }
                if expanded {
                    // 点开之后那一片要重画:**轮询**到 `pressConfirmTotalMs`,找着就走
                    // (2026-10-13 卡 SC:等 1200ms 找一次,画得慢的那一家就成了「点开了还是没找着」)。
                    for step in SendTextPolicy.confirmSteps(totalMs: AgentWindowPolicy.pressConfirmTotalMs) {
                        wait(ms: step)
                        hits = optionItems(window: window, winFrame: winFrame, label: label, options: options, role: role)
                        if !hits.isEmpty { break }
                    }
                }
            }
        }
        if hits.isEmpty {
            return ["ok": true, "result": ["found": false, "expanded": expanded,
                                           "note": expanded
                                               ? "点开了它那颗「展开这一问」的键,还是没找到「\(AgentWindowPolicy.clip(label, 40))」这一项"
                                               : "它窗口里没找到「\(AgentWindowPolicy.clip(label, 40))」这一项(那个框可能已经不在了)"]]
        }
        if hits.count > 1 {
            return ["ok": true, "result": ["found": false, "many": hits.count, "expanded": expanded,
                                           "note": "它窗口里有 \(hits.count) 处都叫这个名字,一处都没点"]]
        }
        guard TextInsert.frontForWindowAction(app) else {
            return ["ok": true, "result": ["found": true, "pressed": false, "gone": false,
                                           "note": "叫不到台前,这一下没点(点不动,还可能点到别人窗口上)"]]
        }
        /// 点**之前**窗口里提到这一项的那几行(卡 SC 第二档的底子:点上了会冒出**新的**一行)。
        let needle = AgentWindowPolicy.pressNeedle(label)
        let mentionsBefore = needle.map { mentionLines(window: window, needle: $0) } ?? []
        let (element, frame) = hits[0]
        var how = "none"
        if actionNames(element).contains(kAXPressAction as String),
           AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            how = "ax_press"
        } else {
            TextInsert.clickAt(CGPoint(x: winFrame.origin.x + frame.midX, y: winFrame.origin.y + frame.midY))
            how = "click"
        }
        /*
         * ⑤ 核实(2026-10-13,卡 SC):**轮询**到 `pressConfirmTotalMs`,那一项不见了就算点上了;
         * 到点还在,再看对话区冒出**新的**一行提到这一项没有(豆包的「收到:果汁」)。
         * 老代码点完等 1200ms 重读一次就下结论 —— 她 11:40 在电话里答的那个「果汁」就是这么被说成「没确认」的
         * (壳回「没点上」、工人把这句原话念给她,而豆包窗口里随后就是「收到:果汁」)。
         */
        var waited = 0
        var itemGone = false
        for step in SendTextPolicy.confirmSteps(totalMs: AgentWindowPolicy.pressConfirmTotalMs) {
            wait(ms: step)
            waited += step
            if optionItems(window: window, winFrame: winFrame, label: label, options: options, role: role).isEmpty {
                itemGone = true
                break
            }
        }
        let mentionsAfter: [String] = {
            guard !itemGone, let needle else { return [] }
            return mentionLines(window: window, needle: needle)
        }()
        let proof = AgentWindowPolicy.pressProof(itemGone: itemGone,
                                                 mentionsBefore: mentionsBefore, mentionsAfter: mentionsAfter)
        return ["ok": true, "result": ["found": true, "pressed": how != "none", "how": how,
                                       "expanded": expanded, "gone": proof != nil,
                                       // 哪一档核出来的、等了多久。**只进日志** —— 8791 那边照旧只看 `gone`。
                                       "confirmed_by": proof?.rawValue ?? "none", "waited_ms": waited]]
    }

    /// 窗口里**提到这一截字**的那几行(点完之后比「冒出了新的一行没有」用,2026-10-13 卡 SC)。
    /// 走法与上限同找那个提问面板那一趟;行数封顶(够比就行,不是把窗口读出去)。
    private static func mentionLines(window: AXUIElement, needle: String, limit: Int = 24) -> [String] {
        var out: [String] = []
        var visited = 0
        let started = CFAbsoluteTimeGetCurrent()
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= AgentWindowPolicy.askScanMaxVisited || out.count >= limit
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.askScanMaxMs { break }
            visited += 1
            guard let n = node(element) else { continue }
            let texts = [n.title, n.desc, stringAttr(element, kAXValueAttribute as String)].compactMap { $0 }
            for text in texts where AgentWindowPolicy.textMentions(text, needle) {
                let row = AgentWindowPolicy.clip(text, 200)
                if !out.contains(row) { out.append(row) }
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { stack.append((child, depth + 1)) }
        }
        return out
    }

    // MARK: - quota_page:在后台把那家翻到额度那一页,不抢焦点(2026-10-03,卡 QP)

    /**
     **在后台替她把那家翻到额度那一页**(`quota_page`,2026-10-03 卡 QP)。

     ## 为什么非得是一条新 op

     卡 QZ(`docs/交接-1003-额度自己读到.md`)把自动读额度那一轮接回来了,**唯独没闭合按键那半边**:
     今天 `agent_press` 点之前必须 `TextInsert.frontForWindowAction` 把那家叫到台前(Electron 那几家
     在后台按了不作数)—— 那就是抢她的焦点,与「她一个字都不用操作、也不被打扰」直接冲突。
     于是她把豆包停在聊天页上时,自动那一轮仍旧读不到额度(格子摆上次那个数)。

     这一条就是那半边:**只走 `AXUIElementPerformAction(kAXPressAction)`,一次鼠标点击都不合成**。
     合成点击(`TextInsert.clickAt` 那条路)才非得要台前 —— 坐标点下去,前面盖着谁就点在谁身上。
     AXPress 是把「按下」直接交给那个元素,不经过屏幕,所以**后台也按得动**:这是整条 op 的全部理由,
     也是 `press` / `pick` / `stop` 那几条里的 `clickAt` 兜底在这里**一行都不许有**的原因。

     ## 纪律(与 `agent_press` 同一套,只少了台前那一下)

     - 认那颗键**复用 `optionItems` + `AgentWindowPolicy.matchOptionLabel`**,不另写一套识别
       (归一化之后整行相等;认不准 / 两处都像 → 一处都不按);
     - 藏着的那一家 `unhide()` 放出来 —— **不 `activate`**(不叫台前、不抢焦点),
       放出来之后等一拍让 AX 的窗口清单跟上(同 `TextInsert.readTexts` 的那笔预算),
       **每一条返回路径**都照原样藏回去(`defer` + `SendTextPolicy.shouldRehide`:
       读的这一两秒里她自己点了它就不藏);
     - **每一扇窗都找一遍**(同 `readTexts` 不给 `index` 那一支):额度那一页的入口常常在设置那扇窗上,
       写死主窗就是掷骰子(卡 MQ 的老教训);
     - 按不动(`AXPress` 不在它的动作里)/ 认不出 → 如实回 `pressed: false` + 一句原因,
       **不重试、不退回合成点击**。「按了到没到那一页」这里一个字都不判 ——
       那由插件紧接着的 `read_texts` 核(壳不下判断,这个文件的老规矩)。

     ## ★ 2026-10-03(卡 QT):**一串键要在同一次放出来里按完**

     卡 QP 那一版一条 op 只按一颗键,插件要按两颗就发两条 op。真机上量到这条路对**弹出式菜单
     走不通**:豆包办公那颗通向额度页的键是侧栏最底下的 `AXPopUpButton`,按下去弹出一张菜单,
     「订阅与额度管理」在那张菜单里 —— 而这条 op 每次返回前都把那家**照原样藏回去**
     (`defer`),菜单跟着收了。第二条 op 再放出来时,那张菜单压根不在树上。

     所以这条 op 收的是**一串** `labels`:一次 `unhide` → 挨个认、挨个 `AXPress`、每按一下
     等一拍让树跟上 → 一次藏回去。中间任何一颗认不出 / 按不动就停在那儿,如实回
     「按到第几颗、哪一颗卡住了」(`pressed_count` / `stuck`),后面那几颗不按。
     `label`(单颗)照旧认 —— 老插件一个字都不用改。

     ## ★ 2026-10-03(卡「豆包闪一下」):`front: true` —— **叫到台前按一下,按完立刻还回去**

     **缺省 `false`:上面那一整段一个字都不变**(不 activate、不抢焦点)。

     为什么要给它开这一格:豆包办公那颗键按下去弹的是 **Chromium 交给系统画的原生弹出菜单**,
     而原生菜单**要那家在台前才跟踪得住** —— 卡 QT 真机量到后台 `AXPress` 回 success、
     整扇窗的树却一个字没变(visited 388 → 388)、应用元素底下也没多出 `AXMenu`。
     也就是说这一家不是「我们认不出那颗键」,是**不在台前那张菜单压根不存在**。

     维护者 2026-10-03 21:4x 拍板(原话「行,处理吧」):**只在那一格真坏了的时候**
     (过了那条 2 小时线)闪一下换一个真数,读完立刻恢复原样,一家 90 分钟最多一次。
     「只在真坏了的时候」与「90 分钟最多一次」两道门都在**插件**那一侧
     (`agentQuota.ts` 的 `reachPage`:`worthUnhiding` + `QUOTA_FRONT_GAP_MS`)——
     壳这一侧只做插件明着要的那一下,一个判断都不自己下(这个文件的老规矩)。

     恢复那两样(**每一条返回路径都要**,所以都在 `defer` 里,顺序不能倒):

     1. **先把台前还给原来那一家**(进来时 `NSWorkspace.frontmostApplication` 是谁就还给谁);
     2. **再按原样藏回去**(`AgentWindowPolicy.shouldRehideAfterFlash`)。倒过来做就是对着
        「它还在台前」问要不要藏 —— 永远不藏,她眼前就留着一扇刚闪过的窗。

     ## ★ 2026-10-04(卡「豆包台前点一下」):`click: true` —— **台前对第一颗键合成一次点击**

     **缺省 `false`:后台那一支里 `clickAt` 照旧一行都没有**(用例按源码钉着:整段只有一处
     `clickAt`,而它前面一行就是 `AgentWindowPolicy.clicksThisStep(`)。

     为什么要给它开这一格:卡「豆包闪一下」把豆包叫到台前、`AXPress` 那颗「标准套餐」——
     回 success,而 `menu_roots: 0`(应用元素底下一棵不是窗的树都没有)。也就是说那张原生菜单
     **AXPress 压根没把它弹开**,不是「弹开了但不进树」。她自己点得开,所以剩下唯一可能通的
     一条就是**照她那样点一下**。维护者 2026-10-04 拍板(「可以」),配三样:

     1. **只在 `front_got == true` 之后点**(`AgentWindowPolicy.clicksThisStep` 的第 3 条)——
        叫不到台前就一下都不点:那一下会点在盖在上面的那扇窗上(她正用着的那个);
     2. **点之前现取一次那颗键的矩形**(`node(element)?.frame`,AX 的位置是整屏坐标)——
        认那颗键走的是整棵树,走完到点下去之间它可能已经滚走了;取不到 / 空矩形就不点,如实说;
     3. **点完照旧按 AX 认下一颗**(`step == 0` 那一条):菜单里那颗「订阅与额度管理」认得出才按。
     */
    static func quotaPage(bundleId: String, labels: [String], front: Bool = false, click: Bool = false) -> [String: Any] {
        let chain = labels.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !chain.isEmpty else { return ["ok": false, "error": "quota_page 缺 label"] }
        // 门与读额度那一侧同一道(`readTexts`):读得了它的窗,才按得了它的键。
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": SendTextPolicy.Failure.notAllowed(bundleId: bundleId).message]
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": SendTextPolicy.Failure.notRunning(bundleId: bundleId).message]
        }
        // 先敲门(Chromium 系不建树就什么都找不到);一处写、处处用,见 AXWake。
        let appEl = AXWake.app(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        /// 本来藏着就放出来 —— **只 unhide,不 activate**。读完原样藏回去,所以用 `defer`:
        /// 下面有五六条 return,漏一条就把她的 App 永远留在外面了(同 `readTexts` 那条纪律)。
        let wasHidden = app.isHidden
        if wasHidden { app.unhide() }
        /*
         * ★ 只有插件明着要「闪一下」(`front: true`)才碰台前(见上面那一段):进来时台前是谁
         * 先记下来,**每一条返回路径**都先把台前还给它、再按原样藏回去。
         * 缺省那一支(`front == false`)这两行一个都不跑 —— 行为与卡 QT 那一版一字不差。
         */
        let frontBefore = front ? NSWorkspace.shared.frontmostApplication : nil
        let fronted = front ? TextInsert.frontForWindowAction(app) : false
        defer {
            if front {
                // ① 先把台前还给原来那一家(还不回去也照实往下走:下面那一格据此就不藏)。
                frontBefore?.activate(options: [.activateAllWindows])
                wait(ms: AgentWindowPolicy.frontFlashBackMs)
                // ② 再按原样藏回去。判据是**系统现问现答的台前**,不是 KVO 那格 `isActive`。
                if AgentWindowPolicy.shouldRehideAfterFlash(
                    wasHidden: wasHidden,
                    frontNow: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
                    bundleId: bundleId) { app.hide() }
            } else if SendTextPolicy.shouldRehide(wasHidden: wasHidden, isActive: app.isActive) { app.hide() }
        }
        var windows: [AXUIElement] = []
        var err: AXError = .success
        var looks = 0
        repeat {
            // 刚放出来那一下 AX 清单还没跟上(卡 MQ2 实测一两秒);没放出过谁就一眼都不等。
            if wasHidden { wait(ms: SendTextPolicy.unhideWaitMs) }
            var ref: CFTypeRef?
            err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &ref)
            if err != .success { break }
            windows = (ref as? [AXUIElement]) ?? []
            looks += 1
        } while wasHidden && SendTextPolicy.worthAnotherUnhideLook(windows: windows.count, looks: looks)
        /// 「本来藏着、这一下是工作台放出来又藏回去的」记号,只给排障看(同 `readTexts` 的 `app_unhidden`)。
        let unhidden: [String: Any] = wasHidden ? ["app_unhidden": true] : [:]
        func fail(_ message: String) -> [String: Any] {
            var out: [String: Any] = ["ok": false, "error": message]
            out.merge(unhidden) { a, _ in a }
            return out
        }
        if err != .success {
            return fail(SendTextPolicy.Failure.axDisabled(bundleId: bundleId, err: err.rawValue).message)
        }
        guard !windows.isEmpty else {
            return fail(SendTextPolicy.Failure.noWindow(bundleId: bundleId).message)
        }
        /// 这一颗键在**每一扇窗**上认出来的那几处(认那颗键的那套识别一个字都不另写,见 `optionHits`)。
        ///
        /// 毫秒那笔预算是**几扇窗合起来**的(`navMaxMs`):一扇一扇往下传剩下多少,
        /// 用完就停在那一扇、如实回 `capped`(不让一棵大树把插件那 8 秒耗光)。
        /// 一串键的时候**整串合用这一份预算**(按完一颗要重新走一遍树 —— 菜单弹出来了,树变了)。
        var visited = 0
        var capped = false
        let scanStarted = CFAbsoluteTimeGetCurrent()
        /**
         ★ **这一趟要走的几棵树**(2026-10-03,卡「豆包闪一下」)。

         缺省就是**每一扇窗**(与卡 QT 那一版一字不差)。只有**闪到台前**那一支多走一层:
         **应用元素底下那几个不是窗的孩子** —— 弹出式原生菜单在 macOS 上就挂在那儿(角色 `AXMenu`),
         `AXWindows` 里压根没有它。豆包那颗「<账号名> 标准套餐」按下去弹的正是这一种
         (卡 QT 真机:按完整扇窗的树一个字没变 → 那张菜单不在窗口清单里)。

         为什么只在台前那一支多走:**原生菜单要那家在台前才存在**(后台按下去压根不弹,卡 QT 量过)——
         背景那一趟多走一层只会多花几毫秒、还可能把菜单栏那一层的同名项收进来(`many` → 一处都不按)。
         菜单栏(`AXMenuBar`)与窗口这两种角色照旧**排掉**:前者是「文件 / 编辑」那一条,
         它的亮灰跟着台前变,不是我们要按的那张弹出菜单。
         */
        func scanRoots() -> [(element: AXUIElement, window: Int)] {
            var roots: [(element: AXUIElement, window: Int)] = windows.enumerated().map {
                (element: $0.element, window: $0.offset)
            }
            guard front else { return roots }
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appEl, kAXChildrenAttribute as CFString, &ref) == .success,
                  let kids = ref as? [AXUIElement] else { return roots }
            for kid in kids where !windows.contains(where: { CFEqual($0, kid) }) {
                let role = stringAttr(kid, kAXRoleAttribute as String) ?? ""
                if role == kAXWindowRole as String || role == kAXMenuBarRole as String { continue }
                // `window: -1` = 它不在窗口清单里(就是弹出来那张菜单);回包里也这么说。
                roots.append((element: kid, window: -1))
            }
            return roots
        }
        func hitsFor(_ wantedOne: String) -> [(element: AXUIElement, window: Int)] {
            var hits: [(element: AXUIElement, window: Int)] = []
            for (window, at) in scanRoots() {
                let spentMs = (CFAbsoluteTimeGetCurrent() - scanStarted) * 1000
                guard spentMs < AgentWindowPolicy.navMaxMs, visited < AgentWindowPolicy.navMaxVisited else {
                    capped = true
                    break
                }
                AXUIElementSetMessagingTimeout(window, 0.5)
                let winFrame = node(window)?.frame ?? .zero
                let found = optionHits(window: window, winFrame: winFrame, label: wantedOne,
                                       maxVisited: AgentWindowPolicy.navMaxVisited - visited,
                                       maxMs: AgentWindowPolicy.navMaxMs - spentMs,
                                       // 翻页这一条路多认一档「键里面那几截静态字」(卡 QT,见 `optionHits` 上面那段)。
                                       alsoInnerText: true)
                visited += found.visited
                if found.capped { capped = true }
                for (element, _) in found.items { hits.append((element, at)) }
            }
            return hits
        }
        var result: [String: Any] = ["windows": windows.count, "hidden": app.isHidden, "active": app.isActive]
        result.merge(unhidden) { a, _ in a }
        if front {
            // 这几格只为排障与插件记日志用(「闪了一下谁、从谁手里闪的、闪成没有」)。
            result["front_asked"] = true
            result["front_got"] = fronted
            result["front_previous"] = frontBefore?.bundleIdentifier ?? ""
            // 「这一轮插件要不要那一下合成点击」也回一格,排障时分得清「没点」与「点了没用」。
            result["click_asked"] = click
            /*
             * 叫不到台前就**一颗都不按**:要台前才弹的那张菜单这会儿压根不存在,按下去等于
             * 白按一下她的 App(D13:不走一个办不到的步骤)。上面那个 `defer` 照旧把两样恢复原样。
             */
            if !fronted {
                result["found"] = false
                result["pressed"] = false
                result["note"] = "没能把它叫到台前(这几颗键非台前不可:它那张菜单是系统画的原生菜单,后台弹不出来),这一轮一颗都没按"
                return ["ok": true, "result": result]
            }
        }
        /// 按到第几颗了(一串键的时候插件照这一格记日志:停在哪一颗上)。
        var pressedCount = 0
        for (step, wantedOne) in chain.enumerated() {
            if step > 0 {
                // 上一颗按下去之后要等一拍:弹出来的那张菜单得先进树,才认得出下一颗
                // (同 `press` 按完等一拍的节奏;Chromium 那几家换一片界面要渲一拍)。
                wait(ms: SendTextPolicy.unhideWaitMs)
                // 菜单有可能是**另一扇窗**(有的 App 把弹层做成独立的 AX 窗口):重新取一次清单。
                var againRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &againRef) == .success,
                   let again = againRef as? [AXUIElement], !again.isEmpty {
                    windows = again
                    result["windows"] = windows.count
                }
            }
            let clipped = AgentWindowPolicy.clip(wantedOne, 40)
            let hits = hitsFor(wantedOne)
            result["visited"] = visited
            result["capped"] = capped
            result["pressed_count"] = pressedCount
            /*
             * 闪到台前那一支多回一格:**这一刻应用元素底下有几棵不是窗的树**
             * (= 上一颗按出来的那张原生菜单在不在 AX 树上)。
             * 「菜单压根没弹出来」与「弹出来了但认不出那颗键」是两件事,不许混成一句
             * (同 `capped` 那条纪律)。壳照旧一个字都不判,这只是回一个数。
             */
            if front { result["menu_roots"] = scanRoots().filter { $0.window < 0 }.count }
            if hits.isEmpty {
                result["found"] = step > 0
                result["pressed"] = pressedCount > 0
                result["stuck"] = clipped
                // 「没走到」与「它没这颗键」是两件事(`capped`),不许混成一句。
                result["note"] = capped
                    ? "走到预算用完还没在它窗口里找到「\(clipped)」这颗键(这棵树太大 / 这会儿它很慢,不是认定它没有)"
                    : "它这几扇窗上认不出「\(clipped)」这颗键(那一页的入口可能换了名字,或者这会儿压根不在树上)"
                return ["ok": true, "result": result]
            }
            if hits.count > 1 {
                result["found"] = step > 0
                result["pressed"] = pressedCount > 0
                result["many"] = hits.count
                result["stuck"] = clipped
                result["note"] = "它窗口里有 \(hits.count) 处都叫「\(clipped)」,一处都没按"
                return ["ok": true, "result": result]
            }
            result["found"] = true
            result["window"] = hits[0].window
            let element = hits[0].element
            /*
             * ★ **台前那一下合成点击**(2026-10-04 卡「豆包台前点一下」,见上面那一段)。
             * 四条都成立才走到这里(插件要了 + 闪台前那一支 + 台前真叫到了 + 第一颗键),
             * 判据是纯函数 `AgentWindowPolicy.clicksThisStep`(有用例)—— 壳这一处一条判断都不自己下。
             * 点之前**现取一次矩形**:认那颗键走的是整棵树,走完到点下去之间它可能已经滚走了。
             */
            if AgentWindowPolicy.clicksThisStep(click: click, front: front, fronted: fronted, step: step) {
                guard let fresh = node(element)?.frame, fresh.width > 0, fresh.height > 0 else {
                    result["pressed"] = pressedCount > 0
                    result["stuck"] = clipped
                    result["note"] = "认出「\(clipped)」这颗键了,可点之前再取它的矩形取不到(或者是个空矩形)—— 没按坐标点下去(那一下会点在不知道什么东西上)"
                    return ["ok": true, "result": result]
                }
                result["click_rect"] = ["x": Int(fresh.origin.x), "y": Int(fresh.origin.y),
                                        "w": Int(fresh.width), "h": Int(fresh.height)]
                TextInsert.clickAt(CGPoint(x: fresh.midX, y: fresh.midY))
                result["how"] = "front_click"
                pressedCount += 1
                result["pressed"] = true
                result["pressed_count"] = pressedCount
                continue
            }
            /*
             * ★ **只走 AXPress,绝不合成鼠标点击**(这条 op 的全部理由,见文件头那一段)。
             * 按不下去就如实说「按不动」——**不**退回 `TextInsert.clickAt`:那一下要么点在盖在上面的
             * 那扇窗上(她正用着的那个),要么非得先把她的窗叫到台前,两样都是这张卡要治的病。
             */
            guard actionNames(element).contains(kAXPressAction as String) else {
                result["pressed"] = pressedCount > 0
                result["stuck"] = clipped
                result["note"] = "认出「\(clipped)」这颗键了,可它按不下去(AXPress 不在它的动作里)。没替它合成鼠标点击 —— 那非得先把她的窗叫到台前"
                return ["ok": true, "result": result]
            }
            let pressErr = AXUIElementPerformAction(element, kAXPressAction as CFString)
            result["how"] = "ax_press"
            guard pressErr == .success else {
                result["pressed"] = pressedCount > 0
                result["stuck"] = clipped
                result["ax_err"] = Int(pressErr.rawValue)
                result["note"] = "按「\(clipped)」这一下它没接住(AXPress 回 \(pressErr.rawValue))"
                return ["ok": true, "result": result]
            }
            pressedCount += 1
            result["pressed"] = true
            result["pressed_count"] = pressedCount
        }
        result["visited"] = visited
        result["capped"] = capped
        return ["ok": true, "result": result]
    }

    /**
     **把她自己那句话写进那家提问面板里的自由作答框、按下面板自己那颗发送键**
     (`agent_write_ask`,2026-09-28 卡 AT)。

     维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
     卡 WQ / AQ 做到的是「替她点框上那一项」;她在手机 / 电脑「等你确认」里**打了一句自己的话**
     (或者电话里说了不在选项里的一句)时,从前只能如实说「要自己说一句,得在电脑上…」。这一下补上那半件。

     **纪律**(比 `press` 还严 —— 写错地方 = 把她的话当成新一轮指令发进她正在跑的会话里):
     - `marks` 是那一问的选项原话 + 问句原话(服务端给);**先得靠它们认出那个面板**
       (容器里既有这几截字、又有输入框:`AgentWindowPolicy.enoughForAskPanel`),
       几个都够格的取**最小**那个(`pickAskPanel`);找不着面板 → 照卡 AQ 点开那颗展开键**一次**再找;
     - 框与那颗发送键**只认面板里的**,而且都在窗口底部主输入框那道红线以上
       (`pickAskField` / `pickAskSend`);**两处都像、或者哪一处认不出 → 一处都不动**,如实说;
     - 两样都挑定了才叫台前、才动手(写字用 AX 赋值或剪贴板粘贴,粘完把她的剪贴板还回去);
     - 按完发送 **⑤ 核实**两条:那个面板没了(`gone`)+ 窗口里出现了她那句话的开头(`echoed`)。
       服务端只在两条都成立时才说「已替你答了」。
     */
    static func writeAsk(bundleId: String, text: String, marks: [String]) -> [String: Any] {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return ["ok": false, "error": "agent_write_ask 缺 text"] }
        let wanted = marks.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !wanted.isEmpty else {
            return ["ok": false, "error": "agent_write_ask 缺 marks(认那个面板要靠那一问的选项 / 问句原话)"]
        }
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, _, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        var scan = askScan(window: window, winFrame: winFrame, marks: wanted)
        /// 面板收在一颗键后面(Codex 的 `Answer question`):照卡 AQ 点开它**一次**,再找一遍。
        var expanded = false
        if scan.panels.isEmpty {
            let openers = expandButtons(window: window, winFrame: winFrame)
            if openers.count == 1, TextInsert.frontForWindowAction(app) {
                let (opener, frame) = openers[0]
                if !(actionNames(opener).contains(kAXPressAction as String)
                    && AXUIElementPerformAction(opener, kAXPressAction as CFString) == .success) {
                    TextInsert.clickAt(CGPoint(x: winFrame.origin.x + frame.midX, y: winFrame.origin.y + frame.midY))
                }
                expanded = true
                // 同 `press`:点开之后那一片要重画,轮询到找着那个面板(卡 SC)。
                for step in SendTextPolicy.confirmSteps(totalMs: AgentWindowPolicy.pressConfirmTotalMs) {
                    wait(ms: step)
                    scan = askScan(window: window, winFrame: winFrame, marks: wanted)
                    if !scan.panels.isEmpty { break }
                }
            }
        }
        /// 窗口底部那个主输入框(**红线**):最靠下的那个输入框。读不到就不给,面板那道门照旧拦着。
        /// (挑面板就要用到它 —— 「这个容器里认不认得出框与发送键」是挑面板的条件之一,见 `pickAskPanelIndex`。)
        let mainInput = scan.inputs.map { $0.field.frame }.max { a, b in a.midY < b.midY }
        let shapes = scan.panels.map {
            AgentWindowPolicy.AskPanelShape(rect: $0.rect, fields: $0.fields.map { $0.field }, sends: $0.sends.map { $0.button })
        }
        guard let panelIndex = AgentWindowPolicy.pickAskPanelIndex(shapes, mainInput: mainInput) else {
            return ["ok": true, "result": ["found": false, "expanded": expanded,
                                           "note": expanded
                                               ? "点开了它那颗「展开这一问」的键,还是没找着那个能打字的提问面板"
                                               : "它窗口里没找着那个能打字的提问面板(那个框可能已经不在了)"]]
        }
        let panel = scan.panels[panelIndex]
        let fieldPick = AgentWindowPolicy.pickAskField(panel.fields.map { $0.field }, panel: panel.rect, mainInput: mainInput)
        let sendPick = AgentWindowPolicy.pickAskSend(panel.sends.map { $0.button }, panel: panel.rect, mainInput: mainInput)
        guard case let .one(fieldIndex, fieldWhy) = fieldPick else {
            return ["ok": true, "result": ["found": false, "expanded": expanded, "note": askPickWhy(fieldPick)]]
        }
        guard case let .one(sendIndex, sendWhy) = sendPick else {
            return ["ok": true, "result": ["found": false, "expanded": expanded, "note": askPickWhy(sendPick)]]
        }
        let field = panel.fields[fieldIndex]
        let send = panel.sends[sendIndex]
        // 挑的那个框万一正是主输入框本人(元素这一层再核一次:几何那一层已经拦过)—— 一个字都不写。
        if let main = scan.inputs.first(where: { CFEqual($0.element, field.element) }), main.field.frame == mainInput {
            return ["ok": true, "result": ["found": false, "expanded": expanded,
                                           "note": "认出来的那个框就是窗口底部的主输入框,一个字都没写"]]
        }
        guard TextInsert.frontForWindowAction(app) else {
            return ["ok": true, "result": ["found": true, "wrote": false, "submitted": false, "gone": false, "echoed": false,
                                           "note": "叫不到台前,这一句没写(写不进去,还可能写到别人窗口里)"]]
        }
        let screenFrame = CGRect(x: winFrame.origin.x + field.field.frame.origin.x,
                                 y: winFrame.origin.y + field.field.frame.origin.y,
                                 width: field.field.frame.width, height: field.field.frame.height)
        let wrote = TextInsert.writeInto(element: field.element, frame: screenFrame, app: app, text: said)
        if !wrote.ok {
            return ["ok": true, "result": ["found": true, "wrote": false, "submitted": false, "gone": false, "echoed": false,
                                           "how": wrote.how.rawValue, "clipboard_restored": wrote.clipboardRestored,
                                           "field_why": fieldWhy,
                                           "note": "没能把这一句写进它那个框(框里读回来的不是这句)"]]
        }
        var submitted = false
        if actionNames(send.element).contains(kAXPressAction as String),
           AXUIElementPerformAction(send.element, kAXPressAction as CFString) == .success {
            submitted = true
        } else {
            TextInsert.clickAt(CGPoint(x: winFrame.origin.x + send.button.frame.midX,
                                       y: winFrame.origin.y + send.button.frame.midY))
            submitted = true
        }
        /*
         * ⑤ 核实两条:那个面板没了 + 窗口里出现了她那句话的开头。
         * **面板那一条轮询**到 `pressConfirmTotalMs`(2026-10-13 卡 SC:老代码等 1200ms 读一次就下结论,
         * 而 Electron 那几家把面板收掉比这慢 —— 送话与替她点那两条路都这么误报过)。
         */
        var waited = 0
        var gone = false
        for step in SendTextPolicy.confirmSteps(totalMs: AgentWindowPolicy.pressConfirmTotalMs) {
            wait(ms: step)
            waited += step
            if askScan(window: window, winFrame: winFrame, marks: wanted).panels.isEmpty {
                gone = true
                break
            }
        }
        // 太短的一句(「行」)认不准,`answerNeedle` 回 nil —— 那种只靠「那个面板没了」说话。
        let echoed = AgentWindowPolicy.answerNeedle(said).map { seesText(window: window, needle: $0) } ?? false
        return ["ok": true, "result": ["found": true, "wrote": true, "submitted": submitted,
                                       "how": wrote.how.rawValue, "clipboard_restored": wrote.clipboardRestored,
                                       "expanded": expanded, "gone": gone, "echoed": echoed,
                                       "waited_ms": waited,
                                       "field_why": fieldWhy, "send_why": sendWhy]]
    }

    // MARK: - agent_approval:替她批准(2026-10-01,卡 AP)

    private struct ApprovalKey {
        let element: AXUIElement
        let label: String
        let frame: CGRect
    }

    private struct ApprovalPanel {
        let rect: CGRect
        let keys: [ApprovalKey]
    }

    /**
     **替她看 / 按那家的批准弹窗**(`agent_approval`,2026-10-01 卡 AP「手机替她批准」)。

     维护者 10-01 午饭在外面(走中转):修手机横屏那条 Claude 会话在等批准,手机「待确认」里打了字,
     两次都「发不出去」——打字批不了一个权限弹窗。这一下补上:读出弹窗上**真实的那几颗键**给她按。

     **认「这条会话的那个弹窗」只靠 `marks`**(这一步自己的原话:命令 / 说明,服务端给)。Claude 桌面上
     可能同时有几条会话、几个子任务的弹窗 —— 一块容器底下**既有那截原话、又有几颗键**才够格
     (`AgentWindowPolicy.approvalMarkHit` / `approvalPanelWorthy`);挑哪一块、哪几颗键算「批准 / 拒绝」
     **由服务端定**(`approvalKeys.ts`),壳不认一家的叫法。

     - 不带 `press`:只读。回够格的那几块(相对窗口左上角的位置 + 键名,重名照列),一个键都不按;
     - 带 `press` + `panel`:重新扫一遍,**只在位置对得上的那一块里**找这个名字的键(`sameRect` / `sameKeyLabel`),
       恰好一颗才按;按之前叫到台前;按完 **⑤ 核实**:再扫一遍,还有没有含那截原话、又有这颗键的一块 ——
       没了才 `gone: true`。认不准 / 两颗都像 → 一颗都不按,如实说。
     */
    static func approval(bundleId: String, marks: [String], press: String?, panel: CGRect?) -> [String: Any] {
        let wanted = marks.filter { AgentWindowPolicy.approvalNeedle($0) != nil }
        guard !wanted.isEmpty else {
            return ["ok": false, "error": "agent_approval 缺 marks(认那个弹窗要靠这一步自己的原话,不到 4 个字的不算)"]
        }
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, _, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        func rectJSON(_ r: CGRect) -> [String: Any] {
            ["x": AgentWindowPolicy.int(r.minX), "y": AgentWindowPolicy.int(r.minY),
             "w": AgentWindowPolicy.int(r.width), "h": AgentWindowPolicy.int(r.height)]
        }
        let panels = approvalScan(window: window, winFrame: winFrame, marks: wanted)
        guard let label = press?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else {
            let out = panels.prefix(12).map { one -> [String: Any] in
                ["rect": rectJSON(one.rect), "keys": one.keys.map(\.label)]
            }
            return ["ok": true, "result": ["found": !out.isEmpty, "panels": out]]
        }
        guard let target = panel else {
            return ["ok": false, "error": "agent_approval 按键要带 panel(读的时候认准的那一块)"]
        }
        guard let mine = panels.first(where: { AgentWindowPolicy.sameRect($0.rect, target) }) else {
            return ["ok": true, "result": ["found": false,
                                           "note": "读的时候认准的那个弹窗这会儿不在原处了(可能已经答掉、或者又来了一个),一颗键都没按"]]
        }
        let hits = mine.keys.filter { AgentWindowPolicy.sameKeyLabel($0.label, label) }
        let distinct = hits.reduce(into: [ApprovalKey]()) { acc, one in
            if !acc.contains(where: { CFEqual($0.element, one.element) }) { acc.append(one) }
        }
        if distinct.isEmpty {
            return ["ok": true, "result": ["found": false, "note": "那个弹窗上没有「\(AgentWindowPolicy.clip(label, 40))」这颗键"]]
        }
        if distinct.count > 1 {
            return ["ok": true, "result": ["found": false, "many": distinct.count,
                                           "note": "那个弹窗上有 \(distinct.count) 颗都叫这个名字,一颗都没按"]]
        }
        guard TextInsert.frontForWindowAction(app) else {
            return ["ok": true, "result": ["found": true, "pressed": false, "gone": false,
                                           "note": "叫不到台前,这一下没按(按不动,还可能按到别人窗口上)"]]
        }
        let key = distinct[0]
        var how = "none"
        if actionNames(key.element).contains(kAXPressAction as String),
           AXUIElementPerformAction(key.element, kAXPressAction as CFString) == .success {
            how = "ax_press"
        } else {
            TextInsert.clickAt(CGPoint(x: winFrame.origin.x + key.frame.midX, y: winFrame.origin.y + key.frame.midY))
            how = "click"
        }
        // ⑤ 核实:含那截原话、又有这颗键的那一块还在不在。**轮询**到 `pressConfirmTotalMs`
        // (2026-10-13 卡 SC:按完等 1200ms 读一次,Electron 那几家把弹窗收掉比这慢,读太早就是一句假话)。
        var waited = 0
        var gone = false
        for step in SendTextPolicy.confirmSteps(totalMs: AgentWindowPolicy.pressConfirmTotalMs) {
            wait(ms: step)
            waited += step
            let left = approvalScan(window: window, winFrame: winFrame, marks: wanted)
                .contains { one in one.keys.contains { AgentWindowPolicy.sameKeyLabel($0.label, label) } }
            if !left {
                gone = true
                break
            }
        }
        return ["ok": true, "result": ["found": true, "pressed": how != "none", "how": how,
                                       "gone": gone, "waited_ms": waited]]
    }

    /**
     走一遍那扇窗,找出**含那截原话、又有几颗键**的那几块(2026-10-01,卡 AP)。走法与上限同 `askScan`。
     一块够格,它的祖先多半也够格 —— 祖先底下的键一多就不够格了(`approvalPanelWorthy`),挑哪块由服务端定。
     */
    private static func approvalScan(window: AXUIElement, winFrame: CGRect, marks: [String]) -> [ApprovalPanel] {
        var out: [ApprovalPanel] = []
        var visited = 0
        let started = CFAbsoluteTimeGetCurrent()
        let pressable: Set<String> = [kAXButtonRole as String, "AXLink", kAXMenuItemRole as String]
        func walk(_ element: AXUIElement, depth: Int) -> (hit: Bool, keys: [ApprovalKey]) {
            if visited >= AgentWindowPolicy.askScanMaxVisited
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.askScanMaxMs {
                return (false, [])
            }
            visited += 1
            guard let n = node(element) else { return (false, []) }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            let texts = [n.title, n.desc, stringAttr(element, kAXValueAttribute as String)].compactMap { $0 }
            var hit = texts.contains { text in marks.contains { AgentWindowPolicy.approvalMarkHit(text: text, mark: $0) } }
            var keys: [ApprovalKey] = []
            if pressable.contains(n.role), let r = rel, r.width > 0 {
                var label = n.title ?? n.desc
                if label == nil {
                    // 键名挂在子节点那几截静态字上的(网页按钮常见)。
                    let inner = n.children.compactMap { child -> String? in
                        guard let c = node(child), c.role == kAXStaticTextRole as String else { return nil }
                        return stringAttr(child, kAXValueAttribute as String) ?? c.title
                    }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
                    label = inner.isEmpty ? nil : inner
                }
                if let label { keys.append(ApprovalKey(element: element, label: label, frame: r)) }
            }
            if depth < AgentWindowPolicy.maxDepth {
                for child in n.children {
                    let below = walk(child, depth: depth + 1)
                    hit = hit || below.hit
                    keys.append(contentsOf: below.keys)
                }
            }
            if hit, let r = rel, AgentWindowPolicy.approvalPanelWorthy(buttons: keys.count) {
                out.append(ApprovalPanel(rect: r, keys: keys))
            }
            return (hit, keys)
        }
        _ = walk(window, depth: 0)
        return out
    }

    /// 挑不出一处时那句如实话(`none` / `many` 各自的原因原样往上报)。
    private static func askPickWhy(_ pick: AgentWindowPolicy.AskPick) -> String {
        switch pick {
        case .one(_, let why): return why
        case .none(let reason): return reason
        case .many(_, let reason): return reason
        }
    }

    private struct AskNode {
        let element: AXUIElement
        let field: AgentWindowPolicy.AskField
    }

    private struct AskSendNode {
        let element: AXUIElement
        let button: AgentWindowPolicy.AskButton
    }

    private struct AskPanel {
        let rect: CGRect
        let fields: [AskNode]
        let sends: [AskSendNode]
    }

    private struct AskScan {
        /// 够格当那个面板的几个容器(最内层那个在里面;挑哪个由 `pickAskPanel` 定)。
        var panels: [AskPanel] = []
        /// 整扇窗里所有输入框(找**窗口底部那个主输入框**那条红线用)。
        var inputs: [AskNode] = []
    }

    /**
     走一遍那扇窗,找出**够格当那个提问面板**的几个容器(2026-09-28,卡 AT)。

     一个容器够格 = 它底下既有那一问的几截字(选项原话 / 问句原话,认法 `AgentWindowPolicy.askMarkHit`)、
     又有输入框(`AgentWindowPolicy.enoughForAskPanel`)。**它的祖先一路到整扇窗也都够格** ——
     所以回一串,由 `pickAskPanel` 取最小那个。上限同 `askScanMaxVisited` / `askScanMaxMs`。
     */
    private static func askScan(window: AXUIElement, winFrame: CGRect, marks: [String]) -> AskScan {
        var out = AskScan()
        var visited = 0
        let started = CFAbsoluteTimeGetCurrent()
        /// 一枝走完往上回的三样:命中了哪几截字、底下那几个输入框、底下那几颗键。
        func walk(_ element: AXUIElement, depth: Int) -> (marks: Set<Int>, fields: [AskNode], sends: [AskSendNode]) {
            if visited >= AgentWindowPolicy.askScanMaxVisited
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.askScanMaxMs {
                return ([], [], [])
            }
            visited += 1
            guard let n = node(element) else { return ([], [], []) }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            var hits: Set<Int> = []
            var fields: [AskNode] = []
            var sends: [AskSendNode] = []
            let texts = [n.title, n.desc, stringAttr(element, kAXValueAttribute as String)].compactMap { $0 }
            for (index, mark) in marks.enumerated() where texts.contains(where: { AgentWindowPolicy.askMarkHit(text: $0, mark: mark) }) {
                hits.insert(index)
            }
            if SendTextPolicy.inputRoles.contains(n.role), let r = rel {
                let label = stringAttr(element, "AXPlaceholderValue") ?? n.title ?? n.desc ?? ""
                let one = AskNode(element: element, field: AgentWindowPolicy.AskField(
                    role: n.role, label: label, frame: r,
                    settable: isSettable(element, kAXValueAttribute as String)))
                fields.append(one)
                out.inputs.append(one)
            }
            if n.role == kAXButtonRole as String, let r = rel {
                sends.append(AskSendNode(element: element, button: AgentWindowPolicy.AskButton(label: n.title ?? n.desc ?? "", frame: r)))
            }
            if depth < AgentWindowPolicy.maxDepth {
                for child in n.children {
                    let below = walk(child, depth: depth + 1)
                    hits.formUnion(below.marks)
                    fields.append(contentsOf: below.fields)
                    sends.append(contentsOf: below.sends)
                }
            }
            if let r = rel, AgentWindowPolicy.enoughForAskPanel(marks: hits.count, inputs: fields.count) {
                out.panels.append(AskPanel(rect: r, fields: fields, sends: sends))
            }
            return (hits, fields, sends)
        }
        _ = walk(window, depth: 0)
        return out
    }

    /// 那扇窗上此刻看得见这一截字没有(核实「对话区里出现了她那句」用)。只读静态文本与按钮标签,上限同一次「读」。
    private static func seesText(window: AXUIElement, needle: String) -> Bool {
        var visited = 0
        let started = CFAbsoluteTimeGetCurrent()
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= AgentWindowPolicy.askScanMaxVisited
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.askScanMaxMs { break }
            visited += 1
            guard let n = node(element) else { continue }
            let texts = [n.title, n.desc, stringAttr(element, kAXValueAttribute as String)].compactMap { $0 }
            if texts.contains(where: { AgentWindowPolicy.textMentions($0, needle) }) { return true }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { stack.append((child, depth + 1)) }
        }
        return false
    }

    /**
     那扇窗上**「把这一问展开」的那几颗键**(2026-09-28,卡 AQ)。走法与上限同 `optionItems`。

     只看按得下去的那几种角色,标签认 `AgentWindowPolicy.looksLikeExpandAsk`(按形状,不写死一家的叫法)。
     回几颗就是几颗 —— **挑不挑、点不点由 `press` 定**(两颗都像就一颗都不点)。
     */
    private static func expandButtons(window: AXUIElement, winFrame: CGRect) -> [(AXUIElement, CGRect)] {
        let started = CFAbsoluteTimeGetCurrent()
        var out: [(AXUIElement, CGRect)] = []
        var visited = 0
        let roles: Set<String> = [kAXButtonRole as String, kAXMenuItemRole as String, "AXLink"]
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= AgentWindowPolicy.readMaxVisited || out.count >= 4
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.readMaxMs { break }
            visited += 1
            guard let n = node(element) else { continue }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            if roles.contains(n.role), let r = rel,
               AgentWindowPolicy.looksLikeExpandAsk(title: n.title, description: n.desc) {
                out.append((element, r))
                continue
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { stack.append((child, depth + 1)) }
        }
        return out
    }

    /// 那扇窗上**按得下去**、而且标签正是这一项的那一处(认不准 / 两处都像 → 空)。走法与上限同 `stopButtons`。
    ///
    /// 2026-09-28 20:36 Air 真机:选项原文带表情和说明(「🍲 番茄小火锅｜牛肉＋豆腐＋菌菇」),整行逐字比一行都找不着。
    /// 现在先把按得下去的那几行全收上来,交给 `AgentWindowPolicy.pickOption` 认(去表情、只标题那一截也认,但要唯一)。
    private static func optionItems(window: AXUIElement, winFrame: CGRect, label: String, options: [String] = [], role: String? = nil) -> [(AXUIElement, CGRect)] {
        optionHits(window: window, winFrame: winFrame, label: label, options: options, role: role).items
    }

    /// 同 `optionItems`,外加两件 `quota_page` 要的(2026-10-03,卡 QP):
    ///
    /// - `maxVisited` / `maxMs` —— 缺省就是读那一份上限(`agent_press` 那几处一字不变);
    ///   在整扇窗里找一颗导航键要宽得多,见 `AgentWindowPolicy.navMax*` 上面那段真机实测;
    /// - `capped` —— 预算用完了还没走完这棵树。**与「这扇窗上没这颗键」是两件事**,
    ///   回包里分开说(混成一句就是把「没走到」说成「它没有」)。
    /// - `alsoInnerText` —— **翻页那一条路额外认「键里面那几截静态字」**(2026-10-03,卡 QT)。
    ///
    ///   缺省 `false` = `agent_press` / `agent_write_ask` 今天的行为一字不差:一颗键身上有自己的字
    ///   (title / description / value)就只拿那几处,拿不到才去拼它底下那几截静态字。
    ///
    ///   翻页那一条(`quota_page`)要多一档,原因是真机量到的:豆包办公那颗通向额度页的
    ///   `AXPopUpButton` 身上写的是「**<账号名>** 标准套餐」—— 账号名是她的,写进
    ///   `WindowQuotaSpec.reach.press` 就只对她这一台机器成立,「以后的用户」一个都对不上。
    ///   而它底下那一截静态字正是「标准套餐」(产品自己的字)。所以这一档**只多收几行**,
    ///   认不认得准照旧由 `pickOptionRows` 判(同一个元素身上几行都对得上还是一处;
    ///   两个元素都对得上 → 一处都不按)。**`matchOptionLabel` 的「整行相等」一个字都没放松** ——
    ///   放松相等去按她的窗口才是真危险的那条路(卡 WQ 的纪律)。
    private static func optionHits(window: AXUIElement, winFrame: CGRect, label: String, options: [String] = [],
                                   maxVisited: Int = AgentWindowPolicy.readMaxVisited,
                                   maxMs: Double = AgentWindowPolicy.readMaxMs,
                                   alsoInnerText: Bool = false,
                                   role: String? = nil)
        -> (items: [(AXUIElement, CGRect)], capped: Bool, visited: Int) {
        let started = CFAbsoluteTimeGetCurrent()
        var rows: [(element: AXUIElement, rect: CGRect, text: String)] = []
        var visited = 0
        var capped = false
        /// 可按的角色:一张表,三个消费方共用(`AgentWindowPolicy.pressableRoles`,有用例)。
        let pressableRoles = AgentWindowPolicy.pressableRoles
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= maxVisited || rows.count >= 400
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > maxMs { capped = true; break }
            visited += 1
            guard let n = node(element) else { continue }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            /*
             * 按角色点名时(2026-10-12 第四轮真跑):**只认真按得下去的**(有 AXPress),而且认完**接着往下走** ——
             * 可灵那一页上一层层的 `AXGroup` 容器自己就带字(拼得出底下的字),老规矩「认出一颗就不往下走」
             * 会停在外面那层容器上,「视频生成」那个页签永远走不到。没点名照老规矩,一字不变。
             */
            let pressable = actionNames(element).contains(kAXPressAction as String)
            if role == nil ? pressableRoles.contains(n.role) : AgentWindowPolicy.pressRoleMatches(nodeRole: n.role, wanted: role), let r = rel,
               role == nil ? (pressable || r.width > 0) : pressable {
                // 标签三处都看一遍(各家把字放在 title / description / value 里的都有);一处一行。
                var texts = [n.title, n.desc, stringAttr(element, kAXValueAttribute as String)]
                    .compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                // 自己身上没字的(单选那一格把字挂在子节点上):拼上它底下那几截静态字。
                // `alsoInnerText`(翻页那一条路)= 身上有字也照样**多收**这一行(见上面那段)。
                if texts.isEmpty || alsoInnerText {
                    let inner = n.children.compactMap { child -> String? in
                        guard let c = node(child), c.role == kAXStaticTextRole as String else { return nil }
                        return stringAttr(child, kAXValueAttribute as String) ?? c.title
                    }.joined(separator: " ")
                    if !inner.trimmingCharacters(in: .whitespaces).isEmpty {
                        if texts.isEmpty { texts = [inner] } else { texts.append(inner) }
                    }
                }
                // 按角色点名时,名字前头的点数不算(「60 生成」认作「生成」;见 `labelWithoutCount`)。
                for text in texts { rows.append((element, r, role == nil ? text : AgentWindowPolicy.labelWithoutCount(text))) }
                if !texts.isEmpty && role == nil { continue }
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { stack.append((child, depth + 1)) }
        }
        /*
         * **「几处都叫这个名字」按元素数,不按行数**(2026-10-03,卡 QP 真机):同一颗键常常把
         * 同一个名字同时写在 title 与 description 上(Muse 侧栏那几颗全是),老那条路据此把
         * 一颗键当成「两处都像」、一处都不按 —— 判在 `AgentWindowPolicy.pickOptionRows`(有用例)。
         */
        var groupOf: [Int] = []
        var reps: [AXUIElement] = []
        for row in rows {
            if let at = reps.firstIndex(where: { CFEqual($0, row.element) }) { groupOf.append(at) }
            else { reps.append(row.element); groupOf.append(reps.count - 1) }
        }
        let indexed = rows.indices.map { (element: groupOf[$0], text: rows[$0].text) }
        switch AgentWindowPolicy.pickOptionRows(rows: indexed, wanted: label, options: options) {
        case .one(let at):
            return ([(rows[at].element, rows[at].rect)], capped, visited)
        case .many(let ats):
            return (ats.map { (rows[$0].element, rows[$0].rect) }, capped, visited)
        case .none:
            return ([], capped, visited)
        }
    }

    private struct SideRow {
        let element: AXUIElement
        let frame: CGRect
        let text: String
        let selected: Bool
    }

    /// 侧栏里那几行,**连元素一起带出来**(`read` 那一段只要字,这里要点得到)。走法、上限与 `read` 同一套。
    private static func sidebarRows(window: AXUIElement, winFrame: CGRect) -> [SideRow] {
        let started = CFAbsoluteTimeGetCurrent()
        var items: [SideRow] = []
        var candidates: [CGRect] = []
        var visited = 0
        var stack: [(AXUIElement, Int, Bool)] = [(window, 0, false)]
        let winW = winFrame.width
        while let (element, depth, selectedAbove) = stack.popLast() {
            if visited >= AgentWindowPolicy.sideMaxVisited || items.count >= AgentWindowPolicy.sideMax * 2
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.sideMaxMs { break }
            visited += 1
            guard let n = node(element) else { continue }
            guard let r = n.frame.map({ AgentWindowPolicy.relative($0, to: winFrame) }) else { continue }
            if depth > 0, AgentWindowPolicy.beyondSidebarSearch(r, windowWidth: winW) { continue }
            if SendTextPolicy.inputRoles.contains(n.role) || AgentWindowPolicy.sideSkipRoles.contains(n.role) { continue }
            if AgentWindowPolicy.looksLikeSidebar(r, windowSize: winFrame.size) { candidates.append(r) }
            var selected = selectedAbove || n.selected == true
            if !selected, AgentWindowPolicy.sideItemRoles.contains(n.role) {
                if let current = stringAttr(element, "AXARIACurrent"), current != "false" { selected = true }
            }
            if n.role == kAXStaticTextRole as String {
                if let value = stringAttr(element, kAXValueAttribute as String) ?? n.title {
                    items.append(SideRow(element: element, frame: r, text: value, selected: selected))
                }
                continue
            }
            if AgentWindowPolicy.sideItemRoles.contains(n.role), let label = n.title ?? n.desc {
                items.append(SideRow(element: element, frame: r, text: label, selected: selected))
                continue
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children.reversed() { stack.append((child, depth + 1, selected)) }
        }
        let sidebar = AgentWindowPolicy.pickSidebar(candidates)
        return items.filter { AgentWindowPolicy.inSidebar($0.frame, sidebar: sidebar) }
    }

    /// 这扇窗上那几颗「停止」键(侧栏里的不算 —— 侧栏里的「Stop execution」是一条菜单项,不是这一段在跑)。
    private static func stopButtons(window: AXUIElement, winFrame: CGRect) -> [(AXUIElement, CGRect)] {
        let started = CFAbsoluteTimeGetCurrent()
        var out: [(AXUIElement, CGRect)] = []
        var visited = 0
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= AgentWindowPolicy.readMaxVisited || out.count >= 4
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.readMaxMs { break }
            visited += 1
            guard let n = node(element) else { continue }
            let rel = n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) }
            let isButton = n.role == kAXButtonRole as String || n.role == "AXPopUpButton" || n.role == "AXMenuButton"
            if isButton, SendTextPolicy.looksLikeStopButton(title: n.title, description: n.desc), let r = rel {
                out.append((element, r))
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { stack.append((child, depth + 1)) }
        }
        return out
    }

    // MARK: - agent_images:一扇窗里图片类节点的位置与地址(2026-10-13 夜,卡 T,只读)

    /**
     ★ **可灵首帧格「传完了没有」的真信号**(维护者 10-13 22:4x:「按钮一直是 60 点,只能从图片判断,
     有一个 loading,然后显示完整的图片」)。文字读窗(`agent_read` 只收 AXStaticText)看不见图;
     而 Chromium 把 `<img>` 暴露成 AXImage,`AXURL` 就是它的 src —— 本机探针在传完的页上读到首帧格那张
     `https://p4-fdl.klingai.com/bs2/upload-ylab-stunt/…/参考图-20261013-220351.png?…`:上传完成后 CDN 的地址,
     带着参考图的文件名;上传中多半是 `blob:` 预览或没有。判「哪张算」在服务端(klingStep),这里只读、只回。

     回包:`images` 每条 = 角色(AXImage / AXProgressIndicator / AXBusyIndicator)、相对窗口的位置大小、
     `url`(最多 200 字)、`desc`(最多 80 字)。一颗键都不按、不叫台前、不 unhide。
     上限三道(节点 / 毫秒 / 条数),到了如实回 `capped: true`。只对登记表里接上了的那几家(与 `agent_read` 同一道门:`locate` 里的 neverRead)。
     */
    static func images(bundleId: String) -> [String: Any] {
        let started = CFAbsoluteTimeGetCurrent()
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, windowCount, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        var rows: [[String: Any]] = []
        var visited = 0
        var capped = false
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var head = 0
        while head < queue.count {
            if visited >= AgentWindowPolicy.imagesMaxVisited
                || rows.count >= AgentWindowPolicy.imagesMax
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.imagesMaxMs {
                capped = true
                break
            }
            let (element, depth) = queue[head]
            head += 1
            visited += 1
            guard let n = node(element) else { continue }
            if AgentWindowPolicy.imageRoles.contains(n.role), let frame = n.frame {
                rows.append(AgentWindowPolicy.imageRow(
                    role: n.role, rel: AgentWindowPolicy.relative(frame, to: winFrame),
                    url: urlAttr(element), desc: n.desc))
            }
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { queue.append((child, depth + 1)) }
        }
        let ms = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
        return ["ok": true, "result": [
            "running": true, "windows": windowCount, "active": app.isActive, "hidden": app.isHidden,
            "window": ["w": AgentWindowPolicy.int(winFrame.width), "h": AgentWindowPolicy.int(winFrame.height)],
            "images": rows, "visited": visited, "capped": capped, "ms": ms,
        ]]
    }

    /// `AXURL`:Chromium 给图片 / 链接带的地址(回来的是 CFURL / NSURL,偶尔是字符串)。
    private static func urlAttr(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, "AXURL" as CFString, &value) == .success, let raw = value else { return nil }
        if let url = raw as? URL { return url.absoluteString }
        if let url = raw as? NSURL { return url.absoluteString }
        if let text = raw as? String { return text }
        return nil
    }

    // MARK: - agent_ax_detail:那棵树的明细(2026-10-02,卡「适配自绘界面的 Kimi」,只读、诊断用)

    /**
     **这扇窗的辅助功能树长什么样**,一个元素一行。判定一条都不在这里下 ——
     服务端(`agentJudge.parseAxDetail`)收下、写进登记表 → 进诊断包,人看着它写读法。

     为什么要它:10-01 的诊断包只带角色的个数(`roles`),于是 Air 上判不过结构那一道的几家
     (官网版 Kimi `…kmp.mac`、可灵、App Store 版豆包)隔着一台机器只看得到
     `{AXUnknown:32, AXScrollArea:6, AXStaticText:23}` —— 认得出「它是自绘界面」,
     **还是写不出「输入框是哪一个节点、怎么往里写」**。这一条补的就是那一步。

     **只读结构,不读内容**(同 `agent_probe` 那条纪律):标题 / 说明 / 帮助 / 值**一个字都不回**,
     只回**字数**。角色名、子角色名、动作名、属性名都是系统常量,不是她窗口上的字。
     上限三道(节点数 / 毫秒 / 行数,见 `AgentWindowPolicy.axDetail*`),到了如实回 `capped: true`。

     走法与 `probeOnce` 一样是广度优先 —— **先把窗口上层铺开**:输入框那一条、发送键那一颗
     都在上层几圈里,封顶也不会先丢掉它们。
     */
    static func axDetail(bundleId: String) -> [String: Any] {
        let started = CFAbsoluteTimeGetCurrent()
        let located = locate(bundleId)
        guard case let .ok(app, _, window, winFrame, windowCount, _) = located else {
            if case let .fail(result) = located { return result }
            return ["ok": false, "error": "读不到"]
        }
        var rows: [[String: Any]] = []
        var visited = 0
        var capped = false
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var head = 0
        while head < queue.count {
            if visited >= AgentWindowPolicy.axDetailMaxVisited
                || rows.count >= AgentWindowPolicy.axDetailMax
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.axDetailMaxMs {
                capped = true
                break
            }
            let (element, depth) = queue[head]
            head += 1
            visited += 1
            guard let n = node(element) else { continue }
            var settable: [String] = []
            for attr in AgentWindowPolicy.axDetailSettableAttrs where isSettable(element, attr) { settable.append(attr) }
            rows.append(AgentWindowPolicy.axDetailRow(
                role: n.role, subrole: n.subrole, depth: depth,
                rel: n.frame.map { AgentWindowPolicy.relative($0, to: winFrame) } ?? .zero,
                actions: actionNames(element), settable: settable,
                focused: boolAttr(element, kAXFocusedAttribute as String) == true,
                titleLen: AgentWindowPolicy.axTextLen(n.title),
                descLen: AgentWindowPolicy.axTextLen(n.desc),
                helpLen: AgentWindowPolicy.axTextLen(stringAttr(element, kAXHelpAttribute as String)),
                valueLen: valueLen(element)))
            if depth >= AgentWindowPolicy.maxDepth { continue }
            for child in n.children { queue.append((child, depth + 1)) }
        }
        let ms = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
        return ["ok": true, "result": [
            "running": true, "windows": windowCount, "active": app.isActive, "hidden": app.isHidden,
            "window": ["w": AgentWindowPolicy.int(winFrame.width), "h": AgentWindowPolicy.int(winFrame.height)],
            "elements": rows, "visited": visited, "capped": capped, "ms": ms,
        ]]
    }

    /// `AXValue` 有几个字。**没有这条属性 → nil**(缺席与「有、是空的」在排障时是两件事);
    /// 值不是字符串(数、布尔、矩形)也回 nil。
    private static func valueLen(_ element: AXUIElement) -> Int? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let text = value as? String else { return nil }
        return AgentWindowPolicy.axTextLen(text)
    }

    private static func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue((v as! CFBoolean))
    }

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    private static func wait(ms: Int) {
        RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000))
    }
}
