package com.llm.live2d

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Size
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream

/**
 * U3 电台桌面（RadioLauncher）JS 桥：构建标志 / 本地音乐扫描 / 播放控制 / 应用抽屉 / 系统设置直达 / 电池优化豁免。
 * phone flavor 同样编译注册（IS_LAUNCHER=false），前端不会走电台路径，无行为影响。
 */
@CapacitorPlugin(name = "RadioLauncher")
class RadioLauncherPlugin : Plugin() {

    // registerMediaChangeReceiver() 注册的广播/去抖状态，提升为字段以便 handleOnDestroy() 对称反注册。
    private var mediaReceiver: BroadcastReceiver? = null
    private var mediaDebounceHandler: Handler? = null
    private var mediaPending: Runnable? = null

    override fun load() {
        // 电台行为只在 u3 构建生效；phone flavor 零注册零监听（回归门）
        if (!BuildConfig.IS_LAUNCHER) return
        // 服务状态 → JS 事件（player 回调已在主线程；post 兜底防桥线程问题）
        RadioPlaybackService.stateListener = { snap ->
            Handler(Looper.getMainLooper()).post { notifyListeners("playbackState", snapToJS(snap)) }
        }
        registerMediaChangeReceiver()
    }

    override fun handleOnDestroy() {
        if (BuildConfig.IS_LAUNCHER) {
            RadioPlaybackService.stateListener = null
            // 对称反注册：配置变更（旋转等）会重建 Activity/插件，registerMediaChangeReceiver() 若不在
            // 这里反注册就会泄漏 receiver 且下次 load() 重复注册造成 mediaChanged 重复通知；先撤销未
            // 触发的去抖 Runnable，避免它在插件已销毁后才触发、对已销毁插件 notifyListeners。
            mediaPending?.let { mediaDebounceHandler?.removeCallbacks(it) }
            mediaReceiver?.let {
                try { context.unregisterReceiver(it) } catch (_: IllegalArgumentException) { /* 未注册/已反注册容忍 */ }
            }
            mediaReceiver = null
            mediaDebounceHandler = null
            mediaPending = null
        }
    }

    /**
     * SD 卡挂载/弹出 → 通知前端重扫（2s 去抖，挂载后 MediaStore 需要片刻索引才能查到新曲目）。
     * 去抖实现：捕获同一个 Handler + 可变 Runnable 引用，新广播到达时先撤销待执行的旧回调再重新排期
     * （Handler.postDelayed(Runnable, Object token, long) 在部分 AndroidX 版本上不是稳定公开 API，改用
     *  「同一 Handler 实例 removeCallbacks(Runnable) 只认 Runnable 身份」这条更朴素也更稳的规则实现等价去抖）。
     */
    private fun registerMediaChangeReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_MEDIA_MOUNTED)
            addAction(Intent.ACTION_MEDIA_EJECT)
            addAction(Intent.ACTION_MEDIA_UNMOUNTED)
            addDataScheme("file")
        }
        val debounceHandler = Handler(Looper.getMainLooper())
        mediaDebounceHandler = debounceHandler
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                mediaPending?.let { debounceHandler.removeCallbacks(it) }
                val r = Runnable { notifyListeners("mediaChanged", JSObject()) }
                mediaPending = r
                debounceHandler.postDelayed(r, 2000)
            }
        }
        mediaReceiver = receiver
        // targetSdk 36 在 API33+ 设备上强制要求声明导出性；这几个都是系统保护广播，标 NOT_EXPORTED。
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun snapToJS(s: RadioPlaybackService.Snapshot): JSObject = JSObject()
        .put("playing", s.playing).put("index", s.index)
        .put("positionMs", s.positionMs).put("durationMs", s.durationMs).put("ended", s.ended)

    private fun ensureService() {
        if (RadioPlaybackService.instance == null) {
            context.startService(Intent(context, RadioPlaybackService::class.java))
        }
    }

    /**
     * 服务就绪后在【主线程】执行 block 再 resolve。
     * 两个硬约束：①startService 异步，轮询兜底最多 ~1.5s；
     * ②Capacitor 插件方法跑在插件线程池，而 ExoPlayer 只许从主线程访问——所有触碰 player 的
     *   调用（setQueue/control/snapshot）必须经这里 hop 到主线程，直调必炸 IllegalStateException。
     */
    private fun withService(call: PluginCall, attempt: Int = 0, block: (RadioPlaybackService) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        val svc = RadioPlaybackService.instance
        if (svc != null) {
            main.post {
                try { block(svc); call.resolve() } catch (e: Exception) { call.reject(e.message ?: "playback error") }
            }
            return
        }
        if (attempt == 0) ensureService()
        if (attempt >= 30) { call.reject("playback service unavailable"); return }
        main.postDelayed({ withService(call, attempt + 1, block) }, 50)
    }

    @PluginMethod
    fun getLauncherInfo(call: PluginCall) {
        // isLauncher 保留不动：旧前端（以及混跑的旧 APK）仍在读它，删了会连带电台一起炸。
        // kind 是新增的细分（none/radio/handheld），前端据它决定挂哪个根。
        call.resolve(
            JSObject()
                .put("isLauncher", BuildConfig.IS_LAUNCHER)
                .put("kind", BuildConfig.LAUNCHER_KIND),
        )
    }

    private fun audioPermission(): String =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO
        else Manifest.permission.READ_EXTERNAL_STORAGE

    private fun audioGranted(): Boolean =
        ContextCompat.checkSelfPermission(context, audioPermission()) == PackageManager.PERMISSION_GRANTED

    @PluginMethod
    fun hasAudioPermission(call: PluginCall) {
        call.resolve(JSObject().put("granted", audioGranted()))
    }

    /** 发起系统权限弹窗后立即 resolve；前端在窗口重获焦点后重查 hasAudioPermission。 */
    @PluginMethod
    fun requestAudioPermission(call: PluginCall) {
        if (!audioGranted()) {
            val perms = if (Build.VERSION.SDK_INT >= 33)
                arrayOf(audioPermission(), Manifest.permission.POST_NOTIFICATIONS)
            else arrayOf(audioPermission())
            activity?.let { ActivityCompat.requestPermissions(it, perms, 4301) }
        }
        call.resolve()
    }

    @PluginMethod
    fun scanAudio(call: PluginCall) {
        if (!audioGranted()) {
            call.resolve(JSObject().put("granted", false).put("tracks", JSArray()))
            return
        }
        val tracks = JSArray()
        val cols = arrayOf(
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.DURATION,
        )
        context.contentResolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols,
            "${MediaStore.Audio.Media.IS_MUSIC} != 0", null,
            "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                tracks.put(
                    JSObject()
                        .put("id", id.toString())
                        .put("uri", ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id).toString())
                        .put("title", c.getString(1) ?: "")
                        .put("artist", c.getString(2) ?: "")
                        .put("album", c.getString(3) ?: "")
                        .put("durationMs", c.getLong(4)),
                )
            }
        }
        call.resolve(JSObject().put("granted", true).put("tracks", tracks))
    }

    /** 专辑封面缩略图 → dataURL；无封面/低版本返回空串（前端画默认胶片）。 */
    @PluginMethod
    fun getAlbumArt(call: PluginCall) {
        val trackId = call.getString("trackId")?.toLongOrNull()
        if (trackId == null) { call.reject("trackId required"); return }
        if (Build.VERSION.SDK_INT < 29) { call.resolve(JSObject().put("dataUrl", "")); return }
        try {
            val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
            val bmp = context.contentResolver.loadThumbnail(uri, Size(256, 256), null)
            val out = ByteArrayOutputStream()
            bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out)
            call.resolve(JSObject().put("dataUrl",
                "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
        } catch (e: Exception) {
            call.resolve(JSObject().put("dataUrl", ""))
        }
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val arr = call.getArray("tracks") ?: run { call.reject("tracks required"); return }
        val startIndex = call.getInt("startIndex") ?: 0
        val items = mutableListOf<MediaItem>()
        for (i in 0 until arr.length()) {
            val t = arr.getJSONObject(i)
            items.add(
                MediaItem.Builder()
                    .setUri(t.optString("uri"))
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(t.optString("title", "未知曲目"))
                            .setArtist(t.optString("artist", ""))
                            .setAlbumTitle(t.optString("album", ""))
                            .build(),
                    )
                    .build(),
            )
        }
        val playWhenReady = call.getBoolean("playWhenReady", true) ?: true
        withService(call) { it.setQueue(items, startIndex, playWhenReady) }
    }

    @PluginMethod
    fun playbackControl(call: PluginCall) {
        val op = call.getString("op") ?: run { call.reject("op required"); return }
        val index = call.getInt("index") ?: -1
        val positionMs = (call.getInt("positionMs") ?: 0).toLong()
        // 保留级排障日志：语音控制链路（utterance→意图→执行→原生）末端可观测（这台 ROM 日志噪音大靠 tag 过滤）。
        android.util.Log.d("RadioLauncher", "playbackControl op=$op index=$index svc=${RadioPlaybackService.instance != null}")
        withService(call) { it.control(op, index, positionMs) }
    }

    @PluginMethod
    fun getPlaybackState(call: PluginCall) {
        // snapshot() 读 player，同样必须主线程
        Handler(Looper.getMainLooper()).post {
            val svc = RadioPlaybackService.instance
            call.resolve(snapToJS(svc?.snapshot() ?: RadioPlaybackService.Snapshot(false, -1, 0, 0, false)))
        }
    }

    @PluginMethod
    fun listApps(call: PluginCall) {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val self = context.packageName
        val apps = JSArray()
        val entries = pm.queryIntentActivities(intent, 0)
            .filter { it.activityInfo.packageName != self }
            .map { info ->
                Triple(
                    info.activityInfo.packageName,
                    info.loadLabel(pm)?.toString() ?: info.activityInfo.packageName,
                    info.loadIcon(pm),
                )
            }
            .sortedBy { it.second.lowercase() }
        for ((pkg, label, drawable) in entries) {
            val bmp = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            drawable.setBounds(0, 0, 96, 96)
            drawable.draw(canvas)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            apps.put(
                JSObject().put("pkg", pkg).put("label", label)
                    .put("icon", "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)),
            )
        }
        call.resolve(JSObject().put("apps", apps))
    }

    @PluginMethod
    fun launchApp(call: PluginCall) {
        val pkg = call.getString("pkg") ?: run { call.reject("pkg required"); return }
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) { call.reject("no launch intent for $pkg"); return }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openSystemSettings(call: PluginCall) {
        val action = when (call.getString("section")) {
            "wifi" -> Settings.ACTION_WIFI_SETTINGS
            "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
            "home" -> Settings.ACTION_HOME_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        try {
            context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        } catch (e: Exception) {
            // 个别 ROM 缺页则回落总设置
            context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        }
    }

    /** 是否已在电池优化白名单——careai ROM 不豁免则灭屏约12分钟按 app-idle 杀播放服务（task-10 实锤）。 */
    @PluginMethod
    fun getBatteryExemption(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val exempt = pm.isIgnoringBatteryOptimizations(context.packageName)
        // 保留级排障日志：这台 ROM 的 logcat 噪音极大且 events buffer 关闭，链路断点全靠 tag 过滤
        android.util.Log.d("RadioLauncher", "getBatteryExemption exempt=$exempt pkg=${context.packageName}")
        call.resolve(JSObject().put("exempt", exempt))
    }

    /**
     * 拉起系统「忽略电池优化」授权弹窗（需 u3 manifest 的 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。
     * 个别 ROM 缺该弹窗页则回落电池优化列表页，让用户手动把本应用设为「不优化」。
     */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            android.util.Log.d("RadioLauncher", "requestBatteryExemption dialog fired")
            call.resolve()
        } catch (e: Exception) {
            android.util.Log.w("RadioLauncher", "requestBatteryExemption dialog failed, fallback to list", e)
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        }
    }

    /** 音量档位钳制（纯逻辑，便于自审）：把 cur+deltaIndex 夹到 [0, max]。 */
    private fun clampVolumeIndex(cur: Int, deltaIndex: Int, max: Int): Int =
        Math.max(0, Math.min(max, cur + deltaIndex))

    private fun audioManager(): AudioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /** 当前 STREAM_MUSIC 音量归一到 0..1（max=0 的异常设备兜底 0）。 */
    @PluginMethod
    fun getVolume(call: PluginCall) {
        val am = audioManager()
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val value = if (max > 0) cur.toDouble() / max else 0.0
        call.resolve(JSObject().put("value", value))
    }

    /** 绝对设定音量 value∈[0,1]（越界钳制到边界）。 */
    @PluginMethod
    fun setVolume(call: PluginCall) {
        val value = (call.getDouble("value") ?: 0.0).coerceIn(0.0, 1.0)
        val am = audioManager()
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val idx = Math.round(value * max).toInt()
        am.setStreamVolume(AudioManager.STREAM_MUSIC, clampVolumeIndex(idx, 0, max), 0)
        android.util.Log.d("RadioLauncher", "setVolume value=$value idx=$idx max=$max")
        call.resolve()
    }

    /** 相对增减 delta∈[-1,1] 分数：换算成档位，至少变动 1 档（避免小 max 设备四舍五入=0 不动）。 */
    @PluginMethod
    fun adjustVolume(call: PluginCall) {
        val delta = (call.getDouble("delta") ?: 0.0).coerceIn(-1.0, 1.0)
        val am = audioManager()
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        var deltaIdx = Math.round(delta * max).toInt()
        if (deltaIdx == 0 && delta > 0) deltaIdx = 1
        if (deltaIdx == 0 && delta < 0) deltaIdx = -1
        val next = clampVolumeIndex(cur, deltaIdx, max)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, next, 0)
        android.util.Log.d("RadioLauncher", "adjustVolume delta=$delta cur=$cur -> $next max=$max")
        call.resolve()
    }
}
