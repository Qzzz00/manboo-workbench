import Foundation

/**
 壳每次打开 / 激活 / 叫到台前一个 App 都记一行(2026-10-02 维护者拍板「诊断包加两样」)。

 ## 为什么要有这一份

 10-02 Air 那位运营同学撞上「网易云音乐每隔 10s 自行打开、不断弹窗」。统筹排查到最后只能写
 「**没查实**」:工作台这一头的每条管线都查过了(登记表巡检全是只读 op、派活那三张卡都 `done`),
 而**壳这一头一行记录都没有** —— 谁在什么时候让哪个包到了台前,事后没有任何地方说得出。
 维护者的要求是「不要拿着打补丁的心态」,所以这一份记的不是网易云,是**每一次**。

 ## 记在哪一处

 不在每一个 `app.activate()` 旁边记:`TextInsert` 里光 `activate` 就有七八处(写字前、按发送前、
 读窗口前各一下),逐处记等于同一件事记五行,而且**加一条新路就会漏一行**。
 记在**腰眼**上:所有让壳动别人窗口的活都从 `HelperSocket.handle` 那一个口进来,
 那里记一行,路由表里加 op 就自动跟着记。段外那一下(`WebHost` 把链接交给系统打开)单独记一行。

 ## 一行里有什么

 时间、哪个包、哪个 op。**没有「哪条管线」** —— 那是插件那一头才知道的事(是派活、是捎话、
 还是登记表巡检),所以插件在让壳 / 让 `open -b` 开 App 的地方**自己也记一行带时间**
 (`workbench-plugin/src/server/appOpenLog.ts`),两头按时间对。
 不把管线名加进 helper 协议是故意的:那是一条有 7 个消费方的接缝(插件 / 电话工人 / 手机 /
 展示台 / 座机 / 壳 / 中转),为一行日志改它不值当,而两行日志能回答同一个问题。

 **窗口里的字一个都不记**:这一行只有身份(包标识)与动作,她那句话、那家回的话都不进来。
 */
enum AppOpenLog {
    /// 行首那个记号(排障时 `grep 开App`)。用例与真实现都引这一份,不逐字抄。
    static let tag = "开App"

    /**
     会把一个 App 打开 / 激活 / 从程序坞里放出来的 op。

     判据是「这个 op 走下去会不会让别人的窗到她眼前」,逐个过 `HelperSocket.dispatch` 那张路由表:

     - `raise_window` → `WindowControl.raise` 里 `app.activate()`;
     - `unhide_app` → `app.unhide()`;
     - `send_text` / `focus_input` → `TextInsert` 写字前 `activate`(藏着的还先 `unhide`);
     - `read_reply` / `read_texts` → 读之前把藏着的那一家 `unhide` 放出来;
     - `quota_page`(2026-10-03,卡 QP)→ 同理先 `unhide` 放出来(**不 activate**)再按那颗键;
       它不叫台前,但「那一家的窗这一下露在屏上过」照样是她看得见的一件事,所以记;
     - `agent_pick` / `agent_press` / `agent_stop` / `agent_write_ask` / `agent_approval`
       → 都要先 `frontForWindowAction` 把那扇窗叫到台前才点得下去。

     **只读、不碰窗的那几个不在表里**(`screen_info` / `app_info` / `running_apps` /
     `icon_colors` / `app_icon` / `agent_probe` / `ax_probe` / `observe` / `hover_zone` /
     `highlight_region` / `window_mode` / `notify` …):它们一拍都不动别人的窗,
     记进来只会把这份日志刷满、把真正那几行埋掉。`hide_app` 同理(它是藏起来,不是开出来)。

     `set_window_frame` 也不在表里:它只挪已经开着的那扇窗。
     */
    static let openingOps: Set<String> = [
        "raise_window",
        "unhide_app",
        "send_text",
        "focus_input",
        "read_reply",
        "read_texts",
        "quota_page",
        "agent_pick",
        "agent_press",
        "agent_stop",
        "agent_write_ask",
        "agent_approval",
    ]

    static func opensApp(_ op: String) -> Bool { openingOps.contains(op) }

    /// 本地时间到毫秒。本地时区是故意的:维护者与她看的都是本地时间,UTC 要在脑子里换一遍。
    static func stamp(_ at: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return formatter.string(from: at)
    }

    /**
     那一行。缺席的那几格不占位置(包标识读不到 = 不是一次开 App 就该说出来,不写个假的)。

     `why` 是壳自己知道的那一点点由头(比如 `send_text` 带了「先开新对话」),
     插件那一头的管线名不在这里 —— 见文件头。
     */
    static func line(at: Date, bundleId: String, op: String, why: String? = nil,
                     timeZone: TimeZone = .current) -> String {
        let who = bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [
            tag,
            stamp(at, timeZone: timeZone),
            who.isEmpty ? "(没给包标识)" : who,
            op,
        ] + ((why?.isEmpty ?? true) ? [] : [why!])
        return parts.joined(separator: " · ")
    }

    /// 真记下去(NSLog 落在 default 级别,诊断包里「全级别那一段」收它)。
    static func note(bundleId: String, op: String, why: String? = nil) {
        NSLog("%@", line(at: Date(), bundleId: bundleId, op: op, why: why))
    }
}
