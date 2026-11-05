package com.llm.live2d;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 主 App WebView → 原生：把「是否正处于 DJ 模式 + 当前 DJ 角色」写入 ScreensaverPrefs
 * （独立于 Capacitor 的 localStorage），供充电屏保 DreamService 读取联动。
 *
 * 用 Capacitor 插件而非 addJavascriptInterface：插件在页面加载前就注册好，window 上立即可用，
 * 不需要 reload。JS 侧通过 registerPlugin('DjState') 调用。
 */
@CapacitorPlugin(name = "DjState")
public class DjStatePlugin extends Plugin {
    @PluginMethod
    public void setDjMode(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        String avatarId = call.getString("avatarId", "");
        ScreensaverPrefs.INSTANCE.setDjMode(getContext(), active, avatarId == null ? "" : avatarId);
        call.resolve();
    }

    /**
     * 设备最近一次已知位置（lat/lon），供 DJ 口播跟随本地天气（与充电屏保同一来源 LocationManager）。
     * 城市名交给 JS 侧反地理编码。未授权/取不到返回空对象，调用方自行回落。
     */
    @PluginMethod
    public void getDeviceLocation(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            boolean granted =
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
                Location best = null;
                String[] providers = {
                    LocationManager.NETWORK_PROVIDER,
                    LocationManager.GPS_PROVIDER,
                    LocationManager.PASSIVE_PROVIDER,
                };
                for (String p : providers) {
                    try {
                        Location l = lm.getLastKnownLocation(p);
                        if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
                    } catch (SecurityException ignored) {
                        /* 该 provider 无权限/不可用 */
                    }
                }
                if (best != null) {
                    ret.put("lat", best.getLatitude());
                    ret.put("lon", best.getLongitude());
                }
            }
        } catch (Throwable ignored) {
            /* 任何异常都回落空对象 */
        }
        call.resolve(ret);
    }

    // ---- 通勤播客：原生前台 Service 播放（锁屏后台续播）----
    // 主 App WebView 把口播列表 + 床直链交给 CommuteAudioService 原生播放；自身只在前台时
    // 轮询 commuteState 驱动话题卡片滚动。控制以 Intent 投递到 Service 主线程执行。

    @PluginMethod
    public void commuteStart(PluginCall call) {
        String episodeId = call.getString("episodeId", "");
        JSArray voiceUrls = call.getArray("voiceUrls");
        int startIndex = call.getInt("startIndex", 0);
        String bedUrl = call.getString("bedUrl", "");
        String urlsJson = voiceUrls != null ? voiceUrls.toString() : "[]";
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(CommuteAudioService.ACTION_START);
        i.putExtra(CommuteAudioService.EXTRA_EPISODE_ID, episodeId == null ? "" : episodeId);
        i.putExtra(CommuteAudioService.EXTRA_VOICE_URLS, urlsJson);
        i.putExtra(CommuteAudioService.EXTRA_START_INDEX, startIndex);
        i.putExtra(CommuteAudioService.EXTRA_BED_URL, bedUrl == null ? "" : bedUrl);
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("commute_start_failed: " + t.getMessage());
        }
    }

    // DJ 音乐模式（默认/工作/学习/休息）：把当前时段的整段歌单直链交给同一个前台 Service 循环播放
    // （loop=true、无音乐床、自带标题）。锁屏后台续播 + MediaSession 锁屏控制，与通勤共用一套 Service。
    @PluginMethod
    public void musicStart(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        JSArray urls = call.getArray("urls");
        JSArray titles = call.getArray("titles");
        JSArray artists = call.getArray("artists");
        JSArray artworks = call.getArray("artworks");
        int startIndex = call.getInt("startIndex", 0);
        int startPositionMs = call.getInt("startPositionMs", 0);
        String title = call.getString("title", "AI 电台");
        String urlsJson = urls != null ? urls.toString() : "[]";
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(CommuteAudioService.ACTION_START);
        i.putExtra(CommuteAudioService.EXTRA_EPISODE_ID, sessionId == null ? "" : sessionId);
        i.putExtra(CommuteAudioService.EXTRA_VOICE_URLS, urlsJson);
        i.putExtra(CommuteAudioService.EXTRA_TITLES, titles != null ? titles.toString() : "[]");
        i.putExtra(CommuteAudioService.EXTRA_ARTISTS, artists != null ? artists.toString() : "[]");
        i.putExtra(CommuteAudioService.EXTRA_ARTWORKS, artworks != null ? artworks.toString() : "[]");
        i.putExtra(CommuteAudioService.EXTRA_START_INDEX, startIndex);
        i.putExtra(CommuteAudioService.EXTRA_BED_URL, "");
        i.putExtra(CommuteAudioService.EXTRA_LOOP, true);
        i.putExtra(CommuteAudioService.EXTRA_TITLE, title == null ? "AI 电台" : title);
        i.putExtra(CommuteAudioService.EXTRA_START_POSITION, (long) startPositionMs);
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("music_start_failed: " + t.getMessage());
        }
    }

    // 封面懒取回填：把某首歌的封面 URL 补给原生（更新当前曲的 MediaSession 元数据 → 锁屏显示封面）。
    @PluginMethod
    public void musicSetArtwork(PluginCall call) {
        int index = call.getInt("index", -1);
        String url = call.getString("url", "");
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(CommuteAudioService.ACTION_SET_ARTWORK);
        i.putExtra(CommuteAudioService.EXTRA_START_INDEX, index);
        i.putExtra(CommuteAudioService.EXTRA_ARTWORK, url == null ? "" : url);
        try { getContext().startService(i); } catch (Throwable ignored) { /* ignore */ }
        call.resolve();
    }

    @PluginMethod
    public void audioDuck(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_DUCK); call.resolve(); }

    @PluginMethod
    public void audioUnduck(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_UNDUCK); call.resolve(); }

    /**
     * DJ 音乐模式的口播：交给原生 bedPlayer 播。
     * WebView 的 <audio> 在展示台这台 ROM 上放不出声（currentTime 卡在 0），
     * 而且它抢音频焦点会把音乐播放器打成暂停——所以口播必须走原生。
     */
    @PluginMethod
    public void audioSpeak(PluginCall call) {
        String url = call.getString("url", "");
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(CommuteAudioService.ACTION_SPEAK);
        i.putExtra(CommuteAudioService.EXTRA_SPEAK_URL, url == null ? "" : url);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void audioSpeakStop(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_SPEAK_STOP); call.resolve(); }

    @PluginMethod
    public void commutePause(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_PAUSE); call.resolve(); }

    @PluginMethod
    public void commuteResume(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_RESUME); call.resolve(); }

    @PluginMethod
    public void commuteStop(PluginCall call) { sendCommuteAction(CommuteAudioService.ACTION_STOP); call.resolve(); }

    @PluginMethod
    public void commuteSeekIndex(PluginCall call) {
        int index = call.getInt("index", 0);
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(CommuteAudioService.ACTION_SEEK);
        i.putExtra(CommuteAudioService.EXTRA_START_INDEX, index);
        try { getContext().startService(i); } catch (Throwable ignored) { /* ignore */ }
        call.resolve();
    }

    @PluginMethod
    public void commuteState(PluginCall call) {
        JSObject ret;
        try {
            ret = new JSObject(CommuteAudioService.stateJson());
        } catch (Throwable t) {
            ret = new JSObject();
        }
        call.resolve(ret);
    }

    private void sendCommuteAction(String action) {
        Intent i = new Intent(getContext(), CommuteAudioService.class);
        i.setAction(action);
        try { getContext().startService(i); } catch (Throwable ignored) { /* ignore */ }
    }
}
