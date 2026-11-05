package com.llm.live2d

import android.content.Context
import android.content.Intent

/**
 * 底条启动参数的持久化。
 *
 * 为什么存在：底条的显示/隐藏由实体侧键（F10，AibooKeyService）全局切换，但按键发生时
 * Aiboo 的 WebView 可能根本不在运行——参数没法现场找 JS 要。于是约定：
 * JS（handheldStrip.ts）仍是参数的唯一真相源，它在桌面启动与设置变更时把全套 extras
 * 同步到这里；按键侧只做「回放」，一个参数都不自己拼。
 */
object StripIntentStore {
    private const val PREFS = "aiboo_strip_intent"

    fun save(ctx: Context, i: Intent) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("avatarId", i.getStringExtra("avatarId"))
            .putString("petQuery", i.getStringExtra("petQuery"))
            .putInt("widthDp", i.getIntExtra("widthDp", 260))
            .putString("aspect", i.getStringExtra("aspect"))
            .putString("token", i.getStringExtra("token"))
            // ★军师**语音**的 token（打 Aiboo 后台），与上面那个是两个东西。
            // 这张表是显式白名单：新加的 extra 不在这里列一行就会被静默丢掉，
            // 症状是 F10 呼出的底条没有语音（漏了这行实翻过一次）。
            .putString("aibooToken", i.getStringExtra("aibooToken"))
            .putBoolean("fixed", i.getBooleanExtra("fixed", false))
            .putInt("xPx", i.getIntExtra("xPx", -1))
            .putInt("yPx", i.getIntExtra("yPx", -1))
            .putInt("widthPx", i.getIntExtra("widthPx", -1))
            .putInt("heightPx", i.getIntExtra("heightPx", -1))
            .putBoolean("touchThrough", i.getBooleanExtra("touchThrough", false))
            .putBoolean("webTouchable", i.getBooleanExtra("webTouchable", false))
            .apply()
    }

    /** 还没同步过参数（桌面从未启动过）时返回 null，调用侧应静默放弃而不是拼默认值。 */
    fun load(ctx: Context): Intent? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val avatarId = p.getString("avatarId", null) ?: return null
        return Intent(ctx, Live2DOverlayService::class.java)
            .putExtra("avatarId", avatarId)
            .putExtra("petQuery", p.getString("petQuery", ""))
            .putExtra("widthDp", p.getInt("widthDp", 260))
            .putExtra("aspect", p.getString("aspect", "3:4"))
            .putExtra("token", p.getString("token", ""))
            .putExtra("aibooToken", p.getString("aibooToken", ""))
            .putExtra("fixed", p.getBoolean("fixed", false))
            .putExtra("xPx", p.getInt("xPx", -1))
            .putExtra("yPx", p.getInt("yPx", -1))
            .putExtra("widthPx", p.getInt("widthPx", -1))
            .putExtra("heightPx", p.getInt("heightPx", -1))
            .putExtra("touchThrough", p.getBoolean("touchThrough", false))
            .putExtra("webTouchable", p.getBoolean("webTouchable", false))
    }
}
