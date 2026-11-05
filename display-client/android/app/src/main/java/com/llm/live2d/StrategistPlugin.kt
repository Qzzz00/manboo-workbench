package com.llm.live2d

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * 军师原生桥（主 App 侧）。底条 WebView 不是 Capacitor WebView，它走
 * [OverlayWindow] 里的 `AibooStrategist` JavascriptInterface —— 两边共用
 * [ScreenCapture]，能力实现只有一份。
 *
 * 本插件给主 App 用：设置页的截屏自检、麦克风权限请求（overlay Service 没有
 * Activity 上下文，弹不了运行时权限窗，必须在这里先要一次）。
 */
@CapacitorPlugin(
    name = "Strategist",
    permissions = [Permission(alias = "mic", strings = [Manifest.permission.RECORD_AUDIO])],
)
class StrategistPlugin : Plugin() {

    /** 能力自检：无障碍开没开、麦克风给没给。设置页据此给引导文案。 */
    @PluginMethod
    fun capabilities(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("screenshot", AibooKeyService.instance != null)
                .put("mic", micGranted()),
        )
    }

    /**
     * 截一张（自检用）。
     * delayMs：延时后再截 —— 设置页「截屏自检」按这个按钮后有几秒切进游戏，
     * 才验得到「游戏全屏时能不能截」。正式问答路径传 0。
     */
    @PluginMethod
    fun captureScreenshot(call: PluginCall) {
        val crop = call.getInt("cropBottomPx") ?: 0
        val maxBytes = call.getInt("maxBytes") ?: 300_000
        val delayMs = (call.getInt("delayMs") ?: 0).toLong().coerceIn(0, 30_000)
        Handler(Looper.getMainLooper()).postDelayed({
            ScreenCapture.capture(AibooKeyService.instance, crop, maxBytes) { r ->
                when (r) {
                    is ScreenCapture.Result.Ok -> call.resolve(
                        JSObject()
                            .put("jpegBase64", r.jpegBase64)
                            .put("widthPx", r.widthPx)
                            .put("heightPx", r.heightPx)
                            .put("bytes", r.bytes),
                    )
                    // reject 的 message 就是 code，JS 侧 classifyCaptureError 按它给文案。
                    is ScreenCapture.Result.Err -> call.reject(r.code)
                }
            }
        }, delayMs)
    }

    /** 请求麦克风运行时权限（语音提问要用；overlay Service 弹不了这个窗）。 */
    @PluginMethod
    fun requestMicPermission(call: PluginCall) {
        if (micGranted()) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("mic", call, "onMicResult")
    }

    @PermissionCallback
    private fun onMicResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", micGranted()))
    }

    private fun micGranted(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
}
