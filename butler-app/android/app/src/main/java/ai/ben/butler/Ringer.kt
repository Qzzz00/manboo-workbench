package ai.ben.butler

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 响铃的那一套(铃声 + 震动 + 来电通知 / 全屏通知),**全 App 只有这一份**(2026-10-20,卡 E 从 DeskPhonePlugin 里搬出来)。
 *
 * 为什么搬:来电现在有两条路 —— App 在前台时网页收 `ring` 再调 DeskPhonePlugin.startRinging;熄屏后网页被冻住,
 * 由前台服务里的 NativeRingListener 自己收 `ring` 直接调这里。两条路响的必须是同一个铃,
 * 并且**按来电 id 去重**(RingBook):亮屏回来网页收到工人补发的那一通,不许再响一遍。
 *
 * 行为与 09-21 / 10-03 那版逐条相同(频道、铃声走「铃声」音量、震动节奏、做不到全屏就降级成抬头通知并如实说)。
 */
object Ringer {

    private const val TAG = "NativeRing"

    /** 来电那条通知的频道。IMPORTANCE_HIGH 是 fullScreenIntent 生效的前提。 */
    const val CHANNEL_RING = "wb_ring"
    /** 座机模式那条常驻通知、普通通知的频道(低优先级,不出声、不弹)。 */
    const val CHANNEL_DESK = "wb_deskphone"
    const val NOTIFICATION_RING = 4101
    /** 普通通知(答案来找她、夜间静默那条来电)。同一个 id、按 tag 区分。 */
    const val NOTIFICATION_NOTICE = 4105

    /**
     * 震动节奏。与网页那条退路(src/deskphone/deskPhone.ts 的 RING_VIBRATE_PATTERN)同一份 ——
     * 两处写不一样的节奏,同一台机器在前台和后台会震出两种手感。
     */
    @JvmField
    val VIBRATE_PATTERN = longArrayOf(0, 400, 600, 400, 600, 400, 600)

    /** 包里那段合成铃声(cap sync 之后的位置);放不出来退到系统缺省铃声。 */
    private const val RINGTONE_ASSET = "public/ring/ringtone.m4a"

    const val NO_NOTIFY_NOTE = "没有通知权限:App 在后台或锁屏时弹不出来电页(铃声和震动照样有)"
    const val NO_FULL_SCREEN_NOTE = "这台机器上不能在锁屏时自动弹出来电页:去系统设置里给「事务官」打开「全屏通知」"

    class Result(
        @JvmField val started: Boolean,
        @JvmField val fullScreen: Boolean,
        @JvmField val nativeTone: Boolean,
        @JvmField val note: String?,
        /** 同一通已经在响 / 刚收场:这一次什么都没做。 */
        @JvmField val deduped: Boolean,
    )

    private val book = RingBook()
    private var tone: MediaPlayer? = null
    private var last: Result? = null
    private val main = Handler(Looper.getMainLooper())
    private var expire: Runnable? = null

    // ———————————————— 频道与权限 ————————————————

    @JvmStatic
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val ring = NotificationChannel(CHANNEL_RING, "事务官来电", NotificationManager.IMPORTANCE_HIGH)
        ring.description = "等你确认 / 运行失败 / 完成时,事务官打来的电话"
        // 频道本身不出声:铃声由下面那个 MediaPlayer 放(循环、说停就停),频道再响一遍就是两个铃一起响。
        ring.setSound(null, null)
        ring.enableVibration(true)
        ring.vibrationPattern = VIBRATE_PATTERN
        ring.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        manager.createNotificationChannel(ring)

        val desk = NotificationChannel(CHANNEL_DESK, "座机模式", NotificationManager.IMPORTANCE_MIN)
        desk.description = "座机模式开着时的那条常驻提示"
        desk.setShowBadge(false)
        manager.createNotificationChannel(desk)
    }

    /** 权限给了、系统里本应用的通知总开关也开着(13 以下没有权限这一说,只剩总开关)。 */
    @JvmStatic
    fun canNotify(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    /** Android 14 起 USE_FULL_SCREEN_INTENT 要用户自己开;开没开只有系统答得了。 */
    @JvmStatic
    fun canFullScreen(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = context.getSystemService(NotificationManager::class.java)
        return manager != null && manager.canUseFullScreenIntent()
    }

    /** 点通知 / 全屏通知都回到 MainActivity。singleTask,所以不会开出第二个。 */
    @JvmStatic
    fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(context, 0, intent, flags)
    }

    // ———————————————— 响 / 停 ————————————————

    /**
     * 开始响。`untilMs` = 响到什么时候(电脑的钟,原生那一路才有);不给就按兜底上限(网页那一路自己会停)。
     * 同一通已经在响 → 不重响,回上一次的结果(网页据此不放自己那段 `<audio>`)。
     */
    @JvmStatic
    @Synchronized
    fun start(context: Context, callId: String, title: String, text: String, untilMs: Long, via: String): Result {
        val app = context.applicationContext
        val key = callId.ifEmpty { "call" }
        when (book.start(key)) {
            RingBook.Start.ALREADY -> {
                Log.i(TAG, "ring dedup call=$key via=$via")
                val prev = last
                return Result(true, prev?.fullScreen ?: false, prev?.nativeTone ?: false, prev?.note, true)
            }
            RingBook.Start.ENDED -> {
                Log.i(TAG, "ring ended-already call=$key via=$via")
                // 回「原生在放」:网页别拿 `<audio>` 去补一个已经收场的电话。
                return Result(true, false, true, null, true)
            }
            RingBook.Start.RING -> Unit
        }
        Log.i(TAG, "ring start call=$key via=$via")
        ensureChannels(app)
        var fullScreen = false
        var note: String? = null
        if (!canNotify(app)) {
            note = NO_NOTIFY_NOTE
        } else {
            val builder = NotificationCompat.Builder(app, CHANNEL_RING)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(openAppIntent(app))
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                .setVibrate(VIBRATE_PATTERN)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // 发不出全屏(Android 14 没开那项权限)系统会降级成抬头通知 —— 那不是失败,是降级,如实说。
            if (canFullScreen(app)) {
                builder.setFullScreenIntent(openAppIntent(app), true)
                fullScreen = true
            } else {
                note = NO_FULL_SCREEN_NOTE
            }
            try {
                NotificationManagerCompat.from(app).notify(NOTIFICATION_RING, builder.build())
            } catch (error: SecurityException) {
                note = "通知发不出去:" + error.message
            }
        }
        vibrate(app)
        val played = playTone(app)
        val result = Result(true, fullScreen, played, note, false)
        last = result
        scheduleExpire(app, key, if (untilMs > 0) NativeRingPolicy.ringTimeoutMs(untilMs, System.currentTimeMillis()) else NativeRingPolicy.MAX_RING_MS)
        return result
    }

    /** 停铃。带 id 只停那一通(不是正在响的那通就什么都不做);null = 全停。 */
    @JvmStatic
    @Synchronized
    fun stop(context: Context, callId: String?) {
        if (!book.stop(callId?.ifEmpty { null })) return
        Log.i(TAG, "ring stop call=${callId ?: "*"}")
        silence(context.applicationContext)
    }

    private fun silence(app: Context) {
        expire?.let { main.removeCallbacks(it) }
        expire = null
        last = null
        NotificationManagerCompat.from(app).cancel(NOTIFICATION_RING)
        vibrator(app)?.cancel()
        stopTone()
    }

    private fun scheduleExpire(app: Context, callId: String, delayMs: Long) {
        expire?.let { main.removeCallbacks(it) }
        val task = Runnable { stop(app, callId) }
        expire = task
        main.postDelayed(task, delayMs)
    }

    /**
     * 只发一条普通通知:不响铃、不震、不拉起来电页。`key` 当 tag —— 不同 key 各占一条,同一个 key 再发是更新那一条。
     * 答案来找她、夜间静默那条来电都走这里。回 null = 发出去了;否则是那句做不到的话。
     */
    @JvmStatic
    fun postNotice(context: Context, key: String?, title: String, text: String): String? {
        val app = context.applicationContext
        ensureChannels(app)
        if (!canNotify(app)) return "没有通知权限:App 在后台时这条通知弹不出来"
        val tag = if (key.isNullOrEmpty()) "notice" else key
        val builder = NotificationCompat.Builder(app, CHANNEL_DESK)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openAppIntent(app))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        return try {
            NotificationManagerCompat.from(app).notify(tag, NOTIFICATION_NOTICE, builder.build())
            null
        } catch (error: SecurityException) {
            "通知发不出去:" + error.message
        }
    }

    /**
     * 熄屏时把屏点亮一下(原生那一路;网页那一路由 Activity 的 setTurnScreenOn 管)。
     * 全屏通知没被放行时(Pixel 上 USE_FULL_SCREEN_INTENT 缺省 deny)这是唯一让他看得见的一下。
     * 系统不让亮就算了:铃声与震动照样有。
     */
    @JvmStatic
    @Suppress("DEPRECATION")
    fun wakeScreen(context: Context) {
        try {
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            if (power.isInteractive) return
            val lock = power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "butler:ringWake",
            )
            lock.acquire(5_000)
        } catch (_: Exception) { /* 不让亮就不亮 */ }
    }

    // ———————————————— 铃声与震动 ————————————————

    /**
     * 放铃声。走「铃声」那一路音量(USAGE_NOTIFICATION_RINGTONE):手机调成静音 / 震动时它跟着不响,
     * 和真电话一样。放不出来回 false,网页那段 `<audio>` 顶上。
     */
    private fun playTone(app: Context): Boolean {
        stopTone()
        val player = MediaPlayer()
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        return try {
            player.setAudioAttributes(attributes)
            try {
                app.assets.openFd(RINGTONE_ASSET).use { fd -> player.setDataSource(fd.fileDescriptor, fd.startOffset, fd.length) }
            } catch (missing: Exception) {
                val fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: throw missing
                player.reset()
                player.setAudioAttributes(attributes)
                player.setDataSource(app, fallback)
            }
            player.isLooping = true
            player.prepare()
            player.start()
            tone = player
            true
        } catch (_: Exception) {
            player.release()
            false
        }
    }

    private fun stopTone() {
        val player = tone ?: return
        tone = null
        try { player.stop() } catch (_: Exception) { /* 还没 start 完 */ }
        player.release()
    }

    private fun vibrator(app: Context): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    private fun vibrate(app: Context) {
        val vibrator = vibrator(app) ?: return
        if (!vibrator.hasVibrator()) return
        // 第二个参数 0 = 从头循环,直到 cancel()。一台真座机就是一直响到你接或者它放弃。
        vibrator.vibrate(VibrationEffect.createWaveform(VIBRATE_PATTERN, 0))
    }
}
