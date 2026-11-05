package com.llm.live2d

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.util.Base64
import android.util.Log
import java.io.File

/**
 * 军师语音播报的原生播放。
 *
 * ★为什么不用 WebView 里的 `<audio>`（原来的做法）：`<audio>` 永远走 **STREAM_MUSIC**，
 * 也就是和游戏同一条媒体音量——玩家没法把「角色说话」和「游戏音效」分开调
 * （Ben 实报）。JS 侧没有任何 API 能选音频流，必须挪到原生。
 *
 * ★流的选择走过一次弯路，结论以真机为准：
 *  · 先押 `USAGE_ASSISTANCE_ACCESSIBILITY`（→STREAM_ACCESSIBILITY），语义最贴。
 *    **但 Ben 真机一看，这台 Anbernic ROM 只暴露四条滑块：媒体 / 通话 / 通知 / 闹钟，
 *    没有「无障碍音量」** —— 那条流在这机器上等于音量锁死、用户调不了，正好废掉了
 *    「能分开调」这个全部目的。所以改掉。
 *  · `STREAM_MUSIC`：与游戏同一条，就是要解决的问题本身。
 *  · `STREAM_VOICE_CALL`：非通话时很多机器路由到听筒，且音量键调不动（只有真在通话中
 *    才可调）。掌机没听筒，风险更大。
 *  · `STREAM_NOTIFICATION`：有独立滑块，但会被勿扰静音、且不少机器与铃声联动。
 *  · **`USAGE_ALARM`（→STREAM_ALARM）**：四条里唯一「独立滑块 + 不被勿扰静音 +
 *    始终走扬声器」的。从此「闹钟」那个滑块就是角色说话的音量 —— 嫌吵直接拉低，
 *    这正是 Ben 要的「方便调节」。
 *
 * ★同时申请 AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK：说话时系统自动把游戏音量压低、
 * 说完恢复。这解决的是「听得清」，与「能分别调」是两件事，一起做。
 *
 * ★★焦点的作用域是**整篇播报**，不是每段（2026-08-01 Ben 真机「上一句和下一句的
 * 语气差很多」）：一条答案会被切成两三段分别合成播放，原来每段 request/abandon 一次，
 * 游戏音量就一段一抽（压低→恢复→压低），听感上比段间静音还刺耳。
 * 现在由 JS 侧在整篇开始/结束时调 beginUtterance/endUtterance，中间的 play() 不碰焦点。
 * 没调 begin 就直接 play 的老路径（开场白、垫词）保持原样：自己申请、自己释放。
 */
object StrategistAudio {
    private const val TAG = "StrategistAudio"
    private val sessions = StrategistAudioSessionGate()

    private class PlaybackResources {
        var player: MediaPlayer? = null
        var tempFile: File? = null
        var audioManager: AudioManager? = null
        var focusRequest: AudioFocusRequest? = null
    }

    /** 整篇播报进行中：此时焦点由 begin/endUtterance 这一对持有，play() 不再各管各的。 */
    private var utteranceOpen = false
    private val utteranceResources = PlaybackResources()

    private val attrs: AudioAttributes = AudioAttributes.Builder()
        // 见类注释：这台 ROM 没有「无障碍音量」滑块，改用闹钟流（四条可调里唯一
        // 独立且始终可闻的）。CONTENT_TYPE_SPEECH 保留——它影响的是音频处理不是音量流。
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** 整篇播报开始：申请一次焦点，整篇期间一直持有。幂等。 */
    @Synchronized
    fun beginUtterance(context: Context) {
        if (utteranceOpen) return
        utteranceOpen = true
        requestFocus(context.applicationContext, utteranceResources)
    }

    /** 整篇播报结束（念完 / 被打断）：把焦点还给游戏。幂等。 */
    @Synchronized
    fun endUtterance(context: Context) {
        if (!utteranceOpen) return
        utteranceOpen = false
        abandonFocus(utteranceResources)
    }

    /**
     * 播一段 base64 音频。onDone 在播完/失败时都会被调用**恰好一次**——
     * 上层靠它串行下一句，漏调会让整条播报队列卡死。
     */
    fun play(context: Context, base64: String, onDone: () -> Unit) {
        val managesOwnFocus = synchronized(this) { !utteranceOpen }
        val resources = PlaybackResources()
        lateinit var session: StrategistAudioSessionGate.Session
        session = sessions.begin(
            release = { release(resources) },
            abandonFocus = { if (managesOwnFocus) abandonFocus(resources) },
            onDone = onDone,
        )
        // An interrupted onDone may synchronously start another clip. Never resurrect this stale one.
        if (!sessions.isActive(session)) return
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            // MediaPlayer 要文件/URI，喂不了裸字节数组。放 cacheDir，播完即删。
            val f = File.createTempFile("strategist-tts", ".bin", context.cacheDir)
            f.writeBytes(bytes)
            resources.tempFile = f

            // 整篇模式下 beginUtterance 已经申请过，这里不再碰焦点。
            if (managesOwnFocus) requestFocus(context.applicationContext, resources)

            val mp = MediaPlayer()
            resources.player = mp
            mp.setAudioAttributes(attrs)
            mp.setDataSource(f.absolutePath)
            mp.setOnCompletionListener { sessions.finish(session) }
            mp.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "MediaPlayer error what=$what extra=$extra")
                sessions.finish(session)
                true
            }
            mp.prepare()
            mp.start()
        } catch (_: Throwable) {
            Log.e(TAG, "play failed")
            sessions.finish(session)
        }
    }

    /** 打断当前播报；与自然结束相同，立即释放焦点并结算等待中的 JS Promise。 */
    @Synchronized
    fun stop() {
        sessions.stop()
        if (utteranceOpen) {
            utteranceOpen = false
            abandonFocus(utteranceResources)
        }
    }

    private fun release(resources: PlaybackResources) {
        resources.player?.let { mp ->
            try {
                if (mp.isPlaying) mp.stop()
            } catch (_: Throwable) {
                // 已经播完/未 prepare：忽略
            }
            try {
                mp.release()
            } catch (_: Throwable) {
                // ignore
            }
        }
        resources.player = null
        resources.tempFile?.delete()
        resources.tempFile = null
    }

    private fun requestFocus(context: Context, resources: PlaybackResources) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        resources.audioManager = am
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .build()
            resources.focusRequest = req
            am.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        }
    }

    private fun abandonFocus(resources: PlaybackResources) {
        val am = resources.audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            resources.focusRequest?.let { am.abandonAudioFocusRequest(it) }
            resources.focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(null)
        }
        resources.audioManager = null
    }
}
