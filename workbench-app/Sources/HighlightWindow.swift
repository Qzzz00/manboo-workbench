import AppKit

/**
 光圈(2026-09-10,docs/设计-总管形态-Siri式与手机.md §四 第 2 步)。

 一扇**透明、忽略鼠标、只画一圈发光边框**的浮窗。总管在动哪个模块,服务端就把那个模块的
 屏幕矩形发过来,这里把边框画在它周围;`rect` 为 null 或到了 ttl 就自己灭。

 与 hover_zone 是两件事,别混:
 - `hover_zone` 是**判定**——WindowControl 拿那个圈算"窗口中心在不在里面",只回事件,
   不画任何东西;
 - 这里是**绘制**——一扇浮窗,不参与任何判定,也不碰 AX。两边各存各的矩形,互不知道对方。

 三条约束:
 - **绝不吃鼠标**:`ignoresMouseEvents = true` + 无边框 + 不可成为 key window。光圈盖在
   哪个应用上面,那个应用照常点、照常拖——这一条错了,光圈就从提示变成了障碍。
 - **不激活自己**:一律 `orderFrontRegardless()`,不 `makeKey`、不 `NSApp.activate()`。
   总管在后台动一下窗位,不该把工作台抢到前台来。
 - **屏变自愈**:AX 坐标是相对主屏左上角算的,主屏一换(拔线 / UU 远程虚拟屏顶替),
   同一个 AX 矩形对应的 AppKit 坐标就变了。沿用 AppDelegate.handleScreenParametersChanged
   的思路:屏参数一变就按存着的 AX 矩形重算一次;算出来的框不在任何一块屏上就直接灭
   ——那说明这个矩形已经指向不存在的区域,继续画只会在角落留一圈鬼影。
 */
final class HighlightOverlay {
    /// 默认亮多久。服务端一般会显式传 ttl_ms(2 秒),这里是它不传时的兜底。
    private static let defaultTTL: TimeInterval = 2.0
    /// ttl 的合法区间:短于 0.2 秒人眼看不到一个淡入淡出,长于 30 秒就成了糊在屏幕上的常驻物。
    private static let minTTL: TimeInterval = 0.2
    private static let maxTTL: TimeInterval = 30.0
    /// 边框画在矩形外面的余量(pt)。窗口比目标矩形每边大这么多,发光才有地方铺开。
    private static let margin: CGFloat = 8

    private var window: NSWindow?
    private var view: HighlightBorderView?
    /// 当前亮着的那个 AX 矩形(主屏左上原点,y 向下)。nil = 没亮。屏变自愈靠它重算。
    private var axRect: CGRect?
    private var timer: DispatchWorkItem?

    init() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScreenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    /// 亮起来。`ttlMs` 缺省 2 秒;同一个矩形再发一次就是**续期**(旧的定时器作废,重新计时)。
    /// `beam: false` = 只亮那行字,不画那圈流线光(2026-09-25 卡 P 补:窗口槽那圈光只属于他亲手拖进来、松手那一下,
    /// 事务官自己切窗 / 认领 / 放开窗位只留「事务官正在切换窗位」这行字)。
    func show(axRect rect: CGRect, ttlMs: Int?, label: String?, beam: Bool = true) {
        guard let frame = appKitFrame(for: rect) else {
            // 算不出屏幕坐标(一块屏都没有)——不画,也不留旧的在那儿冒充。
            hide()
            return
        }
        axRect = rect

        let panel = window ?? makeWindow()
        let border = view ?? HighlightBorderView(frame: .zero)
        if window == nil {
            panel.contentView = border
            window = panel
            view = border
        }
        border.label = (label?.isEmpty ?? true) ? nil : label
        border.beam = beam
        panel.setFrame(frame, display: false)
        border.frame = panel.contentRect(forFrameRect: frame).offsetBy(dx: -frame.origin.x, dy: -frame.origin.y)
        border.needsDisplay = true
        panel.orderFrontRegardless()

        let ttl = clampTTL(ttlMs)
        timer?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ttl, execute: work)
    }

    /// 灭。到 ttl、收到 rect:null、算不出坐标都走这里。窗口留着复用(下一次 show 不用重建)。
    func hide() {
        timer?.cancel()
        timer = nil
        axRect = nil
        window?.orderOut(nil)
    }

    private func clampTTL(_ ttlMs: Int?) -> TimeInterval {
        guard let ttlMs else { return Self.defaultTTL }
        let seconds = TimeInterval(ttlMs) / 1000
        return min(max(seconds, Self.minTTL), Self.maxTTL)
    }

    private func makeWindow() -> NSWindow {
        let panel = NSWindow(contentRect: .zero, styleMask: [.borderless],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true // 绝不吃鼠标:光圈只是画上去的一层,不挡任何点击。
        panel.level = .statusBar        // 高于普通窗与 .floating:光圈要压在被贴合的应用窗口上面。
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        return panel
    }

    /**
     AX 全局坐标(主屏左上原点,y 向下)→ AppKit 全局坐标(主屏左下原点,y 向上),
     再往外扩一圈 margin 给发光留地方。

     主屏高度的取法与 AppDelegate.screenInfoPayload 是同一条(原点在 (0,0) 的那块屏),
     两边必须一致——那边算 axY 用的是 `主屏高 - maxY`,这里是它的逆运算,取法不同就会
     整体偏一个屏高差。一块屏都没有(理论上不会)时回 nil,由调用方按"不画"处理。
     */
    private func appKitFrame(for rect: CGRect) -> CGRect? {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return nil }
        let primaryH = screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? screens[0].frame.height
        let flippedY = primaryH - (rect.origin.y + rect.height)
        let base = CGRect(x: rect.origin.x, y: flippedY, width: rect.width, height: rect.height)
        return base.insetBy(dx: -Self.margin, dy: -Self.margin)
    }

    /// 屏变自愈(沿用 AppDelegate.handleScreenParametersChanged 的思路)。
    @objc private func handleScreenParametersChanged() {
        guard let rect = axRect else { return }
        guard let frame = appKitFrame(for: rect),
              NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) else {
            // 新的屏幕布局里这个矩形落在了任何一块屏之外——它指的区域已经不存在了,灭掉。
            hide()
            return
        }
        window?.setFrame(frame, display: true)
        view?.frame = CGRect(origin: .zero, size: frame.size)
        view?.needsDisplay = true
    }
}

/**
 光圈的参数(2026-09-24,维护者:「之前我们有自制的应用拖拽到窗口槽的边缘光效,也统一改成现在我提供给你那个视效库的光效」)。

 网页那边用的是 libraries.dev 的 border-beam(`size="md"`,光绕整圈走),参数在
 `workbench-plugin/src/client/fx/fxModel.ts` 的 `BEAM.slotHover`;原生浮层用不了 React 组件,
 这里用 CALayer 照同一个样子重画:一圈 1pt 的淡发丝边 + 一段锥形渐变的亮光沿圆角矩形绕圈,外面一层更宽更淡的晕。
 **两边要改一起改**:一圈几秒(`duration`)、线宽、圆角、颜色(中性白,不再是青蓝)。
 「减少动态效果」打开时不转,只留一圈静态亮边(与网页那边 border-beam 停动画 + 静态淡边同口径)。
 */
enum HighlightBeam {
    /// 一圈几秒 —— 与 fxModel.ts BEAM.slotHover.duration 相同。
    static let duration: CFTimeInterval = 3.2
    /// 亮光那一道的线宽(pt);border-beam md 的边是 1px,原生浮层离得远、要压在别的应用上,取 1.5。
    static let coreWidth: CGFloat = 1.5
    /// 外面那层晕的线宽(pt)与不透明度。
    static let bloomWidth: CGFloat = 7
    static let bloomOpacity: Float = 0.35
    /// 常亮的那圈发丝边的不透明度。
    static let hairlineOpacity: CGFloat = 0.28
    /// 圆角 —— 与网页槽体 `.ben-wb__slot-body` 的 border-radius 一致。
    static let radius: CGFloat = 8
    /// 中性白(2026-09-24 全局去蓝)。
    static let color = NSColor.white
}

/// 只画一圈沿边流动的光 +(可选)一行小字。除了画,什么都不做。
final class HighlightBorderView: NSView {
    var label: String? { didSet { needsDisplay = true } }
    /// false = 只画那行字(发丝边、流线光、晕都不画)。
    var beam = true {
        didSet {
            guard beam != oldValue else { return }
            restartSweep()
        }
    }

    /// 光圈离窗边的内缩(pt):窗口比目标矩形每边大 margin,光画在中间,晕才有地方铺开。
    private let inset: CGFloat = 5
    private let hairline = CAShapeLayer()
    private let coreMask = CAShapeLayer()
    private let bloomMask = CAShapeLayer()
    private let coreHost = CALayer()
    private let bloomHost = CALayer()
    private let coreSweep = CAGradientLayer()
    private let bloomSweep = CAGradientLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        hairline.fillColor = nil
        hairline.strokeColor = HighlightBeam.color.withAlphaComponent(HighlightBeam.hairlineOpacity).cgColor
        hairline.lineWidth = 1
        for (host, mask, sweep, width) in [(bloomHost, bloomMask, bloomSweep, HighlightBeam.bloomWidth), (coreHost, coreMask, coreSweep, HighlightBeam.coreWidth)] {
            mask.fillColor = nil
            mask.strokeColor = NSColor.black.cgColor
            mask.lineWidth = width
            sweep.type = .conic
            sweep.startPoint = CGPoint(x: 0.5, y: 0.5)
            sweep.endPoint = CGPoint(x: 0.5, y: 0)
            // 一段亮光 + 一条渐隐的尾巴,其余一圈透明 —— 跟 border-beam 那道光一个样子。
            let c = HighlightBeam.color
            sweep.colors = [c.withAlphaComponent(0).cgColor, c.withAlphaComponent(0).cgColor, c.withAlphaComponent(0.55).cgColor, c.withAlphaComponent(1).cgColor, c.withAlphaComponent(0).cgColor]
            sweep.locations = [0, 0.62, 0.86, 0.97, 1]
            host.addSublayer(sweep)
            host.mask = mask
        }
        bloomHost.opacity = HighlightBeam.bloomOpacity
        layer?.addSublayer(hairline)
        layer?.addSublayer(bloomHost)
        layer?.addSublayer(coreHost)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) 不用") }

    override var isFlipped: Bool { false }
    /// 无边框窗口默认就不成为 key,这里再堵一道:光圈永远不该拿走焦点。
    override var acceptsFirstResponder: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let rect = bounds.insetBy(dx: inset, dy: inset)
        guard rect.width > 0, rect.height > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let path = CGPath(roundedRect: rect, cornerWidth: HighlightBeam.radius, cornerHeight: HighlightBeam.radius, transform: nil)
        hairline.frame = bounds
        hairline.path = path
        // 渐变层是一个盖得住整圈的正方形,绕中心转;遮罩(描边)不动,光就沿着边走。
        let side = hypot(bounds.width, bounds.height)
        for (host, mask, sweep) in [(bloomHost, bloomMask, bloomSweep), (coreHost, coreMask, coreSweep)] {
            host.frame = bounds
            mask.frame = bounds
            mask.path = path
            sweep.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            sweep.position = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        CATransaction.commit()
        restartSweep()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        restartSweep()
    }

    /// 转起来;「减少动态效果」打开时不转,整圈常亮(与网页那边的静态淡边同口径)。只亮字(`beam == false`)时整圈都不画。
    private func restartSweep() {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        hairline.isHidden = !beam
        for sweep in [coreSweep, bloomSweep] {
            sweep.removeAnimation(forKey: "sweep")
            if reduce || !beam { continue }
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi // 顺时针
            spin.duration = HighlightBeam.duration
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            sweep.add(spin, forKey: "sweep")
        }
        coreHost.isHidden = reduce || !beam
        bloomHost.isHidden = reduce || !beam
        hairline.strokeColor = HighlightBeam.color.withAlphaComponent(reduce ? 0.7 : HighlightBeam.hairlineOpacity).cgColor
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: inset, dy: inset)
        guard rect.width > 0, rect.height > 0 else { return }
        drawLabel(in: rect)
    }

    /// 一行小字(「总管正在切换窗位」),贴在框的左上角内侧;放不下就不画——
    /// 宁可只有一圈光,也不要一行被截断到看不懂的字。
    private func drawLabel(in rect: NSRect) {
        guard let label, !label.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NSColor.white,
        ]
        let text = NSAttributedString(string: label, attributes: attrs)
        let size = text.size()
        let padding: CGFloat = 6
        let boxW = size.width + padding * 2
        let boxH = size.height + padding
        guard rect.width > boxW + 8, rect.height > boxH + 8 else { return }
        let box = NSRect(x: rect.minX + 6, y: rect.maxY - boxH - 6, width: boxW, height: boxH)
        let bubble = NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5)
        NSColor.black.withAlphaComponent(0.72).setFill()
        bubble.fill()
        HighlightBeam.color.withAlphaComponent(0.35).setStroke()
        bubble.lineWidth = 1
        bubble.stroke()
        text.draw(at: NSPoint(x: box.minX + padding, y: box.minY + padding / 2))
    }
}
