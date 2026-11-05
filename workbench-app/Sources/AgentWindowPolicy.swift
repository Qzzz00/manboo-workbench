import CoreGraphics
import Foundation

/// 「Agent 自动发现与统一接入」(2026-09-25,卡 Q)里**不碰系统 API 的那一半**。
///
/// 维护者:「后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、标题、内容」——
/// 所以壳读窗口这件事**不认名单**:哪一家是 Agent 由工作台(插件那一侧)按登记表说了算,
/// 壳只负责把窗口**长什么样**、**写着什么**如实读回去。判断(像不像对话窗口、哪一行是最新一句、
/// 它是不是还在跑)全在插件 `server/agentJudge.ts` / `server/agentWindowModel.ts`,有单测。
///
/// 这个文件故意不 import AppKit / ApplicationServices(先例 `SendTextPolicy.swift`):
/// 区域怎么分、界面字怎么截、哪几家**永远不读**,这些最容易写错,单测里要造得出来。
/// 真去调 AX 的那一半在 `AgentWindow.swift`。
///
/// 坐标:回给服务端的矩形一律是**相对那扇窗左上角**的(窗口挪到哪块屏都一样),取整,NaN 记 0。
enum AgentWindowPolicy {

    // MARK: - 永远不读的那几家(隐私底线)

    /// **人跟人聊天的应用永远不读**(卡 Q 第 2 条:微信、企业微信这一类判为不是 Agent,不读)。
    ///
    /// 判定「是不是 Agent」的机制在插件那一侧(先看名字与类别让模型判一次,人跟人聊天的**连窗口结构都不看**);
    /// 这张表只是壳这一侧的**第二道门**:哪怕服务端那一侧判错了、或者被人手工调了接口,
    /// 壳也不把这几家的窗口读出去。与 `SendTextPolicy.neverBundleIds` 是同一张表(一处定义,两处用)。
    static func neverRead(_ bundleId: String) -> Bool {
        SendTextPolicy.neverBundleIds.contains(bundleId)
    }

    /// 拒读时回的那一句。
    static func neverReadMessage(_ bundleId: String) -> String {
        "不读这个应用的窗口:\(bundleId)(人跟人聊天的应用,工作台永远不读)"
    }

    // MARK: - 截字

    /// 按字符截短,超了加「…」。换行与连续空白并成一个空格(界面字、标题、最新一句都只要一行)。
    static func clip(_ text: String, _ max: Int) -> String {
        let flat = text
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
        guard flat.count > max, max > 0 else { return flat }
        return String(flat.prefix(max)) + "…"
    }

    // MARK: - 坐标

    /// 屏幕坐标 → 相对那扇窗左上角。
    static func relative(_ frame: CGRect, to window: CGRect) -> CGRect {
        CGRect(x: frame.origin.x - window.origin.x, y: frame.origin.y - window.origin.y,
               width: frame.width, height: frame.height)
    }

    /// 取整;NaN / ∞ 记 0(Muse 的辅助功能树里就有这种元素,`Int(.infinity)` 会让整个壳直接陷入)。
    static func int(_ v: CGFloat) -> Int {
        guard v.isFinite, abs(v) < 1_000_000 else { return 0 }
        return Int(v.rounded())
    }

    /// 回给服务端的矩形:取整,NaN / ∞ 记 0。
    static func rectJSON(_ r: CGRect) -> [String: Int] {
        ["x": int(r.origin.x), "y": int(r.origin.y), "w": int(r.width), "h": int(r.height)]
    }

    // MARK: - 侧栏

    /// 侧栏**只可能**在左边这一截里(读侧栏时,整个在它右边的那一枝不看)。
    static let sidebarSearchRatio: CGFloat = 0.45

    /// 这个容器像不像侧栏:从窗口左边一成以内开始(左边常有一条图标栏)、至少 120 点宽、
    /// 宽不到窗宽 45%、比窗高一半还高。**用它的真实边界分侧栏与对话区**,不按一个固定比例切 ——
    /// 按比例切的话,对话区里靠左的一小块字(一句话碎成几块时常见)会被当成侧栏里的字丢掉。
    static func looksLikeSidebar(_ rel: CGRect, windowSize: CGSize) -> Bool {
        guard rel.origin.x.isFinite, rel.origin.y.isFinite, rel.width.isFinite, rel.height.isFinite,
              windowSize.width > 0, windowSize.height > 0 else { return false }
        return rel.minX <= windowSize.width * 0.1
            && rel.width >= 120
            && rel.width <= windowSize.width * sidebarSearchRatio
            && rel.height >= windowSize.height * 0.5
    }

    /// 几个像侧栏的容器里挑一个:最高的;一样高挑最宽的(外层那个把图标栏与列表都包进去)。
    static func pickSidebar(_ candidates: [CGRect]) -> CGRect? {
        candidates.max { a, b in
            if abs(a.height - b.height) > 1 { return a.height < b.height }
            return a.width < b.width
        }
    }

    /// 这个元素落在侧栏里(横着不出侧栏左右 2 点)。
    static func inSidebar(_ rel: CGRect, sidebar: CGRect?) -> Bool {
        guard let sidebar, rel.origin.x.isFinite, rel.width.isFinite else { return false }
        return rel.minX >= sidebar.minX - 2 && rel.maxX <= sidebar.maxX + 2
    }

    /// 读侧栏时这一支可以整枝不看:它整个在左边那一截的右边(对话区、输入区)。
    /// 横贯整扇窗的容器(minX≈0)不剪 —— 侧栏就在它里面。
    static func beyondSidebarSearch(_ rel: CGRect, windowWidth: CGFloat) -> Bool {
        guard rel.origin.x.isFinite, windowWidth > 0 else { return false }
        return rel.minX >= windowWidth * sidebarSearchRatio
    }

    // MARK: - 结构探测里的几个数

    /// 字块数:一共几块、侧栏里几块、输入框上面(对话区)几块。**只数,不读字**。
    static func textCounts(frames: [CGRect], sidebar: CGRect?, inputTop: CGFloat?) -> (total: Int, left: Int, aboveInput: Int) {
        var left = 0
        var above = 0
        for f in frames {
            if inSidebar(f, sidebar: sidebar) { left += 1; continue }
            if let top = inputTop {
                if f.midY.isFinite, f.midY < top { above += 1 }
            } else {
                above += 1
            }
        }
        return (frames.count, left, above)
    }

    /// 输入区那一排按钮的名字(「附加文件」「语音」「深度思考」「联网搜索」这类)——
    /// **只取输入框那一片的**:竖着从输入框上沿往上 80 点到窗底,横着不出输入框左右 40 点。
    /// 那是界面上的控件,不是对话内容;侧栏里的按钮(可能是联系人、会话名、他自己的名字)一个都不带。
    /// 去重,最多 `max` 个,每个截 30 字。
    static func toolbarLabels(buttons: [(label: String, frame: CGRect)], input: CGRect?, max: Int = 12) -> [String] {
        guard let input, input.minY.isFinite, input.minX.isFinite, input.maxX.isFinite else { return [] }
        var out: [String] = []
        for b in buttons {
            let label = clip(b.label, 30)
            if label.isEmpty || out.contains(label) { continue }
            guard b.frame.midY.isFinite, b.frame.midX.isFinite else { continue }
            guard b.frame.midY >= input.minY - 80 else { continue }
            guard b.frame.midX >= input.minX - 40, b.frame.midX <= input.maxX + 40 else { continue }
            out.append(label)
            if out.count >= max { break }
        }
        return out
    }

    // MARK: - 读的上限

    /// 一次结构探测最多看多少个节点、最多花多久。探测**一个 App 一辈子只做几次**(判完就记下),可以宽一点。
    static let probeMaxVisited = 4000
    static let probeMaxMs: Double = 900
    /// 一次读(状态 / 标题 / 最新一句)的上限。巡检每一两分钟一次、在跑时几秒一次,要省。
    static let readMaxVisited = 2500
    static let readMaxMs: Double = 450
    static let sideMaxVisited = 1500
    static let sideMaxMs: Double = 250
    /**
     ★ **在整扇窗里找一颗导航键的上限**(2026-10-03,卡 QP;`quota_page` 用)。

     为什么不能跟 `readMax*` 那一份:真机实测(10-03,Muse 两扇 Electron 窗,机器负载很高)
     按 2500 节点 / 450ms 那一份走,**侧栏那几颗导航键一颗都走不到** —— 回的是「认不出这颗键」,
     而那几颗键 `probe quota-keys`(没有时限的同一套走法)明明列得出来。
     `readMax*` 是给「弹在对话区上那个框」定的(那个框几十个节点就到,而且**每一两秒**要读一次,
     所以要省);`quota_page` 是**十分钟最多一次**、要在整扇窗(还要每一扇)里找一颗键,
     省在这里买不到任何东西,只会买到一句假话(「认不出」其实是「没走到」)。

     节点数跟读额度那一趟同一个数(`TextInsert.readTexts` 的 `maxVisits`,24000);
     毫秒是**几扇窗合起来**的总预算(`quotaPage` 自己按剩下多少往下传),2.5 秒留得下 ——
     插件给这个 op 的是 8 秒,前面还有一次最多 2.7 秒的「放出来等清单跟上」。
     走不完如实回 `capped: true`(「没走到」与「它没这颗键」是两件事,不许混成一句)。
     */
    static let navMaxVisited = 24_000
    static let navMaxMs: Double = 2_500

    /**
     **按得下去的那几种角色**(`agent_press` / `agent_write_ask` / `quota_page` 共用一张表)。

     框上那几项在各家里是按钮 / 单选 / 复选 / 单元格 / 链接 / 菜单项 / 表格行。

     ★ **2026-10-03(卡 QT)补上 `AXPopUpButton`** —— 真机上量到的,不是想到的:

     - 豆包办公那颗通向「订阅与额度管理」的键是侧栏最底下一个 `AXPopUpButton`
       (身上写着「<账号名> 标准套餐」,动作里有 `AXPress`);
     - Muse 主窗左下角通向设置的那颗也是 `AXPopUpButton`(「Settings」,78×56)。

     这张表里原来没有这一档,于是壳对这两家回「它这几扇窗上认不出这颗键」——
     **而那是一句假话**(窗口里就有那颗键,只是我们的白名单不认它)。
     卡 QP 的交接据此写下了「Muse 主窗侧栏没有通向它的键」「豆包的通道压根不通」两条结论,
     两条都因为这一格而偏了。

     对另外两个消费方(`agent_press` / `agent_write_ask`)这是**修不是改**:今天它们对这种键
     同样一个都按不动(同卡 QP 修 `pickOptionRows` 那一处的道理);认不准照旧一处都不按。
     */
    /**
     **按角色点名时认不认这个元素**(2026-10-12,演示卡「出图进可灵」)。没点名 = 老表 {@link pressableRoles};
     点了名就只认那一个角色 —— 可灵「视频生成」那一页签是一块 `AXGroup`(带 AXPress),老表里没有它,
     而「生成」键要与同名的导航 `AXLink` 分开。
     */
    static func pressRoleMatches(nodeRole: String, wanted: String?) -> Bool {
        guard let wanted else { return pressableRoles.contains(nodeRole) }
        return nodeRole == wanted
    }

    /**
     **名字前头的点数不算名字**(2026-10-12):可灵的生成键写「60 生成」,点数随时长 / 清晰度变,写死认不住。
     只去掉「整数 + 可有可无的空白」开头、后面还有别的字的那一种;整串都是数字、或是「3.0」这种版本号,原样。
     只在按角色点名那一条路上用(老路一字不变)。
     */
    static func labelWithoutCount(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.prefix(while: { $0.isASCII && $0.isNumber })
        guard !digits.isEmpty else { return trimmed }
        let rest = trimmed.dropFirst(digits.count)
        guard let next = rest.first, next != ".", next != "," else { return trimmed }
        let tail = rest.trimmingCharacters(in: .whitespaces)
        return tail.isEmpty ? trimmed : tail
    }

    static let pressableRoles: Set<String> = [
        "AXButton", "AXRadioButton", "AXCheckBox", "AXCell", "AXMenuItem", "AXLink", "AXRow",
        "AXPopUpButton",
    ]
    /**
     **侧栏里一行算一项的那几种角色**(`agent_read` 与 `agent_pick` 共用;2026-10-08 卡「陌生程序侧栏」)。

     有名字的就整颗收成一行、不再往里看;没名字的往里看,里面那几块字带上 `in`(见 `sideEnclosing`)。
     `AXCheckBox` 是 10-08 真机量到的:千问办公、Manus 的会话行都是 AXCheckBox/AXToggleButton
     (`agent_pick` 那一路早就认它,`agent_read` 这一路漏了,于是千问办公的会话一条都没读进来)。
     不收 `AXRadioButton`:真机上它是一排标签(千问办公侧栏上的「任务 / 频道」),不是会话。
     */
    static let sideItemRoles: Set<String> = ["AXLink", "AXRow", "AXCell", "AXButton", "AXCheckBox"]
    /**
     侧栏里**整枝不看**的角色:弹菜单的键(账号区、「更多」、排序)。它从来不是一条会话,
     里面却装着她的账号名与套餐(千问办公左下角那颗 AXPopUpButton:「姚桑 / 个人免费版」)。
     读额度那一路(`quota_page`)要按的正是这种键,它自己走一遍树,不用这张表。
     */
    static let sideSkipRoles: Set<String> = ["AXPopUpButton", "AXMenuButton"]

    /**
     侧栏里这几种列表项**先读里面的字**,里面一块字都没有才用它自己的名字。
     真机 10-08:Manus 的会话行(AXCheckBox)名字是 Chromium 拿里面的图标说明 + 字拼出来的,
     读成「派活测试任务管理 派活测试任务管理」;千问办公的会话行没有孩子,名字就是标题。
     */
    static let sideReadInsideRoles: Set<String> = ["AXCheckBox"]

    /// 侧栏里一块字外面**最近那一层**列表项 / 键的角色:进了一层 `sideItemRoles` 就记它,否则沿用上面那一层。
    static func sideEnclosing(role: String, above: String?) -> String? {
        sideItemRoles.contains(role) ? role : above
    }

    /// 最新一句那一段从尾巴上收多少块字(界面字、时间戳由服务端筛掉,所以要多收几块)。
    static let tailMax = 30
    static let sideMax = 40
    static let maxDepth = 60

    // MARK: - 「闪一下台前」那一支(2026-10-03,卡「豆包闪一下换一个真数」)

    /**
     ★ **把台前还给她之后等多久**(`quota_page` 的 `front: true` 那一支)。

     250ms 同送话那条路把窗叫到台前那一下的节奏(`TextInsert.frontForWindowAction` 的第一拍):
     够系统把台前换回去、也短到整条「闪一下」落在一两秒里(她眼前那一闪越短越好)。
     */
    static let frontFlashBackMs = 250

    /**
     ★ **闪一下台前、读完要不要把它藏回去。**

     本来藏着的就藏回去(与 `SendTextPolicy.shouldRehide` 同一条规矩)—— **除非台前还在它身上**:
     那说明台前没还回去(或者这一两秒里她自己点了它),这时候把窗从她手底下抽走比读不到额度坏得多。

     判「台前在不在它身上」只许用**系统那份现问现答的** `NSWorkspace.frontmostApplication`:
     `NSRunningApplication.isActive` 是 KVO 异步更新的(苹果自己说别指望它当场就是新的),
     而这一下紧跟在「把台前还回去」后面 —— 拿那一格判会读到一个过期的 true,于是**不藏**,
     她眼前就留着一扇刚闪过的窗。

     调用顺序这条也是规矩的一半:**先把台前还给她,再判要不要藏**(倒过来就是对着一个
     「它还在台前」的事实问要不要藏,永远不藏)。
     */
    static func shouldRehideAfterFlash(wasHidden: Bool, frontNow: String?, bundleId: String) -> Bool {
        wasHidden && frontNow != bundleId
    }

    // MARK: - 台前那一下合成点击(2026-10-04,卡「豆包台前点一下」)

    /**
     ★ **这一步要不要替她合成一次鼠标点击。**

     `quota_page` 从第一天起写着「一次鼠标点击都不合成」—— 那条线当初是为**后台**定的:
     坐标点下去,前面盖着谁就点在谁身上(= 点在她正用着的那扇窗上)。
     维护者 2026-10-04 拍板:**台前、只在她亲手点「读一下」时**,对豆包那颗「标准套餐」
     合成一次点击 —— 因为它弹的是 Chromium 交给系统画的原生菜单,`AXPress` 回 success 而
     菜单压根不弹(卡「豆包闪一下」真机 `menu_roots: 0`)。

     四条**都**成立才点,少一条都不点:

     1. `click` —— 插件明着要这一下(缺省关;老插件压根不发这一格);
     2. `front` —— 这一轮是「闪到台前」那一支(后台那一支永远点不到这里);
     3. `fronted` —— 台前**真的**叫到了(叫不到就点在盖在上面的那扇窗上 = 正是那条老纪律要挡的事);
     4. `step == 0` —— **只有第一颗键**。弹出来那张菜单里的下一颗照旧只走 AX
        (维护者原话「点完照旧按 AX 认下一颗」:认得出才按,认不出就如实说认不出)。

     「什么时候才算她亲手点的」那道门在插件那一侧(`reachPage` 的 `mayPress`)——
     壳这一侧一个判断都不自己下(`AgentWindow` 这个文件的老规矩)。
     */
    static func clicksThisStep(click: Bool, front: Bool, fronted: Bool, step: Int) -> Bool {
        click && front && fronted && step == 0
    }

    // MARK: - 这扇窗的结构摘要(2026-10-01:诊断包里带的那一份)

    /// 一次探测里**各个角色各数到几个** → 回给服务端的那一份(`agent_probe` 的 `roles`)。
    ///
    /// 为什么要它:Air 上有三家被判成 AI 应用、窗口那一道却过不去(新版 Kimi `…kmp.mac`、可灵、
    /// App Store 版豆包),服务端只收得到一句「没有输入框;没有对话区也没有会话列表」——
    /// 到底是**那棵树没建出来**、还是**它真长得不像对话窗**,隔着一台机器分不出来。
    /// 角色的个数一眼就分得出:只剩 `AXWindow` / 几个 `AXGroup` 是树没出来,
    /// 几百个 `AXGroup` + `AXStaticText` 而一个 `AXTextArea` 都没有,那是它真不长那样。
    ///
    /// **只有数,没有一个字的内容** —— 角色名是系统的常量(`AXButton` 这类),不是它窗口上的字。
    /// 多的那几种按个数留前 `max` 种(诊断包里不必摆一百行)。
    static func roleHistogram(_ counts: [String: Int], max: Int = 16) -> [String: Int] {
        let kept = counts
            .filter { !$0.key.isEmpty && $0.value > 0 }
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .prefix(max)
        var out: [String: Int] = [:]
        for (role, count) in kept { out[role] = count }
        return out
    }

    // MARK: - 这扇窗的辅助功能树**明细**(2026-10-02:诊断包里新带的那一份)

    /**
     **为什么要明细**(2026-10-02,卡「适配自绘界面的 Kimi」)。

     10-01 那一份只带角色的个数(`roleHistogram`),于是 Air 上判不过结构那一道的几家——官网 Kimi
     `…kmp.mac`、可灵、App Store 版豆包——隔着一台机器只看得到
     `{AXUnknown:32, AXScrollArea:6, AXStaticText:23}` 这几个数:**认得出「它是自绘界面」,
     还是写不出「输入框是哪一个节点、怎么往里写」**。明细就是补这一步:每个元素的角色、子角色、
     位置大小、按得下去哪些动作(`AXPress` / `AXConfirm`…)、哪几条属性写得进去(`AXValue` / `AXFocused`…),
     下一份诊断包一摆出来,读法当场写得出,不用再上她那台机器猜。

     **脱敏在这一侧做,不靠出包前再擦**(与 `agent_probe` 同一条纪律:壳只读结构,不读内容):
     标题 / 说明 / 帮助 / 值**一个字都不回**,只回**字数**(`tl` / `dl` / `hl` / `vl`)。
     字数本身也是线索(「输入框里有 0 个字」「这块字 37 个字」),而她跟哪家说过什么一个字都出不去。

     上限三道:走过的节点数、花的毫秒、回的行数。行数封顶之后如实回 `capped: true`——
     **宁可少几行,不许让一份诊断包大到发不出去**。
     */
    static let axDetailMax = 120
    static let axDetailMaxVisited = 1500
    static let axDetailMaxMs: Double = 1500

    /// 明细里要问「写得进去吗」的那几条属性(字面量:这个文件故意不 import ApplicationServices)。
    static let axDetailSettableAttrs = ["AXValue", "AXFocused", "AXSelectedText"]

    /// 一个字都不回,只回字数。空 / 没有 → 0。
    static func axTextLen(_ text: String?) -> Int {
        guard let text, !text.isEmpty else { return 0 }
        return text.count
    }

    /**
     明细里的**一行**。全是结构:角色名、子角色名、动作名、属性名都是系统常量,
     位置大小是数,标题 / 说明 / 帮助 / 值只有**字数**。一个字的界面文字、一个字的对话内容都没有。

     空的那几格**不回**(`0` 与「没有」在排障时是两件事:`vl: 0` = 有 AXValue 这条属性、里面是空的;
     缺席 = 压根没有这条属性)—— 所以 `valueLen` 用 `Int?`:`nil` 是缺席,`0` 是空。
     */
    // MARK: - agent_images:图片类节点(2026-10-13 夜,卡 T,只读)

    /// 哪几种角色算「图片类」:Chromium 的 `<img>` 是 AXImage;转圈 / 进度一般是这两种(也可能是自绘的 AXGroup,那就读不到)。
    static let imageRoles: Set<String> = ["AXImage", "AXProgressIndicator", "AXBusyIndicator"]
    /// 上限三道:条数 / 节点数 / 毫秒。可灵生成页本机 352 个节点 99 毫秒;给足富余,但别让一扇大窗把读队列堵住。
    static let imagesMax = 200
    static let imagesMaxVisited = 12_000
    static let imagesMaxMs: Double = 3000
    /// 地址与说明各留多长:地址要留到文件名与查询串开头(`…/参考图-20261013-220351.png?x-kcdn-pid=…`),说明只要辨认用。
    static let imageUrlMax = 200
    static let imageDescMax = 80

    /// 一条图片节点怎么回:角色、相对窗口的位置大小,有地址 / 说明才带(都按上限裁)。
    static func imageRow(role: String, rel: CGRect, url: String?, desc: String?) -> [String: Any] {
        var row: [String: Any] = ["role": clip(role, 40)]
        row.merge(rectJSON(rel)) { a, _ in a }
        if let url, !url.isEmpty { row["url"] = clip(url, imageUrlMax) }
        if let desc, !desc.isEmpty { row["desc"] = clip(desc, imageDescMax) }
        return row
    }

    static func axDetailRow(role: String, subrole: String?, depth: Int, rel: CGRect,
                            actions: [String], settable: [String], focused: Bool,
                            titleLen: Int, descLen: Int, helpLen: Int, valueLen: Int?) -> [String: Any] {
        var row: [String: Any] = ["role": clip(role, 40), "d": depth]
        row.merge(rectJSON(rel)) { a, _ in a }
        if let subrole, !subrole.isEmpty { row["sub"] = clip(subrole, 40) }
        if !actions.isEmpty { row["act"] = actions.prefix(8).map { clip($0, 40) } }
        if !settable.isEmpty { row["set"] = settable.prefix(8).map { clip($0, 40) } }
        if focused { row["foc"] = true }
        if titleLen > 0 { row["tl"] = titleLen }
        if descLen > 0 { row["dl"] = descLen }
        if helpLen > 0 { row["hl"] = helpLen }
        if let valueLen { row["vl"] = valueLen }
        return row
    }

    // MARK: - 「树还没建起来」要再看一眼(2026-09-26,卡 MQ)

    /// 敲过门之后等多久再看第二眼。
    ///
    /// Chromium / Electron 系的应用是**等有辅助功能客户端来读的时候才建网页那一层的树**的
    /// (`AXWake` 写的那一下就是「我来了」),而树不是当场就好 —— 它要重建一遍。
    /// 实测 2026-09-26:Grok Bot、Antigravity 头一眼只看得到 21 / 65 个节点、**一个输入框都没有**;
    /// 过一会儿再读,两家都是清清楚楚的聊天窗(输入框、「新对话」、发送键都在)。
    /// 于是登记表把它们判成「没有输入框、没有发送键」—— 判的其实是**一棵还没建好的树**,不是那个 App。
    static let treeWakeWaitMs = 900

    /// 这一眼**值不值得再看一眼**:一个输入框都没找着,而且树小得不像话(还没走到上限)。
    ///
    /// 为什么拿「没有输入框」当信号:这正是会被误判的那种样子。真没有输入框的窗口(设置窗之类)
    /// 也会多花这一拍 —— 结构探测一个 App 一辈子只做几次,这一拍换「不再冤枉一家」,划算。
    /// 走到上限(`capped`)的不再看:那说明树大得很、早建好了,再看一眼也是同一棵。
    static func worthSecondLook(inputs: Int, visited: Int, capped: Bool) -> Bool {
        inputs == 0 && !capped && visited < probeMaxVisited
    }

    // MARK: - 按标题在侧栏里点那条对话(2026-09-28,卡 WR)

    /**
     侧栏里这一行**是不是他点名那条对话**。纯判断,壳那半只管走树、点一下。

     为什么要它:窗口型那几家(Manus / 豆包办公 / Muse / Grok Bot / Antigravity)没有
     「开到某一段对话」的深链,要往**已有的**那条对话里送话,只有一条路 —— 在侧栏里点它一下。
     点错一条 = 把他的话打进别的对话里,所以这里**宁窄勿宽**:

     - 归一化之后**整行相等** → 就是它(`exact`);
     - 侧栏那一行被 App 自己截断了(以省略号结尾),去掉省略号之后是他那个标题的**开头** → 是它(`prefix`);
       反过来也算:我们存下来的标题被我们截过(卡 ST 截到 60 字),那它是侧栏那一行的开头;
     - 别的一律不是。**不做模糊匹配、不看包含关系**(「参赛网页」会命中「参赛网页 · 旧版」)。
     */
    enum RowMatch: String {
        case exact
        case prefix
    }

    static func matchConversationRow(row: String, wanted: String) -> RowMatch? {
        let a = normalizeRow(row)
        let b = normalizeRow(wanted)
        if a.isEmpty || b.isEmpty { return nil }
        if a == b { return .exact }
        // 截断过的那一头至少要留 4 个字才敢认(「A…」谁都像)。
        let aCut = wasClipped(row)
        let bCut = wasClipped(wanted)
        if aCut, a.count >= 4, b.hasPrefix(a) { return .prefix }
        if bCut, b.count >= 4, a.hasPrefix(b) { return .prefix }
        return nil
    }

    /// 认行用的归一化:去掉首尾空白、把连续空白并成一个空格、去掉尾巴上的省略号。大小写**照原样**
    /// (侧栏里那几条对话的名字是他写的字,大小写就是他的字)。
    static func normalizeRow(_ text: String) -> String {
        let flat = clip(text, 4096)
        var out = flat
        while out.hasSuffix("…") || out.hasSuffix("‥") || out.hasSuffix(".") {
            out = String(out.dropLast())
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /**
     **它弹的那个框上那一项,是不是他点的那一项**(2026-09-28,卡 WQ;`agent_press`)。

     比认对话那一行更严:**只认整行相等**(归一化之后),一个省略号的便宜都不给 ——
     点错一项 = 替他答错一道题,而这一下没有「撤销」。选项那几行字短、天然全画得出来,
     不像侧栏标题会被 App 截断,所以这一条不需要 `prefix` 那一档。

     归一化多做一件事:去掉选项前面 App 自己加的序号 / 记号(「1. 川菜」「• 川菜」「A) 川菜」),
     那几个字符是它画上去的,不是它给我们的 label。
     */
    static func matchOptionLabel(row: String, wanted: String) -> Bool {
        let a = optionKey(row)
        let b = optionKey(wanted)
        return !a.isEmpty && !b.isEmpty && a == b
    }

    /**
     比选项用的那把钥匙(2026-09-28 20:36 Air 真机):在 {@link normalizeOption} 之上再去掉
     **表情、变体符、空白**,全角换半角。Codex 那一问的选项是「🍲 番茄小火锅｜牛肉＋豆腐＋菌菇」,
     窗口里画出来的那一行表情可能没进 AX 文本、竖线可能是半角 —— 这些都不是「哪一项」的区别。
     */
    static func optionKey(_ text: String) -> String {
        let base = normalizeOption(text).applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? normalizeOption(text)
        var out = String.UnicodeScalarView()
        for scalar in base.unicodeScalars {
            if scalar.properties.isWhitespace { continue }
            if scalar.value == 0xFE0F || scalar.value == 0xFE0E || scalar.value == 0x200D { continue }
            // 表情:有默认表情外观的,或者是「其他符号」一类(🌶 这种不带 FE0F 就不算默认表情外观)。
            if scalar.properties.isEmojiPresentation { continue }
            if scalar.properties.isEmoji && scalar.properties.generalCategory == .otherSymbol { continue }
            out.append(scalar)
        }
        return String(out).lowercased()
    }

    /// 一项的「标题那一截」:竖线 / 冒号 / 破折号之前那段(「番茄小火锅|牛肉+豆腐+菌菇」→「番茄小火锅」)。
    static func optionHead(_ text: String) -> String {
        let key = optionKey(text)
        let cut = key.firstIndex(where: { "|:：—-–".contains($0) }) ?? key.endIndex
        return String(key[key.startIndex..<cut])
    }

    /**
     窗口里那几行里,**哪一行**是她点的那一项(2026-09-28 20:36 Air 真机)。认不准回 `nil` —— 一行都不点。

     1. 整行认得出(`matchOptionLabel`)且恰好一行 → 就是它;两行以上 → 不点。
     2. 窗口只画了标题那一截(标题一格、说明一格分开画):那一行**整行等于**她那一项的标题,
        而且这个标题在这一问的几项里**只此一家**、窗口里也**只有一行**对得上 → 就是它。
     */
    static func pickOption(rows: [String], wanted: String, options: [String]) -> Int? {
        let whole = rows.indices.filter { matchOptionLabel(row: rows[$0], wanted: wanted) }
        if whole.count == 1 { return whole[0] }
        if whole.count > 1 { return nil }
        let head = optionHead(wanted)
        guard !head.isEmpty, head != optionKey(wanted) else { return nil }
        let pool = options.isEmpty ? [wanted] : options
        guard pool.filter({ optionHead($0) == head }).count == 1 else { return nil }
        let heads = rows.indices.filter { optionKey(rows[$0]) == head }
        return heads.count == 1 ? heads[0] : nil
    }

    /// 窗口里收上来的那几行里**按哪一行**(`pickOptionRows` 的答案)。
    /// `many` 里每个元素只带一行 —— 调用方据此回「有几处都叫这个名字,一处都没按」。
    enum OptionPick: Equatable {
        case one(Int)
        case many([Int])
        case none
    }

    /**
     ★ **同一个元素身上几行都对得上,那还是一处**(2026-10-03,卡 QP 真机撞出来的)。

     `rows` 里一行是「某个元素身上的某一处文字」(title / description / value 各算一行),
     `element` 是**这一行挂在第几个元素上**。为什么非要这一格:真机上(Muse,10-03)
     侧栏那几颗键把同一个名字**同时写在 title 和 description 上**(`Library` / `Reply` /
     `Copy response` 都是),于是「整行对得上的有两行」——
     老那条路(`pickOption` 只拿到几行字、看不见是谁身上的)把它当成「两处都像」,
     一处都不按,回一句「认不出这颗键」。**那是一句假话**:窗口里就一颗 `Library`。

     所以判「几处」要按**元素**数,不按行数:
     - 对得上的行落在**两个以上元素**上 → `many`(一处都不按,同卡 WQ 的纪律:点错 = 替她答错);
     - 都落在**同一个元素**上 → `one`(就按它);
     - 一行都没整行对上 → 退到「窗口只画了标题那一截」那一支(`pickOption`)。
     */
    static func pickOptionRows(rows: [(element: Int, text: String)], wanted: String, options: [String]) -> OptionPick {
        let whole = rows.indices.filter { matchOptionLabel(row: rows[$0].text, wanted: wanted) }
        var firstOf: [Int: Int] = [:]
        for at in whole where firstOf[rows[at].element] == nil { firstOf[rows[at].element] = at }
        if firstOf.count > 1 { return .many(firstOf.values.sorted()) }
        if let at = firstOf.values.first { return .one(at) }
        guard let at = pickOption(rows: rows.map(\.text), wanted: wanted, options: options) else { return .none }
        return .one(at)
    }

    /// 认选项用的归一化:同 `normalizeRow`,再去掉行首的序号 / 项目符号与其后的空白。
    static func normalizeOption(_ text: String) -> String {
        var out = normalizeRow(text)
        let marks: Set<Character> = ["•", "·", "-", "—", "*", "◦", "▪"]
        if let first = out.first, marks.contains(first) {
            out = String(out.dropFirst()).trimmingCharacters(in: .whitespaces)
        } else {
            // 「1. 」「1) 」「A. 」这种序号:最多两位数字或一个字母,后面跟 . 或 )。
            let scanner = out.prefix(4)
            if let dot = scanner.firstIndex(where: { $0 == "." || $0 == ")" || $0 == "、" }) {
                let head = out[out.startIndex..<dot]
                let numeric = !head.isEmpty && head.allSatisfy { $0.isNumber }
                let letter = head.count == 1 && head.allSatisfy { $0.isLetter && $0.isASCII }
                if numeric || letter {
                    out = String(out[out.index(after: dot)...]).trimmingCharacters(in: .whitespaces)
                }
            }
        }
        return out
    }

    /**
     **「把这一问展开」的那一颗键**(2026-09-28,卡 AQ;`agent_press` 找不到选项时先按它一下)。

     真机撞出来的:Codex 桌面版在对话区里只画了问句 + 一颗 `Answer question`,四个选项
     (1 川菜 / 2 粤菜 / 3 湘菜 / 4 江浙菜)**收在它后面** —— 点开才在输入框上方弹出那个框。
     于是 `POST /asks/answer {choice:'川菜'}` 只能如实回「它窗口里没找到「川菜」这一项」:
     没谎报,可也没答进去;手动点开之后同一个请求就 `confirmed:true` 了。

     **按形状认,不写死一家的叫法**(别的家叫「回答问题」「查看提问」都得认得出),
     而且**宁窄勿宽** —— 这一颗按下去是在她窗口里按一颗我们没见过的键,拿不准就不按:

     - 要**又有「问 / 选项」这个词、又有「回答 / 查看 / 展开」这个动作**(光一个 `Answer`、
       光一个 `Question` 都不算:那可能是交答案的那颗);
     - 带「发送 / 提交 / 跳过 / 取消 / 关闭」的**一律不算**(那几颗按下去是替她答或替她弃答);
     - 长得不像一颗键的(归一化之后超过 24 个字)不算 —— 那多半是对话里的一整句话。

     调用方那一侧的纪律在 `AgentWindow.press`:**只按一次**,按完重新找选项;还是找不到就照旧如实说。
     */
    static func looksLikeExpandAsk(title: String?, description: String?) -> Bool {
        for raw in [title, description] {
            guard let raw, expandAskLabel(raw) else { continue }
            return true
        }
        return false
    }

    /// 一截字是不是那颗展开键的标签。判据见 {@link looksLikeExpandAsk}。
    private static func expandAskLabel(_ raw: String) -> Bool {
        let text = normalizeOption(raw)
        guard !text.isEmpty, text.count <= 24 else { return false }
        let low = text.lowercased()
        /// 按下去会**替她答 / 替她弃答 / 把框关掉**的那几颗:一个都不碰。
        let forbidden = ["send", "submit", "skip", "cancel", "close", "dismiss", "confirm",
                         "发送", "提交", "跳过", "取消", "关闭", "确定", "确认"]
        if forbidden.contains(where: { low.contains($0) }) { return false }
        /// 这一问那个词(英文要带词形,中文按词)。
        let subjects = ["question", "questions", "option", "options", "choice", "choices",
                        "问题", "提问", "这一问", "选项"]
        /// 「打开它」那个动作。
        let actions = ["answer", "respond", "reply", "view", "show", "see", "open", "expand",
                       "回答", "回复", "查看", "展开", "打开", "看看"]
        guard subjects.contains(where: { low.contains($0) }) else { return false }
        return actions.contains(where: { low.contains($0) })
    }

    /// 这一截字是被谁截过的(结尾是省略号 / 三个点)。
    static func wasClipped(_ text: String) -> Bool {
        let flat = clip(text, 4096)
        return flat.hasSuffix("…") || flat.hasSuffix("‥") || flat.hasSuffix("...")
    }

    // MARK: - 把她自己那句话写进那个提问面板(2026-09-28,卡 AT;`agent_write_ask`)

    /**
     维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」

     卡 WQ / AQ 做到的是「替她点框上那一项」;她**打了一句自己的话**(不在那几项里)时,从前只能如实说
     「要自己说一句,得在电脑上…」。这一段是把那半件补上:在**含问句 / 选项的那个面板容器里**找到
     自由作答的输入框与那颗发送键(Codex:展开后面板里的「Or write your own response」+ Send),
     把她那句原文一字不改地写进去、按下发送。

     **最怕的那一件**:写进**窗口底部的主输入框**并发出去 —— 那等于把她的话当成新一轮指令发进她正在跑的会话里。
     所以这一段的纪律是三道门,任一道过不去就**一处都不动**、如实说:

     1. **必须先找着那个面板**(容器里既有问句 / 选项、又有输入框;见 {@link enoughForAskPanel}、{@link pickAskPanel});
     2. **只认面板里的**那个框与那颗键(几何上落在面板里,而且**在主输入框上沿以上**;见 {@link pickAskField});
     3. **两处都像就一处不动**(回 `many`)—— 拿不准时「没答上」远好过「答错地方」。
     */

    /// 面板里一个输入框的样子(纯数据:AX 那一半读出来什么就给什么,判断全在这里)。
    struct AskField: Equatable {
        /// AXRole(`AXTextArea` / `AXTextField` / `AXComboBox`)。
        let role: String
        /// 占位提示 / 标题 / 说明里那一截字(读不到就是空字符串)。
        let label: String
        /// **相对那扇窗左上角**的矩形。
        let frame: CGRect
        /// `AXValue` 写得进去吗(写不进去就走点一下 + 粘贴)。
        let settable: Bool

        init(role: String, label: String = "", frame: CGRect, settable: Bool = true) {
            self.role = role
            self.label = label
            self.frame = frame
            self.settable = settable
        }
    }

    /// 面板里一颗键的样子(找那颗发送键用)。
    struct AskButton: Equatable {
        let label: String
        let frame: CGRect

        init(label: String, frame: CGRect) {
            self.label = label
            self.frame = frame
        }
    }

    /// 挑一处的结果,以及**为什么是它 / 为什么一处都不挑**(这句话原样进日志与回包,不是装饰)。
    enum AskPick: Equatable {
        case one(index: Int, why: String)
        case none(reason: String)
        /// 两处以上都像 —— **一处都不动**。
        case many(count: Int, reason: String)
    }

    /// 一个容器要有几截「问句 / 选项」的字才算那个面板。问句那一截也算一截,所以「一个选项 + 问句」够。
    static let askPanelMarks = 2

    /// 这个容器像不像那个提问面板:**既有问句 / 选项、又有输入框**。
    /// 光有问句的是对话区那一段(她的话不能往那儿写);光有输入框的是窗口底部那个主输入框那一带。
    static func enoughForAskPanel(marks: Int, inputs: Int) -> Bool {
        marks >= askPanelMarks && inputs >= 1
    }

    /// 几个都够格的容器里挑一个:**最小的那个**(最内层那个才是面板;它的祖先一路到整扇窗都够格)。
    ///
    /// ⚠️ 单看大小会栽在**报错了自己高度的祖先**上(见 {@link pickAskPanelIndex} 的真机形状),
    /// 所以动手那一路走的是 `pickAskPanelIndex`;这一条只留作「都挑不出时退回来」的那一步。
    static func pickAskPanel(_ candidates: [CGRect]) -> CGRect? {
        candidates
            .filter { $0.width.isFinite && $0.height.isFinite && $0.width > 0 && $0.height > 0 }
            .min { a, b in a.width * a.height < b.width * b.height }
    }

    /// 一个够格的容器连同它底下那几个框、那几颗键(挑面板要连着框与键一起看,见 {@link pickAskPanelIndex})。
    struct AskPanelShape: Equatable {
        let rect: CGRect
        let fields: [AskField]
        let sends: [AskButton]

        init(rect: CGRect, fields: [AskField] = [], sends: [AskButton] = []) {
            self.rect = rect
            self.fields = fields
            self.sends = sends
        }
    }

    /**
     够格的几个容器里挑那个**真能动手**的面板(2026-09-28,卡 AT2)。

     **为什么不能只挑最小的**:2026-09-28 真机(Codex 0.4.59,「你最想喝哪种饮料?」那一问)的 AX 树里,
     提问面板那一枝上有两个祖先容器都报 `[500,515 737x…]`,其中一个**高度只有 99**
     (面板真身是 `737×311`,作答框在 `y≈787`)。按面积挑最小 → 挑中那个 99 高的壳子,
     作答框与 Send 全落在它外面 → `pickAskField` 回「没有一个既在面板里、又大得像个输入框」,一处不动。
     那一格**不是太小、也不是角色不对**(真身是 `AXTextArea`、`520×20`、`AXValue` 可写、
     title/desc 都是 `Or write your own response`)—— 是容器那一层报错了高度。

     所以挑面板连着框与键一起挑:**框与发送键都认得出来的那几个容器里取最小的那个**。
     两道老门(在面板里 + 在主输入框红线以上 + 不是主输入框本身)一个没少,只是换了个「面板」给它们用。
     一个都挑不出来时退回最小那个 —— 那句如实话照旧原样报上去(行为与从前一字不差)。
     */
    static func pickAskPanelIndex(_ candidates: [AskPanelShape], mainInput: CGRect?) -> Int? {
        let valid = candidates.enumerated().filter {
            $0.element.rect.width.isFinite && $0.element.rect.height.isFinite
                && $0.element.rect.width > 0 && $0.element.rect.height > 0
        }
        if valid.isEmpty { return nil }
        let workable = valid.filter { (_, shape) in
            guard case .one = pickAskField(shape.fields, panel: shape.rect, mainInput: mainInput) else { return false }
            guard case .one = pickAskSend(shape.sends, panel: shape.rect, mainInput: mainInput) else { return false }
            return true
        }
        let pool = workable.isEmpty ? valid : workable
        return pool.min { a, b in
            a.element.rect.width * a.element.rect.height < b.element.rect.width * b.element.rect.height
        }?.offset
    }

    /// 窗口里这一截字算不算命中那一问的某一截(选项原话 / 问句原话)。
    ///
    /// 选项那几截短,按 {@link matchOptionLabel} **整行相等**认(序号、项目符号不算);
    /// 问句那一截长、而且服务端截过(80 字),整行相等指望不上 —— 按**开头 12 个字**认。
    static func askMarkHit(text: String, mark: String) -> Bool {
        let want = normalizeOption(mark)
        guard !want.isEmpty else { return false }
        if matchOptionLabel(row: text, wanted: mark) { return true }
        guard want.count > 24, let needle = answerNeedle(want, max: 12) else { return false }
        return textMentions(text, needle)
    }

    /**
     面板里那个**自由作答**的框是哪一个(挑不准就一个都不挑)。

     `panel` = {@link pickAskPanel} 挑出来的那个容器(相对窗口左上角);
     `mainInput` = 窗口底部那个主输入框(读得到就给,给了就当**红线**:它自己不算候选,
     落在它上沿以下的也一概不算 —— 那一带是输入区,不是面板)。

     顺序:
     1. 太小的(幽灵节点)、不是输入角色的、不在面板里的、在红线以下的,全不算;
     2. 剩下的里面**占位 / 标题像「自己说一句」**的(见 {@link looksLikeOwnAnswerField}):恰好一个就是它,
        两个以上 → `many`;
     3. 一个都不像:**面板里只剩这一个输入框**时就是它(装在面板里本身就是硬证据);
        剩两个以上 → `many`(认不准该往哪个写);一个不剩 → `none`。
     */
    static func pickAskField(_ candidates: [AskField], panel: CGRect, mainInput: CGRect?) -> AskPick {
        let usable = candidates.enumerated().filter { (_, field) in
            SendTextPolicy.inputRoles.contains(field.role)
                && field.frame.width >= SendTextPolicy.minInputSize.width
                && field.frame.height >= SendTextPolicy.minInputSize.height
                && insidePanel(field.frame, panel: panel)
                && !isMainInput(field.frame, mainInput: mainInput)
        }
        if usable.isEmpty {
            return .none(reason: candidates.isEmpty
                ? "它那个提问面板里没有可以打字的框(这一问只能点那几项)"
                : "面板里那几个文本元素没有一个既在面板里、又大得像个输入框")
        }
        let shaped = usable.filter { looksLikeOwnAnswerField($0.element.label) }
        if shaped.count == 1 {
            let one = shaped[0]
            return .one(index: one.offset, why: "面板里那个「自己说一句」的框(\(clip(one.element.label, 30)))")
        }
        if shaped.count > 1 {
            return .many(count: shaped.count, reason: "面板里有 \(shaped.count) 个框都像「自己说一句」,一个都没写")
        }
        if usable.count == 1 {
            return .one(index: usable[0].offset, why: "面板里只有这一个输入框")
        }
        return .many(count: usable.count, reason: "面板里有 \(usable.count) 个输入框,认不准该往哪个写,一个都没写")
    }

    /// 面板里那颗**发送**键(认不出 / 两颗都像就不按)。认标签用 `SendTextPolicy.looksLikeSendButton`
    /// (卡 GB 那一套:停止 / 取消 / 新建一票否决),红线同 {@link pickAskField} —— 底部输入区那颗不算。
    static func pickAskSend(_ candidates: [AskButton], panel: CGRect, mainInput: CGRect?) -> AskPick {
        let usable = candidates.enumerated().filter { (_, button) in
            insidePanel(button.frame, panel: panel)
                && !isMainInput(button.frame, mainInput: mainInput)
                && SendTextPolicy.looksLikeSendButton(title: button.label, description: nil)
        }
        if usable.isEmpty { return .none(reason: "它那个提问面板上认不出发送键,这一句没写进去") }
        if usable.count > 1 {
            return .many(count: usable.count, reason: "面板上有 \(usable.count) 颗键都像发送,一颗都没按")
        }
        return .one(index: usable[0].offset, why: "面板里那颗发送键(\(clip(usable[0].element.label, 30)))")
    }

    /// 这块矩形的正中落在面板里(横竖各让 2 点)。
    static func insidePanel(_ rel: CGRect, panel: CGRect) -> Bool {
        guard rel.midX.isFinite, rel.midY.isFinite, panel.width.isFinite, panel.height.isFinite else { return false }
        return rel.midX >= panel.minX - 2 && rel.midX <= panel.maxX + 2
            && rel.midY >= panel.minY - 2 && rel.midY <= panel.maxY + 2
    }

    /**
     这一块**就是那个主输入框、或者落在它那一带**(→ 一律不碰)。

     两条都要:① 跟主输入框几乎是同一块(正中差 4 点以内)—— 那就是它本人;
     ② 正中落在它上沿以下 —— 那一带是窗口底部的输入区(它右边那颗 Send 也在这儿)。
     读不到主输入框(`nil`)时这道门放空 —— 面板那道门照旧拦着。
     */
    static func isMainInput(_ rel: CGRect, mainInput: CGRect?) -> Bool {
        guard let mainInput, rel.midX.isFinite, rel.midY.isFinite,
              mainInput.midX.isFinite, mainInput.midY.isFinite, mainInput.minY.isFinite else { return false }
        if abs(rel.midX - mainInput.midX) <= 4 && abs(rel.midY - mainInput.midY) <= 4 { return true }
        return rel.midY >= mainInput.minY - 2
    }

    /**
     这一截占位 / 标题像不像「在这儿自己说一句」。**按形状认,不写死一家的叫法**
     (Codex 是 `Or write your own response`,别家可能是「自己写一句」「输入你的回答」)。

     要**又有「答 / 回话」那个词、又有「自己 / 写 / 输入」那个动作**;
     搜索框、密码框、主输入框那几种叫法一票否决(那几处写进去都是坏事)。
     */
    static func looksLikeOwnAnswerField(_ raw: String) -> Bool {
        let text = normalizeRow(raw)
        guard !text.isEmpty, text.count <= 60 else { return false }
        let low = text.lowercased()
        let forbidden = ["search", "搜索", "filter", "筛选", "password", "密码", "token", "api key",
                         "url", "网址", "message", "消息", "ask anything", "问点什么"]
        if forbidden.contains(where: { low.contains($0) }) { return false }
        let subjects = ["response", "answer", "reply", "回答", "答复", "答案", "回复", "作答", "一句", "一段"]
        let actions = ["own", "write", "type", "enter", "other", "custom",
                       "自己", "自定义", "其他", "其它", "输入", "填写", "写"]
        guard subjects.contains(where: { low.contains($0) }) else { return false }
        return actions.contains(where: { low.contains($0) })
    }

    /**
     ⑤ 核实用的那一截字:她那句话的**开头几个字**(窗口里找得着它,就说明她那句真进去了)。
     太短的(一两个字)认不准,不用 —— 那种只靠「那一问没了」说话。
     */
    static func answerNeedle(_ text: String, max: Int = 16) -> String? {
        let flat = clip(text, 4096)
        let chars = Array(flat)
        guard chars.count >= 3 else { return nil }
        return String(chars.prefix(max))
    }

    /// 窗口里这一截字里有那截话没有(两边都并过空白;大小写照原样 —— 她写的字大小写就是她的字)。
    static func textMentions(_ hay: String, _ needle: String) -> Bool {
        let a = clip(hay, 4096)
        let b = clip(needle, 4096)
        guard !a.isEmpty, !b.isEmpty else { return false }
        return a.contains(b)
    }

    /// 找那个面板一次最多看多少个节点、最多花多久(比一次「读」宽一点:要走到面板那一层才认得出)。
    static let askScanMaxVisited = 3000
    static let askScanMaxMs: Double = 900

    // MARK: - 点完 / 答完之后,别太早说「没点上」(2026-10-13,卡 SC)

    /**
     **核实那一下的轮询时限**。步长与送话那边共用 `SendTextPolicy.submitConfirmStepMs`(一处定义)。

     现场:她 11:40 在电话里答「果汁」→ `agent_press` 回「没确认」,工人把这句原话念给她;
     可豆包窗口里随后就是「收到:果汁」—— **点上了**。老代码点完等 1200ms 重读一次就下结论,
     而 Electron 新版豆包把那个面板收掉、把回话画出来都比这慢(与送话那边 `submitConfirmTotalMs` 同一个病)。
     */
    static let pressConfirmTotalMs = 3000

    /// 这一下是**哪一档**核出来的(回包里的 `confirmed_by`;8791 照旧只看 `gone` 这个布尔)。
    enum PressProof: String, Equatable {
        /// 那一项不见了 = 那个框收下了。
        case gone = "gone"
        /// 那一项还在,但对话区里**冒出了新的一行提到它**(豆包的「收到:果汁」)。
        case replyInChat = "reply_in_chat"
    }

    /// 点完之后在窗口里找「提到这一项」的那几行用的那一截字:那一项的名字本身
    /// (并过空白、去掉序号与省略号)。一个字的选项也要认(「茶」),所以这里不设下限 ——
    /// 判的是**点之前没有、点之后出现**的那一行,不是「窗口里有没有这几个字」。
    static func pressNeedle(_ label: String) -> String? {
        let needle = normalizeOption(label)
        return needle.isEmpty ? nil : needle
    }

    /// 核实「这一下点上了没有」。
    /// - `itemGone`:轮询到那一项不见了;
    /// - `mentionsBefore` / `mentionsAfter`:点之前 / 点之后,窗口里**提到这一项**的那几行字。
    ///   两边并过空白之后一模一样 = 什么都没发生,如实报没点上。
    static func pressProof(itemGone: Bool, mentionsBefore: [String], mentionsAfter: [String]) -> PressProof? {
        if itemGone { return .gone }
        let before = Set(mentionsBefore.map { normalizeRow($0) }.filter { !$0.isEmpty })
        let fresh = mentionsAfter.map { normalizeRow($0) }.filter { !$0.isEmpty && !before.contains($0) }
        return fresh.isEmpty ? nil : .replyInChat
    }

    // MARK: - 替她批准(`agent_approval`,2026-10-01 卡 AP)

    /**
     认「这条会话的那个批准弹窗」用的那一截字:这一步自己的原话(命令 / 说明)**第一行**、并过空白,最多 24 个字。
     不到 4 个字认不准(「ls」谁的弹窗上都可能有)→ `nil`,不用。
     */
    static func approvalNeedle(_ mark: String) -> String? {
        let first = mark.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).first.map(String.init) ?? ""
        let flat = clip(first, 4096)
        guard flat.count >= 4 else { return nil }
        return String(flat.prefix(24))
    }

    /// 窗口里这一截字是不是含着那一步的原话(两边都并过空白;不到 4 个字的记号一律不算)。
    static func approvalMarkHit(text: String, mark: String) -> Bool {
        guard let needle = approvalNeedle(mark) else { return false }
        return textMentions(text, needle)
    }

    /// 读的时候和按的时候是不是**同一块**(相对窗口左上角,允许挪几个点;挪一大截就不是它了 —— 不按)。
    static func sameRect(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 4) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    /// 两颗键是不是同一个名字(并过空白后整行相等;大小写照原样 —— 「本次会话都允许」和「批准一次」差一个字都不是一颗)。
    static func sameKeyLabel(_ a: String, _ b: String) -> Bool {
        let x = clip(a, 4096)
        return !x.isEmpty && x == clip(b, 4096)
    }

    /// 一块够不够格当「那个弹窗」:有键,而且不多(几十颗键的那一块是整扇窗 / 整个对话区)。
    static let approvalPanelMaxKeys = 12
    static func approvalPanelWorthy(buttons: Int) -> Bool {
        buttons >= 1 && buttons <= approvalPanelMaxKeys
    }
}
