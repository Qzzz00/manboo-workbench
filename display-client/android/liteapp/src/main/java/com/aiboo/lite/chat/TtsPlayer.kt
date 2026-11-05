package com.aiboo.lite.chat

import android.content.Context
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.aiboo.lite.net.ApiClient
import com.llm.live2d.nativelive2d.NativeLive2DController
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

/**
 * TTS 播放 + 合成口型：POST /ai/tts 拿音频字节 → MediaPlayer 播放，播放期以
 * 双正弦拍频驱动 ParamMouthOpenY（公式照抄 tts.ts startSyntheticMouthLoop——
 * 真实频谱路需 MediaCodec 解码，lite 先用合成路，效果同主 App 的降级口型）。
 */
class TtsPlayer(
    context: Context,
    private val controller: NativeLive2DController,
) {

    private companion object {
        const val TAG = "AibooLite"
        const val MOUTH_FRAME_MS = 33L
    }

    private val cacheDir = File(context.cacheDir, "tts").apply { mkdirs() }
    private val mainHandler = Handler(Looper.getMainLooper())

    private var player: MediaPlayer? = null
    private var mouthRunning = false
    private var generation = 0

    /** 异步：合成并播放。已在播的先停。TTS 失败静默（只出文字不出声）。 */
    fun speak(text: String, emotion: String, avatarId: String) {
        val gen = ++generation
        stopInternal()
        ApiClient.io.execute {
            val audioFile: File = try {
                val body = JSONObject()
                    .put("text", text)
                    .put("avatarId", avatarId)
                    .put("emotion", emotion)
                val bytes = ApiClient.postBytes("/ai/tts", body)
                File(cacheDir, "tts_$gen.bin").apply { writeBytes(bytes) }
            } catch (t: Throwable) {
                Log.w(TAG, "tts failed: ${t.message}")
                return@execute
            }
            mainHandler.post {
                if (gen != generation) {
                    audioFile.delete()
                    return@post
                }
                playFile(audioFile, gen)
            }
        }
    }

    private fun playFile(file: File, gen: Int) {
        try {
            val mp = MediaPlayer()
            player = mp
            mp.setDataSource(file.absolutePath)
            mp.setOnCompletionListener {
                if (gen == generation) stopInternal()
                file.delete()
            }
            mp.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "tts play error what=$what extra=$extra")
                if (gen == generation) stopInternal()
                file.delete()
                true
            }
            mp.prepare()
            mp.start()
            startMouthLoop(gen)
        } catch (t: Throwable) {
            Log.w(TAG, "tts play failed: ${t.message}")
            stopInternal()
        }
    }

    /** 双正弦拍频合成口型（tts.ts 同款系数），MediaPlayer 播放期间 33ms 一帧。 */
    private fun startMouthLoop(gen: Int) {
        mouthRunning = true
        val start = SystemClock.uptimeMillis()
        val tick = object : Runnable {
            override fun run() {
                if (!mouthRunning || gen != generation) return
                val elapsed = (SystemClock.uptimeMillis() - start).toDouble()
                val syllable = abs(sin(elapsed / 82.0))
                val secondary = abs(sin(elapsed / 137.0 + 0.8))
                val value = min(0.85, 0.08 + syllable * 0.45 + secondary * 0.18)
                controller.setMouthParams(JSONObject().put("ParamMouthOpenY", value))
                mainHandler.postDelayed(this, MOUTH_FRAME_MS)
            }
        }
        mainHandler.post(tick)
    }

    fun stop() {
        generation++
        stopInternal()
    }

    private fun stopInternal() {
        mouthRunning = false
        player?.let { mp ->
            runCatching { mp.stop() }
            runCatching { mp.release() }
        }
        player = null
        // 先写一帧闭嘴再清通道，避免嘴停在半开（空 map=硬写通道失效，交还动作/呼吸）
        controller.setMouthParams(JSONObject().put("ParamMouthOpenY", 0.0))
        mainHandler.postDelayed({ controller.setMouthParams(JSONObject()) }, 80L)
    }
}
