package com.llm.live2d

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager

/**
 * 底条角色的「触摸洞」：一个只盖住角色那个正方形的透明可触浮窗。
 *
 * ★为什么另起一个窗而不是把底条主窗改成可触：底条 720×240 一旦可触，就会吃掉
 * 模拟器画面底部整条快捷按钮（Ben 实报点不到），且点到角色会误触发旧桌宠的
 * 打电话流程。主窗必须保持 FLAG_NOT_TOUCHABLE。
 * ★为什么不用 ViewTreeObserver.OnComputeInternalInsetsListener 的 touchableRegion：
 * 那套 API 是 @hide 的，只能反射调，随版本会碎。两个窗口全是公共 API。
 *
 * 手势语义（军师）：
 *   点一下      → 一键卡关（截屏 + 零输入提问）
 *   按住/松开   → 语音提问的录音起止（push-to-talk）
 * 不做拖动、不做长按开 App —— 那些是桌宠浮窗的语义，底条是钉死的。
 */
class StrategistTapWindow(
    private val context: Context,
    xPx: Int,
    yPx: Int,
    sizePx: Int,
) {
    private val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val view = View(context)

    var onTap: (() -> Unit)? = null
    var onHoldStart: (() -> Unit)? = null
    var onHoldEnd: (() -> Unit)? = null

    private val lp = WindowManager.LayoutParams(
        sizePx, sizePx,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = xPx
        y = yPx
    }

    /** push-to-talk 的按住判定门槛。比系统长按（500ms）短一点，说话前的等待更跟手。 */
    private val holdMs = 300L

    @SuppressLint("ClickableViewAccessibility")
    fun addToWindow() {
        val slop = ViewConfiguration.get(context).scaledTouchSlop
        val h = Handler(context.mainLooper)
        var downX = 0f
        var downY = 0f
        var holding = false
        var moved = false
        val holdR = Runnable {
            if (!moved) {
                holding = true
                onHoldStart?.invoke()
            }
        }
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; holding = false; moved = false
                    h.postDelayed(holdR, holdMs)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    // ★位移判定**只在还没进入录音时**有意义：它是用来把「划一下」跟
                    //   「按住」分开的。一旦按住已经开始说话，手指按着说几秒必然会漂移
                    //   几毫米，再用 slop 去收尾就是说到一半被掐断（Ben 实测：「按住还
                    //   没说完，它自己就收回去了」）。录音中只认 UP/CANCEL。
                    if (!holding && !moved &&
                        kotlin.math.hypot(e.rawX - downX, e.rawY - downY) > slop
                    ) {
                        moved = true
                        h.removeCallbacks(holdR) // 还没到门槛就当误触作废，不起录音
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    h.removeCallbacks(holdR)
                    if (holding) { holding = false; onHoldEnd?.invoke() }
                    else if (!moved) onTap?.invoke()
                    true
                }
                else -> false
            }
        }
        if (!view.isAttachedToWindow) {
            wm.addView(view, lp)
            Log.i(TAG, "added at ${lp.x},${lp.y} ${lp.width}x${lp.height}")
        }
    }

    fun removeFromWindow() {
        if (view.isAttachedToWindow) wm.removeView(view)
    }

    private companion object {
        const val TAG = "StrategistTap"
    }
}
