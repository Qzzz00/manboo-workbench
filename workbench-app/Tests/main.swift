import CoreGraphics
import Foundation

/// WindowPlacement 的断言脚本。壳是 `swiftc` 直编的一堆 .swift(没有 SwiftPM 工程,
/// 也就没有 `swift test`),所以测试就是一个可执行文件:`./run-tests.sh` 会把
/// Sources/WindowPlacement.swift 和这个文件编到一起跑,全绿退出码 0,红了打印并退 1。
///
/// 只测纯逻辑——选屏顺序、记忆的读写与失效、收边。AppKit 那半截(NSScreen/NSWindow、
/// 拖动通知)不在这里,造不出来也不值得造。

var failures: [String] = []
var checks = 0

func expect(_ condition: Bool, _ what: String, file: StaticString = #file, line: UInt = #line) {
    checks += 1
    if !condition { failures.append("\(what)  (\(file):\(line))") }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ what: String,
                               file: StaticString = #file, line: UInt = #line) {
    checks += 1
    if actual != expected {
        failures.append("\(what)\n      期望 \(expected)\n      实得 \(actual)  (\(file):\(line))")
    }
}

// Ben 的两块屏:横屏当主屏(原点在 0,0),竖屏排在它右边。
let landscape = ScreenSnapshot(name: "LG HDR QHD",
                               frame: CGRect(x: 0, y: 0, width: 2560, height: 1440),
                               visibleFrame: CGRect(x: 0, y: 0, width: 2560, height: 1415),
                               displayID: 1)
let portrait = ScreenSnapshot(name: "DELL UP2716D",
                              frame: CGRect(x: 2560, y: 0, width: 1440, height: 2560),
                              visibleFrame: CGRect(x: 2560, y: 0, width: 1440, height: 2535),
                              displayID: 2)
let screens = [landscape, portrait]

// MARK: - 记忆键

expectEqual(landscape.key, "LG HDR QHD@2560x1440", "记忆键 = 名字@分辨率")
expectEqual(portrait.key, "DELL UP2716D@1440x2560", "竖屏的键带的是竖着的分辨率")
expect(landscape.key != portrait.key, "两块屏的键不能撞")
expectEqual(WindowPlacement.screenKey(name: "  ", size: CGSize(width: 800, height: 600), displayID: 7),
            "display-7@800x600", "拿不到显示器名(虚拟屏)时退回 displayID")
// 同型号同分辨率会共用一份记忆:这是已知取舍,写成用例免得以后当成 bug 改掉。
expectEqual(WindowPlacement.screenKey(name: "LG HDR QHD", size: CGSize(width: 2560, height: 1440), displayID: 9),
            landscape.key, "同名同分辨率的第二块屏共用同一份记忆(已知取舍)")

// MARK: - 选屏顺序:hint > 上次 > 鼠标 > 主屏

let pickedByHint = WindowPlacement.chooseScreen(screens: screens, hint: "up2716",
                                                lastScreenKey: landscape.key,
                                                mouse: CGPoint(x: 100, y: 100),
                                                mainScreenKey: landscape.key)
expectEqual(pickedByHint?.screen, portrait, "配了 screen_hint 就听它(压过上次和鼠标)")
expectEqual(pickedByHint?.reason, .hint, "落屏理由是 hint")

let pickedByLast = WindowPlacement.chooseScreen(screens: screens, hint: nil,
                                                lastScreenKey: portrait.key,
                                                mouse: CGPoint(x: 100, y: 100),
                                                mainScreenKey: landscape.key)
expectEqual(pickedByLast?.screen, portrait, "没有 hint 时上次待过的屏压过鼠标所在的屏")
expectEqual(pickedByLast?.reason, .remembered, "落屏理由是 remembered")

// 2026-09-23:没记忆时鼠标在竖屏上 → 不跟鼠标,落横屏的主屏(登录/引导整屏不铺到竖屏上)
let pickedAvoidPortrait = WindowPlacement.chooseScreen(screens: screens, hint: nil,
                                                       lastScreenKey: nil,
                                                       mouse: CGPoint(x: 3000, y: 300),
                                                       mainScreenKey: landscape.key)
expectEqual(pickedAvoidPortrait?.screen, landscape, "没记忆、鼠标在竖屏上:落横屏主屏,不铺到竖屏")
expectEqual(pickedAvoidPortrait?.reason, .main, "落屏理由是 main")

// 真机那块竖屏:829×1456(缩放后的点数),在主屏左边
let dellScaled = ScreenSnapshot(name: "DELL UP2716D",
                                frame: CGRect(x: -829, y: 0, width: 829, height: 1456),
                                visibleFrame: CGRect(x: -829, y: 0, width: 829, height: 1431),
                                displayID: 3)
let pickedReal = WindowPlacement.chooseScreen(screens: [landscape, dellScaled], hint: nil,
                                              lastScreenKey: nil,
                                              mouse: CGPoint(x: -400, y: 700),
                                              mainScreenKey: landscape.key)
expectEqual(pickedReal?.screen, landscape, "真机布局:鼠标在 829×1456 竖屏上也落横屏")

// 主屏(菜单栏那块)是竖屏、另有一块横屏:没记忆时仍挑横屏
let pickedLandscapeNotMain = WindowPlacement.chooseScreen(screens: [portrait, landscape], hint: nil,
                                                          lastScreenKey: nil, mouse: nil,
                                                          mainScreenKey: portrait.key)
expectEqual(pickedLandscapeNotMain?.screen, landscape, "主屏是竖屏时挑第一块横屏")
expectEqual(pickedLandscapeNotMain?.reason, .landscape, "落屏理由是 landscape")

// 两块横屏:鼠标在哪块就是哪块(2026-09-18 那条照旧)
let secondLandscape = ScreenSnapshot(name: "Studio Display",
                                     frame: CGRect(x: 4000, y: 0, width: 2560, height: 1440),
                                     visibleFrame: CGRect(x: 4000, y: 0, width: 2560, height: 1415),
                                     displayID: 4)
let pickedByMouse = WindowPlacement.chooseScreen(screens: [landscape, portrait, secondLandscape], hint: nil,
                                                 lastScreenKey: nil,
                                                 mouse: CGPoint(x: 5000, y: 300),
                                                 mainScreenKey: landscape.key)
expectEqual(pickedByMouse?.screen, secondLandscape, "没记忆时落在鼠标所在的那块横屏")
expectEqual(pickedByMouse?.reason, .mouse, "落屏理由是 mouse")

// 一块横屏都没有:退回鼠标所在的屏
let allPortrait = WindowPlacement.chooseScreen(screens: [portrait, dellScaled], hint: nil,
                                               lastScreenKey: nil,
                                               mouse: CGPoint(x: -400, y: 700),
                                               mainScreenKey: portrait.key)
expectEqual(allPortrait?.screen, dellScaled, "全是竖屏:还是跟鼠标")
expectEqual(allPortrait?.reason, .mouse, "落屏理由是 mouse")

// 有记忆(他自己拖到竖屏上的)照样回竖屏
expectEqual(WindowPlacement.chooseScreen(screens: screens, hint: nil, lastScreenKey: portrait.key,
                                         mouse: nil, mainScreenKey: landscape.key)?.screen,
            portrait, "记忆里是竖屏就回竖屏,那是他自己选的")

let pickedByMain = WindowPlacement.chooseScreen(screens: screens, hint: nil,
                                                lastScreenKey: nil, mouse: nil,
                                                mainScreenKey: landscape.key)
expectEqual(pickedByMain?.screen, landscape, "鼠标也问不到就落主屏")
expectEqual(pickedByMain?.reason, .main, "落屏理由是 main")

// 记忆失效:上次那块屏被拔掉了 → 不能认这条记忆,往下顺延到鼠标
let unplugged = WindowPlacement.chooseScreen(screens: [landscape], hint: nil,
                                             lastScreenKey: portrait.key,
                                             mouse: CGPoint(x: 10, y: 10),
                                             mainScreenKey: landscape.key)
expectEqual(unplugged?.screen, landscape, "上次那块屏不在了,记忆作废,顺延到鼠标所在的屏")
expectEqual(unplugged?.reason, .mouse, "作废后的落屏理由是 mouse")

// hint 配了但没有一块屏叫这个名字 → 不是死路,继续往下顺延
let staleHint = WindowPlacement.chooseScreen(screens: screens, hint: "某台已经卖掉的屏",
                                             lastScreenKey: nil,
                                             mouse: CGPoint(x: 10, y: 10),
                                             mainScreenKey: landscape.key)
expectEqual(staleHint?.reason, .mouse, "hint 匹配不到任何屏时顺延,不是报错也不是空窗")
expectEqual(WindowPlacement.chooseScreen(screens: [], hint: nil, lastScreenKey: nil,
                                         mouse: nil, mainScreenKey: nil)?.screen,
            nil, "一块屏都没有时返回 nil,由调用方兜底")
expectEqual(WindowPlacement.chooseScreen(screens: screens, hint: "   ", lastScreenKey: nil,
                                         mouse: nil, mainScreenKey: landscape.key)?.reason,
            .main, "screen_hint 是空白串等于没配")

// MARK: - 首次铺满 / 之后还原

expectEqual(WindowPlacement.frame(for: landscape, remembered: nil), landscape.visibleFrame,
            "第一次在这块屏上出现:铺满 visibleFrame(不是 frame,别盖住菜单栏)")

let small = RememberedFrame(dx: 120, dy: 80, width: 1200, height: 800)
expectEqual(WindowPlacement.frame(for: landscape, remembered: small),
            CGRect(x: 120, y: 80, width: 1200, height: 800),
            "有记忆就还原:偏移是相对这块屏 visibleFrame 原点的")
expectEqual(WindowPlacement.frame(for: portrait, remembered: small),
            CGRect(x: 2680, y: 80, width: 1200, height: 800),
            "同一份偏移放到另一块屏上,还原到那块屏自己的坐标里(所以显示器换排列不会飞走)")

// 记忆比这块屏还大(降了分辨率 / 换了机器):收进可视区,不许超出
let huge = RememberedFrame(dx: -500, dy: -500, width: 9999, height: 9999)
expectEqual(WindowPlacement.frame(for: landscape, remembered: huge), landscape.visibleFrame,
            "记忆比屏还大:夹成整块可视区,不超出不裁切")

// 记忆整个落在屏外(显示器排列改过):拽回可视区里
let offscreen = RememberedFrame(dx: 4000, dy: 3000, width: 800, height: 600)
let pulledBack = WindowPlacement.frame(for: landscape, remembered: offscreen)
expect(landscape.visibleFrame.contains(pulledBack), "跑到屏外的记忆要被拽回可视区")
expectEqual(pulledBack, CGRect(x: 1760, y: 815, width: 800, height: 600), "拽回时贴右上角,尺寸不变")

// MARK: - 收边(不超出、不裁切)

expectEqual(WindowPlacement.fit(CGRect(x: -100, y: -100, width: 800, height: 600),
                                into: landscape.visibleFrame),
            CGRect(x: 0, y: 0, width: 800, height: 600), "左下越界:贴回左下角")
expectEqual(WindowPlacement.fit(CGRect(x: 0, y: 0, width: 200, height: 100),
                                into: landscape.visibleFrame),
            CGRect(x: 0, y: 0, width: WindowPlacement.minWidth, height: WindowPlacement.minHeight),
            "小于最小窗口:撑到最小值")
let tiny = CGRect(x: 0, y: 0, width: 300, height: 200)
expectEqual(WindowPlacement.fit(CGRect(x: 0, y: 0, width: 800, height: 600), into: tiny), tiny,
            "可视区本身比最小窗口还小(极小的虚拟屏):以可视区为准,不硬撑出屏")

// MARK: - 拖完落在哪块屏:看松手时鼠标在哪(2026-09-27,维护者「我想把工作台拖拽到另一个屏幕上,但是发现拖拽不过去」)
// 铺满 2560×1440 主屏的窗口往竖着的 1440×2560 那块拖:窗口大半还在主屏上,按「覆盖面积最大」永远判成主屏。
do {
    let mainScreen = ScreenSnapshot(name: "27N3F", frame: CGRect(x: 0, y: 0, width: 2560, height: 1440),
                                    visibleFrame: CGRect(x: 0, y: 0, width: 2560, height: 1440))
    let portrait = ScreenSnapshot(name: "DELL", frame: CGRect(x: 2560, y: -560, width: 1440, height: 2560),
                                  visibleFrame: CGRect(x: 2560, y: -560, width: 1440, height: 2530))
    let screens = [mainScreen, portrait]
    expectEqual(WindowPlacement.screenForDragEnd(pointer: CGPoint(x: 3000, y: 800), screens: screens, windowScreenKey: mainScreen.key)?.key,
                portrait.key, "松手时鼠标在竖屏上、窗口大半还在主屏:认鼠标那块屏")
    expect(WindowPlacement.screenForDragEnd(pointer: CGPoint(x: 1000, y: 800), screens: screens, windowScreenKey: mainScreen.key) == nil,
           "鼠标还在窗口原来那块屏上:不挪(常规拖动交给系统)")
    expect(WindowPlacement.screenForDragEnd(pointer: CGPoint(x: -500, y: -500), screens: screens, windowScreenKey: mainScreen.key) == nil,
           "鼠标不在任何一块屏上(理论上不会):不挪")
}

// MARK: - 顶栏「换屏」(2026-09-27)
do {
    let portrait = ScreenSnapshot(name: "DELL", frame: CGRect(x: 2560, y: -560, width: 1440, height: 2560),
                                  visibleFrame: CGRect(x: 2560, y: -560, width: 1440, height: 2560))
    expectEqual(WindowPlacement.frameForScreenSwitch(portrait), portrait.visibleFrame,
                "换屏落过去铺满那块屏的可视区,不按旧记忆(那份是菜单栏露着时记的,矮一条)")
}
expectEqual(ShellTitleBar.message(name: "benWorkbenchShell", body: ["type": "titlebar_move_screen"], isMainFrame: true),
            .moveScreen, "「换屏」那条消息认得")
do {
    let a = ScreenSnapshot(name: "A", frame: CGRect(x: 0, y: 0, width: 2560, height: 1440), visibleFrame: CGRect(x: 0, y: 0, width: 2560, height: 1440))
    let b = ScreenSnapshot(name: "B", frame: CGRect(x: 2560, y: 0, width: 1440, height: 2560), visibleFrame: CGRect(x: 2560, y: 0, width: 1440, height: 2530))
    expectEqual(WindowPlacement.nextScreen(after: a.key, in: [a, b])?.key, b.key, "换屏:从 A 到下一块 B")
    expectEqual(WindowPlacement.nextScreen(after: b.key, in: [a, b])?.key, a.key, "换屏:最后一块再点回到第一块")
    expect(WindowPlacement.nextScreen(after: a.key, in: [a]) == nil, "只有一块屏:什么都不做")
    expectEqual(WindowPlacement.nextScreen(after: "认不出", in: [a, b])?.key, a.key, "认不出现在在哪块:去第一块")
}

// MARK: - 拖到另一块屏

expectEqual(WindowPlacement.frameOnArrival(current: CGRect(x: 2600, y: 100, width: 1440, height: 2400),
                                           screen: landscape, remembered: nil),
            landscape.visibleFrame,
            "拖到一块**没来过**的屏:铺满它——Ben 的『拖到横屏没变成横屏的形状』就是这条")

let arrived = WindowPlacement.frameOnArrival(current: CGRect(x: 300, y: 200, width: 1440, height: 2400),
                                             screen: landscape, remembered: small)
expectEqual(arrived, CGRect(x: 300, y: 200, width: 1200, height: 800),
            "拖到一块**来过**的屏:还原那块屏记住的大小,位置留在他松手的地方")

let arrivedEdge = WindowPlacement.frameOnArrival(current: CGRect(x: 2400, y: 1300, width: 400, height: 300),
                                                 screen: landscape, remembered: small)
expect(landscape.visibleFrame.contains(arrivedEdge), "在屏幕边缘松手:还原后仍整个落在可视区内")

// MARK: - 记 / 读

let remembered = WindowPlacement.remember(frame: CGRect(x: 2680, y: 135, width: 1200, height: 900),
                                          on: portrait)
expectEqual(remembered, RememberedFrame(dx: 120, dy: 135, width: 1200, height: 900,
                                        visible: portrait.visibleFrame.size),
            "记的是相对该屏 visibleFrame 原点的偏移,不是全局坐标;2026-09-26 起**连当时的可视区多大一起记**")
expectEqual(remembered.filledWhenRemembered(tolerance: WindowPlacement.fillTolerance), false,
            "这一份当时没铺满(他自己拖小的),还原时就该原样还原")
expectEqual(WindowPlacement.frame(for: portrait, remembered: remembered),
            CGRect(x: 2680, y: 135, width: 1200, height: 900), "记完再读回来是同一块矩形")

// MARK: - app.json 里那一块的编解码

let store = WindowFrameStore(lastScreen: portrait.key,
                             frames: [portrait.key: remembered,
                                      landscape.key: RememberedFrame(dx: 0, dy: 0, width: 2560, height: 1415)])
let roundTripped = WindowFrameStore.decode(store.encoded)
expectEqual(roundTripped, store, "window_frames 编码再解码是同一份")

let encoded = store.encoded
expect(encoded["screens"] != nil && encoded["last_screen"] as? String == portrait.key,
       "编出来的形状是 { last_screen, screens }")

expectEqual(WindowFrameStore.decode(nil), WindowFrameStore(), "没有 window_frames 这个键:空记忆")
expectEqual(WindowFrameStore.decode("乱七八糟"), WindowFrameStore(), "类型完全不对:空记忆,不炸")
expectEqual(WindowFrameStore.decode(["screens": ["A@1x1": ["dx": 0, "dy": 0, "w": 20, "h": 20]]]),
            WindowFrameStore(), "小得没法用的记忆当脏数据丢掉(结果就是回到首次铺满)")
expectEqual(WindowFrameStore.decode(["screens": ["A@1x1": ["dx": 0, "dy": 0, "w": "宽", "h": 600]]]),
            WindowFrameStore(), "字段类型不对的那一条整条丢掉")
expectEqual(RememberedFrame.decode(["dx": Double.nan, "dy": 0, "w": 800, "h": 600]), nil,
            "NaN(某次算错过)一律作废,不还原一个算不出来的窗口")
expectEqual(RememberedFrame.decode(["dx": -300, "dy": -20, "w": 800, "h": 600]),
            RememberedFrame(dx: -300, dy: -20, width: 800, height: 600),
            "偏移为负是正常的(Dock 显隐会让 visibleFrame 变),读的时候再收边")

// 一条坏的不该带走好的那条
let mixed = WindowFrameStore.decode(["last_screen": portrait.key,
                                     "screens": ["A@1x1": ["dx": 0, "dy": 0, "w": 10, "h": 10],
                                                 portrait.key: remembered.encoded]])
expectEqual(mixed.frames.count, 1, "一条脏记忆不该连累同一份里好的那条")
expectEqual(mixed.frames[portrait.key], remembered, "好的那条原样读回")

// MARK: - 前台 / 桌面两档窗口模式(2026-09-18)

expectEqual(ShellWindowMode.front.levelOffset, 0, "前台档 = 普通应用层(normal + 0)")
expectEqual(ShellWindowMode.desktop.levelOffset, -1, "桌面档 = 降半级(normal - 1),原生窗天然排在前面")
expect(ShellWindowMode.front.shouldActivate, "切到前台档要 activate + 置前,光改 level 浮不上来")
expect(!ShellWindowMode.desktop.shouldActivate, "切回桌面档只改层级,不重排窗口(别搅乱贴好的原生窗)")
expectEqual(ShellWindowMode.parse("front"), ShellWindowMode.front, "front 认得出")
expectEqual(ShellWindowMode.parse("desktop"), ShellWindowMode.desktop, "desktop 认得出")
expectEqual(ShellWindowMode.parse("Front"), nil, "大小写不同不认(协议是字面量,不做模糊匹配)")
expectEqual(ShellWindowMode.parse("top"), nil, "不认识的档位一律 nil,壳不猜")
expectEqual(ShellWindowMode.parse(nil), nil, "mode 字段缺失 → nil")
expectEqual(ShellWindowMode.parse(1), nil, "mode 不是字符串 → nil")

// MARK: - CG 兜底拖拽判定(DragSense,2026-09-18 Claude/企微拖不进窗位)
//
// 背景与真机取证见 Sources/DragSense.swift 顶部:那两家对任何 AX 属性都回 -25211,
// 一条 kAXWindowMovedNotification 都不会来,只能靠鼠标事件 + CGWindowList 认这次拖拽。

/// 窗位槽在屏幕上的那块矩形(AX 全局坐标)。
let slotZone = CGRect(x: 200, y: 200, width: 600, height: 400)
/// AX 已经死掉的那两家 —— 兜底只对它们生效。
let deadApps: Set<String> = ["com.anthropic.claudefordesktop", "com.tencent.WeWorkMac"]
func dead(_ bundleId: String) -> Bool { deadApps.contains(bundleId) }

func win(_ bundleId: String, _ number: Int, _ rect: CGRect) -> ScreenWindow {
    ScreenWindow(bundleId: bundleId, windowNumber: number, frame: rect)
}

let claudeFar = win("com.anthropic.claudefordesktop", 101, CGRect(x: 1200, y: 700, width: 900, height: 600))
/// 中心 (500,400),落在 slotZone 里。
let claudeInSlot = win("com.anthropic.claudefordesktop", 101, CGRect(x: 350, y: 300, width: 300, height: 200))
let termWindow = win("com.apple.Terminal", 202, CGRect(x: 1200, y: 700, width: 900, height: 600))
/// 菜单条大小的幽灵窗(企业微信/ChatGPT 真机实测有这种东西混在窗口列表里)。
let ghostBar = win("com.tencent.WeWorkMac", 303, CGRect(x: 0, y: 0, width: 2560, height: 30))

// —— 光标底下那扇窗是谁 ——

expectEqual(DragTracker.windowUnder(CGPoint(x: 1500, y: 900), in: [claudeFar], eligible: dead)?.windowNumber,
            101, "点在窗里 → 认出这扇窗")
expectEqual(DragTracker.windowUnder(CGPoint(x: 10, y: 10), in: [claudeFar], eligible: dead),
            nil, "点在窗外 → 谁都不是")
expectEqual(DragTracker.windowUnder(CGPoint(x: 1500, y: 900), in: [termWindow], eligible: dead),
            nil, "★AX 还活着的应用(终端)不走兜底 —— 兜底的作用面只有 AX 死掉的那几家")
expectEqual(DragTracker.windowUnder(CGPoint(x: 100, y: 15), in: [ghostBar], eligible: dead),
            nil, "★菜单条大小的幽灵窗不当候选(CG 这条链没有 AXStandardWindow 可问,只能卡尺寸下限)")
expectEqual(DragTracker.windowUnder(CGPoint(x: 1500, y: 900), in: [termWindow, claudeFar], eligible: dead)?.windowNumber,
            101, "前后序里跳过不合格的,挑第一个合格的")

// —— 一次完整的拖拽:从槽外拖进槽里 ——

var tracker = DragTracker()
expectEqual(tracker.begin(at: CGPoint(x: 1500, y: 900), windows: [claudeFar], zone: slotZone, eligible: dead),
            [], "★按下这一刻不发 hover(hoverInside 从 false 起步,跟 AX 那条链同口径)")
expectEqual(tracker.tracked?.windowNumber, 101, "按下之后跟着这扇窗")
expectEqual(tracker.sample(windows: [claudeInSlot], zone: slotZone),
            [DragEvent.hover(true)], "★拖进圈那一刻发 hover(true) —— 这就是 Ben 说的「交互反馈」")
expectEqual(tracker.sample(windows: [claudeInSlot], zone: slotZone),
            [], "还在圈里没动 → 不重复发(只在翻转时说话,不是逐帧)")
expectEqual(tracker.end(windows: [claudeInSlot], zone: slotZone),
            [DragEvent.hover(false), DragEvent.settled(bundleId: "com.anthropic.claudefordesktop", frame: claudeInSlot.frame)],
            "★松手 = 落定:先灭高亮,再报一条落定给服务端")
expectEqual(tracker.tracked, nil, "松手之后不再跟着任何窗")

// —— 拖进去又拖出来 ——

tracker = DragTracker()
_ = tracker.begin(at: CGPoint(x: 1500, y: 900), windows: [claudeFar], zone: slotZone, eligible: dead)
expectEqual(tracker.sample(windows: [claudeInSlot], zone: slotZone), [DragEvent.hover(true)], "进圈")
expectEqual(tracker.sample(windows: [claudeFar], zone: slotZone), [DragEvent.hover(false)], "出圈")
expectEqual(tracker.end(windows: [claudeFar], zone: slotZone), [], "★在圈外松手 → 一条都不报(高亮早灭了,也没有落定)")

// —— 没有窗位矩形就不开工 ——

tracker = DragTracker()
_ = tracker.begin(at: CGPoint(x: 1500, y: 900), windows: [claudeFar], zone: nil, eligible: dead)
expectEqual(tracker.tracked, nil, "★圈不存在(窗位隐藏/还没上报矩形)→ 压根不跟踪,一次窗口列表都不读")

// —— 只点一下不算拖拽 ——

tracker = DragTracker()
_ = tracker.begin(at: CGPoint(x: 500, y: 400), windows: [claudeInSlot], zone: slotZone, eligible: dead)
expectEqual(tracker.sample(windows: [claudeInSlot], zone: slotZone), [DragEvent.hover(true)], "点在已经压着窗位的窗上,高亮照亮")
expectEqual(tracker.end(windows: [claudeInSlot], zone: slotZone), [DragEvent.hover(false)],
            "★窗根本没挪过 → 只灭高亮,不报落定:一次普通点击不该把这个应用认领进窗位")

// —— 拖到一半窗没了 ——

tracker = DragTracker()
_ = tracker.begin(at: CGPoint(x: 1500, y: 900), windows: [claudeFar], zone: slotZone, eligible: dead)
_ = tracker.sample(windows: [claudeInSlot], zone: slotZone)
expectEqual(tracker.sample(windows: [], zone: slotZone), [DragEvent.hover(false)],
            "★跟着的窗不见了(关掉/换桌面)→ 补一次灭灯,不留一个追不回来的高亮")
expectEqual(tracker.tracked, nil, "窗没了就不跟了")
expectEqual(tracker.end(windows: [], zone: slotZone), [], "已经不跟任何窗 → 松手什么都不报")

// —— 按窗号认人,不按位置 ——

let twinA = win("com.tencent.WeWorkMac", 401, CGRect(x: 350, y: 300, width: 300, height: 200))
let twinB = win("com.tencent.WeWorkMac", 402, CGRect(x: 350, y: 300, width: 300, height: 200))
expectEqual(DragTracker.follow(twinB, in: [twinA, twinB])?.windowNumber, 402,
            "★两扇窗 frame 逐字相等时,位置根本不构成身份 —— 靠 kCGWindowNumber 认人")

// MARK: - 壳自动重开(2026-09-21):这一趟是不是热更新换完壳之后拉起来的

let exe = "/Applications/工作台.app/Contents/MacOS/workbench"
expect(ShellRelaunch.isUpdateRelaunch(arguments: [exe, "--relaunched-by-update"]),
       "带了那个参数 = 更新拉起来的")
expect(!ShellRelaunch.isUpdateRelaunch(arguments: [exe]), "什么参数都没带 = 他自己点开的")
// 第 0 个是可执行文件路径,不是参数。
expect(!ShellRelaunch.isUpdateRelaunch(arguments: ["--relaunched-by-update"]),
       "★第 0 个是可执行文件路径,不当参数数")
expect(!ShellRelaunch.isUpdateRelaunch(arguments: [exe, "--relaunched-by-update=1"]),
       "★写法不是逐字相等就不认(宁可漏认,不误判)")
expect(!ShellRelaunch.isUpdateRelaunch(arguments: [exe, "--RELAUNCHED-BY-UPDATE"]),
       "★大小写不同也不认")

let auto = ShellRelaunch.startup(arguments: [exe, ShellRelaunch.flag])
let byHand = ShellRelaunch.startup(arguments: [exe])
expect(auto.activateOnLaunch, "被更新拉起来的:自己抬到最前面(不然他以为工作台更新完不见了)")
expect(!byHand.activateOnLaunch, "他自己点开的:系统本来就会放到前面,不再抄一遍")
// 辅助功能授权框:2026-09-23 起任何启动都不弹(只在他点「去授权」时弹),这里没有开关可测了。
// 「回到原窗口位置」没有第二套代码:两条路都走下面这一套记忆(上面那批用例测的就是它)。
expectEqual(WindowPlacement.frame(for: landscape, remembered: RememberedFrame(dx: 40, dy: 30, width: 1200, height: 800)),
            CGRect(x: 40, y: 30, width: 1200, height: 800),
            "★自动重开回到原位靠的就是这一份记忆(旧壳退出前同步落的盘),不是另一条还原路径")
expectEqual(ShellRelaunch.flag, "--relaunched-by-update",
            "★这串字与插件那侧 SHELL_RELAUNCH_FLAG 逐字相同(两边各有一条用例钉着)")


// MARK: - SendTextPolicy(派活第一段:把话送进客户端窗口,2026-09-21)

// 白名单:只有 Agent 客户端 + 一个不会把话发给任何人的验证靶子。
expect(SendTextPolicy.isAllowed("com.anthropic.claudefordesktop"), "Claude 桌面版可以送话")
expect(SendTextPolicy.isAllowed("com.openai.codex"), "ChatGPT/Codex 桌面版可以送话(同一个 app)")
expect(SendTextPolicy.isAllowed("com.moonshot.kimichat"), "Kimi 可以送话")
expect(SendTextPolicy.isAllowed("com.bot.pc.doubao"), "豆包可以送话")
expect(SendTextPolicy.isAllowed("com.meta.endo"), "Muse 可以送话(2026-09-24 卡 F 新加)")
expect(SendTextPolicy.isAllowed("im.manus.desktop"), "Manus 可以送话(2026-09-24 卡 F 新加)")
expect(SendTextPolicy.isAllowed("com.apple.TextEdit"), "TextEdit 在表里:端到端验证要一个按了回车也不发给任何人的靶子")
expect(!SendTextPolicy.isAllowed("com.tencent.xinWeChat"), "★微信永远不许送——往 IM 里打字按回车是以 Ben 的身份对真人说话")
expect(!SendTextPolicy.isAllowed("com.tencent.WeWorkMac"), "★企业微信永远不许送")
expect(!SendTextPolicy.isAllowed("com.apple.finder"), "白名单语义:表里没有就是不行,不是黑名单挡一挡")

// 卡 Z(2026-09-25):运行时新发现的一家 —— 服务端把「登记表里接上了的那几家」报过来(agent_allow),
// 壳这道门据此放行;报过的撤掉就不放行;永不送的那几家服务端说了也不算;别人照旧拒。
SendTextPolicy.setDeclaredAgents(["com.example.fooai", "com.tencent.xinWeChat"])
expect(SendTextPolicy.isAllowed("com.example.fooai"), "★登记表里接上了的一家:不改壳里那张表也送得进(卡 Z)")
expect(!SendTextPolicy.isAllowed("com.tencent.xinWeChat"), "★微信:服务端报它是 Agent 也不送")
expect(!SendTextPolicy.declaredAgents.contains("com.tencent.xinWeChat"), "永不送的那几家进不了服务端报的那一份")
expect(!SendTextPolicy.isAllowed("com.apple.finder"), "服务端没报的照旧拒(Finder)")
expect(SendTextPolicy.isAllowed("com.anthropic.claudefordesktop"), "壳里实测过的那几家不用服务端报也放行")
SendTextPolicy.setDeclaredAgents([])
expect(!SendTextPolicy.isAllowed("com.example.fooai"), "★他说「这不是 Agent」→ 服务端重报一份,壳当场不再放行")
expect(SendTextPolicy.isAllowed("com.anthropic.claudefordesktop"), "撤掉那一份不影响壳里实测过的那几家")
for banned in SendTextPolicy.neverBundleIds {
    expect(!SendTextPolicy.allowedBundleIds.contains(banned), "明着拒的那几家不许混进白名单:\(banned)")
}

// 找输入框。窗口是一扇 1200×800 的聊天窗,输入框在底部。
let chatWindow = CGRect(x: 100, y: 100, width: 1200, height: 800)
func candidate(_ role: String, _ frame: CGRect, settable: Bool = true, focused: Bool = false) -> SendTextPolicy.InputCandidate {
    SendTextPolicy.InputCandidate(role: role, settable: settable, focused: focused, frame: frame)
}
let transcript = candidate("AXTextArea", CGRect(x: 120, y: 140, width: 1160, height: 600))  // 上面那片回复流
let composer = candidate("AXTextArea", CGRect(x: 120, y: 780, width: 1160, height: 100))    // 底部输入框

switch SendTextPolicy.pickInput([transcript, composer], window: chatWindow) {
case .writable(let i, _): expectEqual(i, 1, "★两个 AXTextArea:挑靠下的那个(输入框在底部,回复流在上面)")
default: expect(false, "两个可写文本区应该挑出一个")
}

let focusedTranscript = candidate("AXTextArea", CGRect(x: 120, y: 140, width: 1160, height: 600), focused: true)
switch SendTextPolicy.pickInput([focusedTranscript, composer], window: chatWindow) {
case .writable(let i, let why):
    expectEqual(i, 0, "★焦点优先于几何:光标已经在那儿是比'它更靠下'更硬的证据")
    expect(why.contains("焦点"), "挑中的理由要说出口(\(why))")
default: expect(false, "焦点元素应该被挑中")
}

// 焦点但写不进去:焦点不能让一个只读元素变成可写的。
let focusedReadonly = candidate("AXTextField", CGRect(x: 120, y: 200, width: 400, height: 30), settable: false, focused: true)
switch SendTextPolicy.pickInput([focusedReadonly, composer], window: chatWindow) {
case .writable(let i, _): expectEqual(i, 1, "★焦点元素 AXValue 写不进去时,退给可写的那个,而不是硬写")
default: expect(false, "应该挑出可写的那个")
}

// 幽灵元素:0×0 与 4×2 这种占位节点不算输入框(先例 DragSense 的 120×120 下限)。
let ghost = candidate("AXTextField", CGRect(x: 130, y: 890, width: 4, height: 2))
switch SendTextPolicy.pickInput([composer, ghost], window: chatWindow) {
case .writable(let i, _): expectEqual(i, 0, "★比输入框更靠下的幽灵小元素不许赢(AX 树里全是 0×0 占位)")
default: expect(false, "应该挑出输入框")
}

// 不在这扇窗里的丢掉(屏外的、别的窗的残留节点)。
let elsewhere = candidate("AXTextArea", CGRect(x: 2000, y: 1900, width: 500, height: 80))
switch SendTextPolicy.pickInput([composer, elsewhere], window: chatWindow) {
case .writable(let i, _): expectEqual(i, 0, "★中心点不在这扇窗里的元素不参与(它更靠下也没用)")
default: expect(false, "应该挑出窗内的输入框")
}

// 只读的 contenteditable:能点不能写 —— 退到键盘那条路。
let readonlyComposer = candidate("AXTextArea", CGRect(x: 120, y: 780, width: 1160, height: 100), settable: false)
switch SendTextPolicy.pickInput([readonlyComposer], window: chatWindow) {
case .clickOnly(let i, let why):
    expectEqual(i, 0, "AXValue 写不进去的输入框要当'只能点'返回")
    expect(why.contains("写不进去"), "理由要说清是写不进去(\(why))")
default: expect(false, "★只读输入框应该退到键盘那条路,而不是报找不到")
}
expectEqual(SendTextPolicy.method(for: .clickOnly(index: 0, why: "")), SendTextPolicy.SendMethod.paste,
            "只能点 ⇒ 剪贴板粘贴")
expectEqual(SendTextPolicy.method(for: .writable(index: 0, why: "")), SendTextPolicy.SendMethod.axValue,
            "可写 ⇒ 直接写 AXValue(不碰键盘、不碰剪贴板、与输入法无关)")
expect(SendTextPolicy.method(for: .none(reason: "")) == nil, "找不到输入框就没有'怎么送'这回事")

// AXWebArea 是整张网页,不是输入框。
let webArea = candidate("AXWebArea", CGRect(x: 110, y: 110, width: 1180, height: 780))
switch SendTextPolicy.pickInput([webArea], window: chatWindow) {
case .none(let reason): expect(reason.contains("没有一个") || reason.contains("没有任何"), "★往 AXWebArea 身上写 AXValue 不是'填输入框'(\(reason))")
default: expect(false, "AXWebArea 不该被当成输入框")
}
switch SendTextPolicy.pickInput([], window: chatWindow) {
case .none(let reason): expect(reason.contains("AX"), "一个候选都没有时,原因要指向 AX 通道(\(reason))")
default: expect(false, "空候选只能是 none")
}

// 发送按钮:宁可认不出,不可认错。
expect(SendTextPolicy.looksLikeSendButton(title: "发送", description: nil), "「发送」是发送")
expect(SendTextPolicy.looksLikeSendButton(title: nil, description: "Send message"), "Send message 是发送")
expect(SendTextPolicy.looksLikeSendButton(title: "提交", description: nil), "「提交」是发送")
expect(!SendTextPolicy.looksLikeSendButton(title: "停止生成", description: nil), "★「停止生成」不是发送——认错了就是去按停止")
expect(!SendTextPolicy.looksLikeSendButton(title: "新建对话", description: "Send a new chat"), "★带 new chat 的一票否决,哪怕它也写着 send")
expect(!SendTextPolicy.looksLikeSendButton(title: "Cancel", description: nil), "Cancel 不是发送")
expect(!SendTextPolicy.looksLikeSendButton(title: nil, description: nil), "★什么都读不到时认不出 ⇒ 退到回车,不乱点")
expect(!SendTextPolicy.looksLikeSendButton(title: "", description: ""), "空字符串同理")

// MARK: 卡 F(2026-09-24):新对话、占位符、整块画成按钮的输入区、停止键

// 「新对话」菜单项:整项相等才算(**大小写不算数**,2026-09-26 卡 MQ:Grok Bot 那颗键写的是「New chat」)——
// 同一个菜单里还有 New Window / New Temporary Chat / New Project,那几项一个都不能认。
for title in ["New Chat", "New Session", "New Task", "新聊天", "新对话", " New Chat ", "New chat", "NEW TASK", "new conversation"] {
    expect(SendTextPolicy.isNewConversationItem(title), "「\(title)」是新对话")
}
for title in ["New Window", "New Temporary Chat", "New Project", "New Scheduled Task", "Open Folder…", "新建窗口", ""] {
    expect(!SendTextPolicy.isNewConversationItem(title), "★「\(title)」不是新对话 —— 认成了就是按错键")
}
expect(SendTextPolicy.singleThreadBundleIds == ["com.meta.endo"], "只有 Muse 是一条长期对话(菜单里没有「新对话」)")

// MARK: 卡 DB(2026-09-27):顺序「先开新对话 → 再在新对话里查框 → 送」+ 草稿存与回

// 顺序钉死。派活那条路(newConversation=true)第一步是**只看一眼找不找得到框**——
// 找不到就在按「新对话」之前失败,他的客户端里一条空对话都不留。
expectEqual(SendTextPolicy.sendSteps(newConversation: true, singleThread: false),
            [.reachInput, .openNewConversation, .locateInput, .deliver],
            "★派活:先看一眼写不写得进 → 开新对话 → 在新对话里找框 → 送")
expect(SendTextPolicy.sendSteps(newConversation: true, singleThread: false).firstIndex(of: .openNewConversation)!
       < SendTextPolicy.sendSteps(newConversation: true, singleThread: false).firstIndex(of: .locateInput)!,
       "★「新对话」必须排在「查输入框」前面 —— 反过来就是拿旧对话的框去判草稿,21:23 那一单就是这么被拦下的")
expectEqual(SendTextPolicy.sendSteps(newConversation: false, singleThread: false), [.locateInput, .deliver],
            "不开新对话时就两步(在他正开着的那条里送)")
expectEqual(SendTextPolicy.sendSteps(newConversation: true, singleThread: true), [.locateInput, .deliver],
            "只有一条长期对话的那几家(Muse)没有「新对话」这一步")

// 草稿:框里有他没发出去的字时怎么办。**绝不静默覆盖**。
expectEqual(SendTextPolicy.draftMove(inputEmpty: true, draft: "", overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.send, "框空的就直接送")
expectEqual(SendTextPolicy.draftMove(inputEmpty: true, draft: "给 Claude 发消息", overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.send, "占位符那一层已经在 isEmptyInput 里减掉了,这里照它的结论")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: "国庆放几天", overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.saveThenSend(draft: "国庆放几天"),
            "★有他没发出去的字、接得住 → 先存下来再送(21:23 那一单本该走这条)")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: "国庆放几天", overwrite: false, canSave: false),
            SendTextPolicy.DraftMove.blocked,
            "★老服务端接不住草稿 → 照旧拦下,不静默覆盖")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: nil, overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.blocked,
            "★框里有字却读不出内容 → 存不下来,那就不覆盖")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: "   \n ", overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.blocked, "只读回来一串空白 = 没存到东西,不覆盖")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: "国庆放几天", overwrite: true, canSave: true),
            SendTextPolicy.DraftMove.overwrite, "明着说了 overwrite 才覆盖")
expectEqual(SendTextPolicy.draftMove(inputEmpty: false, draft: " 写了一半\n", overwrite: false, canSave: true),
            SendTextPolicy.DraftMove.saveThenSend(draft: " 写了一半\n"),
            "★存的是**原样**:前后的空白与换行一个字符都不动(要原样放回去)")

// 送完了,那段草稿放不放回框里。
expectEqual(SendTextPolicy.draftReturn(submitted: true, inputEmptyAfterSend: true),
            SendTextPolicy.DraftReturn.putBack, "★发出去了、框空了 → 原样放回去")
if case .keepOnly = SendTextPolicy.draftReturn(submitted: false, inputEmptyAfterSend: false) {
    expect(true, "没替他按发送 → 只存着(框里躺的是我们要送的那句,放回去就顶掉了)")
} else {
    expect(false, "★没按发送时不许往框里写回草稿")
}
if case .keepOnly = SendTextPolicy.draftReturn(submitted: true, inputEmptyAfterSend: false) {
    expect(true, "发完框里还有字 → 只存着,不往上叠")
} else {
    expect(false, "★发完框里还有字时不许再写")
}
expect(SendTextPolicy.newConversationSettleMs >= 1000 && SendTextPolicy.newConversationSettleStepMs > 0,
       "刚按完「新对话」要给树留出重画的时间(旧对话那个框还挂着)")

// Manus 空框读回来是占位符 + 换行,而这句占位符不在任何 AX 属性上。
expect(SendTextPolicy.isKnownPlaceholder("Assign a task or type / for more\n", bundleId: "im.manus.desktop"), "Manus 首页那句占位符算空")
expect(SendTextPolicy.isKnownPlaceholder("Message Manus", bundleId: "im.manus.desktop"), "Manus 任务页那句占位符算空")
expect(!SendTextPolicy.isKnownPlaceholder("Message Manus", bundleId: "com.moonshot.kimichat"), "★占位符按家认,别家的同一句话是草稿")
expect(!SendTextPolicy.isKnownPlaceholder("帮我写个周报", bundleId: "im.manus.desktop"), "★真草稿不许当成空的")

// Muse 的输入区是一颗按钮:标题里同时有「消息」和「发送」。
expect(SendTextPolicy.looksLikeComposerButton(title: "消息 附加文件 语音输入一条消息 发送"), "Muse 的输入区")
expect(SendTextPolicy.looksLikeComposerButton(title: "Message Attach Send"), "英文界面同理")
expect(!SendTextPolicy.looksLikeComposerButton(title: "Send message"), "★「Send message」两段,是普通的发送键")
expect(!SendTextPolicy.looksLikeComposerButton(title: "发送"), "单写「发送」的是发送键")
expect(!SendTextPolicy.looksLikeComposerButton(title: "复制回复"), "消息气泡上的按钮不是输入区")
expect(!SendTextPolicy.looksLikeSendButton(title: "消息 附加文件 语音输入一条消息 发送", description: nil),
       "★输入区那颗按钮标题里也有「发送」—— 按它是点一下输入框,不是发出去")
let museComposer = SendTextPolicy.InputCandidate(role: "AXButton", settable: false, focused: false,
                                                 frame: CGRect(x: 668, y: 989, width: 768, height: 58), composer: true)
switch SendTextPolicy.pickInput([museComposer], window: CGRect(x: 195, y: 195, width: 1496, height: 868)) {
case .clickOnly: expect(true, "整块画成按钮的输入区:只能点、走粘贴")
default: expect(false, "★Muse 的输入区应该被挑成「只能点」")
}
expect(SendTextPolicy.submitNeedsCommand("com.meta.endo"), "Muse 要 ⌘回车才发(回车是换行)")
expect(!SendTextPolicy.submitNeedsCommand("com.moonshot.kimichat"), "别家回车就发")

// 「停止」键 = 那家还在出字:读回复时拿它当"还没完"。宁宽勿窄,但录音 / 听写那种不算。
expect(SendTextPolicy.looksLikeStopButton(title: nil, description: "Stop response"), "Claude 的 Stop response")
expect(SendTextPolicy.looksLikeStopButton(title: "停止生成", description: nil), "豆包的停止生成")
expect(SendTextPolicy.looksLikeStopButton(title: "消息 附加文件 语音输入一条消息 停止", description: nil), "Muse 在答的时候输入区那颗按钮变成「停止」")
expect(!SendTextPolicy.looksLikeStopButton(title: "停止录音", description: nil), "★停止录音不是停止生成")
expect(!SendTextPolicy.looksLikeStopButton(title: "发送", description: nil), "发送不是停止")

// 建议卡(2026-09-25 实测 Manus:把我们附的规矩当成要记住的偏好,回答下面挂一张 Dismiss / Accept 的卡)不算回答。
// 叫到台前之后等「新对话」亮起来(2026-09-25 真系统豆包:activate 之后约 1 秒才亮,老代码只等 350ms 就判灰、拒送)。
expect(SendTextPolicy.newConversationMenuWaitMs >= 3000, "★等「新对话」亮起来至少 3 秒(豆包实测要约 1 秒,机器忙时更久)")
expect(SendTextPolicy.newConversationReactivateAfterMs < SendTextPolicy.newConversationMenuWaitMs, "等到一半再叫一次台前,要在时限之内")
expect(SendTextPolicy.Failure.noNewConversation(bundleId: "com.bot.pc.doubao", detail: "x").message.contains("硬送就打进你正开着的那条对话"),
       "到点还灰才不送,原话照旧说清为什么不硬送")
expect(SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["Dismiss", "Accept"]), "★Manus 的「记住这条?」卡:Dismiss + Accept")
expect(SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["忽略", "接受"]), "中文界面同一张卡")
expect(!SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["Copy"]), "代码块的 Copy 不是建议卡")
expect(!SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["复制", "重试", "分享"]), "回答下面那排按钮不是建议卡")
expect(!SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["Approve", "Deny"]), "★批准命令的框要他知道,不能当建议卡吞掉")
expect(!SendTextPolicy.looksLikeSuggestionCard(buttonTitles: ["Accept"]), "只有一颗 Accept 不算")
expect(SendTextPolicy.Failure.sheetInTheWay(bundleId: "x").message.contains("对话框"),
       "★窗口上挂着存储面板这类对话框就不送 —— 话会打进文件名框")
expect(SendTextPolicy.Failure.noNewConversation(bundleId: "x", detail: "菜单栏里没有").message.contains("没送"),
       "★开不了新对话就不送 —— 硬送就打进他正开着的那条对话")

// 输入法:风险只在键盘那条路上。
expect(SendTextPolicy.imeWarning(inputSourceId: "com.sogou.inputmethod.sogou.pinyin", submit: .returnKey) != nil,
       "中文输入法 + 回车:如实报一句")
expect(SendTextPolicy.imeWarning(inputSourceId: "com.sogou.inputmethod.sogou.pinyin", submit: .axConfirm) == nil,
       "★AXConfirm 根本不经过键盘,输入法碰不到它")
expect(SendTextPolicy.imeWarning(inputSourceId: "com.sogou.inputmethod.sogou.pinyin", submit: .sendButton) == nil,
       "★按界面上那颗发送按钮也不经过键盘")
expect(SendTextPolicy.imeWarning(inputSourceId: "com.apple.keylayout.ABC", submit: .returnKey) == nil,
       "英文键盘按回车没有这个问题")

// 失败原因必须说得出是哪一步断的(卡上的规矩:不假装成功)。
expect(SendTextPolicy.Failure.notAllowed(bundleId: "com.tencent.xinWeChat").message.contains("白名单"),
       "拒送时要说清是白名单挡的")
expect(SendTextPolicy.Failure.notRunning(bundleId: "x").message.contains("找不到窗口"), "没在跑 = 找不到窗口")
expect(SendTextPolicy.Failure.axDisabled(bundleId: "x", err: -25211).message.contains("-25211"),
       "AX 通道关着要把原始错误码写出来")
expect(SendTextPolicy.Failure.noInput(bundleId: "x", detail: "试过了").message.contains("输入框没找到"),
       "找不到输入框要单独是一种失败,不跟'没窗口'混")
expect(SendTextPolicy.Failure.readbackMismatch(bundleId: "x", got: "半截").message.contains("别当成功"),
       "★写进去读回来对不上,就是没送成")

// MARK: - 窗口上弹着一个框挡住了(2026-09-28,卡 DP;现场:豆包正中那个「手机控制电脑」推广框)

// 辅助功能通道那两个错码不是一回事,说出来的下一句也不一样。
expect(SendTextPolicy.axGateHint(err: -25211).contains("kAXErrorAPIDisabled"),
       "-25211 = 整台电脑的辅助功能权限没给")
expect(SendTextPolicy.axGateHint(err: -25204).contains("kAXErrorCannotComplete"),
       "★-25204 = 树还没长出来(敲门之后要再等一拍重试),不是权限没给")
expect(SendTextPolicy.Failure.axDisabled(bundleId: "com.bot.pc.doubao", err: -25204).message.contains("-25204"),
       "原始错误码照旧写出来")
expect(SendTextPolicy.Failure.axDisabled(bundleId: "x", err: -25204).message.contains("辅助功能通道"),
       "服务端按「辅助功能通道」这几个字归类,两个码都要带上它")
expect(SendTextPolicy.axWakeRetryDelaysMs.count >= 2 && SendTextPolicy.axWakeRetryDelaysMs.allSatisfy { $0 > 0 },
       "★敲门之后至少再等两拍重试(Chromium 建树要时间),每拍都真的等")

// 哪些键算「纯关闭」——只认这几个,别的一律不点。
expect(SendTextPolicy.isPureCloseButton(title: "×", description: nil, subrole: nil), "× 是纯关闭")
expect(SendTextPolicy.isPureCloseButton(title: "✕", description: nil, subrole: nil), "✕ 同上")
expect(SendTextPolicy.isPureCloseButton(title: nil, description: "关闭", subrole: nil), "描述里写「关闭」也算")
expect(SendTextPolicy.isPureCloseButton(title: "Close", description: nil, subrole: nil), "Close")
expect(SendTextPolicy.isPureCloseButton(title: "稍后", description: nil, subrole: nil), "稍后")
expect(SendTextPolicy.isPureCloseButton(title: "以后再说", description: nil, subrole: nil), "以后再说")
expect(SendTextPolicy.isPureCloseButton(title: "跳过", description: nil, subrole: nil), "跳过(弹框里的跳过 = 关掉它)")
expect(SendTextPolicy.isPureCloseButton(title: "暂不", description: nil, subrole: nil), "暂不")
expect(SendTextPolicy.isPureCloseButton(title: "Not now", description: nil, subrole: nil), "Not now")
// 这几颗**绝不点**:点下去就是替她答应了什么。
expect(!SendTextPolicy.isPureCloseButton(title: "开始体验", description: nil, subrole: nil),
       "★现场那颗蓝键「开始体验」绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "同意并继续", description: nil, subrole: nil), "★同意绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "开通会员", description: nil, subrole: nil), "★开通绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "确认", description: nil, subrole: nil), "★确认绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "允许", description: nil, subrole: nil), "★允许绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "关闭并同意", description: nil, subrole: nil),
       "★带「同意」的一律不点,哪怕字面上也写着关闭")
expect(!SendTextPolicy.isPureCloseButton(title: "登录", description: nil, subrole: nil), "★登录绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "删除", description: nil, subrole: nil), "★删除绝不点")
expect(!SendTextPolicy.isPureCloseButton(title: "发送", description: nil, subrole: nil), "★发送键绝不当成关闭")
expect(!SendTextPolicy.isPureCloseButton(title: "x", description: nil, subrole: "AXCloseButton"),
       "★窗口自己那颗关闭键(AXCloseButton)不是弹框的关闭键——按下去关掉的是她的窗口")
expect(!SendTextPolicy.isPureCloseButton(title: "关闭", description: nil, subrole: "AXMinimizeButton"),
       "★最小化/缩放那几颗窗口控件同理")
expect(!SendTextPolicy.isPureCloseButton(title: nil, description: nil, subrole: nil), "什么字都没有 → 不点")
expect(!SendTextPolicy.isPureCloseButton(title: "导出为 xlsx", description: nil, subrole: nil),
       "★别的字里刚好有个 x → 不点(短名只认逐字相同)")

// 有没有一层框挡在前面。
expect(SendTextPolicy.looksLikeModalCover(roles: ["AXGroup", "AXSheet"], buttons: [], coverRatio: nil),
       "AXSheet 挂在窗口上 = 有框")
expect(SendTextPolicy.looksLikeModalCover(roles: ["AXApplicationDialog"], buttons: [], coverRatio: nil),
       "网页里的 role=dialog 在 AX 里是 AXApplicationDialog")
expect(SendTextPolicy.looksLikeModalCover(
    roles: ["AXGroup"],
    buttons: [SendTextPolicy.ModalButton(title: "开始体验", description: nil, subrole: nil),
              SendTextPolicy.ModalButton(title: "×", description: nil, subrole: nil)],
    coverRatio: 0.82),
       "★现场那一种:一整块遮罩盖住主区域 + 一颗推广键一颗关闭键")
expect(SendTextPolicy.looksLikeModalCover(
    roles: ["AXGroup"],
    buttons: [SendTextPolicy.ModalButton(title: "以后再说", description: nil, subrole: nil)],
    coverRatio: nil),
       "树里只剩寥寥几颗键、其中一颗是纯关闭 → 当有框挡着")
expect(!SendTextPolicy.looksLikeModalCover(roles: ["AXGroup", "AXTextArea"], buttons: [], coverRatio: nil),
       "★寻常的窗口树里没有框,不许硬说有")
expect(!SendTextPolicy.looksLikeModalCover(
    roles: ["AXGroup"],
    buttons: (0..<9).map { SendTextPolicy.ModalButton(title: "键\($0)", description: nil, subrole: nil) },
    coverRatio: nil),
       "★满树都是按钮、一颗关闭键都没有 → 不是框挡着")

// 认出来了之后:关得掉就关,认不准就如实说。
expectEqual(SendTextPolicy.modalVerdict(looksModal: false, buttons: []), .noModal, "没框 → 什么都不做")
expectEqual(SendTextPolicy.modalVerdict(
    looksModal: true,
    buttons: [SendTextPolicy.ModalButton(title: "开始体验", description: nil, subrole: nil),
              SendTextPolicy.ModalButton(title: "关闭", description: nil, subrole: nil)]),
            .close(index: 1),
            "★有纯关闭键 → 只按那一颗(绝不按「开始体验」)")
expectEqual(SendTextPolicy.modalVerdict(
    looksModal: true,
    buttons: [SendTextPolicy.ModalButton(title: "开始体验", description: nil, subrole: nil)]),
            .giveUp,
            "★只有「开始体验」→ 一颗都不按,如实说我关不掉")
expectEqual(SendTextPolicy.modalVerdict(looksModal: true, buttons: []), .giveUp,
            "★一颗键都读不到 → 认不准,不乱点")

// 那句人话:说清是框挡着、我关不掉、下一步她做什么。
expect(SendTextPolicy.Failure.modalInTheWay(bundleId: "com.bot.pc.doubao", hint: "手机控制电脑").message.contains("弹了个框挡着"),
       "★服务端按「弹了个框挡着」这几个字归类")
expect(SendTextPolicy.Failure.modalInTheWay(bundleId: "x", hint: "手机控制电脑").message.contains("手机控制电脑"),
       "读到了框上那句话就带上它")
expect(SendTextPolicy.Failure.modalInTheWay(bundleId: "x", hint: nil).message.contains("去点一下"),
       "★关不掉一定要给下一步:去点一下再叫我派")
expect(!SendTextPolicy.Failure.modalInTheWay(bundleId: "x", hint: nil).message.contains("nil"),
       "读不到那句话就不提它,不把 nil 念出来")
expectEqual(SendTextPolicy.modalHint(texts: ["手机控制电脑", "随时用手机,继续电脑上的任务"]), "手机控制电脑",
            "框上第一句话就是它的标题")
expectEqual(SendTextPolicy.modalHint(texts: ["  ", "开始体验"]), "开始体验", "空白那几段跳过")
expectEqual(SendTextPolicy.modalHint(texts: []), nil, "什么都没读到 → 没有这一句")
expect((SendTextPolicy.modalHint(texts: [String(repeating: "长", count: 60)]) ?? "").count <= 25,
       "★念给她听的那句话不许是一整段,截短")

// 网页那一层压根没长出来(现场第二次:树里只剩窗口那三颗控件)——与「这个 App 真没有输入框」分开说。
expect(SendTextPolicy.looksLikeShellOnlyTree(
    buttons: [SendTextPolicy.ModalButton(title: nil, description: "关闭", subrole: "AXCloseButton"),
              SendTextPolicy.ModalButton(title: nil, description: "最小化", subrole: "AXMinimizeButton"),
              SendTextPolicy.ModalButton(title: nil, description: "缩放", subrole: "AXZoomButton")],
    texts: []),
       "★只剩窗口三颗控件、一个字都读不到 = 网页那一层没长出来")
expect(!SendTextPolicy.looksLikeShellOnlyTree(
    buttons: [SendTextPolicy.ModalButton(title: "新对话", description: nil, subrole: nil)],
    texts: []),
       "有它自己的键 → 树是长出来了")
expect(!SendTextPolicy.looksLikeShellOnlyTree(buttons: [], texts: ["昨天的对话"]),
       "读到了对话里的字 → 树是长出来了")
expect(SendTextPolicy.Failure.treeShellOnly(bundleId: "x").message.contains("网页那一层没长出来"),
       "★服务端按这几个字归类")
expect(SendTextPolicy.Failure.treeShellOnly(bundleId: "x").message.contains("弹"),
       "★这一句要提一嘴「被弹框挡着时也会这样」,她才知道去看什么")

// MARK: - SwitchBudget:一次切换的时间切给谁(2026-09-21「点标签切换经常卡住」)

// 单次 AX 调用的时限:数字本身也是一条断言——改它必须有人改到这里,不能悄悄漂走。
expectEqual(SwitchBudget.axMessagingTimeoutSeconds, 1.0, "每个 AXUIElement 的消息时限是 1 秒")
expectEqual(SwitchBudget.totalMs, 3000, "一次切换整体最多 3 秒回 8791")
expectEqual(SwitchBudget.hideOthersMs, 1500, "藏别家那一段的预算是 1.5 秒")
expectEqual(SwitchBudget.raiseBudgetMs, 1500, "抬窗那一段 = 总预算 - 藏别家那一段")

// 预算切分:抬窗优先,藏别家拿剩下的(但最多只配 hideOthersMs)。
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 0), 1500,
            "抬窗零耗时:藏别家也只拿 1.5 秒,不因为总预算宽裕就放宽")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 40), 1500,
            "★负载 5 时实测 40ms 的那一趟:藏别家拿满 1.5 秒")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 1500), 1500,
            "抬窗正好花掉自己那一半:藏别家仍拿满 1.5 秒")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 2000), 1000,
            "★抬窗超了自己那一段:藏别家只剩总预算里没用掉的 1 秒")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 3000), 0,
            "★抬窗把总预算吃光:一家都不当场藏,全进后台队列")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: 9000), 0,
            "抬窗远超总预算(负载 200 那种)同样是 0,不会变成负数")
expectEqual(SwitchBudget.hideBudgetMs(raiseElapsedMs: -5), 1500,
            "时钟倒走(测试假时钟/系统校时)不该算出超过 1.5 秒的预算")

// 还该不该当场藏下一家。
expect(!SwitchBudget.shouldDeferNextHide(hideElapsedMs: 0, budgetMs: 1500), "还没花时间,当场藏")
expect(!SwitchBudget.shouldDeferNextHide(hideElapsedMs: 1499, budgetMs: 1500), "差 1ms 也还在预算内")
expect(SwitchBudget.shouldDeferNextHide(hideElapsedMs: 1500, budgetMs: 1500),
       "★用光那一刻就收手(>=,不赌下一家很快)")
expect(SwitchBudget.shouldDeferNextHide(hideElapsedMs: 0, budgetMs: 0),
       "★预算是 0 时第一家就进后台队列")

// 壳侧:在串行队列里躺太久的请求,这次不动。
expect(!SwitchBudget.staleInQueue(queuedForMs: 0), "刚进队就做")
expect(!SwitchBudget.staleInQueue(queuedForMs: 1499), "差 1ms 还做")
expect(SwitchBudget.staleInQueue(queuedForMs: 1500),
       "★躺够 1.5 秒 = 服务端那次切换八成已经回了结果,再动窗口只会让屏幕又跳一下")
expect(SwitchBudget.staleInQueueMessage.contains("这次不动"),
       "放弃的原话要说清是壳自己主动放弃的,不是应用没反应")

// MARK: - 收尾


// MARK: - dsh web 令牌(2026-09-23 从零重装验收:新机器上整屏只有一行 authentication required)

let sampleLog = """
dsh web: http://127.0.0.1:3080/?token=OLD111
[channel] 起了
dsh web: http://127.0.0.1:3080/?token=NEW222
[技能] 接上了
"""
expectEqual(WebToken.latest(inLog: sampleLog), "NEW222", "★取**最后**一条(dsh 每次重启追加一条,旧的还留在上面)")
expectEqual(WebToken.latest(inLog: "[channel] 起了\n"), nil as String?, "日志里没有就是 nil,不编")
expectEqual(WebToken.latest(inLog: ""), nil as String?, "空日志(刚被轮转截断)是 nil")
expectEqual(WebToken.latest(inLog: "open \"http://127.0.0.1:3080/?token=abc\" now"), "abc",
            "值到引号为止(与插件 latestWebToken 同一种行)")
expectEqual(WebToken.latest(inLog: "http://10.0.0.2:3080/?token=lan"), nil as String?,
            "★只认 127.0.0.1 那一条(与插件 latestWebToken 口径一致)")

let files = WebToken.candidateFiles(logsDir: "/L", names: [
    "web.stderr.log.2026-09-21", "web.stdout.log.2026-09-20", "butler.stdout.log",
    "web.stdout.log.2026-09-22", "web.stdout.log", "web.stdout.log.tmp", "web.stdout.log.2026-9-1",
])
expectEqual(files, ["/L/web.stdout.log", "/L/web.stdout.log.2026-09-22", "/L/web.stdout.log.2026-09-20"],
            "★活着那份先看,再按日期新到旧看轮转出来的;别的文件一概不看")
expectEqual(WebToken.candidateFiles(logsDir: "/L", names: []), ["/L/web.stdout.log"],
            "目录读不到时也至少试活着那份")

let page = URL(string: "http://127.0.0.1:3080/?ben-workbench=app")!
expectEqual(WebToken.authenticatedURL(page: page, token: "T0K")?.absoluteString,
            "http://127.0.0.1:3080/?ben-workbench=app&token=T0K", "★带令牌的地址保留 ben-workbench=app")
expectEqual(WebToken.authenticatedURL(page: URL(string: "http://127.0.0.1:3080/x?token=old&a=1")!, token: "N")?.absoluteString,
            "http://127.0.0.1:3080/?a=1&token=N", "★路径归 /、旧 token 去掉只留一个(dsh 要求 token 恰好一个、路径是 /)")

expect(WebToken.sameOrigin(URL(string: "http://127.0.0.1:3080/")!, page), "同协议同主机同端口 = 同源")
expect(!WebToken.sameOrigin(URL(string: "http://127.0.0.1:8791/")!, page), "端口不同不是 dsh web(8791 的 401 不接手)")
expect(!WebToken.sameOrigin(URL(string: "https://127.0.0.1:3080/")!, page), "协议不同不算")

expect(WebToken.isBareRootRedirect(URL(string: "http://127.0.0.1:3080/")!, page: page),
       "★dsh 换完 cookie 303 回去的干净 / —— 要截下来换回原地址")
expect(!WebToken.isBareRootRedirect(page, page: page), "原地址本身(带 ben-workbench=app)不是那一跳")
expect(!WebToken.isBareRootRedirect(URL(string: "http://127.0.0.1:3080/assets/x.js")!, page: page), "别的路径不是")
expect(!WebToken.isBareRootRedirect(URL(string: "http://127.0.0.1:9999/")!, page: page), "别的端口不是")

expectEqual(WebToken.delay(afterConsecutiveFailures: 0), 0, "★第一次 401 立刻去取(新机器上的常态,不让人等)")
expectEqual(WebToken.delay(afterConsecutiveFailures: 1), 2, "连着第二次:日志里那条多半是旧的,等 2 秒")
expectEqual(WebToken.delay(afterConsecutiveFailures: 3), 8, "退避翻倍")
expectEqual(WebToken.delay(afterConsecutiveFailures: 9), 10, "封顶 10 秒(同页面加载失败那套)")

// MARK: - LoadingCover:壳自己的加载占位(2026-09-23,盖住上游「Loading plugins…」)

expectEqual(LoadingCover.handlerName, "benWorkbenchShell", "与插件 shell.ts 的 SHELL_READY_HANDLER 同名")
expect(LoadingCover.isReady(name: "benWorkbenchShell", body: ["type": "ready"], isMainFrame: true), "主框架发 {type:ready} 就揭开")
expect(!LoadingCover.isReady(name: "benWorkbenchShell", body: ["type": "ready"], isMainFrame: false), "iframe 里发的不算(事务官标签里内嵌的 DSH 页)")
expect(!LoadingCover.isReady(name: "别的", body: ["type": "ready"], isMainFrame: true), "别的 handler 名不算")
expect(!LoadingCover.isReady(name: "benWorkbenchShell", body: "ready", isMainFrame: true), "body 不是对象不算")
expect(!LoadingCover.isReady(name: "benWorkbenchShell", body: ["type": "other"], isMainFrame: true), "type 不是 ready 不算")
expectEqual(LoadingCover.subtitle(waited: 0), "正在打开…", "刚盖上:正在打开")
expect(LoadingCover.subtitle(waited: LoadingCover.slowAfter).contains("还在等"), "等久了换一句,不像卡死")
expect(LoadingCover.revealAfterCommit >= 10, "页面提交后至少给插件 10 秒再兜底揭开")

// MARK: - ShellReadiness:先探服务就绪再加载(2026-09-26,卡 U6「壳白屏一次」)
//
// 09-26 生产切换:热更新重启 DSH 之后壳里整窗一片白 —— 3080 先起来、插件还没挂上,
// 壳把一张空页提交了进来,盖板等不到 ready、20 秒兜底一到就揭开。
// 修法是加载之前先探 8791:它答话 = 插件真挂上了。这一段钉住那几条判断。

let helperWS = URL(string: "ws://127.0.0.1:8791/helper")!
expectEqual(ShellReadiness.probeURL(helperWS: helperWS)?.absoluteString,
            "http://127.0.0.1:8791/ready",
            "★探针地址从 helper_ws 推出来:同一个 host 同一个端口,路径换成 /ready")
expectEqual(ShellReadiness.probeURL(helperWS: URL(string: "wss://127.0.0.1:8791/helper")!)?.absoluteString,
            "https://127.0.0.1:8791/ready", "wss 推出 https")
expectEqual(ShellReadiness.probeURL(helperWS: URL(string: "ws://127.0.0.1:8791/helper?x=1#y")!)?.absoluteString,
            "http://127.0.0.1:8791/ready", "query 与 fragment 不带进探针地址")
expect(ShellReadiness.probeURL(helperWS: URL(string: "http://127.0.0.1:8791/helper")!) == nil,
       "scheme 不是 ws/wss:推不出来(回 nil = 退回老行为,直接加载 —— 宁可退回老样子,也不要打不开窗)")
expect(ShellReadiness.probeURL(helperWS: URL(string: "ws:///helper")!) == nil, "拿不到 host:推不出来")
expectEqual(ShellReadiness.probePath, "/ready", "★与插件那条路由同名(server/http.ts 里那一条),两头各有用例钉着")

expect(ShellReadiness.isReady(status: 200), "200:服务在,可以加载页面了")
expect(ShellReadiness.isReady(status: 401), "★401 也算服务在:8791 上真有人在听并且在答话,令牌那一路由页面自己走")
expect(ShellReadiness.isReady(status: 403), "403 同上")
expect(ShellReadiness.isReady(status: 404), "404 也算:有人在答话就够了(路由名以后改了也不该卡住开窗)")
expect(!ShellReadiness.isReady(status: 502), "5xx 不算:刚起来还没就绪的中间态,再等一轮")
expect(!ShellReadiness.isReady(status: nil), "★连不上 / 超时(没有 status)不算 —— 那正是白屏那一刻的样子")

expectEqual(ShellReadiness.delay(afterAttempts: 1), 0.5, "头一下密:热更新重启多半一两秒就回来")
expectEqual(ShellReadiness.delay(afterAttempts: 2), 1, "退避 ×2")
expectEqual(ShellReadiness.delay(afterAttempts: 3), 2, "退避 ×2")
expectEqual(ShellReadiness.delay(afterAttempts: 4), 4, "退避 ×2")
expectEqual(ShellReadiness.delay(afterAttempts: 5), 5, "封顶 5 秒:冷机要 20 秒以上,一秒一探只是白费电")
expectEqual(ShellReadiness.delay(afterAttempts: 99), 5, "封顶就是封顶")
expectEqual(ShellReadiness.delay(afterAttempts: 0), 0.5, "第 0 次当第 1 次算(不会回出 0 让它空转)")

expect(!ShellReadiness.gaveUp(attempts: 1), "才探一次,接着探")
expect(!ShellReadiness.gaveUp(attempts: ShellReadiness.maxAttempts - 1), "没到上限,接着探")
expect(ShellReadiness.gaveUp(attempts: ShellReadiness.maxAttempts), "★到上限就停:一扇无声转圈的窗跟白屏一样糟")
// 上限 × 封顶退避 ≈ 至少两分钟:冷机 + 装机那一幕要够。
expect(Double(ShellReadiness.maxAttempts - 4) * 5 >= 120, "探到头之前至少给两分钟(冷机 20 秒以上、装机更久)")
expectEqual(ShellReadiness.subtitle(waited: 0, gaveUp: false), LoadingCover.subtitle(waited: 0),
            "还在等的时候沿用加载占位那两句(同一件事只有一份措辞)")
expectEqual(ShellReadiness.subtitle(waited: 0, gaveUp: true), ShellReadiness.timedOut, "探到头换那一句")
expect(ShellReadiness.timedOut.contains("再等一下") && ShellReadiness.timedOut.contains("重试"),
       "★探到头那句是人话:告诉他能再等、也能点重试(不出现端口号 / HTTP / 探测这些词)")
expect(!ShellReadiness.timedOut.contains("8791") && !ShellReadiness.timedOut.contains("HTTP"),
       "那句里不许出现内部词")

// MARK: - ShellReadiness:8791 一直不答时壳自己把服务拉一次(2026-10-13,0.4.115「装完没自己起来」)
//
// 10-12 晚那一趟:热更新装完那下 kickstart 没到 launchd,DSH 以 0 退出,
// `KeepAlive.SuccessfulExit=false` 故意不拉 —— 服务停在那儿,而壳只会重连、不会去拉它,
// 所以「关掉重开一次」救不回来。现在壳等够 20 秒自己发一下**不带 -k** 的 kickstart。

expectEqual(ShellReadiness.dshLaunchdLabel, "ai.deepseek.dsh",
            "★与插件 server/setup/paths.ts 的 DSH_LAUNCHD_LABEL 逐字相同,两边各有一条用例钉着")
expectEqual(ShellReadiness.kickstartArguments(uid: 501), ["kickstart", "gui/501/ai.deepseek.dsh"],
            "★不带 -k:对还在跑的项它什么都不做(pid 与 runs 一格不动),所以这一下不可能把一个好着的服务弄掉")
expect(!ShellReadiness.kickstartArguments(uid: 501).contains("-k"), "带 -k 就是杀掉再起 —— 永远不带")

expect(!ShellReadiness.shouldKickstart(waited: 0, kicks: 0, sinceLastKick: nil), "刚开始探:一下都不发")
expect(!ShellReadiness.shouldKickstart(waited: 19, kicks: 0, sinceLastKick: nil),
       "★20 秒之前不动手:launchd 自己的 ThrottleInterval 就要 10 秒(量到约 9 秒),再加冷起")
expect(ShellReadiness.shouldKickstart(waited: ShellReadiness.kickstartAfter, kicks: 0, sinceLastKick: nil),
       "等够了就发第一下")
expect(ShellReadiness.kickstartAfter > 10,
       "★必须大于 plist 里的 ThrottleInterval(10):不然刚 kickstart 过还在节流里就又拉一次")
expect(!ShellReadiness.shouldKickstart(waited: 90, kicks: 1, sinceLastKick: 5),
       "上一下才发了 5 秒:等满间隔再说(不无限重试)")
expect(ShellReadiness.shouldKickstart(waited: 90, kicks: 1, sinceLastKick: ShellReadiness.kickstartInterval),
       "隔满了可以再发一下")
expect(!ShellReadiness.shouldKickstart(waited: 600, kicks: ShellReadiness.maxKickstarts, sinceLastKick: 600),
       "★发到上限就不发了:拉不起来是别的毛病,该出那句人话 + 一颗「重试」")
expect(ShellReadiness.maxKickstarts >= 1 && ShellReadiness.maxKickstarts <= 5, "上限是个小数字")

// MARK: - ShellTitleBar:壳顶上那一条(2026-09-25,卡 TB「顶部空隙难受」)
//
// ① 窗口还是 .titled(无边框那个坑不回来),但 styleMask 含 .fullSizeContentView、标题隐藏、标题栏透明;
// ② 网页顶栏空白处按下 / 双击那两条消息壳认得(拖窗口的回调真的在);
// ③ 双击照系统设置「连按标题栏来」走。

expect(ShellTitleBar.styleMask & ShellTitleBar.fullSizeContentView != 0,
       "★styleMask 含 fullSizeContentView —— 网页内容顶到窗顶,顶上不再叠一层标题栏")
expect(ShellTitleBar.styleMask & ShellTitleBar.titled != 0,
       "★仍然是 .titled 窗口(无边框模式下 WKWebView 输入框失焦的坑不许回来)")
expect(ShellTitleBar.styleMask & ShellTitleBar.closable != 0, "关闭键留着(第一次用的人首先要会关窗)")
expect(ShellTitleBar.styleMask & ShellTitleBar.miniaturizable != 0, "最小化键留着")
expect(ShellTitleBar.styleMask & ShellTitleBar.resizable != 0, "窗口还能缩放")
expectEqual(ShellTitleBar.styleMask, 1 | 2 | 4 | 8 | 32768, "styleMask 就这五项,没多没少")
expect(ShellTitleBar.titleHidden, "★标题文字隐藏(标题「工作台」由网页顶栏那一行小字说)")
expect(ShellTitleBar.titlebarAppearsTransparent, "★标题栏透明,红绿灯浮在网页顶栏上")
expect(ShellTitleBar.movableByWindowBackground, "★窗口背景也能拖(全屏网页没有顶栏时多一条原生兜底)")
expect(ShellTitleBar.trafficLightInset >= 70, "网页顶栏左边给红绿灯留出的位置够(78pt,与插件那侧同一个数)")

expectEqual(ShellTitleBar.handlerName, LoadingCover.handlerName, "与加载占位共用一条通道,不给页面多开一条")
expectEqual(ShellTitleBar.message(name: "benWorkbenchShell", body: ["type": "titlebar_drag"], isMainFrame: true),
            .drag, "★顶栏空白处按下 → 壳收到「拖窗口」(拖动区域的回调在)")
expectEqual(ShellTitleBar.message(name: "benWorkbenchShell", body: ["type": "titlebar_dblclick"], isMainFrame: true),
            .doubleClick, "★双击顶栏 → 壳收到「双击」")
expect(ShellTitleBar.message(name: "benWorkbenchShell", body: ["type": "titlebar_drag"], isMainFrame: false) == nil,
       "iframe 里的顶栏不是窗口的顶栏,不认(事务官标签内嵌的 DSH 页)")
expect(ShellTitleBar.message(name: "别的", body: ["type": "titlebar_drag"], isMainFrame: true) == nil, "别的 handler 名不认")
expect(ShellTitleBar.message(name: "benWorkbenchShell", body: "titlebar_drag", isMainFrame: true) == nil, "body 不是对象不认")
expect(ShellTitleBar.message(name: "benWorkbenchShell", body: ["type": "ready"], isMainFrame: true) == nil,
       "揭开占位那一条不会被当成拖动")
expect(!LoadingCover.isReady(name: "benWorkbenchShell", body: ["type": "titlebar_drag"], isMainFrame: true),
       "反过来也一样:拖动那一条不会被当成「插件挂上了」")

expectEqual(ShellTitleBar.doubleClickAction(setting: nil), .zoom, "★系统设置没动过(缺省):双击表头缩放,不是毫无反应")
expectEqual(ShellTitleBar.doubleClickAction(setting: "Maximize"), .zoom, "选「缩放」就缩放")
expectEqual(ShellTitleBar.doubleClickAction(setting: "Minimize"), .miniaturize, "选「最小化」就最小化")
expectEqual(ShellTitleBar.doubleClickAction(setting: "None"), .ignore, "★选「什么都不做」就真的不做")
expectEqual(ShellTitleBar.doubleClickAction(setting: " minimize "), .miniaturize, "值前后有空格、大小写不同也认")
expectEqual(ShellTitleBar.doubleClickAction(setting: "认不出来的值"), .zoom, "认不出来按缺省缩放,不让双击显得窗口坏了")

// MARK: - 可视区变了要不要跟着重新铺满(卡 TB ④:菜单栏改成「自动隐藏和显示」)

let menuBarShown = CGRect(x: 0, y: 0, width: 2560, height: 1415)
let menuBarHidden = CGRect(x: 0, y: 0, width: 2560, height: 1440)
expect(WindowPlacement.fills(menuBarShown, menuBarShown), "四边贴着就算铺满")
expect(WindowPlacement.fills(CGRect(x: 1, y: 0, width: 2559, height: 1414), menuBarShown), "差一两点(整像素取整)还算铺满")
expect(!WindowPlacement.fills(CGRect(x: 0, y: 0, width: 1400, height: 900), menuBarShown), "他自己拖小过的不算铺满")
expectEqual(WindowPlacement.refit(menuBarShown, from: menuBarShown, into: menuBarHidden), menuBarHidden,
            "★菜单栏一藏、可视区长高:刚才铺满的跟着铺满新的(顶上不留空带)")
expectEqual(WindowPlacement.refit(menuBarHidden, from: menuBarHidden, into: menuBarShown), menuBarShown,
            "菜单栏又露出来:跟着收回去,不被顶出屏外")
expectEqual(WindowPlacement.refit(CGRect(x: 40, y: 40, width: 1400, height: 900), from: menuBarShown, into: menuBarHidden),
            CGRect(x: 40, y: 40, width: 1400, height: 900),
            "★他自己拖小过的窗口:可视区变了也只收边,大小位置不动(他选的赢过自动铺满)")
expectEqual(WindowPlacement.refit(menuBarShown, from: nil, into: menuBarHidden),
            WindowPlacement.fit(menuBarShown, into: menuBarHidden),
            "没有旧可视区可比(刚启动)时退回收边,不猜")
expectEqual(WindowPlacement.refit(menuBarShown, from: menuBarShown, into: menuBarShown), menuBarShown,
            "可视区没变(Dock 显隐之类的空通知):什么都不改,不白写一次盘")

// MARK: - 定时核对可视区(2026-09-26,卡 TB 真机回访:改完「自动隐藏和显示菜单栏」窗口没跟着长高)
//
// 真机上那一下:2560×1440 的屏,窗口停在 2560×1410 不动。原因是壳只在
// didChangeScreenParametersNotification 那**一次**核对,而这个设置要么不发通知、要么发的时候
// NSScreen 还是旧值 —— 唯一一次机会白过,就再也没有第二次。现在通知与定时核对共用下面这条判断。

expect(WindowPlacement.visibleFramePoll > 0 && WindowPlacement.visibleFramePoll <= 5,
       "核对间隔是秒级(改完设置抬头就看见),不是分钟级")

// 维护者真机上的那组数:菜单栏 30 点,窗口正铺满 2560×1410 → 设成自动隐藏后可视区变 2560×1440。
let benShown = CGRect(x: 0, y: 0, width: 2560, height: 1410)
let benHidden = CGRect(x: 0, y: 0, width: 2560, height: 1440)
expectEqual(WindowPlacement.reconcile(window: benShown, previous: benShown, visible: benHidden), benHidden,
            "★真机那一组:菜单栏改成自动隐藏,正铺满的窗口跟着长到 2560×1440(顶上那 30 点空带没了)")
expect(WindowPlacement.reconcile(window: benShown, previous: benShown, visible: benShown) == nil,
       "★可视区没变:核对什么都不做 —— 每两秒进来一次,这是常态,不许 setFrame、不许写盘")
expect(WindowPlacement.reconcile(window: benShown, previous: nil, visible: benHidden) == nil,
       "壳刚起来、还没有可比的旧值:只记住,不动窗口")
expect(WindowPlacement.reconcile(window: CGRect(x: 40, y: 40, width: 1400, height: 900),
                                 previous: benShown, visible: benHidden) == nil,
       "★他自己拖小过的窗口:可视区长高也不动它(收边收了个寂寞 → nil,不白写一次盘)")
expectEqual(WindowPlacement.reconcile(window: benHidden, previous: benHidden, visible: benShown), benShown,
            "菜单栏改回一直显示:铺满的窗口跟着收回去")
expectEqual(WindowPlacement.reconcile(window: CGRect(x: 0, y: 0, width: 2560, height: 1440),
                                      previous: benHidden,
                                      visible: CGRect(x: 0, y: 100, width: 2560, height: 1340)),
            CGRect(x: 0, y: 100, width: 2560, height: 1340),
            "Dock 冒出来把可视区压矮:铺满的窗口跟着让开,不被压在 Dock 底下")
// 没铺满、但被新的可视区顶出去了:收边,这一下要动(与上面那条「收了个寂寞」区分开)。
expectEqual(WindowPlacement.reconcile(window: CGRect(x: 0, y: 0, width: 1400, height: 900),
                                      previous: benHidden,
                                      visible: CGRect(x: 0, y: 200, width: 2560, height: 1240)),
            CGRect(x: 0, y: 200, width: 1400, height: 900),
            "没铺满但被顶出可视区:收进来,大小不变")

// MARK: - 重启还原记忆也要跟着新可视区铺满(2026-09-26,卡 TB 真机回访之二)
//
// 统筹实测:维护者把菜单栏改成「始终自动隐藏」后杀掉重开壳,NSScreen.visibleFrame 已经是
// 2560×1440,而 app.json 里的记忆是 {dx:0, dy:0, w:2560, h:1410} —— 还原那一路只 fit,
// **不知道那份记忆当时正铺满旧的可视区**,于是老实还原成 1410,顶上又空一条。
// 现在记忆里一并记下「写它的时候可视区多大」(vw/vh),口径与 refit 那一路一致。

let menuShown = ScreenSnapshot(name: "27N3F", frame: CGRect(x: 0, y: 0, width: 2560, height: 1440),
                               visibleFrame: CGRect(x: 0, y: 0, width: 2560, height: 1415), displayID: 11)
let menuHidden = ScreenSnapshot(name: "27N3F", frame: CGRect(x: 0, y: 0, width: 2560, height: 1440),
                                visibleFrame: CGRect(x: 0, y: 0, width: 2560, height: 1440), displayID: 11)
expectEqual(menuShown.key, menuHidden.key, "菜单栏显隐不改记忆键(键用的是整块屏的分辨率)")

// 统筹给的那条用例:记忆 h1410@可视区 1415 → 现在可视区 1440 → 还原成 1440。
let filledThen = WindowPlacement.remember(frame: CGRect(x: 0, y: 0, width: 2560, height: 1415), on: menuShown)
expectEqual(filledThen.filledWhenRemembered(tolerance: WindowPlacement.fillTolerance), true,
            "写这份记忆的时候它正铺满(这一点现在记在册子里,不靠猜)")
expectEqual(WindowPlacement.frame(for: menuHidden, remembered: filledThen), menuHidden.visibleFrame,
            "★重启还原:当时铺满旧可视区的记忆,碰上长高了的可视区 → 铺满新的(顶上不留空带)")
expectEqual(WindowPlacement.frame(for: menuShown, remembered: filledThen), menuShown.visibleFrame,
            "可视区没变:还原成原样(就是铺满)")
let smallThen = WindowPlacement.remember(frame: CGRect(x: 100, y: 100, width: 1400, height: 900), on: menuShown)
expectEqual(WindowPlacement.frame(for: menuHidden, remembered: smallThen),
            CGRect(x: 100, y: 100, width: 1400, height: 900),
            "★他自己拖小过的那一份:可视区长高也原样还原,不擅自铺满")
expectEqual(WindowPlacement.frameOnArrival(current: CGRect(x: 60, y: 60, width: 1200, height: 800),
                                           screen: menuHidden, remembered: filledThen),
            menuHidden.visibleFrame,
            "拖回这块屏:那块屏记着的是一扇铺满的窗,而可视区变大了 → 铺满新的")

// 旧记忆(2026-09-26 之前写的,没有 vw/vh):一次性迁移口径 —— 贴原点、同宽、只矮一条菜单栏之内。
let legacyFilled = RememberedFrame(dx: 0, dy: 0, width: 2560, height: 1410)
expectEqual(WindowPlacement.frame(for: menuHidden, remembered: legacyFilled), menuHidden.visibleFrame,
            "★升级前写下的记忆(没有 vw/vh):矮的正好是一条菜单栏 → 当成当年铺满过,铺满现在这块")
let legacySmall = RememberedFrame(dx: 0, dy: 0, width: 2560, height: 1200)
expectEqual(WindowPlacement.frame(for: menuHidden, remembered: legacySmall),
            CGRect(x: 0, y: 0, width: 2560, height: 1200),
            "旧记忆矮得比一条菜单栏多(他自己拖的):原样还原,不认这条迁移")
let legacyNarrow = RememberedFrame(dx: 0, dy: 0, width: 2000, height: 1410)
expectEqual(WindowPlacement.frame(for: menuHidden, remembered: legacyNarrow),
            CGRect(x: 0, y: 0, width: 2000, height: 1410),
            "旧记忆宽度对不上可视区:不是铺满过的那种,原样还原")
expect(!filledThen.looksFilledBeforeMenuBarHid(now: menuHidden.visibleFrame),
       "带 vw/vh 的新记忆一律不走迁移那条(它自己答得上来)")

// 编解码:vw/vh 跟着进 app.json,旧文件缺这两项照常读(当「不知道」)。
let encodedFilled = filledThen.encoded
expectEqual(encodedFilled["vw"] as? Int, 2560, "记忆里带上当时可视区的宽")
expectEqual(encodedFilled["vh"] as? Int, 1415, "记忆里带上当时可视区的高")
expectEqual(RememberedFrame.decode(encodedFilled), filledThen, "带 vw/vh 的记忆编解码一轮回来是同一份")
expectEqual(RememberedFrame.decode(["dx": 0, "dy": 0, "w": 2560, "h": 1410])?.visible, nil,
            "旧文件没有 vw/vh:读出来就是「不知道」,不编一个数")
expectEqual(RememberedFrame.decode(["dx": 0, "dy": 0, "w": 2560, "h": 1410, "vw": 2560])?.visible, nil,
            "只有半项(vw 没 vh):当没有,不半信半疑")

// MARK: - WebPolicy:壳替网页做的那批事(2026-09-25,卡 fix/shell-web-capabilities)
//
// 真 WebKit 引擎里的那一半(选文件框真的回文件给网页、拖文件、新窗口、弹框、下载落盘)
// 在 ./run-web-tests.sh;这里只测判断。

func nav(_ url: String?, main: Bool = true, link: Bool = false, download: Bool = false) -> WebPolicy.NavigationFacts {
    WebPolicy.NavigationFacts(url: url.flatMap { URL(string: $0) }, isMainFrame: main,
                              isLinkActivated: link, shouldPerformDownload: download)
}

expectEqual(WebPolicy.decide(nav("blob:http://127.0.0.1:3080/abc", link: true, download: true), page: page), .download,
            "★<a download>(导出粒子配置)转下载 —— 不然主框架会去「打开」那个 blob,整页换成一段 JSON")
expectEqual(WebPolicy.decide(nav("file:///Users/example/Desktop/%E6%8A%A5%E5%91%8A.pdf"), page: page), .cancel,
            "★拖进来没被网页接住的文件:WebKit 想把整页换成它 —— 不许(壳没有后退键)")
expectEqual(WebPolicy.decide(nav("file:///tmp/a.txt", main: false), page: page), .cancel, "iframe 里也不开本地文件")
expectEqual(WebPolicy.decide(nav("https://kimi.com/x", link: true), page: page), .openExternally(URL(string: "https://kimi.com/x")!),
            "★点外链(主框架、人点的)→ 交给默认浏览器,不把工作台换走")
expectEqual(WebPolicy.decide(nav("http://127.0.0.1:8791/files/a.bin", link: true), page: page),
            .openExternally(URL(string: "http://127.0.0.1:8791/files/a.bin")!), "端口不同就是别的源(8791 的文件链接也交给浏览器)")
expectEqual(WebPolicy.decide(nav("http://127.0.0.1:3080/sessions/1", link: true), page: page), .allow,
            "同源(DSH 自己的页)照常走")
expectEqual(WebPolicy.decide(nav("https://kimi.com/x", link: false), page: page), .allow,
            "脚本跳转 / 重载 / 重定向不拦(换令牌那一跳、热更新 reload 都走这里)")
expectEqual(WebPolicy.decide(nav("https://kimi.com/x", main: false, link: true), page: page), .allow,
            "iframe 里点链接不拦(自定义模块自己的事)")
expectEqual(WebPolicy.decide(nav("mailto:ben@example.com", link: true), page: page),
            .openExternally(URL(string: "mailto:ben@example.com")!), "mailto 交给邮件")
expectEqual(WebPolicy.decide(nav("x-apple.systempreferences:com.apple.preference.security", link: true), page: page),
            .openExternally(URL(string: "x-apple.systempreferences:com.apple.preference.security")!), "系统设置链接交给系统")
expectEqual(WebPolicy.decide(nav("weixin://dl/chat", link: true), page: page), .allow,
            "★不认的自定义协议不交给系统(聊天里的链接来自模型输出,不能随手拉起任意 App)")
expectEqual(WebPolicy.decide(nav(nil), page: page), .allow, "没有地址照常(about:blank 那一类)")
expectEqual(WebPolicy.decide(nav("about:blank", link: true), page: page), .allow, "about:blank 照常")

expectEqual(WebPolicy.newWindowTarget(URL(string: "https://www.kimi.com/")), URL(string: "https://www.kimi.com/"),
            "★target=_blank / window.open 的 http(s) → 交给默认浏览器(以前在壳里点了没反应)")
expectEqual(WebPolicy.newWindowTarget(URL(string: "http://127.0.0.1:3080/?token=abc")), URL(string: "http://127.0.0.1:3080/?token=abc"),
            "同源的新窗口也交给浏览器(壳没有标签页;「种一次 cookie」本来就是给浏览器种的)")
expectEqual(WebPolicy.newWindowTarget(URL(string: "about:blank")), nil, "先开空窗再往里写的那种不开")
expectEqual(WebPolicy.newWindowTarget(URL(string: "javascript:alert(1)")), nil, "javascript: 不开")
expectEqual(WebPolicy.newWindowTarget(URL(string: "file:///etc/passwd")), nil, "本地文件不开")
expectEqual(WebPolicy.newWindowTarget(URL(string: "vscode://file/x")), nil, "自定义协议不开")
expectEqual(WebPolicy.newWindowTarget(nil), nil, "没有地址不开")

expect(WebPolicy.responseIsDownload(canShowMIMEType: false, statusCode: 200, contentDisposition: nil), "网页显示不了的(压缩包)→ 下载")
expect(!WebPolicy.responseIsDownload(canShowMIMEType: true, statusCode: 200, contentDisposition: nil), "网页照常显示")
expect(WebPolicy.responseIsDownload(canShowMIMEType: true, statusCode: 200, contentDisposition: "attachment; filename=\"a.json\""),
       "★明说是附件的 json/txt 也下载 —— 不然工作台整页被换成那段文字")
expect(WebPolicy.responseIsDownload(canShowMIMEType: true, statusCode: 200, contentDisposition: "  Attachment"), "attachment 不分大小写")
expect(!WebPolicy.responseIsDownload(canShowMIMEType: true, statusCode: 200, contentDisposition: "inline; filename=a.pdf"), "inline 照常显示")
expect(!WebPolicy.responseIsDownload(canShowMIMEType: false, statusCode: 204, contentDisposition: nil), "204 本来就不换页,不落空文件")
expect(!WebPolicy.responseIsDownload(canShowMIMEType: false, statusCode: 404, contentDisposition: "attachment"), "出错的回应不当文件下")
expect(WebPolicy.responseIsDownload(canShowMIMEType: false, statusCode: nil, contentDisposition: nil), "blob:/data: 这类非 HTTP 的显示不了也下载")

expect(WebPolicy.sameOrigin(URL(string: "http://127.0.0.1:3080/a")!, page), "同协议同主机同端口 = 同源")
expect(WebPolicy.sameOrigin(URL(string: "https://kimi.com/a")!, URL(string: "https://KIMI.com:443/b")!), "缺省端口按协议补、主机不分大小写")
expect(!WebPolicy.sameOrigin(URL(string: "http://localhost:3080/")!, page), "localhost 与 127.0.0.1 不是同一个源(同浏览器口径)")

expectEqual(WebPolicy.openPanelOptions(for: .init(allowsMultipleSelection: true, allowsDirectories: false, allowedExtensions: [])),
            .init(canChooseFiles: true, canChooseDirectories: false, allowsMultipleSelection: true, allowedExtensions: []),
            "★输入框的 +(<input type=file multiple>,不限类型):能多选文件、不限类型")
expectEqual(WebPolicy.openPanelOptions(for: .init(allowsMultipleSelection: false, allowsDirectories: false, allowedExtensions: [".JSON", "json", " svg "])),
            .init(canChooseFiles: true, canChooseDirectories: false, allowsMultipleSelection: false, allowedExtensions: ["json", "svg"]),
            "accept 折成扩展名:去点、小写、去空白、去重")
expectEqual(WebPolicy.openPanelOptions(for: .init(allowsMultipleSelection: false, allowsDirectories: true, allowedExtensions: ["json"])),
            .init(canChooseFiles: false, canChooseDirectories: true, allowsMultipleSelection: false, allowedExtensions: []),
            "webkitdirectory:只给选文件夹、不按类型过滤(同 Chrome「上传文件夹」)")
expectEqual(WebPolicy.normalizedExtensions(["png", "*"]), [], "出现通配就当不限类型")
expectEqual(WebPolicy.normalizedExtensions(["image/*", "", "."]), [], "只剩空与 MIME 残片 = 不限")

var taken: Set<String> = []
expectEqual(WebPolicy.downloadFileName(suggested: "butler-swarm-v4.json") { taken.contains($0) }, "butler-swarm-v4.json", "不重名就用原名")
taken = ["butler-swarm-v4.json", "butler-swarm-v4 (1).json"]
expectEqual(WebPolicy.downloadFileName(suggested: "butler-swarm-v4.json") { taken.contains($0) }, "butler-swarm-v4 (2).json",
            "★重名依次加 (1) (2)…,永不覆盖已有文件(同 Safari / Chrome)")
taken = ["README"]
expectEqual(WebPolicy.downloadFileName(suggested: "README") { taken.contains($0) }, "README (1)", "没有扩展名也照样编号")
expectEqual(WebPolicy.sanitizedFileName("../../.ssh/id_rsa"), "_.._.ssh_id_rsa", "★去掉路径分隔、不许以点开头(不往别处写、不做隐藏文件)")
expectEqual(WebPolicy.sanitizedFileName("a:b\u{0}c\nd.txt"), "a_b_c_d.txt", "冒号、控制字符、换行换成下划线")
expectEqual(WebPolicy.sanitizedFileName("  "), "下载", "空名字叫「下载」")
expectEqual(WebPolicy.sanitizedFileName("报告👨‍💻.pdf"), "报告👨‍💻.pdf", "中文与带零宽连接符的表情原样保留")
expect(WebPolicy.sanitizedFileName(String(repeating: "长", count: 120) + ".pdf").utf8.count <= 200, "超长名字截短")
expect(WebPolicy.sanitizedFileName(String(repeating: "长", count: 120) + ".pdf").hasSuffix(".pdf"), "截短时保住扩展名")

expectEqual(WebPolicy.dialogMessage("  移除这台电脑?  "), "移除这台电脑?", "弹框标题是网页原话(去首尾空白)")
expectEqual(WebPolicy.dialogMessage(""), "工作台", "空消息不弹空框")

// ─── read_texts(2026-09-25,卡 O「额度要覆盖派活名单里的每一家」):只回命中的那一小段 ───
let quotaPatterns = SendTextPolicy.parseTextPatterns([
    ["id": "manus.credits", "regex": "^(?:[0-9][0-9,]*(?:\\.[0-9]+)?[KkMm]?|∞)$", "top": 80],
    ["id": "manus.empty", "regex": "积分已用完[^。]{0,30}重置|No credits left[^.]{0,40}"],
])
expect(quotaPatterns != nil, "patterns 合法就认(id + regex + 可选 top)")
let quotaNodes = [
    SendTextPolicy.TextNode(text: "给 Lapis 写周报 3 份", x: 20, y: 200),
    SendTextPolicy.TextNode(text: "3", x: 900, y: 30),
    SendTextPolicy.TextNode(text: "1,234", x: 1000, y: 30),
    SendTextPolicy.TextNode(text: "5,000", x: 500, y: 400),
    SendTextPolicy.TextNode(text: "  积分已用完，将于 9月26日 重置  ", x: 300, y: 600),
]
let quotaHits = SendTextPolicy.matchTexts(quotaNodes, patterns: quotaPatterns ?? [])
expectEqual(quotaHits.map { $0["text"] as? String ?? "" }, ["3", "1,234", "积分已用完，将于 9月26日 重置"],
            "★只回命中的那一小段:顶栏以外的数字不回,他的任务标题一个字都不回")
expectEqual(quotaHits.map { $0["id"] as? String ?? "" }, ["manus.credits", "manus.credits", "manus.empty"], "命中带回服务端给的 id")
expectEqual(quotaHits.map { $0["x"] as? Double ?? -1 }, [900, 1000, 300], "带位置(相对窗口左上角),服务端据此挑顶栏最右那一格")
expect(SendTextPolicy.parseTextPatterns([["id": "x", "regex": "("]]) == nil, "有一条正则不合法 → 整个不认(宁可不读)")
expect(SendTextPolicy.parseTextPatterns([] as [[String: Any]]) == nil, "空的不认")
expect(SendTextPolicy.parseTextPatterns(Array(repeating: ["id": "x", "regex": "a"], count: SendTextPolicy.readTextsMaxPatterns + 1)) == nil,
       "一次最多 \(SendTextPolicy.readTextsMaxPatterns) 条")
let longNode = [SendTextPolicy.TextNode(text: String(repeating: "长", count: 200), x: 0, y: 0)]
expect(SendTextPolicy.matchTexts(longNode, patterns: SendTextPolicy.parseTextPatterns([["id": "all", "regex": ".+"]]) ?? []).isEmpty,
       "★命中太长(一整段话)不回 —— 防一条宽正则把窗口里的字整段带出去")
let manyNodes = (0..<40).map { SendTextPolicy.TextNode(text: "\($0)", x: 0, y: 0) }
expectEqual(SendTextPolicy.matchTexts(manyNodes, patterns: SendTextPolicy.parseTextPatterns([["id": "n", "regex": "^[0-9]+$"]]) ?? []).count,
            SendTextPolicy.readTextsMaxMatches, "回几段封顶")
// ★ 卡 AG(2026-09-27):Antigravity 的「Models & Usage」一页上，光用量那几行就要
// 两条组名 + 一条页标题 + 四条限额名 + 四个百分比 + 两句刷新时间 = 13 段，还要 9 条正则才认得全。
// 上限低于这两个数，界面上就只能把两组并成一行（卡 QG 当时正是这样）。往回收要先改这一条。
expect(SendTextPolicy.readTextsMaxPatterns >= 12, "★一次至少收得下 12 条正则（Antigravity 的组名要第 9 条）")
expect(SendTextPolicy.readTextsMaxMatches >= 24, "★每扇窗至少回得了 24 段（Antigravity 的四行两组一段都不能挤掉）")
let antiNodes = [
    SendTextPolicy.TextNode(text: "Models & Usage", x: 600, y: 100),
    SendTextPolicy.TextNode(text: "Gemini Models", x: 600, y: 200),
    SendTextPolicy.TextNode(text: "Weekly Limit Remaining", x: 600, y: 300),
    SendTextPolicy.TextNode(text: "100%", x: 1200, y: 300),
    SendTextPolicy.TextNode(text: "Five Hour Limit Remaining", x: 600, y: 380),
    SendTextPolicy.TextNode(text: "98%", x: 1200, y: 380),
    SendTextPolicy.TextNode(text: "Claude and GPT models", x: 600, y: 460),
    SendTextPolicy.TextNode(text: "Weekly Limit Remaining", x: 600, y: 520),
    SendTextPolicy.TextNode(text: "100%", x: 1200, y: 520),
    SendTextPolicy.TextNode(text: "Five Hour Limit Remaining", x: 600, y: 600),
    SendTextPolicy.TextNode(text: "100%", x: 1200, y: 600),
]
let antiPatterns = SendTextPolicy.parseTextPatterns([
    ["id": "pct", "regex": "[0-9]{1,3}\\s*%"],
    ["id": "limit", "regex": "^[^\\n]{0,12}(?:Limits?)(?:[^\\n]{0,2}(?:Remaining))$"],
    ["id": "page", "regex": "^[A-Za-z][A-Za-z &]{0,11}Usage$"],
    ["id": "group", "regex": "^[A-Za-z][A-Za-z ]{0,26}[Mm]odels?$"],
])
expectEqual(SendTextPolicy.matchTexts(antiNodes, patterns: antiPatterns ?? []).count, 11,
            "★Antigravity 那一页的 11 段一段不落（老上限 12 段时，再多两句刷新时间就挤掉组名）")

// ─── 「还有几扇窗不在这会儿看着的桌面上」(2026-09-26,卡 MQ2)───
// 这一屏照着维护者那台机器上的 Muse 写:聊天窗 + 设置窗(两扇一样大、叠在一处)在眼前这个桌面上,
// 登录 / 欢迎那两扇老窗在另一个桌面上,外加一个小徽标和一层浮层。
func museWin(_ id: Int, _ layer: Int, _ w: Double, _ h: Double, _ onSpace: Bool) -> SendTextPolicy.OSWindow {
    SendTextPolicy.OSWindow(id: id, layer: layer, width: w, height: h, onSpace: onSpace)
}
let museScreen = [
    museWin(88791, 0, 1640, 945, true),    // 设置(「使用情况」页开着)
    museWin(76696, 0, 1640, 945, true),    // 聊天主窗
    museWin(76672, 0, 1200, 800, false),   // 欢迎:在别的桌面上
    museWin(76602, 0, 1200, 800, false),   // 登录:在别的桌面上
    museWin(86438, 103, 34, 18, false),    // 小徽标:不是一扇窗
    museWin(76695, 3, 520, 680, false),    // 浮层:不是一扇窗
]
expectEqual(SendTextPolicy.windowCount(museScreen), 4, "只把普通层、两边到 200pt 的算一扇窗(徽标 / 浮层不算)")
expectEqual(SendTextPolicy.offSpaceWindowCount(museScreen), 2,
            "★数的是「不在这会儿看着的桌面上的有几扇」——登录 / 欢迎那两扇;设置窗开在眼前就不算")
expectEqual(SendTextPolicy.offSpaceWindowCount(museScreen.filter { $0.onSpace }), 0,
            "都在眼前这个桌面上:一句「有窗在别的桌面上」都不说")
// 减法(系统说有几扇 − AX 读到几扇)会说错话的那一种:窗都在这个桌面上,只是 AX 不肯露其中一扇。
// 那时候减法会让工作台叫他去别的桌面找,而那边什么都没有 —— 数出来的这个数不会。
expectEqual(SendTextPolicy.offSpaceWindowCount([museWin(1, 0, 1200, 800, true), museWin(2, 0, 400, 300, true)]), 0,
            "★AX 少读了一扇、可窗都在眼前:不编出「在别的桌面上」这句话")
expectEqual(SendTextPolicy.offSpaceWindowCount([]), 0, "一扇窗都数不到:不说这句话")

// ─── 藏着的那一家:读之前放出来、读完藏回去(2026-09-26,卡 MQ3)───
// 维护者 18:50 看到 Muse、Manus 都成了「没接上」,点「读一下」什么都不变 —— 藏它的手正是工作台
// 自己的窗口槽,所以这一下由壳消化:放出来(不 activate)→ 等一拍 → 读 → 藏回去。
expect(SendTextPolicy.worthAnotherUnhideLook(windows: 0, looks: 1),
       "★放出来第一眼一扇窗都没露出来:再等一拍看一眼(AX 那张清单要一两秒才跟上)")
expect(!SendTextPolicy.worthAnotherUnhideLook(windows: 1, looks: 1),
       "★露出来一扇就别再等了 —— 读一下不该在他的电脑上白等两秒")
expect(!SendTextPolicy.worthAnotherUnhideLook(windows: 0, looks: SendTextPolicy.unhideMaxLooks),
       "看够几眼还是一扇都没有:停(放出来也读不到,服务端照实说那两句)")
expectEqual(SendTextPolicy.unhideMaxLooks * SendTextPolicy.unhideWaitMs, 2700,
            "最坏等 2.7 秒 —— 服务端给 read_texts 的是 8 秒,留得下(同卡 MQ 那笔预算)")
expect(SendTextPolicy.shouldRehide(wasHidden: true, isActive: false),
       "★本来藏着的读完照原样藏回去(工作台藏的、他自己 ⌘H 藏的,都一样恢复)")
expect(!SendTextPolicy.shouldRehide(wasHidden: false, isActive: false),
       "★本来没藏:一个手指头都不动它(读额度不许顺手藏掉他开着的窗)")
expect(!SendTextPolicy.shouldRehide(wasHidden: true, isActive: true),
       "★读的这一两秒里他自己点开了它:不藏回去 —— 从他手底下抽走窗比读不到额度坏得多")

// MARK: - 「键身上的字」也读:按家声明的那一格(2026-10-03,卡「Grok 读键字」)
//
// 真机量到的(10-03,`probe quota-keys com.anysphere.sand`):Grok Bot 的额度写在一颗键身上 ——
//     AXMenuItem (22,708) 220x30  ['SuperGrok 6%']
// 而 read_texts 按设计只收 `AXStaticText` 的 `AXValue`:同一刻整扇窗 89 块静态字、额度那几条
// 正则命中 **0**,连一个百分号都没有。所以那一格不是「没翻到那一页」,是那个数压根不在我们读的
// 那一类节点上。维护者 21:4x 拍板开这一格,**而且明说不能全局开**。
expect(!SendTextPolicy.readsTitle(role: "AXMenuItem", includeTitles: false),
       "★缺省一个都不收 —— 不给 `include_titles` 的那一趟与 2026-10-03 之前一字不差")
expect(!SendTextPolicy.readsTitle(role: "AXButton", includeTitles: false), "缺省那一趟连按钮的 title 也不收")
expect(SendTextPolicy.readsTitle(role: "AXMenuItem", includeTitles: true),
       "★声明过的那一家:菜单项身上那行字算数(Grok Bot 的「SuperGrok 6%」就是这一档)")
expect(SendTextPolicy.readsTitle(role: "AXButton", includeTitles: true), "按钮身上那行字同档")
expect(!SendTextPolicy.readsTitle(role: "AXGroup", includeTitles: true),
       "★`AXGroup` 不算:网页那层树里到处是它,收进来等于把满窗的字都当成界面文案")
expect(!SendTextPolicy.readsTitle(role: "AXPopUpButton", includeTitles: true),
       "★`AXPopUpButton` 不在这张表上:豆包那颗键身上写的是「<账号名> 标准套餐」—— 账号名是她的,收它只会给额度那几条正则送去一行只对她这一台机器成立的字(没量到的不写)")
expect(!SendTextPolicy.titleRoles.contains("AXStaticText"),
       "静态字不进这张表(它那条路本来就收 `AXValue`,收两遍只会让同一行命中两次)")
expect(SendTextPolicy.titleRoles.count == 2,
       "★这张表只放量到过的那两档 —— 它每多一档,Muse / 豆包那条「整格静态字」的旁证就多一分被一颗同名的键骗过去的机会(卡 MQ 的老教训:假阳性比读不到坏)")
expect(SendTextPolicy.inputRoles.isDisjoint(with: SendTextPolicy.titleRoles),
       "★输入框那几档一个都不在这张表上(她打了一半的字一个都不读,这条线一个字没动)")

// MARK: - 悬停只认真拖(2026-09-25,卡 P:「窗口槽的流线光效时不时自己闪一下,其实没拖新应用进去」)
let hoverZoneRect = CGRect(x: 195, y: 195, width: 1640, height: 868)
let slotSizedWindow = CGRect(x: 195, y: 195, width: 1640, height: 868)
expect(DragTracker.hovering(slotSizedWindow, zone: hoverZoneRect, pressed: true), "★按着左键把窗拖进圈:算悬停")
expect(!DragTracker.hovering(slotSizedWindow, zone: hoverZoneRect, pressed: false),
       "★没人按着(点标签时我们自己把窗摆进槽、应用自己缩放、截图把藏着的放出来):不算悬停,不亮光")
expect(!DragTracker.hovering(slotSizedWindow, zone: nil, pressed: true), "没有圈就没有悬停")

// MARK: - ActivationSense:被叫出来是「真切过去」还是「临时叫一下」(2026-09-25,卡 P)
//
// 维护者:「每次使用截图,都会把企业微信显示出来,预期应该是保持页面不变,这个机制应该对其他有截图能力的
// APP 都是一个逻辑」。真机实测(09-25):企业微信截图**不激活**自己,只把自己放出来 + 每块屏盖一扇层级 103 的遮罩;
// 截完它仍然放着,摆在窗口槽位置上的主窗就盖了出来。系统截图不激活、不放出任何一家。

let mainDisplay = CGRect(x: 0, y: 0, width: 2560, height: 1440)
let sideDisplay = CGRect(x: -1440, y: 0, width: 1440, height: 2560)
let displays = [mainDisplay, sideDisplay]
// 真机量到的样子:企业微信主窗(窗口槽里)、遮罩(层级 103,每块屏一扇)、跟着鼠标的尺寸标签(100×18)
let wecomMain = ActivationWindow(number: 101, layer: 0, frame: CGRect(x: 195, y: 195, width: 1640, height: 868), alpha: 1)
let wecomShotMain = ActivationWindow(number: 201, layer: 103, frame: mainDisplay, alpha: 1)
let wecomShotSide = ActivationWindow(number: 202, layer: 103, frame: sideDisplay, alpha: 1)
let wecomSizeTag = ActivationWindow(number: 203, layer: 103, frame: CGRect(x: 1913, y: 1385, width: 100, height: 18), alpha: 1)
let fullOverlayLayer0 = ActivationWindow(number: 204, layer: 0, frame: mainDisplay, alpha: 1)
let floatingPanel = ActivationWindow(number: 205, layer: 3, frame: CGRect(x: 800, y: 300, width: 420, height: 260), alpha: 1)
let menuExtra = ActivationWindow(number: 206, layer: 25, frame: CGRect(x: 1700, y: 0, width: 30, height: 24), alpha: 1)
let desktopLevel = ActivationWindow(number: 207, layer: -1, frame: CGRect(x: 0, y: 30, width: 2560, height: 1410), alpha: 1)

// ── 哪扇算遮罩 ──
expectEqual(ActivationSense.classify(windows: [wecomSizeTag, wecomShotMain, wecomShotSide, wecomMain], displays: displays, focusedSubrole: nil),
            .overlay(wecomShotMain, reason: "层级 103"), "★企业微信截图:尺寸标签太小不算,最前面那扇是层级 103 的遮罩")
expectEqual(ActivationSense.classify(windows: [menuExtra, wecomMain], displays: displays, focusedSubrole: nil), .ordinary(wecomMain),
            "菜单栏小图标(30×24)不算它的窗,看下一扇")
expectEqual(ActivationSense.classify(windows: [menuExtra], displays: displays, focusedSubrole: nil), .none, "只剩菜单栏小图标 = 没有窗")
expectEqual(ActivationSense.classify(windows: [desktopLevel], displays: displays, focusedSubrole: nil), .none,
            "压在普通窗口下面的(层级 -1,工作台桌面档那种)不算盖上来的")
expectEqual(ActivationSense.classify(windows: [floatingPanel, wecomMain], displays: displays, focusedSubrole: nil),
            .overlay(floatingPanel, reason: "层级 3"), "★浮在上面的小面板(划词、快捷面板)= 遮罩")
expectEqual(ActivationSense.classify(windows: [fullOverlayLayer0, wecomMain], displays: displays, focusedSubrole: nil),
            .overlay(fullOverlayLayer0, reason: "铺满整块屏"), "★普通层、但正好盖住一整块屏(连菜单栏)= 遮罩(AX 读不了时)")
expectEqual(ActivationSense.classify(windows: [fullOverlayLayer0], displays: displays, focusedSubrole: "AXStandardWindow"),
            .ordinary(fullOverlayLayer0), "铺满整块屏但 AX 说是标准窗口(原生全屏)= 普通窗口")
expectEqual(ActivationSense.classify(windows: [wecomMain], displays: displays, focusedSubrole: "AXUnknown"),
            .overlay(wecomMain, reason: "子角色 AXUnknown"), "AX 读得到、子角色不是标准窗口(无边框)= 遮罩")
expectEqual(ActivationSense.classify(windows: [wecomMain], displays: displays, focusedSubrole: nil), .ordinary(wecomMain),
            "普通层、没铺满、AX 读不了(企业微信常态)= 普通窗口")
expect(ActivationSense.related("com.tencent.WeWorkMac", "com.tencent.WeWorkMac.ScreenCapture"), "子程序算同一家")
expect(!ActivationSense.related("com.tencent.WeWorkMac", "com.tencent.xinWeChat"), "企业微信与微信不是同一家")

// ── ① 企业微信截图(真机那一串):被放出来、不激活 → 遮罩 → 截完露出主窗 → 临时叫一下 ──
var activation = ActivationTracker()
expectEqual(activation.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 188.2), [], "被放出来那一刻不下结论")
expectEqual(activation.sample(pid: 736, at: 188.35, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103")), [],
            "★焦点一直在工作台(没被激活)也照看它的窗:遮罩在")
expectEqual(activation.sample(pid: 736, at: 230, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103")), [],
            "★遮罩开着多久都不算完(他在框选)")
expectEqual(activation.sample(pid: 736, at: 259.5, frontmostPid: 82857, kind: .ordinary(wecomMain)),
            [.transient(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, reason: .overlay, dwellMs: 71300,
                        overlay: wecomShotMain, overlayReason: "层级 103", front: wecomMain)],
            "★截完了、露出来的是它的主窗 → 临时叫一下(服务端据此把它藏回去)")
expect(activation.episodes.isEmpty, "下了结论就不再看")

// ② 我们自己摆回窗口(放出来、不激活、没有遮罩):看 3 秒,不下结论
activation = ActivationTracker()
_ = activation.unhidden(bundleId: "com.anthropic.claudefordesktop", pid: 58614, at: 10)
expectEqual(activation.sample(pid: 58614, at: 10.2, frontmostPid: 82857, kind: .ordinary(wecomMain)), [], "放出来的是普通窗口:先看着")
expectEqual(activation.sample(pid: 58614, at: 13.1, frontmostPid: 82857, kind: .ordinary(wecomMain)), [],
            "★没遮罩、没激活:3 秒后不看了,也不下结论(不替他动窗口)")
expect(activation.episodes.isEmpty, "不下结论也收掉这一趟")

// ③ 点标签切换(我们放出来 + 激活)、⌘Tab 切到微信并停留 → 真切过去
let wechatMain = ActivationWindow(number: 301, layer: 0, frame: CGRect(x: 195, y: 195, width: 1640, height: 868), alpha: 1)
activation = ActivationTracker()
_ = activation.unhidden(bundleId: "com.tencent.xinWeChat", pid: 733, at: 200)
_ = activation.activated(bundleId: "com.tencent.xinWeChat", pid: 733, at: 200.05, wasHidden: true, previous: "com.anthropic.claudefordesktop")
expectEqual(activation.sample(pid: 733, at: 200.2, frontmostPid: 733, kind: .ordinary(wechatMain)), [], "普通窗口刚露:还没待够")
expectEqual(activation.sample(pid: 733, at: 201.0, frontmostPid: 733, kind: .ordinary(wechatMain)), [], "待了不到 1.5 秒:还不算")
expectEqual(activation.sample(pid: 733, at: 201.8, frontmostPid: 733, kind: .ordinary(wechatMain)),
            [.switched(bundleId: "com.tencent.xinWeChat", wasHidden: true, previous: "com.anthropic.claudefordesktop", dwellMs: 1800, window: wechatMain)],
            "★先放出来再激活:接着那一趟算,普通窗口待满 1.5 秒 → 真切过去(服务端:自己点的标签 = 抑制期内,不重复切)")

// ④ ⌘Tab 过去又马上切回来 → 临时
activation = ActivationTracker()
_ = activation.activated(bundleId: "com.tencent.xinWeChat", pid: 733, at: 300, wasHidden: true, previous: nil)
_ = activation.sample(pid: 733, at: 300.15, frontmostPid: 733, kind: .ordinary(wechatMain))
expectEqual(activation.sample(pid: 733, at: 300.9, frontmostPid: 999, kind: .none),
            [.transient(bundleId: "com.tencent.xinWeChat", wasHidden: true, previous: nil, reason: .quickReturn, dwellMs: 900,
                        overlay: nil, overlayReason: nil, front: wechatMain)],
            "★1.5 秒内焦点就回去了 → 不算切过去")

// ⑤ 另一家被激活:被激活的那一趟按「焦点走了」收;只被放出来的那一趟(截图遮罩)不受影响,接着看
activation = ActivationTracker()
_ = activation.activated(bundleId: "com.tencent.xinWeChat", pid: 733, at: 400, wasHidden: false, previous: nil)
_ = activation.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 400.1)
_ = activation.sample(pid: 736, at: 400.3, frontmostPid: 733, kind: .overlay(wecomShotMain, reason: "层级 103"))
let pushed = activation.activated(bundleId: "com.apple.finder", pid: 555, at: 400.5, wasHidden: false, previous: "com.tencent.xinWeChat")
expectEqual(pushed, [.transient(bundleId: "com.tencent.xinWeChat", wasHidden: false, previous: nil, reason: .noWindow, dwellMs: 500,
                                overlay: nil, overlayReason: nil, front: nil)],
            "新的一家被激活:上一趟被激活的还没结论,按「没露窗就走了」收")
expect(activation.episodes[736] != nil, "★企业微信那一趟(只被放出来)照看不误")
expectEqual(activation.focusLeft(at: 401).count, 1, "工作台被点到前面:只收被激活的那几趟")
expect(activation.episodes[736] != nil && activation.episodes[555] == nil, "只被放出来的那一趟还在看")

// ⑥ 截图小程序做完把焦点交给主程序(同一家的子程序)→ 接着那一趟算,主程序露出来的普通窗口不算切过去
activation = ActivationTracker()
_ = activation.activated(bundleId: "com.tencent.WeWorkMac.ScreenCapture", pid: 900, at: 500, wasHidden: false, previous: "ai.ben.workbench")
_ = activation.sample(pid: 900, at: 500.2, frontmostPid: 900, kind: .overlay(wecomShotMain, reason: "层级 103"))
_ = activation.activated(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 503, wasHidden: true, previous: "com.tencent.WeWorkMac.ScreenCapture")
expectEqual(activation.sample(pid: 736, at: 503.2, frontmostPid: 736, kind: .ordinary(wecomMain)).first.map { verdict -> Bool in
    if case .transient(let bundle, let hidden, _, let reason, _, _, _, _) = verdict { return bundle == "com.tencent.WeWorkMac" && hidden && reason == .overlay }
    return false
}, true, "★子程序遮罩收了、2 秒内主程序被叫出来:算同一趟截图(临时),不跟过去")
// 不相干的另一家(快捷面板里点开了企业微信):不接着算
activation = ActivationTracker()
_ = activation.activated(bundleId: "com.raycast.macos", pid: 910, at: 600, wasHidden: false, previous: nil)
_ = activation.sample(pid: 910, at: 600.2, frontmostPid: 910, kind: .overlay(floatingPanel, reason: "层级 3"))
_ = activation.activated(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 601, wasHidden: true, previous: "com.raycast.macos")
_ = activation.sample(pid: 736, at: 601.2, frontmostPid: 736, kind: .ordinary(wecomMain))
expectEqual(activation.sample(pid: 736, at: 602.8, frontmostPid: 736, kind: .ordinary(wecomMain)).count, 1, "快捷面板里点开的另一家:照常待满 1.5 秒就算切过去")
expectEqual(activation.nextDelay(at: 700), nil, "没有在看的一趟就不排下一次采样(不是常驻定时器)")
_ = activation.unhidden(bundleId: "com.tencent.xinWeChat", pid: 733, at: 800)
expectEqual(activation.nextDelay(at: 801), 0.25, "前 3 秒 0.25 秒一次")
expectEqual(activation.nextDelay(at: 805), 1, "之后 1 秒一次")
// 遮罩收了、它自己又藏回去了(整家没窗):不用再藏,不下结论
activation = ActivationTracker()
_ = activation.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 900)
_ = activation.sample(pid: 736, at: 900.2, frontmostPid: 1, kind: .overlay(wecomShotMain, reason: "层级 103"))
expectEqual(activation.sample(pid: 736, at: 905, frontmostPid: 1, kind: .none), [], "遮罩收了、它自己又藏回去:什么都不用做")
expect(activation.episodes.isEmpty, "这一趟收掉")

// ── ⑦ 遮罩一收就当场藏回去(2026-09-25 卡 P 补)──
// 统筹:「截图遮罩一关,立刻把被掀出来的那个窗位 App 藏回去,不等 1.5 秒判定窗口结束,让『窗口闪一下』尽量看不见。
// 判定逻辑不变:真切换还是按 1.5 秒算。」遮罩开着时壳每 30 毫秒问一句那扇遮罩还在不在;服务端预约过的,
// 遮罩一收那一拍就在壳里藏,不再绕服务端一圈。
activation = ActivationTracker()
var arms = RehideArms()
_ = activation.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 1000)
expectEqual(activation.sample(pid: 736, at: 1000.15, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103")), [],
            "遮罩开了:还不是结论")
let opened = activation.takeOpenedOverlays()
expectEqual(opened.map { $0.bundleId }, ["com.tencent.WeWorkMac"], "★第一次看到遮罩就报一句「遮罩开了」(服务端据此预约藏回去)")
expectEqual(opened.first?.wasHidden, true, "报的时候带上「被叫出来之前是藏着的」")
expectEqual(activation.takeOpenedOverlays(), [], "取了就清")
_ = activation.sample(pid: 736, at: 1000.4, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103"))
expectEqual(activation.takeOpenedOverlays(), [], "同一趟遮罩只报一次")
expectEqual(activation.showingOverlays, [736: 201], "★遮罩开着:壳盯着那一扇遮罩(窗号 201)")
expect(ActivationTracker.overlayPoll <= 0.05, "★遮罩开着时问得够勤(不超过 50 毫秒;原来 3 秒以后 1 秒才整看一次)")
expect(arms.arm("com.tencent.WeWorkMac", overlayShowing: true), "服务端预约:遮罩开着,收下")
_ = activation.sample(pid: 736, at: 1030, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103"))
let closed = activation.sample(pid: 736, at: 1030.03, frontmostPid: 82857, kind: .ordinary(wecomMain))
expectEqual(closed, [.transient(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, reason: .overlay, dwellMs: 30030,
                                overlay: wecomShotMain, overlayReason: "层级 103", front: wecomMain)],
            "★框选了 30 秒,遮罩一收那一拍就下结论(不等 1.5 秒、不等这一趟结束)")
expect(arms.take(closed[0]), "★预约过:壳当场藏回去")
expect(!arms.take(closed[0]), "一次预约只藏一次")
expect(activation.showingOverlays.isEmpty && activation.episodes.isEmpty, "下了结论就不再盯")

let shotDone: ActivationTracker.Verdict = .transient(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, reason: .overlay,
                                                     dwellMs: 5000, overlay: wecomShotMain, overlayReason: "层级 103", front: wecomMain)
var late = RehideArms()
expect(!late.arm("com.tencent.WeWorkMac", overlayShowing: false), "遮罩已经收了的迟到预约不收(那一趟走服务端那条路)")
_ = late.arm("com.tencent.WeWorkMac", overlayShowing: true)
late.cancel("com.tencent.WeWorkMac")
expect(!late.take(shotDone), "★服务端要露出它(点标签切过去 / 摆回窗位):预约作废,不把他刚切过去的那一家藏掉")
late = RehideArms()
_ = late.arm("com.tencent.WeWorkMac", overlayShowing: true)
expect(!late.take(.switched(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, dwellMs: 1600, window: wecomMain)),
       "真切过去的不藏(判定照旧按 1.5 秒)")
expect(!late.take(.transient(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, reason: .quickReturn, dwellMs: 600,
                             overlay: nil, overlayReason: nil, front: wecomMain)), "不是「遮罩收了」的临时叫一下:不在壳里藏(走服务端)")
expect(!late.take(.transient(bundleId: "com.tencent.WeWorkMac", wasHidden: false, previous: nil, reason: .overlay, dwellMs: 600,
                             overlay: wecomShotMain, overlayReason: "层级 103", front: wecomMain)), "被叫出来之前就露着的:不藏")
expect(late.take(.transient(bundleId: "com.tencent.WeWorkMac.ScreenCapture", wasHidden: true, previous: nil, reason: .overlay, dwellMs: 600,
                            overlay: wecomShotMain, overlayReason: "层级 103", front: wecomMain)), "同一家的子程序的结论也认")
late = RehideArms()
_ = late.arm("com.tencent.WeWorkMac", overlayShowing: true)
late.keep(only: ["com.tencent.xinWeChat"])
expect(late.armed.isEmpty, "这一趟结束了(遮罩收了、它自己又藏回去,没有结论):预约作废")

// MARK: - NotifyPolicy(2026-09-25,卡 M:事务官有话问你 / 要你批一件事,壳不在前台时弹系统通知)

let notifyAway = NotifyPolicy.decide(key: "question:q-1", title: "事务官有话问你", body: "「这个有点问题」派活前对一遍", appActive: false)
expect(notifyAway.show, "★壳不在前台:弹")
expectEqual(notifyAway.identifier, "ben-wb-ask-question:q-1", "通知标识带着 key(同一问只留一条)")
expectEqual(notifyAway.title, "事务官有话问你", "标题原样")
let notifyFront = NotifyPolicy.decide(key: "question:q-1", title: "事务官有话问你", body: "x", appActive: true)
expect(!notifyFront.show, "★壳在前台:不弹(球下那一区已经有那张卡了)")
expectEqual(notifyFront.reason, "工作台在前台", "不弹的原因回给服务端")
expect(!NotifyPolicy.decide(key: "", title: "t", body: "b", appActive: false).show, "没有 key 不弹")
expect(!NotifyPolicy.decide(key: "k", title: "   ", body: "b", appActive: false).show, "空标题不弹(不弹一条空通知)")
expectEqual(NotifyPolicy.decide(key: "k", title: "t", body: String(repeating: "字", count: 200), appActive: false).body.count, NotifyPolicy.bodyMax + 1, "正文太长截短加「…」")
expectEqual(NotifyPolicy.key(fromUserInfo: ["ben_wb_key": "approval:a-1"]), "approval:a-1", "点了通知认得出是哪一张")
expect(NotifyPolicy.key(fromUserInfo: ["other": 1]) == nil, "不是我们的通知不认")
// 没允许之前优雅退化(卡 M 追加,统筹):他没点「允许」/ 关掉了 → 不弹、说清原因,不报错;还没问过 → 照常判(真弹前问一次)。
let notifyDenied = NotifyPolicy.decide(key: "question:q-1", title: "事务官有话问你", body: "x", appActive: false, permission: .denied)
expect(!notifyDenied.show, "★通知没开:不弹(工作台里的气泡照旧)")
expect(notifyDenied.reason?.contains("通知没开") == true, "不弹的原因回给服务端")
expect(NotifyPolicy.decide(key: "question:q-1", title: "t", body: "b", appActive: false, permission: .notDetermined).show, "还没问过他:照常判,真弹之前壳去问一次")
expect(NotifyPolicy.decide(key: "question:q-1", title: "t", body: "b", appActive: false, permission: .allowed).show, "允许了:弹")
expectEqual(NotifyPolicy.decide(key: "question:q-1", title: "t", body: "b", appActive: true, permission: .denied).reason, "工作台在前台", "在前台时先说在前台(不是没开通知)")
// 回给服务端的那一条(卡 M 补:以前静默失败):授权那个词、交的哪一张、系统收没收、没收的原话。
let notifyOk = NotifyPolicy.statusPayload(permission: .allowed, key: "question:q-1", ok: true, at: Date(timeIntervalSince1970: 0))
expectEqual(notifyOk["kind"] as? String, "notify_status", "回的是 notify_status")
expectEqual(notifyOk["permission"] as? String, "allowed", "授权那个词")
expectEqual(notifyOk["key"] as? String, "question:q-1", "交的哪一张")
expectEqual(notifyOk["ok"] as? Bool, true, "系统收下了")
expect(notifyOk["error"] == nil, "收下了就没有原话")
let notifyFail = NotifyPolicy.statusPayload(permission: .denied, key: "k", ok: false, error: "系统没让工作台发通知")
expectEqual(notifyFail["permission"] as? String, "denied", "没开")
expectEqual(notifyFail["error"] as? String, "系统没让工作台发通知", "没收的原话带上")
expectEqual(NotifyPolicy.statusPayload(permission: .notDetermined)["permission"] as? String, "not_determined", "还没问过")
expect(NotifyPolicy.statusPayload(permission: .unknown)["key"] == nil, "只报授权时没有 key")

// ── ⑧ 遮罩收起那一拍,最前面是他原来的窗口(2026-09-25 卡 P 补二)──
// 维护者 0.3.0 真壳:「截图我做了验证,没彻底解决,但是比之前好,还是会闪一下企业微信,然后恢复之前的页面」。
// 统筹:「问题在遮罩底下,那一刻最前面已经是企业微信主窗口。遮罩一收,它先被看见,藏回才生效。所以『收了再藏』再快也会闪」。
// 现在:遮罩还开着(预约收下那一刻)就把它的普通窗口挪到屏外;遮罩一收露出来的是他原来的窗口;藏好之后再挪回原位。

// 挪到哪:维护者那两块屏(主屏 2560×1440、左边一块竖屏 1440×2560),主屏右下角外面,只留 1 像素
let slotRect = CGRect(x: 195, y: 195, width: 1496, height: 868)
let parkedAt = ActivationSense.parkOrigin(size: slotRect.size, displays: displays)
expectEqual(parkedAt, CGPoint(x: 2559, y: 1439), "★挪到主屏右下角外面(不压左边那块竖屏)")
expect(ActivationSense.exposedArea(CGRect(origin: parkedAt ?? .zero, size: slotRect.size), displays: displays) <= 1.5,
       "挪完在各块屏上只露 1 个像素")
// 右边有一块更高的屏:右下角会压到它 → 换一个角,照样只露 1 个像素
let tallRight = [mainDisplay, CGRect(x: 2560, y: 0, width: 1440, height: 2560)]
let parkedTall = ActivationSense.parkOrigin(size: slotRect.size, displays: tallRight)
expect(parkedTall != nil && parkedTall != CGPoint(x: 2559, y: 1439), "右边那块屏更高:不用会压到它的右下角")
expect(ActivationSense.exposedArea(CGRect(origin: parkedTall ?? .zero, size: slotRect.size), displays: tallRight) <= 1.5,
       "换的那个角同样只露 1 个像素")
// 挪哪几扇:只挪它的普通窗口;遮罩(层级 103)、尺寸标签(太小)不动 —— 挪了遮罩截图就花了
let shotMain = ActivationWindow(number: 101, layer: 0, frame: slotRect, alpha: 1)
expectEqual(ActivationSense.windowsToPark([wecomSizeTag, wecomShotMain, wecomShotSide, shotMain], displays: displays), [shotMain],
            "★只挪它的普通窗口,遮罩与尺寸标签一扇不动")
expectEqual(ActivationSense.windowsToPark([fullOverlayLayer0], displays: displays), [], "普通层但盖满整块屏的那扇是遮罩:不挪")

/// 一块假屏:窗按前后排(同一层里排前面的在上;层级高的永远在上),问某一点最上面露着的是谁的窗。
struct FakeWindow {
    let owner: String
    var frame: CGRect
    let layer: Int
    var shown: Bool
}
func topmost(_ windows: [FakeWindow], at point: CGPoint) -> String? {
    let ordered = windows.enumerated().sorted { a, b in
        a.element.layer != b.element.layer ? a.element.layer > b.element.layer : a.offset < b.offset
    }
    return ordered.first { $0.element.shown && $0.element.frame.contains(point) }?.element.owner
}
let slotCenter = CGPoint(x: slotRect.midX, y: slotRect.midY)

/// 企业微信 ⌘⇧A 那一串,窗口槽当前是 `current`(外家 App 的窗在槽里,或者 nil = 工作台自己那一页在台前)。
/// `park`:照这次的改法遮罩底下挪开;false = 上一版(遮罩一收再藏)。回遮罩收起那一拍、槽中间最上面是谁。
func screenshotReveal(current: String?, park: Bool) -> (atReveal: String?, afterRehide: String?, restored: CGRect?) {
    var screen: [FakeWindow] = []
    if let current { screen.append(FakeWindow(owner: current, frame: slotRect, layer: 0, shown: true)) }
    screen.append(FakeWindow(owner: "企业微信", frame: slotRect, layer: 0, shown: false))          // 窗口槽成员,藏着
    screen.append(FakeWindow(owner: "工作台", frame: mainDisplay, layer: -1, shown: true))        // 桌面档
    // ⌘⇧A:企业微信被放出来(它的主窗排到普通层最前面)+ 每块屏一扇遮罩
    let wecomIndex = screen.firstIndex { $0.owner == "企业微信" }!
    var wecom = screen.remove(at: wecomIndex)
    wecom.shown = true
    screen.insert(wecom, at: 0)
    screen.append(FakeWindow(owner: "企业微信遮罩", frame: mainDisplay, layer: 103, shown: true))
    screen.append(FakeWindow(owner: "企业微信遮罩", frame: sideDisplay, layer: 103, shown: true))

    var tracker = ActivationTracker()
    var guardian = RehideArms()
    _ = tracker.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 0)
    _ = tracker.sample(pid: 736, at: 0.01, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103"))
    // 服务端预约(它是成员、不在台前、原来藏着)→ 壳收下就挪
    if park, guardian.arm("com.tencent.WeWorkMac", overlayShowing: !tracker.showingOverlays.isEmpty), guardian.beginPark("com.tencent.WeWorkMac") {
        let toPark = ActivationSense.windowsToPark([wecomShotMain, wecomShotSide, shotMain], displays: displays)
        var parkedWindows: [ParkedWindow] = []
        for window in toPark {
            let origin = ActivationSense.parkOrigin(size: window.frame.size, displays: displays)!
            if let i = screen.firstIndex(where: { $0.owner == "企业微信" && $0.frame == window.frame }) { screen[i].frame.origin = origin }
            parkedWindows.append(ParkedWindow(original: window.frame, parkedAt: origin))
        }
        _ = guardian.didPark("com.tencent.WeWorkMac", parkedWindows)
    }
    else if !park {
        _ = guardian.arm("com.tencent.WeWorkMac", overlayShowing: true)
    }
    // 他框选了 3 秒、截完:遮罩收起
    _ = tracker.sample(pid: 736, at: 3.0, frontmostPid: 82857, kind: .overlay(wecomShotMain, reason: "层级 103"))
    for i in screen.indices where screen[i].owner == "企业微信遮罩" { screen[i].shown = false }
    let atReveal = topmost(screen, at: slotCenter)                                              // ★ 遮罩收起那一拍
    // 壳的下一拍看到遮罩没了 → 临时叫一下 → 当场藏 → 藏好(didHide)→ 挪回原位
    let wecomNow = screen.first { $0.owner == "企业微信" }!
    let verdicts = tracker.sample(pid: 736, at: 3.02, frontmostPid: 82857,
                                  kind: .ordinary(ActivationWindow(number: 101, layer: 0, frame: wecomNow.frame, alpha: 1)))
    var restored: CGRect?
    if let verdict = verdicts.first, guardian.take(verdict) {
        for i in screen.indices where screen[i].owner == "企业微信" { screen[i].shown = false }
        for one in guardian.didHide("com.tencent.WeWorkMac") {
            if let i = screen.firstIndex(where: { $0.owner == "企业微信" }) { screen[i].frame.origin = one.original.origin }
        }
        restored = screen.first { $0.owner == "企业微信" }?.frame
    }
    return (atReveal, topmost(screen, at: slotCenter), restored)
}

let withClaude = screenshotReveal(current: "Claude", park: true)
expectEqual(withClaude.atReveal, "Claude", "★遮罩收起那一拍,窗口槽里最上面是他原来的窗口(Claude),不是企业微信主窗口")
expectEqual(withClaude.afterRehide, "Claude", "藏回之后还是 Claude")
expectEqual(withClaude.restored, slotRect, "★藏好之后企业微信的窗挪回原位(藏着挪,下次点它的标签还在窗口槽里)")
let withButler = screenshotReveal(current: nil, park: true)
expectEqual(withButler.atReveal, "工作台", "★台前是工作台自己那一页时:遮罩收起那一拍露出来的是工作台")
let before = screenshotReveal(current: "Claude", park: false)
expectEqual(before.atReveal, "企业微信", "(对照)上一版:遮罩收起那一拍最前面是企业微信主窗口 —— 维护者看到的那一下闪")

// 挪与藏的先后:挪是在另一条队列上做的,「挪完」可能晚于「藏好」
var order = RehideArms()
let shotVerdict: ActivationTracker.Verdict = .transient(bundleId: "com.tencent.WeWorkMac", wasHidden: true, previous: nil, reason: .overlay,
                                                        dwellMs: 3000, overlay: wecomShotMain, overlayReason: "层级 103", front: shotMain)
let parkedOne = [ParkedWindow(original: slotRect, parkedAt: CGPoint(x: 2559, y: 1439))]
_ = order.arm("com.tencent.WeWorkMac", overlayShowing: true)
expect(order.beginPark("com.tencent.WeWorkMac"), "收下预约就去挪")
expect(!order.beginPark("com.tencent.WeWorkMac"), "只挪一次")
expect(order.take(shotVerdict), "遮罩收了:当场藏")
expectEqual(order.didHide("com.tencent.WeWorkMac"), [], "藏好了但还在挪:先不挪回")
expect(order.pending("com.tencent.WeWorkMac"), "还等着挪完")
expectEqual(order.didPark("com.tencent.WeWorkMac", parkedOne), parkedOne, "★挪完的时候已经藏好了:当场挪回")
expect(!order.pending("com.tencent.WeWorkMac"), "这一条收掉")
// 服务端在挪的时候要露出它(点标签切到企业微信):作废;挪完的窗当场交回来挪回
order = RehideArms()
_ = order.arm("com.tencent.WeWorkMac", overlayShowing: true)
_ = order.beginPark("com.tencent.WeWorkMac")
expectEqual(order.cancel("com.tencent.WeWorkMac"), [:], "还在挪:没有要挪回的")
expectEqual(order.didPark("com.tencent.WeWorkMac", parkedOne), parkedOne, "★挪完发现已经作废:当场挪回,不留在屏外")
// 挪完了才作废:cancel 直接交回
order = RehideArms()
_ = order.arm("com.tencent.WeWorkMac", overlayShowing: true)
_ = order.beginPark("com.tencent.WeWorkMac")
_ = order.didPark("com.tencent.WeWorkMac", parkedOne)
expectEqual(order.cancel("com.tencent.WeWorkMac"), ["com.tencent.WeWorkMac": parkedOne], "服务端要露出它:挪走的窗交回挪回")
// 这一趟没结论就结束了(遮罩收了、它自己又藏回去):预约作废,挪走的窗交回
order = RehideArms()
_ = order.arm("com.tencent.WeWorkMac", overlayShowing: true)
_ = order.beginPark("com.tencent.WeWorkMac")
_ = order.didPark("com.tencent.WeWorkMac", parkedOne)
expectEqual(order.keep(only: []), ["com.tencent.WeWorkMac": parkedOne], "一趟结束了:挪走的窗交回")
// 藏了却一直没藏好(它不肯藏):不再等,也不挪回
order = RehideArms()
_ = order.arm("com.tencent.WeWorkMac", overlayShowing: true)
_ = order.beginPark("com.tencent.WeWorkMac")
_ = order.didPark("com.tencent.WeWorkMac", parkedOne)
_ = order.take(shotVerdict)
order.keep(only: [])
expect(order.pending("com.tencent.WeWorkMac"), "藏了、在等藏好:一趟结束也不收")
expectEqual(order.forget("com.tencent.WeWorkMac"), parkedOne, "不肯藏的:不再等;挪走的窗交出来记着(它还露着,不当场挪回)")
expect(!order.pending("com.tencent.WeWorkMac"), "这一条收掉")

// 开头那一下:被掀出来之后 0.3 秒内、还没看到遮罩,10 毫秒看一次
activation = ActivationTracker()
_ = activation.unhidden(bundleId: "com.tencent.WeWorkMac", pid: 736, at: 2000)
expectEqual(activation.nextDelay(at: 2000.05), ActivationTracker.startPoll, "★掀出来之后先 10 毫秒看一次(量开头那一下露没露)")
_ = activation.sample(pid: 736, at: 2000.06, frontmostPid: 1, kind: .overlay(wecomShotMain, reason: "层级 103"))
expectEqual(activation.nextDelay(at: 2000.07), 0.25, "看到遮罩了:回到平常那一拍(遮罩那边另有 30 毫秒的轻量一问)")

// 时间线:记第一次、报离开头多少毫秒
var timeline = ActivationTimeline(startedAt: 100)
timeline.mark("unhide", at: 100)
timeline.mark("overlay_on", at: 100.012)
timeline.mark("overlay_on", at: 100.5)
timeline.mark("parked", at: 100.2)
timeline.count("parked", 1)
expectEqual(timeline.milliseconds("overlay_on"), 12, "只记第一次")
let timelinePayload = timeline.payload(startedAtWall: Date(timeIntervalSince1970: 0))
expectEqual(timelinePayload["parked_ms"] as? Int, 200, "报的是离开头多少毫秒")
expectEqual(timelinePayload["parked"] as? Int, 1, "计数原样")
expect((timelinePayload["started_at"] as? String)?.hasPrefix("1970-01-01T00:00:00") == true, "开头的墙钟")

// MARK: - AgentWindowPolicy:读 Agent 窗口的纯逻辑(2026-09-25,卡 Q「Agent 自动发现与统一接入」)

expect(AgentWindowPolicy.neverRead("com.tencent.xinWeChat"), "★微信永远不读(壳这一侧的第二道门)")
expect(AgentWindowPolicy.neverRead("com.tencent.WeWorkMac"), "★企业微信永远不读")
expect(!AgentWindowPolicy.neverRead("com.example.fooai"), "别的应用壳不拦 —— 是不是 Agent 由服务端的登记表说了算,壳不认名单")
expect(AgentWindowPolicy.neverReadMessage("com.tencent.xinWeChat").contains("永远不读"), "拒读的话说清为什么")

// ★「树还没建起来」要再看一眼(2026-09-26,卡 MQ)。实测 Grok Bot 21 个节点 / Antigravity 65 个节点、
// 一个输入框都没有 —— 那是一棵还没建好的树,不是「这家没有输入框」。
expect(AgentWindowPolicy.worthSecondLook(inputs: 0, visited: 21, capped: false), "★没输入框又只看到 21 个节点:再看一眼")
expect(AgentWindowPolicy.worthSecondLook(inputs: 0, visited: 65, capped: false), "★没输入框又只看到 65 个节点:再看一眼")
expect(!AgentWindowPolicy.worthSecondLook(inputs: 1, visited: 21, capped: false), "找着输入框了就不用再看 —— 树已经建好了")
expect(!AgentWindowPolicy.worthSecondLook(inputs: 0, visited: AgentWindowPolicy.probeMaxVisited, capped: true),
       "走到上限还没输入框:树大得很、早建好了,再看一眼也是同一棵")
expect(AgentWindowPolicy.treeWakeWaitMs > 0 && Double(AgentWindowPolicy.treeWakeWaitMs) + AgentWindowPolicy.probeMaxMs * 2 < 8000,
       "等的那一拍加两眼的时间要留在服务端那 8 秒里")

// ★ 这扇窗的结构摘要(2026-10-01):判成 AI 应用、窗口那一道却过不去的那几家,诊断包里要看得出
// 「是树没建出来」还是「它真不长得像对话窗」。**只有数**,角色名是系统常量,不含它窗口上的字。
let roleCounts = ["AXGroup": 420, "AXStaticText": 88, "AXButton": 12, "AXWebArea": 1, "AXTextArea": 0, "": 7]
let roleTop3 = AgentWindowPolicy.roleHistogram(roleCounts, max: 3)
expectEqual(roleTop3, ["AXGroup": 420, "AXStaticText": 88, "AXButton": 12], "★按个数留前几种,0 个的与没名字的那一格都不留")
expectEqual(AgentWindowPolicy.roleHistogram(["AXWindow": 1]), ["AXWindow": 1], "只剩窗口自己那一个也照实回(那正是「树没建出来」的样子)")
expectEqual(AgentWindowPolicy.roleHistogram([:]), [:], "一个都没数到就回空,不编")

expectEqual(AgentWindowPolicy.clip("第一行\n第二行\t  第三", 50), "第一行 第二行 第三", "换行与连续空白并成一个空格")
expectEqual(AgentWindowPolicy.clip("一二三四五六", 4), "一二三四…", "超了截短加省略号")
expectEqual(AgentWindowPolicy.clip("短", 4), "短", "不超不动")

let agentWin = CGRect(x: 100, y: 50, width: 1000, height: 800)
expectEqual(AgentWindowPolicy.relative(CGRect(x: 150, y: 90, width: 10, height: 10), to: agentWin),
            CGRect(x: 50, y: 40, width: 10, height: 10), "屏幕坐标换成相对窗口左上角")
expectEqual(AgentWindowPolicy.rectJSON(CGRect(x: CGFloat.nan, y: 1.4, width: CGFloat.infinity, height: 2.6)),
            ["x": 0, "y": 1, "w": 0, "h": 3], "NaN / ∞ 记 0,其余取整(Muse 的树里有这种元素)")
expectEqual(AgentWindowPolicy.int(-CGFloat.infinity), 0, "负无穷也记 0,不陷入")
expectEqual(AgentWindowPolicy.int(1e300), 0, "大得离谱的数记 0,不陷入")

let agentWinSize = CGSize(width: 1200, height: 800)
expect(AgentWindowPolicy.looksLikeSidebar(CGRect(x: 0, y: 40, width: 280, height: 760), windowSize: agentWinSize), "贴着左边、又高又不太宽的容器像侧栏")
expect(AgentWindowPolicy.looksLikeSidebar(CGRect(x: 60, y: 0, width: 260, height: 800), windowSize: agentWinSize), "左边先有一条图标栏、再是列表,也认")
expect(!AgentWindowPolicy.looksLikeSidebar(CGRect(x: 0, y: 0, width: 1200, height: 800), windowSize: agentWinSize), "横贯整扇窗的容器不是侧栏")
expect(!AgentWindowPolicy.looksLikeSidebar(CGRect(x: 0, y: 0, width: 60, height: 800), windowSize: agentWinSize), "一条窄窄的图标栏不是侧栏")
expect(!AgentWindowPolicy.looksLikeSidebar(CGRect(x: 0, y: 0, width: 280, height: 200), windowSize: agentWinSize), "矮的不是侧栏(顶上的一块)")
expect(!AgentWindowPolicy.looksLikeSidebar(CGRect(x: 400, y: 0, width: 300, height: 800), windowSize: agentWinSize), "不贴左边的不是侧栏")
let pickedSidebar = AgentWindowPolicy.pickSidebar([
    CGRect(x: 0, y: 60, width: 260, height: 700),
    CGRect(x: 0, y: 0, width: 280, height: 800),
])
expectEqual(pickedSidebar, CGRect(x: 0, y: 0, width: 280, height: 800), "挑最高的那个(外层把图标栏与列表都包进去)")
expectEqual(AgentWindowPolicy.pickSidebar([]), nil, "一个都不像就没有侧栏(不按位置猜)")
expect(AgentWindowPolicy.inSidebar(CGRect(x: 10, y: 100, width: 250, height: 30), sidebar: pickedSidebar), "侧栏里的一行")
expect(!AgentWindowPolicy.inSidebar(CGRect(x: 300, y: 300, width: 60, height: 20), sidebar: pickedSidebar),
       "★对话区里靠左的一小块字不算侧栏(按固定比例切会把它丢掉)")
expect(!AgentWindowPolicy.inSidebar(CGRect(x: 0, y: 0, width: 1200, height: 800), sidebar: pickedSidebar), "横贯整扇窗的不在侧栏里")
expect(!AgentWindowPolicy.inSidebar(CGRect(x: 10, y: 100, width: 250, height: 30), sidebar: nil), "没有侧栏就谁都不在侧栏里")
expect(AgentWindowPolicy.beyondSidebarSearch(CGRect(x: 600, y: 0, width: 400, height: 700), windowWidth: 1200), "整个在右边的那一枝读侧栏时不看")
expect(!AgentWindowPolicy.beyondSidebarSearch(CGRect(x: 0, y: 0, width: 1200, height: 800), windowWidth: 1200), "★横贯整扇窗的容器不剪(侧栏就在它里面)")

let counted = AgentWindowPolicy.textCounts(frames: [
    CGRect(x: 10, y: 100, width: 200, height: 20),   // 侧栏
    CGRect(x: 300, y: 200, width: 60, height: 20),   // 对话区里靠左的一小块
    CGRect(x: 400, y: 300, width: 400, height: 20),  // 对话区
    CGRect(x: 400, y: 760, width: 100, height: 20),  // 输入框下面那行小字
], sidebar: pickedSidebar, inputTop: 700)
expectEqual(counted.total, 4, "一共几块字")
expectEqual(counted.left, 1, "侧栏里几块")
expectEqual(counted.aboveInput, 2, "输入框上面(对话区)几块 —— 只数不读")
expectEqual(AgentWindowPolicy.textCounts(frames: [CGRect(x: 10, y: 200, width: 100, height: 20)], sidebar: nil, inputTop: nil).aboveInput,
            1, "没有侧栏、没找到输入框时,都算对话区")

let chatInputFrame = CGRect(x: 280, y: 700, width: 640, height: 60)
let toolbar = AgentWindowPolicy.toolbarLabels(buttons: [
    (label: "张三", frame: CGRect(x: 10, y: 120, width: 200, height: 30)),         // 侧栏里的一行(可能是联系人)
    (label: "Ben", frame: CGRect(x: 10, y: 760, width: 200, height: 30)),          // 侧栏底上他自己的名字
    (label: "分享", frame: CGRect(x: 800, y: 10, width: 60, height: 30)),          // 顶上那一排
    (label: "深度思考", frame: CGRect(x: 400, y: 740, width: 80, height: 24)),     // 输入区那一排
    (label: "附加文件", frame: CGRect(x: 300, y: 740, width: 30, height: 24)),
    (label: "深度思考", frame: CGRect(x: 500, y: 740, width: 80, height: 24)),     // 重复
], input: chatInputFrame)
expectEqual(toolbar, ["深度思考", "附加文件"], "★只取输入框那一片的按钮名(界面字);侧栏里的(可能是人名、他自己的名字)与顶上那排都不带,去重")
expectEqual(AgentWindowPolicy.toolbarLabels(buttons: [(label: "深度思考", frame: CGRect(x: 400, y: 740, width: 80, height: 24))], input: nil),
            [], "没有输入框就一个都不带")

// MARK: - IconColor:App 图标的主色(2026-09-25,卡 Q:头像与小灯的颜色从各家图标来,不写死)

/// 拼一张假图标:每一种颜色若干个像素(RGBA,预乘透明度 —— 同壳里 CGContext 画出来的一样)。
func iconPixels(_ fills: [(r: Int, g: Int, b: Int, a: Int, count: Int)]) -> [UInt8] {
    var out: [UInt8] = []
    for fill in fills {
        let a = Double(fill.a) / 255
        for _ in 0..<fill.count {
            out += [UInt8((Double(fill.r) * a).rounded()), UInt8((Double(fill.g) * a).rounded()), UInt8((Double(fill.b) * a).rounded()), UInt8(fill.a)]
        }
    }
    return out
}
func iconHSV(_ hex: String) -> (h: Double, s: Double, v: Double) {
    let scanner = Scanner(string: String(hex.dropFirst()))
    var value: UInt64 = 0
    scanner.scanHexInt64(&value)
    let r = Double((value >> 16) & 0xff) / 255, g = Double((value >> 8) & 0xff) / 255, b = Double(value & 0xff) / 255
    let maxC = max(r, g, b), minC = min(r, g, b)
    return (IconColor.hue(r, g, b), maxC == 0 ? 0 : (maxC - minC) / maxC, maxC)
}

// 米色底上一颗橙色的星(像 Claude 的图标):占地方最多的是米色,取到的要是橙。
let clawd = IconColor.dominant(rgba: iconPixels([(r: 240, g: 230, b: 216, a: 255, count: 700), (r: 217, g: 119, b: 87, a: 255, count: 300), (r: 0, g: 0, b: 0, a: 0, count: 500)]))
expect(clawd != nil, "有颜色的图标取得到主色")
if let clawd {
    let hsv = iconHSV(clawd)
    expect(hsv.h >= 5 && hsv.h <= 30, "★米色底上的橙星:主色是橙(色相 \(Int(hsv.h))°),不是占地方最多的米色")
    expect(hsv.s > 0.4, "★主色是饱和的那种橙,不是米色")
}
// 黑底白字(像 ChatGPT / Codex 那种黑白图标):取到黑。
let inky = IconColor.dominant(rgba: iconPixels([(r: 0, g: 0, b: 0, a: 255, count: 800), (r: 255, g: 255, b: 255, a: 255, count: 200)]))
expect(inky.map { iconHSV($0).v < 0.15 } == true, "★黑白图标黑的多:主色是黑(插件那一侧再提亮成看得清的浅色)")
// 白底黑字:取到白。
let paper = IconColor.dominant(rgba: iconPixels([(r: 250, g: 250, b: 250, a: 255, count: 700), (r: 20, g: 20, b: 20, a: 255, count: 300)]))
expect(paper.map { iconHSV($0).v > 0.9 } == true, "白的多:主色是白")
// 一点点颜色(不到一成)不算彩色图标。
let speck = IconColor.dominant(rgba: iconPixels([(r: 250, g: 250, b: 250, a: 255, count: 970), (r: 30, g: 90, b: 230, a: 255, count: 30)]))
expect(speck.map { iconHSV($0).s < 0.1 } == true, "颜色只占一丁点:当它是黑白图标,不拿那一点当主色")
// 半透明的像素按去掉预乘之后的颜色算。
let halfClear = IconColor.dominant(rgba: iconPixels([(r: 40, g: 160, b: 90, a: 160, count: 100)]))
expect(halfClear.map { abs(iconHSV($0).h - 145) < 12 } == true, "预乘过的半透明像素还原回原色再挑")
expect(IconColor.dominant(rgba: iconPixels([(r: 255, g: 0, b: 0, a: 40, count: 100)])) == nil, "整张几乎透明:取不到(插件那一侧用中性灰,不猜)")
expect(IconColor.dominant(rgba: []) == nil, "没有像素:取不到")
expectEqual(IconColor.hex(1, 0.5, 0), "#ff8000", "十六进制按四舍五入")

// MARK: - AppIconPolicy:整张图标(2026-09-26,卡 LG:窗口槽标签与顶栏那一排的小 logo)

// 边长:没说 / 说了个不像数的 → 默认 64pt;太小太大都夹住(一个坏参数不该让一排图标全没了)。
expectEqual(AppIconPolicy.side(nil), AppIconPolicy.defaultSide, "没说边长 → 默认 64pt")
expectEqual(AppIconPolicy.side(0), AppIconPolicy.defaultSide, "0 不是边长 → 默认")
expectEqual(AppIconPolicy.side(-5), AppIconPolicy.defaultSide, "负数不是边长 → 默认")
expectEqual(AppIconPolicy.side(8), AppIconPolicy.minSide, "太小的夹到下限")
expectEqual(AppIconPolicy.side(4096), AppIconPolicy.maxSide, "太大的夹到上限(别白占内存与带宽)")
expectEqual(AppIconPolicy.side(32), 32, "上下限之间的照用")
// 缓存的键:同一个包同一个边长问第二次落在同一格(**幂等**,不重新渲);边长不同是两格。
expectEqual(AppIconPolicy.cacheKey(bundleId: "com.example.fooai", side: 64),
            AppIconPolicy.cacheKey(bundleId: "com.example.fooai", side: 64), "★同包同边长 → 同一个缓存键(问第二次回同一份)")
expect(AppIconPolicy.cacheKey(bundleId: "com.example.fooai", side: 64)
       != AppIconPolicy.cacheKey(bundleId: "com.example.fooai", side: 32), "边长不同是两格")
expect(AppIconPolicy.cacheKey(bundleId: "a", side: 64) != AppIconPolicy.cacheKey(bundleId: "b", side: 64), "包不同是两格")
// 是不是真的 PNG:渲出来的东西不是 PNG 就当没取到(不把一串来历不明的字节当图片发出去)。
expect(AppIconPolicy.isPng(AppIconPolicy.pngMagic + [0x00, 0x01]), "★头八个字节对上 = PNG")
expect(!AppIconPolicy.isPng([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49]), "JPEG 的头不是 PNG")
expect(!AppIconPolicy.isPng([]), "空的不是 PNG")
expect(!AppIconPolicy.isPng(AppIconPolicy.pngMagic), "只有头、没有一个字节内容 → 不算")

// MARK: - DisplayAwakePolicy:工作台在前台就别让屏幕暗下去(2026-09-27,卡 IN)

// ★主干:在前台 + 窗还在屏上 + 没收进坞 → 按住那条断言。
expect(DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false)), "★在前台、窗在屏上 → 常亮")
// 切走 = 放掉(这是它和"永久常亮"的全部区别)。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false)), "切到别家 → 放掉")
// 收进程序坞:App 有可能还是 active(只剩菜单栏),但屏幕上看不见工作台了 → 放掉。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: true)), "收进程序坞 → 放掉")
// 藏起来 / 窗关了。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: false, windowMiniaturized: false)), "窗不在屏上 → 放掉")
// 正在退出:哪怕这一刻四个事实里前三条都还成立,也必须放掉(不留一条没人管的断言)。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false, terminating: true)), "★正在退出 → 放掉")
expect(!DisplayAwakePolicy.assertionName.isEmpty, "断言有个人话名字(pmset -g assertions 里看得到)")

// MARK: - DisplayAwakePolicy · 出门时电脑不睡(2026-10-03,卡「出门时电脑不睡」)
//
// 这一格为真 = 设置里那颗开关开着 **而且** 此刻真有一台已配对手机经中转连着(判断全在插件那边,
// 壳只收一个结论)。缺省假 —— 开关关着时下面「逐字相同」那一组钉的就是「跟今天一模一样」。

// ★开关关着(这一格缺省就是假):四种前台组合逐条与 2026-10-03 之前**逐字相同**。
for (active, visible, mini) in [(true, true, false), (false, true, false), (true, true, true), (true, false, false)] {
    let today = DisplayAwakePolicy.Moment(appActive: active, windowVisible: visible, windowMiniaturized: mini)
    let off = DisplayAwakePolicy.Moment(appActive: active, windowVisible: visible, windowMiniaturized: mini,
                                        awayKeepAwake: false)
    expectEqual(DisplayAwakePolicy.shouldHold(off), DisplayAwakePolicy.shouldHold(today),
                "★开关关着 → 与今天逐字相同(在前台=\(active) 窗在屏上=\(visible) 收进坞=\(mini))")
    expectEqual(DisplayAwakePolicy.holdReason(off), DisplayAwakePolicy.holdReason(today),
                "开关关着 → 按住的理由也是同一个")
}
// ★出门那一格为真 → **不看前台**:切到别家、窗藏起来、收进程序坞,一律照样按住。
expect(DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false, awayKeepAwake: true)),
       "★出门 + 不在前台 → 照样按住(她人不在电脑前,工作台当然不是最前面那个)")
expect(DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: false, windowMiniaturized: true, awayKeepAwake: true)),
       "★出门 + 窗不在屏上 + 收进坞 → 照样按住")
expect(DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false, awayKeepAwake: true)),
       "出门 + 又正好在前台 → 按住(两条理由同时成立)")
// ★正在退出照旧最大:出门模式也不留一条没人管的断言(卡 IN 那条纪律一个字不改)。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: false, windowMiniaturized: false,
    terminating: true, awayKeepAwake: true)), "★正在退出 → 放掉(出门模式也不例外)")
// 按住的理由要分得清:pmset 那一行的名字按理由选。
expectEqual(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false)), .foreground, "在前台 → 理由是「在前台」")
expectEqual(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false, awayKeepAwake: true)), .away,
            "★出门那一格为真 → 理由是「出门」(两条都成立时也先认出门:她这会儿真不在电脑前)")
expect(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false)) == nil, "切走 → 没有理由按")
// `pmset -g assertions` 里那一行:出门那一条是在原来那句话后面**加一句**,原句一个字不动。
expectEqual(DisplayAwakePolicy.assertionName(for: .foreground), DisplayAwakePolicy.assertionName,
            "★在前台那一条的名字 = 原来那一句,逐字不变")
expect(DisplayAwakePolicy.assertionName(for: .away).hasPrefix(DisplayAwakePolicy.assertionName),
       "★出门那一条 = 原句 + 一句(她去 pmset 里查「谁让我的屏幕不睡」时看得懂)")
expect(DisplayAwakePolicy.assertionName(for: .away) != DisplayAwakePolicy.assertionName,
       "★出门按着的时候那一行要说得出是出门模式")
expect(DisplayAwakePolicy.assertionName(for: .away).contains(DisplayAwakePolicy.awayMark),
       "出门那一行里有「出门」两个字")
// 这一颗只管屏幕,**不碰整机那一条**(整机不睡是另一颗开关,见 SystemAwakePolicy)。
expect(DisplayAwakePolicy.assertionName(for: .away) != SystemAwakePolicy.assertionName,
       "★和「电脑别睡」那条不是同一条")

// MARK: - DisplayAwakePolicy · 「在前台」认窗口槽里的那一家(2026-10-04)
//
// 维护者 10-04 原话:「我说的是锁屏的修复没有生效……之前做了一个只要工作台在前台就不锁屏的修复」。
// 量到的:16:51 锁屏,此前她一直在用窗口槽里的 Codex。那一刻 `pmset -g assertions` 里
// `PreventUserIdleDisplaySleep 0` —— 因为她点进槽里那扇真窗之后,最前面的 App 是 Codex 不是工作台,
// `appActive` 成了假,断言被放掉。她眼里「工作台在前台」= 壳那扇窗在屏上、她在用它(**包括槽里那一家**)。

// ★主干:槽里那一家在最前面 + 壳那扇窗还在屏上 → 按住(这是 10-04 这张卡的全部)。
expect(DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false, slotAppFront: true)),
       "★槽里那一家在最前面 + 壳那扇窗在屏上 → 按住(她正在工作台里用 Codex)")
expectEqual(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false, slotAppFront: true)), .slotApp,
            "槽里那一家在前 → 理由是「正在用槽里那一家」,不是「工作台自己在前台」")
// ★槽外的别的 App 在最前面 → 照旧放掉(这是它和「永久常亮」的全部区别,一个字不改)。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false, slotAppFront: false)),
       "★切到槽外的别的 App → 放掉")
// ★槽里那家在前,但壳那扇窗收进了程序坞 / 藏起来了 / 关了 → 放掉(屏幕上已经没有工作台了)。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: true, slotAppFront: true)),
       "★槽里那家在前 + 壳那扇窗收进坞 → 放掉")
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: false, windowMiniaturized: false, slotAppFront: true)),
       "★槽里那家在前 + 壳那扇窗不在屏上(藏起来 / 关了)→ 放掉")
// 正在退出照旧最大:槽里那家在前也不留一条没人管的断言。
expect(!DisplayAwakePolicy.shouldHold(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false,
    terminating: true, slotAppFront: true)), "★正在退出 → 放掉(槽里那家在前也不例外)")
// 两条都成立时先认工作台自己(更准的那一句:她这会儿看着的就是工作台本体)。
expectEqual(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: true, windowVisible: true, windowMiniaturized: false, slotAppFront: true)), .foreground,
            "工作台自己在前 → 理由照旧是「在前台」(slotAppFront 这一格不抢它)")
// 出门那一格照旧最先(她人不在电脑前,槽里那家在不在前面都不是实话)。
expectEqual(DisplayAwakePolicy.holdReason(DisplayAwakePolicy.Moment(
    appActive: false, windowVisible: true, windowMiniaturized: false,
    awayKeepAwake: true, slotAppFront: true)), .away,
            "出门 + 槽里那家在前 → 先认出门")
// ★这一格缺省假:2026-10-04 之前的四种前台组合逐条与今天相等(缺省就是今天的行为)。
for (active, visible, mini) in [(true, true, false), (false, true, false), (true, true, true), (true, false, false)] {
    let today = DisplayAwakePolicy.Moment(appActive: active, windowVisible: visible, windowMiniaturized: mini)
    let off = DisplayAwakePolicy.Moment(appActive: active, windowVisible: visible, windowMiniaturized: mini,
                                        slotAppFront: false)
    expectEqual(DisplayAwakePolicy.holdReason(off), DisplayAwakePolicy.holdReason(today),
                "★槽里那家不在前 → 与 10-04 之前逐字相同(在前台=\(active) 窗在屏上=\(visible) 收进坞=\(mini))")
}
// `pmset -g assertions` 里那一行:槽里那一家这一条也是**原句加一句**,原句一个字不动。
expect(DisplayAwakePolicy.assertionName(for: .slotApp).hasPrefix(DisplayAwakePolicy.assertionName),
       "★槽里那一家那一条 = 原句 + 一句(她去 pmset 里查「谁让我的屏幕不睡」时看得懂)")
expect(DisplayAwakePolicy.assertionName(for: .slotApp) != DisplayAwakePolicy.assertionName,
       "★槽里那一家按着的时候那一行要说得出是在用槽里的程序")
expect(DisplayAwakePolicy.assertionName(for: .slotApp).contains(DisplayAwakePolicy.slotMark),
       "那一行里有「窗口槽」三个字")
expect(DisplayAwakePolicy.assertionName(for: .slotApp) != DisplayAwakePolicy.assertionName(for: .away),
       "和出门那一条不是同一句")

// 壳怎么算这一格(`DisplayAwakePolicy.slotAppFront`):最前面那个 bundle id 在不在插件下发的成员表里。
// **一处主人**:成员表是 dock.json 的那一叠(插件经 `slot_apps` 下发),壳不另造一张。
expect(DisplayAwakePolicy.slotAppFront(front: "com.openai.codex", members: ["com.openai.codex", "com.kimi.app"]),
       "★最前面那个 bundle id 在成员表里 → 这一格为真")
expect(!DisplayAwakePolicy.slotAppFront(front: "com.apple.Safari", members: ["com.openai.codex"]),
       "槽外的别的 App → 假")
expect(!DisplayAwakePolicy.slotAppFront(front: nil, members: ["com.openai.codex"]),
       "问不出最前面是谁(极少见:系统正在切)→ 假(宁可放掉)")
expect(!DisplayAwakePolicy.slotAppFront(front: "com.openai.codex", members: []),
       "★成员表还没下发(壳刚起来 / 旧插件)→ 假(缺省就是 10-04 之前的行为)")

// MARK: - SystemAwakePolicy:工作台开着时电脑不睡(2026-09-28,卡 AW)

// ★主干:工作台活着 + 开关开着 → 按住「整机别因为闲着而睡」。**不看前台后台** ——
// 她离开电脑的时候恰恰是手机要找得到这台电脑的时候。
expect(SystemAwakePolicy.shouldHold(SystemAwakePolicy.Moment(settingOn: true)), "★开着 → 电脑不睡")
// 她自己把开关关了(不插电想省电):立刻放掉,电脑照系统设置该睡就睡。
expect(!SystemAwakePolicy.shouldHold(SystemAwakePolicy.Moment(settingOn: false)), "★关了 → 放掉")
// 正在退出:一定放掉,不留一条没人管的断言(同卡 IN 那条纪律)。
expect(!SystemAwakePolicy.shouldHold(SystemAwakePolicy.Moment(settingOn: true, terminating: true)),
       "★正在退出 → 放掉")
expect(!SystemAwakePolicy.shouldHold(SystemAwakePolicy.Moment(settingOn: false, terminating: true)),
       "关着又在退出 → 还是放掉")
// app.json 里那颗开关:默认开;读不懂一律回默认(读不懂配置不该悄悄改答案)。
expect(SystemAwakePolicy.settingDefault, "★默认开")
expect(SystemAwakePolicy.settingOn(nil), "★没有 app.json → 默认开")
expect(SystemAwakePolicy.settingOn([:]), "键缺席 → 默认开")
expect(SystemAwakePolicy.settingOn([SystemAwakePolicy.settingKey: true]), "写着 true → 开")
expect(!SystemAwakePolicy.settingOn([SystemAwakePolicy.settingKey: false]), "★写着 false → 关")
expect(SystemAwakePolicy.settingOn([SystemAwakePolicy.settingKey: "false"]), "字符串 \"false\" 不算关 → 默认开")
expect(SystemAwakePolicy.settingOn([SystemAwakePolicy.settingKey: 0]), "数字 0 不算关 → 默认开")
// 别的键一个字不动:同一份 app.json 是壳和插件共用的。
expect(!SystemAwakePolicy.settingOn(["lan_access": true, SystemAwakePolicy.settingKey: false]),
       "旁边有别的键也照读这一颗")
expect(!SystemAwakePolicy.assertionName.isEmpty, "断言有个人话名字(pmset -g assertions 里看得到)")
// 两条断言是两回事,名字不能撞(真去 pmset 里查的时候要分得出谁是谁)。
expect(SystemAwakePolicy.assertionName != DisplayAwakePolicy.assertionName, "★和「屏幕别暗」那条不是同一条")

// MARK: - GrantMode:装的时候把授权一次做完(2026-09-27,卡 IN)

// 平时启动:一个 nil,壳照常开(行为与加这一条之前逐字相同)。
expect(GrantMode.parse(arguments: ["/x/workbench"]) == nil, "★没给 --grant → 照常启动")
expect(GrantMode.parse(arguments: ["/x/workbench", "--relaunched-by-update"]) == nil, "别的参数不误认")
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant", "accessibility"]),
            GrantRequest(kinds: [.accessibility], checkOnly: false), "★--grant accessibility")
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant", "notifications"]),
            GrantRequest(kinds: [.notifications], checkOnly: false), "--grant notifications")
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant", "accessibility,notifications"]),
            GrantRequest(kinds: [.accessibility, .notifications], checkOnly: false), "一趟办两样,按给的顺序")
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant", "notifications, accessibility "]),
            GrantRequest(kinds: [.notifications, .accessibility], checkOnly: false), "空格照剥")
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant", "accessibility,accessibility"]),
            GrantRequest(kinds: [.accessibility], checkOnly: false), "重复的只算一样")
// 不认识的名字 → 整个当没给(宁可退回普通启动,也不要开一扇不建窗口的壳)。
expect(GrantMode.parse(arguments: ["/x/workbench", "--grant", "camera"]) == nil, "★不认识的名字 → 退回普通启动")
expect(GrantMode.parse(arguments: ["/x/workbench", "--grant", "accessibility,camera"]) == nil, "一个不认识就整个不认")
expect(GrantMode.parse(arguments: ["/x/workbench", "--grant"]) == nil, "--grant 后面没东西 → 不认")
expect(GrantMode.parse(arguments: ["/x/workbench", "--grant", ""]) == nil, "空串 → 不认")
// 只查不问:安装器开那一屏时先读一次现状,不能顺手弹框。
expectEqual(GrantMode.parse(arguments: ["/x/workbench", "--grant-check"]),
            GrantRequest(kinds: GrantKind.allCases, checkOnly: true), "★--grant-check 查全部、不弹框")
// 两样授权都要有人话的名字和一句「干什么用的」(界面上一行就靠它们)。
for kind in GrantKind.allCases {
    expect(!kind.label.isEmpty, "\(kind.rawValue) 有人话名字")
    expect(!kind.why.isEmpty, "\(kind.rawValue) 说得出干什么用的")
    expect(kind.settingsURL.hasPrefix("x-apple.systempreferences:"), "\(kind.rawValue) 指得到系统设置那一页")
    // 人话里不许出现内部词(维护者不是程序员)。
    expect(!kind.why.contains("API") && !kind.why.contains("命令行"), "\(kind.rawValue) 的说明里没有内部话")
}

// 状态文件:写出去再读回来是同一份。
let grantRoundTrip = GrantStatusFile.decode(GrantStatusFile.encode(
    [.accessibility: .granted, .notifications: .missing], at: Date(timeIntervalSince1970: 0)))
expectEqual(grantRoundTrip[.accessibility], GrantState.granted, "★状态文件:辅助功能 granted 读回来还是 granted")
expectEqual(grantRoundTrip[.notifications], GrantState.missing, "状态文件:通知 missing 读回来还是 missing")
// 同一份状态两次编码逐字节一样(安装器那边靠"文件变了没有"判)。
expectEqual(GrantStatusFile.encode([.accessibility: .granted], at: Date(timeIntervalSince1970: 0)),
            GrantStatusFile.encode([.accessibility: .granted], at: Date(timeIntervalSince1970: 0)),
            "同一份状态编两次逐字节一样")
// 坏文件 / 没写过 / 不认识的值 → **缺席**,不是「她没允许」。
expect(GrantStatusFile.decode(nil).isEmpty, "★没有文件 → 缺席,不是「没允许」")
expect(GrantStatusFile.decode(Data("不是 JSON".utf8)).isEmpty, "坏文件 → 缺席")
expect(GrantStatusFile.decode(Data("{\"accessibility\":\"maybe\"}".utf8)).isEmpty, "不认识的值 → 缺席")
expectEqual(GrantStatusFile.decode(Data("{\"accessibility\":\"unknown\"}".utf8))[.accessibility],
            GrantState.unknown, "「不知道」是一个正经答案")


// ───────── 卡 WR(2026-09-28):按标题在侧栏里点那条对话 ─────────
// 点错一条 = 把他的话打进别的对话里,所以**宁窄勿宽**:整行相等,或者被截断的那一头是另一头的开头。
expectEqual(AgentWindowPolicy.matchConversationRow(row: "DramaWise", wanted: "DramaWise"),
            AgentWindowPolicy.RowMatch.exact, "★整行相等 → 就是它")
expectEqual(AgentWindowPolicy.matchConversationRow(row: " DramaWise ", wanted: "DramaWise"),
            AgentWindowPolicy.RowMatch.exact, "首尾空白不算差别")
expectEqual(AgentWindowPolicy.matchConversationRow(row: "Initiating A New Conversa…", wanted: "Initiating A New Conversation"),
            AgentWindowPolicy.RowMatch.prefix, "★侧栏那一行被 App 截断了 → 去掉省略号后是他那个标题的开头")
expectEqual(AgentWindowPolicy.matchConversationRow(row: "Initiating A New Conversation", wanted: "Initiating A New Conv…"),
            AgentWindowPolicy.RowMatch.prefix, "★反过来也算:我们存下来的标题被我们截过")
expect(AgentWindowPolicy.matchConversationRow(row: "参赛网页 · 旧版", wanted: "参赛网页") == nil,
       "★不做包含匹配:「参赛网页」不许命中「参赛网页 · 旧版」")
expect(AgentWindowPolicy.matchConversationRow(row: "Token Factory", wanted: "DramaWise") == nil, "两回事就是两回事")
expect(AgentWindowPolicy.matchConversationRow(row: "", wanted: "DramaWise") == nil, "空行不认")
expect(AgentWindowPolicy.matchConversationRow(row: "A…", wanted: "Anything") == nil, "★截得只剩一两个字 → 谁都像,不认")

// MARK: - agent_press:替他点它弹的框上那一项(2026-09-28,卡 WQ)
// 维护者:「它现在几个选项给出来了,给完之后我还不能选。」点错一项 = 替他答错一道题,所以这一条**只认整行相等**。
expect(AgentWindowPolicy.matchOptionLabel(row: "川菜", wanted: "川菜"), "★整行相等 → 就是它")
expect(AgentWindowPolicy.matchOptionLabel(row: " 川菜 ", wanted: "川菜"), "两头的空白不算")
expect(AgentWindowPolicy.matchOptionLabel(row: "1. 川菜", wanted: "川菜"), "★它自己画上去的序号不算(「1. 川菜」就是「川菜」)")
expect(AgentWindowPolicy.matchOptionLabel(row: "• 川菜", wanted: "川菜"), "项目符号同理")
expect(AgentWindowPolicy.matchOptionLabel(row: "A) 川菜", wanted: "川菜"), "「A) 」这种序号同理")
expect(!AgentWindowPolicy.matchOptionLabel(row: "川菜(推荐)", wanted: "川菜"), "★多一截就不是它 —— 不做包含匹配")
expect(!AgentWindowPolicy.matchOptionLabel(row: "川菜…", wanted: "川菜馆子"), "★截断的便宜这一条不给(认对话那一行才给)")
expect(!AgentWindowPolicy.matchOptionLabel(row: "", wanted: "川菜"), "空的不认")
expect(!AgentWindowPolicy.matchOptionLabel(row: "粤菜", wanted: "川菜"), "两回事就是两回事")

// MARK: - 「展开这一问」那颗键(2026-09-28,卡 AQ)
// 真机:Codex 在对话区里只画了问句 + 一颗「Answer question」,四个选项收在它后面 ——
// 不点开就找不到「川菜」,`agent_press` 只好如实说「没找到这一项」。所以找不到选项时先找这一颗。
// **按形状认,不写死一家的叫法**;拿不准就不点(点错一颗键 = 在她窗口里乱按)。
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "Answer question", description: nil), "★Codex 那颗就是它")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "Answer questions", description: nil), "复数同理")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: nil, description: "Answer question"), "字放在 description 里的也认")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "回答问题", description: nil), "中文那一种")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "查看提问", description: nil), "「查看提问」也是展开")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "展开这一问", description: nil), "「展开这一问」")
expect(AgentWindowPolicy.looksLikeExpandAsk(title: "查看选项", description: nil), "冲着选项去的也算")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Answer", description: nil), "★光一个 Answer 拿不准 → 不点")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Question", description: nil), "★光一个 Question 同理")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Send", description: nil), "★发送键绝不能按成展开")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Send answer to question", description: nil), "★带「发送」的一律不点(那是替她交答案)")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Skip", description: nil), "★跳过键不点(那是替她弃答)")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "跳过这个问题", description: nil), "中文的跳过同理")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Or write your own response", description: nil), "自己说一句那一条不是展开")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "川菜", description: nil), "选项本身不是展开")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: nil, description: nil), "什么都没有 → 不点")
expect(!AgentWindowPolicy.looksLikeExpandAsk(title: "Answer question about your favorite cuisine right here", description: nil),
       "★长得不像一颗键的字(整段话里刚好有这两个词)→ 不点")

// MARK: - 把她自己那句话写进那个提问面板(2026-09-28,卡 AT)
// 维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
// 最怕的那一件是写进**窗口底部的主输入框**并发出去(= 把她的话当新一轮指令发进她正在跑的会话)。
// 所以这一段的断言几乎全是「哪一种情况一处都不动」。
//
// 造一扇 1000×800 的窗(相对坐标),照 Codex 桌面版真机的样子摆:
//   - 对话区在上面(问句复述了一遍);
//   - 提问面板在输入框上方(y 480…600):问句 + 四个选项 + 「Or write your own response」+ Send;
//   - 主输入框在底部(y 660…720),它右边那颗 Send 在 y≈690。
let askPanel = CGRect(x: 40, y: 480, width: 900, height: 120)
let askMainInput = CGRect(x: 40, y: 660, width: 900, height: 60)
let panelField = AgentWindowPolicy.AskField(role: "AXTextField", label: "Or write your own response",
                                           frame: CGRect(x: 60, y: 550, width: 700, height: 30))
let mainField = AgentWindowPolicy.AskField(role: "AXTextArea", label: "Ask Codex anything", frame: askMainInput)

// ① 挑面板:最小的那个容器(它的祖先一路到整扇窗都「够格」)。
expectEqual(AgentWindowPolicy.enoughForAskPanel(marks: 2, inputs: 1), true, "问句 + 一个选项 + 一个输入框 → 够格")
expectEqual(AgentWindowPolicy.enoughForAskPanel(marks: 1, inputs: 1), false, "★只有一截字的不算面板")
expectEqual(AgentWindowPolicy.enoughForAskPanel(marks: 4, inputs: 0), false, "★没有输入框的是对话区那一段,不是面板")
expectEqual(AgentWindowPolicy.pickAskPanel([CGRect(x: 0, y: 0, width: 1000, height: 800), askPanel]), askPanel,
            "★整扇窗与面板都够格 → 取小的那个(面板)")
expectEqual(AgentWindowPolicy.pickAskPanel([]), nil, "一个都没有 → 没有面板")
expectEqual(AgentWindowPolicy.pickAskPanel([CGRect(x: 0, y: 0, width: 0, height: 0)]), nil, "0×0 的幽灵容器不算")

// MARK: - 按真机那棵树的真实形状挑面板(2026-09-28,卡 AT2)
// 2026-09-28 真机只读 dump(Codex 0.4.59,窗口 1400×898,那一问「你最想喝哪种饮料?」)照抄如下
// (坐标都相对窗口左上角):
//   AXGroup [500,515 737×99]    ← ★**报错了自己高度的祖先**(面板真身有 311 高),按面积挑最小就挑中它
//    AXGroup [500,515 737×363]  ← 面板 + 底部输入区都在它底下
//     AXGroup [500,515 737×311] ← 面板真身(title 里有 Question / 问句 / Skip / Send)
//      AXStaticText 你最想喝哪种饮料?/ AXRadioGroup(可乐 茶 咖啡 果汁)
//      AXTextArea [553,787 520×20] title=desc=Or write your own response SETTABLE ← ★她自己那句要写进这一格
//      AXButton Dictate [1080,783 29×28] / Skip [1116,783 46×28] / Send [1169,783 51×28] / Dismiss [1197,532 27×27]
//     AXGroup [500,834 737×44]:AXTextArea [541,838 379×36] title=Do anything ← 窗口底部主输入框(红线)
//                              AXButton Stop [1200,842 29×28] 等
// 真机回的那句「没有一个既在面板里、又大得像个输入框」= 挑中了那个 99 高的壳子,框落在它外面。
// **不是尺寸门刷的**(520×20 远过 minInputSize 60×12),**也不是角色不对**(真身就是 AXTextArea、AXValue 可写)。
let realOwnField = AgentWindowPolicy.AskField(role: "AXTextArea", label: "Or write your own response",
                                              frame: CGRect(x: 553, y: 787, width: 520, height: 20))
let realMainField = AgentWindowPolicy.AskField(role: "AXTextArea", label: "Do anything",
                                               frame: CGRect(x: 541, y: 838, width: 379, height: 36))
let realMainInput = realMainField.frame
let realPanelSends = [
    AgentWindowPolicy.AskButton(label: "Dismiss", frame: CGRect(x: 1197, y: 532, width: 27, height: 27)),
    AgentWindowPolicy.AskButton(label: "Dictate", frame: CGRect(x: 1080, y: 783, width: 29, height: 28)),
    AgentWindowPolicy.AskButton(label: "Skip", frame: CGRect(x: 1116, y: 783, width: 46, height: 28)),
    AgentWindowPolicy.AskButton(label: "Send", frame: CGRect(x: 1169, y: 783, width: 51, height: 28)),
]
let realComposerSends = [
    AgentWindowPolicy.AskButton(label: "Add files and more", frame: CGRect(x: 508, y: 842, width: 29, height: 28)),
    AgentWindowPolicy.AskButton(label: "Dictate", frame: CGRect(x: 1164, y: 842, width: 29, height: 28)),
    AgentWindowPolicy.AskButton(label: "Stop", frame: CGRect(x: 1200, y: 842, width: 29, height: 28)),
]
let realGhost = AgentWindowPolicy.AskPanelShape(rect: CGRect(x: 500, y: 515, width: 737, height: 99),
                                                fields: [realOwnField, realMainField],
                                                sends: realPanelSends + realComposerSends)
let realPanel = AgentWindowPolicy.AskPanelShape(rect: CGRect(x: 500, y: 515, width: 737, height: 311),
                                                fields: [realOwnField], sends: realPanelSends)
let realOuter = AgentWindowPolicy.AskPanelShape(rect: CGRect(x: 500, y: 515, width: 737, height: 363),
                                                fields: [realOwnField, realMainField],
                                                sends: realPanelSends + realComposerSends)
expectEqual(AgentWindowPolicy.pickAskPanel([realGhost.rect, realPanel.rect, realOuter.rect]), realGhost.rect,
            "★(存证)单看面积就是挑中那个报错了高度的壳子 —— 真机那一趟一处不动的根")
expectEqual(AgentWindowPolicy.pickAskPanelIndex([realGhost, realPanel, realOuter], mainInput: realMainInput), 1,
            "★连着框与键一起挑 → 挑中面板真身(框与 Send 都在它里面),那个 99 高的壳子被跳过")
expectEqual(AgentWindowPolicy.pickAskField(realPanel.fields, panel: realPanel.rect, mainInput: realMainInput),
            .one(index: 0, why: "面板里那个「自己说一句」的框(Or write your own response)"),
            "★真机那一格(AXTextArea 520×20、单行矮框)认得出来")
expectEqual(AgentWindowPolicy.pickAskSend(realPanel.sends, panel: realPanel.rect, mainInput: realMainInput),
            .one(index: 3, why: "面板里那颗发送键(Send)"),
            "★面板上 Dismiss / Dictate / Skip 都不是发送,只按 Send")
expectEqual(AgentWindowPolicy.pickAskPanelIndex([realOuter, realPanel], mainInput: realMainInput), 1,
            "两个都动得了手 → 还是取小的那个(面板真身,不是连底部输入区一起的那个)")
expectEqual(AgentWindowPolicy.pickAskPanelIndex([realGhost], mainInput: realMainInput), 0,
            "★一个都动不了手 → 退回最小那个,那句如实话原样报上去(不假装找着了)")
if case .none = AgentWindowPolicy.pickAskField(realGhost.fields, panel: realGhost.rect, mainInput: realMainInput) {} else {
    failures.append("★退回那个壳子之后照旧一处不动(框落在它外面)")
}
checks += 1
// 安全那一头:只圈着**底部输入区**的容器(框就是主输入框)永远不算「动得了手」,也不许被挑去写。
let composerOnly = AgentWindowPolicy.AskPanelShape(rect: CGRect(x: 500, y: 834, width: 737, height: 44),
                                                   fields: [realMainField], sends: realComposerSends)
expectEqual(AgentWindowPolicy.pickAskPanelIndex([composerOnly, realPanel], mainInput: realMainInput), 1,
            "★底部输入区那个容器更小,但它动不了手 → 挑的还是面板真身")
if case .none = AgentWindowPolicy.pickAskField(composerOnly.fields, panel: composerOnly.rect, mainInput: realMainInput) {} else {
    failures.append("★只圈着底部输入区的容器:一个字都不写")
}
checks += 1
expectEqual(AgentWindowPolicy.pickAskPanelIndex([], mainInput: realMainInput), nil, "一个容器都没有 → 没有面板")
expectEqual(AgentWindowPolicy.pickAskPanelIndex([
    AgentWindowPolicy.AskPanelShape(rect: CGRect(x: 0, y: 0, width: 0, height: 0), fields: [realOwnField], sends: realPanelSends),
], mainInput: realMainInput), nil, "0×0 的幽灵容器照旧不算")
expectEqual(AgentWindowPolicy.pickAskPanelIndex([realGhost, realPanel, realOuter], mainInput: nil), 1,
            "读不到主输入框那条红线时也挑得对(面板那道门还在)")

// ② 认那一问的几截字:选项按整行相等,问句按开头。
expect(AgentWindowPolicy.askMarkHit(text: "1. 川菜", mark: "川菜"), "选项那一截:序号不算")
expect(!AgentWindowPolicy.askMarkHit(text: "川菜馆子", mark: "川菜"), "★选项不做包含匹配")
expect(AgentWindowPolicy.askMarkHit(text: "你最喜欢哪种菜系?问这个是想给你推荐几家你家附近的馆子,顺便记一条偏好",
                                   mark: "你最喜欢哪种菜系?问这个是想给你推荐几家你家附近的馆子"),
       "★问句那一截长(服务端截过)→ 按开头十几个字认")
expect(!AgentWindowPolicy.askMarkHit(text: "今天中午吃什么", mark: "你最喜欢哪种菜系?问这个是想给你推荐几家你家附近的馆子"), "两回事就是两回事")
expect(!AgentWindowPolicy.askMarkHit(text: "川菜", mark: ""), "空的不认")

// ③ 挑面板里那个自由作答框。
expectEqual(AgentWindowPolicy.pickAskField([panelField], panel: askPanel, mainInput: askMainInput),
            .one(index: 0, why: "面板里那个「自己说一句」的框(Or write your own response)"),
            "★Codex 那个框就是它")
expectEqual(AgentWindowPolicy.pickAskField([mainField, panelField], panel: askPanel, mainInput: askMainInput),
            .one(index: 1, why: "面板里那个「自己说一句」的框(Or write your own response)"),
            "★主输入框同时在候选里 → 挑的还是面板里那个")
if case .none = AgentWindowPolicy.pickAskField([mainField], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★只有窗口底部那个主输入框 → 一处都不动")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "自己说一句", frame: CGRect(x: 60, y: 690, width: 700, height: 30)),
], panel: CGRect(x: 0, y: 0, width: 1000, height: 800), mainInput: askMainInput) {} else {
    failures.append("★面板认成了整扇窗、那个框又落在主输入框那一带 → 一处都不动")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "Or write your own response",
                              frame: CGRect(x: 60, y: 300, width: 700, height: 30)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★框在面板外面(对话区里)→ 不写")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "Or write your own response",
                              frame: CGRect(x: 60, y: 550, width: 8, height: 4)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★幽灵节点(8×4)不算输入框")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXStaticText", label: "Or write your own response",
                              frame: CGRect(x: 60, y: 550, width: 700, height: 30)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★静态文本不是输入框(那只是面板上印的一行字)")
}
checks += 1
expectEqual(AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "", frame: CGRect(x: 60, y: 550, width: 700, height: 30)),
], panel: askPanel, mainInput: askMainInput), .one(index: 0, why: "面板里只有这一个输入框"),
            "占位读不到、面板里就这一个 → 装在面板里本身就是证据")
if case .many(let howMany, _) = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "", frame: CGRect(x: 60, y: 520, width: 300, height: 30)),
    AgentWindowPolicy.AskField(role: "AXTextField", label: "", frame: CGRect(x: 500, y: 520, width: 300, height: 30)),
], panel: askPanel, mainInput: askMainInput) { expectEqual(howMany, 2, "★面板里两个框都没占位 → 一个都不写") } else {
    failures.append("★面板里两个框都没占位 → 一个都不写")
}
checks += 1
if case .many = AgentWindowPolicy.pickAskField([
    AgentWindowPolicy.AskField(role: "AXTextField", label: "写你自己的回答", frame: CGRect(x: 60, y: 520, width: 300, height: 30)),
    AgentWindowPolicy.AskField(role: "AXTextField", label: "自己输入一句", frame: CGRect(x: 500, y: 520, width: 300, height: 30)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★两个框都像「自己说一句」→ 一个都不写")
}
checks += 1
// 读不到主输入框时(那道红线放空),面板那道门照旧拦着。
expectEqual(AgentWindowPolicy.pickAskField([panelField], panel: askPanel, mainInput: nil),
            .one(index: 0, why: "面板里那个「自己说一句」的框(Or write your own response)"),
            "读不到主输入框也照走(面板那道门还在)")

// ④ 占位像不像「自己说一句」。
expect(AgentWindowPolicy.looksLikeOwnAnswerField("Or write your own response"), "★Codex 那一句")
expect(AgentWindowPolicy.looksLikeOwnAnswerField("Write your own answer"), "换个说法也认")
expect(AgentWindowPolicy.looksLikeOwnAnswerField("输入你的回答"), "中文那一种")
expect(AgentWindowPolicy.looksLikeOwnAnswerField("自己说一句"), "「自己说一句」")
expect(AgentWindowPolicy.looksLikeOwnAnswerField("其他(自定义回答)"), "「其他」那一档")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("Ask Codex anything"), "★窗口底部主输入框那一句一票否决")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("发消息"), "★「发消息」是主输入框")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("搜索对话"), "★搜索框不写")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("Search"), "英文搜索同理")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("Password"), "★密码框永远不写")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField("回答"), "光一个「回答」拿不准 → 不认(退回「面板里只有一个」那一条)")
expect(!AgentWindowPolicy.looksLikeOwnAnswerField(""), "空的不认")

// ⑤ 面板里那颗发送键。
let panelSend = AgentWindowPolicy.AskButton(label: "Send", frame: CGRect(x: 800, y: 570, width: 60, height: 24))
let mainSend = AgentWindowPolicy.AskButton(label: "Send", frame: CGRect(x: 880, y: 690, width: 40, height: 40))
expectEqual(AgentWindowPolicy.pickAskSend([panelSend], panel: askPanel, mainInput: askMainInput),
            .one(index: 0, why: "面板里那颗发送键(Send)"), "★面板自己那颗 Send")
expectEqual(AgentWindowPolicy.pickAskSend([mainSend, panelSend], panel: askPanel, mainInput: askMainInput),
            .one(index: 1, why: "面板里那颗发送键(Send)"), "★底部输入区那颗 Send 不算(在红线以下)")
if case .none = AgentWindowPolicy.pickAskSend([mainSend], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★只找着底部那颗 Send → 一颗都不按")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskSend([
    AgentWindowPolicy.AskButton(label: "Skip", frame: CGRect(x: 800, y: 570, width: 60, height: 24)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★Skip 不是发送(按下去是替她弃答)")
}
checks += 1
if case .none = AgentWindowPolicy.pickAskSend([
    AgentWindowPolicy.AskButton(label: "停止生成", frame: CGRect(x: 800, y: 570, width: 60, height: 24)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★停止键不是发送")
}
checks += 1
if case .many = AgentWindowPolicy.pickAskSend([
    panelSend,
    AgentWindowPolicy.AskButton(label: "提交", frame: CGRect(x: 700, y: 570, width: 60, height: 24)),
], panel: askPanel, mainInput: askMainInput) {} else {
    failures.append("★面板上两颗都像发送 → 一颗都不按")
}
checks += 1

// ⑥ 核实用那一截字。
expectEqual(AgentWindowPolicy.answerNeedle("我想吃江浙菜,清淡一点", max: 7), "我想吃江浙菜,", "取开头几个字")
expectEqual(AgentWindowPolicy.answerNeedle("行"), nil, "★太短的认不准 → 不用它核实")
expectEqual(AgentWindowPolicy.answerNeedle("  换成\n江浙菜  ", max: 16), "换成 江浙菜", "换行并成一个空格、首尾空白去掉")
expect(AgentWindowPolicy.textMentions("你最喜欢哪种菜系? 我想吃江浙菜,清淡一点", "我想吃江浙菜"), "对话区里出现了她那句 → 核上了")
expect(!AgentWindowPolicy.textMentions("你最喜欢哪种菜系?", "我想吃江浙菜"), "没出现就是没核上")
expect(!AgentWindowPolicy.textMentions("", "我想吃江浙菜"), "空的不算")

// MARK: - 读回来核对:只比字,不比空白(2026-09-28 20:44 Air 真机,豆包工作)
// 派活原文两段之间空一行,豆包的框把空行吞成一个换行 —— 逐字相等判「对不上」,回车一次都没按。
let dispatchSent = "【工作台派活 23bfe5】新开一条会话,问豆包:国庆节的放假安排。\n\n(这是工作台转交的活,做完直接回结果,我在手机上看。)"
let doubaoGot = "【工作台派活 23bfe5】新开一条会话,问豆包:国庆节的放假安排。\n(这是工作台转交的活,做完直接回结果,我在手机上看。)"
expect(SendTextPolicy.readbackMatches(got: doubaoGot, sent: dispatchSent), "★框把空行吞成一个换行 → 还是同一段话,照样按发送")
expect(SendTextPolicy.readbackMatches(got: "  你好 世界 ", sent: "你好\n世界"), "空白、换行的多少不算")
expect(!SendTextPolicy.readbackMatches(got: dispatchSent + dispatchSent, sent: dispatchSent), "★框里是同一段话两遍 → 不算(追加那一类照旧拦)")
expect(!SendTextPolicy.readbackMatches(got: "【工作台派活 23bfe5】新开一条会话", sent: dispatchSent), "只进去半截 → 不算")
expect(!SendTextPolicy.readbackMatches(got: "", sent: dispatchSent), "空的 → 不算")

// MARK: - 认选项:带表情、带说明的那种(2026-09-28 20:36 Air 真机,Codex「今晚想吃哪一种」)
// 选项原文「🍲 番茄小火锅｜牛肉＋豆腐＋菌菇」,整行逐字比找不着那一行。
let dinnerRows = ["🍚 家常菜｜番茄炒蛋＋青椒肉丝＋米饭", "🍜 牛肉面｜加青菜，热乎又省心", "🥗 鸡肉荞麦面｜配黄瓜和煎蛋",
                  "🌶️ 麻辣香锅｜肉和蔬菜自由搭配", "🥟 饺子｜配紫菜蛋花汤", "🍲 番茄小火锅｜牛肉＋豆腐＋菌菇"]
expect(AgentWindowPolicy.matchOptionLabel(row: "6. 番茄小火锅｜牛肉＋豆腐＋菌菇", wanted: "🍲 番茄小火锅｜牛肉＋豆腐＋菌菇"),
       "★窗口里那一行没画表情 → 照样认得出")
expect(AgentWindowPolicy.matchOptionLabel(row: "🌶 麻辣香锅 | 肉和蔬菜自由搭配", wanted: "🌶️ 麻辣香锅｜肉和蔬菜自由搭配"),
       "表情少个变体符、全角半角竖线、空格多少 → 同一项")
expect(!AgentWindowPolicy.matchOptionLabel(row: "番茄小火锅", wanted: "🍲 番茄小火锅｜牛肉＋豆腐＋菌菇"),
       "只对上半截不算整行相等(半截认领交给 pickOption,要唯一)")
// 一行里标题与说明分成两段画(标题一格、说明一格)时,认「标题那一截」—— 但必须在这一组里唯一。
expectEqual(AgentWindowPolicy.pickOption(rows: ["家常菜", "牛肉面", "鸡肉荞麦面", "麻辣香锅", "饺子", "番茄小火锅"],
                                         wanted: "🍲 番茄小火锅｜牛肉＋豆腐＋菌菇", options: dinnerRows), 5,
            "★窗口只画了标题那一截 → 认得出是第 6 行")
expectEqual(AgentWindowPolicy.pickOption(rows: dinnerRows, wanted: "🍲 番茄小火锅｜牛肉＋豆腐＋菌菇", options: dinnerRows), 5,
            "整行一样 → 就是它")
expectEqual(AgentWindowPolicy.pickOption(rows: ["番茄面", "番茄面"], wanted: "番茄面｜加蛋", options: ["番茄面｜加蛋", "番茄面｜加肉"]), nil,
            "★两行都像 → 一行不点")
expectEqual(AgentWindowPolicy.pickOption(rows: ["可乐", "茶"], wanted: "咖啡", options: ["可乐", "茶", "咖啡"]), nil,
            "窗口里没有这一项 → 不点")

// MARK: - 替她批准:认这条会话的那个批准弹窗(2026-10-01,卡 AP「手机替她批准」)
// 维护者 10-01 午饭在外面:Claude 那条会话在等批准,手机上打了字「发不出去」。现在工作台替她按弹窗上那颗键,
// 但 Claude 桌面上可能同时有几条会话、子任务的弹窗 —— 先用这一步自己的原话(命令 / 说明)圈出**这一个**弹窗。
expectEqual(AgentWindowPolicy.approvalNeedle("  git push  origin\nmain  "), "git push origin",
            "记号只取第一行、并过空白")
expectEqual(AgentWindowPolicy.approvalNeedle("ls"), nil, "★太短(不到 4 个字)认不准,不用")
expectEqual(AgentWindowPolicy.approvalNeedle("跑一遍测试"), "跑一遍测试", "中文 4 个字以上照用")
expect(AgentWindowPolicy.approvalMarkHit(text: "Allow Claude to run: git push origin main --force", mark: "git push origin main"),
       "★弹窗那句话里含这一步的命令 → 命中")
expect(AgentWindowPolicy.approvalMarkHit(text: "git  push origin\nmain", mark: "git push origin main"), "窗口里画出来的换行 / 多空白不算区别")
expect(!AgentWindowPolicy.approvalMarkHit(text: "git push origin dev", mark: "git push origin main"), "★别的命令(另一条会话 / 子任务的弹窗)不算")
expect(!AgentWindowPolicy.approvalMarkHit(text: "anything", mark: "ls"), "记号太短 → 一律不命中")
expect(AgentWindowPolicy.sameRect(CGRect(x: 10, y: 20, width: 300, height: 80), CGRect(x: 12, y: 19, width: 301, height: 82)),
       "读的时候和按的时候那块弹窗挪了一两个点 → 还是它")
expect(!AgentWindowPolicy.sameRect(CGRect(x: 10, y: 20, width: 300, height: 80), CGRect(x: 10, y: 140, width: 300, height: 80)),
       "★挪了一大截(下面又来了一个弹窗 / 滚动了)→ 不是它,不按")
expect(AgentWindowPolicy.sameKeyLabel("Allow once", " Allow  once "), "键名两头空白、并空白不算区别")
expect(!AgentWindowPolicy.sameKeyLabel("Allow once", "Allow for this session"), "★「批准一次」和「本次会话都允许」是两颗键")
expect(AgentWindowPolicy.approvalPanelWorthy(buttons: 3), "三颗键的一块够格")
expect(!AgentWindowPolicy.approvalPanelWorthy(buttons: 0), "一颗键都没有的不是弹窗")
expect(!AgentWindowPolicy.approvalPanelWorthy(buttons: 40), "★几十颗键的那一块是整扇窗,不是弹窗")

// MARK: - 认发送键:「Send feedback」不是发送键(2026-09-30 维护者真机)
// 手机往 Claude 桌面那条会话捎「测试」:字打进了输入框,按「发送」时按成了 Claude 底部那颗
// 「Send feedback」—— 弹出反馈窗口,那句话停在框里没发出去。
expect(!SendTextPolicy.looksLikeSendButton(title: "Send feedback", description: nil), "★「Send feedback」不是发送键")
expect(!SendTextPolicy.looksLikeSendButton(title: nil, description: "发送反馈"), "「发送反馈」不是发送键")
expect(!SendTextPolicy.looksLikeSendButton(title: "Report a problem", description: "Submit report"), "提交问题报告不是发送键")
expect(!SendTextPolicy.looksLikeSendButton(title: "Share", description: "Send to a friend"), "分享不是发送键")
expect(SendTextPolicy.looksLikeSendButton(title: "Send message", description: nil), "Send message 照样是发送键")
expect(SendTextPolicy.looksLikeSendButton(title: "发送", description: nil), "发送 照样是发送键")

// MARK: - 开 App 那一行(2026-10-02「诊断包加两样」)
// 10-02「网易云每隔 10s 自行打开」只能写「没查实」:壳这一头谁让哪个包到了台前,事后一行记录都没有。
// 判据写在 AppOpenLog.openingOps 里,记在 HelperSocket 那一个口上(不在七八处 activate 旁边各记一行)。
expect(AppOpenLog.opensApp("raise_window"), "叫到台前算一次开 App")
expect(AppOpenLog.opensApp("unhide_app"), "从程序坞里放出来算一次")
expect(AppOpenLog.opensApp("send_text"), "写字前要 activate,算一次")
expect(AppOpenLog.opensApp("read_texts"), "读之前把藏着的放出来,算一次")
expect(AppOpenLog.opensApp("agent_press"), "替她点那一项要先叫到台前,算一次")
expect(!AppOpenLog.opensApp("screen_info"), "★只读屏幕信息,一拍都不动别人的窗 → 不记")
expect(!AppOpenLog.opensApp("running_apps"), "★只问有哪几个 App → 不记")
expect(!AppOpenLog.opensApp("app_icon"), "★只取图标 → 不记")
expect(!AppOpenLog.opensApp("hide_app"), "★藏起来不是开出来 → 不记")
expect(!AppOpenLog.opensApp("set_window_frame"), "★只挪已经开着的那扇窗 → 不记")
expect(!AppOpenLog.opensApp("observe"), "★只订阅事件 → 不记")

let openAt = Date(timeIntervalSince1970: 1_759_000_000)
let utc = TimeZone(identifier: "UTC")!
expectEqual(AppOpenLog.stamp(openAt, timeZone: utc), "2025-09-27 19:06:40.000", "时间到毫秒、本地时区")
expectEqual(AppOpenLog.line(at: openAt, bundleId: "com.example.music", op: "raise_window", timeZone: utc),
            "开App · 2025-09-27 19:06:40.000 · com.example.music · raise_window",
            "一行里有:记号、时间、哪个包、哪个 op")
expectEqual(AppOpenLog.line(at: openAt, bundleId: "com.example.music", op: "send_text", why: "先开新对话", timeZone: utc),
            "开App · 2025-09-27 19:06:40.000 · com.example.music · send_text · 先开新对话",
            "壳自己知道的那点由头接在后面")
expectEqual(AppOpenLog.line(at: openAt, bundleId: "  ", op: "unhide_app", timeZone: utc),
            "开App · 2025-09-27 19:06:40.000 · (没给包标识) · unhide_app",
            "★包标识没给就说没给,不写个假的")
expect(AppOpenLog.line(at: openAt, bundleId: "com.example.music", op: "raise_window", timeZone: utc).hasPrefix(AppOpenLog.tag),
       "行首是那个记号(grep 开App 找得到)")

// MARK: - 自绘界面(2026-10-02,卡「适配自绘界面的 Kimi」)
// 现场:Air 诊断包 20261002-193929 里官网版 Kimi `com.moonshot.kimichat.kmp.mac` 登录之后的那一份 ——
// roles {AXGroup:4, AXScrollArea:6, AXUnknown:32, AXButton:4, AXWindow:1, AXScrollBar:5, AXStaticText:23},
// 对话文字读得到(23 块),输入框与发送键都是 AXUnknown。

let kimiRoles = ["AXGroup": 4, "AXScrollArea": 6, "AXUnknown": 32, "AXButton": 4,
                 "AXWindow": 1, "AXScrollBar": 5, "AXStaticText": 23]
expect(SendTextPolicy.looksSelfDrawnTree(roles: kimiRoles), "官网 Kimi 登录后那棵树:一个标准输入角色都没有、32 个 AXUnknown、滚得动 → 自绘界面")
expect(!SendTextPolicy.looksSelfDrawnTree(roles: ["AXWindow": 1, "AXImage": 1]),
       "★没登录时那一份(一扇窗一张图)不是自绘界面 —— 不许在登录页上乱点")
expect(!SendTextPolicy.looksSelfDrawnTree(roles: ["AXButton": 3, "AXBusyIndicator": 1, "AXStaticText": 2, "AXWindow": 1]),
       "★兄弟:Kimi 安装器那扇窗(没有 AXUnknown、没有滚动区)不是自绘界面")
expect(!SendTextPolicy.looksSelfDrawnTree(roles: ["AXWindow": 1, "AXGroup": 120, "AXWebArea": 1, "AXScrollArea": 2]),
       "★兄弟:Electron 的树还没建好(满是 AXGroup、没有 AXUnknown)不是自绘界面")
expect(!SendTextPolicy.looksSelfDrawnTree(roles: ["AXTextArea": 1, "AXUnknown": 40, "AXScrollArea": 3]),
       "★有标准输入框、只是没认出来(位置不对 / 整块编辑区)→ 不走自绘这条路")

let drawnWindow = CGRect(x: 100, y: 100, width: 1200, height: 800)
expect(SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: CGRect(x: 300, y: 740, width: 800, height: 56),
                                          window: drawnWindow, settable: false, focusable: true, pressable: false),
       "窗口下部、宽而矮、可聚焦的 AXUnknown → 就是那个输入框")
expect(SendTextPolicy.looksLikeDrawnInput(role: "AXGroup", frame: CGRect(x: 300, y: 740, width: 800, height: 56),
                                          window: drawnWindow, settable: false, focusable: false, pressable: true),
       "有 AXPress 也算动得了")
expect(!SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: CGRect(x: 300, y: 740, width: 800, height: 56),
                                           window: drawnWindow, settable: false, focusable: false, pressable: false),
       "★一动不动的那一块不认(自绘界面里一多半节点是这种)")
expect(!SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: CGRect(x: 300, y: 160, width: 800, height: 56),
                                           window: drawnWindow, settable: false, focusable: true, pressable: true),
       "★顶上那一条(搜索框 / 标题栏)不认")
expect(!SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: CGRect(x: 300, y: 300, width: 800, height: 560),
                                           window: drawnWindow, settable: true, focusable: true, pressable: true),
       "★一整块的那个容器(对话区自己)不认 —— 高过窗高两成就不是输入条")
expect(!SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: CGRect(x: 1000, y: 740, width: 90, height: 56),
                                           window: drawnWindow, settable: true, focusable: true, pressable: true),
       "★窗口下部一颗小方块(发送键 / 附件键)不认 —— 不够宽")
expect(!SendTextPolicy.looksLikeDrawnInput(role: "AXStaticText", frame: CGRect(x: 300, y: 740, width: 800, height: 56),
                                           window: drawnWindow, settable: true, focusable: true, pressable: true),
       "★只在 AXUnknown / AXGroup 里认,别的角色不认")

let fallback = SendTextPolicy.bottomCenterInput(window: drawnWindow)
expect(fallback.midX == drawnWindow.midX, "兜底落点横向在正中")
expect(fallback.midY > drawnWindow.minY + drawnWindow.height * 0.8, "兜底落点在窗口下部")
expect(fallback.maxY < drawnWindow.maxY, "★兜底落点不贴底边(底边那一行常是版本号)")
expect(SendTextPolicy.looksLikeDrawnInput(role: "AXUnknown", frame: fallback, window: drawnWindow,
                                          settable: false, focusable: true, pressable: false),
       "兜底落点自己过得了「像输入框」那几条(两条路挑出来的是同一带)")

// 自绘那个落点只能点、不能写 AXValue —— 与 Muse 那颗 composer 同一档。
let drawnCandidate = SendTextPolicy.InputCandidate(role: "AXUnknown", settable: true, focused: true,
                                                   frame: CGRect(x: 400, y: 740, width: 800, height: 56), drawn: true)
switch SendTextPolicy.pickInput([drawnCandidate], window: drawnWindow) {
case .clickOnly(let i, let why):
    expectEqual(i, 0, "自绘那个落点挑得出来")
    expect(why.contains("自绘界面"), "为什么挑它说得出来")
default: expect(false, "★自绘那个落点必须是 clickOnly(AXValue 写不得)")
}
expectEqual(SendTextPolicy.method(for: SendTextPolicy.pickInput([drawnCandidate], window: drawnWindow)),
            SendTextPolicy.SendMethod.paste, "★自绘那一档走剪贴板粘贴(壳已有的手段,不新造)")

// 真输入框在场时,自绘那个落点不许抢:AXValue 写得进去的那条路照旧赢。
let realInput = SendTextPolicy.InputCandidate(role: "AXTextArea", settable: true, focused: false,
                                              frame: CGRect(x: 400, y: 760, width: 800, height: 56))
expect(SendTextPolicy.pickInput([drawnCandidate, realInput], window: drawnWindow).isWritable,
       "★有真输入框时走 AXValue 那条路(自绘那一档只是兜底)")

// 送出去之后「它发出去了没有」:自绘界面里命中那一块字落在输入框那一带 = 还躺在框里。
let bandWindow = CGRect(x: 0, y: 0, width: 1200, height: 800)
expect(SendTextPolicy.looksLikeInInputBand(frame: CGRect(x: 300, y: 700, width: 700, height: 24), window: bandWindow),
       "★她粘进框里那一句在窗口下部那一带 —— 不许拿它当「已送达」的凭据")
expect(!SendTextPolicy.looksLikeInInputBand(frame: CGRect(x: 300, y: 300, width: 700, height: 24), window: bandWindow),
       "对话区中间那一块是真发出去了")
expect(!SendTextPolicy.looksLikeInInputBand(frame: CGRect(x: 300, y: 600, width: 700, height: 24), window: bandWindow),
       "紧贴输入框上面那一块(对话区最后一句)算发出去了")
expect(!SendTextPolicy.looksLikeInInputBand(frame: CGRect(x: 0, y: 0, width: 10, height: 10), window: .zero),
       "窗口读不出大小时这一条不下判断")

// MARK: - 辅助功能树明细只带字数(2026-10-02,诊断包)

let detailRow = AgentWindowPolicy.axDetailRow(
    role: "AXUnknown", subrole: nil, depth: 7, rel: CGRect(x: 300, y: 740, width: 800, height: 56),
    actions: ["AXPress"], settable: ["AXFocused"], focused: true,
    titleLen: 0, descLen: 4, helpLen: 0, valueLen: 0)
expectEqual(detailRow["role"] as? String, "AXUnknown", "明细带角色名(系统常量)")
expectEqual(detailRow["d"] as? Int, 7, "明细带它在树上第几层")
expectEqual(detailRow["w"] as? Int, 800, "明细带位置大小")
expectEqual(detailRow["act"] as? [String] ?? [], ["AXPress"], "明细带按得下去哪些动作")
expectEqual(detailRow["set"] as? [String] ?? [], ["AXFocused"], "明细带哪几条属性写得进去")
expectEqual(detailRow["foc"] as? Bool, true, "明细带此刻是不是焦点")
expectEqual(detailRow["dl"] as? Int, 4, "★说明只带字数")
expect(detailRow["tl"] == nil, "空的那几格不回(「0 个字」与「压根没有」是两件事)")
expectEqual(detailRow["vl"] as? Int, 0, "★vl:0 = 有 AXValue 这条属性、里面是空的")
expect(AgentWindowPolicy.axDetailRow(role: "AXStaticText", subrole: nil, depth: 3, rel: .zero,
                                     actions: [], settable: [], focused: false,
                                     titleLen: 0, descLen: 0, helpLen: 0, valueLen: nil)["vl"] == nil,
       "★没有 AXValue 这条属性 → 缺席,不写 0")
expectEqual(AgentWindowPolicy.axTextLen("她那句话"), 4, "字数就是字数")
expectEqual(AgentWindowPolicy.axTextLen(""), 0, "空串 0")
expectEqual(AgentWindowPolicy.axTextLen(nil), 0, "没有这一格 0")
expectEqual(AgentWindowPolicy.axDetailRow(role: "AXUnknown", subrole: nil, depth: 1, rel: .zero,
                                          actions: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
                                          settable: [], focused: false,
                                          titleLen: 0, descLen: 0, helpLen: 0, valueLen: nil)["act"] as? [String] ?? [],
            ["a", "b", "c", "d", "e", "f", "g", "h"], "动作名最多带 8 个")
expect(AgentWindowPolicy.axDetailMax <= 200 && AgentWindowPolicy.axDetailMaxVisited <= 4000,
       "明细有行数与节点数两道上限(诊断包不许大到发不出去)")

// MARK: - ScreenLockPolicy:电脑锁着屏时窗口型的家送不进(2026-10-03,卡「锁屏时窗口型的家送不进」)
//
// 现场:2026-10-03 09:04 维护者在手机上给 Kimi 回了一句,7 秒内 `open -b` 五次,最后报
// 「找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有」。唯一的差别是那会儿电脑锁着屏。
// 这一组钉住三件事:怎么认出锁屏、锁屏时那句话换成什么、没锁时一个字都不改。

// ① 认出锁屏:两格各自说得出话,读不出来一律按「没锁」算(不编)
expect(!ScreenLockPolicy.isLocked(nil), "★字典拿不到 = 不知道 → 按没锁算(编成锁着会把她好好的一次送话拦下)")
expect(!ScreenLockPolicy.isLocked([:]), "空字典也按没锁算")
// 2026-10-03 本机(macOS 26)没锁屏时量到的那一本:锁屏那一格**压根不在里面**,OnConsole 是 1。
expect(!ScreenLockPolicy.isLocked([ScreenLockPolicy.onConsoleKey: 1,
                                   "kCGSSessionUserNameKey": "ben"]),
       "★没锁屏时锁屏那一格缺席(本机量过)→ 没锁")
expect(ScreenLockPolicy.isLocked([ScreenLockPolicy.lockedKey: 1,
                                  ScreenLockPolicy.onConsoleKey: 1]),
       "★锁屏那一格是 1 → 锁着")
expect(ScreenLockPolicy.isLocked([ScreenLockPolicy.lockedKey: true]), "Bool 的 true 也认")
expect(!ScreenLockPolicy.isLocked([ScreenLockPolicy.lockedKey: 0,
                                   ScreenLockPolicy.onConsoleKey: 1]),
       "锁屏那一格是 0 → 没锁")
expect(ScreenLockPolicy.isLocked([ScreenLockPolicy.onConsoleKey: 0]),
       "★快速用户切换切走了(OnConsole 是 0)→ 她也看不见,一样算送不进")
expect(!ScreenLockPolicy.isLocked(["kCGSSessionUserNameKey": "ben"]),
       "★OnConsole 那一格缺席 = 不知道,不许说成「她不在」")
expect(ScreenLockPolicy.truthy(nil) == nil && ScreenLockPolicy.truthy("yes") == nil,
       "认不出的值回 nil(= 这一格没有话说),不猜成真或假")

// ② 那句人话:带着插件认的那截字、带着哪一家、说了下一步
let lockedWhy = ScreenLockPolicy.lockedWhy("com.moonshot.kimichat")
expect(lockedWhy.contains(ScreenLockPolicy.marker), "★那句人话里有插件认的那截字(两边同一个常量)")
expect(lockedWhy.contains("com.moonshot.kimichat"), "说得出是哪一家")
expect(lockedWhy.contains("解锁"), "★说得出下一步(她听了去解锁,不去查那一家)")

// ③ 对照:判「没窗口」用的那两截字,与 SendTextPolicy 那两句同源(不写「逐字相同」的注释代替测试)
expect(ScreenLockPolicy.looksLikeNoWindow(SendTextPolicy.Failure.noWindow(bundleId: "com.x.y").message),
       "★「一扇标准窗口都没有」那句认得出来(对照 SendTextPolicy 的原话)")
expect(ScreenLockPolicy.looksLikeNoWindow(SendTextPolicy.Failure.notRunning(bundleId: "com.x.y").message),
       "★「它没在运行」那句也认得出来(锁屏时 App 可能真被系统收了)")
expect(!ScreenLockPolicy.looksLikeNoWindow(SendTextPolicy.Failure.noInput(bundleId: "com.x.y", detail: "找遍了").message),
       "★「输入框没找到」不算没窗口 —— 那是那扇窗上的事实,不是锁屏")
expect(!ScreenLockPolicy.looksLikeNoWindow(SendTextPolicy.Failure.draftInTheWay(bundleId: "com.x.y").message),
       "框里有她没发出去的字也不算没窗口")

// ④ 回包:锁着屏 + 没窗口那一类失败 → 换掉那句话 + 带上那一格
let lockedFail = ScreenLockPolicy.decorate(
    op: "send_text", bundleId: "com.moonshot.kimichat",
    res: ["ok": false, "error": SendTextPolicy.Failure.noWindow(bundleId: "com.moonshot.kimichat").message],
    locked: true)
expectEqual(lockedFail["error"] as? String, ScreenLockPolicy.lockedWhy("com.moonshot.kimichat"),
            "★锁着屏时「一扇标准窗口都没有」换成人话")
expectEqual(lockedFail[ScreenLockPolicy.field] as? Bool, true, "回包带上 screen_locked")
// 别的失败**不换**:那是那扇窗上的事实,换掉就把判据抹了(插件按原话归类)
let lockedOther = ScreenLockPolicy.decorate(
    op: "send_text", bundleId: "com.x.y",
    res: ["ok": false, "error": SendTextPolicy.Failure.draftInTheWay(bundleId: "com.x.y").message],
    locked: true)
expectEqual(lockedOther["error"] as? String, SendTextPolicy.Failure.draftInTheWay(bundleId: "com.x.y").message,
            "★锁着屏也只换「没窗口」那一类,别的原话一个字不动")
expectEqual(lockedOther[ScreenLockPolicy.field] as? Bool, true, "但那一格照旧带上(查日志时对得上)")

// ⑤ 没锁屏:除了那两个只读 op 的那一格,**一个字都不改**(老行为一字不变)
let unlockedFail = ScreenLockPolicy.decorate(
    op: "send_text", bundleId: "com.moonshot.kimichat",
    res: ["ok": false, "error": SendTextPolicy.Failure.noWindow(bundleId: "com.moonshot.kimichat").message],
    locked: false)
expectEqual(unlockedFail["error"] as? String, SendTextPolicy.Failure.noWindow(bundleId: "com.moonshot.kimichat").message,
            "★没锁屏时那句原话一个字不改")
expect(unlockedFail[ScreenLockPolicy.field] == nil, "★没锁屏、又不是那两个只读 op → 连那一格都不加")

// ⑥ 只读那两个 op:锁没锁都带上那一格(8791 的 /state 据此摆出来)
for op in ScreenLockPolicy.alwaysReport.sorted() {
    let unlocked = ScreenLockPolicy.decorate(op: op, bundleId: "", res: ["ok": true, "result": ["scale": 2]], locked: false)
    expectEqual((unlocked["result"] as? [String: Any])?[ScreenLockPolicy.field] as? Bool, false,
                "★\(op) 没锁屏时也带上那一格(false 是答案,不是缺席)")
    expectEqual(unlocked[ScreenLockPolicy.field] as? Bool, false, "\(op) 顶上那一格同理")
    let locked = ScreenLockPolicy.decorate(op: op, bundleId: "", res: ["ok": true, "result": ["scale": 2]], locked: true)
    expectEqual((locked["result"] as? [String: Any])?[ScreenLockPolicy.field] as? Bool, true, "\(op) 锁着屏时那一格是真")
    expectEqual((locked["result"] as? [String: Any])?["scale"] as? Int, 2, "\(op) 原来那几格一个不动")
}
expect(ScreenLockPolicy.alwaysReport.contains("screen_info"),
       "★screen_info 在那张表里 —— 它不碰别人的窗口,服务端拿它当「问一句锁没锁」的路")

// ⑦ `locate` 那种「读到了、可一扇窗都没有」的只读回包:result 里加那一格(它不是失败)
let lockedRead = ScreenLockPolicy.decorate(
    op: "agent_read", bundleId: "com.x.y",
    res: ["ok": true, "result": ["running": true, "windows": 0, "hidden": false]],
    locked: true)
expectEqual((lockedRead["result"] as? [String: Any])?[ScreenLockPolicy.field] as? Bool, true,
            "★锁着屏 + 一扇窗都没有 → 那一格进 result(服务端才分得出是锁屏还是真没窗)")
expect(ScreenLockPolicy.looksLikeNoWindowResult(["running": true, "windows": 0]),
       "running:true + windows:0 = 一扇窗都没有")
expect(ScreenLockPolicy.looksLikeNoWindowResult(["running": true]),
       "windows 那一格压根没有也算(locate 的 ax_err 那一种)")
expect(!ScreenLockPolicy.looksLikeNoWindowResult(["running": true, "windows": 2]),
       "有窗就不是这一类")
expect(!ScreenLockPolicy.looksLikeNoWindowResult(["running": false]),
       "★没在跑不算这一类(那是「它没开」,不是锁屏盖住了窗)")
let lockedNormal = ScreenLockPolicy.decorate(
    op: "agent_read", bundleId: "com.x.y",
    res: ["ok": true, "result": ["running": true, "windows": 1]],
    locked: true)
expect((lockedNormal["result"] as? [String: Any])?[ScreenLockPolicy.field] == nil,
       "★锁着屏但窗读得到 → 不往 result 里塞那一格(这一条跟锁屏没关系)")

// ⑧ 那两条通知的名字(真机订得上没有要维护者验;这里只钉住常量不被改没)
expectEqual(ScreenLockPolicy.lockedNotification, "com.apple.screenIsLocked", "锁屏通知名")
expectEqual(ScreenLockPolicy.unlockedNotification, "com.apple.screenIsUnlocked", "解锁通知名")

// MARK: - quota_page:在后台把那家翻到额度那一页(2026-10-03,卡 QP)
//
// 这条 op 存在的全部理由是**不抢她的焦点**:老那条 `agent_press` 点之前必须把那家叫到台前
// (Electron 那几家在后台「点」不作数),所以自动读额度那一轮一颗键都不敢按 —— 她把豆包停在
// 聊天页上,格子就永远停在上次那个数(卡 QZ 唯一没闭合的半边)。
//
// ① 认键那一套**一个字都不另写**(复用 `agent_press` 的 `matchOptionLabel` / `pickOptionRows`);
// ② 「只走 AXPress、绝不合成鼠标点击」这条用**源码对照**钉(纯逻辑测试进不了 AX,但这一条
//    是整条 op 的命门:哪天有人顺手在它底下补一个 `clickAt` 兜底,这条就红)。

// ① 同一颗键把同一个名字写在 title 与 description 上 —— 那还是**一处**(10-03 真机:Muse 侧栏全是这样)
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Library"), (element: 0, text: "Library")],
                                             wanted: "Library", options: []),
            .one(0),
            "★title 与 description 都写着「Library」= 一颗键,按它(真机:Muse 的侧栏键全是这样,老那条路把它判成「两处都像」、一处都不按)")
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Library"), (element: 1, text: "Library")],
                                             wanted: "Library", options: []),
            .many([0, 1]),
            "★两个**不同元素**都叫这个名字 → 一处都不按(同卡 WQ:按错一颗 = 替她点错)")
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Goals"), (element: 1, text: "Library")],
                                             wanted: "Library", options: []),
            .one(1), "认得出是第二行那一颗")
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Goals")], wanted: "Library", options: []),
            .none, "窗口里没有这颗键 → 不按")
// 退到「窗口只画了标题那一截」那一支(卡 WQ 的老行为,`pickOption`):一行都没整行对上才走
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "番茄小火锅")],
                                             wanted: "番茄小火锅|牛肉+豆腐", options: ["番茄小火锅|牛肉+豆腐"]),
            .one(0), "整行对不上时照旧退到「标题那一截」那一支(老行为一字不改)")
// ★ 10-03 真机:同一颗导航键的字会带角标(Muse 的「Chat」切到 Library 页之后变成「Chat, 2 notifications」)
expect(!AgentWindowPolicy.matchOptionLabel(row: "Chat, 2 notifications", wanted: "Chat"),
       "★带角标的那一行不算「Chat」—— 这就是 `reach.back` 不能照着一个写死的 label 按回去的原因(交接第 4 节)")

// ② 源码对照:`quotaPage` 那一段里只有 AXPress,没有合成点击、没有叫台前
let agentWindowSource: String = {
    for path in ["Sources/AgentWindow.swift",
                 (#filePath as NSString).deletingLastPathComponent + "/../Sources/AgentWindow.swift"] {
        if let text = try? String(contentsOfFile: path, encoding: .utf8) { return text }
    }
    return ""
}()
expect(agentWindowSource.count > 1000, "★读到了 Sources/AgentWindow.swift(读不到就不是「对照过了」,这条必须红)")
let quotaPageBody: String = {
    guard let from = agentWindowSource.range(of: "static func quotaPage(") else { return "" }
    let rest = agentWindowSource[from.upperBound...]
    // 到下一个 `static func` 为止就是这一段。
    guard let to = rest.range(of: "\n    static func ") else { return String(rest) }
    return String(rest[rest.startIndex..<to.lowerBound])
}()
expect(quotaPageBody.count > 500, "★切出了 quotaPage 那一段")
/// **只留代码,注释一行都不算**(这一段的注释里就写着「绝不合成鼠标点击」—— 拿注释当证据
/// 等于用一句话证明自己,正是 AGENTS.md 那条「不写『逐字相同』注释代替测试」要挡的事)。
func codeOnly(_ text: String) -> String {
    var out: [String] = []
    var inBlock = false
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
        var line = String(raw)
        if inBlock {
            guard let end = line.range(of: "*/") else { continue }
            line = String(line[end.upperBound...])
            inBlock = false
        }
        while let start = line.range(of: "/*") {
            if let end = line.range(of: "*/", range: start.upperBound..<line.endIndex) {
                line = String(line[line.startIndex..<start.lowerBound]) + String(line[end.upperBound...])
            } else {
                line = String(line[line.startIndex..<start.lowerBound])
                inBlock = true
            }
        }
        if let slashes = line.range(of: "//") { line = String(line[line.startIndex..<slashes.lowerBound]) }
        if !line.trimmingCharacters(in: .whitespaces).isEmpty { out.append(line) }
    }
    return out.joined(separator: "\n")
}
let quotaPageCode = codeOnly(quotaPageBody)
expect(quotaPageCode.count > 300, "★注释剥掉之后还剩一段真代码(别让这几条断言落在注释上)")
expect(!quotaPageCode.contains("绝不合成"), "★剥注释这一下真的管用(那句话只在注释里)")
expect(quotaPageCode.contains("AXUIElementPerformAction"), "★它是靠 AXPress 按下去的")
/*
 * ★ **2026-10-04(卡「豆包台前点一下」)这一条换了说法,而且比原来紧。**
 *
 * 原来钉的是「这一段里 `clickAt` 一个字都不许有」。维护者 10-04 拍板(「可以」):
 * **台前、只在她亲手点「读一下」时**,对豆包那颗「标准套餐」合成一次点击 ——
 * AXPress 那颗键回 success 而 `menu_roots: 0`(那张原生菜单压根没被弹开)。
 * 那条老纪律的理由(「坐标点下去,前面盖着谁就点在谁身上」)只在**后台**那一支成立。
 *
 * 换成三条,合起来钉的还是同一件事(**后台那一支一行 `clickAt` 都没有**):
 * ① 整段**只有一处** `clickAt`;② 它被 `AgentWindowPolicy.clicksThisStep(` 关着;
 * ③ 那个纯函数本身 `front == false` 时恒为假(下面那一组用例)。
 */
expectEqual(quotaPageCode.components(separatedBy: "clickAt").count - 1, 1,
            "★整段只有一处合成点击(别再给它补第二处「兜底点一下」—— 后台那一支一下都不许点)")
expect(quotaPageCode.contains("AgentWindowPolicy.clicksThisStep(click: click, front: front, fronted: fronted, step: step)"),
       "★那一处点击被 `clicksThisStep` 关着(四条都成立才点:插件要了 + 闪台前那一支 + 台前真叫到了 + 第一颗键)")
expect(agentWindowSource.contains("static func quotaPage(bundleId: String, labels: [String], front: Bool = false, click: Bool = false)"),
       "★`click` 这一格**缺省关着**(老插件不发这一格 → 行为与 0.4.93 一字不差)")
expect(quotaPageCode.contains("node(element)?.frame"),
       "★点之前**现取一次那颗键的矩形**(认那颗键走的是整棵树,走完到点下去之间它可能已经滚走了)")
// 那四条门本身是纯函数(壳那一处一条判断都不自己下)
expect(AgentWindowPolicy.clicksThisStep(click: true, front: true, fronted: true, step: 0),
       "★插件要了 + 闪台前那一支 + 台前真叫到了 + 第一颗键 → 点这一下(豆包那颗「标准套餐」)")
expect(!AgentWindowPolicy.clicksThisStep(click: false, front: true, fronted: true, step: 0),
       "★插件没要就不点(缺省关着)")
expect(!AgentWindowPolicy.clicksThisStep(click: true, front: false, fronted: true, step: 0),
       "★**后台那一支永远不点** —— 坐标点下去,前面盖着谁就点在谁身上(这条 op 从第一天起的纪律)")
expect(!AgentWindowPolicy.clicksThisStep(click: true, front: true, fronted: false, step: 0),
       "★台前叫不到就一下都不点(那一下会点在盖在上面的那扇窗上 = 她正用着的那个)")
expect(!AgentWindowPolicy.clicksThisStep(click: true, front: true, fronted: true, step: 1),
       "★只有第一颗键用点击;弹出来那张菜单里的下一颗照旧只走 AX(维护者原话「点完照旧按 AX 认下一颗」)")
/*
 * ★ **2026-10-03(卡「豆包闪一下」)这两条换了说法。**
 *
 * 卡 QP / QT 这里钉的是「`frontForWindowAction` 在这一段里一行都不许有」「不 activate」。
 * 维护者 10-03 21:4x 拍板(原话「行,处理吧」):**只在那一格真坏了的时候**把豆包叫到台前
 * 闪一下换一个真数 —— 因为它那颗键弹的是系统画的原生菜单,后台 `AXPress` 回 success 而
 * 整扇窗的树一个字没变(卡 QT 真机 visited 388 → 388)。所以这一段里现在**有**那一下,
 * 但它被一格 `front`(缺省 false)关着,而「什么时候才开」两道门都在插件那一侧。
 *
 * 换成三条:① 缺省关着;② 开了才碰台前;③ 碰了台前就一定把台前与隐藏状态都还原。
 */
expect(agentWindowSource.contains("front: Bool = false, click: Bool = false)"),
       "★「叫到台前」那一支**缺省关着**(不给 `front` 的那一下与卡 QT 那一版一字不差)")
expect(quotaPageCode.contains("front ? TextInsert.frontForWindowAction(app) : false"),
       "★只有插件明着要 `front: true` 才碰台前 —— 自动那一轮默认一下都不碰")
expect(quotaPageCode.contains("frontBefore?.activate(options: [.activateAllWindows])")
    && quotaPageCode.contains("shouldRehideAfterFlash"),
       "★闪完**先把台前还给原来那一家、再按原样藏回去**(两样都在 `defer` 里:上面有六七条 return)")
expect(quotaPageCode.contains("NSWorkspace.shared.frontmostApplication?.bundleIdentifier"),
       "★判「台前还在不在它身上」用系统那份现问现答的,不是 KVO 那格 `isActive`(紧跟在还台前后面,那一格会是过期的 true → 永远不藏)")
// 恢复那两件的判据本身是纯函数(有用例,见下面那一组);壳这一段一条判断都不自己下。
expect(AgentWindowPolicy.shouldRehideAfterFlash(wasHidden: true, frontNow: "com.openai.codex", bundleId: "com.bot.pc.doubao"),
       "★本来藏着、台前已经还给她了 → 藏回去(她眼前那一闪到此结束)")
expect(!AgentWindowPolicy.shouldRehideAfterFlash(wasHidden: true, frontNow: "com.bot.pc.doubao", bundleId: "com.bot.pc.doubao"),
       "★台前还在它身上(还不回去 / 这一两秒里她自己点了它):**不藏** —— 从她手底下抽走窗比读不到额度坏得多")
expect(!AgentWindowPolicy.shouldRehideAfterFlash(wasHidden: false, frontNow: "com.openai.codex", bundleId: "com.bot.pc.doubao"),
       "★本来没藏着的:一个指头都不动它(读额度不许顺手藏掉她开着的窗)")
expect(AgentWindowPolicy.shouldRehideAfterFlash(wasHidden: true, frontNow: nil, bundleId: "com.bot.pc.doubao"),
       "台前问不出来(nil)也算「不在它身上」→ 照旧藏回去(宁可藏回她本来藏着的那一家,不留一扇她没开过的窗)")
expectEqual(AgentWindowPolicy.frontFlashBackMs, 250,
            "把台前还回去之后等一拍(同送话那条路叫台前的第一拍;她眼前那一闪越短越好)")
expect(quotaPageCode.contains("app.unhide()") && quotaPageCode.contains("shouldRehide"),
       "★藏着的放出来读、每一条返回路径都照原样藏回去(defer + shouldRehide)")
expect(quotaPageCode.contains("navMaxVisited") && quotaPageCode.contains("navMaxMs"),
       "★用的是「在整扇窗里找一颗导航键」那一份预算 —— 读那一份(2500 节点 / 450ms)在真机上一颗都走不到")
expect(AgentWindowPolicy.navMaxVisited > AgentWindowPolicy.readMaxVisited
    && AgentWindowPolicy.navMaxMs > AgentWindowPolicy.readMaxMs, "那一份预算比读那一份宽")

// ③ 开 App 那一行记它(它会把藏着的那一家放出来 —— 她看得见的一件事)
expect(AppOpenLog.opensApp("quota_page"), "★`quota_page` 记进「开App」那一行(它 unhide 了她的 App)")
expect(!AppOpenLog.opensApp("quota_pages"), "名字不对的不记")

// MARK: - 认键那张角色表 + 翻页多认一档(2026-10-03,卡 QT)
//
// 卡 QP 的交接写下两条结论:「Muse 主窗侧栏没有一颗通向使用情况的键」、「豆包的辅助功能通道压根不通」。
// 10-03 这台机器上重量了一遍 —— **两条都偏了**,偏在同一格上:
//
//   probe quota-keys com.bot.pc.doubao --at 60,945
//     d16 AXPopUpButton (9,914) 232x49 acts=[AXPress,…] labels=["Ben 标准套餐"]
//     d17 AXStaticText  (57,941) 48x16                  labels=["标准套餐"]
//   probe quota-keys com.meta.endo(others 那一格)
//     w1 AXPopUpButton (0,911) 78x56 labels=["Settings","Settings"]
//
// 两家那颗键都是 `AXPopUpButton`,而这张角色表里原来**没有这一档** —— 壳于是回
// 「认不出这颗键」,听起来像「它没有」。

// ① `AXPopUpButton` 在表上(这一格就是那两条结论偏掉的原因)
expect(AgentWindowPolicy.pressableRoles.contains("AXPopUpButton"),
       "★`AXPopUpButton` 按得下去 —— 豆包的「订阅与额度管理」入口、Muse 主窗左下角的「Settings」都是这一档(10-03 真机)")
for role in ["AXButton", "AXRadioButton", "AXCheckBox", "AXCell", "AXMenuItem", "AXLink", "AXRow"] {
    expect(AgentWindowPolicy.pressableRoles.contains(role), "老那几档一个都没丢:\(role)")
}
expect(!AgentWindowPolicy.pressableRoles.contains("AXStaticText"),
       "静态字不算一颗键(按它什么都不会发生,收进来只会把「几处都像」撞成 many)")
expect(!AgentWindowPolicy.pressableRoles.contains("AXGroup"),
       "★`AXGroup` 不进这张表:网页那层树里到处是它,收进来等于满窗都是「键」")

// ② 一处主人:壳与探针用的是同一张表(探针自己再抄一份 = 探针看得见、壳看不见,正是这张卡要治的误判)
let toolsSource: String = {
    for path in ["Tools/main.swift", (#filePath as NSString).deletingLastPathComponent + "/../Tools/main.swift"] {
        if let text = try? String(contentsOfFile: path, encoding: .utf8) { return text }
    }
    return ""
}()
expect(toolsSource.count > 1000, "★读到了 Tools/main.swift(读不到就不是「对照过了」)")
expect(toolsSource.contains("let pressableRoles = AgentWindowPolicy.pressableRoles"),
       "★探针用的就是壳那张角色表(别再抄一份)")
let agentWindowCode = codeOnly(agentWindowSource)
expect(agentWindowCode.contains("let pressableRoles = AgentWindowPolicy.pressableRoles"),
       "★`optionHits` 用的也是那张表")

// ③ 翻页那一条路多认「键里面那几截静态字」,**老那两条消费方一个字没变**
expect(quotaPageCode.contains("alsoInnerText: true"),
       "★`quota_page` 多认一档「键里面那几截静态字」—— 豆包那颗键身上写的是「<账号名> 标准套餐」,账号名是她的,写进表里只对她这一台机器成立")
let pressBody: String = {
    guard let from = agentWindowSource.range(of: "static func press(") else { return "" }
    let rest = agentWindowSource[from.upperBound...]
    guard let to = rest.range(of: "\n    static func ") else { return String(rest) }
    return String(rest[rest.startIndex..<to.lowerBound])
}()
expect(pressBody.count > 300, "★切出了 press 那一段")
expect(!codeOnly(pressBody).contains("alsoInnerText"),
       "★`agent_press`(替她点选项那条)不走这一档 —— 它按错一颗 = 替她答错一道题,多收几行就多一分认错的机会")
let writeAskBody: String = {
    guard let from = agentWindowSource.range(of: "static func writeAsk(") else { return "" }
    let rest = agentWindowSource[from.upperBound...]
    guard let to = rest.range(of: "\n    static func ") else { return String(rest) }
    return String(rest[rest.startIndex..<to.lowerBound])
}()
expect(writeAskBody.count > 300, "★切出了 writeAsk 那一段")
expect(!codeOnly(writeAskBody).contains("alsoInnerText"), "★`agent_write_ask` 也不走这一档")

// ③bis 一串键在**同一次放出来**里按完(卡 QT):弹出式菜单在两条 op 之间会收掉
//
// 真机(10-03,Muse,`probe quota-page com.meta.endo Chat Chat`):`pressed_count: 2`、
// 3 扇窗 / 814 个节点、`front_before == front_after`(没抢焦点)、读完照旧藏着;
// 第二颗给一个不存在的名字 → `pressed_count: 1` + `stuck: 这颗键不存在`(停在那儿,不接着按)。
expect(quotaPageCode.contains("for (step, wantedOne) in chain.enumerated()"),
       "★一条 op 把那一串键挨个按完(分两条 op 发,豆包弹出来那张菜单在中间就被 `defer` 藏回去收掉了)")
expect(quotaPageCode.contains("\"pressed_count\"") && quotaPageCode.contains("\"stuck\""),
       "★回包说清「按到第几颗、卡在哪一颗」(插件照这两格记日志)")
expect(quotaPageCode.contains("kAXWindowsAttribute"),
       "★每按一下都重新取一次窗口清单 —— 弹出来的那张菜单可能是另一扇窗")
let socketSource: String = {
    for path in ["Sources/HelperSocket.swift",
                 (#filePath as NSString).deletingLastPathComponent + "/../Sources/HelperSocket.swift"] {
        if let text = try? String(contentsOfFile: path, encoding: .utf8) { return text }
    }
    return ""
}()
expect(socketSource.count > 1000, "★读到了 Sources/HelperSocket.swift")
expect(codeOnly(socketSource).contains("(msg[\"labels\"] as? [Any])?.compactMap { $0 as? String }")
    && codeOnly(socketSource).contains("?? (msg[\"label\"] as? String).map { [$0] }"),
       "★`labels` 收一串、缺了就退回老那一格 `label` —— 老插件一个字都不用改")

// MARK: - 那两格新的请求位 + caps(2026-10-03,卡「豆包闪一下 / Grok 读键字」)
//
// 维护者 21:4x 拍板的两件事,壳这一侧各是一格**可选的**请求位:
//   `read_texts` 的 `include_titles`(按家声明地也读键身上的字)、`quota_page` 的 `front`(闪一下台前)。
// 两格都**缺省关着**,而且各进一格 caps —— 老壳没有那一格,插件据此压根不发它。
let socketCode = codeOnly(socketSource)
expect(socketCode.contains("includeTitles: (msg[\"include_titles\"] as? Bool) ?? false"),
       "★`include_titles` 缺省 false(不给这一格的那一趟与之前一字不差)")
expect(socketCode.contains("front: (msg[\"front\"] as? Bool) ?? false"),
       "★`front` 缺省 false(不给这一格就不碰台前)")
expect(socketCode.contains("\"read_titles\""), "★caps 里报得出 `read_titles`(插件据此才发 `include_titles`)")
expect(socketCode.contains("\"quota_front\""), "★caps 里报得出 `quota_front`(插件据此才发 `front`)")
expect(socketCode.contains("\"quota_click\""), "★caps 里报得出 `quota_click`(插件据此才发 `click`;2026-10-04 卡「豆包台前点一下」)")
expect(socketCode.contains("click: (msg[\"click\"] as? Bool) ?? false"),
       "★`click` 那一格从请求里取、缺省 false(壳自己不替插件决定要不要点)")
let textInsertSource: String = {
    for path in ["Sources/TextInsert.swift",
                 (#filePath as NSString).deletingLastPathComponent + "/../Sources/TextInsert.swift"] {
        if let text = try? String(contentsOfFile: path, encoding: .utf8) { return text }
    }
    return ""
}()
expect(textInsertSource.count > 1000, "★读到了 Sources/TextInsert.swift(读不到就不是「对照过了」)")
let textInsertCode = codeOnly(textInsertSource)
expect(textInsertCode.contains("includeTitles: Bool = false"),
       "★读那一趟的 `includeTitles` 缺省 false —— 服务端不给这一格时文字流里只有静态字")
expect(textInsertCode.contains("SendTextPolicy.readsTitle(role: role, includeTitles: includeTitles)"),
       "★「这个节点的 title 这一趟读不读」问的是那条纯函数(壳这一处一条判断都不自己下)")
expect(textInsertCode.contains("kAXTitleAttribute"), "★收的是键身上那行字(`AXTitle`)")
expect(textInsertCode.contains("if SendTextPolicy.inputRoles.contains(role) { continue }"),
       "★输入框那一支照旧整个跳过(她打了一半的字一个都不读)")

// ④ 「整行相等」一个字都没放松(放松相等去按她的窗口才是真危险的那条路)
expect(!AgentWindowPolicy.matchOptionLabel(row: "Ben 标准套餐", wanted: "标准套餐"),
       "★「Ben 标准套餐」不等于「标准套餐」—— 这张卡**没有**改成「包含就算」,多认的是那颗键里面那一截字(③)")
expect(AgentWindowPolicy.matchOptionLabel(row: "标准套餐", wanted: "标准套餐"), "那一截字整行对得上")
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Ben 标准套餐"), (element: 0, text: "标准套餐")],
                                             wanted: "标准套餐", options: []),
            .one(1),
            "★同一颗键:身上那一行对不上、里面那一截对得上 → 还是按它这一颗(10-03 真机豆包那颗 AXPopUpButton)")
expectEqual(AgentWindowPolicy.pickOptionRows(rows: [(element: 0, text: "Ben 标准套餐"), (element: 0, text: "标准套餐"),
                                                    (element: 1, text: "标准套餐")],
                                             wanted: "标准套餐", options: []),
            .many([1, 2]),
            "★两颗不同的键里面都写着这一截 → 一处都不按(多收几行没有放松「认不准就不按」;`many` 里每个元素只带对得上的第一行)")

// 侧栏那几行收哪几种(2026-10-08,卡「陌生程序侧栏」;`agent_read` 与 `agent_pick` 共用)
expect(AgentWindowPolicy.sideItemRoles.contains("AXCheckBox"), "★会话行画成可切换项的家(千问办公、Manus:AXCheckBox/AXToggleButton)也收")
expect(AgentWindowPolicy.sideItemRoles.isSuperset(of: ["AXLink", "AXRow", "AXCell", "AXButton"]), "原来那四种照收")
expect(AgentWindowPolicy.sideSkipRoles.isSuperset(of: ["AXPopUpButton", "AXMenuButton"]),
       "★弹菜单的键整枝不看(千问办公左下角账号区是一颗 AXPopUpButton,里面是她的名字和套餐)")
expect(AgentWindowPolicy.sideItemRoles.isDisjoint(with: AgentWindowPolicy.sideSkipRoles), "收的与跳的不重叠")
expect(AgentWindowPolicy.sideReadInsideRoles.isSubset(of: AgentWindowPolicy.sideItemRoles), "先读里面的那几种本身也是一项")
expect(AgentWindowPolicy.sideReadInsideRoles.contains("AXCheckBox"),
       "★Manus 的会话行名字是拼出来的(「派活测试任务管理 派活测试任务管理」),先读里面那块字")
expect(!AgentWindowPolicy.sideReadInsideRoles.contains("AXLink"), "链接 / 按钮照旧拿自己的名字(Antigravity、Muse 不变)")
expect(!AgentWindowPolicy.sideItemRoles.contains("AXRadioButton"), "单选项是一排标签(千问办公「任务 / 频道」),不收")
expectEqual(AgentWindowPolicy.sideEnclosing(role: "AXCheckBox", above: nil), "AXCheckBox", "进了一项列表项,里面那几块字记它")
expectEqual(AgentWindowPolicy.sideEnclosing(role: "AXGroup", above: "AXCheckBox"), "AXCheckBox", "隔着几层普通块照旧记最近那一项")
expectEqual(AgentWindowPolicy.sideEnclosing(role: "AXButton", above: "AXCheckBox"), "AXButton", "里面又套一颗键:记最近那一颗")
expect(AgentWindowPolicy.sideEnclosing(role: "AXGroup", above: nil) == nil, "不在任何一种键里(Manus 的导航、账号名)就缺席")

// 2026-10-12 演示卡「出图进可灵」:按角色认键时,名字前头那个点数不算名字(可灵的生成键写「60 生成」,点数随时长 / 清晰度变)。
expectEqual(AgentWindowPolicy.labelWithoutCount("60 生成"), "生成", "前头的点数去掉")
expectEqual(AgentWindowPolicy.labelWithoutCount("120生成"), "生成", "没空格也去掉")
expectEqual(AgentWindowPolicy.labelWithoutCount("生成"), "生成", "没点数原样")
expectEqual(AgentWindowPolicy.labelWithoutCount("2026"), "2026", "整个都是数字不动(那是数字本身,不是点数)")
expectEqual(AgentWindowPolicy.labelWithoutCount("3.0 Omni 开始创作"), "3.0 Omni 开始创作", "带小数点的版本号不动")
expect(AgentWindowPolicy.pressRoleMatches(nodeRole: "AXGroup", wanted: "AXGroup"), "点名了角色:只认这个角色(可灵「视频生成」那一页签是 AXGroup)")
expect(!AgentWindowPolicy.pressRoleMatches(nodeRole: "AXLink", wanted: "AXButton"), "点名了按钮:同名的导航链接不算")
expect(AgentWindowPolicy.pressRoleMatches(nodeRole: "AXLink", wanted: nil), "没点名:照老表(AXLink 在里头)")
expect(!AgentWindowPolicy.pressRoleMatches(nodeRole: "AXGroup", wanted: nil), "没点名:照老表(AXGroup 不在里头,老行为一字不变)")

// 2026-10-12 演示卡:可灵输入区左下角那颗没名字的垃圾桶(真量的几块:框 111,441 412×216;输入区 99,429 436×278;垃圾桶 111,671 24×24)。
do {
    let input = CGRect(x: 111, y: 441, width: 412, height: 216)
    let composer = CGRect(x: 99, y: 429, width: 436, height: 278)
    let trash = (frame: CGRect(x: 111, y: 671, width: 24, height: 24), named: false)
    let toggle = (frame: CGRect(x: 198, y: 669, width: 96, height: 28), named: true)      // 「智能分镜」
    let save = (frame: CGRect(x: 405, y: 671, width: 28, height: 28), named: false)       // 右边那几颗小图标
    let inPrompt = (frame: CGRect(x: 120, y: 450, width: 24, height: 24), named: false)   // 框里面的东西
    expectEqual(SendTextPolicy.pickComposerClearKey(input: input, composer: composer, keys: [toggle, save, trash, inPrompt]), 2,
                "可灵:左下角那颗没名字的小键就是垃圾桶")
    expectEqual(SendTextPolicy.pickComposerClearKey(input: input, composer: composer, keys: [toggle, save]), nil,
                "左下角一颗都没有 → 不按")
    let twin = (frame: CGRect(x: 140, y: 671, width: 24, height: 24), named: false)
    expectEqual(SendTextPolicy.pickComposerClearKey(input: input, composer: composer, keys: [trash, twin]), nil,
                "左下角两颗都像 → 一颗都不按")
    expectEqual(SendTextPolicy.pickComposerClearKey(input: input, composer: composer, keys: [(frame: trash.frame, named: true)]), nil,
                "有名字的不算(有名字就该按名字认)")
}

// 2026-10-12 演示卡:框上方那几张帧图的删除键(真量:首帧 110,197 203×183,删除 269,207 28×28;尾帧 321,197,删除 480,207)。
do {
    let input = CGRect(x: 111, y: 441, width: 412, height: 216)
    let first = CGRect(x: 110, y: 197, width: 203, height: 183)
    let tail = CGRect(x: 321, y: 197, width: 203, height: 183)
    let thumb = CGRect(x: 600, y: 140, width: 40, height: 40)           // 右边任务列表里的小缩略图
    let keys: [(frame: CGRect, named: Bool)] = [
        (frame: CGRect(x: 241, y: 207, width: 28, height: 28), named: false),   // 首帧「上传」(在删除左边)
        (frame: CGRect(x: 269, y: 207, width: 28, height: 28), named: false),   // 首帧「删除」
        (frame: CGRect(x: 480, y: 207, width: 28, height: 28), named: false),   // 尾帧「删除」
        (frame: CGRect(x: 300, y: 280, width: 30, height: 30), named: false),   // 中间那颗「⇄」(不在任何一张的右上角)
        (frame: CGRect(x: 111, y: 671, width: 24, height: 24), named: false),   // 框底下的垃圾桶
    ]
    let picks = SendTextPolicy.pickFrameDeleteKeys(input: input, images: [tail, first, first, thumb], keys: keys)
    expectEqual(picks.map { $0.image }, [1, 0], "两张帧图各一颗(同位置的两份 AXImage 只算一张;从左到右)")
    expectEqual(picks.map { $0.key }, [1, 2], "每张取右上角最右那颗(删除),不取左边的上传")
    expectEqual(SendTextPolicy.pickFrameDeleteKeys(input: input, images: [thumb], keys: keys).count, 0, "框上方没有帧图 → 一颗都不按")
}

// 2026-10-12 演示卡:可灵结果卡上的「下载」(真量:播放时间 653,557 78×18;⬇ 1171,603 28×33;… 1203,603;下一张卡的时间在 1042)。
do {
    let anchors = [CGRect(x: 653, y: 1042, width: 78, height: 18), CGRect(x: 653, y: 557, width: 78, height: 18)]
    let keys: [(frame: CGRect, role: String, named: Bool)] = [
        (frame: CGRect(x: 1203, y: 603, width: 28, height: 33), role: "AXPopUpButton", named: false),   // …
        (frame: CGRect(x: 1171, y: 603, width: 28, height: 33), role: "AXPopUpButton", named: false),   // ⬇
        (frame: CGRect(x: 1139, y: 603, width: 28, height: 33), role: "AXGroup", named: false),         // ✈
        (frame: CGRect(x: 1171, y: 1088, width: 28, height: 33), role: "AXPopUpButton", named: false),  // 下一张卡的 ⬇
    ]
    expectEqual(SendTextPolicy.pickKeyBelowAnchor(anchors: anchors, keys: keys, role: "AXPopUpButton"), 1,
                "最上面那张卡底下那一排:没名字的弹出键里最左边那颗(⬇),不是「…」、不是下一张卡的")
    expectEqual(SendTextPolicy.pickKeyBelowAnchor(anchors: [], keys: keys, role: "AXPopUpButton"), nil, "没有锚 → 不按")
    expectEqual(SendTextPolicy.pickKeyBelowAnchor(anchors: anchors, keys: [keys[2]], role: "AXPopUpButton"), nil, "那一排没有这种键 → 不按")
}

// MARK: 卡 SC(2026-10-13):发出去了没有 / 点上了没有 —— 核对别读太早
//
// 现场(统筹这台 Mac,普通包豆包 com.bot.pc.doubao,窗口可见、在台前):
// ① 11:49 探针 `send … --new --overwrite --submit 你好` 回 `submitted:false`、`submit_method:return_key`;
//    **两秒后 agent-read 读那扇窗:对话标题已是「问候」、右侧气泡就是那句「你好」、豆包已回话** —— 字真发出去了;
// ② 11:43 派活给豆包同样 `submitted:false`,接力停在第一步、事项记「没派」,而那一刻字还在框里(清框**慢**,不是不清);
// ③ 11:40 她在电话里答「果汁」→ `agent_press` 回「没确认」,豆包窗口里随后就是「收到:果汁」—— 点上了。
// 三件事同一个病:按完只等一拍就读一次。

// 轮询的拍子。
expectEqual(SendTextPolicy.confirmSteps(totalMs: 3000, stepMs: 500), [500, 500, 500, 500, 500, 500],
            "★最多 3 秒 = 6 拍 × 500ms(老代码只等 600ms 读一次)")
expectEqual(SendTextPolicy.confirmSteps(totalMs: 1200, stepMs: 500), [500, 500, 200],
            "最后那一拍只补到时限,不多等")
expectEqual(SendTextPolicy.confirmSteps(totalMs: 400, stepMs: 500), [400], "时限不够一整拍 → 就等那一小截")
expectEqual(SendTextPolicy.confirmSteps(totalMs: 0, stepMs: 500), [], "时限 0 = 不核对")
expectEqual(SendTextPolicy.confirmSteps(totalMs: 3000, stepMs: 0), [], "★步长非法也不许死循环")
expect(SendTextPolicy.confirmSteps(totalMs: SendTextPolicy.submitConfirmTotalMs).reduce(0, +)
        == SendTextPolicy.submitConfirmTotalMs, "缺省那一套加起来正好是时限")
expect(SendTextPolicy.submitConfirmTotalMs >= 3000, "真机上清框比 600ms 慢,给到 3 秒")
expect(SendTextPolicy.submitConfirmEarlyTotalMs < SendTextPolicy.submitConfirmTotalMs,
       "★前两条路(AXConfirm / 发送键)按完没动静就该换下一条,不能把三秒全花在第一条上")

// 对话区那一档半途也看一眼(真机上这一版豆包每一送都落在这一档,死等到点就白搭三秒)。
expect(!SendTextPolicy.echoCheckDue(waitedMs: 500, budgetMs: 3000), "刚等了半秒 → 还不查(框自己清掉的那几家最省)")
expect(SendTextPolicy.echoCheckDue(waitedMs: 1500, budgetMs: 3000), "★等到一半 → 查一眼")
expect(SendTextPolicy.echoCheckDue(waitedMs: 3000, budgetMs: 3000), "到点当然查")
expect(SendTextPolicy.echoCheckDue(waitedMs: 1000, budgetMs: 1500), "前两条路那份短时限同理")

// 第二档:去对话区找送出去那段话的开头。
expectEqual(SendTextPolicy.echoNeedle("帮我写一段关于秋天的短视频脚本,大概三十秒,分镜也给我"),
            "帮我写一段关于秋天的短视频脚本,大概三十", "取前 \(SendTextPolicy.echoNeedleMax) 字")
expectEqual(SendTextPolicy.echoNeedle("你好"), "你好", "★两个字的也认 —— 11:49 真跑送的就是这一句")
expectEqual(SendTextPolicy.echoNeedle("好"), nil, "★一个字的不认(界面上到处是单字,认错就是把没发出去说成发出去了)")
expectEqual(SendTextPolicy.echoNeedle("  第一行\n第二行  "), "第一行 第二行",
            "换行并成一个空格、首尾空白去掉 —— 与窗口里读到的字同一套")
expect(SendTextPolicy.mentionsSentText(hay: "你好呀,有什么可以帮你的?", needle: "你好"), "气泡里有那一截 → 核上了")
expect(SendTextPolicy.mentionsSentText(hay: "派活\n原文  两段", needle: "派活 原文"), "窗口里读到的字也并过空白再比")
expect(!SendTextPolicy.mentionsSentText(hay: "有什么可以帮你的?", needle: "你好"), "没出现就是没核上")
expect(!SendTextPolicy.mentionsSentText(hay: "", needle: "你好"), "空的不算")
expect(!SendTextPolicy.mentionsSentText(hay: "你好", needle: ""), "空的不算(反过来也一样)")

// 扫窗那一趟要排掉**框里的字** —— 没发出去的时候那段字正躺在框里(真机上输入框那一块:-1104,1586 828×24)。
let composerBox = CGRect(x: -1104, y: 1586, width: 828, height: 24)
expect(SendTextPolicy.insideInput(node: composerBox, input: composerBox), "★框自己那一块里的字不算对话区里的")
expect(SendTextPolicy.insideInput(node: CGRect(x: -1100, y: 1590, width: 100, height: 16), input: composerBox),
       "框里那一截静态字(整块都在框里)同理")
expect(!SendTextPolicy.insideInput(node: CGRect(x: -1100, y: 1400, width: 300, height: 40), input: composerBox),
       "★框上方那个气泡里的字算 —— 那正是「发出去了」的凭据")
expect(!SendTextPolicy.insideInput(node: CGRect(x: -1104, y: 1000, width: 828, height: 900), input: composerBox),
       "★整个对话区那一大块不能因为盖着框就被排掉(中点在框外、也没整块落在框里)")
expect(!SendTextPolicy.insideInput(node: composerBox, input: .zero), "框量不到 → 一概不排")
expect(!SendTextPolicy.insideInput(node: CGRect(x: CGFloat.nan, y: CGFloat.nan, width: CGFloat.nan, height: CGFloat.nan), input: composerBox),
       "★读不出矩形的节点(真机上 Muse 那扇窗里有)不许当成框里的字")

// 第二档:框没「空」,但回到了写之前那个样子。
// ★ 真机(统筹这台 Mac,11:5x 探针跑完那一次):这一版豆包发完之后 AXValue 读回来是**那句占位符**
//   (`find` 真读数:value_len:14、placeholder:""、desc:""、title:"")—— isEmptyInput 永远判它「有草稿」,
//   第一档再怎么轮询都不成立。所以比的是「写之前那个值原样回来了没有」,一个字都不用写进壳里。
expect(SendTextPolicy.valueBackToBefore(now: "发消息或按住空格说话…", before: "发消息或按住空格说话…", sent: "你好"),
       "★写之前那个值原样回来 = 我们写进去那段字已经不在框里了")
expect(SendTextPolicy.valueBackToBefore(now: " 发消息或按住空格说话…\n", before: "发消息或按住空格说话…", sent: "你好"),
       "两边都并过空白再比")
expect(!SendTextPolicy.valueBackToBefore(now: "你好", before: "发消息或按住空格说话…", sent: "你好"),
       "★那段字还在框里 → 这一档不成立")
expect(!SendTextPolicy.valueBackToBefore(now: "你好", before: "你好", sent: "你好"),
       "★写之前框里就是同一段(重复送同一句)→ 认不准,交给后面那一档")
expect(!SendTextPolicy.valueBackToBefore(now: nil, before: "发消息或按住空格说话…", sent: "你好"), "读不出值 → 不算")
expect(!SendTextPolicy.valueBackToBefore(now: "发消息或按住空格说话…", before: nil, sent: "你好"), "没量到底子 → 不算")

// 三档判据合一处。
expectEqual(SendTextPolicy.submitProof(inputCleared: true, echoBefore: false, echoAfter: false),
            SendTextPolicy.SubmitProof.inputCleared, "框空了 = 发出去了(第一档)")
expectEqual(SendTextPolicy.submitProof(inputCleared: false, valueBackToBefore: true, echoBefore: false, echoAfter: false),
            SendTextPolicy.SubmitProof.inputBackToBefore, "★框回到写之前那个样子 = 发出去了(第二档,真机上豆包走的就是这一档)")
expectEqual(SendTextPolicy.submitProof(inputCleared: true, valueBackToBefore: true, echoBefore: false, echoAfter: false),
            SendTextPolicy.SubmitProof.inputCleared, "两档都成立时报靠前那一档")
expectEqual(SendTextPolicy.SubmitProof.inputBackToBefore.rawValue, "input_back_to_before", "回包里 confirmed_by 那一格")
expectEqual(SendTextPolicy.submitProof(inputCleared: false, echoBefore: false, echoAfter: true),
            SendTextPolicy.SubmitProof.echoInChat, "★框到点还没空,但对话区里冒出了那句 → 也算发出去了")
expectEqual(SendTextPolicy.submitProof(inputCleared: false, echoBefore: true, echoAfter: true), nil,
            "★送之前对话区里本来就有同一句 → 找到的是旧的那一条,不算凭据")
expectEqual(SendTextPolicy.submitProof(inputCleared: false, echoBefore: false, echoAfter: false), nil,
            "★两样都没有才报没发 —— 「宁可报没发」的分寸留在最后这一档")
expectEqual(SendTextPolicy.submitProof(inputCleared: true, echoBefore: true, echoAfter: true),
            SendTextPolicy.SubmitProof.inputCleared, "框空了就是第一档,与对话区里有没有旧的那一条无关")
expectEqual(SendTextPolicy.SubmitProof.inputCleared.rawValue, "input_cleared", "回包里 confirmed_by 那一格")
expectEqual(SendTextPolicy.SubmitProof.echoInChat.rawValue, "echo_in_chat", "同上")

// 兄弟路:草稿那一套一个字没动 —— 第二档判成「发出去了」而框里还留着字时,草稿只存不写回。
if case .keepOnly = SendTextPolicy.draftReturn(submitted: true, inputEmptyAfterSend: false) {
    expect(true, "★echo_in_chat 那一档(框没空)照旧不往框里写回草稿")
} else {
    expect(false, "★框里还有字时不许写回草稿")
}

// 替她点完那一下:同一套轮询,判据换成「那一项不见了 / 对话区冒出新的一行提到它」。
expect(AgentWindowPolicy.pressConfirmTotalMs >= 3000, "点完也给到 3 秒(新版豆包面板重画比 1.2 秒慢)")
expectEqual(AgentWindowPolicy.pressNeedle("1. 果汁"), "果汁", "找「提到这一项」用那一项的名字(序号不算)")
expectEqual(AgentWindowPolicy.pressNeedle("   "), nil, "空的 → 不找")
expectEqual(AgentWindowPolicy.pressProof(itemGone: true, mentionsBefore: ["果汁"], mentionsAfter: ["果汁"]),
            AgentWindowPolicy.PressProof.gone, "那一项不见了 = 面板收了(第一档)")
expectEqual(AgentWindowPolicy.pressProof(itemGone: false,
                                         mentionsBefore: ["果汁", "果汁 鲜榨的那种"],
                                         mentionsAfter: ["果汁", "果汁 鲜榨的那种", "收到:果汁"]),
            AgentWindowPolicy.PressProof.replyInChat,
            "★11:40 真机:面板还在,可对话区冒出了「收到:果汁」—— 新的一行提到这一项,就是点上了")
expectEqual(AgentWindowPolicy.pressProof(itemGone: false, mentionsBefore: ["果汁"], mentionsAfter: ["果汁"]), nil,
            "★一模一样 = 什么都没发生,如实报没点上")
expectEqual(AgentWindowPolicy.pressProof(itemGone: false, mentionsBefore: ["果汁"], mentionsAfter: [" 果汁 ", "果汁…"]), nil,
            "★并过空白、去掉省略号之后还是那一行 → 不算新回话")
expectEqual(AgentWindowPolicy.pressProof(itemGone: false, mentionsBefore: [], mentionsAfter: []), nil, "一行都读不到 → 不算")
expectEqual(AgentWindowPolicy.PressProof.gone.rawValue, "gone", "回包里 confirmed_by 那一格")
expectEqual(AgentWindowPolicy.PressProof.replyInChat.rawValue, "reply_in_chat", "同上")

// MARK: - agent_images:图片节点那一行怎么回(2026-10-13 夜,卡 T)

do {
    let long = String(repeating: "x", count: 500)
    let row = AgentWindowPolicy.imageRow(role: "AXImage", rel: CGRect(x: 110, y: 197, width: 203, height: 183),
                                         url: "https://p4-fdl.klingai.com/bs2/upload/" + long, desc: "/format,webp")
    expectEqual(row["role"] as? String, "AXImage", "角色原样")
    expectEqual(row["x"] as? Int, 110, "相对窗口的 x")
    expectEqual(row["w"] as? Int, 203, "宽")
    expect((row["url"] as? String)?.count ?? 0 <= AgentWindowPolicy.imageUrlMax + 1, "地址按上限裁")
    expect((row["url"] as? String)?.hasPrefix("https://p4-fdl.klingai.com/bs2/upload/") == true, "地址开头保留")
    expectEqual(row["desc"] as? String, "/format,webp", "说明原样")
    let bare = AgentWindowPolicy.imageRow(role: "AXProgressIndicator", rel: .zero, url: nil, desc: "")
    expect(bare["url"] == nil && bare["desc"] == nil, "没地址 / 空说明就不带那一格")
    expect(AgentWindowPolicy.imageRoles.contains("AXImage") && !AgentWindowPolicy.imageRoles.contains("AXGroup"), "图片类角色表")
}

// MARK: - ReadLanes:读窗按包各排各的队(2026-10-21,卡「派活按家隔离」)

do {
    // 认哪一条队:按包读窗的那几样按包分;不看包的只读(列 App、取图标)共用一条。
    expectEqual(ReadLanes.laneKey(op: "read_reply", bundleId: "com.bot.pc.doubao"), "com.bot.pc.doubao", "读回话按包分队")
    expectEqual(ReadLanes.laneKey(op: "agent_read", bundleId: "com.moonshot.kimichat"), "com.moonshot.kimichat", "读窗口按包分队")
    expectEqual(ReadLanes.laneKey(op: "running_apps", bundleId: ""), ReadLanes.sharedKey, "列 App 不看包,共用一条")
    expectEqual(ReadLanes.laneKey(op: "app_icon", bundleId: "com.bot.pc.doubao"), ReadLanes.sharedKey, "取图标几毫秒,共用一条")
    expectEqual(ReadLanes.laneKey(op: "read_reply", bundleId: ""), ReadLanes.sharedKey, "没带包的读也有地方排")

    let book = ReadLanes()
    let t0 = Date(timeIntervalSince1970: 1_000)
    let doubao1 = book.enter("com.bot.pc.doubao", at: t0)
    let doubao2 = book.enter("com.bot.pc.doubao", at: t0)
    let kimi = book.enter("com.moonshot.kimichat", at: t0)
    expectEqual(book.pending("com.bot.pc.doubao"), 2, "豆包那条队里排着两下")
    expectEqual(book.verdict(doubao1, at: t0.addingTimeInterval(0.5)), .run, "轮到就读")
    // ★ 排队太久:插件那一头读窗 15 秒就不等了,这一下再读也没人收 —— 不读,当场回。
    expectEqual(book.verdict(doubao2, at: t0.addingTimeInterval(16)), .stale(waitedMs: 16_000), "排过头的那一下不读")
    expect(ReadLanes.staleSay(waitedMs: 16_000).contains("16"), "排过头那一句说得出等了多久")
    // ★ 撤读:只撤那几个包还没开始的,别的包一下不动。
    let doubao3 = book.enter("com.bot.pc.doubao", at: t0)
    let doubao4 = book.enter("com.bot.pc.doubao", at: t0)
    expectEqual(book.cancel(["com.bot.pc.doubao", "com.work.pc.doubao"]), 2, "撤了豆包排着的两下")
    expectEqual(book.verdict(doubao3, at: t0.addingTimeInterval(1)), .cancelled, "撤掉的那一下不读")
    expectEqual(book.verdict(doubao4, at: t0.addingTimeInterval(1)), .cancelled, "撤掉的那一下不读")
    expectEqual(book.verdict(kimi, at: t0.addingTimeInterval(1)), .run, "Kimi 那条队一下不动")
    expectEqual(book.pending("com.bot.pc.doubao"), 0, "撤完不再排着")
    let after = book.enter("com.bot.pc.doubao", at: t0.addingTimeInterval(2))
    expectEqual(book.verdict(after, at: t0.addingTimeInterval(2)), .run, "撤完之后新来的照读")
    // 一次读窗的墙钟上限:比插件那一头的 15 秒短,读不完就停(不再在那条队里一直遍历下去)。
    expect(ReadLanes.readBudgetMs < 15_000 && ReadLanes.readBudgetMs >= 5_000, "读一扇窗最多读这么久")
}

if failures.isEmpty {
    print("✅ WindowPlacement + WindowMode + DragSense + ShellRelaunch + SendTextPolicy + SwitchBudget + WebToken + LoadingCover + ShellReadiness + ShellTitleBar + WebPolicy + ActivationSense + NotifyPolicy + AgentWindowPolicy + IconColor + AppIconPolicy + DisplayAwakePolicy + SystemAwakePolicy + ScreenLockPolicy + GrantMode + AppOpenLog + ReadLanes:\(checks) 条断言全绿")
    exit(0)
}
print("❌ WindowPlacement + WindowMode + DragSense + ShellRelaunch + SendTextPolicy + SwitchBudget + WebToken + LoadingCover + ShellReadiness + ShellTitleBar + WebPolicy + ActivationSense + NotifyPolicy + AgentWindowPolicy + IconColor + AppIconPolicy + DisplayAwakePolicy + ScreenLockPolicy + GrantMode + AppOpenLog:\(failures.count)/\(checks) 条不过")
for failure in failures { print("  - \(failure)") }
exit(1)
