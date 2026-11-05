package com.llm.live2d

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * 客户端屏保中心插件：一键应用屏保（WRITE_SECURE_SETTINGS 直写 + 未授权回落深链）、
 * 屏保参数（角色/亮度/帧数/服务器/城市）读写、日历/定位/通知使用权申请。
 *
 * JS 侧 registerPlugin('Screensaver')。所有方法不把异常抛给 JS：失败 resolve 安全值
 * （唯一例外：深链系统页本身打不开时 reject，UI 提示"无法打开系统设置"）。
 *
 * WRITE_SECURE_SETTINGS 是签名级权限，自用机型装完后执行一次：
 *   adb shell pm grant com.llm.live2d android.permission.WRITE_SECURE_SETTINGS
 * 授予后跨重启/跨升级存活，卸载才失效。
 */
@CapacitorPlugin(
    name = "Screensaver",
    permissions = [
        Permission(strings = [Manifest.permission.READ_CALENDAR], alias = "calendar"),
        Permission(strings = [Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
    ],
)
class ScreensaverPlugin : Plugin() {

    private fun dreamComponent(): String =
        ComponentName(context, Live2DDreamService::class.java).flattenToString()

    private fun listenerComponent(): String =
        ComponentName(context, AibooNotificationListener::class.java).flattenToString()

    private fun secureGranted(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED

    /** 是否已被设为系统屏保且启用（读 secure settings 不需要权限）。 */
    private fun isApplied(): Boolean {
        return try {
            val cr = context.contentResolver
            val comps = Settings.Secure.getString(cr, "screensaver_components") ?: ""
            val enabled = Settings.Secure.getInt(cr, "screensaver_enabled", 0) == 1
            enabled && comps.split(':').any { it == dreamComponent() }
        } catch (_: Throwable) {
            false
        }
    }

    private fun notifAccessGranted(): Boolean = try {
        NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    } catch (_: Throwable) {
        false
    }

    private fun runtimeGranted(perm: String): Boolean =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

    @PluginMethod
    fun getState(call: PluginCall) {
        val ctx = context
        val ret = JSObject()
        try {
            ret.put("applied", isApplied())
            ret.put("secureGranted", secureGranted())
            ret.put("notifAccess", notifAccessGranted())
            ret.put("calendarGranted", runtimeGranted(Manifest.permission.READ_CALENDAR))
            ret.put("locationGranted", runtimeGranted(Manifest.permission.ACCESS_COARSE_LOCATION))
            ret.put("avatarId", ScreensaverPrefs.getScreensaverAvatarId(ctx))
            ret.put("brightness", ScreensaverPrefs.getScreensaverBrightness(ctx))
            ret.put("fps", ScreensaverPrefs.getScreensaverFps(ctx))
            ret.put("server", ScreensaverPrefs.getServerBaseUrl(ctx))
            ret.put("city", ScreensaverPrefs.getWeatherCity(ctx))
        } catch (_: Throwable) {
            // 尽力而为：缺键由 JS 侧 normalize 兜底
        }
        call.resolve(ret)
    }

    /** 一键应用：已授 secure 权限 → 直写三键；否则/写失败 → needManual（UI 走深链）。 */
    @PluginMethod
    fun apply(call: PluginCall) {
        val ret = JSObject()
        if (secureGranted()) {
            try {
                val cr = context.contentResolver
                Settings.Secure.putString(cr, "screensaver_components", dreamComponent())
                Settings.Secure.putInt(cr, "screensaver_enabled", 1)
                // 充电时启动（AOSP「While charging」）
                Settings.Secure.putInt(cr, "screensaver_activate_on_sleep", 1)
                ret.put("applied", isApplied())
                ret.put("needManual", false)
                call.resolve(ret)
                return
            } catch (_: Throwable) {
                // 授权被收回等 → 回落手动
            }
        }
        ret.put("applied", false)
        ret.put("needManual", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun openDreamSettings(call: PluginCall) {
        try {
            val i = Intent(Settings.ACTION_DREAM_SETTINGS)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
            call.resolve()
        } catch (_: Throwable) {
            call.reject("no_dream_settings")
        }
    }

    /** 增量写配置：只写调用方传入的键。 */
    @PluginMethod
    fun setConfig(call: PluginCall) {
        val ctx = context
        try {
            call.getString("avatarId")?.let { ScreensaverPrefs.setScreensaverAvatarId(ctx, it) }
            call.getInt("brightness")?.let { ScreensaverPrefs.setScreensaverBrightness(ctx, it) }
            call.getInt("fps")?.let { ScreensaverPrefs.setScreensaverFps(ctx, it) }
            call.getString("server")?.let { ScreensaverPrefs.setServerBaseUrl(ctx, it) }
            call.getString("city")?.let { ScreensaverPrefs.setWeatherCity(ctx, it) }
        } catch (_: Throwable) {
            // 防崩：单键失败不影响整体
        }
        call.resolve()
    }

    @PluginMethod
    fun requestCalendarPermission(call: PluginCall) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) {
            resolvePermissions(call)
        } else {
            requestPermissionForAlias("calendar", call, "permissionDone")
        }
    }

    @PluginMethod
    fun requestLocationPermission(call: PluginCall) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            resolvePermissions(call)
        } else {
            requestPermissionForAlias("location", call, "permissionDone")
        }
    }

    @PermissionCallback
    private fun permissionDone(call: PluginCall) {
        resolvePermissions(call)
    }

    private fun resolvePermissions(call: PluginCall) {
        val ret = JSObject()
        ret.put("calendarGranted", runtimeGranted(Manifest.permission.READ_CALENDAR))
        ret.put("locationGranted", runtimeGranted(Manifest.permission.ACCESS_COARSE_LOCATION))
        call.resolve(ret)
    }

    /**
     * 开启通知读取：已授 secure 权限 → 追加（冒号分隔、去重）本 listener 到
     * enabled_notification_listeners（系统监听该键自动重绑）；否则深链通知使用权设置页。
     */
    @PluginMethod
    fun enableNotificationAccess(call: PluginCall) {
        val ret = JSObject()
        if (secureGranted()) {
            try {
                val cr = context.contentResolver
                val cur = Settings.Secure.getString(cr, "enabled_notification_listeners") ?: ""
                val mine = listenerComponent()
                val parts = cur.split(':').filter { it.isNotBlank() }
                if (!parts.contains(mine)) {
                    Settings.Secure.putString(
                        cr,
                        "enabled_notification_listeners",
                        (parts + mine).joinToString(":"),
                    )
                }
                ret.put("method", "secure")
                call.resolve(ret)
                return
            } catch (_: Throwable) {
                // 回落深链
            }
        }
        try {
            val i = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
            ret.put("method", "settings")
            call.resolve(ret)
        } catch (_: Throwable) {
            call.reject("no_notification_settings")
        }
    }
}
