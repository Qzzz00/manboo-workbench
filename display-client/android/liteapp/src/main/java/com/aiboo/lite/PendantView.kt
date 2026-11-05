package com.aiboo.lite

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.BatteryManager
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 摆件信息块：时钟 / 日期 / 电量，透明背景直接叠在角色 GL 层之上。
 *
 * 两种形态（治「又像屏保又像主页」的身份混乱）：
 * - PENDANT 摆件态：64sp 大钟+日期+电量——屏保与充电闲置态专用
 * - COMPACT 聊天态：一行小字「HH:mm · ⚡xx%」——聊天主页角落里不抢戏
 */
class PendantView(context: Context, private val compact: Boolean = false) : LinearLayout(context) {

    private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val dateFormat = SimpleDateFormat("M月d日 EEEE", Locale.CHINA)

    private var batteryText = ""

    private val timeView = TextView(context).apply {
        if (compact) {
            setTextColor(0x99FFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        } else {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            includeFontPadding = false
        }
    }
    private val dateView = TextView(context).apply {
        setTextColor(0xB3FFFFFF.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    }
    private val batteryView = TextView(context).apply {
        setTextColor(0x80FFFFFF.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    }

    private val timeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = refreshClock()
    }
    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = refreshBattery(intent)
    }

    init {
        orientation = VERTICAL
        refreshClock()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        context.registerReceiver(
            timeReceiver,
            IntentFilter().apply {
                addAction(Intent.ACTION_TIME_TICK)
                addAction(Intent.ACTION_TIME_CHANGED)
                addAction(Intent.ACTION_TIMEZONE_CHANGED)
            },
        )
        // sticky：注册即返回当前电量
        val sticky = context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        sticky?.let { refreshBattery(it) }
        refreshClock()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        runCatching { context.unregisterReceiver(timeReceiver) }
        runCatching { context.unregisterReceiver(batteryReceiver) }
    }

    private fun ensureChildren() {
        if (childCount > 0) return
        addView(timeView)
        if (!compact) {
            addView(dateView)
            addView(batteryView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        }
    }

    private fun refreshClock() {
        ensureChildren()
        val now = Date()
        if (compact) {
            timeView.text = listOf(timeFormat.format(now), batteryText)
                .filter { it.isNotEmpty() }
                .joinToString(" · ")
        } else {
            timeView.text = timeFormat.format(now)
            dateView.text = dateFormat.format(now)
        }
        // attach 窗口期 setText 的 requestLayout 可能被吞（实测被量成单字符宽），显式补一刀
        requestLayout()
    }

    private fun refreshBattery(intent: Intent) {
        ensureChildren()
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        if (level < 0) return
        val pct = level * 100 / scale.coerceAtLeast(1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        batteryText = if (charging) "⚡$pct%" else "$pct%"
        if (compact) {
            refreshClock()
        } else {
            batteryView.text = if (charging) "⚡ $pct%" else "$pct%"
            requestLayout()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
