import AppKit
import WebKit

/// 加载占位那块视图 + 它的开关(判断在 LoadingCover.swift,这里只做 AppKit 那一半)。
///
/// 盖在 WKWebView 上面、同一个父视图里;背景跟工作台页面同一个底色(深色/浅色跟系统外观走),
/// 中间两行字:「工作台」「正在打开…」。揭开时淡出 0.25 秒。
final class LoadingCoverView: NSView {
    private let titleLabel = NSTextField(labelWithString: LoadingCover.title)
    private let subtitleLabel = NSTextField(labelWithString: LoadingCover.subtitle(waited: 0))
    /**
     * 「重试」(2026-09-26,卡 U6)。**只在探到头之后露出来**:还在等的时候摆一颗按钮,
     * 等于在说"你得做点什么",而那会儿他什么都不用做。
     */
    private let retryButton = NSButton(title: ShellReadiness.retryLabel, target: nil, action: nil)
    /// 按下「重试」时叫谁(AppDelegate 装上:重新探一轮再加载)。
    var onRetry: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        titleLabel.font = .systemFont(ofSize: 18, weight: .medium)
        titleLabel.textColor = .labelColor
        subtitleLabel.font = .systemFont(ofSize: 13)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.alignment = .center
        retryButton.bezelStyle = .rounded
        retryButton.target = self
        retryButton.action = #selector(retryTapped)
        retryButton.isHidden = true
        let stack = NSStackView(views: [titleLabel, subtitleLabel, retryButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func retryTapped() { onRetry?() }

    /// 探到头了(或者又开始等了):那颗「重试」跟着露出 / 收起。
    func setRetryVisible(_ visible: Bool) {
        if retryButton.isHidden == !visible { return }
        retryButton.isHidden = !visible
    }

    /// 深色 #0f1012 / 浅色白,接近工作台页面的 bg-base,淡出时不闪一块别的颜色。
    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        layer?.backgroundColor = (dark ? NSColor(srgbRed: 0x0f / 255, green: 0x10 / 255, blue: 0x12 / 255, alpha: 1)
                                       : NSColor.white).cgColor
    }
    override var wantsUpdateLayer: Bool { true }

    /// 盖板挡住下面的网页:点击不穿透。
    override func hitTest(_ point: NSPoint) -> NSView? { isHidden ? nil : self }

    func setSubtitle(_ text: String) {
        if subtitleLabel.stringValue != text { subtitleLabel.stringValue = text }
    }
}

/// 开关:什么时候盖、什么时候揭。
final class LoadingCoverController {
    let view: LoadingCoverView
    private var shownAt: Date?
    private var committedAt: Date?
    private var timer: Timer?
    /// 此刻屏上**已经提交**的那一页揭开过没有(2026-09-25)。主框架开始换页时会先盖上(`cover()`),
    /// 但换页不一定真的换成:点到一个「附件」,导航半路变成了下载,旧页原样留在那儿 —— 这时要按它
    /// 原来的样子揭开,不然盖板一直盖着一张好好的页面(没有提交就没有 20 秒兜底,会一直盖着)。
    private(set) var revealedPage = false

    init(frame: NSRect) {
        view = LoadingCoverView(frame: frame)
        view.autoresizingMask = [.width, .height]
    }

    /**
     * 等服务就绪那一段探到头了(2026-09-26,卡 U6)。摆一句人话 + 露出那颗「重试」,
     * **并且停下计时** —— 那一行不该再被 tick 改回「正在打开…」。盖板照旧盖着:
     * 下面那一页要么没加载过,要么是白的,露出来只会更糟。
     */
    private(set) var gaveUp = false

    /// 按下「重试」时叫谁。装在 controller 上,转交给视图那颗按钮。
    var onRetry: (() -> Void)? {
        get { view.onRetry }
        set { view.onRetry = newValue }
    }

    /// 主框架换页(或启动):盖上,从头计时。
    func cover() {
        shownAt = Date()
        committedAt = nil
        gaveUp = false
        view.setRetryVisible(false)
        view.setSubtitle(LoadingCover.subtitle(waited: 0))
        view.alphaValue = 1
        view.isHidden = false
        startTimer()
    }

    /// 探到头了:换那一句、露出「重试」、停表。再点「重试」会回到 `cover()`。
    func showGaveUp() {
        gaveUp = true
        timer?.invalidate()
        timer = nil
        view.setSubtitle(ShellReadiness.subtitle(waited: 0, gaveUp: true))
        view.setRetryVisible(true)
        view.alphaValue = 1
        view.isHidden = false
    }

    /// 主框架提交了一页(不管是不是工作台):开始算「提交后多久没 ready」。
    func noteCommitted() {
        revealedPage = false
        if view.isHidden { return }
        committedAt = Date()
    }

    /// 刚开始的那次换页没换成、变成了下载(见 `revealedPage`):旧页还在,揭开过就照旧揭开。
    /// 旧页本来就还没揭开(比如启动时)→ 什么都不做,盖板照原来的规矩走。
    func provisionalAbandoned() {
        if revealedPage { reveal() }
    }

    /// 工作台挂上了(或兜底时间到了):淡出揭开。
    func reveal() {
        revealedPage = true
        timer?.invalidate()
        timer = nil
        guard !view.isHidden else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.25
            view.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.view.alphaValue == 0 else { return }
            self.view.isHidden = true
        })
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        // 探到头之后那一行是定的(「工作台还没起来…」),别再被这里改回「正在打开…」。
        if gaveUp { return }
        let now = Date()
        if let shownAt { view.setSubtitle(LoadingCover.subtitle(waited: now.timeIntervalSince(shownAt))) }
        if let committedAt, now.timeIntervalSince(committedAt) >= LoadingCover.revealAfterCommit { reveal() }
    }
}

/// WKUserContentController 会强持有 handler;中间垫一层弱引用,免得 AppDelegate ↔ WebView 成环。
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
