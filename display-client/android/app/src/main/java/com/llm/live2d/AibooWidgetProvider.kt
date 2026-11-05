package com.llm.live2d

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.widget.RemoteViews

/**
 * Live2D 桌面组件：帧由 App 内烘焙写入 filesDir，launcher 的 ViewFlipper 自动翻帧
 * ——我们进程不需要活着，零后台零功耗。
 *
 * spike 阶段：3 张纯色假帧验证 MIUI launcher 翻帧兼容性（GATE）；Task 2 换真帧。
 */
class AibooWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) {
            try {
                mgr.updateAppWidget(id, buildViews(context))
            } catch (_: Throwable) {
                try {
                    mgr.updateAppWidget(id, placeholderViews(context))
                } catch (_: Throwable) {
                    // 绝不崩桌面
                }
            }
        }
    }

    companion object {
        /** 读 filesDir 真帧建视图；无帧/超预算读失败 → placeholder 引导。 */
        fun buildViews(context: Context): RemoteViews {
            val loaded = WidgetFrameStore.loadActiveFrames(context) ?: return placeholderViews(context)
            val (frames, fps) = loaded
            return buildFlipperViews(context, frames, (1000 / fps.coerceIn(1, 30)))
        }

        fun buildFlipperViews(context: Context, frames: List<Bitmap>, intervalMs: Int): RemoteViews {
            // ★冻结治本：ViewFlipper.autoStart 只在视图 attach 时点火；同布局 RemoteViews 原地
            // reapply 不走 attach → 每次烤完 refreshAll 后组件冻死（视频实证 7.2s 仅 1 翻）。
            // 两个等价布局交替 → launcher 判定布局变化 → 全新 inflate+attach → 必然重新起播。
            val prefs = context.getSharedPreferences("aiboo_widget", Context.MODE_PRIVATE)
            val flip = !prefs.getBoolean("layout_flip", false)
            prefs.edit().putBoolean("layout_flip", flip).apply()
            val layoutId = if (flip) R.layout.widget_live2d else R.layout.widget_live2d_b
            val root = RemoteViews(context.packageName, layoutId)
            root.removeAllViews(R.id.widget_flipper)
            for (bmp in frames) {
                val item = RemoteViews(context.packageName, R.layout.widget_frame_item)
                item.setImageViewBitmap(R.id.widget_frame_image, bmp)
                root.addView(R.id.widget_flipper, item)
            }
            root.setInt(R.id.widget_flipper, "setFlipInterval", intervalMs)
            root.setOnClickPendingIntent(
                R.id.widget_flipper,
                PendingIntent.getActivity(
                    context,
                    0,
                    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            return root
        }

        fun placeholderViews(context: Context): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_placeholder)
            v.setOnClickPendingIntent(
                R.id.widget_placeholder_root,
                PendingIntent.getActivity(
                    context,
                    0,
                    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            return v
        }

        /** 插件/换角后主动刷桌面：对所有实例重建视图。 */
        fun refreshAll(context: Context) {
            try {
                val mgr = AppWidgetManager.getInstance(context)
                val ids = mgr.getAppWidgetIds(
                    android.content.ComponentName(context, AibooWidgetProvider::class.java),
                )
                for (id in ids) {
                    try {
                        mgr.updateAppWidget(id, buildViews(context))
                    } catch (_: Throwable) {
                        try { mgr.updateAppWidget(id, placeholderViews(context)) } catch (_: Throwable) { /* 不崩 */ }
                    }
                }
            } catch (_: Throwable) {
                // 不崩
            }
        }
    }
}
