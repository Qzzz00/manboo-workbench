package com.llm.live2d

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.Display
import java.io.ByteArrayOutputStream

/**
 * 军师截屏：无障碍 takeScreenshot → 裁掉底条 → JPEG 压到限额内 → base64。
 *
 * ★为什么是无障碍而不是文档 §10 写的 MediaProjection：掌机已经为 F10 侧键装了
 * [AibooKeyService]，无障碍截屏无授权弹窗、无「投屏中」常驻通知、**开机后不用重新
 * 授权**；MediaProjection 在 targetSdk 36 下每次开机都要弹一次系统确认框。
 *
 * ★★为什么裁剪而不是「先隐藏底条再截」：takeScreenshot 截的是 display 合成结果，
 * 底条上的 Live2D 角色会糊在游戏画面上干扰 VLM 识别。但底条几何是**已知固定值**
 * （满宽、钉死屏幕底部、高 STRIP_HEIGHT_PX），直接裁掉那一条即可 —— 确定性、
 * 零时序竞态、零闪烁、不用等一帧。cropBottomPx 由 JS 侧下发（底条几何的唯一真相源
 * 在 handheldStrip.ts），原生不自己猜，免得两边各持一份常数迟早漂。
 */
object ScreenCapture {
    private const val TAG = "ScreenCapture"

    /** 质量阶梯：先按质量降，降到底还超限就整体缩到 0.75× 再走一轮。 */
    private val QUALITY_LADDER = intArrayOf(85, 70, 55, 40)
    private const val MAX_SCALE_ROUNDS = 3
    private const val SCALE_STEP = 0.75f

    sealed class Result {
        data class Ok(val jpegBase64: String, val widthPx: Int, val heightPx: Int, val bytes: Int) : Result()
        data class Err(val code: String) : Result()
    }

    /**
     * 截一张。cb 在主线程回调。
     * service=null（无障碍没启用/重装被撤销）→ 立刻 Err("SERVICE_DISABLED")。
     */
    fun capture(
        service: AccessibilityService?,
        cropBottomPx: Int,
        maxBytes: Int,
        cb: (Result) -> Unit,
    ) {
        if (service == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            cb(Result.Err("SERVICE_DISABLED"))
            return
        }
        try {
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                service.mainExecutor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        val buffer = result.hardwareBuffer
                        try {
                            val hw = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                            if (hw == null) {
                                cb(Result.Err("CAPTURE_FAILED"))
                                return
                            }
                            cb(encode(hw, cropBottomPx, maxBytes))
                        } catch (e: Throwable) {
                            Log.e(TAG, "encode failed", e)
                            cb(Result.Err("CAPTURE_FAILED"))
                        } finally {
                            buffer.close()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "takeScreenshot failed code=$errorCode")
                        cb(Result.Err(errName(errorCode)))
                    }
                },
            )
        } catch (e: Throwable) {
            Log.e(TAG, "takeScreenshot threw", e)
            cb(Result.Err("CAPTURE_FAILED"))
        }
    }

    private fun errName(code: Int): String = when (code) {
        // 系统限流：默认 1 次/秒。连点两下第二下必中，UI 要给专属文案而不是让人重试到死。
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "INTERVAL_TOO_SHORT"
        AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "SERVICE_DISABLED"
        else -> "CAPTURE_FAILED"
    }

    /**
     * 硬件位图 → 软件位图 → 裁掉底部 → JPEG 阶梯压缩。
     * ★必须先 copy 成 ARGB_8888：硬件位图不能当 Canvas 绘制源，也不能直接
     * createBitmap 裁剪（"Software rendering doesn't support hardware bitmaps"）。
     */
    private fun encode(hw: Bitmap, cropBottomPx: Int, maxBytes: Int): Result {
        val sw = hw.copy(Bitmap.Config.ARGB_8888, false)
            ?: return Result.Err("CAPTURE_FAILED")
        // 裁剪高度夹进合法区间：cropBottomPx 传大了也不能裁出 0 高的图。
        val keepH = (sw.height - cropBottomPx).coerceIn(1, sw.height)
        val cropped =
            if (keepH == sw.height) sw
            else Bitmap.createBitmap(sw, 0, 0, sw.width, keepH)
        val jpeg = compressUnderLimit(cropped, maxBytes)
        Log.i(TAG, "capture ok ${cropped.width}x${cropped.height} ${jpeg.size}B (crop=$cropBottomPx)")
        return Result.Ok(
            Base64.encodeToString(jpeg, Base64.NO_WRAP),
            cropped.width,
            cropped.height,
            jpeg.size,
        )
    }

    private fun compressUnderLimit(src: Bitmap, maxBytes: Int): ByteArray {
        var bmp = src
        var last: ByteArray = ByteArray(0)
        for (round in 0..MAX_SCALE_ROUNDS) {
            for (q in QUALITY_LADDER) {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, q, out)
                last = out.toByteArray()
                if (last.size <= maxBytes) return last
            }
            if (round == MAX_SCALE_ROUNDS) break
            val w = (bmp.width * SCALE_STEP).toInt().coerceAtLeast(1)
            val h = (bmp.height * SCALE_STEP).toInt().coerceAtLeast(1)
            bmp = Bitmap.createScaledBitmap(bmp, w, h, true)
        }
        // 缩了三轮还超限：交出最后一版而不是失败——晚点的 VLM 请求慢一点，
        // 也好过一键卡关直接报错。
        Log.w(TAG, "compressUnderLimit: still ${last.size}B > $maxBytes")
        return last
    }
}
