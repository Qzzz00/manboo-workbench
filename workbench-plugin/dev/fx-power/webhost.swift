// 量 WebKit 用的小宿主:一扇几乎透明、点不中的窗(不抢焦点、不挡人),里面一块 WKWebView 开指定页面,到点退出。
// 不写任何配置:网站数据用非持久的那一份。
import Cocoa
import WebKit

final class Host: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var web: WKWebView!
  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = CommandLine.arguments
    let url = URL(string: args[1])!
    let seconds = Double(args.count > 2 ? args[2] : "20") ?? 20
    let alpha = CGFloat(Double(args.count > 3 ? args[3] : "0.02") ?? 0.02)
    let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let size = NSSize(width: 720, height: 760)
    let rect = NSRect(x: frame.maxX - size.width, y: frame.minY, width: size.width, height: size.height)
    window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    window.alphaValue = alpha
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
    window.contentView = web
    window.orderFrontRegardless()
    web.load(URLRequest(url: url))
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = Host()
app.delegate = host
app.run()
