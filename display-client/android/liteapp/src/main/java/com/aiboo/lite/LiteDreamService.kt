package com.aiboo.lite

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.service.dreams.DreamService
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import com.aiboo.lite.avatar.AvatarRepo
import com.aiboo.lite.avatar.readModelJson
import com.llm.live2d.nativelive2d.NativeLive2DController
import org.json.JSONArray
import org.json.JSONObject

/**
 * 零 WebView 系统屏保：充电+闲置时由系统拉起，同一套原生渲染栈 + 摆件时钟。
 * 与主 App 的 Live2DDreamService(WebView 宿主)互不相干——这是 liteapp 自己的屏保。
 * 只展示不聊天（Dream 无输入场景）。
 */
class LiteDreamService : DreamService() {

    private companion object {
        const val TAG = "AibooLite"
    }

    private var controller: NativeLive2DController? = null

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        AvatarRepo.init(this)

        isFullscreen = true
        isInteractive = false
        isScreenBright = true

        val root = FrameLayout(this)
        setContentView(root)
        window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))

        val c = NativeLive2DController(this)
        controller = c
        if (!c.isCoreAvailable()) {
            Log.e(TAG, "dream: cubism core unavailable")
            return
        }
        c.attachUnderOnUiThread(
            root, 0,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val avatar = AvatarRepo.resolve(AvatarRepo.currentAvatarId) ?: AvatarRepo.BUILTIN
        val settingsJson = try {
            readModelJson(this, avatar.modelJson)
        } catch (t: Throwable) {
            Log.e(TAG, "dream model json read failed", t)
            return
        }
        val plan = AvatarRepo.motionPlan(avatar, settingsJson)
        val dm = resources.displayMetrics
        val opts = JSONObject().apply {
            put("settingsJson", settingsJson)
            put("modelDir", avatar.modelDir)
            plan.idleGroup?.let { put("idleMotionGroup", it) }
            if (plan.beatGroups.isNotEmpty()) put("idleBeatGroups", JSONArray(plan.beatGroups))
            put("targetFps", AvatarRepo.targetFps)
            put("backgroundColor", "#10101A")
            // 全身站桩（摆件语义），估值 aspect 起步、回调用真实画布比例修正
            put("layout", com.aiboo.lite.avatar.aspectFitLayout(0.92, 0.97, 0.5, dm.widthPixels, dm.heightPixels))
        }
        c.showModel(opts) { result, error ->
            if (result == null) {
                Log.e(TAG, "dream showModel failed: $error")
            } else {
                val cw = result.optDouble("canvasWidthPx", 0.0)
                val ch = result.optDouble("canvasHeightPx", 0.0)
                if (cw > 0 && ch > 0) {
                    c.setLayout(
                        com.aiboo.lite.avatar.aspectFitLayout(0.92, 0.97, cw / ch, dm.widthPixels, dm.heightPixels),
                    )
                }
            }
        }

        root.addView(
            PendantView(this),
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                leftMargin = dp(28)
                topMargin = dp(64)
            },
        )
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        controller?.resumeIfVisible()
    }

    override fun onDreamingStopped() {
        super.onDreamingStopped()
        controller?.pauseIfVisible()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        controller?.destroy()
        controller = null
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
