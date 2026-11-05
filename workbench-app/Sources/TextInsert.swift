import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// 把一段话送进某家 Agent 客户端的输入框 —— **真去调系统 API 的那一半**。
///
/// 判断全在 `SendTextPolicy`(纯逻辑、有单测):哪个元素是输入框、哪颗按钮是发送、
/// 什么时候该退到键盘、失败了该说哪句话。这里只做动作,一条判断都不自己下。
///
/// 两条送话的路,**AX 优先**:
/// 1. `AXValue` 直接赋值 —— 一次属性写,不碰键盘、不碰剪贴板,**与输入法完全无关**;
/// 2. 写不进去(前端把输入框做成 contenteditable、AXValue 只读)就退到键盘:
///    激活窗口 → 点一下输入框 → **⌘V 粘贴**(先存后还用户的剪贴板)。
///    **从不逐字敲字符键** —— 那条路才会被中文输入法吃掉。
///
/// 发送那一下同理:`AXConfirm` → 界面上的发送按钮 → 回车键,前两条都不经过键盘。
///
/// 安全边界(卡上第 4 条):白名单只有 Agent 客户端,**微信 / 企业微信这类 IM 永远不在里面**。
/// 这道门在 `SendTextPolicy.isAllowed` 里,服务端那侧还有独立的一道,两道都过才送得出去。
enum TextInsert {

    // MARK: - 对外的两个原语

    /// 只找输入框,不送任何字(能力探测 + `focus_input` 原语共用这一条)。
    /// 返回这扇窗里所有像输入框的元素、挑中了哪个、为什么 —— 每家客户端的实测表就是它跑出来的。
    static func focusInput(bundleId: String, index: Int, focus: Bool) -> [String: Any] {
        switch locate(bundleId: bundleId, index: index) {
        case .failure(let failure):
            return ["ok": false, "error": failure.message, "scan": lastScan]
        case .success(let found):
            var result = describe(found)
            if focus {
                let focusedOK = focusElement(found.element, app: found.app, frame: found.pickedFrame)
                result["focused"] = focusedOK
            }
            return ["ok": true, "result": result]
        }
    }

    /**
     **把一张图粘贴进那家的输入框**(2026-10-12,演示卡「出图进可灵」;维护者原话「复制粘贴进可灵」)。

     为什么要它:可灵桌面版自带的 `klingai://Omni-video?path=` 入口真机量过 —— 开得出「视频生成 3.0」那一页,
     **图在半路丢了**(「添加 首尾帧图」那一格是空的)。粘贴是她自己平时的做法。

     与 `send_text` 同一套:找输入框(同一个 `locate`,白名单照旧)→ 叫到台前 → 给焦点 → ⌘V;
     **她的剪贴板先存后还**(存的是所有 item 的所有类型),还不回去如实报 `clipboard_restored:false`。
     剪贴板里放三样:PNG、TIFF、文件网址 —— 网页的粘贴处理认哪一样由它自己挑(Chromium 有文件网址时给 `files`)。
     **不判「粘没粘上」**:那是网页里的事,由插件紧接着读窗口核(壳不下判断的老规矩)。
     */
    static func pasteImage(bundleId: String, index: Int, path: String) -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: path), let image = NSImage(data: data) else {
            return ["ok": false, "error": "读不到这张图:\(path)"]
        }
        switch locate(bundleId: bundleId, index: index) {
        case .failure(let failure):
            return ["ok": false, "error": failure.message]
        case .success(let found):
            let saved = saveClipboard()
            let item = NSPasteboardItem()
            let isPNG = data.starts(with: [0x89, 0x50, 0x4E, 0x47])
            if isPNG { item.setData(data, forType: .png) }
            else if let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                item.setData(png, forType: .png)
            }
            if let tiff = image.tiffRepresentation { item.setData(tiff, forType: .tiff) }
            item.setString(URL(fileURLWithPath: path).absoluteString, forType: .fileURL)
            let pb = NSPasteboard.general
            pb.clearContents()
            guard pb.writeObjects([item]) else {
                let restored = restoreClipboard(saved)
                return ["ok": false, "error": "图放不进剪贴板", "clipboard_restored": restored]
            }
            found.app.activate(options: [.activateAllWindows])
            wait(ms: 250)
            _ = focusElement(found.element, app: found.app, frame: found.pickedFrame)
            wait(ms: 150)
            keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
            // 网页那一侧是异步读剪贴板的:还得太早,它读到的就是她原来那份。
            wait(ms: 800)
            let restored = restoreClipboard(saved)
            var result = describe(found)
            result["pasted"] = true
            result["clipboard_restored"] = restored
            return ["ok": true, "result": result]
        }
    }

    /**
     **按输入区左下角那颗没名字的「清空」键**(2026-10-12,演示卡「出图进可灵」;认法在 `SendTextPolicy.pickComposerClearKey`,有用例)。

     先找输入框(同一个 `locate`,白名单照旧),往上找**包着它、比它高出一截**的那一层(输入区),
     在输入区里收能按的元素,挑出那一颗;认不准就回 `found:false`,一下都不按。按完不判清没清 —— 由插件读窗口核。
     */
    /// `click`:不走 AXPress、在那颗键正中合成点一下(10-12 真量:可灵这颗 AXPress 回成功、网页却没清 ——
    /// 点击事件挂在里面那个图标上)。只在叫到台前之后点,点的就是认准的那一颗。
    static func clearComposer(bundleId: String, index: Int, click: Bool = false) -> [String: Any] {
        switch locate(bundleId: bundleId, index: index) {
        case .failure(let failure):
            return ["ok": false, "error": failure.message]
        case .success(let found):
            guard let inputFrame = frame(of: found.element) else { return ["ok": false, "error": "读不到输入框的位置"] }
            var composer: AXUIElement?
            var composerFrame = CGRect.null
            var current = found.element
            for _ in 0..<6 {
                var parentRef: CFTypeRef?
                guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
                      let parentRef, CFGetTypeID(parentRef) == AXUIElementGetTypeID() else { break }
                let parent = parentRef as! AXUIElement
                if let f = frame(of: parent), f.maxY >= inputFrame.maxY + 20 { composer = parent; composerFrame = f; break }
                current = parent
            }
            guard let composer else { return ["ok": true, "result": ["found": false, "note": "认不出包着输入框的那块输入区"]] }
            var keys: [(element: AXUIElement, frame: CGRect, named: Bool)] = []
            var stack: [(AXUIElement, Int)] = [(composer, 0)]
            var visited = 0
            while let (element, depth) = stack.popLast(), visited < 600 {
                visited += 1
                if actionNames(element).contains(kAXPressAction as String), let f = frame(of: element) {
                    let named = [stringAttr(element, kAXTitleAttribute), stringAttr(element, kAXDescriptionAttribute), stringAttr(element, kAXValueAttribute)]
                        .contains { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines) != "" }
                    keys.append((element, f, named))
                }
                if depth < 12 { for child in children(element) { stack.append((child, depth + 1)) } }
            }
            guard let at = SendTextPolicy.pickComposerClearKey(input: inputFrame, composer: composerFrame,
                                                               keys: keys.map { (frame: $0.frame, named: $0.named) }) else {
                return ["ok": true, "result": ["found": false, "keys": keys.count, "note": "输入区左下角认不准哪颗是清空键,一颗都没按"]]
            }
            let f = keys[at].frame
            let fronted = frontForWindowAction(found.app)
            wait(ms: 200)
            var pressed = false
            if click {
                guard fronted else { return ["ok": true, "result": ["found": true, "pressed": false, "note": "叫不到台前,没点"]] }
                clickAt(CGPoint(x: f.midX, y: f.midY))
                pressed = true
            } else {
                pressed = AXUIElementPerformAction(keys[at].element, kAXPressAction as CFString) == .success
            }
            wait(ms: 600)
            return ["ok": true, "result": ["found": true, "pressed": pressed,
                                           "frame": ["x": Int(f.minX - found.windowFrame.minX), "y": Int(f.minY - found.windowFrame.minY), "w": Int(f.width), "h": Int(f.height)]]]
        }
    }

    /**
     **把框上方已经挂着的帧图一张张删掉**(2026-10-12,演示卡「出图进可灵」;第六轮真跑:上一回的首帧留着,新图贴成了尾帧)。
     认法在 `SendTextPolicy.pickFrameDeleteKeys`(有用例)。那颗删除键要鼠标悬停才显示 —— 先把鼠标移过去、再点;
     删一张重读一次(删完首帧,尾帧会挪过来),最多删 4 回。叫不到台前一下都不点。回 `{deleted, left}`。
     */
    static func clearFrames(bundleId: String, index: Int) -> [String: Any] {
        guard case .success(let first) = locate(bundleId: bundleId, index: index) else {
            return ["ok": false, "error": "找不到输入框,不知道帧图在哪"]
        }
        guard frontForWindowAction(first.app) else { return ["ok": true, "result": ["deleted": 0, "note": "叫不到台前,没点"]] }
        wait(ms: 200)
        var deleted = 0
        for _ in 0..<4 {
            guard case .success(let found) = locate(bundleId: bundleId, index: index), let inputFrame = frame(of: found.element) else { break }
            var images: [CGRect] = []
            var keys: [(frame: CGRect, named: Bool)] = []
            var stack: [(AXUIElement, Int)] = [(found.window, 0)]
            var visited = 0
            while let (element, depth) = stack.popLast(), visited < 3000 {
                visited += 1
                let role = stringAttr(element, kAXRoleAttribute) ?? ""
                if let f = frame(of: element) {
                    if role == kAXImageRole as String { images.append(f) }
                    if actionNames(element).contains(kAXPressAction as String) {
                        let named = [stringAttr(element, kAXTitleAttribute), stringAttr(element, kAXDescriptionAttribute), stringAttr(element, kAXValueAttribute)]
                            .contains { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines) != "" }
                        keys.append((frame: f, named: named))
                    }
                }
                if depth < 40 { for child in children(element) { stack.append((child, depth + 1)) } }
            }
            guard let pick = SendTextPolicy.pickFrameDeleteKeys(input: inputFrame, images: images, keys: keys).first else { break }
            let image = images[pick.image]
            let key = keys[pick.key].frame
            // 先悬停在图上,让那两颗键画出来,再点删除。
            hover(at: CGPoint(x: image.midX, y: image.midY))
            wait(ms: 300)
            hover(at: CGPoint(x: key.midX, y: key.midY))
            wait(ms: 150)
            click(at: CGPoint(x: key.midX, y: key.midY))
            deleted += 1
            wait(ms: 900)
        }
        var left = 0
        if case .success(let found) = locate(bundleId: bundleId, index: index), let inputFrame = frame(of: found.element) {
            var images: [CGRect] = []
            var stack: [(AXUIElement, Int)] = [(found.window, 0)]
            var visited = 0
            while let (element, depth) = stack.popLast(), visited < 3000 {
                visited += 1
                if stringAttr(element, kAXRoleAttribute) == kAXImageRole as String, let f = frame(of: element) { images.append(f) }
                if depth < 40 { for child in children(element) { stack.append((child, depth + 1)) } }
            }
            left = SendTextPolicy.pickFrameDeleteKeys(input: inputFrame, images: images,
                                                     keys: images.map { (frame: CGRect(x: $0.maxX - 30, y: $0.minY + 5, width: 28, height: 28), named: false) }).count
        }
        return ["ok": true, "result": ["deleted": deleted, "left": left]]
    }

    private static func hover(at point: CGPoint) {
        let source = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    /**
     **按「锚在一段字下面那一排里、没名字的那颗键」**(2026-10-12,演示卡:可灵最新那条结果卡上的「下载」)。
     认法在 `SendTextPolicy.pickKeyBelowAnchor`(有用例)。`pattern` 是认锚那段字的正则(插件给);
     叫到台前、先悬停再点(那一排有的家要悬停才亮)。点完回那一刻窗口里新冒出来的几行字(弹出菜单),不判下没下载 ——
     下没下载由插件看那家自己的记录 / 下载目录核。
     */
    static func pressBelowText(bundleId: String, index: Int, pattern: String, role: String, maxBelow: Int) -> [String: Any] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return ["ok": false, "error": "认锚的正则写错了"] }
        guard case .success(let found) = locate(bundleId: bundleId, index: index) else { return ["ok": false, "error": "找不到那扇窗"] }
        func scan() -> (anchors: [CGRect], keys: [(element: AXUIElement, frame: CGRect, role: String, named: Bool)], texts: Set<String>) {
            var anchors: [CGRect] = []
            var keys: [(element: AXUIElement, frame: CGRect, role: String, named: Bool)] = []
            var texts = Set<String>()
            var stack: [(AXUIElement, Int)] = [(found.window, 0)]
            var visited = 0
            while let (element, depth) = stack.popLast(), visited < 4000 {
                visited += 1
                let r = stringAttr(element, kAXRoleAttribute) ?? ""
                if let f = frame(of: element) {
                    if r == kAXStaticTextRole as String, let t = stringAttr(element, kAXValueAttribute) {
                        texts.insert(t)
                        if regex.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil { anchors.append(f) }
                    }
                    if r == role, actionNames(element).contains(kAXPressAction as String) {
                        let named = [stringAttr(element, kAXTitleAttribute), stringAttr(element, kAXDescriptionAttribute), stringAttr(element, kAXValueAttribute)]
                            .contains { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines) != "" }
                        keys.append((element, f, r, named))
                    }
                }
                if depth < 40 { for child in children(element) { stack.append((child, depth + 1)) } }
            }
            return (anchors, keys, texts)
        }
        let before = scan()
        guard let at = SendTextPolicy.pickKeyBelowAnchor(anchors: before.anchors, keys: before.keys.map { (frame: $0.frame, role: $0.role, named: $0.named) },
                                                         role: role, maxBelow: CGFloat(maxBelow)) else {
            return ["ok": true, "result": ["found": false, "anchors": before.anchors.count, "note": "没认出那颗键,一下都没点"]]
        }
        guard frontForWindowAction(found.app) else { return ["ok": true, "result": ["found": true, "pressed": false, "note": "叫不到台前,没点"]] }
        wait(ms: 200)
        let f = before.keys[at].frame
        hover(at: CGPoint(x: f.midX, y: f.midY))
        wait(ms: 200)
        click(at: CGPoint(x: f.midX, y: f.midY))
        wait(ms: 900)
        let after = scan()
        let fresh = after.texts.subtracting(before.texts).sorted().prefix(12)
        return ["ok": true, "result": ["found": true, "pressed": true, "new_texts": Array(fresh),
                                       "frame": ["x": Int(f.minX - found.windowFrame.minX), "y": Int(f.minY - found.windowFrame.minY), "w": Int(f.width), "h": Int(f.height)]]]
    }

    /// 把输入框擦干净。**只擦我们刚送进去的那种场合用**(验证收尾):送字进别人的输入框
    /// 是为了证明送得进去,不是为了在他的窗口里留下一段话。擦不掉就如实说。
    static func clearInput(bundleId: String, index: Int) -> [String: Any] {
        switch locate(bundleId: bundleId, index: index) {
        case .failure(let failure):
            return ["ok": false, "error": failure.message]
        case .success(let found):
            // 实测(2026-09-21):往这几家的 contenteditable 写 `AXValue = ""` **清不掉**
            // (写进去的值像是被追加而不是替换)。真能清干净的只有"全选 + 删除"这条键盘路。
            found.app.activate(options: [.activateAllWindows])
            _ = focusElement(found.element, app: found.app, frame: found.pickedFrame)
            wait(ms: 120)
            selectAllAndDelete()
            wait(ms: 150)
            let after = isEmptyInput(found.element, bundleId: bundleId)
            return ["ok": after, "result": ["readback_empty": after, "len": (stringValue(of: found.element) ?? "").count]]
        }
    }

    /// 送话。`submit=true` 时再按发送。
    ///
    /// `restoreFront`:送完把用户原来在台前的那个应用换回去(卡上写的"可选")。
    /// **缺省不还** —— 送完把那家客户端留在台前,Ben 才看得见字进去了没有;
    /// 界面上真用起来时由服务端按场景传这个参数。
    ///
    /// **试两次**(2026-09-21 实测):三家客户端**第一次**都会失败,读回来的还是占位符。
    /// 原因是刚写完 `AXManualAccessibility` 那一下 Chromium 正在重建整棵网页 AX 树,
    /// 我们手里那个元素引用已经作废了 —— 写进去的是一个不存在的框。重新找一次元素再送,
    /// 三家都成。所以这里**只重试一次,而且必须重新 locate**(拿着同一个陈引用重试没有意义)。
    /// 步骤顺序与草稿的去向都在 `SendTextPolicy`(`sendSteps` / `draftMove` / `draftReturn`,有单测),
    /// 这里只照着走 —— 见那三处的注释,2026-09-27 卡 DB 的现场就写在 `sendSteps` 上面。
    ///
    /// `saveDraft`:调用方接得住草稿(工作台会把它存下来)。给 true 时**框里有他没发出去的字也照送**,
    /// 但先把那段原文读出来一并回给调用方,送完再原样放回框里(放不回就如实说)。
    /// **缺省 false**:老调用方一字不变,照旧拦下不覆盖。
    static func sendText(bundleId: String, index: Int, text: String, submit: Bool,
                         restoreFront: Bool, overwrite: Bool = false,
                         newConversation: Bool = false, saveDraft: Bool = false) -> [String: Any] {
        guard !text.isEmpty else {
            return ["ok": false, "error": SendTextPolicy.Failure.emptyText.message]
        }
        let previousFront = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        // 被藏起来的先翻出来(2026-09-25,卡 C 把各家认领进窗口槽之后,不是当前那一格的都是藏着的)。
        // 正常情况下服务端已经先切过那一格(dock.switchTo),这里只是兜底:藏着的应用 activate 不一定会
        // 把窗口带出来,而键盘那条路(⌘V、回车)发给的是台前那一家 —— 字会落空或落到别处。
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first, app.isHidden {
            app.unhide()
            wait(ms: 250)
        }

        let singleThread = SendTextPolicy.singleThreadBundleIds.contains(bundleId)
        let steps = SendTextPolicy.sendSteps(newConversation: newConversation, singleThread: singleThread)

        // ① 先看一眼这扇窗写不写得进 —— **只看找不找得到框,不判草稿**(卡 DB)。
        // 这一步挡住的是「开了新对话才发现送不了」那一类:挡住就一条空对话都不留在他的客户端里。
        // 这一趟有没有替她关掉过一层框:每次送话从零开始记(卡 DP)。
        lastModalClosed = nil
        if steps.contains(.reachInput), case .failure(let failure) = locateClosingModal(bundleId: bundleId, index: index) {
            return ["ok": false, "error": failure.message, "step": SendTextPolicy.SendStep.reachInput.rawValue]
        }

        // ② 开一条新对话(2026-09-24,卡 F):不开就会打进他此刻正开着的那条对话。
        // 只有一条长期对话的那几家(Muse)没有这一步,如实记一句。
        var conversationNote: String?
        if newConversation {
            if singleThread {
                conversationNote = "single_thread"
            } else {
                let opened = openNewConversation(bundleId: bundleId)
                if opened["ok"] as? Bool != true {
                    return ["ok": false, "error": (opened["error"] as? String) ?? "开不了新对话",
                            "step": SendTextPolicy.SendStep.openNewConversation.rawValue]
                }
                conversationNote = (opened["result"] as? [String: Any])?["menu"] as? String ?? "new"
            }
        }
        let openedNew = conversationNote != nil && conversationNote != "single_thread"

        /// 他没发出去的那段字(存下来了才有值);送完要原样放回框里。
        var savedDraft: String?
        var draftNote: String?

        var last: [String: Any] = [:]
        for attempt in 1...2 {
            switch locateClosingModal(bundleId: bundleId, index: index) {
            case .failure(let failure):
                var out: [String: Any] = ["ok": false, "error": failure.message, "attempt": attempt,
                                          "step": SendTextPolicy.SendStep.locateInput.rawValue]
                if openedNew { out["new_conversation_left_empty"] = true }
                return out
            case .success(let first):
                // ③ 草稿:框里有他自己写了一半的话 —— **绝不静默覆盖**。判的必须是**新对话那个框**,
                // 所以刚按完「新对话」时先让树稳下来(旧对话的框还可能挂着,里面是他的草稿)。
                var found = first
                if attempt == 1, openedNew, !isEmptyInput(found.element, bundleId: bundleId) {
                    let settled = settleAfterNewConversation(bundleId: bundleId, index: index)
                    if let settled { found = settled }
                }
                if attempt == 1 {
                    let move = SendTextPolicy.draftMove(inputEmpty: isEmptyInput(found.element, bundleId: bundleId),
                                                        draft: stringValue(of: found.element),
                                                        overwrite: overwrite,
                                                        canSave: saveDraft)
                    switch move {
                    case .send, .overwrite:
                        break
                    case .saveThenSend(let draft):
                        savedDraft = draft
                    case .blocked:
                        var out: [String: Any] = ["ok": false,
                                                  "error": SendTextPolicy.Failure.draftInTheWay(bundleId: bundleId).message]
                        if openedNew { out["new_conversation_left_empty"] = true }
                        return out
                    }
                }
                var result = describe(found)
                result["restored_front"] = false
                result["attempt"] = attempt
                if let conversationNote { result["new_conversation"] = conversationNote }
                // 存下来的草稿**原样回给调用方**(工作台落盘;见 server/clientDrafts.ts)。
                // 只有这一格会带框里的内容出去 —— 别的地方只报空不空、报长度(见 `describe`)。
                if let savedDraft { result["draft"] = savedDraft }

                /*
                 * 送**之前**量一眼对话区里有没有这一截字(卡 SC 第二档的底子)。
                 * 非得在写进框之前量:写进去之后那段字就躺在框里了,之后再找「窗口里有没有它」
                 * 一定找得到 —— 那不是凭据。她上回发过同一句的情形也靠这一量挡住(见 `Echo`)。
                 */
                var echo: Echo?
                if submit, let needle = SendTextPolicy.echoNeedle(text) {
                    echo = Echo(needle: needle,
                                before: seesSentText(window: found.window, needle: needle, skipping: found.pickedFrame),
                                valueBefore: stringValue(of: found.element),
                                sent: text)
                }

                guard let failure = deliver(found: found, text: text, result: &result) else {
                    var submittedOK = false
                    if submit {
                        let submitted = performSubmit(found: found, echo: echo)
                        result["submit_method"] = submitted.method.rawValue
                        result["submitted"] = submitted.ok
                        // 哪一档核出来的、在核对上等了多久(卡 SC)。**只进日志** —— 8791 那边照旧只看 `submitted`。
                        result["confirmed_by"] = submitted.by?.rawValue ?? "none"
                        result["waited_ms"] = submitted.waitedMs
                        // 按那一下的时候它在不在台前(2026-09-28,卡 WR:没在台前 = 这一下不算数,见 frontForSubmit)。
                        result["submit_front"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId
                        submittedOK = submitted.ok
                        if let warning = SendTextPolicy.imeWarning(inputSourceId: currentInputSourceID(), submit: submitted.method) {
                            result["ime_warning"] = warning
                        }
                        result["ime"] = currentInputSourceID()
                    }
                    // ④ 把他那段草稿原样放回框里。放不回去就只存着,并如实说为什么(调用方要告诉他存哪了)。
                    if let savedDraft {
                        switch SendTextPolicy.draftReturn(submitted: submittedOK,
                                                          inputEmptyAfterSend: inputLooksEmpty(bundleId: bundleId, index: index)) {
                        case .putBack:
                            let back = putDraftBack(bundleId: bundleId, index: index, draft: savedDraft)
                            result["draft_returned"] = back.ok
                            if !back.ok { draftNote = back.reason }
                        case .keepOnly(let reason):
                            result["draft_returned"] = false
                            draftNote = reason
                        }
                        if let draftNote { result["draft_note"] = draftNote }
                    }
                    restoreFrontIfNeeded(restoreFront, previousFront, &result)
                    // 替她关掉过一层框就**说一句**(卡 DP):替她按了她窗口上的键,不许做完不说。
                    if let lastModalClosed { result["modal_closed"] = lastModalClosed }
                    return ["ok": true, "result": result]
                }
                last = ["ok": false, "error": failure.message, "result": result]
                if attempt == 1 { wait(ms: 250) }
            }
        }
        var result = (last["result"] as? [String: Any]) ?? [:]
        if openedNew { result["new_conversation_left_empty"] = true }
        restoreFrontIfNeeded(restoreFront, previousFront, &result)
        last["result"] = result
        return last
    }

    // MARK: - 草稿保全(2026-09-27,卡 DB)

    /// 刚按完「新对话」那一拍,AX 树里可能还挂着**旧对话**的那个框(里面是他的草稿)。
    /// 在 `newConversationSettleMs` 里每 `newConversationSettleStepMs` 重找一次:
    /// 框空了 = 新对话那个框画出来了,回它。到点还不空就回**最后一次找到的那个**
    /// (至少是个新鲜的引用),由 `draftMove` 去判那到底是不是他的字。
    private static func settleAfterNewConversation(bundleId: String, index: Int) -> Found? {
        let deadline = Date().addingTimeInterval(Double(SendTextPolicy.newConversationSettleMs) / 1000)
        var latest: Found?
        while Date() < deadline {
            wait(ms: SendTextPolicy.newConversationSettleStepMs)
            guard case .success(let again) = locate(bundleId: bundleId, index: index) else { continue }
            latest = again
            if isEmptyInput(again.element, bundleId: bundleId) { return again }
        }
        return latest
    }

    /// 发完之后框里空不空。**读不出值(或者找不到框)按"空"算** —— 核不了就让"放回去"那一步
    /// 自己去试、自己如实说为什么;在这里替它判"没空"会白白把他的草稿留在工作台里不放回。
    private static func inputLooksEmpty(bundleId: String, index: Int) -> Bool {
        guard case .success(let found) = locate(bundleId: bundleId, index: index) else { return true }
        guard stringValue(of: found.element) != nil else { return true }
        return isEmptyInput(found.element, bundleId: bundleId)
    }

    /// 把他那段草稿**原样**写回输入框(走送字那同一条路:AXValue 优先,写不进退到粘贴)。
    /// 放不回去就如实回原因 —— 调用方据此在事项上告诉他「你没发的那句我存在这里了」。
    private static func putDraftBack(bundleId: String, index: Int, draft: String) -> (ok: Bool, reason: String?) {
        guard case .success(let found) = locate(bundleId: bundleId, index: index) else {
            return (false, "要放回去时重新找不到那个输入框了")
        }
        var scratch: [String: Any] = [:]
        if let failure = deliver(found: found, text: draft, result: &scratch) {
            return (false, "放回去没成:\(failure.message)")
        }
        return (true, nil)
    }

    // MARK: - 新对话 / 读回复(2026-09-24,卡 F「手机远程派活」)

    /// 按那家菜单栏里的「新对话」(名字表在 `SendTextPolicy.newConversationMenuTitles`)。
    ///
    /// 走的是 AX 菜单项的 `AXPress` —— 那家自己告诉我们的那一下,**不敲快捷键**
    /// (⌘K 在 Kimi 里是新聊天,在别家可能是别的)。菜单项的可用状态跟着"谁在台前"变,
    /// 所以先把那家叫到台前再找。找不到 / 是灰的就**如实失败**,调用方据此不送。
    static func openNewConversation(bundleId: String) -> [String: Any] {
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": SendTextPolicy.Failure.notAllowed(bundleId: bundleId).message]
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": SendTextPolicy.Failure.notRunning(bundleId: bundleId).message]
        }
        // 先敲门再读(Chromium 系不建树就读不到东西);一处写、处处用,见 AXWake。
        let appEl = AXWake.app(app.processIdentifier)
        app.activate(options: [.activateAllWindows])
        wait(ms: 350)

        // 菜单项的亮 / 灰跟着"谁在台前"变,而且变得慢(豆包 activate 之后约 1 秒才亮,见
        // `SendTextPolicy.newConversationMenuWaitMs`)。所以灰的时候**等一等再看**,不是看一眼就判灰。
        let started = Date()
        var reactivated = false
        while true {
            var barRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &barRef) == .success,
                  let bar = barRef, CFGetTypeID(bar) == AXUIElementGetTypeID() else {
                return ["ok": false, "error": SendTextPolicy.Failure.noNewConversation(bundleId: bundleId, detail: "读不到它的菜单栏").message]
            }
            var greyed: String?
            for top in children(bar as! AXUIElement) {
                for menu in children(top) {
                    for item in children(menu) {
                        guard let title = stringAttr(item, kAXTitleAttribute), SendTextPolicy.isNewConversationItem(title) else { continue }
                        if boolAttr(item, kAXEnabledAttribute) == false { greyed = title; continue }
                        let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
                        guard err == .success else {
                            return ["ok": false, "error": SendTextPolicy.Failure.noNewConversation(bundleId: bundleId, detail: "按「\(title)」回 \(err.rawValue)").message]
                        }
                        // 新对话的输入框要一拍才画出来(Codex 实测 900ms 时拿到的还是旧框的引用);
                        // 之后 locate 自己还会等一次 800ms 重扫,读回来对不上还会重新找一次再送。
                        wait(ms: 1500)
                        let waited = Int(Date().timeIntervalSince(started) * 1000)
                        return ["ok": true, "result": ["menu": title, "menu_wait_ms": waited]]
                    }
                }
            }
            guard let grey = greyed else {
                return ["ok": false, "error": SendTextPolicy.Failure.noNewConversation(bundleId: bundleId, detail: "菜单栏里没有「新对话」这一项").message]
            }
            let elapsed = Int(Date().timeIntervalSince(started) * 1000)
            if elapsed >= SendTextPolicy.newConversationMenuWaitMs {
                let seconds = SendTextPolicy.newConversationMenuWaitMs / 1000
                return ["ok": false, "error": SendTextPolicy.Failure.noNewConversation(
                    bundleId: bundleId,
                    detail: "菜单里的「\(grey)」叫到台前等了 \(seconds) 秒还是灰的 —— 它可能没到台前,或者正挂着登录 / 更新之类的框").message]
            }
            if !reactivated && elapsed >= SendTextPolicy.newConversationReactivateAfterMs {
                // 再叫一次台前,这回两条路都走:`activate` 从 macOS 14 起是合作式的(叫的人自己不在台前时
                // 系统可以不理 —— 派活时台前常常是上一家,不是壳);辅助功能那条路(`AXFrontmost`)受信任的客户端都能用。
                app.activate(options: [.activateAllWindows])
                AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                reactivated = true
            }
            wait(ms: 150)
        }
    }

    /// 把那扇窗里**我们送进去的那句话之后**的文字读回来(只读,不激活、不动焦点)。
    ///
    /// 按**文档顺序**(深度优先)收 `AXStaticText` 的值,找最后一个含 `marker` 的节点,
    /// 回它后面的那些。**只回 marker 之后的** —— 那之前是他自己的东西(侧栏里的对话标题、
    /// 以前的对话),我们没有理由读,也不往外带一个字。
    ///
    /// `busy`:窗口里有没有一颗「停止」键(`SendTextPolicy.looksLikeStopButton`)——
    /// 有就是那家还在出字 / 还在干活,调用方据此不把半截回答当结果。
    /// 怎么把这些节点拼成"回答"(去掉我们自己那句的其余几段、去掉界面文案)是服务端的事
    /// (`dispatchReply.ts`),这里一条判断都不下。
    static func readReply(bundleId: String, index: Int, marker: String,
                          maxNodes: Int = 400, maxChars: Int = 40_000) -> [String: Any] {
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": SendTextPolicy.Failure.notAllowed(bundleId: bundleId).message]
        }
        let needle = marker.filter { !$0.isWhitespace }
        guard !needle.isEmpty else { return ["ok": false, "error": "read_reply 缺 marker"] }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": SendTextPolicy.Failure.notRunning(bundleId: bundleId).message]
        }
        // 先敲门再读(Chromium 系不建树就读不到东西);一处写、处处用,见 AXWake。
        let appEl = AXWake.app(app.processIdentifier)
        var windowsRef: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef)
        if err != .success {
            return ["ok": false, "error": SendTextPolicy.Failure.axDisabled(bundleId: bundleId, err: err.rawValue).message]
        }
        let all = (windowsRef as? [AXUIElement]) ?? []
        let standard = all.filter { subrole(of: $0) == kAXStandardWindowSubrole as String }
        let windows = standard.isEmpty ? all : standard
        guard !windows.isEmpty else {
            return ["ok": false, "error": SendTextPolicy.Failure.noWindow(bundleId: bundleId).message]
        }
        let window = windows[(index >= 0 && index < windows.count) ? index : 0]
        let windowFrame = frame(of: window)

        var texts: [String] = []
        /// 与 `texts` 一一对应的那个节点(记号那一格是 nil)。只为**命中之后**问一次它在哪 ——
        /// 自绘界面里没有输入框那个角色,得靠位置分「这句已经发出去了」与「它还躺在框里」(见
        /// `SendTextPolicy.looksLikeInInputBand`)。只问命中那一个,不是每一块字都问(那是几百次来回)。
        var textNodes: [AXUIElement?] = []
        /// 「停止」键出现在文字流的哪个位置(那一刻已经收了几段字)。**只认我们那一句之后的**:
        /// 侧栏里别的会话 / 别的任务也可能挂着「Stop this task」(Claude 桌面版实测),那不是这一件在跑。
        var stopAt: [Int] = []
        var visited = 0
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        // ★ 墙钟上限(2026-10-21,卡「派活按家隔离」):从前只数节点(上限两万多个、每个几次 AX 来回),
        // 慢的那一家能在它那条读队里遍历很久 —— 插件那一头 15 秒就不等了。读过上限就停、如实说。
        let budgetStart = Date()
        while let (node, depth) = stack.popLast(), visited < maxNodes * 60 {
            visited += 1
            if visited % 50 == 0 {
                let spent = Int(Date().timeIntervalSince(budgetStart) * 1000)
                if spent > ReadLanes.readBudgetMs { return ["ok": false, "error": ReadLanes.budgetSay(ms: spent)] }
            }
            let role = stringAttr(node, kAXRoleAttribute) ?? ""
            // 输入框里面的字不算:Codex 的输入框是 contenteditable,框里的话在 AX 树里也是
            // AXStaticText。话还没发出去时,不跳过这一支就会在输入框里"找到"我们那句、把输入区的按钮当成回答。
            // 同时在文字流里留一个记号:回复读到输入框为止,输入区那一排(权限档、模型名、分支名)不算回答。
            if SendTextPolicy.inputRoles.contains(role) { texts.append(inputSentinel); textNodes.append(nil); continue }
            if role == kAXStaticTextRole as String {
                if let value = stringAttr(node, kAXValueAttribute), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    texts.append(value)
                    textNodes.append(node)
                }
            } else if role == kAXButtonRole as String,
                      SendTextPolicy.looksLikeStopButton(title: stringAttr(node, kAXTitleAttribute),
                                                         description: stringAttr(node, kAXDescriptionAttribute)) {
                stopAt.append(texts.count)
            }
            if depth >= maxDepth + 20 { continue }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let kids = childrenRef as? [AXUIElement] else { continue }
            // 那家弹的建议卡(Manus「要不要记住这条」,带 Accept / Dismiss)整张跳过:它的字不是回答。
            let buttonTitles = kids.compactMap { kid -> String? in
                stringAttr(kid, kAXRoleAttribute) == kAXButtonRole as String ? stringAttr(kid, kAXTitleAttribute) : nil
            }
            if buttonTitles.count >= 2, SendTextPolicy.looksLikeSuggestionCard(buttonTitles: buttonTitles) { continue }
            for child in kids.reversed() { stack.append((child, depth + 1)) }
        }

        guard let at = texts.lastIndex(where: { $0 != inputSentinel && $0.filter { !$0.isWhitespace }.contains(needle) }) else {
            // 没找到我们那句:多半是他切到了别的对话,或者这家的对话区读不出字。**一个字都不回**。
            return ["ok": true, "result": ["found": false, "busy": false, "visited": visited, "text_nodes": texts.count]]
        }
        /*
         * ★ **自绘界面:命中那一块字还在输入框那一带 = 还没发出去**(2026-10-02,卡「适配自绘界面的 Kimi」)。
         * 这棵树里一个标准输入角色都没有(没留下过记号),命中那一块又落在窗口下部那一条 ——
         * 那是她粘进去、还没发出去的那一句。**如实回「没找到」**,不拿它冒充凭据。
         */
        if !texts.contains(inputSentinel), let windowFrame,
           let node = textNodes.indices.contains(at) ? textNodes[at] : nil,
           let hit = frame(of: node),
           SendTextPolicy.looksLikeInInputBand(frame: hit, window: windowFrame) {
            // 回包字段**一格不加**(统筹 10-02:窗口适配器照现有契约写)——
            // 走的就是现成那一支「没找到我们那一句」。
            return ["ok": true, "result": ["found": false, "busy": false,
                                           "visited": visited, "text_nodes": texts.count]]
        }
        let busy = stopAt.contains { $0 > at }
        var out: [String] = []
        var chars = 0
        var truncated = false
        var reachedInput = false
        for text in texts[at...] {
            if text == inputSentinel { reachedInput = true; break }
            if out.count >= maxNodes || chars + text.count > maxChars { truncated = true; break }
            out.append(text)
            chars += text.count
        }
        return ["ok": true, "result": ["found": true, "busy": busy, "texts": out, "truncated": truncated,
                                       "reached_input": reachedInput, "visited": visited, "text_nodes": texts.count]]
    }

    /// 只读几小段字(read_texts,2026-09-25 卡 O「额度要覆盖派活名单里的每一家」)。
    ///
    /// 服务端给几条正则(`SendTextPolicy.parseTextPatterns`),这里按文档顺序收那扇窗里的 `AXStaticText`
    /// (**输入框那一支整个跳过** —— 他打了一半的字不读),连同位置交给 `SendTextPolicy.matchTexts`,
    /// **只回命中的那一小段**。Manus 首页右上角的积分、Muse「使用情况」页上的「已使用 N%」靠它读。
    /// 只读:不激活、不动焦点、不点任何东西。白名单同送话那一张。
    ///
    /// ★ **2026-09-26(卡 MQ):不给 `index` 就每一扇标准窗都读一遍。**
    ///
    /// 原来写死读 `windows[0]`。实测 Muse 开着四扇标准窗(聊天主窗、设置、登录、欢迎),
    /// 额度那几个字在「设置 → 通用」那一扇上,而 `windows[0]` 是另一扇 —— 服务端于是一条正则都没命中,
    /// 界面上说「这会儿不在『使用情况』页上」,可他明明正开着那一页。一个用户开着几扇窗是常态,
    /// 没有哪一扇天生是第 0 扇,所以**壳把每一扇都读一遍**,命中里带上是第几扇(`window`),
    /// 每一扇的宽高在 `windows` 里;**哪一扇算数由服务端的 parse 判**(壳一条判断都不下,同这个文件的老规矩)。
    /// `index` 给了就还是只读那一扇(老服务端一字不变)。
    ///
    /// 遍历的花销:`maxVisits` 是**几扇窗合起来**的上限(不是每扇一份),超了就停在那一扇 ——
    /// 宁可少读一扇,也不让一棵大树把服务端那 8 秒耗光。
    ///
    /// ★ **2026-09-26(卡 MQ2):Muse 的设置窗 `AXWindows` 里有,前提是它在这会儿显示着的那个桌面上。**
    ///
    /// 卡 MQ 收尾时那一眼看着像「`AXWindows` 压根不列 Muse 的设置窗」,于是怀疑要另找一条路
    /// (`AXMainWindow` / `AXFocusedWindow` / 应用元素的 children / 敲门过一拍 / 挂在别的窗底下的 sheet /
    /// 照着系统窗口的中心点位测)。**一条都不用**:同一个进程里同一刻对照着采(`probe spacewatch`)量到的是 ——
    ///
    /// - 设置窗在**这会儿显示着的那个桌面**上时:`AXWindows` 里就有它(`AXStandardWindow`),
    ///   这里每扇都读,「使用情况」页上那几行(「使用情况」/「Free plan」/「Weekly limit resets on…」/「3% used」)全命中;
    /// - 它不在这个桌面上时:`AXWindows` 里**没有**它,上面那几条路也全都没有 —— 主窗 / 焦点窗回的还是
    ///   同一扇被列出来的窗,children 也一样。只有主窗那一扇在别的桌面上时仍旧留在清单里,
    ///   subrole 从 `AXStandardWindow` 降成 `AXDialog`(像个影子)。切桌面之后这张清单还要一两秒才跟上。
    ///
    /// 所以枚举这条路**不用改**;真正要说清的是「那扇窗得在你这会儿看着的桌面上」——
    /// 那句话靠下面 `offspace_windows` 这一格(数出来的,不是减出来的)。
    ///
    /// ★ **2026-09-26(卡 MQ3):藏着的家,读之前先把它放出来,读完照原样藏回去。**
    ///
    /// 卡 MQ2 把话说对了(「它这会儿是藏起来的,点一下图标把它放出来」),可那句话是**让他去补工作台
    /// 自己造的一个坑**:藏它的手就是工作台的窗口槽(`WindowControl.hide`,「遮罩一收就藏回去」)——
    /// 于是只要某一家被槽收过一次,额度这条路就死了,与它开着几扇窗、在不在用量那一页无关。
    /// 这里把它消化掉:`unhide()`(**不 activate** —— 不抢焦点、不闪到台前)→ 等一拍让 AX 清单跟上
    /// → 读 → **藏回去**。取舍与节奏写在 `SendTextPolicy.unhideWaitMs` / `worthAnotherUnhideLook` /
    /// `shouldRehide` 上面。窗口槽那套规则一个字没动。
    ///
    /// `unhideHidden: false` 只给诊断探针用(`probe read-texts --no-unhide`):复现「不放出来直接读」
    /// 那条老路,好在同一台机器上同一刻对照出放出来到底多读到了什么。服务端从不给这一格。
    ///
    /// ★ **2026-10-03(卡「Grok 读键字」):`includeTitles` —— 按家声明地也读「键身上的字」。**
    ///
    /// 缺省 `false`:文字流还是只有 `AXStaticText` 的 `AXValue`,**行为一字不变**。
    /// 服务端只对查实过的那一家给 `include_titles: true`(今天只有 Grok Bot:它的额度写在
    /// 一颗 `AXMenuItem` 身上 ——「SuperGrok 6%」,而整扇窗的静态字里一个百分号都没有)。
    /// 哪几种角色的 title 算数、以及**为什么不许全局打开**,见 `SendTextPolicy.titleRoles`。
    static func readTexts(bundleId: String, index: Int?, patterns: [SendTextPolicy.TextPattern],
                          maxVisits: Int = 24_000, unhideHidden: Bool = true,
                          includeTitles: Bool = false) -> [String: Any] {
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": SendTextPolicy.Failure.notAllowed(bundleId: bundleId).message]
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": SendTextPolicy.Failure.notRunning(bundleId: bundleId).message]
        }
        // 先敲门再读(Chromium 系不建树就读不到东西);一处写、处处用,见 AXWake。
        let appEl = AXWake.app(app.processIdentifier)
        // 藏着的先放出来(只放出来,不叫台前);**每一条返回路径**都照原样藏回去 —— 所以用 defer,
        // 别指望在四五个 return 前面各写一遍(漏一个就把他的应用永远留在外面了)。
        let wasHidden = app.isHidden && unhideHidden
        if wasHidden { app.unhide() }
        defer {
            if SendTextPolicy.shouldRehide(wasHidden: wasHidden, isActive: app.isActive) { app.hide() }
        }
        var all: [AXUIElement] = []
        var err: AXError = .success
        var looks = 0
        repeat {
            // 刚放出来那一下 AX 清单还没跟上(卡 MQ2 实测一两秒),所以先等一拍再看;
            // 没放出过谁就一眼都不等(`wasHidden == false` 时这个循环只走一遍,行为与原来一字不差)。
            if wasHidden { wait(ms: SendTextPolicy.unhideWaitMs) }
            var windowsRef: CFTypeRef?
            err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef)
            if err != .success { break }
            all = (windowsRef as? [AXUIElement]) ?? []
            looks += 1
        } while wasHidden && SendTextPolicy.worthAnotherUnhideLook(windows: all.count, looks: looks)
        if err != .success {
            return ["ok": false, "error": SendTextPolicy.Failure.axDisabled(bundleId: bundleId, err: err.rawValue).message]
        }
        let standard = all.filter { subrole(of: $0) == kAXStandardWindowSubrole as String }
        // 指名读第几扇:还是老那份「标准窗」清单(老服务端按它数窗口,语义一个字都不能变)。
        // 不指名(遍历):**每一扇都读**,包括不是标准窗的那几扇 —— 设置窗在有的 App 上是 AXDialog,
        // 按老规矩会被整个滤掉,而额度那几个字恰恰就在它上面。
        let windows = index == nil ? all : (standard.isEmpty ? all : standard)
        // 这个 App 这会儿是不是**还**被藏起来的。
        //
        // ★ 2026-09-26(卡 MQ2)为什么这一格要回:藏起来的 App,窗一扇都不在任何桌面上,
        // 辅助功能于是什么都读不到 —— 而「藏起来了」和「窗开在别的桌面上」要他做的下一步完全不同,
        // 不能都算成「在别的桌面上」,不然界面会让他去别的桌面找一扇根本不在那儿的窗
        // (D13:不编数,更不编一句让他白跑的话)。
        //
        // ★ 2026-09-26(卡 MQ3)口径变了:上面已经**先放出来再读**,所以这一格问的是
        // 「放出来这一下没成」(极少:App 刚好在退、或者系统不让)。**读成了就是 false** ——
        // 服务端据此不再说那句「它这会儿是藏起来的」,那件事壳已经替他做完了。
        // `app_unhidden` 是「本来藏着、工作台为了这一眼把它放出来又藏回去了」的记号,只给诊断看。
        let appHidden = app.isHidden
        let unhidden: [String: Any] = wasHidden ? ["app_unhidden": true] : [:]
        guard !windows.isEmpty else {
            return ["ok": false, "error": SendTextPolicy.Failure.noWindow(bundleId: bundleId).message,
                    "app_hidden": appHidden].merging(unhidden) { a, _ in a }
        }
        // NaN 记 0(Muse 的树里见过 NaN 矩形)。
        func i(_ v: CGFloat) -> Int { v.isFinite ? Int(v.rounded()) : 0 }
        let picked: [Int] = index == nil
            ? Array(windows.indices)
            : [(index! >= 0 && index! < windows.count) ? index! : 0]

        var matches: [[String: Any]] = []
        var sizes: [[String: Any]] = []
        var visited = 0
        var textNodes = 0
        var firstSize: [String: Any]?
        for at in picked {
            if visited >= maxVisits { break }
            let windowFrame = frame(of: windows[at])
            let nodes = staticTexts(in: windows[at], origin: windowFrame?.origin ?? .zero,
                                    budget: maxVisits - visited, visited: &visited,
                                    includeTitles: includeTitles)
            textNodes += nodes.count
            // 窗口宽高一起回:服务端据此认「顶栏最右那一格」(Manus 的积分在首页右上角)。
            let size: [String: Any] = ["w": i(windowFrame?.width ?? 0), "h": i(windowFrame?.height ?? 0)]
            if firstSize == nil { firstSize = size }
            let hits = SendTextPolicy.matchTexts(nodes, patterns: patterns)
            sizes.append(size.merging(["index": at, "matches": hits.count]) { a, _ in a })
            for var hit in hits {
                hit["window"] = at
                matches.append(hit)
            }
        }
        // `window` 还是第一扇的宽高(老服务端只认这一格);每一扇的在 `windows` 里。
        var result: [String: Any] = ["matches": matches, "window": firstSize ?? ["w": 0, "h": 0],
                                     "windows": sizes, "window_count": windows.count,
                                     "visited": visited, "text_nodes": textNodes,
                                     // 藏起来的 App 一扇窗都读不到(上面 `appHidden` 那段)。
                                     // 卡 MQ3 起这一格几乎永远是 false —— 藏着的已经被放出来读过了。
                                     "app_hidden": appHidden].merging(unhidden) { a, _ in a }
        // 辅助功能**只列这会儿显示着的那个桌面(Space)上的窗**:窗一旦不在这个桌面上就从 `AXWindows` 里
        // 消失(只剩主窗那一扇,subrole 还从 `AXStandardWindow` 降成 `AXDialog`)—— 于是
        // 「读过窗口,没找着那一格」和「那一格就开在另一个桌面上」在服务端长得一模一样。
        // 系统那份窗口清单**数得到**别的桌面上的窗,所以把数一起回,服务端才说得出
        // 「切到那个桌面、或把它拖过来再点一次」,而不是让他对着一句不对的话干瞪眼。
        //
        // ★ 2026-09-26(卡 MQ2):这个数是**真去数**「不在当前桌面上的有几扇」,
        // 不再拿「系统说有几扇 − AX 读到几扇」减 —— 减法会说错话,原因写在
        // `SendTextPolicy.offSpaceWindowCount` 上面。
        if let os = osWindows(pid: app.processIdentifier) {
            result["os_windows"] = SendTextPolicy.windowCount(os)
            let offSpace = SendTextPolicy.offSpaceWindowCount(os)
            if offSpace > 0 { result["offspace_windows"] = offSpace }
        }
        return ["ok": true, "result": result]
    }

    /// 这个进程的窗在系统那份窗口清单里:每扇的层 / 宽高 / **在不在这会儿显示着的那个桌面上**
    /// (别的桌面、别的显示器上的也数得到)。**一个标题都不读**(标题要屏幕录制授权,
    /// 而且聊天窗的标题多半就是他那条对话的名字)。清单读不出来回 nil —— 读不出来就不说那句话,不猜。
    ///
    /// 哪几条算「一扇窗」、其中几扇不在这个桌面上,都由 `SendTextPolicy` 判(纯函数,有单测);
    /// 这里只把系统那份清单翻译过去,一条判断不下。
    private static func osWindows(pid: pid_t) -> [SendTextPolicy.OSWindow]? {
        guard let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        // 「这会儿显示着的那个桌面」= 系统的 on-screen 那一份;不在这一份里的就是别的桌面上的窗
        // (最小化 / 藏起来的也不在,它们同样读不到,对用户来说是一件事:这会儿看不见)。
        let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        let onScreenIds = Set(onScreen.compactMap { $0[kCGWindowNumber as String] as? Int })
        var rows: [SendTextPolicy.OSWindow] = []
        for info in all {
            guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  let id = info[kCGWindowNumber as String] as? Int,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double else { continue }
            rows.append(SendTextPolicy.OSWindow(id: id, layer: layer, width: w, height: h,
                                               onSpace: onScreenIds.contains(id)))
        }
        return rows
    }

    /// 一扇窗里的文字流(`AXStaticText` 的 `AXValue`,按文档顺序;**输入框那一支整个跳过**)。
    /// `budget` 是这一扇最多走几个节点,走过多少累加进 `visited`(几扇窗合用一份预算)。
    ///
    /// `includeTitles`(2026-10-03,卡「Grok 读键字」)= 这一趟连「键身上的字」也收:
    /// 只收 `SendTextPolicy.titleRoles` 那两档(`AXMenuItem` / `AXButton`)的 `AXTitle`,
    /// **缺省一个都不收**。判「这一个节点的 title 这一趟读不读」的那条判断是纯函数、有用例
    /// (`SendTextPolicy.readsTitle`)—— 这里一条判断都不自己下。
    private static func staticTexts(in window: AXUIElement, origin: CGPoint, budget: Int,
                                    visited: inout Int,
                                    includeTitles: Bool = false) -> [SendTextPolicy.TextNode] {
        var nodes: [SendTextPolicy.TextNode] = []
        var walked = 0
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (node, depth) = stack.popLast(), walked < budget {
            walked += 1
            let role = stringAttr(node, kAXRoleAttribute) ?? ""
            if SendTextPolicy.inputRoles.contains(role) { continue }
            if role == kAXStaticTextRole as String,
               let value = stringAttr(node, kAXValueAttribute),
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let at = frame(of: node)?.origin ?? origin
                nodes.append(SendTextPolicy.TextNode(text: value, x: Double(at.x - origin.x), y: Double(at.y - origin.y)))
            }
            // 键身上那行字(只有按家声明的那一趟才收;位置照它自己那个矩形,与静态字同一种坐标)。
            if SendTextPolicy.readsTitle(role: role, includeTitles: includeTitles),
               let title = stringAttr(node, kAXTitleAttribute),
               !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let at = frame(of: node)?.origin ?? origin
                nodes.append(SendTextPolicy.TextNode(text: title, x: Double(at.x - origin.x), y: Double(at.y - origin.y)))
            }
            if depth >= maxDepth + 20 { continue }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let kids = childrenRef as? [AXUIElement] else { continue }
            for child in kids.reversed() { stack.append((child, depth + 1)) }
        }
        visited += walked
        return nodes
    }

    /// 文字流里"这里是输入框"的记号(不会出现在任何一家的界面文字里)。
    private static let inputSentinel = "\u{0}INPUT"

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
              let list = ref as? [AXUIElement] else { return [] }
        return list
    }

    /// 真把字放进框里那一下(AX 优先,写不进去或前端把它刷回去了就退到粘贴)。
    private static func deliver(found: Found, text: String, result: inout [String: Any]) -> SendTextPolicy.Failure? {
        let bundleId = found.app.bundleIdentifier ?? ""
        // 送字之前先把这扇窗叫到台前:键盘那条路非它不可(⌘V 发给的是前台应用),
        // AX 那条路其实不需要 —— 但两条路都激活,行为才只有一种,查起来也只有一种。
        found.app.activate(options: [.activateAllWindows])
        AXUIElementPerformAction(found.window, kAXRaiseAction as CFString)
        wait(ms: 250)

        let method = SendTextPolicy.method(for: found.pick) ?? .paste
        result["method"] = method.rawValue

        if method == .axValue {
            let err = AXUIElementSetAttributeValue(found.element, kAXValueAttribute as CFString, text as CFString)
            if err != .success {
                return .writeRejected(bundleId: bundleId, err: err.rawValue)
            }
            wait(ms: 120)
            let got = (stringValue(of: found.element) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            result["readback"] = got
            // **要求逐字相等,不是"包含"**。实测:这几家的输入框把 AXValue 的写当成追加,
            // "包含"这一档会把"框里现在是同一句话的两遍"判成成功 —— 那正是 Ben 会看到的样子。
            if SendTextPolicy.readbackMatches(got: got, sent: text) { return nil }
            // 写回来对不上:要么这个元素引用已经作废(见 sendText 顶上那段),要么前端
            // (React / Lexical 这类)把 AX 的赋值又刷回去了。**不当成功** ——
            // 退到键盘那条路再试一次,那条走的是真的输入事件,前端框架认它。
            result["ax_value_rejected"] = true
        }

        let pasted = pasteInto(found: found, text: text)
        result["method"] = SendTextPolicy.SendMethod.paste.rawValue
        result["clipboard_restored"] = pasted.clipboardRestored
        if !pasted.ok { return .clipboardFailed(bundleId: bundleId) }
        wait(ms: 150)
        // 整个输入区画成一颗按钮的那几家(Muse):按钮身上没有"框里的字"可读,核不了就如实说核不了。
        // 发没发出去由服务端之后在对话区里找那句话来判(找不到就说"没看到它发出去")。
        // 整个输入区画成一颗按钮的那几家(Muse)、以及自绘界面那个落点(2026-10-02):
        // 身上没有「框里的字」可读 —— **核不了就说核不了**,不许拿读回来的空串判成「对不上」。
        if found.candidates.indices.contains(pickedIndex(found.pick)),
           found.candidates[pickedIndex(found.pick)].composer || found.candidates[pickedIndex(found.pick)].drawn {
            result["readback_unavailable"] = true
            return nil
        }
        // 读不回值是常态(contenteditable 的 AXValue 常常是只读的空串),读得回来就核对,
        // 读不回来就如实说"核不了",不假装成功也不假装失败。
        guard let after = stringValue(of: found.element) else {
            // ★ 2026-09-24 实测(Codex,刚按完「New Chat」):**元素引用已经作废**时也读不回值,
            // 而那一下粘贴其实落空了 —— 当成"核不了 = 成功"就会按下一个空回车。
            // 分得清:连角色都读不出来 = 这个框已经被换掉了,算没送成,让 sendText 重新找一次再送。
            if stringAttr(found.element, kAXRoleAttribute) == nil {
                return .readbackMismatch(bundleId: bundleId, got: "(输入框刚被换掉了,读不回来)")
            }
            result["readback_unavailable"] = true
            return nil
        }
        let trimmed = after.trimmingCharacters(in: .whitespacesAndNewlines)
        result["readback"] = trimmed
        if SendTextPolicy.readbackMatches(got: trimmed, sent: text) { return nil }
        return .readbackMismatch(bundleId: bundleId, got: trimmed)
    }

    private static func pickedIndex(_ pick: SendTextPolicy.InputPick) -> Int {
        switch pick {
        case .writable(let i, _), .clickOnly(let i, _): return i
        case .none: return -1
        }
    }

    // MARK: - 找到那扇窗、那个框

    struct Found {
        let app: NSRunningApplication
        let window: AXUIElement
        let windowFrame: CGRect
        let element: AXUIElement
        let pick: SendTextPolicy.InputPick
        let pickedFrame: CGRect
        let candidates: [SendTextPolicy.InputCandidate]
        let why: String
    }

    enum LocateResult {
        case success(Found)
        case failure(SendTextPolicy.Failure)
    }

    static func locate(bundleId: String, index: Int) -> LocateResult {
        guard SendTextPolicy.isAllowed(bundleId) else { return .failure(.notAllowed(bundleId: bundleId)) }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return .failure(.notRunning(bundleId: bundleId))
        }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        // Chromium / Electron 的 AX 通道默认是关的(2026-09-18 取证:任何属性都回 -25211)。
        // 敲门(写 `AXManualAccessibility`)只有一处:`AXWake.knock`。原生应用没有这条属性,回 -25205,无害。
        AXWake.knock(appEl)

        /*
         * ★ 2026-09-28(卡 DP):**敲了门要给它时间把树建起来**。
         *
         * 真机现场:派给豆包第一次回「辅助功能通道关着:com.bot.pc.doubao 回 **-25204**」。
         * -25204 是 `kAXErrorCannotComplete` ——**不是**权限没给(那是 -25211),
         * 是刚敲完门、它那棵树还没长出来,这一下取窗口取不到。老代码取一次就判「通道关着」,
         * 于是把一个「再等 250ms 就好」的事说成了「去开辅助功能权限」。
         *
         * 所以:取不到就**再敲一次门、等一拍、重试**(`axWakeRetryDelaysMs`:250/600/1200ms)。
         * 三拍都取不到才如实回那个错码 —— 而那句话现在也说得清 -25204 与 -25211 不是一回事。
         */
        var windowsRef: CFTypeRef?
        var err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef)
        for delay in SendTextPolicy.axWakeRetryDelaysMs where err != .success {
            AXWake.knock(appEl)
            wait(ms: delay)
            windowsRef = nil
            err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef)
        }
        if err != .success {
            return .failure(.axDisabled(bundleId: bundleId, err: err.rawValue))
        }
        let all = (windowsRef as? [AXUIElement]) ?? []
        let standard = all.filter { subrole(of: $0) == kAXStandardWindowSubrole as String }
        let windows = standard.isEmpty ? all : standard
        guard !windows.isEmpty else { return .failure(.noWindow(bundleId: bundleId)) }
        let i = (index >= 0 && index < windows.count) ? index : 0
        let window = windows[i]
        guard let windowFrame = frame(of: window) else { return .failure(.noWindow(bundleId: bundleId)) }
        // 窗口上挂着对话框(存储 / 打开面板这类 AXSheet)→ 不送。焦点在那个框里,话会打进文件名。
        if children(window).contains(where: { stringAttr($0, kAXRoleAttribute) == "AXSheet" }) {
            return .failure(.sheetInTheWay(bundleId: bundleId))
        }

        var elements: [AXUIElement] = []
        var candidates: [SendTextPolicy.InputCandidate] = []
        var scanned = scan(appEl: appEl, window: window, windowFrame: windowFrame, elements: &elements, candidates: &candidates)
        if candidates.isEmpty {
            // 刚写完 AXManualAccessibility 的那一下,Chromium 还在把整棵网页 AX 树建起来 ——
            // 实测第一次扫到的是一棵只有外壳的树。等一拍再扫一次,**只补这一次**
            // (再没有就是真没有,不在这儿等下去)。
            wait(ms: 800)
            elements = []
            candidates = []
            scanned = scan(appEl: appEl, window: window, windowFrame: windowFrame, elements: &elements, candidates: &candidates)
        }
        lastScan = scanned

        let pick = SendTextPolicy.pickInput(candidates, window: windowFrame)
        switch pick {
        case .none(let reason):
            /*
             * ★ 2026-09-28(卡 DP):**找不到输入框时先问一句「是不是有层框挡着」**。
             * 判断全在 `SendTextPolicy`(纯函数、有单测),这里只把现场读出来。
             * 关得掉的那一种由 `sendText` 自己关掉再重来(`locateClosingModal`)—— `locate` 是只读的,
             * 探测能力、读额度那几条路也在用它,不能在这儿替她点键。
             */
            let scene = modalScene(window: window, windowFrame: windowFrame)
            if SendTextPolicy.looksLikeModalCover(roles: scene.roles, buttons: scene.buttons, coverRatio: scene.coverRatio) {
                return .failure(.modalInTheWay(bundleId: bundleId, hint: SendTextPolicy.modalHint(texts: scene.texts)))
            }
            if SendTextPolicy.looksLikeShellOnlyTree(buttons: scene.buttons, texts: scene.texts) {
                return .failure(.treeShellOnly(bundleId: bundleId))
            }
            /*
             * ★ **自绘界面:认不出位置就按窗口下部中央点一下**(2026-10-02,卡「适配自绘界面的 Kimi」)。
             *
             * 这一下是**兜底**,排在前面那两道之后 —— 有层框挡着、树只剩窗口壳,都不该在她窗口里乱点。
             * 闸是 `looksSelfDrawnTree`:这棵树一个标准输入角色都没有、认不出来的交互节点够多、还滚得动。
             * 一次「Electron 的树还没建好」过不了这道闸(那种满是 `AXGroup`、没有 `AXUnknown`)。
             *
             * 落点由 `bottomCenterInput` 算(窗口下部中央那一条,不贴底边);元素拿那扇窗自己 ——
             * 点的是落点中心,不是这个元素的中心(`focusElement` 用的是 `pickedFrame`)。
             * 只能点、不能写(`drawn: true` → `.clickOnly` → 粘贴),发完核不了就如实说核不了,
             * 发没发出去由服务端在对话区里找她那一句来判。
             */
            let roles = (lastScan["roles"] as? [String: Int]) ?? [:]
            if SendTextPolicy.looksSelfDrawnTree(roles: roles) {
                let box = SendTextPolicy.bottomCenterInput(window: windowFrame)
                var all = candidates
                all.append(SendTextPolicy.InputCandidate(role: "AXWindow", settable: false, focused: false,
                                                         frame: box, drawn: true))
                return .success(Found(app: app, window: window, windowFrame: windowFrame, element: window,
                                      pick: .clickOnly(index: all.count - 1, why: SendTextPolicy.drawnFallbackWhy),
                                      pickedFrame: box, candidates: all, why: SendTextPolicy.drawnFallbackWhy))
            }
            return .failure(.noInput(bundleId: bundleId, detail: reason))
        case .writable(let idx, let why), .clickOnly(let idx, let why):
            return .success(Found(app: app, window: window, windowFrame: windowFrame,
                                  element: elements[idx], pick: pick, pickedFrame: candidates[idx].frame,
                                  candidates: candidates, why: why))
        }
    }

    /// AX 树宽度优先铺开。两道闸都是**为了不在一棵大树上卡住主线程**。
    ///
    /// 数字是**实测定的,不是拍的**:这几家的输入框都在网页 AX 树里,层数远比原生界面深
    /// (Claude 实测 22 层、Kimi 18 层)。深度 14 那一版一个输入框都找不到,而窗口那一层
    /// 到输入框之间几乎全是 AXGroup。所以放到 40 层 / 12000 个节点 ——
    /// 一棵这么大的树扫完实测在百毫秒量级,够用也卡不住。
    private static let maxDepth = 40
    private static let maxNodes = 12_000

    /// 上一次扫描的现场读数(扫了几个节点、封顶没有)。只为让"找不到输入框"这句话
    /// 说得出下一句该查什么,不参与任何判定。
    private(set) static var lastScan: [String: Any] = [:]

    /// 先问焦点元素,再扫整棵树。
    ///
    /// **焦点优先是一条捷径,不是另一套规则**:这几家客户端打开就把光标放在输入框里,
    /// 问一次 `AXFocusedUIElement` 就拿到了,不用铺开整棵网页树。问不出来(或者焦点不是
    /// 文本元素)才扫树 —— 挑哪一个仍然由 `SendTextPolicy.pickInput` 说了算。
    private static func scan(appEl: AXUIElement, window: AXUIElement, windowFrame: CGRect,
                             elements: inout [AXUIElement],
                             candidates: inout [SendTextPolicy.InputCandidate]) -> [String: Any] {
        var focusedRole = "无"
        var focusedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
           let focused = focusedRef, CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let element = focused as! AXUIElement
            if let role = stringAttr(element, kAXRoleAttribute) {
                focusedRole = role
                if SendTextPolicy.inputRoles.contains(role) {
                    elements.append(element)
                    candidates.append(SendTextPolicy.InputCandidate(
                        role: role,
                        settable: isSettable(element, kAXValueAttribute),
                        focused: true,
                        frame: frame(of: element) ?? .zero))
                }
            }
        }
        var roles: [String: Int] = [:]
        let visited = collect(window, depth: 0, windowFrame: windowFrame,
                              elements: &elements, candidates: &candidates, roles: &roles)
        // `roles`(2026-10-02):自绘界面那条兜底的闸要它(`SendTextPolicy.looksSelfDrawnTree`)。
        // 只数不读,和 `agent_probe` 的 `roles` 同一个意思。
        return ["visited": visited, "capped": visited >= maxNodes, "focused_role": focusedRole,
                // 留 40 种(默认 16 种会把 AXScrollArea 这类少数角色挤掉 —— 自绘那道闸正要看它)。
                "candidates": candidates.count, "roles": AgentWindowPolicy.roleHistogram(roles, max: 40)]
    }

    @discardableResult
    private static func collect(_ element: AXUIElement, depth: Int, windowFrame: CGRect,
                                elements: inout [AXUIElement],
                                candidates: inout [SendTextPolicy.InputCandidate],
                                roles: inout [String: Int]) -> Int {
        if depth > maxDepth || elements.count >= maxNodes { return 0 }
        var queue: [(AXUIElement, Int)] = [(element, depth)]
        var visited = 0
        while !queue.isEmpty && visited < maxNodes {
            let (node, d) = queue.removeFirst()
            visited += 1
            // 角色**只问一次**(2026-10-02):下面三支都要它,一棵一万节点的树上多问两遍就是两万次来回。
            let nodeRole = stringAttr(node, kAXRoleAttribute)
            if let role = nodeRole, !role.isEmpty { roles[role, default: 0] += 1 }
            if d > 0, let role = nodeRole, SendTextPolicy.inputRoles.contains(role) {
                let f = frame(of: node) ?? .zero
                elements.append(node)
                candidates.append(SendTextPolicy.InputCandidate(
                    role: role,
                    settable: isSettable(node, kAXValueAttribute),
                    focused: boolAttr(node, kAXFocusedAttribute) ?? false,
                    frame: f))
            } else if d > 0, nodeRole == kAXButtonRole as String,
                      SendTextPolicy.looksLikeComposerButton(title: stringAttr(node, kAXTitleAttribute)) {
                // Muse:整个输入区是一颗按钮(见 SendTextPolicy.looksLikeComposerButton)。只能点、不能写。
                elements.append(node)
                candidates.append(SendTextPolicy.InputCandidate(
                    role: kAXButtonRole as String, settable: false, focused: false,
                    frame: frame(of: node) ?? .zero, composer: true))
            } else if d > 0, let role = nodeRole,
                      SendTextPolicy.drawnInputRoles.contains(role), let f = frame(of: node),
                      SendTextPolicy.looksLikeDrawnInputShape(role: role, frame: f, window: windowFrame) {
                /*
                 * ★ **自绘界面的输入框**(2026-10-02,卡「适配自绘界面的 Kimi」)。
                 * 形状先过(上一行,不花 IPC),过了才去问「动得了吗」—— 一棵自绘的树上几十个
                 * `AXUnknown`,每个都问一遍动作名是几十次来回。只能点、不能写(`drawn: true`)。
                 */
                let pressable = actionNames(node).contains(kAXPressAction as String)
                if SendTextPolicy.looksLikeDrawnInput(role: role, frame: f, window: windowFrame,
                                                      settable: isSettable(node, kAXValueAttribute),
                                                      focusable: isSettable(node, kAXFocusedAttribute),
                                                      pressable: pressable) {
                    elements.append(node)
                    candidates.append(SendTextPolicy.InputCandidate(
                        role: role, settable: false, focused: boolAttr(node, kAXFocusedAttribute) ?? false,
                        frame: f, drawn: true))
                }
            }
            if d >= maxDepth { continue }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { continue }
            for child in children { queue.append((child, d + 1)) }
        }
        return visited
    }

    // MARK: - 动作

    /// 点一下输入框并把焦点给它。两条路都走:`AXFocused` 写不进去的(contenteditable 常见)
    /// 就真点一下鼠标 —— 点的是它自己的矩形中心,不是屏幕上某个猜出来的坐标。
    private static func focusElement(_ element: AXUIElement, app: NSRunningApplication, frame: CGRect) -> Bool {
        app.activate(options: [.activateAllWindows])
        let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if err == .success, boolAttr(element, kAXFocusedAttribute) == true { return true }
        guard frame.width > 0, frame.height > 0 else { return false }
        click(at: CGPoint(x: frame.midX, y: frame.midY))
        wait(ms: 120)
        return boolAttr(element, kAXFocusedAttribute) ?? false
    }

    private static func pasteInto(found: Found, text: String) -> (ok: Bool, clipboardRestored: Bool) {
        let saved = saveClipboard()
        let pb = NSPasteboard.general
        pb.clearContents()
        guard pb.setString(text, forType: .string) else {
            let restored = restoreClipboard(saved)
            return (false, restored)
        }
        let idx = pickedIndex(found.pick)
        /*
         * **这两类都得真点一下,不能只给 AX 焦点**:
         * - `composer`(Muse):整个输入区画成一颗按钮 —— 给这颗"按钮"AX 焦点,键盘焦点并不会进到
         *   里面那个打字的框(2026-09-24 实测:焦点报在按钮上,粘贴落空);
         * - `drawn`(2026-10-02,自绘界面):`AXFocused` 在自绘的控件上本来就不作数;**兜底那一下更是**——
         *   元素拿的是那扇窗自己,把 `AXFocused` 写给一扇窗是「让这扇窗成为焦点窗」,会**成功**,
         *   于是 `focusElement` 当成办好了、一下都不点,⌘V 就落空了。
         *
         * 点在矩形里**偏左**的地方:右边那一截是附件 / 语音 / 发送几颗小键。
         */
        if found.candidates.indices.contains(idx),
           found.candidates[idx].composer || found.candidates[idx].drawn {
            found.app.activate(options: [.activateAllWindows])
            let f = found.pickedFrame
            click(at: CGPoint(x: f.minX + f.width * 0.3, y: f.midY))
        } else {
            _ = focusElement(found.element, app: found.app, frame: found.pickedFrame)
        }
        wait(ms: 120)
        // 先全选:这一下让粘贴变成**替换**而不是追加(框里可能还留着上一次没成的半截)。
        // 框里本来是空的时候全选什么也不选,无害。
        keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_A), flags: .maskCommand)
        wait(ms: 60)
        keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
        wait(ms: 200)
        let restored = restoreClipboard(saved)
        return (true, restored)
    }

    /**
     把一段字写进**指定的那一个**输入框(2026-09-28,卡 AT:往那家提问面板里那个自由作答框写她那句话)。

     与 `sendText` 那一路的差别只有一处:**框是调用方挑的**,这里不挑框、不按发送。
     (挑框那件事在 `AgentWindowPolicy.pickAskField` —— 弄错了就是把她的话写进主输入框,
     所以那一段判断全是纯函数、有用例;这里只管把字送进去。)

     两条路,同 `SendTextPolicy.SendMethod`:`AXValue` 写得进去就写(不碰键盘、不碰剪贴板);
     写不进去就点它一下、全选、⌘V 粘贴 —— **她的剪贴板先存后还**,还不回去如实回
     `clipboardRestored: false`。写完读一眼:读得出值而里面没有她那句 → `ok: false`(不假装写进去了)。
     */
    static func writeInto(element: AXUIElement, frame: CGRect, app: NSRunningApplication, text: String)
    -> (ok: Bool, how: SendTextPolicy.SendMethod, clipboardRestored: Bool) {
        app.activate(options: [.activateAllWindows])
        if isSettable(element, kAXValueAttribute),
           AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success {
            wait(ms: 120)
            if let now = stringValue(of: element), now.contains(text) { return (true, .axValue, true) }
            // 写回来不是那句(有的前端把 AXValue 当只读、或者自己又重画了一遍)—— 退到粘贴那条路。
        }
        let saved = saveClipboard()
        let pb = NSPasteboard.general
        pb.clearContents()
        guard pb.setString(text, forType: .string) else {
            return (false, .paste, restoreClipboard(saved))
        }
        _ = focusElement(element, app: app, frame: frame)
        wait(ms: 120)
        // 先全选:这一下让粘贴变成**替换**而不是追加(框里可能还留着上一次没成的半截)。
        keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_A), flags: .maskCommand)
        wait(ms: 60)
        keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
        wait(ms: 250)
        let restored = restoreClipboard(saved)
        // 读得出值就核一眼;读不出值的(contenteditable 那几种)按"写进去了"算,
        // 发完之后调用方还要核「那一问没了 + 对话区出现她那句」,核不上不会说成答上了。
        if let now = stringValue(of: element) { return (now.contains(text), .paste, restored) }
        return (true, .paste, restored)
    }

    /**
     按发送之前**一定要让那一家在台前**(2026-09-28,卡 WR)。

     统筹 09-28 10:07 真机(维护者本机 + Manus):字用 AX 写进了输入框(`method: ax_value`),
     可回车与 `AXPress` 都没让它发出去 —— `submitted: false`。缘由是这一条:
     - 回车走的是 `CGEvent`,它发给**台前那一家**。Manus 不在台前时那一下**根本没进 Manus**
       (甚至可能落进别人的窗口 —— 比发不出去更糟);
     - Electron 那几家(Manus / 豆包)在后台时 AX 的 `AXPress` / `AXConfirm` 常常也不生效:
       它们的渲染进程要窗口是 key window 才接这一下。

     所以这一下:叫到台前(两条路都走:`activate` 与 `AXFrontmost`)→ **核一眼真到了台前**
     (`NSWorkspace.frontmostApplication`)→ 到了才按。到不了台前就回 `false`,
     调用方据此**不按发送**、如实回「字写进去了没发出去」。
     */
    private static func frontForSubmit(_ app: NSRunningApplication) -> Bool {
        frontForWindowAction(app)
    }

    /// 同上,给壳里**别的动手动作**用(`agent_pick` 在侧栏里点那条对话、`agent_stop` 按停止键):
    /// 后台点不动,而鼠标事件在后台还可能落到别人窗口上 —— 一处写、处处用。
    static func frontForWindowAction(_ app: NSRunningApplication) -> Bool {
        let bundleId = app.bundleIdentifier ?? ""
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId { return true }
        let appEl = AXWake.app(app.processIdentifier)
        for attempt in 0..<3 {
            app.activate(options: [.activateAllWindows])
            AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            wait(ms: attempt == 0 ? 250 : 400)
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId { return true }
        }
        return false
    }

    /// 送之前量好的那一份底子(2026-10-13,卡 SC)。
    struct Echo {
        /// 去对话区找的那一截字(送出去那段话的开头)。
        let needle: String
        /// **送之前**窗口里有没有它。有(她上回发过同一句)→ 对话区那一档一律不算,那是旧的那一条。
        let before: Bool
        /// 写**之前**框里读回来的那个值(这一版豆包是那句占位符,见 `SendTextPolicy.valueBackToBefore`)。
        /// 只在内存里比一比,不报给调用方、不进日志 —— 框里的内容是她的东西。
        let valueBefore: String?
        /// 这一趟送出去的那段字(比「框回到写之前那个样子」时要排掉「本来就是同一段」那一次)。
        let sent: String
    }

    private struct SubmitOutcome {
        let ok: Bool
        let method: SendTextPolicy.SubmitMethod
        /// 哪一档核出来的(`nil` = 两档都没核上,如实报没发)。
        let by: SendTextPolicy.SubmitProof?
        /// 这一趟在核对上一共等了多久(回包里的 `waited_ms`)。
        let waitedMs: Int
    }

    private static func performSubmit(found: Found, echo: Echo?) -> SubmitOutcome {
        let bundleId = found.app.bundleIdentifier ?? ""
        // ★ 见 frontForSubmit:那家不在台前时这三条路全不算数(而回车会落到别人窗口里)。
        guard frontForSubmit(found.app) else { return SubmitOutcome(ok: false, method: .returnKey, by: nil, waitedMs: 0) }
        var waited = 0
        // ★ 2026-09-24 实测(Codex):`AXPress` 那颗 Send 回了 success,话却还在框里 —— 前端只认真的点击/回车。
        // 所以每一条路按完都**核一次发出去了没有**,没核上就走下一条;三条都没核上,才如实报没发出去。
        // 核法见 `confirmSubmit`(卡 SC:轮询到 3 秒,再去对话区找那句话 —— 老代码只等 600ms 读一次)。
        // ① 元素自己的 AXConfirm —— 不经过键盘,输入法碰不到它。
        if actionNames(found.element).contains(kAXConfirmAction as String),
           AXUIElementPerformAction(found.element, kAXConfirmAction as CFString) == .success {
            let confirm = confirmSubmit(after: found, bundleId: bundleId,
                                        budgetMs: SendTextPolicy.submitConfirmEarlyTotalMs, echo: echo)
            waited += confirm.waitedMs
            if let by = confirm.proof { return SubmitOutcome(ok: true, method: .axConfirm, by: by, waitedMs: waited) }
        }
        // ② 界面上那颗"发送"按钮。认不出就走下一条,**绝不乱点**(见 looksLikeSendButton)。
        if let button = findSendButton(in: found.window),
           AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
            let confirm = confirmSubmit(after: found, bundleId: bundleId,
                                        budgetMs: SendTextPolicy.submitConfirmEarlyTotalMs, echo: echo)
            waited += confirm.waitedMs
            if let by = confirm.proof { return SubmitOutcome(ok: true, method: .sendButton, by: by, waitedMs: waited) }
        }
        // ③ 回车(键盘)。先把焦点放回输入框:前两条路可能把焦点挪走了。
        let idx = pickedIndex(found.pick)
        // composer 那颗按钮点第二下会弹出别的面板,所以不点;自绘那个落点照点 —— 点一下只是把焦点放回输入框。
        if !(found.candidates.indices.contains(idx) && found.candidates[idx].composer) {
            if found.candidates.indices.contains(idx), found.candidates[idx].drawn {
                // 同 pasteInto:自绘那一类 `AXFocused` 不作数(兜底那一下的元素还是那扇窗),真点一下。
                found.app.activate(options: [.activateAllWindows])
                let f = found.pickedFrame
                click(at: CGPoint(x: f.minX + f.width * 0.3, y: f.midY))
            } else {
                _ = focusElement(found.element, app: found.app, frame: found.pickedFrame)
            }
            wait(ms: 80)
        }
        // Muse 要 ⌘回车(见 SendTextPolicy.commandReturnBundleIds);别家就是回车。
        keyDownUp(virtualKey: CGKeyCode(kVK_Return), flags: SendTextPolicy.submitNeedsCommand(bundleId) ? .maskCommand : [])
        // 最后这一条拿满时限(前两条只拿 early 那一份,见 submitConfirmEarlyTotalMs)。
        let confirm = confirmSubmit(after: found, bundleId: bundleId,
                                    budgetMs: SendTextPolicy.submitConfirmTotalMs, echo: echo)
        waited += confirm.waitedMs
        return SubmitOutcome(ok: confirm.proof != nil, method: .returnKey, by: confirm.proof, waitedMs: waited)
    }

    /**
     **按完发送之后核一眼:发出去了没有**(2026-10-13,卡 SC —— 老代码在这里只等 600ms 读一次,
     把「清框慢」读成了「没发出去」,见 `SendTextPolicy.submitConfirmTotalMs` 上面那段现场)。

     三档(每 `submitConfirmStepMs` 看一次,最多 `budgetMs`):
     1. 框空了(`isEmptyInput`);
     2. 框没「空」但**回到了写之前那个样子**(`SendTextPolicy.valueBackToBefore` —— 这一版豆包发完
        读回来的是那句认不出的占位符);
     3. 去**对话区**找送出去那段话(她那句话的气泡)。只认「送之前没有、送之后出现」那一条
        (`Echo.before`);等到一半先查一眼(`echoCheckDue`),到点再查一次。

     三档都没核上才回 `nil`(调用方据此如实报没发 —— 「宁可报没发」的分寸就在这里)。
     */
    private static func confirmSubmit(after found: Found, bundleId: String, budgetMs: Int, echo: Echo?)
        -> (proof: SendTextPolicy.SubmitProof?, waitedMs: Int) {
        var waited = 0
        /// 对话区那一档半途看过一眼没有(看一眼要走一趟树,一趟就够,见 `echoCheckDue`)。
        var echoTried = false
        for step in SendTextPolicy.confirmSteps(totalMs: budgetMs) {
            wait(ms: step)
            waited += step
            let now = inputState(after: found, bundleId: bundleId)
            let back = SendTextPolicy.valueBackToBefore(now: now.value, before: echo?.valueBefore,
                                                        sent: echo?.sent ?? "")
            if let proof = SendTextPolicy.submitProof(inputCleared: now.cleared, valueBackToBefore: back,
                                                      echoBefore: false, echoAfter: false) {
                return (proof, waited)
            }
            if !echoTried, SendTextPolicy.echoCheckDue(waitedMs: waited, budgetMs: budgetMs) {
                echoTried = true
                if let proof = echoProof(found: found, bundleId: bundleId, echo: echo) { return (proof, waited) }
            }
        }
        return (echoProof(found: found, bundleId: bundleId, echo: echo), waited)
    }

    /// 第三档:去**对话区**找送出去那段话(发出去的那一刻她那句会出现在右侧气泡里)。
    /// 只认「送之前没有、送之后出现」那一条(`Echo.before`)—— 送之前就有的是旧的那一条,
    /// 连树都不必走。
    private static func echoProof(found: Found, bundleId: String, echo: Echo?) -> SendTextPolicy.SubmitProof? {
        guard let echo, !echo.before else { return nil }
        // 窗口与框的位置都重新取一次:发出去那一下前端常常把整个输入区重画一遍(框还会长高 ——
        // 拿写之前那个矩形去排,长出来那一截里的字就漏成了「对话区里出现了」)。
        var window = found.window
        var inputFrame = found.pickedFrame
        if case .success(let fresh) = locate(bundleId: bundleId, index: 0) {
            window = fresh.window
            inputFrame = fresh.pickedFrame
        }
        let seen = seesSentText(window: window, needle: echo.needle, skipping: inputFrame)
        return SendTextPolicy.submitProof(inputCleared: false, echoBefore: false, echoAfter: seen)
    }

    /**
     那扇窗上此刻看得见送出去那段话没有(第二档,卡 SC)。

     **输入框那一块里的字不算** —— 没发出去的时候那段字正躺在框里,把它读进来就是自己给自己盖章。
     按几何排除(框的位置刚量过):中点落在框里的节点一概不看。走法与找那个提问面板同一份上限
     (`AgentWindowPolicy.askScanMax*`:节点数与时限都封了顶)。
     */
    private static func seesSentText(window: AXUIElement, needle: String, skipping inputFrame: CGRect) -> Bool {
        let started = CFAbsoluteTimeGetCurrent()
        var visited = 0
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        while let (element, depth) = stack.popLast() {
            if visited >= AgentWindowPolicy.askScanMaxVisited
                || (CFAbsoluteTimeGetCurrent() - started) * 1000 > AgentWindowPolicy.askScanMaxMs { break }
            visited += 1
            if let box = frame(of: element), SendTextPolicy.insideInput(node: box, input: inputFrame) { continue }
            let texts = [stringValue(of: element), stringAttr(element, kAXTitleAttribute),
                         stringAttr(element, kAXDescriptionAttribute)].compactMap { $0 }
            if texts.contains(where: { SendTextPolicy.mentionsSentText(hay: $0, needle: needle) }) { return true }
            if depth >= maxDepth { continue }
            for child in children(element) { stack.append((child, depth + 1)) }
        }
        return false
    }

    /// 按完发送之后,框此刻**空没空**、里面读回来**是什么**。元素引用作废了就重新找一次再看 ——
    /// 发出去那一下前端常常把整个输入区重画一遍。**读不出来按"没空"算**:宁可多试一条路,
    /// 也不把一段还躺在框里的话报成"已发送"。
    /// 那个值只给 `SendTextPolicy.valueBackToBefore` 比一比,**不报给调用方、不进日志**。
    ///
    /// **这里不等** —— 等多久、看几次由 `confirmSubmit` 定(卡 SC)。
    private static func inputState(after found: Found, bundleId: String) -> (cleared: Bool, value: String?) {
        /*
         * 原来那个元素**只信它说「框空了」那一句**(2026-10-13 真机,卡 SC):这一版豆包发出去之后
         * 把输入区整片重画了,旧引用照旧答得出话 —— 答的却是重画**之前**那个值(「你好」)。
         * 老代码只在旧引用彻底作废时才重新找,于是轮询满三秒每一拍读到的都是那段字,
         * 「发出去了」只能靠对话区那一档兜住(真读数:`confirmed_by:echo_in_chat`、`waited_ms:3000`)。
         */
        if stringAttr(found.element, kAXRoleAttribute) != nil, let value = stringValue(of: found.element),
           isEmptyInput(found.element, bundleId: bundleId) {
            return (true, value)
        }
        guard case .success(let fresh) = locate(bundleId: bundleId, index: 0) else {
            // 重新找不到那个框(窗口没了 / 挡着一层框):只能照原来那个元素读到的算。
            return (false, stringValue(of: found.element))
        }
        guard let value = stringValue(of: fresh.element) else {
            // 那种只能点的输入区(Muse 那颗按钮)本来就读不出值:核不了,如实当"发出去了"。
            // 服务端之后会在对话区里找那句话,找不到就说"没看到它发出去"。
            return (fresh.candidates.indices.contains(0) && fresh.pickedFrame != .zero && !(fresh.pick.isWritable), nil)
        }
        return (isEmptyInput(fresh.element, bundleId: bundleId), value)
    }

    private static func findSendButton(in window: AXUIElement) -> AXUIElement? {
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty && visited < maxNodes {
            let (node, d) = queue.removeFirst()
            visited += 1
            if d > 0, stringAttr(node, kAXRoleAttribute) == kAXButtonRole as String,
               SendTextPolicy.looksLikeSendButton(title: stringAttr(node, kAXTitleAttribute),
                                                  description: stringAttr(node, kAXDescriptionAttribute)) {
                return node
            }
            if d >= maxDepth { continue }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { continue }
            for child in children { queue.append((child, d + 1)) }
        }
        return nil
    }

    // MARK: - 挡在前面那一层框(2026-09-28,卡 DP)

    /// 一扇窗此刻的「有没有框挡着」现场。判断不在这里(全在 `SendTextPolicy`),这里只把它读出来。
    struct ModalScene {
        /// 树里出现过的模态角色 / subrole(只记 `SendTextPolicy.modalRoles` 里那几个)。
        var roles: [String] = []
        /// 树里那几颗键(带 subrole,窗口自己的控件由判断那一侧排除)。
        var buttons: [SendTextPolicy.ModalButton] = []
        /// 按钮元素,与 `buttons` 一一对应(要按哪一颗由 `modalVerdict` 说)。
        var buttonElements: [AXUIElement] = []
        /// 读到的那几段字(念给她听时取第一句)。
        var texts: [String] = []
        /// 盖住这扇窗最大的那一块占窗口的比例;算不出来就缺席。
        var coverRatio: Double?
    }

    /// 把这扇窗的现场读出来。**上限比找输入框那一趟小**(只要按钮、几段字和最大那块遮罩),
    /// 走到这里时已经确定没有输入框了,不值得再铺一棵大树。
    static func modalScene(window: AXUIElement, windowFrame: CGRect) -> ModalScene {
        var scene = ModalScene()
        let windowArea = windowFrame.width * windowFrame.height
        var biggestCover: Double = 0
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty && visited < 4000 {
            let (node, d) = queue.removeFirst()
            visited += 1
            let role = stringAttr(node, kAXRoleAttribute)
            let sub = subrole(of: node)
            for one in [role, sub].compactMap({ $0 }) where SendTextPolicy.modalRoles.contains(one) {
                if !scene.roles.contains(one) { scene.roles.append(one) }
            }
            if d > 0, role == kAXButtonRole as String, scene.buttons.count < 24 {
                scene.buttons.append(SendTextPolicy.ModalButton(title: stringAttr(node, kAXTitleAttribute),
                                                                description: stringAttr(node, kAXDescriptionAttribute),
                                                                subrole: sub))
                scene.buttonElements.append(node)
            }
            if d > 0, role == kAXStaticTextRole as String, scene.texts.count < 12,
               let text = stringValue(of: node) ?? stringAttr(node, kAXTitleAttribute),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                scene.texts.append(text)
            }
            // 遮罩:盖住主区域的一整块。**整棵树的根那几层不算**(网页那一层本来就铺满窗口),
            // 所以只看 ≤0.98 的那些 —— 真正的遮罩会给弹框留边,或者盖住窗口的大半而不是全部。
            if d >= 2, windowArea > 0, let box = frame(of: node) {
                let ratio = (box.intersection(windowFrame).width * box.intersection(windowFrame).height) / windowArea
                if ratio > biggestCover && ratio <= 0.98 { biggestCover = ratio }
            }
            if d >= maxDepth { continue }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { continue }
            for child in children { queue.append((child, d + 1)) }
        }
        if biggestCover > 0 { scene.coverRatio = biggestCover }
        return scene
    }

    /// 上一次送话的过程里**替她关掉过一层框**没有(如实回给工作台,不偷偷做完不说)。
    private(set) static var lastModalClosed: String?

    /// 找框、按那一颗纯关闭键。回 `true` = 真按了(按完还要重新 locate 才算数)。
    /// **只按 `modalVerdict` 指的那一颗**;它说 `giveUp` 就一颗都不按。
    private static func dismissModal(bundleId: String, index: Int) -> (closed: Bool, hint: String?) {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return (false, nil)
        }
        let appEl = AXWake.app(app.processIdentifier)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let all = windowsRef as? [AXUIElement], !all.isEmpty else { return (false, nil) }
        let standard = all.filter { subrole(of: $0) == kAXStandardWindowSubrole as String }
        let windows = standard.isEmpty ? all : standard
        let window = windows[(index >= 0 && index < windows.count) ? index : 0]
        guard let windowFrame = frame(of: window) else { return (false, nil) }
        let scene = modalScene(window: window, windowFrame: windowFrame)
        let hint = SendTextPolicy.modalHint(texts: scene.texts)
        let looks = SendTextPolicy.looksLikeModalCover(roles: scene.roles, buttons: scene.buttons, coverRatio: scene.coverRatio)
        guard case .close(let at) = SendTextPolicy.modalVerdict(looksModal: looks, buttons: scene.buttons),
              scene.buttonElements.indices.contains(at) else { return (false, hint) }
        let pressed = AXUIElementPerformAction(scene.buttonElements[at], kAXPressAction as CFString) == .success
        guard pressed else { return (false, hint) }
        let title = [scene.buttons[at].title, scene.buttons[at].description].compactMap { $0 }.first ?? "关闭"
        lastModalClosed = "它窗口上弹着的那个框(\(hint ?? "读不到标题"))挡住了输入框,我按「\(title)」把它关掉了再送"
        wait(ms: 600)
        return (true, hint)
    }

    /// 找输入框 —— **挡着的那层框关得掉就关掉再找**(送话那条路专用;只读那几条路照旧用 `locate`)。
    static func locateClosingModal(bundleId: String, index: Int) -> LocateResult {
        let first = locate(bundleId: bundleId, index: index)
        guard case .failure(let failure) = first else { return first }
        switch failure {
        case .modalInTheWay, .treeShellOnly:
            let closed = dismissModal(bundleId: bundleId, index: index)
            guard closed.closed else {
                // 关不掉 / 认不准 → 如实说一句人话(话在 `SendTextPolicy.Failure`),**不硬送**。
                if case .treeShellOnly = failure, closed.hint == nil { return first }
                return .failure(.modalInTheWay(bundleId: bundleId, hint: closed.hint))
            }
            return locate(bundleId: bundleId, index: index)
        default:
            return first
        }
    }

    // MARK: - 剪贴板(先存后还)

    /// 用户的剪贴板是他的东西。存的是**所有** item 的所有类型,不是只存一个字符串 ——
    /// 他剪贴板里可能是一张图、一个文件。还不回去时如实报 `clipboard_restored:false`。
    private static func saveClipboard() -> [[NSPasteboard.PasteboardType: Data]] {
        let pb = NSPasteboard.general
        return (pb.pasteboardItems ?? []).map { item in
            var copy: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { copy[type] = data }
            }
            return copy
        }
    }

    private static func restoreClipboard(_ saved: [[NSPasteboard.PasteboardType: Data]]) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        if saved.isEmpty { return true }
        let items: [NSPasteboardItem] = saved.compactMap { dict in
            guard !dict.isEmpty else { return nil }
            let item = NSPasteboardItem()
            for (type, data) in dict { item.setData(data, forType: type) }
            return item
        }
        guard !items.isEmpty else { return true }
        return pb.writeObjects(items)
    }

    // MARK: - 键盘 / 鼠标(CGEvent)

    private static func keyDownUp(virtualKey: CGKeyCode, flags: CGEventFlags) {
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    /// 全选 + 删除。清空一个 contenteditable 输入框唯一可靠的办法(见 `clearInput`)。
    private static func selectAllAndDelete() {
        keyDownUp(virtualKey: CGKeyCode(kVK_ANSI_A), flags: .maskCommand)
        wait(ms: 60)
        keyDownUp(virtualKey: CGKeyCode(kVK_Delete), flags: [])
    }

    /// 点一下(给 `AgentWindow.pick` / `AgentWindow.stop` 用;**调用方必须先把那家叫到台前**)。
    static func clickAt(_ point: CGPoint) { click(at: point) }

    private static func click(at point: CGPoint) {
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    static func currentInputSourceID() -> String {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "未知" }
        return Unmanaged<CFString>.fromOpaque(ptr).takeUnretainedValue() as String
    }

    // MARK: - 小工具

    private static func restoreFrontIfNeeded(_ restore: Bool, _ previousFront: String?, _ result: inout [String: Any]) {
        guard restore, let previousFront,
              let app = NSRunningApplication.runningApplications(withBundleIdentifier: previousFront).first else { return }
        app.activate(options: [.activateAllWindows])
        result["restored_front"] = true
        result["previous_front"] = previousFront
    }

    private static func describe(_ found: Found) -> [String: Any] {
        [
            "bundle_id": found.app.bundleIdentifier ?? "",
            "window_frame": rectJSON(found.windowFrame),
            "picked": [
                "why": found.why,
                // 框里现在是不是空的。**只报空不空,不报内容** —— 那是用户没发出去的草稿,
                // 我们没有任何理由把它读进日志里。送话之前要看这一格:
                // 人家框里有半截没写完的话,我们一写就把它覆盖掉了。
                "empty": isEmptyInput(found.element, bundleId: found.app.bundleIdentifier ?? ""),
                // 只报长度与**占位符**(占位符是应用自己的界面文案,不是用户写的东西)。
                // 有的实现把占位符当成 AXValue 报出来,不减掉这一层就会把每个空框都当成"有草稿"。
                "value_len": (stringValue(of: found.element) ?? "").count,
                "placeholder": stringAttr(found.element, kAXPlaceholderValueAttribute) ?? "",
                // 元素自己的标题/描述(界面文案,不是用户写的东西)。有的前端把"输入你的问题"
                // 这句放在 AXDescription 而不是 AXPlaceholderValue 上。
                "title": stringAttr(found.element, kAXTitleAttribute) ?? "",
                "desc": stringAttr(found.element, kAXDescriptionAttribute) ?? "",
                "frame": rectJSON(found.pickedFrame),
                "writable": { if case .writable = found.pick { return true } else { return false } }(),
            ] as [String: Any],
            "scan": lastScan,
            "candidates": found.candidates.map { c in
                ["role": c.role, "settable": c.settable, "focused": c.focused, "frame": rectJSON(c.frame)] as [String: Any]
            },
        ]
    }

    /// ★ 非有限的数(NaN / ∞)**不许**转 Int —— Swift 在这里直接陷入,整个壳会崩(2026-09-24 实测:
    /// Muse 那扇窗的 AX 树里就有矩形是 NaN 的元素,探路工具在同一行崩过)。读不出来的记 0。
    private static func rectJSON(_ r: CGRect) -> [String: Any] {
        func i(_ v: CGFloat) -> Int { v.isFinite ? Int(v.rounded()) : 0 }
        return ["x": i(r.origin.x), "y": i(r.origin.y), "w": i(r.width), "h": i(r.height)]
    }

    /// 主线程上的短等待。**不用 `Thread.sleep`**:壳的 `/helper` 回调就跑在主线程上,
    /// 睡死了这几百毫秒里连 WS 的 ping 都收不到。跑一小段 runloop,让别的事照常走。
    private static func wait(ms: Int) {
        RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000.0))
    }

    private static func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private static func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success, let value else { return nil }
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue((value as! CFBoolean))
    }

    /// 这个框此刻算不算空。
    ///
    /// 实测(2026-09-21,Claude / ChatGPT / Kimi 三家):空框的 `AXValue` **不是空串**,
    /// 报的是界面上那句占位符(「给 Claude 发消息」这一类)。不减掉这一层,
    /// 每一个空框都会被当成"里面有草稿"而拒送。
    static func isEmptyInput(_ element: AXUIElement, bundleId: String = "") -> Bool {
        let value = (stringValue(of: element) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return true }
        if SendTextPolicy.isKnownPlaceholder(value, bundleId: bundleId) { return true }
        for attr in [kAXPlaceholderValueAttribute, kAXDescriptionAttribute, kAXTitleAttribute] {
            if let placeholder = stringAttr(element, attr),
               value == placeholder.trimmingCharacters(in: .whitespacesAndNewlines) { return true }
        }
        return false
    }

    private static func stringValue(of element: AXUIElement) -> String? {
        stringAttr(element, kAXValueAttribute)
    }

    private static func isSettable(_ element: AXUIElement, _ attr: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, attr as CFString, &settable) == .success else { return false }
        return settable.boolValue
    }

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    private static func subrole(of win: AXUIElement) -> String? {
        stringAttr(win, kAXSubroleAttribute)
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }
}
