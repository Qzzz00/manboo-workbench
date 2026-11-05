package com.llm.live2d

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.BatteryManager
import android.provider.CalendarContract
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/**
 * 注入屏保 WebView 的 JS 桥（window.AibooNative）。
 * 所有方法同步返回基本类型或 JSON 字符串；任何异常都回落到安全空值，不让屏保崩。
 */
class ScreensaverBridge(private val ctx: Context) {

    @JavascriptInterface
    fun getServerBaseUrl(): String = ScreensaverPrefs.getServerBaseUrl(ctx)

    @JavascriptInterface
    fun getWeatherCity(): String = ScreensaverPrefs.getWeatherCity(ctx)

    @JavascriptInterface
    fun getScreensaverFps(): Int = ScreensaverPrefs.getScreensaverFps(ctx)

    /** 客户端指定的屏保角色 id（未设置返回空串，Web 端回落默认角色）。 */
    @JavascriptInterface
    fun getScreensaverAvatarId(): String = ScreensaverPrefs.getScreensaverAvatarId(ctx)

    /** 主 App 是否正处于 DJ 模式（带时间戳新鲜度判定）。屏保据此联动换装/电台卡片。 */
    @JavascriptInterface
    fun isDjModeActive(): Boolean = ScreensaverPrefs.isDjModeActive(ctx)

    /** 主 App 当前 DJ 角色 id（未在 DJ 模式返回空串）。 */
    @JavascriptInterface
    fun getDjAvatarId(): String = ScreensaverPrefs.getDjAvatarId(ctx)

    @JavascriptInterface
    fun getBatteryLevel(): Int {
        return try {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } catch (_: Throwable) {
            -1
        }
    }

    @JavascriptInterface
    fun isCharging(): Boolean {
        return try {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.isCharging
        } catch (_: Throwable) {
            false
        }
    }

    @JavascriptInterface
    fun isCalendarGranted(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    @JavascriptInterface
    fun isNotificationAccessGranted(): Boolean {
        return try {
            NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
        } catch (_: Throwable) {
            false
        }
    }

    @JavascriptInterface
    fun getNotificationsJson(): String = AibooNotificationListener.snapshotJson()

    @JavascriptInterface
    fun isLocationGranted(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** 设备最近一次已知位置 + 反地理编码城市名（天气跟随本地）。未授权/取不到返回 ""。 */
    @JavascriptInterface
    fun getLocationJson(): String {
        if (!isLocationGranted()) return ""
        return try {
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            var best: Location? = null
            val providers = listOf(
                LocationManager.NETWORK_PROVIDER,
                LocationManager.GPS_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
            )
            for (p in providers) {
                try {
                    val l = lm.getLastKnownLocation(p)
                    if (l != null && (best == null || l.time > best!!.time)) best = l
                } catch (_: SecurityException) {
                    /* 该 provider 无权限/不可用 */
                }
            }
            val loc = best ?: return ""
            val obj = JSONObject()
            obj.put("lat", loc.latitude)
            obj.put("lon", loc.longitude)
            try {
                @Suppress("DEPRECATION")
                val addrs = Geocoder(ctx, Locale.getDefault()).getFromLocation(loc.latitude, loc.longitude, 1)
                val city = addrs?.firstOrNull()?.let { it.locality ?: it.subAdminArea ?: it.adminArea }
                if (!city.isNullOrBlank()) obj.put("city", city)
            } catch (_: Throwable) {
                /* 反编码失败：只给经纬度 */
            }
            obj.toString()
        } catch (_: Throwable) {
            ""
        }
    }

    @JavascriptInterface
    fun getCalendarEventsJson(): String {
        if (!isCalendarGranted()) return "[]"
        return try {
            queryCalendar()
        } catch (_: Throwable) {
            "[]"
        }
    }

    private fun queryCalendar(): String {
        val now = System.currentTimeMillis()
        val end = now + 3L * 24 * 3600 * 1000 // 未来 3 天

        val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(builder, now)
        ContentUris.appendId(builder, end)
        val uri = builder.build()

        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.ALL_DAY,
        )

        val arr = JSONArray()
        ctx.contentResolver.query(
            uri,
            projection,
            null,
            null,
            "${CalendarContract.Instances.BEGIN} ASC",
        )?.use { cursor ->
            val idxTitle = 0
            val idxBegin = 1
            val idxEnd = 2
            val idxLoc = 3
            val idxAllDay = 4
            var count = 0
            while (cursor.moveToNext() && count < 10) {
                val title = cursor.getString(idxTitle)?.trim().orEmpty()
                if (title.isEmpty()) continue
                val obj = JSONObject()
                obj.put("title", title)
                obj.put("begin", cursor.getLong(idxBegin))
                obj.put("end", cursor.getLong(idxEnd))
                cursor.getString(idxLoc)?.let { if (it.isNotBlank()) obj.put("location", it) }
                obj.put("allDay", cursor.getInt(idxAllDay) == 1)
                arr.put(obj)
                count++
            }
        }
        return arr.toString()
    }
}
