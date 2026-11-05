import Foundation

/// 壳的可配项,~/.dsh/workbench/app.json 可覆盖:
/// { "page_url": "...", "helper_ws": "...", "screen_hint": "..." }
struct AppConfig {
    var pageURL: URL
    var helperWS: URL
    /// 「窗口永远开在这台显示器上」的**可选**覆盖(按显示器名大小写不敏感包含匹配)。
    /// 2026-09-18 起**没有缺省值**:以前写死 "UP2716D",于是在任何机器上工作台都去铺满
    /// 那块竖屏——Ben 的原话「登录窗口一上来就默认撑满了我的竖屏屏幕,这不对吧」。
    /// 缺席(常态)时落屏顺序见 WindowPlacement.chooseScreen。
    var screenHint: String?

    static func load() -> AppConfig {
        var config = AppConfig(
            pageURL: URL(string: "http://127.0.0.1:3080/?ben-workbench=app")!,
            helperWS: URL(string: "ws://127.0.0.1:8791/helper")!,
            screenHint: nil
        )
        guard let json = AppConfigStore.read() else { return config }
        if let s = json["page_url"] as? String, let u = URL(string: s) { config.pageURL = u }
        if let s = json["helper_ws"] as? String, let u = URL(string: s) { config.helperWS = u }
        if let s = json["screen_hint"] as? String,
           !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { config.screenHint = s }
        return config
    }
}

/// ~/.dsh/workbench/app.json 的读写。
///
/// 这份文件是**壳和插件共用**的(插件那边放 lan_access / scan_roots / butler_cwd / …,
/// 见 workbench-plugin/src/server/appConfig.ts)。所以壳这边守同一条规矩:
/// **读整份 → 只改 `window_frames` 这一个键 → 原子写回(tmp + rename)**,
/// 不认识的键一个字不动。写之前**现读一次**,不用启动时那份内存快照——
/// 中间插件可能改过别的键,拿旧快照写回去等于把人家的改动抹掉。
///
/// 已知取舍:两个进程各自「读-改-写」,理论上仍可能撞车(壳写的一瞬间插件正好也在写,
/// 后写的赢)。没有加文件锁,因为壳这边的写只在人手动拖/缩窗口停下来之后发生(还防抖了),
/// 与插件的设置写入撞上同一毫秒的概率极低,代价也只是一次窗口大小没记住。
enum AppConfigStore {
    /// ⚠️ 2026-09-18 踩过的坑,写在这儿别再踩:**`NSHomeDirectory()` 不认 `$HOME` 环境变量**
    /// (它走 getpwuid,不是读环境变量)。想拿个假家目录跑这个类型的手工验证是**做不到**的——
    /// 那次真写到了 Ben 的真 app.json 上。要验这一段,改成往一个显式传入的路径写,
    /// 或者干脆只验 WindowFrameStore 的编解码(run-tests.sh 就是只验那一层,不碰任何文件)。
    static var path: String { NSHomeDirectory() + "/.dsh/workbench/app.json" }

    /// 写盘放到自己的串行队列上:JSON 虽小,拖动结束那一下主线程还在忙,不占它。
    private static let queue = DispatchQueue(label: "workbench.appconfig.write")

    static func read() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json
    }

    static func loadWindowFrames() -> WindowFrameStore {
        WindowFrameStore.decode(read()?["window_frames"])
    }

    static func saveWindowFrames(_ store: WindowFrameStore) {
        let payload = store.encoded
        queue.async { merge(windowFrames: payload) }
    }

    /// 退出前的最后一次落盘要**同步**做完:异步排队的话进程已经没了,那一下就丢了。
    static func saveWindowFramesSync(_ store: WindowFrameStore) {
        let payload = store.encoded
        queue.sync { merge(windowFrames: payload) }
    }

    private static func merge(windowFrames: [String: Any]) {
        var json = read() ?? ["version": 1]
        json["window_frames"] = windowFrames
        write(json)
    }

    private static func write(_ json: [String: Any]) {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        guard var data = try? JSONSerialization.data(withJSONObject: json,
                                                     options: [.prettyPrinted, .sortedKeys]) else { return }
        data.append(0x0A) // 结尾换行,跟插件那边 JSON.stringify(...) + '\n' 写出来的一样
        let tmp = "\(path).\(ProcessInfo.processInfo.processIdentifier).\(UUID().uuidString).tmp"
        guard (try? data.write(to: URL(fileURLWithPath: tmp))) != nil else { return }
        // rename(2) 同文件系统内是原子的,且直接覆盖目标——读者要么看到旧的完整文件,
        // 要么看到新的完整文件,不会读到写了一半的 JSON(同插件那边 tmp + rename)。
        if rename(tmp, path) != 0 { try? FileManager.default.removeItem(atPath: tmp) }
    }
}
