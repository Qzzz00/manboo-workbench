import Foundation

/// 取一张 App 图标**整张图**时那几条规矩(2026-09-26,卡 LG;维护者原话:「增加一个功能,就是现在电脑上有多少个
/// Agent 客户端,把对应的 logo 也搞上;桌面端的应用标签,也加各家的 logo icon」)。
///
/// 图标的**主色**早就有一条路了(`IconColor` + 壳的 `icon_colors`,2026-09-25 卡 Q:顶栏小灯、头像的颜色从各家
/// 图标来,不写死)。这张卡沿的是同一条路,只是不再只取一个颜色,而是把**整张图标**渲成一张小 PNG 交给界面 ——
/// 窗口槽标签名字前面那 16px、顶栏那一排小灯、「这台电脑上 N 家 Agent 客户端」那一条上的小图标都用它。
///
/// 这个文件里**不碰 AppKit**(才编得动、才测得了):只有边长怎么算、缓存的键长什么样、回来的那串字节
/// 是不是真的 PNG。真去问 `NSWorkspace` 拿图标、渲成位图在 `AgentWindow.appIcon`。
enum AppIconPolicy {
    /// 默认按 64pt 渲(界面上最大用到 20px 左右,64pt@2x = 128px 够清楚了,一张几 KB)。
    static let defaultSide = 64
    /// 边长的上下限:小于这个看不清,大于这个只是白占内存与带宽(界面一处也用不到)。
    static let minSide = 16
    static let maxSide = 256
    /// @2x 渲一次(Retina 上不虚)。像素边长 = side × scale。
    static let scale = 2

    /// 服务端要的边长(pt)夹进上下限;没说 / 说了个不是数的 → 默认 64pt。
    /// **夹住而不是报错**:这条路上一个坏参数不该让一排图标全没了。
    static func side(_ requested: Int?) -> Int {
        guard let requested, requested > 0 else { return defaultSide }
        return max(minSide, min(maxSide, requested))
    }

    /// 壳内存里那份缓存的键。同一个包、同一个边长问第二次,回的是同一份(**幂等**,不重新渲)。
    static func cacheKey(bundleId: String, side: Int) -> String {
        "\(bundleId)@\(side)x\(scale)"
    }

    /// PNG 的头八个字节。渲出来的东西不是 PNG 就当没取到(不把一串来历不明的字节当图片发出去)。
    static let pngMagic: [UInt8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

    static func isPng(_ bytes: [UInt8]) -> Bool {
        guard bytes.count > pngMagic.count else { return false }
        return Array(bytes.prefix(pngMagic.count)) == pngMagic
    }
}
