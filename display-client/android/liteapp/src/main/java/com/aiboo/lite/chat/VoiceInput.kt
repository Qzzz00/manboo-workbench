package com.aiboo.lite.chat

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 按住说话录音器：AudioRecord 16k/16bit/mono → WAV 字节（服务端 /ai/asr 契约格式）。
 * 上限 60s（holoInput 同款 ≤4MB 约束的富余），过短(<400ms)视为误触返回 null。
 * 调用方须已持有 RECORD_AUDIO 权限。
 */
class VoiceInput {

    private companion object {
        const val TAG = "AibooLite"
        const val SAMPLE_RATE = 16_000
        const val MAX_MS = 60_000L
        const val MIN_MS = 400L
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var running = false
    private var startedAt = 0L

    val isRecording: Boolean get() = running

    /** 开始录音（已在录则忽略）。返回 false = AudioRecord 初始化失败（设备占用等）。 */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                (minBuf * 2).coerceAtLeast(8192),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "AudioRecord create failed: ${t.message}")
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        pcm.reset()
        record = rec
        running = true
        startedAt = System.currentTimeMillis()
        rec.startRecording()
        thread = Thread {
            val buf = ByteArray(4096)
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) pcm.write(buf, 0, n)
                if (System.currentTimeMillis() - startedAt > MAX_MS) break
            }
        }.apply { start() }
        return true
    }

    /** 停止并打包 WAV；时长过短返回 null（误触）。 */
    fun stop(): ByteArray? {
        if (!running) return null
        running = false
        val durationMs = System.currentTimeMillis() - startedAt
        thread?.join(600)
        thread = null
        record?.let { rec ->
            runCatching { rec.stop() }
            rec.release()
        }
        record = null
        val data = pcm.toByteArray()
        pcm.reset()
        if (durationMs < MIN_MS || data.isEmpty()) return null
        return wrapWav(data)
    }

    fun cancel() {
        running = false
        thread?.join(300)
        thread = null
        record?.let { rec ->
            runCatching { rec.stop() }
            rec.release()
        }
        record = null
        pcm.reset()
    }

    /** 44 字节标准 WAV 头 + PCM（16k/16bit/mono）。 */
    private fun wrapWav(pcmData: ByteArray): ByteArray {
        val byteRate = SAMPLE_RATE * 2
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray())
        header.putInt(36 + pcmData.size)
        header.put("WAVE".toByteArray())
        header.put("fmt ".toByteArray())
        header.putInt(16)                 // PCM chunk size
        header.putShort(1)                // PCM format
        header.putShort(1)                // mono
        header.putInt(SAMPLE_RATE)
        header.putInt(byteRate)
        header.putShort(2)                // block align
        header.putShort(16)               // bits per sample
        header.put("data".toByteArray())
        header.putInt(pcmData.size)
        return header.array() + pcmData
    }
}
