import CoreGraphics
import Foundation

/// 「把一段话送进某家 Agent 客户端的输入框」这件事里**不碰系统 API 的那一半**。
///
/// 2026-09-21 Ben 纠正派活的定义:派活不是命令行、不是 API,是**直接操作窗口槽里的客户端**
/// (Claude / Codex(ChatGPT) / Kimi / 豆包;2026-09-24 卡 F 加了 Muse / Manus)。链路的第一段——把话送进去——之前是零。
///
/// **这个文件故意不 import AppKit / ApplicationServices**(先例:`WindowPlacement.swift`、
/// `DragSense.swift` 顶上那两段)。`AXUIElement`、`NSPasteboard`、`CGEvent` 在单测里造不出来,
/// 而「哪个元素才是聊天输入框」「哪个按钮是发送、哪个是停止」「什么时候该退到键盘」恰恰是
/// 最容易写错、也最值得钉住的部分。真去调 AX 的那一半在 `TextInsert.swift`,它只做动作,
/// 一条判断都不自己下。测试跑法见 `workbench-app/run-tests.sh`。
///
/// 坐标系:AX 全局坐标(主屏左上为原点,y 向下)——与 `DragSense` / `WindowControl` 同一套,
/// 全链没有换算。
enum SendTextPolicy {

    /**
     **输入区左下角那颗没名字的「清空」键**(2026-10-12,演示卡「出图进可灵」;第六轮真跑撞上的:
     可灵「视频生成」那一页**留着上一回贴的首帧**,新图贴进去落成了尾帧)。

     可灵那颗垃圾桶是一块 24×24、带 AXPress、**一个字的名字都没有**的 `AXGroup`,只能按结构认:
     没名字、能按、12~40 点见方、在提示词框下沿以下、落在输入区里、在输入区最左边那五分之一里。
     **恰好一颗才认**;零颗、两颗以上都回 nil(认不准一颗都不按)。坐标一律是同一套(屏幕坐标)。
     */
    /**
     **框上方那几张帧图各自的「删除」键**(2026-10-12,演示卡;维护者截图:鼠标放到图上才显示「上传 / 删除」两颗,
     删除在最右边)。可灵这两颗都是没名字的 28×28 `AXLink`,不悬停时也在树里。

     认法:提示词框上方、横向与框重叠、80 点见方以上的图(同一块位置的几份只算一张,从上到下、从左到右排);
     每张图的**右上那一块**里、没名字、能按、16~40 点见方的键,取**最右边**那颗。
     回 `(image, key)`:第几张图、按哪颗;一张图右上角一颗都没有就不收那张。
     */
    static func pickFrameDeleteKeys(input: CGRect, images: [CGRect], keys: [(frame: CGRect, named: Bool)]) -> [(image: Int, key: Int)] {
        var seen: [CGRect] = []
        var order: [Int] = []
        for at in images.indices {
            let f = images[at]
            guard f.width >= 80, f.height >= 80, f.maxY <= input.minY + 4,
                  f.maxX > input.minX, f.minX < input.maxX else { continue }
            if seen.contains(where: { abs($0.minX - f.minX) < 2 && abs($0.minY - f.minY) < 2 && abs($0.width - f.width) < 2 }) { continue }
            seen.append(f)
            order.append(at)
        }
        order.sort { (images[$0].minY, images[$0].minX) < (images[$1].minY, images[$1].minX) }
        var out: [(image: Int, key: Int)] = []
        for at in order {
            let img = images[at]
            let inCorner = keys.indices.filter { k in
                let key = keys[k]
                let f = key.frame
                return !key.named && f.width >= 16 && f.width <= 40 && f.height >= 16 && f.height <= 40
                    && f.midX > img.midX && f.midX < img.maxX && f.midY > img.minY && f.midY < img.midY
            }
            if let best = inCorner.max(by: { keys[$0].frame.midX < keys[$1].frame.midX }) { out.append((image: at, key: best)) }
        }
        return out
    }

    /**
     **锚在一段字下面那一排里、没名字的那一颗键**(2026-10-12,演示卡「出图进可灵」:可灵结果卡上的「下载」)。

     维护者截图:视频下面那一排是「👍 👎 ✈ ⬇ … ☆」,真量:⬇ 与 … 都是没名字的 `AXPopUpButton`(28×33),⬇ 在左。
     锚 = 最上面那一处对得上的字(最新那条结果卡的播放时间「00:01 / 00:05」);
     键 = 角色对得上、没名字、顶边在锚下沿以下 `maxBelow` 点以内、横向不在锚左边太远(120 点)的那几颗里**最左边**那颗。
     没有锚、没有键都回 nil(一颗都不按)。
     */
    static func pickKeyBelowAnchor(anchors: [CGRect], keys: [(frame: CGRect, role: String, named: Bool)],
                                   role: String, maxBelow: CGFloat = 80) -> Int? {
        guard let anchor = anchors.min(by: { $0.minY < $1.minY }) else { return nil }
        let pool = keys.indices.filter { at in
            let key = keys[at]
            return key.role == role && !key.named
                && key.frame.minY >= anchor.maxY - 2 && key.frame.minY <= anchor.maxY + maxBelow
                && key.frame.minX >= anchor.minX - 120
        }
        return pool.min(by: { keys[$0].frame.minX < keys[$1].frame.minX })
    }

    static func pickComposerClearKey(input: CGRect, composer: CGRect, keys: [(frame: CGRect, named: Bool)]) -> Int? {
        let pool = keys.indices.filter { at in
            let key = keys[at]
            let f = key.frame
            return !key.named
                && f.width >= 12 && f.width <= 40 && f.height >= 12 && f.height <= 40
                && f.minY >= input.maxY - 4
                && composer.contains(CGPoint(x: f.midX, y: f.midY))
                && f.midX < composer.minX + composer.width * 0.2
        }
        return pool.count == 1 ? pool[0] : nil
    }


    // MARK: - 白名单

    /// **实测过、写在壳里的那几家**(不用服务端说一句就放行)。
    ///
    /// 只有 Agent 客户端。**微信 / 企业微信这类 IM 永远不在这张表里** —— 往聊天窗口里
    /// 打一行字再按回车,那是以 Ben 的身份对真人说话,和"派活"是两件事。这条在
    /// `run-tests.sh` 里有一条断言钉着(`denied` 那组),不是靠注释自觉。
    ///
    /// `com.apple.TextEdit` 在表里是**故意的**:端到端验证(激活 → 聚焦 → 送字 → 回车)
    /// 要有一个"按了回车也不会把话发给任何人"的靶子。真客户端上这张卡只验到"字在框里",
    /// 回车那一下留给 Ben(见交接第五节)。
    ///
    /// ★ **2026-09-25(卡 Z)这张表不再是「能送话的全部」**:维护者「要是写死了就很糟糕了……
    /// 你得想个机制」—— 有哪几家 Agent 由服务端的 Agent 登记表在运行时发现(两道判:窗口像对话窗口 +
    /// 回话的是 AI 不是人;他随时能说「这不是 Agent」当场撤)。服务端把登记表里接上了的那几家
    /// 报给壳(`agent_allow`),壳这边**三道门**照旧各自成立:① {@link neverBundleIds} 一律拒;
    /// ② 这张实测表 或 服务端报过的那一份,别的一概不送(Finder 这种照旧拒);
    /// ③ 真找不到聊天输入框就不送(见 `TextInsert.locate`)。
    static let allowedBundleIds: Set<String> = [
        "com.anthropic.claudefordesktop", // Claude 桌面版
        "com.openai.codex",               // ChatGPT 桌面版 —— Codex 与 ChatGPT 是同一个 app
        "com.moonshot.kimichat",           // Kimi
        "com.bot.pc.doubao",               // 豆包
        "com.meta.endo",                   // Muse(Meta,2026-09-24 维护者新装;bundle id 里的 endo 是它的内部代号)
        "im.manus.desktop",                // Manus
        "com.apple.TextEdit",              // 端到端验证靶子(见上)
    ]

    /// 明着拒的那几家:**任何情况下都不送**(服务端报它是 Agent 也不送)。
    static let neverBundleIds: Set<String> = [
        "com.tencent.xinWeChat",  // 微信
        "com.tencent.WeWorkMac",  // 企业微信
    ]

    /// 服务端报过的「Agent 登记表里接上了的那几家」(`agent_allow`)。**进程内的,重启即空**:
    /// 服务端每次连上、登记表一变就重报一遍,壳不落盘 —— 落盘就等于壳自己又存了一份会过期的名单。
    ///
    /// 上锁是因为**读写跨线程**:`agent_allow` 在主线程改,`read_reply` 在 readQueue 上读
    /// (见 `HelperSocket` 的「怎么分」)。
    private static let declaredLock = NSLock()
    private static var declared: Set<String> = []

    static var declaredAgents: Set<String> {
        declaredLock.lock()
        defer { declaredLock.unlock() }
        return declared
    }

    /// 服务端报一份过来(整份替换)。`neverBundleIds` 里的一律剔掉 —— 那一道门服务端说了也不算。
    static func setDeclaredAgents(_ bundleIds: [String]) {
        let next = Set(bundleIds.filter { !$0.isEmpty && !neverBundleIds.contains($0) })
        declaredLock.lock()
        declared = next
        declaredLock.unlock()
    }

    static func isAllowed(_ bundleId: String) -> Bool {
        if neverBundleIds.contains(bundleId) { return false }
        if allowedBundleIds.contains(bundleId) { return true }
        declaredLock.lock()
        defer { declaredLock.unlock() }
        return declared.contains(bundleId)
    }

    // MARK: - 先开一条新对话(2026-09-24,卡 F「手机远程派活」)

    /// 送话之前先按那家菜单里的「新对话」。**不开新对话就送**,话会打进他此刻正开着的那条对话
    /// —— 那是他自己的会话,往里塞一句派活是在他的会话里做有副作用的事。
    ///
    /// 名字是 2026-09-24 在这台机器上逐家读菜单栏读出来的(不是猜的):
    ///
    /// | 家 | 菜单 | 快捷键 |
    /// |---|---|---|
    /// | Claude 桌面版 | File ▸ New Session | ⌘N |
    /// | ChatGPT / Codex | File ▸ New Chat | ⌘N |
    /// | Kimi | 文件 ▸ 新聊天 | ⌘K |
    /// | Manus | File ▸ New Task | ⌘N |
    /// | 豆包 | 文件 ▸ 新对话 | ⌘N |
    /// | Muse | **菜单栏里没有**(它只有一条长期对话,见 `singleThreadBundleIds`) | —— |
    ///
    /// **逐字相等才算,不做包含**:同一个菜单里还有 New Window / New Temporary Chat /
    /// New Project / New Scheduled Task,哪一个被"包含"认成新对话都是按错键。
    /// 按的是 AX 菜单项的 `AXPress`,**不敲快捷键**:⌘K 在别的应用里是别的意思,
    /// 而菜单项是那家自己告诉我们的那一下。
    static let newConversationMenuTitles: Set<String> = [
        "New Chat", "New Session", "New Task", "New Thread", "New Conversation",
        "新聊天", "新对话", "新建对话", "新会话", "新任务", "新建任务",
    ]

    static func isNewConversationItem(_ title: String) -> Bool {
        let one = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if newConversationMenuTitles.contains(one) { return true }
        // **大小写不算数**(2026-09-26,卡 MQ):Grok Bot 那颗键上写的是「New chat」,
        // 跟表里的「New Chat」只差一个字母 —— 按字面比就漏了,可用户看见的是同一颗键。
        // 漏了的后果不止是按不着它:登记表判「像不像对话窗口」要「有发送键**或**有新对话入口」,
        // 漏这一条就能把一家有聊天窗的 App 判成不是 Agent。
        return newConversationMenuTitles.contains { $0.caseInsensitiveCompare(one) == .orderedSame }
    }

    /// 叫到台前之后,**等「新对话」那一项亮起来**最多等多久(毫秒)。
    ///
    /// 2026-09-25 真系统(0.2.97):豆包那一单 3 秒就挂了阻塞 ——「菜单里的「新对话」是灰的」。
    /// 实测:豆包不在台前时它**整个菜单都是灰的**(新对话、重新加载都灰);`activate` 之后要约 **1 秒**
    /// 「新对话」才亮(876ms 还灰、1031ms 亮),老代码只等 350ms 就判了灰。它当时开着的是一条有字的对话,
    /// 不是"已经在一条空的新对话里";按完「新对话」、停在空对话上时那一项照样是亮的(也实测过)。
    /// 所以是**等**的问题,不是不该送:在这个时限里每 150ms 看一次,亮了就按;到点还灰才如实不送。
    static let newConversationMenuWaitMs = 4000
    /// 等到一半还灰,就再叫一次台前(第一次 activate 可能被别的应用抢回去了)。
    static let newConversationReactivateAfterMs = 1500

    /// **只有一条长期对话**、没有「新对话」这回事的那几家:话就送进那一条。
    /// Muse(Meta)是这样设计的 —— 它是"一个随身助理",不是一堆会话;菜单栏里一个「新」字都没有。
    static let singleThreadBundleIds: Set<String> = ["com.meta.endo"]

    // MARK: - 送一句话走哪几步(2026-09-27,卡 DB)

    /// 送一句话的**步骤表**。顺序写死在这里(纯函数、有单测),`TextInsert.sendText` 照着走。
    ///
    /// 现场(2026-09-27 21:23,交接「电话捎话犯傻」第五节第 1 条):电话让事务官「找豆包总结聊天」,
    /// 派给豆包回的是「没送:输入框里有你没发出去的字」—— 而这条路**本意是新开一条对话再送**,
    /// 新对话的框本来是空的。两处错:
    /// ① 判「有没有草稿」判的是**开新对话之前 / 刚按完新对话那一拍**那个框(树还挂着旧对话的框),
    ///    于是旧对话里他写了一半的话把新对话这一送拦下了;
    /// ② 「新对话」按在最前面,后面哪一步断了都**留下一条空对话**在他的豆包里。
    ///
    /// 所以顺序是:**先看一眼这扇窗写不写得进**(`reachInput`,只看能不能找到框,**不判草稿**)
    /// → 按「新对话」→ **在新对话里重新找框**(`locateInput`,这一步才判草稿)→ 送(`deliver`)。
    /// 第一步挡住的正是「开了新对话才发现送不了」那一类(没窗口、辅助功能关着、找不到框),
    /// 挡住就一条空对话都不留。
    enum SendStep: String, Equatable {
        /// 先看一眼:这扇窗此刻找得到输入框吗。**只看找不找得到,不看框里有没有字**。
        case reachInput
        /// 按那家菜单里的「新对话」。
        case openNewConversation
        /// (在新对话里)重新找输入框 —— 判草稿是这一步的事。
        case locateInput
        /// 把字送进去。
        case deliver
    }

    /// `newConversation`:这一送要不要先开新对话;`singleThread`:那家只有一条长期对话(Muse)。
    static func sendSteps(newConversation: Bool, singleThread: Bool) -> [SendStep] {
        guard newConversation, !singleThread else { return [.locateInput, .deliver] }
        return [.reachInput, .openNewConversation, .locateInput, .deliver]
    }

    /// 刚按完「新对话」,AX 树里可能还挂着**旧对话**那个框(里面是他的草稿)。
    /// 在这个时限里每 `newConversationSettleStepMs` 重找一次,框空了就当新对话画好了。
    /// 到点还不空 —— 那才可能是他在新对话里也写了字,交给 `draftMove` 处置。
    static let newConversationSettleMs = 3000
    static let newConversationSettleStepMs = 400

    // MARK: - 框里那段他没发出去的字(草稿)

    /// 框里有字时,这一送该怎么办。**绝不静默覆盖** —— 那段字是他的东西。
    enum DraftMove: Equatable {
        /// 框是空的(或者只有占位符):直接送。
        case send
        /// 调用方明着说了 overwrite:照他说的覆盖。
        case overwrite
        /// 有他没发出去的字、而且**读得出来** → 先存下来再送(送完再放回去)。
        case saveThenSend(draft: String)
        /// 有字但**读不出内容**(读不回 AXValue 的那几家),或者调用方没要求存 → **不送**。
        /// 存不下来的东西不许覆盖:覆盖掉就找不回来了。
        case blocked
    }

    /// - `inputEmpty`:`TextInsert.isEmptyInput` 的结论(占位符那一层已经减掉);
    /// - `draft`:框里读回来的原文(读不回值时传 nil);
    /// - `overwrite`:调用方明着要覆盖;
    /// - `canSave`:调用方接得住草稿(会把它存到工作台)。老调用方不接 → false，照老样子拦下。
    static func draftMove(inputEmpty: Bool, draft: String?, overwrite: Bool, canSave: Bool) -> DraftMove {
        if inputEmpty { return .send }
        if overwrite { return .overwrite }
        guard canSave, let draft, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .blocked }
        return .saveThenSend(draft: draft)
    }

    /// 送完了,存下来那段草稿放不放回框里。
    enum DraftReturn: Equatable {
        /// 框空了(话真发出去了)→ 原样放回去,他回到豆包看见的还是自己那半句。
        case putBack
        /// 放不回去:只存着,并在事项上告诉他存哪了。
        case keepOnly(reason: String)
    }

    /// - `submitted`:替他按了发送、而且发出去了;
    /// - `inputEmptyAfterSend`:发完框里是空的。
    ///
    /// 只有「发出去了 + 框空了」才放回 —— 没按发送时框里躺着的是我们要送的那句,
    /// 放回去就把它顶掉了;发完框里还有字,再写一次只会叠上去。
    static func draftReturn(submitted: Bool, inputEmptyAfterSend: Bool) -> DraftReturn {
        if !submitted { return .keepOnly(reason: "这一送只把话放进框里、没替你按发送,框里现在是我要送的那句 —— 放回去就把它顶掉了") }
        if !inputEmptyAfterSend { return .keepOnly(reason: "发完框里还留着字,没敢再往上写") }
        return .putBack
    }

    // MARK: - 空框的占位符(AX 属性上找不到的那几家)

    /// 空框时 `AXValue` 报的就是占位符、而这句占位符**不在** `AXPlaceholderValue` /
    /// `AXDescription` / `AXTitle` 任何一格上的那几家(不列进来,空框会被当成"有草稿"而拒送)。
    /// 2026-09-24 实测:Manus 空框读回来是 `Assign a task or type / for more` + 一个换行,
    /// 发出去进了任务页之后是 `Message Manus`。
    static let knownPlaceholders: [String: [String]] = [
        // 首页那个框 / 进了任务页之后底下那个框(发出去之后是后一句)。
        "im.manus.desktop": ["Assign a task or type / for more", "Message Manus"],
    ]

    static func isKnownPlaceholder(_ value: String, bundleId: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (knownPlaceholders[bundleId] ?? []).contains { $0 == v }
    }

    // MARK: - 整个输入区画成一颗按钮的那几家

    /// Muse 的输入区在 AX 树里是**一颗 AXButton**(2026-09-24 实测,标题
    /// 「消息 附加文件 语音输入一条消息 发送」),下面没有 AXTextArea。它只能"点一下再粘贴"。
    /// 认法:标题里**同时**有「消息」和「发送」(英文界面 Message + Send),**而且是好几颗控件
    /// 的名字拼起来的**(按空白切开至少三段)。只有一个词不算 —— 单写「发送」的是发送键,
    /// 单写「消息」的可能是一条消息的气泡;「Send message」两段,是普通的发送键。
    static func looksLikeComposerButton(title: String?) -> Bool {
        guard let t = title?.lowercased(), !t.isEmpty else { return false }
        let parts = t.split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 3 else { return false }
        return (t.contains("消息") && t.contains("发送")) || (t.contains("message") && t.contains("send"))
    }

    /// 回车发不出去、要 **⌘回车** 才发的那几家。Muse 的输入区里回车是换行
    /// (2026-09-24 实测:三次回车都只把字留在框里,⌘回车一次就发出去了)。
    static let commandReturnBundleIds: Set<String> = ["com.meta.endo"]

    static func submitNeedsCommand(_ bundleId: String) -> Bool {
        commandReturnBundleIds.contains(bundleId)
    }

    // MARK: - 它还在不在生成

    /// 窗口里有一颗「停止」键 = 那家还在出字 / 还在干活。**读回复时拿它当"还没完"的信号**:
    /// 认错成"还在跑"只是多等几秒,认错成"跑完了"是把半截回答当结果交上去 —— 所以这里宁宽勿窄。
    static func looksLikeStopButton(title: String?, description: String?) -> Bool {
        let text = [title, description].compactMap { $0 }.joined(separator: " ").lowercased()
        if text.isEmpty { return false }
        // 这几个带「停止 / stop」却不是"停止生成":录音、共享、朗读。
        let notIt = ["录音", "recording", "共享", "sharing", "朗读", "read aloud", "dictation", "听写"]
        if notIt.contains(where: { text.contains($0) }) { return false }
        let yes = ["停止", "中止", "中断", "stop", "interrupt", "cancel generation", "cancel response"]
        return yes.contains(where: { text.contains($0) })
    }

    // MARK: - 回答里不算的那几块

    /// 一块字的**直接子元素**里同时有「接受」和「忽略」两颗按钮 = 那家界面上弹的一张**建议卡**,不是回答。
    ///
    /// 2026-09-25 实测 Manus:我们附在派活指令末尾的规矩被它当成"要记住的偏好",回答下面挂一张
    /// 「工作台派活全局规则与系统执行约束 / Rules mentioned once globally apply …」+ Dismiss / Accept 的卡
    /// (点 Accept 才会存进他的 Manus 知识库)。读回复时把整张卡跳过,它的字就不会拼进交付物。
    /// **只认这一对**(Accept + Dismiss、接受 + 忽略):Codex 代码块的「Copy」、各家的「复制 / 重试」都不是它,
    /// 批准命令那种框(Approve / Run)也不是 —— 那是要他知道的事,不能吞。
    static func looksLikeSuggestionCard(buttonTitles: [String]) -> Bool {
        let titles = Set(buttonTitles.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        let accept = ["accept", "接受"]
        let dismiss = ["dismiss", "忽略"]
        return accept.contains(where: { titles.contains($0) }) && dismiss.contains(where: { titles.contains($0) })
    }

    // MARK: - 找输入框

    /// 一个候选元素在我们眼里的样子。真读 AX 属性的那几行在 `TextInsert.swift`。
    struct InputCandidate: Equatable {
        /// AXRole,如 `AXTextArea` / `AXTextField`。
        let role: String
        /// AXValue 这条属性**可写**吗(`AXUIElementIsAttributeSettable`)。
        /// 不可写就只能退到键盘那条路(点一下 + 粘贴),不能直接赋值。
        let settable: Bool
        /// 此刻是不是焦点元素。
        let focused: Bool
        /// AX 全局坐标下的矩形。
        let frame: CGRect
        /// 这是一颗"整个输入区画成的按钮"(Muse,见 `looksLikeComposerButton`)。
        /// 它不是 `inputRoles` 里的角色,但确实是输入框 —— 只能点、不能写。
        let composer: Bool
        /// 这是**自绘界面里认出来的(或兜底挑的)那个落点**(2026-10-02,见 `looksLikeDrawnInput`)。
        /// 它的角色是 `AXUnknown` / `AXGroup`,不在 `inputRoles` 里,但它就是那个输入框 ——
        /// 与 `composer` 同一档:只能点、不能写 AXValue。
        let drawn: Bool

        init(role: String, settable: Bool, focused: Bool, frame: CGRect, composer: Bool = false, drawn: Bool = false) {
            self.role = role
            self.settable = settable
            self.focused = focused
            self.frame = frame
            self.composer = composer
            self.drawn = drawn
        }
    }

    /// 能当输入框看的角色。`AXComboBox` 也收:有的前端把输入区做成带补全的组合框。
    /// `AXWebArea` **不收** —— 它是整张网页,往它身上写 AXValue 不是"填输入框"。
    static let inputRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox"]

    /// 幽灵元素的尺寸下限。先例:`DragSense` 里那条 120×120 —— 同一类坑
    /// (AX 树里混着 0×0、1×1 的占位节点,选中它等于选了个不存在的东西)。
    static let minInputSize = CGSize(width: 60, height: 12)

    /// 挑出来的那个,以及**为什么是它**(这句话会原样进日志与交接表,不是装饰)。
    enum InputPick: Equatable {
        /// 可以直接写 AXValue 的那个。
        case writable(index: Int, why: String)
        /// 看着像输入框但 AXValue 写不进去 —— 只能点它一下,然后走键盘。
        case clickOnly(index: Int, why: String)
        /// 一个都没有。
        case none(reason: String)

        var isWritable: Bool { if case .writable = self { return true } else { return false } }
    }

    /// 从一堆候选里挑聊天输入框。
    ///
    /// 三条规矩,按顺序:
    /// 1. **焦点优先**:已经是焦点的可写元素直接用 —— 用户/客户端自己刚刚把光标放那儿了,
    ///    这是比任何几何猜测都硬的证据。
    /// 2. **靠下的赢**:聊天类客户端的输入框一律在窗口底部,回复流在上面。比"最大的那个"
    ///    可靠得多(最大的通常是消息列表,而它在有的实现里也是 AXTextArea)。
    /// 3. **必须在这扇窗里**:中心点落在窗口矩形外的丢掉(屏外的、别的窗的残留节点)。
    ///
    /// 挑不出可写的,就退回"能点的"那一个(键盘那条路);连能点的都没有才是 `none`。
    static func pickInput(_ candidates: [InputCandidate], window: CGRect) -> InputPick {
        let usable = candidates.enumerated().filter { (_, c) in
            (inputRoles.contains(c.role) || c.composer || c.drawn)
                && c.frame.width >= minInputSize.width
                && c.frame.height >= minInputSize.height
                && window.contains(CGPoint(x: c.frame.midX, y: c.frame.midY))
        }
        if usable.isEmpty {
            return .none(reason: candidates.isEmpty
                ? "这扇窗的 AX 树里没有任何文本输入元素(多半是 AX 通道没醒,或者这家把输入框画成了纯 canvas)"
                : "AX 树里有文本元素,但没有一个落在这扇窗里、又大得像个输入框")
        }

        if let focused = usable.first(where: { $0.element.focused && $0.element.settable && !$0.element.drawn }) {
            return .writable(index: focused.offset, why: "它已经是焦点元素(\(focused.element.role))")
        }

        // 自绘那一类**永不走 AXValue**:往一个 AXUnknown 身上写值不是「填输入框」(同 composer 那一条)。
        let writable = usable.filter { $0.element.settable && !$0.element.drawn }
        if let best = lowest(writable) {
            return .writable(index: best.offset,
                             why: "窗口里最靠下的那个可写文本元素(\(best.element.role),y=\(best.element.frame.midY.isFinite ? Int(best.element.frame.midY.rounded()) : 0))")
        }

        if let focused = usable.first(where: { $0.element.focused }) {
            return .clickOnly(index: focused.offset, why: focused.element.drawn
                ? "自绘界面里认出来的那个落点,而且它此刻就是焦点(\(focused.element.role))"
                : "它是焦点元素,但 AXValue 写不进去(\(focused.element.role))")
        }
        if let best = lowest(usable) {
            // 自绘那一类说清是哪一条认出来的(她问「它怎么知道往哪点」时答的就是这句)。
            if best.element.drawn {
                return .clickOnly(index: best.offset,
                                  why: "自绘界面里认出来的那个落点:窗口下部一条宽而矮、动得了的 \(best.element.role)")
            }
            return .clickOnly(index: best.offset,
                              why: "窗口里最靠下的那个文本元素,但 AXValue 写不进去(\(best.element.role))")
        }
        return .none(reason: "没有可用的输入框")
    }

    /// 最靠下的那个;一样低就取宽的(输入框通常横贯整个窗口宽度)。
    private static func lowest(_ items: [(offset: Int, element: InputCandidate)]) -> (offset: Int, element: InputCandidate)? {
        items.max { a, b in
            if a.element.frame.midY != b.element.frame.midY { return a.element.frame.midY < b.element.frame.midY }
            return a.element.frame.width < b.element.frame.width
        }
    }

    // MARK: - 怎么送

    /// 两条路。**AX 优先**:一次属性赋值,不碰键盘、不碰剪贴板、跟输入法完全无关。
    enum SendMethod: String, Equatable {
        /// 直接写 `AXValue`。
        case axValue = "ax_value"
        /// 剪贴板粘贴(⌘V)。用户的剪贴板先存后还。
        case paste
    }

    /**
     送进去的字**读回来对不对得上**(2026-09-28 20:44 Air 真机,豆包工作)。

     只比字,不比空白:派活原文两段之间空一行,豆包的框把空行吞成一个换行,逐字相等就判「对不上」、
     回车一次都没按 —— 他看着字全在框里,就是不发。**仍然是整段相等,不是「包含」**:
     框里是同一段话两遍(追加那一类)照旧拦下。
     */
    static func readbackMatches(got: String, sent: String) -> Bool {
        func squeeze(_ text: String) -> String {
            String(String.UnicodeScalarView(text.unicodeScalars.filter { !$0.properties.isWhitespace }))
        }
        let a = squeeze(got)
        return !a.isEmpty && a == squeeze(sent)
    }

    static func method(for pick: InputPick) -> SendMethod? {
        switch pick {
        case .writable: return .axValue
        case .clickOnly: return .paste
        case .none: return nil
        }
    }

    // MARK: - 怎么发出去

    /// 发送那一下的三条路,按可靠性排序。
    enum SubmitMethod: String, Equatable {
        /// 元素自己的 `AXConfirm` 动作 —— 不经过键盘,**输入法完全碰不到它**。
        case axConfirm = "ax_confirm"
        /// 按下界面上那颗"发送"按钮(`AXPress`)—— 同样不经过键盘。
        case sendButton = "send_button"
        /// 回车键(CGEvent)。最后一条路,见 `imeWarning`。
        case returnKey = "return_key"
    }

    // MARK: - 发出去了没有:核对别读太早(2026-10-13,卡 SC)

    /**
     **按完发送之后等多久、怎么核对**。

     现场(统筹这台 Mac,普通包豆包 `com.bot.pc.doubao`,窗口可见、在台前):
     - 11:49 探针 `send … --new --overwrite --submit 你好` 回 `submitted:false`;**两秒后读那扇窗,
       对话标题已是「问候」、右侧气泡就是那句「你好」、豆包也已经回了话** —— 字真发出去了,壳却报没发;
     - 11:43 派活给豆包同样 `submitted:false`,视频接力停在第一步、事项记「没派」,而那一刻字还在框里
       —— 清框**慢**,不是不清。

     病根只有一条:老代码按完**等 600ms 读一次**就下结论,而 Electron 新版豆包发出去那一下
     把输入框清空、把对话区重画都比这慢。所以改成**轮询**:每 `submitConfirmStepMs` 看一次、
     最多 `submitConfirmTotalMs`,框空了就算发出去;到点还没空,再去对话区找送出去那段话
     (第二档,见 `echoNeedle`);两样都没有才如实报没发 —— 「宁可报没发」的分寸保留在最后那一档。

     前两条路(`axConfirm` / `sendButton`)只给 `submitConfirmEarlyTotalMs`:那两下按完没动静就该换下一条,
     把三秒全花在第一条上,只会让「真发不出去」那一次等到九秒。最后那一条(回车)拿满。
     */
    static let submitConfirmTotalMs = 3000
    static let submitConfirmStepMs = 500
    static let submitConfirmEarlyTotalMs = 1500

    /// 轮询的那几拍(毫秒)。每一拍**先等再读** —— 按完那一瞬间读到的框必然还没清。
    /// 时限不够一整拍就只等那一小截;时限或步长非法回空(= 不核对,绝不死循环)。
    static func confirmSteps(totalMs: Int, stepMs: Int = submitConfirmStepMs) -> [Int] {
        guard totalMs > 0, stepMs > 0 else { return [] }
        var out: [Int] = []
        var left = totalMs
        while left > 0 {
            out.append(min(stepMs, left))
            left -= stepMs
        }
        return out
    }

    /// 对话区那一档**半途也看一眼**:等到一半(或到点)就查一次。
    ///
    /// 真机上这一版豆包**每一送都落在这一档**(框里那个值三秒之内一直是刚写进去那段字,见
    /// `valueBackToBefore` 那段现场)—— 死等到点再查,每一送白搭三秒;半途查一眼就早两秒交活。
    /// 真发不出去的那一次多走一趟扫窗(节点与时限都封了顶),换的是演示那条链每一步都快两秒。
    static func echoCheckDue(waitedMs: Int, budgetMs: Int) -> Bool {
        waitedMs * 2 >= budgetMs
    }

    /// 这一送是**哪一档**核出来的(回包里的 `confirmed_by`,给看日志的人;8791 照旧只看 `submitted`)。
    enum SubmitProof: String, Equatable {
        /// 框空了 = 发出去了。绝大多数时候就是这一档,只是比 600ms 晚一点。
        case inputCleared = "input_cleared"
        /// 框没「空」,但**回到了写之前那个样子**(见 `valueBackToBefore`)。
        case inputBackToBefore = "input_back_to_before"
        /// 框到点还没变,但**送出去那段话出现在对话区里**(她那句话的气泡)。
        case echoInChat = "echo_in_chat"
    }

    /**
     框里**回到了写之前那个样子**(2026-10-13 真机量到的那一条,卡 SC)。

     统筹这台 Mac 上这一版豆包:发完之后那个 `AXTextArea` 的 `AXValue` 读回来是**那句占位符**
     (14 个字),而这句占位符**不在** `AXPlaceholderValue` / `AXDescription` / `AXTitle` 任何一格上
     (探针 `find` 真读数:`value_len:14`、`placeholder:""`、`desc:""`、`title:""`)。
     于是 `isEmptyInput` 永远判它「框里有草稿」—— 第一档再怎么轮询都不成立。
     (`knownPlaceholders` 那张表治的是同一个病,但那要把那句占位符逐字写进壳里:
     它每版都可能改,而框里的内容是她的东西,壳不读出来、也不写进日志。)

     所以这一档只比**写之前那个值**与**发完那个值**:原样回来了 = 我们写进去那段字已经不在框里了。
     走到这一步时 `deliver` 已经核过「写进去的字读回来对得上」(`readbackMatches`),
     所以这一档不会把「压根没写进去」说成发出去了。写之前框里就是同一段字(重复送同一句)那一次
     认不准,交给后面那一档。
     */
    static func valueBackToBefore(now: String?, before: String?, sent: String) -> Bool {
        guard let now, let before else { return false }
        let a = flatten(now)
        let b = flatten(before)
        guard !a.isEmpty, a == b else { return false }
        return b != flatten(sent)
    }

    /// 去对话区找的那一截字:送出去那段话的**前 `max` 个字**(并过空白,与窗口里读到的字同一套)。
    /// 一个字的(「好」)不认 —— 界面上到处都是单字,认错就是把没发出去说成发出去了。
    static let echoNeedleMax = 20
    static func echoNeedle(_ text: String, max: Int = echoNeedleMax) -> String? {
        let flat = flatten(text)
        guard flat.count >= 2 else { return nil }
        return String(Array(flat).prefix(max))
    }

    /// 走窗口找那一截字时,这个节点算不算**框里的字** —— 没发出去的时候那段字正躺在框里,
    /// 把它读进来就是自己给自己盖章。中点落在框里、或者整块都在框里,都算框里的字。
    /// 框量不到(`.zero`)时一概不排(宁可这一档不成立,也不能把框里的字当成对话区里的)。
    ///
    /// 框的位置要用**发完之后**那一刻的(写进去一长段之后输入框会长高 —— 拿写之前那个矩形去排,
    /// 长出来那一截里的字就漏成了「对话区里出现了」)。
    static func insideInput(node: CGRect, input: CGRect, slack: CGFloat = 2) -> Bool {
        guard !input.isEmpty, node.width.isFinite, node.height.isFinite,
              node.origin.x.isFinite, node.origin.y.isFinite else { return false }
        let box = input.insetBy(dx: -slack, dy: -slack)
        return box.contains(CGPoint(x: node.midX, y: node.midY)) || box.contains(node)
    }

    /// 窗口里读到的这一截字里,有没有那一段话的开头(两边都并过空白)。
    static func mentionsSentText(hay: String, needle: String) -> Bool {
        let a = flatten(hay)
        let b = flatten(needle)
        guard !a.isEmpty, !b.isEmpty else { return false }
        return a.contains(b)
    }

    /// 换行与连续空白并成一个空格、首尾空白去掉(同 `AgentWindowPolicy.clip` 那一套;
    /// 这边不依赖那边 —— 这个文件是下面那一层)。
    static func flatten(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    /// 三档判据合一处。
    /// - `inputCleared`:轮询到框空了;
    /// - `valueBackToBefore`:框回到了写之前那个样子(见上);
    /// - `echoBefore` / `echoAfter`:**送之前**窗口里有没有这一截字、送之后有没有。
    ///   只认「送之前没有、送之后出现」那一条 —— 对话区里本来就有同一句话时(她上回发过同一句),
    ///   找到的是那一条旧的,不算凭据。
    static func submitProof(inputCleared: Bool, valueBackToBefore: Bool = false,
                            echoBefore: Bool, echoAfter: Bool) -> SubmitProof? {
        if inputCleared { return .inputCleared }
        if valueBackToBefore { return .inputBackToBefore }
        if !echoBefore, echoAfter { return .echoInChat }
        return nil
    }

    /// 一颗按钮看着像不像"发送"。
    ///
    /// **宁可认不出,不可认错**:认不出就退到回车,认错了就是去点了"停止生成"或者"新建对话"。
    /// 所以停/取消/删除这类词一票否决,而不是只看有没有"发送"两个字。
    static func looksLikeSendButton(title: String?, description: String?) -> Bool {
        let text = [title, description].compactMap { $0 }.joined(separator: " ").lowercased()
        if text.isEmpty { return false }
        // 整个输入区画成的那颗按钮(Muse)标题里也有「发送」—— 按它是"点一下输入框",不是发出去。
        if looksLikeComposerButton(title: title) || looksLikeComposerButton(title: description) { return false }
        // 2026-09-30 维护者真机:Claude 桌面底部那颗「Send feedback」被当成发送键按了 —— 弹出反馈窗口,话没发出去。
        // 反馈 / 报告问题 / 分享这几类键名字里也带 send / submit / 发送,一票否决。
        let veto = ["停止", "取消", "删除", "清空", "新建", "stop", "cancel", "delete", "clear", "new chat",
                    "反馈", "feedback", "报告", "report", "分享", "share", "邀请", "invite"]
        if veto.contains(where: { text.contains($0) }) { return false }
        let yes = ["发送", "送出", "提交", "send", "submit"]
        return yes.contains(where: { text.contains($0) })
    }

    /// 中文输入法 + 回车 = 上屏候选词,而不是发送。
    ///
    /// 这条风险**只在"逐字敲键盘"那条路上**才真的存在:我们送字从不敲字符键(要么写 AXValue,
    /// 要么 ⌘V 粘贴),粘贴不开候选窗,所以按回车前没有待上屏的编码。真正的兜底顺序是
    /// `AXConfirm` → 发送按钮 → 回车,前两条根本不经过键盘。
    ///
    /// 即便如此,回车那条路仍然**如实报一句当前输入法**(送话结果里的 `ime`),
    /// 因为万一哪天真吃了字,第一个要问的就是这个。**不替用户切输入法** ——
    /// 切输入法是改他电脑的状态,而且切回来的时机没有一个可靠的点(Ben 的规矩:不碰系统设置)。
    static func imeWarning(inputSourceId: String, submit: SubmitMethod) -> String? {
        guard submit == .returnKey else { return nil }
        let id = inputSourceId.lowercased()
        let chinese = ["sogou", "baidu", "pinyin", "shuangpin", "wubi", "itabc", "scim", "tcim", "rime", "squirrel"]
        guard chinese.contains(where: { id.contains($0) }) else { return nil }
        return "当前输入法是中文(\(inputSourceId)),回车走的是键盘那条路;这次是粘贴进去的、没有待上屏的编码,按理不会被吃。万一发出去的是半截,先看这一行"
    }

    // MARK: - 窗口上弹着一个框挡住了(2026-09-28,卡 DP)

    /*
     * 现场(维护者本机 0.4.55,派一件自测给豆包):
     * ① 第一次回「辅助功能通道关着:com.bot.pc.doubao 回 **-25204**」;
     * ② 第二次回「输入框没找到 —— 这扇窗的 AX 树里没有任何文本输入元素」;
     * ③ 截图:豆包窗口正中弹着一个推广框「手机控制电脑 · 随时用手机,继续电脑上的任务」,
     *    左边一颗蓝键「开始体验」、右上角一个 ×,整个界面被它盖住;AX 树里只剩窗口那三颗控件。
     * 维护者:「那是不是我打电话派活也还是输不进去?」—— 是。
     *
     * 于是这一节定三件事(全是纯判断,真去点的那一半在 `TextInsert`):
     * 1. **-25204 不是权限没给**(那是 -25211):它是 kAXErrorCannotComplete —— 敲过门了、树还没长出来。
     *    对策是**再敲一次门、等一拍、重试**(`axWakeRetryDelaysMs`),而不是当场判「通道关着」。
     * 2. 找不到输入框时先问一句:**是不是有一层框挡着**(树里出现 dialog/sheet 角色、
     *    或者主区域被一整块遮罩盖住、或者树里只剩寥寥几颗键而其中一颗是纯关闭)。
     * 3. 挡着的话:**只按纯关闭那一颗**(×/关闭/Close/稍后/以后再说/跳过),
     *    「开始体验/同意/开通/确认/允许」这类**一颗都不按** —— 按下去就是替她答应了什么。
     *    按不到纯关闭的就**如实说一句人话**,让她去点一下,事项挂「等你处理」,绝不记成已发。
     */

    /// 每次重试之前等多久(毫秒)。Chromium 收到 `AXManualAccessibility` 之后要重建整棵网页树,
    /// 机器忙的时候第一下取窗口就回 -25204。数字本身是一条断言:改它得有人改到用例里。
    static let axWakeRetryDelaysMs: [Int] = [250, 600, 1200]

    /// 辅助功能那几个错码各是什么意思 —— **下一句该查什么**全看它。
    static func axGateHint(err: Int32) -> String {
        switch err {
        case -25211:
            return "kAXErrorAPIDisabled:整台电脑的辅助功能权限没给工作台"
        case -25204:
            return "kAXErrorCannotComplete:它的辅助功能树还没长出来(已敲过 AXManualAccessibility 并重试过)"
        case -25212:
            return "kAXErrorInvalidUIElement:手里那个元素引用已经作废了"
        case -25205:
            return "kAXErrorAttributeUnsupported:它没有这条属性"
        default:
            return "AXError \(err)"
        }
    }

    /// 弹框现场里的一颗键(壳扫出来的:标题 / 描述 / 它的 subrole)。
    struct ModalButton: Equatable {
        let title: String?
        let description: String?
        /// 窗口自己那几颗控件靠它认出来(`AXCloseButton` / `AXMinimizeButton` / …)。
        let subrole: String?

        init(title: String?, description: String?, subrole: String?) {
            self.title = title
            self.description = description
            self.subrole = subrole
        }
    }

    /// 窗口自己那几颗控件 —— **它们的「关闭」关掉的是她的窗口**,不是弹框。永远不算候选。
    static let windowControlSubroles = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton",
                                        "AXFullScreenButton", "AXToolbarButton"]

    /// 网页 / 原生里「这是一层模态」的那几个角色。
    static let modalRoles = ["AXSheet", "AXDialog", "AXAlert", "AXSystemDialog",
                            "AXApplicationDialog", "AXApplicationAlert"]

    /// **绝不按**的那几颗:按下去就是替她同意 / 开通 / 确认 / 允许了什么。一票否决,排在纯关闭之前判。
    static let neverPressWords = ["开始体验", "立即体验", "体验", "同意", "接受", "开通", "确认", "确定",
                                  "允许", "继续", "立即", "马上", "试用", "授权", "登录", "注册", "购买",
                                  "订阅", "升级", "付款", "支付", "删除", "清空", "开启", "启用", "安装",
                                  "更新", "发送", "提交", "保存", "分享", "邀请",
                                  "agree", "accept", "allow", "continue", "confirm", "upgrade", "subscribe",
                                  "buy", "pay", "sign in", "sign up", "log in", "login", "install", "update",
                                  "enable", "delete", "send", "submit", "save", "share", "try", "start"]

    /// 逐字相同才算的那几颗(短名:混在别的字里毫无意义,「导出为 xlsx」里那个 x 不是关闭键)。
    static let pureCloseExact = ["x", "✕", "✖", "×", "╳", "关闭", "close", "dismiss", "skip", "跳过",
                                 "稍后", "以后", "暂不", "later", "取消关闭"]

    /// 整句里带着就算的那几条(长到不会误伤)。
    static let pureClosePhrases = ["以后再说", "稍后再说", "暂时不", "不用了", "不再显示", "关闭弹窗",
                                   "关闭窗口", "关闭提示", "not now", "no thanks", "maybe later",
                                   "close dialog", "close modal", "skip for now"]

    /// 这颗键是不是**纯关闭**(按它只是把这层框收起来,不替她答应任何事)。
    ///
    /// 两道门:① 窗口自己那几颗控件直接出局;② 「同意 / 开通 / 确认 / 允许」这类词一票否决 ——
    /// 哪怕它字面上也写着「关闭」(「关闭并同意」)。剩下的才拿去对那两张表。
    static func isPureCloseButton(title: String?, description: String?, subrole: String?) -> Bool {
        if let subrole, windowControlSubroles.contains(subrole) { return false }
        let parts = [title, description].compactMap { $0 }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if parts.isEmpty { return false }
        let joined = parts.joined(separator: " ").lowercased()
        if neverPressWords.contains(where: { joined.contains($0) }) { return false }
        if pureClosePhrases.contains(where: { joined.contains($0) }) { return true }
        return parts.contains { pureCloseExact.contains($0.lowercased()) }
    }

    /// 这颗键**绝不按**(替她同意 / 开通 / 确认 / 允许那一类)。判「有没有框挡着」时也用它:
    /// 一整块遮罩 + 一颗这样的推广键,几乎一定是弹框。
    static func isNeverPressButton(title: String?, description: String?) -> Bool {
        let joined = [title, description].compactMap { $0 }.joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if joined.isEmpty { return false }
        return neverPressWords.contains(where: { joined.contains($0) })
    }

    /// 有没有一层框挡在前面。**只在「找不到输入框」之后才问这一句** —— 有输入框就压根不走到这里。
    ///
    /// - `roles`:这扇窗的树里出现过的角色 / subrole(壳扫的时候顺手记下的);
    /// - `buttons`:树里那几颗键(窗口自己的控件已经带着 subrole,判断时自己会排除);
    /// - `coverRatio`:盖住这扇窗最大的那一块占窗口的比例(网页里那层遮罩;整棵树的根不算)。
    static func looksLikeModalCover(roles: [String], buttons: [ModalButton], coverRatio: Double?) -> Bool {
        if roles.contains(where: { modalRoles.contains($0) }) { return true }
        let closable = buttons.filter { isPureCloseButton(title: $0.title, description: $0.description, subrole: $0.subrole) }
        // 现场那一种:遮罩把主区域盖住,树里剩下的就是这层框自己的那两颗键。
        if let ratio = coverRatio, ratio >= 0.6,
           !closable.isEmpty || buttons.contains(where: { isNeverPressButton(title: $0.title, description: $0.description) }) {
            return true
        }
        // 遮罩读不出来(比例算不出)也还有一条:树里只剩寥寥几颗键,其中一颗是纯关闭。
        return buttons.count <= 4 && !closable.isEmpty
    }

    /// 认出来之后怎么办。
    enum ModalVerdict: Equatable {
        /// 没有框挡着 —— 什么都不做。
        case noModal
        /// 按第 `index` 颗键把它关掉(**只会是纯关闭那一颗**)。
        case close(index: Int)
        /// 认不准 / 关不掉 —— 一颗都不按,如实说。
        case giveUp
    }

    /// 挡着的这层框关得掉吗。关得掉 = 树里找得到一颗纯关闭键;找不到就 `giveUp`(**绝不退而求其次**)。
    static func modalVerdict(looksModal: Bool, buttons: [ModalButton]) -> ModalVerdict {
        guard looksModal else { return .noModal }
        for (index, button) in buttons.enumerated() {
            if isPureCloseButton(title: button.title, description: button.description, subrole: button.subrole) {
                return .close(index: index)
            }
        }
        return .giveUp
    }

    /// 框上那句话(念给她听时带上它,她才知道是哪个框)。取读到的第一句,截到 24 字。
    static func modalHint(texts: [String]) -> String? {
        for text in texts {
            let one = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if one.isEmpty { continue }
            return one.count <= 24 ? one : String(one.prefix(24)) + "…"
        }
        return nil
    }

    /// **网页那一层压根没长出来**:树里只剩窗口自己那几颗控件,一个字都读不到。
    /// 与「这个 App 真没有输入框」分开说 —— 前者去看一眼窗口就能解决(常见就是被一层框盖住了),
    /// 后者是这家客户端的事实。
    static func looksLikeShellOnlyTree(buttons: [ModalButton], texts: [String]) -> Bool {
        if texts.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { return false }
        return buttons.allSatisfy { button in
            guard let subrole = button.subrole else { return false }
            return windowControlSubroles.contains(subrole)
        }
    }

    // MARK: - 自绘界面的输入框(2026-10-02,卡「适配自绘界面的 Kimi」)

    /**
     ★ **自己画界面的那一类 App,输入框不在 `inputRoles` 里**(2026-10-02)。

     现场(Air 诊断包 20261002-193929):官网版 Kimi `com.moonshot.kimichat.kmp.mac` 登录之后
     辅助功能树是 `{AXGroup:4, AXScrollArea:6, AXUnknown:32, AXButton:4, AXScrollBar:5, AXStaticText:23}` ——
     **对话文字读得到**(23 块静态文本),可输入框与发送键被那套自绘工具箱(Compose 一类)
     报成了 `AXUnknown`,一个 `AXTextArea` / `AXTextField` 都没有。举例 = 一整类:
     Compose / Flutter / 自画 canvas 的客户端都是这个样子,所以这里**不认任何一家的名字**,只认形状。

     两条，按顺序:
     1. **先在那堆 `AXUnknown` / `AXGroup` 里认**(`looksLikeDrawnInput`):窗口下部、宽而矮、
        可聚焦或 `AXValue` 写得进去或有 `AXPress`;
     2. **认不出位置就兜底**(`bottomCenterInput`):点窗口下部中央让它拿到焦点。

     两条都只能**点**,不能写 AXValue(`InputCandidate.drawn` 与 Muse 那颗 `composer` 同一档:
     `pickInput` → `.clickOnly` → `method` → `.paste`)——送话走的是壳已有的那条**剪贴板粘贴 + 回车**,
     没有新造的手段。发没发出去由服务端在对话区里找她那一句来核(`dispatchRun` 那一道),
     壳这一侧如实回「核不了」,**绝不假装送成了**。

     **这条路有闸**:只在 `looksSelfDrawnTree` 为真(这棵树确实一个标准输入角色都没有、
     认不出来的交互节点够多)时才走 —— 不然一次「Electron 的树还没建好」就会变成在她窗口里乱点一下。
     */

    /// 自绘界面里拿来当输入框看的角色(自绘工具箱把自己的控件报成这两种)。
    static let drawnInputRoles: Set<String> = ["AXUnknown", "AXGroup"]

    /// 这棵树上至少要有这么多个认不出来的交互节点(`AXUnknown`),才当它是自绘界面。
    /// 与插件 `server/agentJudge.ts` 的 `SELF_DRAWN_UNKNOWN_MIN` 是同一个数(一处改两处跟)。
    static let selfDrawnUnknownMin = 4

    /**
     这棵树**是不是自绘界面**。只看角色的个数:
     - 一个标准文本输入角色都没有(有而没认出来是别的毛病:位置不对、整块编辑区 —— 不该来点窗口);
     - `AXUnknown` 至少 `selfDrawnUnknownMin` 个(`AXGroup` 故意不算:网页那一层的树里到处是它,
       算进去会把「Electron 的树还没建好」误当自绘);
     - 有个滚得动的区(`AXScrollArea` / `AXScrollBar`)—— 对话区总得滚。
     */
    static func looksSelfDrawnTree(roles: [String: Int]) -> Bool {
        if inputRoles.contains(where: { (roles[$0] ?? 0) > 0 }) { return false }
        if (roles["AXUnknown"] ?? 0) < selfDrawnUnknownMin { return false }
        return (roles["AXScrollArea"] ?? 0) > 0 || (roles["AXScrollBar"] ?? 0) > 0
    }

    /**
     这个 `AXUnknown` / `AXGroup` 节点**像不像那个输入框**:
     - 在窗口里、在**下部**(中心线过了窗高 60%);
     - **宽而矮**:至少占窗宽三成、长宽比 ≥ 3、矮于窗高两成,且过得了幽灵元素那道尺寸下限;
     - **动得了**:可聚焦,或者 `AXValue` 写得进去,或者有 `AXPress`。

     三样缺一不认 —— 认错一个节点 = 把她那句话点进别的地方。
     */
    static func looksLikeDrawnInput(role: String, frame: CGRect, window: CGRect,
                                   settable: Bool, focusable: Bool, pressable: Bool) -> Bool {
        looksLikeDrawnInputShape(role: role, frame: frame, window: window) && (settable || focusable || pressable)
    }

    /// 上面那一条里**只看形状**的那一半(角色 + 位置 + 宽高比)。
    /// 分出来是为了省 IPC:形状过了才去问它那几条属性写不写得进去、有没有 `AXPress`
    /// (一棵自绘的树上几十个 `AXUnknown`,每个都问一遍动作名是几十次来回)。
    static func looksLikeDrawnInputShape(role: String, frame: CGRect, window: CGRect) -> Bool {
        guard drawnInputRoles.contains(role) else { return false }
        guard window.width > 0, window.height > 0 else { return false }
        guard frame.width.isFinite, frame.height.isFinite, frame.midX.isFinite, frame.midY.isFinite else { return false }
        guard frame.width >= minInputSize.width, frame.height >= minInputSize.height else { return false }
        guard window.contains(CGPoint(x: frame.midX, y: frame.midY)) else { return false }
        guard frame.width >= window.width * 0.3 else { return false }
        guard frame.height <= window.height * 0.2 else { return false }
        guard frame.width / frame.height >= 3 else { return false }
        // AX 坐标 y 向下:越靠下 midY 越大。
        return frame.midY >= window.minY + window.height * 0.6
    }

    /**
     **认不出位置时的兜底落点**:窗口下部中央那一条(点它一下让输入框拿到焦点)。
     横向取中间一半,纵向取窗高的 82%–88% 那一带 —— **不贴底边**:底边那一两行常是版本号、
     免责声明,点上去什么也不会发生,还可能点到窗口边框。
     */
    static func bottomCenterInput(window: CGRect) -> CGRect {
        CGRect(x: window.minX + window.width * 0.25, y: window.minY + window.height * 0.82,
               width: window.width * 0.5, height: window.height * 0.06)
    }

    /// 兜底那一下写进日志与交接的那句话(不是装饰:她问「它怎么知道往哪点」时答的就是这句)。
    static let drawnFallbackWhy = "自绘界面:一个标准输入框都认不出,按窗口下部中央点一下让它拿到焦点"

    /**
     ★ **这块字还躺在输入框那一带**(2026-10-02)。

     为什么要它:`read_reply`(按记号在对话区里找我们那一句 —— 「发出去了」的唯一凭据)靠
     `inputRoles` 那个记号把**输入框里的字**排除在回答之外。自绘界面里压根没有那个角色,
     于是**粘贴进去、还没发出去的那一句也会被「找到」** —— 那就成了假凭据:字停在框里,
     工作台却说「已送达」。

     所以自绘那一类多一道:命中那一块字**在哪**。落在窗口下部那一带(`bottomCenterInput` 那一条
     往下)= 它还在输入框里,如实回「没看见发出去」。对话区的字画不到输入框底下,
     所以这一条认错的余地很小;认错了也只是**悲观**(说没看见),不会假装送成了。
     */
    static func looksLikeInInputBand(frame: CGRect, window: CGRect) -> Bool {
        guard window.height > 0, frame.midY.isFinite else { return false }
        return frame.midY >= bottomCenterInput(window: window).minY
    }

    // MARK: - 说人话的失败原因

    /// 失败原因**必须说得出是哪一步断的**(卡上的规矩:不假装成功)。
    enum Failure: Equatable {
        case notAllowed(bundleId: String)
        case notRunning(bundleId: String)
        case noWindow(bundleId: String)
        case axDisabled(bundleId: String, err: Int32)
        case noInput(bundleId: String, detail: String)
        case writeRejected(bundleId: String, err: Int32)
        /// 写进去了,但读回来不是那段话(被输入法/前端框架吃了,或者它自己清空了)。
        case readbackMismatch(bundleId: String, got: String)
        case clipboardFailed(bundleId: String)
        case emptyText
        /// 框里有他自己没发出去的字。**默认不覆盖**(2026-09-21 实测发现:三家客户端的
        /// 输入框随时可能存着一句写了一半的话,一写 AXValue 就没了)。
        case draftInTheWay(bundleId: String)
        /// 要先开新对话,但菜单里找不到 / 按不动那一项。**不送** —— 送了就打进他正开着的那条对话。
        case noNewConversation(bundleId: String, detail: String)
        /// **它窗口正中弹着一层框挡住了界面**,而且这层框**关不掉**(2026-09-28,卡 DP:
        /// 豆包那个「手机控制电脑」推广框,左边一颗「开始体验」、右上角一个 ×)。
        /// 关得掉的壳自己关了再送;走到这一句 = 只剩她自己去点一下。`hint` 是框上那句话(读不到就缺席)。
        case modalInTheWay(bundleId: String, hint: String?)
        /// 这扇窗的 AX 树里**只剩窗口自己那几颗控件**,网页那一层没长出来(2026-09-28,卡 DP)。
        /// 与「这个 App 真没有输入框」分开说:被一层框盖住、或者它还在加载,都长这样。
        case treeShellOnly(bundleId: String)
        /// 那扇窗上挂着一个对话框(AXSheet:存储 / 打开 / 设置……)。**不送** —— 2026-09-24 实测:
        /// Claude 窗口上挂着一个「存储」面板时,焦点在它的文件名框里,话会打进文件名、回车就存了一个文件。
        case sheetInTheWay(bundleId: String)

        var message: String {
            switch self {
            case .notAllowed(let b):
                return "不许往这个应用送话:\(b)(白名单只有 Agent 客户端,微信/企业微信这类永远不在里面)"
            case .notRunning(let b):
                return "找不到窗口:\(b) 没在运行"
            case .noWindow(let b):
                return "找不到窗口:\(b) 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)"
            case .axDisabled(let b, let err):
                // ★ 2026-09-28(卡 DP):以前这一句一律写「kAXErrorAPIDisabled = -25211」,
                // 而真机回的是 **-25204**(cannot complete)—— 那不是权限没给,是树还没长出来。
                // 说错了下一步就查错了方向(去开辅助功能权限,而它本来就是开着的)。
                return "辅助功能通道没通:\(b) 回 \(err)(\(axGateHint(err: err)))"
            case .modalInTheWay(let b, let hint):
                let what = hint == nil ? "" : "(「\(hint!)」)"
                return "没送:\(b) 那边弹了个框挡着\(what) —— 我只按「×/关闭/稍后」这类纯关闭的键,这个关不掉;去点一下再叫我派"
            case .treeShellOnly(let b):
                return "没送:\(b) 的窗口里只读到窗口本身,网页那一层没长出来(它被一层弹框盖住时也会这样)—— 去看一眼它的窗口,有框就关掉再叫我派"
            case .noInput(let b, let detail):
                return "输入框没找到:\(b) —— \(detail)"
            case .writeRejected(let b, let err):
                return "输入框没接住这段话:\(b) 写 AXValue 回 \(err)"
            case .readbackMismatch(let b, let got):
                return "送进去了但读回来对不上:\(b) 框里现在是「\(got)」——没送成,别当成功"
            case .clipboardFailed(let b):
                return "剪贴板这条路没走通:\(b)(写不进剪贴板,已按原样还回用户的剪贴板)"
            case .emptyText:
                return "要送的话是空的,没送"
            case .draftInTheWay(let b):
                return "没送:\(b) 的输入框里有你没发出去的字,覆盖掉就找不回来了(要覆盖得明着说 overwrite)"
            case .noNewConversation(let b, let detail):
                return "没送:\(b) 开不了新对话(\(detail))——硬送就打进你正开着的那条对话里了"
            case .sheetInTheWay(let b):
                return "没送:\(b) 的窗口上开着一个对话框(存储 / 打开 / 设置之类),话会打进那个框里 —— 先把它关掉再派"
            }
        }
    }
}

// MARK: - 只读几小段字(read_texts,2026-09-25 卡 O「额度要覆盖派活名单里的每一家」)

/// Manus、Muse 这几家的额度**只在它们自己的窗口上**(Manus 首页右上角那一格积分、Muse「使用情况」页上的
/// 「已使用 N%」),没有别的地方能读。壳替服务端去窗口里找 —— 但**只回命中的那一小段字**:
/// 服务端给几条正则,壳把文字流过一遍,回的是「1,234」「已使用 38%」这种片段和它在窗口里的位置,
/// 窗口里别的字(他的任务标题、对话内容)一个都不往外带。判断全在这里(纯函数,有单测);
/// 真去碰 AX 的那一半在 `TextInsert.readTexts`,一条判断都不自己下。
extension SendTextPolicy {
    /// 服务端给的一条「我要找的那一小段字」。
    /// - `id`:服务端自己认的名字(「manus.credits」),原样带回;
    /// - `regex`:NSRegularExpression 语法,**只回命中的那一段**,不是整个节点;
    /// - `top`:只认离窗口上沿这么多点以内的字(顶栏里的那一格);缺省 = 整扇窗。
    struct TextPattern {
        let id: String
        let regex: NSRegularExpression
        let top: Double?
    }

    /// 文字流里的一段:值 + 它在窗口里的位置(相对窗口左上角,AX 坐标,y 向下)。
    struct TextNode: Equatable {
        let text: String
        let x: Double
        let y: Double
    }

    /// 一次最多几条 pattern、回几段(防一次读出一整页)。
    ///
    /// ★ **2026-09-27(卡 AG)放宽:8 → 12 条、12 → 24 段。** 维护者原话:「为什么我肉眼都看到
    /// 额度信息了,但是还说读不到或者读反了」。Antigravity 的「Models & Usage」一页上光用量那几行就有
    /// **两组模型 × 两条限额 = 四行**(「Gemini Models」/「Claude and GPT models」下各有
    /// 「Weekly Limit Remaining」「Five Hour Limit Remaining」),加页标题、档位、两句刷新时间 ——
    /// 12 段名额当场挤爆,组名那两行连一条正则都排不上(卡 QG 因此只能把两组并成一行)。
    ///
    /// 上限还在、只是抬高了一档:**这两个数是隐私闸,不是性能闸** —— 壳照旧只回正则命中的那一小段
    /// (≤80 字),整窗的字一个都不往外带。24 段 × 80 字 ≈ 2KB,仍然远不到「把他的对话喂出去」那条线。
    static let readTextsMaxPatterns = 12
    static let readTextsMaxMatches = 24
    /// 一段命中最长回多少字(积分、百分比、一句「积分已用完,将于 9月26日 重置」都在这以内)。
    static let readTextsMaxChars = 80

    /// 解析服务端给的 patterns。**有一条不合法就整个不认**(nil)—— 宁可不读,不猜着读。
    static func parseTextPatterns(_ raw: Any?) -> [TextPattern]? {
        guard let list = raw as? [[String: Any]], !list.isEmpty, list.count <= readTextsMaxPatterns else { return nil }
        var out: [TextPattern] = []
        for item in list {
            guard let id = item["id"] as? String, !id.isEmpty,
                  let source = item["regex"] as? String, !source.isEmpty,
                  let regex = try? NSRegularExpression(pattern: source, options: []) else { return nil }
            let top = (item["top"] as? NSNumber)?.doubleValue
            out.append(TextPattern(id: id, regex: regex, top: top))
        }
        return out
    }

    /// 在文字流里找命中。**只回命中的那一小段**(不超过 `readTextsMaxChars`),带它的位置;
    /// 顺序 = 文字流顺序(文档顺序);总数封顶 `readTextsMaxMatches`。
    static func matchTexts(_ nodes: [TextNode], patterns: [TextPattern]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for node in nodes {
            let text = node.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let range = NSRange(text.startIndex..., in: text)
            for pattern in patterns {
                if let top = pattern.top, node.y > top { continue }
                guard let hit = pattern.regex.firstMatch(in: text, options: [], range: range),
                      let r = Range(hit.range, in: text) else { continue }
                let piece = String(text[r])
                if piece.isEmpty || piece.count > readTextsMaxChars { continue }
                out.append(["id": pattern.id, "text": piece, "x": node.x.isFinite ? node.x : 0, "y": node.y.isFinite ? node.y : 0])
                if out.count >= readTextsMaxMatches { return out }
            }
        }
        return out
    }

    // MARK: - 「还有几扇窗不在这会儿看着的桌面上」(2026-09-26,卡 MQ2)

    /// 系统窗口清单里的一扇窗,**只要这几格**(壳一个标题都不读 —— 聊天窗的标题多半就是他那条对话的名字)。
    struct OSWindow: Equatable {
        let id: Int
        /// 窗口层:0 = 普通窗口(菜单、浮层、输入法候选框在更高的层)。
        let layer: Int
        let width: Double
        let height: Double
        /// 在不在**这会儿显示着的那个桌面(Space)**上。
        let onSpace: Bool
    }

    /// 这一条算不算「一扇窗」:普通层、两边都到 200pt。
    /// (小块的那些是阴影 / 角标 / 小徽标一类,不是一扇窗;实测 Muse 就有 34×18、300×124 这样的。)
    static func countsAsWindow(_ win: OSWindow) -> Bool {
        win.layer == 0 && win.width >= 200 && win.height >= 200
    }

    /// 这个 App 一共有几扇窗(系统数得到的那一份)。
    static func windowCount(_ windows: [OSWindow]) -> Int {
        windows.filter(countsAsWindow).count
    }

    /// 其中有几扇**不在这会儿显示着的那个桌面上**。
    ///
    /// ★ 2026-09-26(卡 MQ2)为什么要**真去数**、不拿「系统说有几扇 − AX 读到几扇」减:
    ///
    /// 实测(Muse,同一个进程里同一刻对照着采,`Tools/main.swift` 的 `probe spacewatch`):
    /// 辅助功能**只列这会儿显示着的那个桌面上的窗** —— 窗一旦不在这个桌面上就从 `AXWindows` 里消失,
    /// 只剩主窗那一扇还在(而且 subrole 从 `AXStandardWindow` 变成 `AXDialog`,像个降级的影子)。
    /// 减法在这种时候会**说错话**:
    ///
    /// - 减出来的是「系统有、我们没读到」的扇数,界面上却照着它说「有 N 扇在别的桌面上」——
    ///   哪天某家在**这个**桌面上有一扇 AX 不肯露的窗(浮动小面板这类),减法就会让工作台
    ///   告诉他「去别的桌面找找」,而那边什么都没有(D13:不编数,更不编一句要他白跑一趟的话);
    /// - 反过来,主窗那一扇不在这个桌面上也照样读得到,减法会把它从「别的桌面上」那一笔里抹掉。
    ///
    /// 数出来的这个数只说一件量到的事:**这个 App 有几扇窗不在你这会儿看着的桌面上。**
    static func offSpaceWindowCount(_ windows: [OSWindow]) -> Int {
        windows.filter { countsAsWindow($0) && !$0.onSpace }.count
    }

    // MARK: - 藏着的那一家:读之前先放出来,读完照原样藏回去(2026-09-26,卡 MQ3)

    /// ★ 为什么非得有这一套:**工作台自己就是那只藏它的手。**
    ///
    /// 窗口槽那一套「遮罩一收就藏回去」(`WindowControl.hide`)把槽里那扇窗藏起来,是为了让弹层
    /// 不被原生窗盖住 —— 那条规则一个字都不动。可它的副作用是:**被藏过一次的那一家,额度这条路就死了**
    /// (卡 MQ2 量到的:`isHidden` 的 App 辅助功能一扇窗都列不出,与它开着几扇、在不在用量那一页无关)。
    /// 维护者 2026-09-26 18:50 看到的正是这件事:Muse、Manus 都成了「没接上」,点「读一下」什么都不变
    /// —— 而 Manus 之前明明读到过 2,690 积分。
    ///
    /// 所以读之前把它**放出来**(`NSRunningApplication.unhide()`,**不 activate**:不抢焦点、不闪到台前),
    /// 等一拍让 AX 那张清单跟上,读完**按原样藏回去**。工作台整屏在最前时,放出来的窗排在它后面,
    /// 他看不见任何闪动(不 activate 的 App 的普通窗不会越到台前那个 App 的窗上面)。
    static let unhideWaitMs = 900
    /// 放出来之后最多看几眼(最坏 3 × 900ms ≈ 2.7 秒;服务端给 `read_texts` 的是 8 秒,留得下 ——
    /// 同卡 MQ 给 Electron 那棵树定的「两眼加一拍」那笔预算)。
    static let unhideMaxLooks = 3

    /// 放出来之后还值不值得**再看一眼**:一扇窗都还没露出来、而且没看够几眼。
    ///
    /// 为什么不是放出来就立刻读:卡 MQ2 的 `probe spacewatch` 实测过,窗一进 / 一出「这会儿显示着的
    /// 那个桌面」,`AXWindows` 那张清单要**一两秒**才跟上;放出来那一下同理,立刻去读还是
    /// 「一扇标准窗口都没有」。所以等一拍再看,没露出来就再等一拍 —— 节奏照卡 MQ 的
    /// `AgentWindowPolicy.treeWakeWaitMs`(900ms)。
    static func worthAnotherUnhideLook(windows: Int, looks: Int) -> Bool {
        windows <= 0 && looks < unhideMaxLooks
    }

    /// 读完要不要把它**藏回去**:本来就是藏着的才藏(它本来是工作台藏的、还是他自己按 ⌘H 藏的,
    /// 都一样恢复原样),**除非这会儿它自己到了台前** —— 那就是读的这一两秒里他点了它,
    /// 这时候把窗从他手底下抽走比读不到额度坏得多。
    static func shouldRehide(wasHidden: Bool, isActive: Bool) -> Bool {
        wasHidden && !isActive
    }

    // MARK: - 「键身上的字」也读(read_texts 的 `include_titles`,2026-10-03 卡「豆包闪一下 / Grok 读键字」)

    /**
     ★ **哪几种角色的「身上那行字」算一段可读的文字**(`include_titles` 为真时才问这张表)。

     为什么非得有这一格:真机量到的(10-03,`probe quota-keys com.anysphere.sand`)——
     Grok Bot 的额度写在**一颗键身上**:

         AXMenuItem (22,708) 220x30  ['SuperGrok 6%']      ← 额度就是这一行

     而 `read_texts` 按设计只收 `AXStaticText` 的 `AXValue`(见 `TextInsert.readTexts`)。
     同一刻整扇窗的静态字里**一个百分号都没有**(89 块字、额度那几条正则命中 0)——
     也就是说那一格不是「没翻到那一页」,是**那个数压根不在我们读的那一类节点上**。

     ## 为什么只给声明了的那一家开(`include_titles`,缺省 false)

     Muse / 豆包那条「这确实是额度那一页」的旁证是按**整格静态字**认的
     (`^使用情况$` / `^(?:订阅与额度管理|标准套餐)$`)。把键身上的字全局收进文字流,
     一颗叫「使用情况」的侧栏键立刻就把那条旁证骗过去了 —— 那比读不到坏得多(卡 MQ 的老教训:
     假阳性比读不到坏)。所以这一格**按家声明**:插件只对查实过的那一家发 `include_titles: true`。

     ## 为什么表里只有这两档

     `AXMenuItem`(Grok Bot 那六行账号菜单)与 `AXButton` 是**量到过把字写在 title 上**的两档。
     `AXStaticText` 不在表里(它那条路本来就收,`AXValue`);`AXPopUpButton` 也不在 ——
     豆包那颗键身上写的是「<账号名> 标准套餐」(账号名是她的),收进文字流只会给额度那几条正则
     送去一行只对她这一台机器成立的字。**没量到的不往表里写**(D13)。
     */
    static let titleRoles: Set<String> = ["AXMenuItem", "AXButton"]

    /// 这一个节点的「身上那行字」这一趟读不读:**`includeTitles` 没明着给就一个都不读**
    /// (= 缺省行为与 2026-10-03 之前一字不差),给了也只读 `titleRoles` 那两档。
    static func readsTitle(role: String, includeTitles: Bool) -> Bool {
        includeTitles && titleRoles.contains(role)
    }
}
