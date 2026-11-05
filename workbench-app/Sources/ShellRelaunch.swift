import Foundation

/// 壳这一趟是**自己被人点开的**,还是**热更新换完壳之后自动拉起来的**(2026-09-21)。
///
/// 起因:热更新那一步把 `/Applications/工作台.app` 整个换掉之后,屏幕上跑着的还是
/// 换之前那份二进制 —— 界面上只好写一句「把工作台窗口关掉重开一次」。对一个不懂代码的人,
/// 一次"自动更新"最后要他自己动手关一扇窗,那句话本身就是这条流程没做完的证据。
///
/// 现在服务端会**先让旧壳优雅退出**(AppleScript quit → `applicationWillTerminate` →
/// 窗口位置同步落盘),等它真退了再 `open -n … --args --relaunched-by-update`。
/// 「优雅」两个字是这条路的全部重量:`kill -9` 也能让它消失,但那一下会把
/// 「他把窗口拖到哪儿、拉成多大」连同进程一起丢掉,重开之后窗口回到铺满 —— 那比不重开更气人。
///
/// 这个文件**故意不 import AppKit**:它是纯逻辑,run-tests.sh 编得动也测得了
/// (同 WindowPlacement / WindowMode 那两份)。AppKit 那半截(真去 activate)
/// 留在 AppDelegate 里,只有两行。
enum ShellRelaunch {
    /// 服务端拉起来时带的那个参数。**两边各写一份字面量是会走漂的**,所以插件那侧
    /// (`update/apply.ts` 的 `SHELL_RELAUNCH_FLAG`)与这里各有一条用例钉着同一串字。
    static let flag = "--relaunched-by-update"

    /// 这一趟是不是更新拉起来的。
    ///
    /// 只认**完全相等**的那一个参数:`--relaunched-by-update=1`、`-relaunched-by-update`
    /// 之类的写法一律当"不是"。宁可漏认(退回普通启动,行为与加这一条之前逐字相同),
    /// 也不要把一次人手点开误判成自动重开 —— 误判的后果是窗口莫名其妙抢到最前面来。
    static func isUpdateRelaunch(arguments: [String]) -> Bool {
        // 第 0 个是可执行文件路径,不是参数。
        arguments.dropFirst().contains(flag)
    }

    /// 这一趟启动该怎么开场。
    static func startup(arguments: [String]) -> ShellStartup {
        ShellStartup(relaunchedByUpdate: isUpdateRelaunch(arguments: arguments))
    }
}

/// 启动那一刻的两个决定。字段都是**只读派生**的,免得哪天有人只改了其中一个。
struct ShellStartup: Equatable {
    let relaunchedByUpdate: Bool

    /// 要不要**强行**抬到最前面(`NSApp.activate(ignoringOtherApps: true)`)。
    ///
    /// 和前台档那一下 `NSApp.activate()` 不是同一件事:macOS 14 起无参那版是**合作式**的,
    /// 别的 App 正在前台时系统可以不理它。而自动重开这一趟,前一秒还在前台的那个 App
    /// 正是我们自己刚刚 quit 掉的那份壳 —— 这时候"礼让"会让新壳开在别人后面,
    /// 他看到的就是"工作台更新完之后不见了"。
    ///
    /// 普通启动**不**做这件事:那一下是他自己点的图标,系统本来就会把它放到前面,
    /// 强行抢焦点只会在别的场合里打断人。
    var activateOnLaunch: Bool { relaunchedByUpdate }

    // 「要不要弹辅助功能那个系统框」原来也在这里(自动重开不弹、普通启动弹)。
    // 2026-09-23 起**任何启动都不弹**:启动时只静默查(AppDelegate),弹框只在他自己点了
    // 「去授权」时由服务端经 helper 通道发 `request_accessibility` 触发。这一个开关因此没了。
}

/**
 「回到原窗口位置」这件事,**这个文件里一行代码都没有** —— 这是故意的。

 旧壳退出前 `applicationWillTerminate` 已经把那一帧同步写进了 `app.json` 的
 `window_frames`(`persistFrame(sync: true)`),新壳启动时照常
 `WindowPlacement.chooseScreen(lastScreenKey:…)` + `frame(for:remembered:)` 读它,
 于是它就回到了原处。要是为"被更新拉起"另写一条还原路径,两条路迟早给出不一样的答案,
 而只有其中一条会被人真的用到。

 所以这条链上真正要守的是**上游那一环**:服务端必须让旧壳**优雅退出**,
 而不是 `kill -9`(见 `workbench-plugin/src/server/update/apply.ts`)。
 */
