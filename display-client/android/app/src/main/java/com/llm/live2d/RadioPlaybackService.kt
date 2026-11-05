package com.llm.live2d

import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * U3 电台桌面本地播放前台服务：media3 ExoPlayer + MediaSession。
 * 锁屏/灭屏续播、音频焦点让位（其他 App 播放时自动暂停）、拔耳机暂停、系统媒体通知全由框架托管。
 * 与 CommuteAudioService（通勤播客）完全独立。插件同进程经 instance 直调。
 */
class RadioPlaybackService : MediaSessionService() {

    data class Snapshot(
        val playing: Boolean, val index: Int, val positionMs: Long, val durationMs: Long, val ended: Boolean,
    )

    companion object {
        @Volatile var instance: RadioPlaybackService? = null; private set
        /** 播放状态监听（RadioLauncherPlugin 注册转发 JS）。 */
        @Volatile var stateListener: ((Snapshot) -> Unit)? = null
    }

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val p = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
        p.addListener(object : Player.Listener {
            override fun onEvents(pl: Player, events: Player.Events) { stateListener?.invoke(snapshot()) }
        })
        player = p
        val s = MediaSession.Builder(this, p).build()
        session = s
        // 关键：addSession() 才会让 MediaNotificationManager 接管这个 session（建通知 + 播放时提前台）。
        // MediaSessionService 文档假设是"系统媒体控件/通知栏会自动 connect 一个 controller 从而
        // 触发框架内部自动 addSession"——但这台白牌 ROM 没有这类自动连接的系统媒体面板，
        // 实测 onGetSession 从未被外部触发过，导致通知/前台一直不生效（startForegroundCount 卡 0）。
        // addSession 对同一 session 实例幂等（第二次晚到的自动调用不会冲突），显式调用是安全的兜底。
        addSession(s)
        instance = this
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onDestroy() {
        instance = null
        session?.let { removeSession(it); it.release() }
        session = null
        player?.release(); player = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 桌面是常驻任务，正常不会走到；保险：停播放停服务
        player?.stop()
        stopSelf()
    }

    // —— 插件同进程直调 ——

    fun setQueue(items: List<MediaItem>, startIndex: Int, playWhenReady: Boolean = true) {
        val p = player ?: return
        p.setMediaItems(items, startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)), 0L)
        p.prepare()
        if (playWhenReady) p.play() else p.pause() // 冷启恢复上次曲目时用 false=就绪待播不炸音乐
    }

    fun control(op: String, index: Int, positionMs: Long) {
        val p = player ?: return
        when (op) {
            // 播完（STATE_ENDED）时单独 play() 对 ExoPlayer 无效，须先 seek 回 0 再 play；
            // 对齐系统媒体通知「播完点播放」的重播行为。
            "toggle" -> when {
                p.isPlaying -> p.pause()
                p.playbackState == Player.STATE_ENDED -> { p.seekTo(0, 0L); p.play() }
                else -> p.play()
            }
            "next" -> { p.seekToNextMediaItem(); p.play() }
            "prev" -> { p.seekToPreviousMediaItem(); p.play() }
            "playAt" -> if (index in 0 until p.mediaItemCount) { p.seekTo(index, 0L); p.play() }
            "seekTo" -> p.seekTo(positionMs.coerceAtLeast(0L))
        }
    }

    fun snapshot(): Snapshot {
        val p = player ?: return Snapshot(false, -1, 0, 0, false)
        return Snapshot(
            playing = p.isPlaying,
            index = if (p.mediaItemCount == 0) -1 else p.currentMediaItemIndex,
            positionMs = p.currentPosition.coerceAtLeast(0L),
            durationMs = if (p.duration == C.TIME_UNSET) 0L else p.duration,
            ended = p.playbackState == Player.STATE_ENDED,
        )
    }
}
