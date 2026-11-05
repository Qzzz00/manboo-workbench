package com.llm.live2d

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaStyleNotificationHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通勤播客「锁屏后台连续播放」核心。
 *
 * 为什么需要它：通勤 DJ 原先跑在屏保 [Live2DDreamService] 的 WebView 里，靠 JS 串行驱动
 * 一段段口播。但 Android 锁屏/灭屏会终止 dream（onDreamingStopped→pauseTimers()→冻结全部
 * JS；onDetachedFromWindow→WebView.destroy()），任何 JS 兜底都救不了。
 *
 * 这里把口播播放搬到一个**独立前台 Service**：用两个 ExoPlayer——voicePlayer 无缝顺播口播
 * 列表（gapless），bedPlayer 低音量循环音乐床。Service 生命周期不依赖 dream，灭屏照播，并
 * 通过 MediaSession + MediaStyle 通知提供锁屏媒体控制。
 *
 * 控制入口全部走 onStartCommand（主线程，可安全操作 ExoPlayer）：屏保 WebView 经
 * [ScreensaverBridge] 发 Intent 进来。播放状态以 companion 的 @Volatile 快照对外，供 bridge
 * 同步读（不跨线程碰 player）。
 */
@OptIn(UnstableApi::class)
class CommuteAudioService : Service() {

    private var voicePlayer: ExoPlayer? = null
    private var bedPlayer: ExoPlayer? = null
    private var session: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())

    private val ticker = object : Runnable {
        override fun run() {
            voicePlayer?.let {
                sIndex = it.currentMediaItemIndex
                sPositionMs = it.currentPosition
            }
            handler.postDelayed(this, 1000)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            sIndex = voicePlayer?.currentMediaItemIndex ?: sIndex
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            sPlaying = isPlaying
            // 音乐床跟随口播 play/pause（无床则 player 空闲，调用无副作用）。
            if (isPlaying) bedPlayer?.play() else bedPlayer?.pause()
            if (isPlaying) startTicker() else stopTicker()
        }

        override fun onPlaybackStateChanged(state: Int) {
            // 循环模式（DJ 音乐）下不会真正 ENDED；仅顺播一次（通勤口播）播完才收。
            if (state == Player.STATE_ENDED && !sLoop) {
                sEnded = true
                stopEverything()
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            // 单段取流失败默认会停掉整列表。尝试跳到下一段续播，避免整集中断。
            val vp = voicePlayer ?: return
            if (vp.hasNextMediaItem()) {
                vp.seekToNextMediaItem()
                vp.prepare()
                vp.play()
            } else {
                sEnded = true
                stopEverything()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        val attrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build()
        val vp = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(attrs, /* handleAudioFocus = */ true)
            addListener(playerListener)
        }
        val bp = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(attrs, /* handleAudioFocus = */ false) // 床不独立抢焦点，避免与口播冲突
            repeatMode = Player.REPEAT_MODE_ONE
            volume = BED_VOLUME
        }
        voicePlayer = vp
        bedPlayer = bp
        session = MediaSession.Builder(this, vp).build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart(intent)
            ACTION_PAUSE -> { voicePlayer?.pause(); bedPlayer?.pause() }
            ACTION_RESUME -> { voicePlayer?.play(); bedPlayer?.play() }
            ACTION_SEEK -> {
                val i = intent.getIntExtra(EXTRA_START_INDEX, 0)
                voicePlayer?.let { it.seekTo(i.coerceIn(0, (it.mediaItemCount - 1).coerceAtLeast(0)), 0L); it.play() }
            }
            // 口播插播时压低音乐 / 插播结束后恢复（DJ 音乐模式：口播由 WebView 亮屏时叠在原生音乐上）。
            ACTION_DUCK -> voicePlayer?.volume = DUCK_VOLUME
            ACTION_UNDUCK -> voicePlayer?.volume = 1f
            // 封面懒取回填：只换该曲元数据的 artworkUri（同 URI，media3 无缝不打断播放）。
            ACTION_SET_ARTWORK -> {
                val idx = intent.getIntExtra(EXTRA_START_INDEX, -1)
                val art = intent.getStringExtra(EXTRA_ARTWORK).orEmpty()
                voicePlayer?.let { vp ->
                    if (idx in 0 until vp.mediaItemCount && art.isNotEmpty()) {
                        val old = vp.getMediaItemAt(idx)
                        val newMd = old.mediaMetadata.buildUpon().setArtworkUri(Uri.parse(art)).build()
                        vp.replaceMediaItem(idx, old.buildUpon().setMediaMetadata(newMd).build())
                    }
                }
            }
            ACTION_STOP -> stopEverything()
        }
        return START_NOT_STICKY
    }

    private fun handleStart(intent: Intent) {
        val episodeId = intent.getStringExtra(EXTRA_EPISODE_ID).orEmpty()
        // 幂等：同一期已在播/已播完 → 屏保重启重新进来时不从头重播，只确保前台已建立。
        if (sEpisodeId == episodeId && (sActive || sEnded)) {
            if (sActive) startForegroundNow()
            return
        }
        val urls = parseUrls(intent.getStringExtra(EXTRA_VOICE_URLS).orEmpty())
        if (urls.isEmpty()) { stopEverything(); return }
        val startIndex = intent.getIntExtra(EXTRA_START_INDEX, 0).coerceIn(0, urls.size - 1)
        val bedUrl = intent.getStringExtra(EXTRA_BED_URL).orEmpty()
        // DJ 音乐模式：loop=true（整段歌单循环）、自带标题、可带续播位置；通勤口播则 loop=false。
        val loop = intent.getBooleanExtra(EXTRA_LOOP, false)
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val startPositionMs = intent.getLongExtra(EXTRA_START_POSITION, 0L)
        // 逐曲元数据（与 urls 等长；位置对齐，保留空串）。无则锁屏回落到通知标题。
        val titles = parseList(intent.getStringExtra(EXTRA_TITLES).orEmpty())
        val artists = parseList(intent.getStringExtra(EXTRA_ARTISTS).orEmpty())
        val artworks = parseList(intent.getStringExtra(EXTRA_ARTWORKS).orEmpty())

        sEpisodeId = episodeId
        sTotal = urls.size
        sIndex = startIndex
        sEnded = false
        sActive = true
        sLoop = loop
        sTitle = if (title.isNotEmpty()) title else "通勤播客"

        voicePlayer?.apply {
            repeatMode = if (loop) Player.REPEAT_MODE_ALL else Player.REPEAT_MODE_OFF
            volume = 1f // 重置可能残留的 duck 音量
            setMediaItems(
                urls.mapIndexed { i, u -> buildMediaItem(u, titles.getOrNull(i), artists.getOrNull(i), artworks.getOrNull(i)) },
                startIndex,
                startPositionMs.coerceAtLeast(0L),
            )
            prepare()
            playWhenReady = true
        }
        bedPlayer?.apply {
            if (bedUrl.isNotEmpty()) {
                setMediaItem(MediaItem.fromUri(bedUrl))
                prepare()
                playWhenReady = true
            } else {
                stop()
                clearMediaItems()
            }
        }
        startForegroundNow()
    }

    private fun startForegroundNow() {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun stopEverything() {
        sActive = false
        sPlaying = false
        stopTicker()
        voicePlayer?.pause()
        bedPlayer?.pause()
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
        stopSelf()
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(if (sTitle.isNotEmpty()) sTitle else "通勤播客")
            .setContentText("正在播放")
            .setOngoing(true)
        session?.let { builder.setStyle(MediaStyleNotificationHelper.MediaStyle(it)) }
        return builder.build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(CHANNEL_ID, "通勤播客", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            mgr.createNotificationChannel(ch)
        }
    }

    private fun startTicker() { handler.removeCallbacks(ticker); handler.post(ticker) }
    private fun stopTicker() { handler.removeCallbacks(ticker) }

    override fun onDestroy() {
        stopTicker()
        sActive = false
        session?.release(); session = null
        voicePlayer?.release(); voicePlayer = null
        bedPlayer?.release(); bedPlayer = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "commute_audio"
        private const val NOTIF_ID = 0xC0
        private const val BED_VOLUME = 0.22f
        private const val DUCK_VOLUME = 0.28f // 口播插播时音乐压低到的音量

        const val ACTION_START = "com.llm.live2d.commute.START"
        const val ACTION_PAUSE = "com.llm.live2d.commute.PAUSE"
        const val ACTION_RESUME = "com.llm.live2d.commute.RESUME"
        const val ACTION_SEEK = "com.llm.live2d.commute.SEEK"
        const val ACTION_DUCK = "com.llm.live2d.commute.DUCK"
        const val ACTION_UNDUCK = "com.llm.live2d.commute.UNDUCK"
        const val ACTION_SET_ARTWORK = "com.llm.live2d.commute.SET_ARTWORK"
        const val ACTION_STOP = "com.llm.live2d.commute.STOP"

        const val EXTRA_EPISODE_ID = "episodeId"
        const val EXTRA_VOICE_URLS = "voiceUrls"
        const val EXTRA_START_INDEX = "startIndex"
        const val EXTRA_BED_URL = "bedUrl"
        const val EXTRA_LOOP = "loop"
        const val EXTRA_TITLE = "title"
        const val EXTRA_START_POSITION = "startPositionMs"
        // DJ 音乐：与 urls 等长的逐曲元数据（锁屏/系统媒体控件显示歌名/歌手/封面）。
        const val EXTRA_TITLES = "titles"
        const val EXTRA_ARTISTS = "artists"
        const val EXTRA_ARTWORKS = "artworks"
        const val EXTRA_ARTWORK = "artwork" // 单曲封面回填（配合 EXTRA_START_INDEX）

        // 播放状态快照（@Volatile，bridge 同步读，不跨线程访问 player）。
        @Volatile private var sEpisodeId: String = ""
        @Volatile private var sIndex: Int = 0
        @Volatile private var sTotal: Int = 0
        @Volatile private var sPositionMs: Long = 0
        @Volatile private var sPlaying: Boolean = false
        @Volatile private var sEnded: Boolean = false
        @Volatile private var sActive: Boolean = false
        @Volatile private var sLoop: Boolean = false // 循环歌单（DJ 音乐）vs 顺播一次（通勤口播）
        @Volatile private var sTitle: String = "" // 前台通知标题

        @JvmStatic
        fun stateJson(): String {
            return JSONObject().apply {
                put("episodeId", sEpisodeId)
                put("index", sIndex)
                put("total", sTotal)
                put("positionMs", sPositionMs)
                put("playing", sPlaying)
                put("ended", sEnded)
                put("active", sActive)
            }.toString()
        }

        private fun parseUrls(json: String): List<String> {
            return try {
                val arr = JSONArray(json)
                (0 until arr.length()).mapNotNull { arr.optString(it, null) }.filter { it.isNotEmpty() }
            } catch (_: Throwable) {
                emptyList()
            }
        }

        // 与 urls 位置对齐的字符串数组（保留空串，不过滤），供逐曲元数据用。
        private fun parseList(json: String): List<String> {
            return try {
                val arr = JSONArray(json)
                (0 until arr.length()).map { arr.optString(it, "") }
            } catch (_: Throwable) {
                emptyList()
            }
        }

        // 带元数据的 MediaItem（歌名/歌手/封面）；三者皆空则退化为纯 URL（通勤口播即如此）。
        private fun buildMediaItem(url: String, title: String?, artist: String?, artwork: String?): MediaItem {
            val t = title.orEmpty()
            val a = artist.orEmpty()
            val art = artwork.orEmpty()
            if (t.isEmpty() && a.isEmpty() && art.isEmpty()) return MediaItem.fromUri(url)
            val md = MediaMetadata.Builder()
            if (t.isNotEmpty()) md.setTitle(t)
            if (a.isNotEmpty()) md.setArtist(a)
            if (art.isNotEmpty()) md.setArtworkUri(Uri.parse(art))
            return MediaItem.Builder().setUri(url).setMediaMetadata(md.build()).build()
        }
    }
}
