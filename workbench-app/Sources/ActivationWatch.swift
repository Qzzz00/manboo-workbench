import AppKit
import ApplicationServices

/// 「有一家被叫到前面 / 被放出来」这件事的 AppKit 那一半(2026-09-25,卡 P;判断全在 ActivationSense.swift)。
///
/// 做这几件事:
/// 1. 记住谁藏着(NSWorkspace 的 hide / unhide 通知)—— 激活一个藏着的应用会先把它放出来,
///    「这一趟激活之前它是不是藏着的」只有在被放出来之前记下才知道;
/// 2. 有一家被激活(AppDelegate 转来的 didActivate)或**被放出来**(didUnhide —— 企业微信截图不激活自己,
///    只把自己放出来再盖一层遮罩,真机实测)就开一趟:开头 0.3 秒 10 毫秒看一次、之后照常,看它最前面那扇窗是哪一种
///    (CGWindowList 取层级与大小;AX 读得了的顺手问一句子角色),直到下结论;
/// 3. 结论交给 `onReport`(HelperSocket 发给服务端,由服务端决定窗口槽跟不跟、要不要藏回去)。
/// 4. 遮罩开着时每 30 毫秒只问一句「那扇遮罩还在不在屏上」;服务端预约过「遮罩一收就藏回去」的(`arm`):
///    **遮罩还开着就把它的普通窗口挪到屏外**(`park`,卡 P 补二:遮罩收起那一刻露出来的是他原来的页面,
///    不是它的主窗口),遮罩一收当场藏(`onRehide`),藏好了(didHide)再把窗挪回原位(`unpark`)。
/// 5. 每一趟记一条时间线(被掀出来 / 遮罩盖上 / 收起 / 挪开 / 藏好 / 挪回各在第几毫秒),跟着结论报给服务端,
///    进 `/state.dock.recent_activations`,统筹事后核。
///
/// **不是常驻轮询**(V8 纪律):唤醒这条链的是激活事件,一趟下了结论就停;没有人切应用时一次都不采。
/// 采样本身只读:不动任何窗口、不抢焦点。动窗口的只有第 4 条(挪开、藏、挪回),而且只动服务端预约过的那一家,
/// 从不激活任何应用(有的截图工具一失焦就收遮罩)。
final class ActivationWatch {
    private let ownBundleId: String
    private var tracker = ActivationTracker()
    /// 此刻藏着的进程(启动时从 NSWorkspace 抄一份,之后跟着 hide / unhide 通知走)。
    private var hiddenPids: Set<pid_t> = []
    /// 刚被放出来的时刻:unhide 通知可能比 didActivate 先到,那一刻它已经不在 hiddenPids 里了。
    private var unhiddenAt: [pid_t: TimeInterval] = [:]
    /// 上一个在前面的应用(给结论里的 `previous`)。
    private var lastActive: String?
    private var pending: DispatchWorkItem?
    /// 「遮罩一收就藏回去」的预约与挪开 / 挪回(服务端给的预约)。
    private var arms = RehideArms()
    /// 遮罩开着时,下一次整看最晚在什么时候(其余那几拍只问遮罩还在不在)。
    private var nextFullLookAt: TimeInterval = 0
    /// 在看的那几趟的时间线(按 bundle id)。
    private var timelines: [String: ActivationTimeline] = [:]
    /// 壳当场藏了、等藏好(didHide)与挪回之后再报的那一条(按 bundle id)。
    private var deferred: [String: DeferredReport] = [:]
    /// 挪走了却没挪回来的窗(它不肯藏 / 藏着时 AX 读不到它的窗):下次它被叫到前面、或服务端要露出它时再挪回。
    private var stillParked: [String: [ParkedWindow]] = [:]
    /// 服务端最近一次要露出某一家(unhide_app / raise_window)的时刻。
    private var recentlyShown: [String: TimeInterval] = [:]
    /// 挪开 / 挪回走这条队列(AX 要等对方回话,对方这会儿正开着截图,不能卡主线程)。
    private let parkQueue = DispatchQueue(label: "ai.ben.workbench.park", qos: .userInitiated)

    private struct DeferredReport {
        var payload: [String: Any]
        var timeline: ActivationTimeline
    }

    /// 发给服务端的那一条(结论 / 遮罩开了),主线程回调。
    var onReport: (([String: Any]) -> Void)?
    /// 遮罩一收、服务端预约过:当场把这一家藏回去(主线程回调;AppDelegate 接到 WindowControl.hide)。
    var onRehide: ((String) -> Void)?
    /// 遮罩底下把这几扇窗挪到屏外(**不在主线程上调**;AppDelegate 接到 WindowControl.park)。
    var park: ((String, [CGRect], [CGRect]) -> (parked: [ParkedWindow], error: String?))?
    /// 藏好之后挪回原位(**不在主线程上调**;AppDelegate 接到 WindowControl.unpark)。回没挪回来的那几扇。
    var unpark: ((String, [ParkedWindow]) -> (missed: [ParkedWindow], error: String?))?
    /// 这一家的 AX 通道是不是已知不通(WindowControl.axDead):不通就不问子角色,只看 CG,也不白等 AX 的时限。
    var axUnavailable: (String) -> Bool = { _ in false }

    /// AX 问子角色的时限。比切换窗口那条(1 秒)短得多:这是在主线程上顺手问一句,问不到就只看 CG。
    private static let axTimeout: Float = 0.25
    /// 被叫出来之后隔多久开始看:马上(开头那几拍 10 毫秒一次,见 ActivationTracker.startPoll)。
    private static let firstLook: TimeInterval = 0.01
    /// unhide 通知与 didActivate 相隔多久以内,算「这一趟激活把它放出来的」。
    private static let unhideWindow: TimeInterval = 1.0
    /// 壳当场藏了之后,最多等多久「藏好 + 挪回」再报(不肯藏的,到点照报)。
    private static let reportWait: TimeInterval = 2.0
    /// 服务端刚要露出过它(这么久以内):挪走的窗当场挪回,不管它此刻藏没藏。
    private static let shownWindow: TimeInterval = 5.0

    init(ownBundleId: String) {
        self.ownBundleId = ownBundleId
        hiddenPids = Set(NSWorkspace.shared.runningApplications.filter { $0.isHidden }.map { $0.processIdentifier })
        lastActive = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(self, selector: #selector(didHide(_:)), name: NSWorkspace.didHideApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(didUnhide(_:)), name: NSWorkspace.didUnhideApplicationNotification, object: nil)
    }

    deinit {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// 开机以来的秒数 → 墙钟(时间线报的是墙钟,统筹拿它对服务端的 ts)。
    private func wall(_ uptime: TimeInterval) -> Date { Date(timeIntervalSinceNow: uptime - now) }

    @objc private func didHide(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        hiddenPids.insert(app.processIdentifier)
        guard let bundleId = app.bundleIdentifier, !bundleId.isEmpty else { return }
        mark(bundleId, "hidden", at: now)
        // 壳当场藏的那一家藏好了:挪走的窗挪回原位(藏着挪,人看不见);还在挪的,等挪完再挪回;没挪过的,这就报。
        let back = arms.didHide(bundleId)
        if !back.isEmpty {
            restore(bundleId, back)
        }
        else if !arms.pending(bundleId) {
            flush(bundleId)
        }
    }

    @objc private func didUnhide(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        let at = now
        hiddenPids.remove(app.processIdentifier)
        unhiddenAt[app.processIdentifier] = at
        // 被放出来却不一定被激活(企业微信截图):也开一趟看它有没有盖遮罩。工作台自己、认不出是谁的不管。
        guard let bundleId = app.bundleIdentifier, !bundleId.isEmpty, bundleId != ownBundleId else { return }
        beginTimeline(bundleId, pid: app.processIdentifier, at: at)
        mark(bundleId, "unhide", at: at)
        emit(tracker.unhidden(bundleId: bundleId, pid: app.processIdentifier, at: at))
        schedule(after: Self.firstLook)
    }

    /// AppDelegate 转来的 didActivate。
    func handleActivated(_ app: NSRunningApplication) {
        let at = now
        let pid = app.processIdentifier
        let bundleId = app.bundleIdentifier ?? ""
        let previous = lastActive
        lastActive = bundleId.isEmpty ? lastActive : bundleId
        // 工作台自己被点到前面(或者认不出是谁):在看的那一趟按「焦点走了」收。
        if bundleId.isEmpty || bundleId == ownBundleId {
            emit(tracker.focusLeft(at: at))
            // 只被放出来的那几趟(企业微信截图)还要接着看:只有一趟都不剩了才停下采样。
            if tracker.episodes.isEmpty {
                pending?.cancel()
                pending = nil
            }
            return
        }
        // 他把它叫到前面了:上回挪走没挪回来的窗,这就挪回来(不然他看见的是一块空)。
        if let windows = stillParked.removeValue(forKey: bundleId) { runUnpark(bundleId, windows) }
        let wasHidden = hiddenPids.contains(pid) || unhiddenAt[pid].map { at - $0 <= Self.unhideWindow } == true
        beginTimeline(bundleId, pid: pid, at: at)
        mark(bundleId, "activate", at: at)
        emit(tracker.activated(bundleId: bundleId, pid: pid, at: at, wasHidden: wasHidden, previous: previous))
        schedule(after: Self.firstLook)
    }

    private func schedule(after delay: TimeInterval, _ action: (() -> Void)? = nil) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if let action { action() } else { self.look() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func look() {
        pending = nil
        let at = now
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let displays = Self.displayFrames()
        for episode in tracker.episodes.values {
            // 开头那几拍(还没看到遮罩)只看 CG,不问 AX:对方这会儿正忙着开截图,问一句能卡主线程 0.25 秒。
            let starting = at - episode.startedAt < ActivationTracker.startWatch && episode.overlay == nil
            // 被激活的那一趟焦点已经走了:不用再取窗(tracker 会按「焦点走了」收);只被放出来的照常看它的窗。
            let kind: FrontKind = episode.activated && front != episode.pid
                ? .none
                : frontKind(pid: episode.pid, bundleId: episode.bundleId, displays: displays, askAX: !starting)
            noteSample(episode, kind: kind, at: at)
            emit(tracker.sample(pid: episode.pid, at: at, frontmostPid: front, kind: kind), displays: displays)
        }
        guard let delay = tracker.nextDelay(at: at) else { return }
        if tracker.showingOverlays.isEmpty {
            schedule(after: delay)
            return
        }
        // 遮罩开着:平常那一拍照旧整看,中间每 overlayPoll 只问一句遮罩还在不在。
        nextFullLookAt = at + delay
        schedule(after: ActivationTracker.overlayPoll) { [weak self] in self?.overlayCheck() }
    }

    /// 遮罩开着时的轻量一问:那几扇遮罩还在不在屏上。有一扇不在了(截完 / 取消了)→ 当场整看、当场下结论。
    private func overlayCheck() {
        pending = nil
        let gone = tracker.showingOverlays.values.contains { !Self.windowOnScreen($0) }
        if gone || now >= nextFullLookAt {
            look()
            return
        }
        schedule(after: ActivationTracker.overlayPoll) { [weak self] in self?.overlayCheck() }
    }

    private func emit(_ verdicts: [ActivationTracker.Verdict], displays: [CGRect]? = nil) {
        let at = now
        for verdict in verdicts {
            let bundleId = verdict.bundleId
            var timeline = timelines.removeValue(forKey: bundleId) ?? ActivationTimeline(startedAt: at)
            if case .transient(_, _, _, let reason, _, _, _, let revealed) = verdict, reason == .overlay {
                timeline.mark("overlay_off", at: at)
                // 遮罩收起那一拍,它最前面那扇普通窗口在屏上露着多少(像素²):挪开了是 0~1,没挪开是整扇窗。
                if let revealed {
                    let area = ActivationSense.exposedArea(revealed.frame, displays: displays ?? Self.displayFrames())
                    timeline.count("revealed_px", Int(area.rounded()))
                }
            }
            let rehide = arms.take(verdict)
            let payload = verdict.payload(rehidden: rehide)
            if rehide {
                // 服务端预约过「遮罩一收就藏回去」:当场藏;藏好(didHide)、挪回之后带着整条时间线再报。
                timeline.mark("rehide", at: at)
                deferred[bundleId] = DeferredReport(payload: payload, timeline: timeline)
                onRehide?(bundleId)
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.reportWait) { [weak self] in self?.flush(bundleId, timedOut: true) }
                continue
            }
            report(payload, timeline)
        }
        // 一趟结束了、还只是预约(它自己又藏回去了 / 看太久不看了):预约作废,挪走的窗挪回。
        for (bundleId, windows) in arms.keep(only: Set(tracker.episodes.values.map { $0.bundleId })) {
            restore(bundleId, windows)
        }
        for opened in tracker.takeOpenedOverlays() {
            var payload = opened.payload()
            if let timeline = timelines[opened.bundleId] { payload["timeline"] = timeline.payload(startedAtWall: wall(timeline.startedAt)) }
            onReport?(payload)
        }
        // 没结论就结束的那几趟,时间线不留。
        let active = Set(tracker.episodes.values.map { $0.bundleId })
        timelines = timelines.filter { active.contains($0.key) }
    }

    private func report(_ payload: [String: Any], _ timeline: ActivationTimeline) {
        var out = payload
        out["timeline"] = timeline.payload(startedAtWall: wall(timeline.startedAt))
        onReport?(out)
    }

    /// 壳当场藏了的那一条:藏好、挪回之后(或者等到点了)带着整条时间线报出去。
    private func flush(_ bundleId: String, timedOut: Bool = false) {
        guard var entry = deferred.removeValue(forKey: bundleId) else { return }
        if timedOut, arms.pending(bundleId) {
            // 等了 2 秒还没藏好(它不肯藏):不再等,挪走的窗也**不当场挪回**(它还露着,挪回来就又盖在窗位上了)——
            // 记着,等它下次被叫到前面 / 服务端要露出它时再挪回。
            entry.timeline.note("wait_note", "等了 2 秒还没藏好,挪走的窗先不挪回")
            let windows = arms.forget(bundleId)
            if !windows.isEmpty { stillParked[bundleId, default: []] += windows }
        }
        report(entry.payload, entry.timeline)
    }

    // MARK: - 时间线

    private func beginTimeline(_ bundleId: String, pid: pid_t, at: TimeInterval) {
        // 同一家已经在看(先被放出来、这会儿才激活):接着那一条;新的一趟另起一条。
        if tracker.episodes[pid] == nil || timelines[bundleId] == nil {
            var timeline = ActivationTimeline(startedAt: at)
            timeline.count("start_poll_ms", Int((ActivationTracker.startPoll * 1000).rounded()))
            timelines[bundleId] = timeline
        }
    }

    /// 记一样的时刻:还在看的那一趟记在它的时间线上,已经下了结论、在等藏好 / 挪回的记在待报的那一条上。
    private func mark(_ bundleId: String, _ name: String, at: TimeInterval) {
        if timelines[bundleId] != nil { timelines[bundleId]?.mark(name, at: at) }
        else if deferred[bundleId] != nil { deferred[bundleId]?.timeline.mark(name, at: at) }
    }

    private func count(_ bundleId: String, _ name: String, _ value: Int) {
        if timelines[bundleId] != nil { timelines[bundleId]?.count(name, value) }
        else if deferred[bundleId] != nil { deferred[bundleId]?.timeline.count(name, value) }
    }

    private func note(_ bundleId: String, _ name: String, _ text: String) {
        if timelines[bundleId] != nil { timelines[bundleId]?.note(name, text) }
        else if deferred[bundleId] != nil { deferred[bundleId]?.timeline.note(name, text) }
    }

    private func noteSample(_ episode: ActivationTracker.Episode, kind: FrontKind, at: TimeInterval) {
        guard timelines[episode.bundleId] != nil else { return }
        timelines[episode.bundleId]?.mark("first_look", at: at)
        switch kind {
        case .overlay:
            timelines[episode.bundleId]?.mark("overlay_on", at: at)
        case .ordinary:
            // 遮罩盖上之前就看到它的普通窗口露着 = 开头那一下闪了(掀出来到遮罩盖上之间)。
            if episode.overlay == nil { timelines[episode.bundleId]?.mark("ordinary_before_overlay", at: at) }
        case .none:
            break
        }
    }

    // MARK: - 「遮罩一收就藏回去」的预约(服务端经 HelperSocket 发来)

    /// 服务端预约:这一家的遮罩一收就藏回去。只在它此刻确实开着遮罩时才收(回 false = 没收,服务端照老路走)。
    /// 收下就**马上在遮罩底下把它的普通窗口挪开**:遮罩收起那一刻露出来的是他原来的页面。
    func arm(_ bundleId: String) -> Bool {
        guard let episode = tracker.episodes.values.first(where: { $0.overlayShowing && ActivationSense.related($0.bundleId, bundleId) }),
              arms.arm(bundleId, overlayShowing: true) else { return false }
        mark(episode.bundleId, "armed", at: now)
        if arms.beginPark(bundleId) {
            let displays = Self.displayFrames()
            let frames = ActivationSense.windowsToPark(Self.screenWindows(pid: episode.pid), displays: displays).map { $0.frame }
            startPark(bundleId, frames: frames, displays: displays, timelineKey: episode.bundleId)
        }
        return true
    }

    /// 服务端自己要露出它(unhide / raise:点标签切过去、摆回窗位):预约作废,挪走的窗当场挪回。
    func cancelRehide(_ bundleId: String) {
        recentlyShown[bundleId] = now
        for (bundle, windows) in arms.cancel(bundleId) { restore(bundle, windows) }
        if let windows = stillParked.removeValue(forKey: bundleId) { runUnpark(bundleId, windows) }
    }

    private func startPark(_ bundleId: String, frames: [CGRect], displays: [CGRect], timelineKey: String) {
        guard let park, !frames.isEmpty else {
            note(timelineKey, "park_error", frames.isEmpty ? "没有要挪开的普通窗口" : "壳没接挪窗")
            let back = arms.didPark(bundleId, [])
            if !back.isEmpty { restore(bundleId, back) }
            return
        }
        parkQueue.async { [weak self] in
            let result = park(bundleId, frames, displays)
            DispatchQueue.main.async {
                guard let self else { return }
                self.mark(timelineKey, "parked", at: self.now)
                self.count(timelineKey, "parked", result.parked.count)
                if let error = result.error { self.note(timelineKey, "park_error", error) }
                // 挪完的时候:已经藏好了 / 这一条已经作废了 → 当场挪回。
                let back = self.arms.didPark(bundleId, result.parked)
                if !back.isEmpty { self.restore(bundleId, back) }
            }
        }
    }

    /// 挪走的窗要回来了:它藏着(藏着挪,人看不见)或服务端刚要露出它 → 当场挪回;它还露着(不肯藏)→ 先不挪,
    /// 挪回来就又盖在窗位上了,等它下次被叫到前面 / 服务端要露出它时再挪。
    private func restore(_ bundleId: String, _ windows: [ParkedWindow]) {
        guard !windows.isEmpty else { return }
        let hidden = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?.isHidden ?? true
        let shown = recentlyShown[bundleId].map { now - $0 < Self.shownWindow } ?? false
        if hidden || shown {
            runUnpark(bundleId, windows)
        }
        else {
            stillParked[bundleId, default: []] += windows
            note(bundleId, "unpark_error", "它还露着,先不挪回")
            flush(bundleId)
        }
    }

    private func runUnpark(_ bundleId: String, _ windows: [ParkedWindow]) {
        guard let unpark else { flush(bundleId); return }
        parkQueue.async { [weak self] in
            let result = unpark(bundleId, windows)
            DispatchQueue.main.async {
                guard let self else { return }
                self.mark(bundleId, "unparked", at: self.now)
                self.count(bundleId, "unparked", windows.count - result.missed.count)
                if let error = result.error { self.note(bundleId, "unpark_error", error) }
                if !result.missed.isEmpty { self.stillParked[bundleId, default: []] += result.missed }
                self.flush(bundleId)
            }
        }
    }

    // MARK: - 取样(只读)

    /// 这一家在屏上的窗(前后序)+ 各块屏的矩形 + (AX 通的话)它当前那扇窗的子角色。
    private func frontKind(pid: pid_t, bundleId: String, displays: [CGRect], askAX: Bool) -> FrontKind {
        let windows = Self.screenWindows(pid: pid)
        var subrole: String?
        // 只在普通层的窗上问 AX:层级高的已经是遮罩了,不用再问;AX 已知不通的不问(省那 0.25 秒)。
        if askAX,
           let first = windows.first(where: { $0.layer >= 0 && $0.frame.width >= ActivationSense.minSide && $0.frame.height >= ActivationSense.minSide }),
           first.layer == 0, !axUnavailable(bundleId) {
            subrole = Self.focusedSubrole(pid: pid, matching: first.frame)
        }
        return ActivationSense.classify(windows: windows, displays: displays, focusedSubrole: subrole)
    }

    static func screenWindows(pid: pid_t) -> [ActivationWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return list.compactMap { entry -> ActivationWindow? in
            guard (entry[kCGWindowOwnerPID as String] as? Int) == Int(pid),
                  let number = entry[kCGWindowNumber as String] as? Int,
                  let bounds = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            let layer = entry[kCGWindowLayer as String] as? Int ?? 0
            let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1
            return ActivationWindow(number: number, layer: layer, frame: rect, alpha: alpha)
        }
    }

    /// 这扇窗此刻还在不在屏上(只问这一扇,比整张窗口表便宜得多)。问不到(窗已经没了)= 不在。
    ///
    /// 窗号要**原样**放进 CFArray(值就是窗号、不带回调):`[指针] as CFArray` 会被 Swift 装箱成对象,
    /// CGWindowListCreateDescriptionFromArray 就什么都查不到(本机实测:装箱的查不到,CFArrayCreate 的查得到)。
    static func windowOnScreen(_ number: Int) -> Bool {
        guard number > 0 else { return false }
        var values: [UnsafeRawPointer?] = [UnsafeRawPointer(bitPattern: UInt(number))]
        let ids = values.withUnsafeMutableBufferPointer { buffer in
            CFArrayCreate(kCFAllocatorDefault, buffer.baseAddress, buffer.count, nil)
        }
        guard let ids,
              let list = CGWindowListCreateDescriptionFromArray(ids) as? [[String: Any]],
              let entry = list.first else { return false }
        return entry[kCGWindowIsOnscreen as String] as? Bool ?? false
    }

    /// 各块屏的矩形,与 CGWindowList 同一套全局坐标(主屏左上原点、y 向下)。
    static func displayFrames() -> [CGRect] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    }

    /// AX 读它当前那扇窗的子角色 —— 只在那扇窗的位置对得上 CG 最前面那扇时才算数(对不上就当没读到)。
    static func focusedSubrole(pid: pid_t, matching frame: CGRect) -> String? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, axTimeout)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let value = focused, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let window = value as! AXUIElement
        AXUIElementSetMessagingTimeout(window, axTimeout)
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posValue = posRef, let sizeValue = sizeRef else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posValue as! AXValue, .cgPoint, &pos), AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        let axFrame = CGRect(origin: pos, size: size)
        guard abs(axFrame.minX - frame.minX) <= 4, abs(axFrame.minY - frame.minY) <= 4,
              abs(axFrame.width - frame.width) <= 4, abs(axFrame.height - frame.height) <= 4 else { return nil }
        var subrole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXSubroleAttribute as CFString, &subrole) == .success else { return nil }
        return subrole as? String
    }
}

private func activationRect(_ window: ActivationWindow?) -> [String: Any]? {
    guard let window else { return nil }
    return ["layer": window.layer,
            "x": Int(window.frame.origin.x.rounded()), "y": Int(window.frame.origin.y.rounded()),
            "w": Int(window.frame.width.rounded()), "h": Int(window.frame.height.rounded())]
}

extension ActivationTracker.OverlayOpened {
    /// 「遮罩开了」(`verdict: "overlay"`,还不是结论):服务端据此决定要不要预约「遮罩一收就藏回去」。旧服务端不认这个结论,原样忽略。
    func payload() -> [String: Any] {
        var out: [String: Any] = ["kind": "activation", "bundle_id": bundleId, "verdict": "overlay", "reason": "overlay",
                                  "was_hidden": wasHidden, "dwell_ms": 0]
        if let previous { out["prev_bundle_id"] = previous }
        if var overlayRect = activationRect(overlay) {
            overlayRect["why"] = overlayReason
            out["overlay"] = overlayRect
        }
        return out
    }
}

extension ActivationTracker.Verdict {
    /// 发给服务端的那一条(`{kind:"activation", …}`)。只有 bundle id、结论、几个几何数字 —— 没有窗口标题、没有内容。
    /// `rehidden`:壳已经按服务端的预约当场藏回去了(服务端不用再发 hide_app)。
    func payload(rehidden: Bool = false) -> [String: Any] {
        let rect = activationRect
        switch self {
        case .switched(let bundleId, let wasHidden, let previous, let dwellMs, let window):
            var out: [String: Any] = ["kind": "activation", "bundle_id": bundleId, "verdict": "switch",
                                      "was_hidden": wasHidden, "dwell_ms": dwellMs]
            if let previous { out["prev_bundle_id"] = previous }
            if let front = rect(window) { out["front"] = front }
            return out
        case .transient(let bundleId, let wasHidden, let previous, let reason, let dwellMs, let overlay, let overlayReason, let front):
            var out: [String: Any] = ["kind": "activation", "bundle_id": bundleId, "verdict": "transient",
                                      "reason": reason.rawValue, "was_hidden": wasHidden, "dwell_ms": dwellMs]
            if let previous { out["prev_bundle_id"] = previous }
            if var overlayRect = rect(overlay) {
                if let overlayReason { overlayRect["why"] = overlayReason }
                out["overlay"] = overlayRect
            }
            if let frontRect = rect(front) { out["front"] = frontRect }
            if rehidden { out["rehidden"] = true }
            return out
        }
    }
}
