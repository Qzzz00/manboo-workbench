import AppKit
import CoreImage

/// 三屏:开场 → 装的过程 → 装好了。**一个窗口,换内容,不弹别的窗**。
///
/// 为什么只有一个窗口:安装器面对的是"第一次见到这个东西"的人,多一个窗就多一次
/// "我该看哪儿"。系统授权那几个框是 macOS 自己弹的,挡不住也不该挡 —— 结尾那一屏
/// 提前把它们说清楚(Ben 09-18:安装器不做向导步骤,只在结尾说清楚)。
final class InstallerWindow: NSObject {
    private let window: NSWindow
    private let content = NSView()
    private let kernel: Kernel
    private let resources: String

    // 装的过程那一屏上的几件东西(要随事件改,所以留着引用)。
    private let stepLabel = InstallerWindow.label("", size: 15, weight: .semibold)
    private let noteLabel = InstallerWindow.label("", size: 12, color: .secondaryLabelColor)
    private let progress = NSProgressIndicator()
    private let logText = NSTextView()
    private let logScroll = NSScrollView()
    private let logToggle = NSButton()
    private let errorLabel = InstallerWindow.label("", size: 13, color: .systemRed)
    private let retryButton = PrimaryButton(title: "重试")
    /// 出错那一屏上那句「这一趟的日志在哪」与旁边那颗「在访达里显示」(2026-09-27,卡 PN)。
    private let logFileLabel = InstallerWindow.label("", size: 11, color: .tertiaryLabelColor)
    private let revealLogButton = NSButton()
    /// 内核开头发上来的那条 `logfile` 事件里的路径。空 = 还没发过(老内核 / 起都没起来)。
    private var logFilePath = ""

    private var totalSteps = 10
    private var currentStep = 0
    private var currentStepPct: Double = 0
    private var shellApp = "/Applications/工作台.app"
    private var finished = false
    /// 把事件回显到 stderr(`--auto-start` 验收时用,平时关着)。
    var traceEvents = false

    init(kernel: Kernel, resources: String) {
        self.kernel = kernel
        self.resources = resources
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered,
                          defer: false)
        super.init()
        // 标题带版本号(2026-09-27):一眼看得出打开的是不是刚下的那一份。
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        window.title = version.isEmpty ? "安装工作台" : "安装工作台 \(version)"
        // 只做深色(维护者 2026-09-24「先不做浅色」):系统浅色时安装器也是深色,白底黑字按钮才站得住。
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        window.contentView = content
    }

    func show() {
        showIntro()
        window.makeKeyAndOrderFront(nil)
    }

    /// 截图用:把窗口摆出来但**不抢焦点、不上屏**。`cacheDisplay` 不需要它可见。
    func showOffscreen() {
        showIntro()
        // 摆到屏幕外并 orderFrontRegardless:不抢焦点,但窗口仍然"被显示过" ——
        // 没有这一下,AppKit 根本不给它布局,截出来就是一张白纸。
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFrontRegardless()
    }

    var nsWindow: NSWindow { window }

    // ───────────────────────── 第一屏:开场 ─────────────────────────

    func showIntro() {
        let title = InstallerWindow.label("安装工作台", size: 30, weight: .bold)
        let body = InstallerWindow.label(
            """
            这会把工作台装到这台电脑上:一个叫「工作台」的程序,加上它在后台要用的东西。\
            装好之后它会跟着开机自己启动。

            大约需要 3 到 10 分钟,取决于网速 —— 中间要从网上下两样东西,所以请保持联网。\
            装到一半断了没关系,重新打开这个安装器接着装就行。
            """,
            size: 13, color: .secondaryLabelColor)
        body.preferredMaxLayoutWidth = 520

        let start = InstallerWindow.button("开始安装", target: self, action: #selector(startInstall))
        start.keyEquivalent = "\r"

        let stack = NSStackView(views: [title, body])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18

        let container = NSView()
        container.addSubview(stack)
        container.addSubview(start)
        stack.translatesAutoresizingMaskIntoConstraints = false
        start.translatesAutoresizingMaskIntoConstraints = false
        // 顶上一条粒子黑洞横幅(2026-09-23 维护者拍板:主视觉用在安装器欢迎页)。
        // 图是 installer-app/scripts/render-welcome-hero.mjs 离线画的;缺了图就退回原来的排法,不空一块黑。
        let hero = InstallerWindow.welcomeHero(resources: resources)
        if let hero {
            container.addSubview(hero)
            hero.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                hero.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                hero.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                hero.topAnchor.constraint(equalTo: container.topAnchor),
                hero.heightAnchor.constraint(equalToConstant: InstallerWindow.heroHeight),
            ])
        }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            hero.map { stack.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 28) }
                ?? stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 48),
            start.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            start.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -32),
        ])
        swap(to: container)
    }

    /// 「装好了」那一屏上说桌面整理干了什么、去哪儿改回来的那段话。
    ///
    /// **与插件那侧 `DESKTOP_TIDY_SUMMARY` 是同一份话**(workbench-plugin/src/server/setup/installer.ts)。
    /// 两边各存一份是因为这两半不共享一行代码(Swift / TypeScript),插件那侧有用例钉着
    /// 「注销」「桌面与程序坞」「控制中心」这几个词一定在里面;改一边记得改另一边。
    static let desktopTidySummary = """
        顺手把顶部菜单栏和底下的程序坞都设成了「自动隐藏」—— 鼠标碰到屏幕边上它们就出来,\
        这样工作台能多用到那两条地方。菜单栏那一下要注销一次或者重启才看得到效果,程序坞已经生效了。\
        想改回来:系统设置 → 桌面与程序坞(程序坞),系统设置 → 控制中心 → 菜单栏(菜单栏)。
        """

    /// 横幅的点高(图是 @2x 的 1240×400,按 620×200 点摆)。
    static let heroHeight: CGFloat = 200

    /// 欢迎页横幅:Resources/welcome-hero.png。找不到就 nil(欢迎页照旧,只是没有横幅)。
    /// 用图层铺,不用 NSImageView:图层按 resizeAspectFill 贴满、底色是原型的 #08090b,窗口再宽也不露缝。
    static func welcomeHero(resources: String) -> NSView? {
        let candidates = [resources + "/welcome-hero.png", Bundle.main.path(forResource: "welcome-hero", ofType: "png")].compactMap { $0 }
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }),
              let image = NSImage(contentsOfFile: path) else { return nil }
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(srgbRed: 8 / 255, green: 9 / 255, blue: 11 / 255, alpha: 1).cgColor
        view.layer?.contents = image
        view.layer?.contentsGravity = .resizeAspectFill
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.image)
        view.setAccessibilityLabel("粒子黑洞:一道亮白的光环,粒子向它汇聚")
        return view
    }

    // ───────────────────────── 第二屏:装的过程 ─────────────────────────

    private func showProgress() {
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 1
        progress.doubleValue = 0
        // 全局去蓝:系统进度条画的是强调色(默认蓝)。整条去饱和成中性灰白,不自己另画一套控件。
        progress.wantsLayer = true
        if let gray = CIFilter(name: "CIColorControls", parameters: [kCIInputSaturationKey: 0]) {
            progress.contentFilters = [gray]
        }

        noteLabel.preferredMaxLayoutWidth = 520
        errorLabel.preferredMaxLayoutWidth = 520
        errorLabel.isHidden = true

        logToggle.title = "详细日志"
        logToggle.setButtonType(.pushOnPushOff)
        logToggle.bezelStyle = .inline
        logToggle.target = self
        logToggle.action = #selector(toggleLog)

        logText.isEditable = false
        logText.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        logText.textColor = .secondaryLabelColor
        logScroll.documentView = logText
        logScroll.hasVerticalScroller = true
        logScroll.borderType = .bezelBorder
        logScroll.isHidden = true

        retryButton.title = "重试"
        retryButton.target = self
        retryButton.action = #selector(startInstall)
        retryButton.isHidden = true
        retryButton.keyEquivalent = "\r"

        // 「这一趟的日志在哪」+「在访达里显示」(2026-09-27,卡 PN):平时藏着,出错那一屏才露出来。
        // 为什么非有不可:界面里那块日志窗口一关就没了,而排障真正要的是她**把日志发过来**。
        logFileLabel.isHidden = true
        logFileLabel.preferredMaxLayoutWidth = 420
        revealLogButton.title = "在访达里显示"
        revealLogButton.bezelStyle = .inline
        revealLogButton.target = self
        revealLogButton.action = #selector(revealLogFile)
        revealLogButton.isHidden = true
        let logFileRow = NSStackView(views: [logFileLabel, revealLogButton])
        logFileRow.orientation = .horizontal
        logFileRow.alignment = .firstBaseline
        logFileRow.spacing = 8

        let header = InstallerWindow.label("正在安装,请不要关掉这个窗口", size: 12, color: .tertiaryLabelColor)
        let stack = NSStackView(views: [header, stepLabel, progress, noteLabel, errorLabel, logFileRow, logToggle, logScroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.setCustomSpacing(6, after: stepLabel)
        stack.setCustomSpacing(6, after: progress)

        let container = NSView()
        container.addSubview(stack)
        container.addSubview(retryButton)
        stack.translatesAutoresizingMaskIntoConstraints = false
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        progress.translatesAutoresizingMaskIntoConstraints = false
        logScroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 40),
            progress.widthAnchor.constraint(equalTo: stack.widthAnchor),
            logScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            logScroll.heightAnchor.constraint(equalToConstant: 150),
            retryButton.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            retryButton.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -32),
        ])
        swap(to: container)
    }

    // ───────────────────────── 第三屏:授权(2026-09-27,卡 IN) ─────────────────────────

    /// 授权那一屏上每一行的那几件东西(要随轮询改,所以留着引用)。
    private struct GrantRowViews {
        let grant: InstallerGrant
        let state: NSTextField
        let button: PrimaryButton
        let settings: NSButton
    }
    private var grantRows: [GrantRowViews] = []
    private var grantTimer: Timer?
    private var grantWorkRepo = ""

    /// 「装好了」之前多的这一屏:每一样授权一行,点了就由**壳自己**去发起那一问。
    ///
    /// 为什么不在这儿弹框:授权按 App 记 —— 安装器弹的那一下记在「安装工作台」名下,
    /// 而那个 App 装完就再也不会被打开。整段道理在 `Grants.swift` 顶上。
    /// 可以「先跳过」:她这会儿可能急着用,而工作台里引导那一步会再问一次(已经给过的不再问)。
    func showGrants(workRepo: String) {
        grantWorkRepo = workRepo
        grantRows = []

        let title = InstallerWindow.label("还差几个授权。", size: 28, weight: .bold)
        let body = InstallerWindow.label(
            """
            这几样只有你能点,工作台替不了。趁现在一次点完,以后就不用再管了 —— 工作台更新也不会掉。
            """,
            size: 13, color: .secondaryLabelColor)
        body.preferredMaxLayoutWidth = 520

        let stack = NSStackView(views: [title, body])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14

        for grant in InstallerGrant.allCases {
            let name = InstallerWindow.label(grant.label, size: 14, weight: .semibold)
            let state = InstallerWindow.label("还没允许", size: 12, color: .tertiaryLabelColor)
            let why = InstallerWindow.label(grant.why, size: 12, color: .secondaryLabelColor)
            why.preferredMaxLayoutWidth = 350
            let button = PrimaryButton(title: "去允许")
            button.target = self
            button.action = #selector(askGrant(_:))
            button.tag = InstallerGrant.allCases.firstIndex(of: grant) ?? 0
            // 「打开系统设置」是第二条路:系统那个框有时候只弹一次,她错过了就只能自己去那张表。
            let settings = NSButton(title: "打开系统设置", target: self, action: #selector(openGrantSettings(_:)))
            settings.bezelStyle = .inline
            settings.tag = button.tag

            let head = NSStackView(views: [name, state])
            head.orientation = .horizontal
            head.spacing = 10
            let text = NSStackView(views: [head, why])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 2
            let buttons = NSStackView(views: [settings, button])
            buttons.orientation = .horizontal
            buttons.spacing = 8
            let row = NSStackView(views: [text, buttons])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 16
            text.setContentHuggingPriority(.defaultLow, for: .horizontal)

            stack.addView(row, in: .top)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            grantRows.append(GrantRowViews(grant: grant, state: state, button: button, settings: settings))
        }

        // 文稿 / 日历:如实说一句,不做成一颗点了没用的键(理由在 Grants.swift)。
        let later = InstallerWindow.label(documentsAndCalendarNote, size: 12, color: .tertiaryLabelColor)
        later.preferredMaxLayoutWidth = 520
        stack.addView(later, in: .top)
        // 系统防火墙那一问(本机通话服务第一次起来时系统发起,理由在 Grants.swift)。
        let firewall = InstallerWindow.label(firewallNote, size: 12, color: .tertiaryLabelColor)
        firewall.preferredMaxLayoutWidth = 520
        stack.addView(firewall, in: .top)

        let skip = NSButton(title: "先跳过", target: self, action: #selector(finishGrants))
        skip.bezelStyle = .inline
        let next = InstallerWindow.button("下一步", target: self, action: #selector(finishGrants))
        next.keyEquivalent = "\r"

        let container = NSView()
        container.addSubview(stack)
        container.addSubview(skip)
        container.addSubview(next)
        stack.translatesAutoresizingMaskIntoConstraints = false
        skip.translatesAutoresizingMaskIntoConstraints = false
        next.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 36),
            next.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            next.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -32),
            skip.centerYAnchor.constraint(equalTo: next.centerYAnchor),
            skip.trailingAnchor.constraint(equalTo: next.leadingAnchor, constant: -14),
        ])
        swap(to: container)

        refreshGrants()
        grantTimer?.invalidate()
        // 每秒读一次 grants.json。她去系统设置里拨开关那几十秒里,这一行会自己变成「已完成」。
        grantTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshGrants() }
    }

    @objc private func askGrant(_ sender: NSButton) {
        let all = InstallerGrant.allCases
        guard sender.tag >= 0, sender.tag < all.count else { return }
        let grant = all[sender.tag]
        InstallerGrantStatus.ask(grant, shellApp: shellApp)
        // 提示那句只在点过之后出现 —— 没点过就摆一句「系统会弹框」是提前替她担心。
        if let row = grantRows.first(where: { $0.grant == grant }) {
            row.state.stringValue = grant.hint
            row.state.textColor = .secondaryLabelColor
        }
    }

    @objc private func openGrantSettings(_ sender: NSButton) {
        let all = InstallerGrant.allCases
        guard sender.tag >= 0, sender.tag < all.count else { return }
        InstallerGrantStatus.openSettings(all[sender.tag])
    }

    /// 读一次状态文件,把已经给了的那几行画成「已完成」。**只读,不问**。
    /// 没给的那几行一个字不动 —— 她刚点过那一下留下的提示句不该被轮询冲掉。
    private func refreshGrants() {
        let states = InstallerGrantStatus.read()
        for row in grantRows where states[row.grant] == .granted { markGranted(row) }
    }

    /// 把一行画成「已完成」。**两颗键一起收走** —— 留一颗灰着的键只会让人想再点一次。
    private func markGranted(_ row: GrantRowViews) {
        row.state.stringValue = "已完成"
        row.state.textColor = .systemGreen
        row.button.isHidden = true
        row.settings.isHidden = true
    }

    /// 截图用:把某一行画成「已完成」(不碰状态文件)。
    func markGrantGranted(_ grant: InstallerGrant) {
        guard let row = grantRows.first(where: { $0.grant == grant }) else { return }
        markGranted(row)
    }

    @objc private func finishGrants() {
        grantTimer?.invalidate()
        grantTimer = nil
        grantRows = []
        showDone(workRepo: grantWorkRepo)
    }

    // ───────────────────────── 第四屏:装好了 ─────────────────────────

    // ───────────────── 装完之后自检三件(2026-10-21,卡「引导三件事」) ─────────────────
    //
    // 内核装完之后接着把早报、交代一件事、打个电话各试一遍,一件一条 `check` 事件发上来。
    // 这一块只管摆:一件一行(成 / 没成 + 缺哪道门),能一颗键修的(登录 Claude / Codex)给键。不说「都好了」。

    private var checks: [(key: String, ok: Bool, line: String, logins: [(family: String, label: String)])] = []
    private let checkStack = NSStackView()

    private func refreshChecks() {
        checkStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        checkStack.orientation = .vertical
        checkStack.alignment = .leading
        checkStack.spacing = 6
        if checks.isEmpty {
            checkStack.addArrangedSubview(InstallerWindow.label(
                "正在把三件事各试一遍:早报、交代一件事、打个电话……", size: 12, color: .secondaryLabelColor))
            return
        }
        let order = ["morning", "delegate", "call"]
        for one in checks.sorted(by: { (order.firstIndex(of: $0.key) ?? 9) < (order.firstIndex(of: $1.key) ?? 9) }) {
            let text = InstallerWindow.label((one.ok ? "✓ " : "· ") + one.line, size: 12,
                                             color: one.ok ? .labelColor : .secondaryLabelColor)
            text.preferredMaxLayoutWidth = 520
            checkStack.addArrangedSubview(text)
            for login in one.logins {
                let button = InstallerWindow.button(login.label, target: self, action: #selector(loginAgent(_:)))
                button.identifier = NSUserInterfaceItemIdentifier(login.family)
                checkStack.addArrangedSubview(button)
            }
        }
    }

    /// 「登录 Claude / Codex」:让工作台在这台电脑上开它自己的登录窗口(账号密码工作台不经手)。
    @objc private func loginAgent(_ sender: NSButton) {
        guard let family = sender.identifier?.rawValue,
              let url = URL(string: "http://127.0.0.1:8791/agents/login") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["family": family])
        sender.isEnabled = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                sender.title = ok ? "登录窗口开了,登完回来就行" : "没开成:打开工作台后在设置里登录"
            }
        }.resume()
    }

    private func showDone(workRepo: String) {
        let title = InstallerWindow.label("装好了。", size: 30, weight: .bold)
        let body = InstallerWindow.label(
            """
            刚才那几个授权,点过的以后就不用再管了 —— 工作台更新也不会掉。\
            上一屏跳过的话,进了工作台,引导走到授权那一步还会再问你一次。

            「文稿」文件夹和「日历」这两样,系统会在工作台第一次用到的时候弹框问你,点「允许」。

            \(InstallerWindow.desktopTidySummary)

            你的东西会放在 \(workRepo.replacingOccurrences(of: NSHomeDirectory(), with: "~"))。
            """,
            size: 13, color: .secondaryLabelColor)
        body.preferredMaxLayoutWidth = 520

        let open = InstallerWindow.button("打开工作台", target: self, action: #selector(openWorkbench))
        open.keyEquivalent = "\r"

        refreshChecks()
        let stack = NSStackView(views: [title, body, checkStack])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18

        let container = NSView()
        container.addSubview(stack)
        container.addSubview(open)
        stack.translatesAutoresizingMaskIntoConstraints = false
        open.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 48),
            open.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            open.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -32),
        ])
        swap(to: container)
    }

    /// 截图用:直接跳到「装好了」那一屏(平时它只由授权屏的「下一步」进)。
    func showDoneForScreenshot(workRepo: String) {
        grantTimer?.invalidate()
        grantTimer = nil
        grantRows = []
        showDone(workRepo: workRepo)
    }

    // ───────────────────────── 动作 ─────────────────────────

    /// 截图那一趟要从外面调它(内部可见,不是 private)。
    @objc func startInstall() {
        showProgress()
        errorLabel.isHidden = true
        retryButton.isHidden = true
        stepLabel.stringValue = "正在开始…"
        noteLabel.stringValue = ""
        currentStep = 0
        currentStepPct = 0
        finished = false
        kernel.run(onEvent: { [weak self] event in self?.handle(event) },
                   onExit: { [weak self] code in self?.handleExit(code) })
    }

    @objc private func toggleLog() {
        logScroll.isHidden = logToggle.state != .on
    }

    /// 在访达里选中那份日志(2026-09-27,卡 PN)。日志还没写出来就什么都不做 —— 不弹框吓人。
    @objc private func revealLogFile() {
        guard !logFilePath.isEmpty, FileManager.default.fileExists(atPath: logFilePath) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: logFilePath)])
    }

    /// 截图用:把「详细日志」摊开或收起。
    func setLogVisible(_ visible: Bool) {
        logToggle.state = visible ? .on : .off
        logScroll.isHidden = !visible
    }

    /// 起服务 → 等 3080 应答 → 打开壳。
    ///
    /// **为什么要等**:冷机第一次 launchd 把 DSH 拉起来要 20 秒以上,壳一打开就去连 3080,
    /// 连不上就是一屏错误。让人看着一句「正在启动工作台…」等一会儿,比看一屏错误好。
    @objc private func openWorkbench() {
        stepLabel.stringValue = "正在启动工作台…"
        showProgress()
        progress.isIndeterminate = true
        progress.startAnimation(nil)
        stepLabel.stringValue = "正在启动工作台…"
        noteLabel.stringValue = "第一次启动要等一会儿(冷机 20 秒以上)。"

        let uid = getuid()
        DispatchQueue.global().async { [weak self] in
            _ = InstallerWindow.shell(["/bin/launchctl", "kickstart", "-k", "gui/\(uid)/ai.deepseek.dsh"])
            let up = InstallerWindow.waitForPort(url: "http://127.0.0.1:3080/", seconds: 150)
            DispatchQueue.main.async {
                guard let self else { return }
                if !up {
                    self.progress.stopAnimation(nil)
                    self.errorLabel.isHidden = false
                    self.errorLabel.stringValue = "等了两分半,工作台还没起来。先把电脑重启一次试试;还是不行的话,这份安装包旁边的说明里写了去哪儿看日志。"
                    self.retryButton.title = "再等一次"
                    self.retryButton.target = self
                    self.retryButton.action = #selector(self.openWorkbench)
                    self.retryButton.isHidden = false
                    return
                }
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: self.shellApp),
                                                   configuration: NSWorkspace.OpenConfiguration()) { _, _ in
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            }
        }
    }

    // ───────────────────────── 事件 → 界面 ─────────────────────────

    /// 截图那一趟直接喂事件走这条路 —— 截出来的就是真机上会看到的那一屏。
    func handle(_ event: KernelEvent) {
        if traceEvents, case .log = event {} else if traceEvents {
            FileHandle.standardError.write(Data("事件 \(event)\n".utf8))
        }
        switch event {
        case .begin(let total):
            totalSteps = max(total, 1)
        case .step(let index, let total, _, let title):
            currentStep = index
            totalSteps = max(total, 1)
            currentStepPct = 0
            stepLabel.stringValue = title
            noteLabel.stringValue = "第 \(index) 步,共 \(total) 步"
            progress.isIndeterminate = false
            updateProgress()
        case .note(let text):
            noteLabel.stringValue = text
            append(log: text)
        case .log(let text):
            append(log: text)
        case .logfile(let path):
            // 只记下来,不上屏 —— 一切顺利的时候没人关心日志在哪。出错那一屏才说。
            logFilePath = path
        case .progress(let pct):
            currentStepPct = min(max(pct, 0), 1)
            updateProgress()
        case .skip(_, let why):
            // 可选步骤没装成不是失败,但也不能假装没发生过 —— 说一句,留在日志里。
            noteLabel.stringValue = "这一步跳过了(不影响使用)"
            append(log: "跳过:" + why)
        case .fail(_, let title, let error, let tail):
            finished = true
            // 「正在下载工作台的运行时…」→「没能下载工作台的运行时」。省掉那三个点:
            // 它的意思是"还在动",而这会儿已经停了。
            stepLabel.stringValue = "没能" + title
                .replacingOccurrences(of: "正在", with: "")
                .replacingOccurrences(of: "…", with: "")
            errorLabel.stringValue = error
            errorLabel.isHidden = false
            retryButton.title = "重试"
            retryButton.target = self
            retryButton.action = #selector(startInstall)
            retryButton.isHidden = false
            noteLabel.stringValue = "装好的那几步不会重装,点「重试」会从这一步接着来。"
            append(log: "—— 出错那一步的最后几行 ——")
            for line in tail { append(log: line) }
            showLogFileRow()
        case .check(let key, let ok, let line, let logins):
            // 装完之后那三行(2026-10-21):先记下,「装好了」那一屏在就当场重画那一块。
            checks.removeAll { $0.key == key }
            checks.append((key: key, ok: ok, line: line, logins: logins))
            append(log: line)
            refreshChecks()
        case .done(let shell, let workRepo):
            finished = true
            shellApp = shell.isEmpty ? shellApp : shell
            progress.doubleValue = 1
            // 先「授权」那一屏,再「装好了」(2026-09-27,卡 IN):趁她还在这儿,把只有她能点的那几下点完。
            showGrants(workRepo: workRepo)
        }
    }

    private func handleExit(_ code: Int32) {
        guard !finished else { return }
        // 内核没说话就退了(被杀掉、崩了)。**不猜原因**,把退出码摆出来。
        finished = true
        errorLabel.stringValue = "安装程序中途退出了(退出码 \(code)),没有说原因。点「重试」再来一次。"
        errorLabel.isHidden = false
        retryButton.title = "重试"
        retryButton.target = self
        retryButton.action = #selector(startInstall)
        retryButton.isHidden = false
        showLogFileRow()
    }

    /// 出错那一屏底下那一行:日志在哪 +「在访达里显示」。日志路径还没收到就不说话(不编一条路径)。
    private func showLogFileRow() {
        guard !logFilePath.isEmpty else { return }
        logFileLabel.stringValue = "这一趟的完整日志:\(logFilePath)(把它发给我们最有用)"
        logFileLabel.isHidden = false
        revealLogButton.isHidden = false
    }

    private func updateProgress() {
        let base = Double(max(currentStep - 1, 0))
        progress.doubleValue = (base + currentStepPct) / Double(totalSteps)
    }

    private func append(log line: String) {
        guard !line.isEmpty else { return }
        logText.textStorage?.append(NSAttributedString(
            string: line + "\n",
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                         .foregroundColor: NSColor.secondaryLabelColor]))
        logText.scrollToEndOfDocument(nil)
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private func swap(to view: NSView) {
        content.subviews.forEach { $0.removeFromSuperview() }
        view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            view.topAnchor.constraint(equalTo: content.topAnchor),
            view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        content.layoutSubtreeIfNeeded()
    }

    private static func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.isSelectable = false
        return field
    }

    private static func button(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let button = PrimaryButton(title: title)
        button.target = target
        button.action = action
        return button
    }

    @discardableResult
    private static func shell(_ argv: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: argv[0])
        task.arguments = Array(argv.dropFirst())
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return -1 }
        task.waitUntilExit()
        return task.terminationStatus
    }

    /// 轮询一个地址,直到它**回了任何东西**(不管几号状态码)。回不了 = 服务还没起来。
    private static func waitForPort(url: String, seconds: Int) -> Bool {
        guard let target = URL(string: url) else { return false }
        let deadline = Date().addingTimeInterval(TimeInterval(seconds))
        while Date() < deadline {
            let semaphore = DispatchSemaphore(value: 0)
            var alive = false
            var request = URLRequest(url: target)
            request.timeoutInterval = 3
            URLSession.shared.dataTask(with: request) { _, response, _ in
                alive = response != nil
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 5)
            if alive { return true }
            Thread.sleep(forTimeInterval: 2)
        }
        return false
    }
}

/// 主按钮:**白底黑字,不用系统强调色**(2026-09-24 维护者真机反馈,全局去蓝规矩)。
///
/// 为什么自绘:带 bezel 的 NSButton 一旦设了 `keyEquivalent = "\r"` 就成了窗口的默认按钮,
/// 系统会拿「强调色」(默认蓝)把它整个涂满 —— 改不了颜色,只能不要 bezel、自己画底。
/// 回车照样能按:`keyEquivalent` 走的是 `performKeyEquivalent`,和画不画边框无关。
///
/// 描边一像素中性灰:安装器跟随系统深浅色,浅色窗口上一块纯白底会看不见边。
final class PrimaryButton: NSButton {
    private static let fill = NSColor.white
    private static let pressedFill = NSColor(srgbRed: 0xD9 / 255, green: 0xD9 / 255, blue: 0xD9 / 255, alpha: 1)
    private static let border = NSColor(srgbRed: 0xC8 / 255, green: 0xC8 / 255, blue: 0xC8 / 255, alpha: 1)
    private static let ink = NSColor.black
    private static let disabledInk = NSColor(srgbRed: 0x8A / 255, green: 0x8A / 255, blue: 0x8A / 255, alpha: 1)

    private var restyling = false

    convenience init(title: String) {
        self.init(frame: .zero)
        self.title = title
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setButtonType(.momentaryPushIn)
        isBordered = false
        wantsLayer = true
        focusRingType = .none  // 焦点环也是强调色(蓝),一并不要
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("不从 nib 建") }

    // 外面会改 title(「重试」↔「再等一次」):改完要把黑字重新套上,否则退回系统默认字色。
    override var title: String { didSet { restyle() } }
    override var isEnabled: Bool { didSet { restyle() } }

    /// 按下态:NSButton 的跟踪循环在 `super.mouseDown` 里同步跑完,不一定回头设控件的
    /// `isHighlighted`,所以自己在进出跟踪时把底色切灰/切回,最稳。
    private var pressed = false { didSet { restyle() } }
    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = true
        super.mouseDown(with: event)
        pressed = false
    }

    override var intrinsicContentSize: NSSize {
        let text = attributedTitle.size()
        return NSSize(width: ceil(text.width) + 40, height: 36)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        restyle()  // CGColor 不跟深浅色走,切换外观时重设一次
    }

    private func restyle() {
        guard !restyling else { return }
        restyling = true
        defer { restyling = false }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: isEnabled ? PrimaryButton.ink : PrimaryButton.disabledInk,
            .paragraphStyle: paragraph,
        ])
        layer?.backgroundColor = (pressed ? PrimaryButton.pressedFill : PrimaryButton.fill).cgColor
        layer?.borderColor = PrimaryButton.border.cgColor
        alphaValue = isEnabled ? 1 : 0.5
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }
}
