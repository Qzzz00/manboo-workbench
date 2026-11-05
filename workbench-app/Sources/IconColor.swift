import Foundation

/// 一个 App 图标的**主色**(2026-09-25,卡 Q;维护者:「Claude 是橙色的,能不能配个同色系的卡通形象,其他的 Agent 也是」)。
///
/// 会话卡、事务官舞台、顶栏小灯、手机上各家的颜色**都从它自己的图标来**,不写死每家的颜色 ——
/// 自动发现的一家也自然有它的颜色。这里是纯函数:给一张图标的像素,挑出「最像它品牌色」的那一种。
/// 怎么提亮(深色底上看得清)、取不到时用什么灰,不在这里定,在插件那一侧一处定(agentRegistry.ts 的 agentColor)。
///
/// 挑法:
/// 1. 透明的像素不算(图标四周是透明的);
/// 2. **有颜色的像素**(饱和度、亮度都够)占到一成以上 → 按色相分 24 格,取像素最多的那一格的平均色
///    —— 米色底上一颗橙色的星(Claude)取到的是橙,不是占地方最多的米色;
/// 3. 没什么颜色的(黑底白字、白底黑字那种)→ 深的多取深、浅的多取浅,取那一半的平均色(黑白两色的图标就是黑或白)。
enum IconColor {
    /// 透明度低于这个的像素不算。
    static let alphaMin: Double = 0.5
    /// 「有颜色」的门槛。
    static let colorfulSaturation: Double = 0.28
    static let colorfulValue: Double = 0.25
    /// 有颜色的像素占不透明像素的这一成以上,才按颜色挑;否则当它是黑白图标。
    static let colorfulShare: Double = 0.06
    static let hueBuckets = 24

    /// `rgba`:每个像素 4 个字节 R, G, B, A,**预乘过透明度**(CGContext `premultipliedLast` 画出来的就是这样)。
    /// 回 `#rrggbb`;整张都是透明的回 nil。
    static func dominant(rgba: [UInt8]) -> String? {
        var opaque = 0
        var hueCount = [Int](repeating: 0, count: hueBuckets)
        var hueSum = [(Double, Double, Double)](repeating: (0, 0, 0), count: hueBuckets)
        var darkCount = 0, lightCount = 0
        var darkSum = (0.0, 0.0, 0.0), lightSum = (0.0, 0.0, 0.0)
        var i = 0
        while i + 3 < rgba.count {
            let a = Double(rgba[i + 3]) / 255
            if a >= alphaMin {
                // 去掉预乘。
                let r = min(1, Double(rgba[i]) / 255 / a)
                let g = min(1, Double(rgba[i + 1]) / 255 / a)
                let b = min(1, Double(rgba[i + 2]) / 255 / a)
                opaque += 1
                let maxC = max(r, g, b), minC = min(r, g, b)
                let v = maxC
                let s = maxC == 0 ? 0 : (maxC - minC) / maxC
                if s >= colorfulSaturation && v >= colorfulValue {
                    let bucket = min(hueBuckets - 1, Int(hue(r, g, b) / 360 * Double(hueBuckets)))
                    hueCount[bucket] += 1
                    hueSum[bucket].0 += r; hueSum[bucket].1 += g; hueSum[bucket].2 += b
                }
                if v < 0.5 {
                    darkCount += 1
                    darkSum.0 += r; darkSum.1 += g; darkSum.2 += b
                }
                else {
                    lightCount += 1
                    lightSum.0 += r; lightSum.1 += g; lightSum.2 += b
                }
            }
            i += 4
        }
        if opaque == 0 { return nil }
        let colorful = hueCount.reduce(0, +)
        if colorful > 0 && Double(colorful) >= colorfulShare * Double(opaque) {
            var best = 0
            for index in 1..<hueBuckets where hueCount[index] > hueCount[best] { best = index }
            let n = Double(hueCount[best])
            return hex(hueSum[best].0 / n, hueSum[best].1 / n, hueSum[best].2 / n)
        }
        if darkCount >= lightCount {
            let n = Double(darkCount)
            return hex(darkSum.0 / n, darkSum.1 / n, darkSum.2 / n)
        }
        let n = Double(lightCount)
        return hex(lightSum.0 / n, lightSum.1 / n, lightSum.2 / n)
    }

    /// 色相(0 ≤ h < 360)。
    static func hue(_ r: Double, _ g: Double, _ b: Double) -> Double {
        let maxC = max(r, g, b), minC = min(r, g, b)
        let d = maxC - minC
        if d == 0 { return 0 }
        var h: Double
        if maxC == r { h = (g - b) / d }
        else if maxC == g { h = (b - r) / d + 2 }
        else { h = (r - g) / d + 4 }
        h *= 60
        if h < 0 { h += 360 }
        return h >= 360 ? h - 360 : h
    }

    static func hex(_ r: Double, _ g: Double, _ b: Double) -> String {
        func byte(_ c: Double) -> Int { Int((max(0, min(1, c)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
    }
}
