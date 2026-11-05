package com.llm.live2d;

import android.media.MediaPlayer;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 展示台来电铃声（来电链 v0）：JS 收到工作台 ring 推送后经此起铃，offhook/missed 停铃。
 *
 * 为什么在原生层放而不是 WebView：这台 ROM 上 WebView `<audio>` 的 currentTime 卡死不走、
 * WebAudio 的 AudioContext 无手势时挂起（kiosk 没人碰屏），两条 JS 路都实锤走不通；
 * 原生播放链路（DJ 音乐的 ExoPlayer）被证明能出声。铃声比音乐轻得多——本地 res/raw 资源、
 * 无网络取流、无锁屏续播需求，所以不复用 CommuteAudioService（前台 Service + 抢 MediaSession，
 * 还会顶掉正在播的歌单），用 Activity 进程内一只 MediaPlayer 循环即可。
 * 音频属性走 MediaPlayer 默认的 STREAM_MUSIC——与音乐同一条被证明能出声的流。
 */
@CapacitorPlugin(name = "Ringtone")
public class RingtonePlugin extends Plugin {
    private MediaPlayer player;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (player != null) {
            call.resolve(); // 已在响，幂等
            return;
        }
        try {
            MediaPlayer p = MediaPlayer.create(getContext(), R.raw.phone_ring);
            if (p == null) {
                // create 失败返回 null 而不是抛异常；必须 reject 让 JS 侧能记进 DJTRACE，
                // 别重蹈 ringtone.ts 静默吞错的覆辙。
                call.reject("ringtone_create_failed");
                return;
            }
            p.setLooping(true);
            p.start();
            player = p;
            android.util.Log.i("Ringtone", "铃声起播 looping=true");
            call.resolve();
        } catch (Throwable t) {
            call.reject("ringtone_start_failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        MediaPlayer p = player;
        player = null;
        if (p != null) {
            try { p.stop(); } catch (Throwable ignored) { /* 已停也算停 */ }
            try { p.release(); } catch (Throwable ignored) { /* 重复释放无妨 */ }
            android.util.Log.i("Ringtone", "铃声已停");
        }
        call.resolve();
    }
}
