package com.llm.live2d

import android.annotation.SuppressLint
import android.graphics.Color
import android.service.dreams.DreamService
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.llm.live2d.nativelive2d.NativeLive2DController

/**
 * Live2D 屏保（系统 Daydream）。
 *
 * 在设备「充电 + 闲置 / 竖立充电」时由系统拉起（用户需先在 设置 > 显示 > 屏保 选中本应用）。
 * 承载一个 WebView，**通过 WebViewAssetLoader 以 https://appassets.androidplatform.net/
 * 提供 android assets**，加载精简页 .../assets/public/screensaver.html。
 *
 * 为什么不用 file://：Chromium WebView 的 fetch() 不支持 file:// 协议，而 Live2D 引擎用
 * fetch() 加载 model3.json，会失败导致角色不显示。用 https 虚拟域即可让 fetch 正常工作，
 * 且无需改动前端/引擎代码。
 *
 * 注意：WebGL 依赖硬件加速（WebView 默认开启）——切勿对 WebView 调用
 * setLayerType(LAYER_TYPE_SOFTWARE)，否则 Live2D 黑屏。
 */
class Live2DDreamService : DreamService() {

    private var webView: WebView? = null

    // 低端机原生 Live2D 渲染层（与主 App 共用 Controller）：JS 侧判定低端后经
    // window.AibooNativeLive2D 桥请求建层，GL 垫在透明 WebView 之下。
    private var live2dController: NativeLive2DController? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()

        // 全屏，保持屏幕常亮（充电展示态）
        isFullscreen = true
        // 设为可交互：经典屏保「碰一下就退出」太容易误退；可交互后轻触不再立即消失，
        // 仍可按电源键退出或拿起手机解锁。注意：拿起手机会让设备退出 idle，dream 必然结束——这是系统行为。
        isInteractive = true
        isScreenBright = true

        // 屏保窗口亮度用户可调（默认 45%）：OLED 功耗≈亮度，长时间充电态全亮是发热大头。
        window?.let { w ->
            val lp = w.attributes
            lp.screenBrightness = ScreensaverPrefs.getScreensaverBrightness(this) / 100f
            w.attributes = lp
        }

        WebView.setWebContentsDebuggingEnabled(true)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        val wv = WebView(this)
        wv.setBackgroundColor(Color.BLACK)

        wv.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d(
                    "ScreensaverWeb",
                    "${msg.messageLevel()} ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}",
                )
                return true
            }
        }

        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false // 允许 DJ 音频自动播放
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        // https(appassets) 页访问 http 后端(DJ/天气，常经 adb reverse 或局域网)属混合内容，放行
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        wv.addJavascriptInterface(ScreensaverBridge(applicationContext), "AibooNative")

        // 根容器：WebView 常驻；低端机上 JS 经桥请求后，GL 层插到 index 0（WebView 之下）。
        val root = FrameLayout(this)
        root.addView(
            wv,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val controller = NativeLive2DController(this)
        live2dController = controller
        wv.addJavascriptInterface(
            NativeLive2DScreensaverBridge(controller, root, wv, window),
            "AibooNativeLive2D",
        )

        wv.loadUrl("https://appassets.androidplatform.net/assets/public/screensaver.html")

        webView = wv
        setContentView(root)
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        webView?.onResume()
        webView?.resumeTimers()
        live2dController?.resumeIfVisible()
    }

    override fun onDreamingStopped() {
        super.onDreamingStopped()
        webView?.onPause()
        webView?.pauseTimers()
        live2dController?.pauseIfVisible()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        live2dController?.destroy()
        live2dController = null
        webView?.let { wv ->
            try {
                wv.loadUrl("about:blank")
                wv.removeJavascriptInterface("AibooNative")
                wv.removeJavascriptInterface("AibooNativeLive2D")
                wv.destroy()
            } catch (_: Throwable) {
                // ignore
            }
        }
        webView = null
    }
}
