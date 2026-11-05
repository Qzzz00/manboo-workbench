import AppKit
import ApplicationServices

/// **只读探针**(2026-10-13 夜,卡 S 第三节 A):把一扇窗里**图片类**的辅助功能节点倒出来 ——
/// AXImage / 进度圈 / 忙碌圈,以及说明里带「loading / 上传」的节点:角色、相对窗口的位置大小、
/// `AXURL`(Chromium 给 `<img>` 带的 src)、说明、标题。一颗键都不按、一个字都不写。
///
/// 为什么要它:可灵生成页的首帧格上传中是转圈、传完才显示整图(维护者 10-13 22:4x 原话),
/// 壳现成的 `agent_read` 只收 AXStaticText,看不见图;`agent_ax_detail` 120 行 BFS 到不了那一格。
/// 量法:先在「传完了」的页上跑一次留底;维护者拖一张 3–5 MB 的图进首帧格,每 0.5 秒跑一次、跑 15 秒,
/// 对比首帧格矩形里多了什么、`AXURL` 从什么变成什么(`blob:` / 没有 → `https://p?-fdl.klingai.com/bs2/upload-…`)。
enum ProbeImages {
    static func dump(bundleId: String, maxVisited: Int = 12000, maxSeconds: Double = 6) -> [String: Any] {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": true, "result": ["running": false]]
        }
        let appEl = AXWake.app(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        guard let windows = attr(appEl, kAXWindowsAttribute) as? [AXUIElement], let window = windows.first else {
            return ["ok": false, "error": "没有窗口(AXWindows 空)"]
        }
        let win = rect(window) ?? .zero
        let started = CFAbsoluteTimeGetCurrent()
        var rows: [[String: Any]] = []
        var roleCounts: [String: Int] = [:]
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var head = 0
        var visited = 0
        var capped = false
        while head < queue.count {
            if visited >= maxVisited || CFAbsoluteTimeGetCurrent() - started > maxSeconds { capped = true; break }
            let (el, depth) = queue[head]
            head += 1
            visited += 1
            let role = str(el, kAXRoleAttribute) ?? ""
            roleCounts[role, default: 0] += 1
            let desc = str(el, kAXDescriptionAttribute) ?? ""
            let title = str(el, kAXTitleAttribute) ?? ""
            let url = urlString(el)
            let imageLike = role == "AXImage" || role == "AXProgressIndicator" || role == "AXBusyIndicator"
            let loadingLike = [desc, title].contains { one in
                let low = one.lowercased()
                return low.contains("loading") || low.contains("上传") || low.contains("spinner")
            }
            if imageLike || loadingLike || url != nil {
                var row: [String: Any] = ["role": role, "d": depth]
                if let sub = str(el, kAXSubroleAttribute), !sub.isEmpty { row["sub"] = sub }
                if let r = rect(el) {
                    row["x"] = Int((r.origin.x - win.origin.x).rounded())
                    row["y"] = Int((r.origin.y - win.origin.y).rounded())
                    row["w"] = Int(r.width.rounded())
                    row["h"] = Int(r.height.rounded())
                }
                if let url { row["url"] = String(url.prefix(160)) }
                if !desc.isEmpty { row["desc"] = String(desc.prefix(80)) }
                if !title.isEmpty { row["title"] = String(title.prefix(80)) }
                rows.append(row)
            }
            if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
                for kid in kids { queue.append((kid, depth + 1)) }
            }
        }
        let ms = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
        return ["ok": true, "result": [
            "window": ["w": Int(win.width.rounded()), "h": Int(win.height.rounded())],
            "visited": visited, "capped": capped, "ms": ms,
            "roles": roleCounts.filter { $0.value >= 1 }.sorted { $0.value > $1.value }.prefix(12).map { "\($0.key):\($0.value)" },
            "images": rows,
        ]]
    }

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    private static func str(_ el: AXUIElement, _ name: String) -> String? {
        attr(el, name) as? String
    }

    /// `AXURL`:Chromium 给图片 / 链接带的地址;回来的是 CFURL / NSURL。
    private static func urlString(_ el: AXUIElement) -> String? {
        guard let raw = attr(el, "AXURL") else { return nil }
        if let url = raw as? URL { return url.absoluteString }
        if let url = raw as? NSURL { return url.absoluteString }
        if let text = raw as? String { return text }
        return nil
    }

    private static func rect(_ el: AXUIElement) -> CGRect? {
        guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
}
