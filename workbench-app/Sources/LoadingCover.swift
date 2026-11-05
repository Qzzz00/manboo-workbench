import Foundation

/// 壳自己的加载占位(2026-09-23 维护者从零重装:壳加载插件时露出上游的「HARNESS / Loading plugins…」)。
///
/// 上游那一屏不改(C3 锁版本,上游仓库保持干净)。壳在 WKWebView 上面先盖一层「工作台 · 正在打开…」,
/// **等工作台插件那一层真的挂上了**才揭开:插件在 `WorkbenchOverlay` 挂载时往
/// `window.webkit.messageHandlers.benWorkbenchShell` 发一条 `{type:'ready'}`(workbench-plugin/src/client/shell.ts)。
///
/// 这个文件只放判断(纯逻辑,不 import AppKit,run-tests.sh 里有用例);盖板那块视图在 LoadingCoverView.swift。
///
/// 几条规矩:
/// - 每次主框架换页(commit)都重新盖上:热更新自动 reload、⌘R 也不露出上游那一屏。
/// - 页面提交了、等了 `revealAfterCommit` 秒还没收到 ready(插件没加载成功)→ 揭开,让人看到上游的原话(比一直盖着强)。
/// - 页面一直没提交(dsh 还没起来,壳在重试)→ 一直盖着,副标题换成「还在等…」,不露出白屏/错误页。
/// - 这条消息只有「揭开」一个作用,不带数据;页面伪造了也只是早揭开一下。
enum LoadingCover {
    static let handlerName = "benWorkbenchShell"
    /// 页面提交后多久还没 ready 就揭开。
    static let revealAfterCommit: TimeInterval = 20
    /// 盖了多久之后副标题换成「还在等」。
    static let slowAfter: TimeInterval = 12

    static let title = "工作台"

    /// 认不认这条消息是「工作台挂上了」:名字对、主框架发的、body 是 `{type:'ready'}`。
    static func isReady(name: String, body: Any, isMainFrame: Bool) -> Bool {
        guard name == handlerName, isMainFrame else { return false }
        guard let dict = body as? [String: Any] else { return false }
        return dict["type"] as? String == "ready"
    }

    /// 盖板上那一行小字。等久了换一句,告诉人不是卡死了。
    static func subtitle(waited: TimeInterval) -> String {
        waited >= slowAfter ? "还在等工作台启动,第一次打开会久一点…" : "正在打开…"
    }
}
