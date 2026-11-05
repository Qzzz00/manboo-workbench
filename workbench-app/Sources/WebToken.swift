import Foundation

/// 壳第一次打开时的「dsh web 令牌」那一步(2026-09-23 从零重装验收)。
///
/// ## 为什么要有这一步
///
/// dsh web(3080)只认两样:`/?token=<launchToken>`(GET / 时换成一个签名 cookie,
/// 然后 303 回到干净的 `/`),或者那个 cookie。壳固定加载 `http://127.0.0.1:3080/?ben-workbench=app`,
/// 从来不带令牌。老机器没暴露,是因为壳的 WebKit 里存着很久以前种下的 cookie;
/// 新机器上一个都没有,整屏只剩一行 `dsh web authentication required; reopen the URL printed by dsh web.`
///
/// ## 令牌从哪来:壳自己读 `~/.dsh/logs/web.stdout.log`
///
/// launchToken 每次 dsh 重启都换,打印在 web.stdout.log 里(`dsh web: http://127.0.0.1:3080/?token=…`)。
/// 另一条路是让 8791 加一个回环接口把这条地址回给壳 —— 没选,理由写在交接里,一句话:
/// **不给一个会被手机/局域网访问的 HTTP 服务再加一个「发钥匙」的口子**;日志文件同一个用户本来就读得到,
/// 壳读它不新增任何暴露面,也不依赖插件那一半有没有加载成功。
///
/// ## 纪律
///
/// - 令牌**只在内存里**:不落盘、不打日志、不写进 app.json。它只在一次 `load` 里出现一下,
///   dsh 回 303 + Set-Cookie 之后就换回原地址。
/// - 日志轮转(`workbench-plugin/src/server/diagnostics/rotate.ts`):活着那份每天**原地截断**,
///   尾巴抄到 `web.stdout.log.<YYYY-MM-DD>`。所以活着那份没有令牌时,再看最新一份轮转出来的 ——
///   dsh 重启一定写进活着那份,活着那份里没有就说明从轮转那一刻起 dsh 没重启过,轮转那份里的还有效。
///
/// 这个文件**故意不 import AppKit / WebKit**:纯逻辑,run-tests.sh 编得动也测得了。
enum WebToken {
    /// dsh 用的查询参数名(dsh-client-connection 的 TOKEN_QUERY)。
    static let queryName = "token"

    /// 一段日志里**最新**一条带令牌的地址里的令牌值。没有就 nil。
    ///
    /// 与插件那侧 `latestWebToken`(workbench-plugin/src/server/setup/status.ts)认同一种行:
    /// `http(s)://127.0.0.1:<端口>/?token=<值>`,值到空白或引号为止。
    static func latest(inLog log: String) -> String? {
        let pattern = #"https?://127\.0\.0\.1:\d+/\?token=([^\s"']+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(log.startIndex..., in: log)
        guard let last = regex.matches(in: log, range: range).last,
              let valueRange = Range(last.range(at: 1), in: log) else { return nil }
        let value = String(log[valueRange])
        return value.isEmpty ? nil : value
    }

    /// 按什么顺序读哪几份日志:活着那份 → 轮转出来的、按日期新到旧。
    ///
    /// `names` 是 logs 目录里的文件名。只认 `web.stdout.log.<YYYY-MM-DD>` 这种后缀,
    /// 别的(`web.stderr.log.*`、临时文件)一概不看。
    static func candidateFiles(logsDir: String, names: [String]) -> [String] {
        let live = "web.stdout.log"
        let rotated = names.filter { name in
            guard name.hasPrefix(live + ".") else { return false }
            let suffix = name.dropFirst(live.count + 1)
            return suffix.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        }.sorted(by: >)
        return ([live] + rotated).map { (logsDir as NSString).appendingPathComponent($0) }
    }

    /// 把令牌加到壳平常加载的那个地址上(`?ben-workbench=app` 原样留着)。
    ///
    /// dsh 认令牌时只看路径是不是 `/`、`token` 是不是恰好一个,别的参数不管 ——
    /// 所以带着 `ben-workbench=app` 一起发过去没问题。它回 303 到干净的 `/`,
    /// 那一跳由 AppDelegate 截下来换回原地址(见 `isBareRootRedirect`)。
    static func authenticatedURL(page: URL, token: String) -> URL? {
        guard var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
        var items = (parts.queryItems ?? []).filter { $0.name != queryName }
        items.append(URLQueryItem(name: queryName, value: token))
        parts.path = "/"
        parts.queryItems = items
        return parts.url
    }

    /// 两个地址是不是同一个 dsh web(协议 + 主机 + 端口)。401 只在是它的时候才接手。
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased()
            && (a.port ?? defaultPort(a)) == (b.port ?? defaultPort(b))
    }

    /// dsh 换完 cookie 之后 303 回去的那个干净的 `/`(同源、路径 `/`、没有任何查询参数)。
    /// 正在换令牌的时候看到它,就说明 cookie 种上了 —— 截下来改走原地址。
    static func isBareRootRedirect(_ url: URL, page: URL) -> Bool {
        guard sameOrigin(url, page) else { return false }
        let path = url.path.isEmpty ? "/" : url.path
        return path == "/" && (url.query ?? "").isEmpty
    }

    /// 连着第几次 401 之后,隔多久再去取一次令牌。
    ///
    /// 第一次立刻取(新机器上这是常态,不该让人等);之后说明日志里那条是旧的
    /// (dsh 刚重启、新的还没打印)或者还没有,按页面加载失败那套退避 2→4→8→10 秒封顶。
    static func delay(afterConsecutiveFailures n: Int) -> TimeInterval {
        if n <= 0 { return 0 }
        return min(pow(2, Double(n)), 10)
    }

    private static func defaultPort(_ url: URL) -> Int? {
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}

/// 读日志的那一半(碰文件系统,所以不在上面那个纯逻辑里)。
///
/// 路径**显式传入**:`NSHomeDirectory()` 不认 `$HOME`(Config.swift 里那条坑),
/// 想用假家目录验证只能传路径进来。
enum WebTokenReader {
    /// 读到的最新令牌。任何一步读不到都是 nil —— 调用方按「这次没取到、过一会儿再试」处理。
    static func latestToken(logsDir: String) -> String? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: logsDir)) ?? []
        for path in WebToken.candidateFiles(logsDir: logsDir, names: names) {
            guard let data = FileManager.default.contents(atPath: path) else { continue }
            let text = String(decoding: data, as: UTF8.self)
            if let token = WebToken.latest(inLog: text) { return token }
        }
        return nil
    }
}
