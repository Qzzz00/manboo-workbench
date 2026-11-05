package com.llm.live2d

import android.graphics.Color
import android.util.Log
import android.view.ViewGroup
import android.view.Window
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import com.llm.live2d.nativelive2d.NativeLive2DController
import org.json.JSONObject

/**
 * 充电屏保（DreamService）里的原生 Live2D 渲染桥：以 addJavascriptInterface 挂到屏保
 * WebView 的 `window.AibooNativeLive2D`，方法面与主 App 的 Capacitor 插件一致（JSON 字符串版）。
 *
 * 与主 App 同一套 [NativeLive2DController]（GL 垫底 + Cubism 关物理渲染）；低端机上屏保
 * WebView 只剩 UI（时钟/电台卡），角色由原生层画——WebView Pixi 7-8fps 的卡顿就此绕开。
 *
 * showModel 是异步的（模型在 GL 线程加载）：结果经 evaluateJavascript 回调
 * `window.__aibooNl2dResolve(resultJson)` / `window.__aibooNl2dReject(message)`。
 */
class NativeLive2DScreensaverBridge(
    private val controller: NativeLive2DController,
    private val root: FrameLayout,
    private val webView: WebView,
    private val window: Window?,
    // true=悬浮窗透明合成（U3 固定浮窗，GL 走 media overlay 露下层）；false=屏保全屏不透明（默认 punch-hole）。
    private val transparentOverlay: Boolean = false,
    // 桌宠「显示背景」的圆角卡片：GL 是独立 SurfaceView，pet.css .pet-card 的 CSS 圆角裁不到它，
    // view outline 裁剪对 setZOrderMediaOverlay 的 surface 也不生效（真机实测）——
    // 故圆角由背景 shader 的 SDF 擦 alpha 实现（NativeLive2DRenderer.setCornerRadius），
    // 这里只把半径（dp，与 .pet-card 的 22px 同源）带进来。0=直角（屏保/无背景桌宠）。
    private val cornerRadiusDp: Float = 0f,
    private val onHostResumed: ((Long) -> Unit)? = null,
) {
    private companion object {
        const val TAG = "NativeLive2D"
    }

    @Volatile private var lifecycleTraceId: Long? = null

    /** Host-owned handheld ID. Ordinary screensaver hosts leave it null and use native fallback IDs. */
    fun setLifecycleTraceId(id: Long?) {
        lifecycleTraceId = id
    }

    /** 渲染能力探测：核心 .so 可用才走原生（JS 侧还会叠加 isLowEndDevice 判定）。 */
    @JavascriptInterface
    fun available(): Boolean = controller.isCoreAvailable()

    @JavascriptInterface
    fun showModel(optsJson: String) {
        val opts = parse(optsJson) ?: run {
            rejectToJs("bad opts json")
            return
        }
        lifecycleTraceId?.let { opts.put("lifecycleTraceId", it) }
        controller.runOnUi {
            // 穿透三件套的宿主侧：GL 垫底 + WebView/窗口透明（页面侧 CSS 由 JS 加 html.native-live2d）
            controller.attachUnderOnUiThread(
                root, 0,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
                transparentOverlay,
            )
            webView.setBackgroundColor(Color.TRANSPARENT)
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

            // 桌宠 bg 卡片的圆角半径 → 背景 shader（attach 后 glHost 才存在，故放在这里）。
            if (cornerRadiusDp > 0f) {
                controller.setCornerRadius(cornerRadiusDp * root.resources.displayMetrics.density)
            }

            controller.showModel(opts, { id -> onHostResumed?.invoke(id) }) { result, error ->
                if (result != null) resolveToJs(result.toString()) else rejectToJs(error ?: "showModel failed")
            }
        }
    }

    @JavascriptInterface
    fun setOverlayTargets(paramsJson: String) {
        controller.setOverlayTargets(parse(paramsJson))
    }

    @JavascriptInterface
    fun setPersistentParams(paramsJson: String) {
        controller.setPersistentParams(parse(paramsJson))
    }

    @JavascriptInterface
    fun setMouthParams(paramsJson: String) {
        controller.setMouthParams(parse(paramsJson))
    }

    @JavascriptInterface
    fun playMotion(group: String) {
        controller.playMotion(group)
    }

    @JavascriptInterface
    fun setLayout(layoutJson: String) {
        controller.setLayout(parse(layoutJson))
    }

    /** 底部软边渐隐 {start,end}（从顶部起算比例）。桌宠浮窗「上半身+透明悬浮」用它防赛博截肢。 */
    @JavascriptInterface
    fun setBottomFade(optsJson: String) {
        controller.setBottomFade(parse(optsJson))
    }

    @JavascriptInterface
    fun setBackground(optsJson: String) {
        controller.setBackground(parse(optsJson))
    }

    @JavascriptInterface
    fun awaitNextFrame() {
        try {
            controller.showAfterFrame(
                lifecycleTraceId,
                { id -> onHostResumed?.invoke(id) },
            ) { resolveToJs("{}") }
        } catch (t: Throwable) {
            rejectToJs(t.message ?: "awaitNextFrame failed")
        }
    }

    @JavascriptInterface
    fun hide() {
        controller.hide()
    }

    private fun parse(json: String): JSONObject? =
        try {
            JSONObject(json)
        } catch (t: Throwable) {
            Log.w(TAG, "bridge json parse failed: ${json.take(80)}", t)
            null
        }

    private fun resolveToJs(resultJson: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.__aibooNl2dResolve && window.__aibooNl2dResolve($resultJson)",
                null,
            )
        }
    }

    private fun rejectToJs(message: String) {
        val quoted = JSONObject.quote(message)
        webView.post {
            webView.evaluateJavascript(
                "window.__aibooNl2dReject && window.__aibooNl2dReject($quoted)",
                null,
            )
        }
    }
}
