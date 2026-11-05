package com.llm.live2d

import android.content.Context

/**
 * 屏保配置持久化（独立于 Capacitor WebView 的 localStorage）。
 * 由 ScreensaverSetupActivity 写入、ScreensaverBridge 读出注入到屏保网页。
 */
object ScreensaverPrefs {
    private const val PREFS = "aiboo_screensaver"
    const val KEY_SERVER = "server_base_url"
    const val KEY_CITY = "weather_city"
    const val KEY_FPS = "screensaver_fps"
    const val KEY_AVATAR = "screensaver_avatar"
    const val KEY_BRIGHTNESS = "screensaver_brightness"

    // 主 App 是否正处于 DJ 模式（屏保据此联动换装/电台卡片）。带时间戳心跳做新鲜度判定：
    // 主 App 在 DJ 模式且前台时每隔几秒刷新一次时间戳；被杀/久未活动 → 时间戳过期 → 视为未激活。
    const val KEY_DJ_ACTIVE = "dj_mode_active"
    const val KEY_DJ_TS = "dj_mode_ts"
    const val KEY_DJ_AVATAR = "dj_avatar_id"
    // 失效窗口：心跳间隔(~10s)的若干倍，覆盖「息屏→屏保启动」的短延迟，又能识别 App 被杀。
    private const val DJ_STALE_MS = 35_000L

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun getServerBaseUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_SERVER, "")?.trim()?.trimEnd('/') ?: ""

    fun setServerBaseUrl(ctx: Context, value: String) {
        prefs(ctx).edit().putString(KEY_SERVER, value.trim().trimEnd('/')).apply()
    }

    fun getWeatherCity(ctx: Context): String =
        prefs(ctx).getString(KEY_CITY, "")?.trim() ?: ""

    fun setWeatherCity(ctx: Context, value: String) {
        prefs(ctx).edit().putString(KEY_CITY, value.trim()).apply()
    }

    /** 屏保 Live2D 渲染帧率（默认 15；越高越流畅但越耗电/发热）。 */
    fun getScreensaverFps(ctx: Context): Int =
        prefs(ctx).getInt(KEY_FPS, 15)

    fun setScreensaverFps(ctx: Context, value: Int) {
        prefs(ctx).edit().putInt(KEY_FPS, value.coerceIn(10, 60)).apply()
    }

    /** 客户端指定的屏保角色 id（未设置返回空串，Web 端回落默认角色）。 */
    fun getScreensaverAvatarId(ctx: Context): String =
        prefs(ctx).getString(KEY_AVATAR, "")?.trim() ?: ""

    fun setScreensaverAvatarId(ctx: Context, value: String) {
        prefs(ctx).edit().putString(KEY_AVATAR, value.trim()).apply()
    }

    /** 屏保窗口亮度百分比（10–100，默认 45；OLED 功耗≈亮度，默认压暗降温）。 */
    fun getScreensaverBrightness(ctx: Context): Int =
        prefs(ctx).getInt(KEY_BRIGHTNESS, 45)

    fun setScreensaverBrightness(ctx: Context, value: Int) {
        prefs(ctx).edit().putInt(KEY_BRIGHTNESS, value.coerceIn(10, 100)).apply()
    }

    /** 主 App 写入：进入/退出 DJ 模式 + 心跳刷新时间戳。avatarId 为当前 DJ 角色（退出时传空）。 */
    fun setDjMode(ctx: Context, active: Boolean, avatarId: String) {
        prefs(ctx).edit()
            .putBoolean(KEY_DJ_ACTIVE, active)
            .putLong(KEY_DJ_TS, System.currentTimeMillis())
            .putString(KEY_DJ_AVATAR, avatarId)
            .apply()
    }

    /** 屏保读取：是否「正处于」DJ 模式（active 标志 + 时间戳未过期）。 */
    fun isDjModeActive(ctx: Context): Boolean {
        val p = prefs(ctx)
        if (!p.getBoolean(KEY_DJ_ACTIVE, false)) return false
        val age = System.currentTimeMillis() - p.getLong(KEY_DJ_TS, 0L)
        return age in 0..DJ_STALE_MS
    }

    fun getDjAvatarId(ctx: Context): String =
        prefs(ctx).getString(KEY_DJ_AVATAR, "")?.trim() ?: ""
}
