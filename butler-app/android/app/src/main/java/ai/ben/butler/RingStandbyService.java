package ai.ben.butler;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * 后台待机(2026-10-03,维护者:「起码做到保持 APP 存活在后台,在锁屏情况下和其他 APP 使用的时候
 * 还是要能响铃或通知」)。
 *
 * <p>收铃的是 WebView 里那条 LiveKit 连接(src/call/useIncoming.ts)。没有这个服务时:
 * Android 14 起后台进程几秒就被冻住(cached app freezer),锁屏久了 Doze 断网,
 * 屏一灭 CPU 睡下去、网页里的心跳不发,服务器把这台手机踢出房间 —— 工人看见「房里没有手机」就不打。
 * 前台服务让进程不冻、网不断;那把 PARTIAL_WAKE_LOCK 让心跳跟得上。
 *
 * <p><b>代价如实</b>:状态栏一直挂一条通知;CPU 不深睡,多耗电(还没在真机上量过)。设置里能关。
 *
 * <p><b>START_NOT_STICKY</b>:进程被杀后系统若把服务单独拉起来,WebView 并不在 ——
 * 那时挂着「随时接电话」是假话,所以不让它被拉起来。
 *
 * <p><b>原生听铃(2026-10-20,卡 E)</b>:实测熄屏约 5 分钟后 WebView 那一页被冻住,前台服务保住了进程和网,
 * 保不住那一页。所以熄屏后由这里的 {@link NativeRingListener} 用同一身份进房听铃,网页那条先让出来
 * (src/call/ringHandoff.ts)。常驻通知照实说现在是谁在守:原生连不上就改口,不挂一句假的「随时接电话」。
 */
public class RingStandbyService extends Service {

    private static final String CHANNEL_STANDBY = "wb_standby";
    private static final String CHANNEL_GONE = "wb_standby_gone";
    private static final int NOTIFICATION_STANDBY = 4103;
    private static final int NOTIFICATION_GONE = 4104;

    private static volatile boolean running = false;
    private static volatile RingStandbyService instance;

    private PowerManager.WakeLock wakeLock;
    private NativeRingListener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 服务没在跑时 listen 回的那句话(网页据此不把房间让出来)。 */
    static final String NOT_RUNNING_NOTE = "后台待机没在跑,熄屏后的电话没法交给系统这一侧";

    /** 原生听铃此刻的状态(NativeRingListener.STATE_*);服务不在就是 off。 */
    public static String listenState() {
        RingStandbyService service = instance;
        return service == null || service.listener == null ? NativeRingListener.STATE_OFF : service.listener.getState();
    }

    public static String listenNote() {
        RingStandbyService service = instance;
        return service == null || service.listener == null ? null : service.listener.getNote();
    }

    /**
     * 拿这张凭证进房听铃。回 null = 开始听了(连上要一两秒,连不上自己重试);否则是做不到的那句话。
     * 凭证只在内存里。
     */
    public static String listen(NativeRingListener.Credential credential) {
        RingStandbyService service = instance;
        if (service == null || !running) return NOT_RUNNING_NOTE;
        service.main.post(() -> service.ensureListener().start(credential));
        return null;
    }

    /** 离房(网页要收回了)。等主线程那一下做完再回,网页才好紧接着进房。 */
    public static void unlisten() {
        RingStandbyService service = instance;
        if (service == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) { service.stopListener(); return; }
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        service.main.post(() -> { service.stopListener(); done.countDown(); });
        try { done.await(3, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { /* 照样往下 */ }
    }

    private NativeRingListener ensureListener() {
        if (listener == null) {
            listener = new NativeRingListener(this, (state, note) -> { updateNotice(state, note); return kotlin.Unit.INSTANCE; });
        }
        return listener;
    }

    private void stopListener() {
        if (listener != null) listener.stop();
    }

    public static boolean isRunning() {
        return running;
    }

    public static void start(Context context) {
        Intent intent = new Intent(context, RingStandbyService.class);
        androidx.core.content.ContextCompat.startForegroundService(context, intent);
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_GONE);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, RingStandbyService.class));
    }

    /**
     * 页面没了(多任务里划掉 / Activity 被结束)。服务留着也收不到铃,所以收场,
     * 并把那条通知<b>改口</b>成「已退出」—— 不让她以为还在待机。
     */
    static void appGone(Context context) {
        if (!running) return;
        RingStandbyService service = instance;
        // 先把原生听铃收掉:不然 onDestroy 会把它当成「正守着铃却被停了」再改口一遍。
        if (service != null && service.listener != null) { service.listener.dispose(); service.listener = null; }
        stop(context);
        postGone(context, "事务官已退出,电话打不进来了", "点这里重新打开,就又能接电话");
    }

    private static void postGone(Context context, String title, String text) {
        ensureChannels(context);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_GONE)
            .setSmallIcon(android.R.drawable.stat_notify_missed_call)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try { NotificationManagerCompat.from(context).notify(NOTIFICATION_GONE, builder.build()); }
        catch (SecurityException ignored) { /* 通知权限被撤:那就只能不说 */ }
    }

    private static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        // LOW 而不是 MIN:前台服务挂在 MIN 频道上,有的系统会另弹一条「正在后台运行」。
        NotificationChannel standby = new NotificationChannel(CHANNEL_STANDBY, "随时接电话", NotificationManager.IMPORTANCE_LOW);
        standby.setDescription("切到别的 App 或锁屏时,让事务官的电话照样打得进来");
        standby.setShowBadge(false);
        manager.createNotificationChannel(standby);
        NotificationChannel gone = new NotificationChannel(CHANNEL_GONE, "接不了电话的提醒", NotificationManager.IMPORTANCE_DEFAULT);
        gone.setDescription("事务官被关掉、电话打不进来时提醒一声");
        manager.createNotificationChannel(gone);
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(context, 1, intent, flags);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 常驻通知那两行。原生听铃连不上 / 放弃时改口:不挂一句假的「随时接电话」。 */
    private Notification standbyNotice(String state, String note) {
        String title = "事务官 · 随时接电话";
        String text = "切到别的 App 或锁屏,电话照样打得进来";
        if (NativeRingListener.STATE_FAILED.equals(state)) {
            title = "事务官 · 熄屏时接不到电话";
            text = note != null ? note : "点这里打开事务官,重新连上";
        } else if (NativeRingListener.STATE_RETRYING.equals(state) || NativeRingListener.STATE_RECONNECTING.equals(state)) {
            text = "网络断了,正在重连;连上之前电话可能打不进来";
        }
        return new NotificationCompat.Builder(this, CHANNEL_STANDBY)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(this))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
    }

    private void updateNotice(String state, String note) {
        if (!running) return;
        try { NotificationManagerCompat.from(this).notify(NOTIFICATION_STANDBY, standbyNotice(state, note)); }
        catch (SecurityException ignored) { /* 通知权限被撤:那就只能不说 */ }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        instance = this;
        Notification notification = standbyNotice(listenState(), listenNote());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_STANDBY, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_STANDBY, notification);
        }
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "butler:ringStandby");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        }
        running = true;
        return START_NOT_STICKY;
    }

    /** 多任务里划掉:WebView 跟着没了,见 {@link #appGone}。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        appGone(this);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        boolean wasListening = listener != null && !NativeRingListener.STATE_OFF.equals(listener.getState())
            && !NativeRingListener.STATE_TAKEN_OVER.equals(listener.getState());
        if (listener != null) { listener.dispose(); listener = null; }
        /*
         * 熄屏时正由这里守着铃,服务却被停了(系统收了 / 被她在系统里停掉):网页那一页多半冻着,
         * 这之后的电话打不进来。改口说一声,不让那条「随时接电话」不声不响地消失。
         */
        if (wasListening) postGone(this, "后台待机停了,熄屏时接不到电话", "点这里重新打开事务官");
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }
}
