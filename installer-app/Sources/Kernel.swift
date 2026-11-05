import Foundation

/// 内核发上来的一条事件。字段与 `workbench-plugin/src/server/setup/installer.ts` 的
/// `InstallerEvent` 一一对应 —— 那边是真相源,这边只是读。
enum KernelEvent {
    case begin(total: Int)
    case step(index: Int, total: Int, key: String, title: String)
    case note(String)
    case log(String)
    case progress(Double)
    case skip(key: String, why: String)
    case fail(key: String, title: String, error: String, tail: [String])
    case done(shellApp: String, workRepo: String)
    /// 这一趟的完整日志写在哪(2026-09-27,卡 PN)。stage0.sh 第一条就发它。
    case logfile(path: String)
    /// 装完之后自检的一件(2026-10-21,卡「引导三件事」):早报 / 交代 / 电话各一条。
    /// `line` 是那一句「成」或「没成 —— 缺哪道门 + 怎么办」;`loginFamilies` 是能一颗键登录的那几家。
    case check(key: String, ok: Bool, line: String, loginFamilies: [(family: String, label: String)])

    /// 一行 JSON → 一条事件。**认不出来的一律当日志**,不丢弃也不崩:
    /// 内核有一小段是 shell 写的(stage0.sh),它在装 node 之前可能打出别的东西。
    static func parse(line: String) -> KernelEvent {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"),
              let data = trimmed.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["t"] as? String
        else { return .log(line) }

        switch type {
        case "begin":
            return .begin(total: json["total"] as? Int ?? 0)
        case "step":
            return .step(index: json["i"] as? Int ?? 0,
                         total: json["n"] as? Int ?? 0,
                         key: json["key"] as? String ?? "",
                         title: json["title"] as? String ?? "")
        case "note":
            return .note(json["text"] as? String ?? "")
        case "log":
            return .log(json["text"] as? String ?? "")
        case "progress":
            return .progress(json["pct"] as? Double ?? 0)
        case "skip":
            return .skip(key: json["key"] as? String ?? "", why: json["why"] as? String ?? "")
        case "fail":
            return .fail(key: json["key"] as? String ?? "",
                         title: json["title"] as? String ?? "",
                         error: json["error"] as? String ?? "没说原因",
                         tail: json["tail"] as? [String] ?? [])
        case "done":
            return .done(shellApp: json["shell_app"] as? String ?? "",
                         workRepo: json["work_repo"] as? String ?? "")
        case "logfile":
            return .logfile(path: json["path"] as? String ?? "")
        case "check":
            let fixes = json["fixes"] as? [[String: Any]] ?? []
            let logins = fixes.compactMap { fix -> (family: String, label: String)? in
                guard fix["kind"] as? String == "login_cli", let family = fix["family"] as? String else { return nil }
                return (family: family, label: fix["label"] as? String ?? "登录 \(family)")
            }
            return .check(key: json["key"] as? String ?? "",
                          ok: json["ok"] as? Bool ?? false,
                          line: json["line"] as? String ?? "",
                          loginFamilies: logins)
        default:
            return .log(line)
        }
    }
}

/// 谁来干活。真的那一份起一个子进程;假的那一份给 `--dry-run` 与截图用。
protocol Kernel {
    /// 跑一遍。`onEvent` 一定在主线程上调;`onExit` 在跑完(或被杀掉)之后调一次。
    func run(onEvent: @escaping (KernelEvent) -> Void, onExit: @escaping (Int32) -> Void)
    func cancel()
}

/// 真内核:`Resources/stage0.sh --json`。
///
/// **安装逻辑一行都不在 Swift 里** —— 这个类只做三件事:起进程、按行读、把 JSON 翻成事件。
/// 这是有意的:安装步骤已经在 `setup/install.ts` 里写过一遍并且有用例盯着,
/// 在界面里再写一遍,两处迟早不一致(而且 Swift 这一份没有用例)。
final class ProcessKernel: Kernel {
    private let resources: String
    private var task: Process?

    init(resources: String) {
        self.resources = resources
    }

    func run(onEvent: @escaping (KernelEvent) -> Void, onExit: @escaping (Int32) -> Void) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [resources + "/stage0.sh", "--resources", resources, "--json"]
        // 语言环境钉死:内核那边的人话是 UTF-8 中文,继承一个奇怪的 LANG 会变成问号。
        var env = ProcessInfo.processInfo.environment
        env["LANG"] = "zh_CN.UTF-8"
        env["WORKBENCH_INSTALLER_RESOURCES"] = resources
        process.environment = env

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        // stdout 按行读 JSON;stderr 一律当日志(npm / curl 的噪音都从那儿来)。
        readLines(from: out) { line in onEvent(KernelEvent.parse(line: line)) }
        readLines(from: err) { line in onEvent(.log(line)) }

        process.terminationHandler = { finished in
            DispatchQueue.main.async { onExit(finished.terminationStatus) }
        }
        self.task = process
        do {
            try process.run()
        } catch {
            onEvent(.fail(key: "start", title: "启动安装程序",
                          error: "起不来安装程序(\(error.localizedDescription))。这份安装包可能是坏的,重新下一份。",
                          tail: []))
            onExit(-1)
        }
    }

    func cancel() {
        task?.terminate()
        task = nil
    }

    /// 按行读一个管道。**不用 `availableData` 一把读完** —— npm 那步要跑几分钟,
    /// 一把读完等于进度条在那几分钟里一动不动。
    private func readLines(from pipe: Pipe, onLine: @escaping (String) -> Void) {
        var pending = Data()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                if !pending.isEmpty, let rest = String(data: pending, encoding: .utf8) {
                    DispatchQueue.main.async { onLine(rest) }
                }
                handle.readabilityHandler = nil
                return
            }
            pending.append(chunk)
            while let index = pending.firstIndex(of: 0x0A) {
                let lineData = pending.subdata(in: pending.startIndex..<index)
                pending.removeSubrange(pending.startIndex...index)
                if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                    DispatchQueue.main.async { onLine(line) }
                }
            }
        }
    }
}

/// 假内核:什么都不装,按脚本把事件播一遍。`--dry-run` 与截图用的就是它。
///
/// 为什么值得有:界面那一半没有用例(Swift 这边不跑测试),而"十步走完长什么样、
/// 失败那屏长什么样"是要给人看的东西 —— 用假内核跑一遍并截图,比嘴上说"应该没问题"实在。
final class FakeKernel: Kernel {
    /// 在第几步失败(1 起);0 = 一路绿灯。
    private let failAt: Int
    private let stepMs: Int
    private var cancelled = false

    init(failAt: Int = 0, stepMs: Int = 400) {
        self.failAt = failAt
        self.stepMs = stepMs
    }

    private static let steps: [(String, String)] = [
        ("node", "正在准备运行环境…"),
        ("runtime", "正在下载工作台的运行时…"),
        ("profile", "正在配置运行环境…"),
        ("plugin", "正在安装工作台…"),
        ("work_repo", "正在建你的工作目录…"),
        ("scripts", "正在安装启动脚本…"),
        ("butler", "正在安装事务官…"),
        ("worker", "正在安装通话组件…"),
        ("livekit", "正在安装本机通话服务…"),
        ("shell", "正在把工作台放进「应用程序」…"),
        ("launchd", "正在设置开机自动启动…"),
        ("desktop", "正在把桌面整理一下…"),
    ]

    func run(onEvent: @escaping (KernelEvent) -> Void, onExit: @escaping (Int32) -> Void) {
        let steps = FakeKernel.steps
        let delay = stepMs
        DispatchQueue.global().async { [weak self] in
            let emit: (KernelEvent) -> Void = { event in DispatchQueue.main.async { onEvent(event) } }
            emit(.logfile(path: NSHomeDirectory() + "/Library/Logs/工作台/安装-演示.log"))
            emit(.begin(total: steps.count))
            for (index, step) in steps.enumerated() {
                if self?.cancelled == true { return }
                emit(.step(index: index + 1, total: steps.count, key: step.0, title: step.1))
                emit(.note("(演示)这一步在真机上会真的动手"))
                emit(.log("$ (演示)\(step.0)"))
                if step.0 == "node" {
                    for pct in stride(from: 0.0, through: 1.0, by: 0.25) {
                        emit(.progress(pct))
                        Thread.sleep(forTimeInterval: Double(delay) / 4000.0)
                    }
                }
                if self?.failAt == index + 1 {
                    emit(.fail(key: step.0, title: step.1,
                               error: "网不通,下不下来(演示用的假失败)。连上网之后点「重试」,装好的不会重装。",
                               tail: ["npm error network request to https://registry.npmjs.org/… failed",
                                      "npm error network This is a problem related to network connectivity."]))
                    DispatchQueue.main.async { onExit(2) }
                    return
                }
                Thread.sleep(forTimeInterval: Double(delay) / 1000.0)
            }
            emit(.done(shellApp: "/Applications/工作台.app",
                       workRepo: NSHomeDirectory() + "/Documents/工作台"))
            // 装完之后那三行(演示):一成两没成,真机上的字由内核照 `selfCheckLine` 拼。
            Thread.sleep(forTimeInterval: Double(delay) / 1000.0)
            emit(.check(key: "morning", ok: true, line: "早报与播客:成", loginFamilies: []))
            emit(.check(key: "delegate", ok: false,
                        line: "交代一件事:没成 —— 没登录 Claude 或 Codex。先登录 Claude 或 Codex 其中一家(点「登录 Claude」)。",
                        loginFamilies: [(family: "claude", label: "登录 Claude")]))
            emit(.check(key: "call", ok: false,
                        line: "打个电话:没成 —— 手机没配对。扫一下配对页的二维码,或在手机上输那六位配对码;没有安卓手机也行,第三件改在电脑上对我说一句。",
                        loginFamilies: []))
            DispatchQueue.main.async { onExit(0) }
        }
    }

    func cancel() { cancelled = true }
}
