package com.llm.live2d

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import org.json.JSONArray

/**
 * 桌面组件插件：App 内烤好的帧经此落盘（filesDir/widgetFrames）并刷新桌面。
 * JS 侧 registerPlugin('Widget')。所有方法防崩：失败 resolve 安全值。
 */
@CapacitorPlugin(name = "Widget")
class WidgetPlugin : Plugin() {

    @PluginMethod
    fun getState(call: PluginCall) {
        val ret = JSObject()
        try {
            val ctx = context
            val meta = WidgetFrameStore.readMeta(ctx)
            val avatarId = meta?.optString("avatarId") ?: ""
            ret.put("avatarId", avatarId)
            ret.put("activeLoop", meta?.optString("activeLoop") ?: "")
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, AibooWidgetProvider::class.java))
            ret.put("added", ids.isNotEmpty())
            ret.put("loops", if (avatarId.isNotEmpty()) WidgetFrameStore.listLoops(ctx, avatarId) else JSONArray())
        } catch (_: Throwable) {
            // 缺键由 JS normalize 兜底
        }
        call.resolve(ret)
    }

    /** 写一环帧（base64 png 数组）。首个环自动设为 active 并刷新桌面。 */
    @PluginMethod
    fun saveFrames(call: PluginCall) {
        val ret = JSObject()
        var saved = 0
        try {
            val ctx = context
            val avatarId = call.getString("avatarId") ?: ""
            val loopKey = call.getString("loopKey") ?: ""
            val fps = call.getInt("fps") ?: 12
            val frames = call.getArray("frames")
            if (avatarId.isNotEmpty() && loopKey.isNotEmpty() && frames != null && frames.length() > 0) {
                val dir = WidgetFrameStore.loopDir(ctx, avatarId, loopKey)
                dir.deleteRecursively()
                dir.mkdirs()
                for (i in 0 until frames.length()) {
                    val b64 = frames.optString(i) ?: continue
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    File(dir, String.format("%03d.png", i)).writeBytes(bytes)
                    saved++
                }
                val meta = WidgetFrameStore.readMeta(ctx)
                val sameAvatar = meta?.optString("avatarId") == avatarId
                val hadActive = sameAvatar && !(meta?.optString("activeLoop") ?: "").isNullOrEmpty()
                val active = if (hadActive) meta!!.optString("activeLoop") else loopKey
                WidgetFrameStore.writeMeta(ctx, avatarId, active, fps, saved)
                AibooWidgetProvider.refreshAll(ctx)
            }
        } catch (_: Throwable) {
            // 部分写入也如实返回 saved
        }
        ret.put("saved", saved)
        call.resolve(ret)
    }

    @PluginMethod
    fun setActiveLoop(call: PluginCall) {
        try {
            val ctx = context
            val avatarId = call.getString("avatarId") ?: ""
            val loopKey = call.getString("loopKey") ?: ""
            if (avatarId.isNotEmpty() && loopKey.isNotEmpty()) {
                val fps = WidgetFrameStore.readMeta(ctx)?.optInt("fps", 12) ?: 12
                val n = WidgetFrameStore.loopDir(ctx, avatarId, loopKey)
                    .listFiles { f -> f.name.endsWith(".png") }?.size ?: 0
                WidgetFrameStore.writeMeta(ctx, avatarId, loopKey, fps, n)
                AibooWidgetProvider.refreshAll(ctx)
            }
        } catch (_: Throwable) {
            // 防崩
        }
        call.resolve()
    }

    /** 一键添加到桌面：launcher 支持 pin 则弹系统确认。 */
    @PluginMethod
    fun requestPin(call: PluginCall) {
        val ret = JSObject()
        var ok = false
        try {
            val ctx = context
            val mgr = AppWidgetManager.getInstance(ctx)
            if (mgr.isRequestPinAppWidgetSupported) {
                ok = mgr.requestPinAppWidget(
                    ComponentName(ctx, AibooWidgetProvider::class.java),
                    null,
                    null,
                )
            }
        } catch (_: Throwable) {
            ok = false
        }
        ret.put("requested", ok)
        call.resolve(ret)
    }

    @PluginMethod
    fun refresh(call: PluginCall) {
        try {
            AibooWidgetProvider.refreshAll(context)
        } catch (_: Throwable) {
            // 防崩
        }
        call.resolve()
    }
}
