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
            /**
             * DJ 音乐模式的口播：★用 bedPlayer 播，不要用 WebView 的 <audio>。
             *
             * 原来口播走 WebView `<audio>`，这台 ROM 上那条路根本走不动
             *（play() 成功、readyState=4、无报错，而 currentTime 卡在 0 不走——
             * 当初把音乐搬到原生就是因为它）。音乐搬走了，口播还留在死路上，
             * 于是：听不到口播，而且 WebView 一为它抢音频焦点，
             * voicePlayer(handleAudioFocus=true) 就自己暂停——表现成"音乐被暂停而不是压低"。
             *
             * bedPlayer 正合适：DJ 音乐模式下它本来空着（EXTRA_BED_URL 传的是 ""），
             * 而且它建的时候就是 handleAudioFocus=false，不会跟任何人抢焦点。
             * 音量与循环要现设——它默认是 BED_VOLUME + REPEAT_MODE_ONE，那是音乐床的设定。
             */
            ACTION_SPEAK -> {
                val url = intent.getStringExtra(EXTRA_SPEAK_URL).orEmpty()
                if (url.isNotEmpty()) bedPlayer?.let { bp ->
                    bp.repeatMode = Player.REPEAT_MODE_OFF
                    bp.volume = 1f
                    bp.setMediaItem(MediaItem.fromUri(url))
                    bp.prepare()
                    bp.play()
                }
            }
            ACTION_SPEAK_STOP -> bedPlayer?.let { bp ->
                bp.stop()
                bp.clearMediaItems()
                // 还原成音乐床的设定，免得下次通勤模式拿到一个被口播改过的播放器。
                bp.repeatMode = Player.REPEAT_MODE_ONE
                bp.volume = BED_VOLUME
            }
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
        // 凡经 startForegroundService() 拉起（ACTION_START 是唯一前台启动入口），系统要求 5s 内必须
        // 调用 startForeground()，否则抛 RemoteServiceException 杀掉整个 App（一加等国产 ROM 尤其严格）。
        // 原逻辑只在末尾 startForeground，而「整点无口播→urls 为空走 stopEverything」「同期幂等 early-return」
        // 两条路径都会漏调 → 进 DJ 必闪退。故第一件事就无条件进前台，之后再按业务决定继续/停止。
        startForegroundNow()

        val episodeId = intent.getStringExtra(EXTRA_EPISODE_ID).orEmpty()
        // 幂等：同一期已在播/已播完 → 屏保重启重新进来时不从头重播，前台已在上面建立。
        if (sEpisodeId == episodeId && (sActive || sEnded)) {
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
        // 前台已在 handleStart 开头建立，这里不再重复调用。
    }

    private fun startForegroundNow() {
        try {
            val notif = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (t: Throwable) {
            // 正常路径不会进来；保留以防个别 ROM 的 startForeground 抛异常时留痕、不裸崩。
            android.util.Log.e("CommuteAudioService", "startForeground failed: $t", t)
        }
    }

    // 用户从「最近任务」划掉主 App → 停止播放（锁屏/切后台不会触发本回调，故灭屏仍续播；
    // 只有主动划掉 App 才停）。修复"杀了 App 播客还在响、却关不掉"。
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopEverything()
        super.onTaskRemoved(rootIntent)
    }

    private fun stopEverything() {
        // 关键：本次服务可能是被 startForegroundService 拉起、却还没 startForeground 就要停的——
        // DJ 进入时 JS「先停后启」，STOP intent 抢在 START 前到达就落到这里。Android 铁律：凡经
        // startForegroundService 启动，就必须有过一次 startForeground()，否则抛 RemoteServiceException
        // 杀掉整个 App（一加等国产 ROM 尤其严格）。故停止前先无条件补一次（已在前台时是幂等的，
        // 紧接着的 stopForeground 会撤掉），再正常收尾。
        startForegroundNow()
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
        const val ACTION_SPEAK = "com.llm.live2d.commute.SPEAK"
        const val ACTION_SPEAK_STOP = "com.llm.live2d.commute.SPEAK_STOP"

        const val EXTRA_SPEAK_URL = "speakUrl"
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
