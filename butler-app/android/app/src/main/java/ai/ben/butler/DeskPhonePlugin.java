package ai.ben.butler;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 座机(2026-09-21,Ben:手机装在 3D 打印外壳里当座机,「待确认 / 运行失败 / 完成提醒时座机响铃」)。
 *
 * <p>三件只有原生做得到的事,网页那一层(src/deskphone/deskPhone.ts)一件都做不到:
 *
 * <ol>
 *   <li><b>屏幕常亮、不锁屏</b>。{@code FLAG_KEEP_SCREEN_ON} + {@code setShowWhenLocked} +
 *       {@code setTurnScreenOn}。{@code navigator.wakeLock} 在 Capacitor 的 WebView 里不保证有,
 *       而且它只管「不熄屏」,管不了「已经锁了要亮起来」。</li>
 *   <li><b>后台 / 锁屏时把来电页拉起来</b>。这是 {@code setFullScreenIntent} ——
 *       <b>{@code @capacitor/local-notifications} 没有这一项</b>(它的 Android 实现走
 *       NotificationCompat.Builder,选项表里根本没有 fullScreenIntent 的入口),
 *       所以这件事只能自己写。社区插件有做的,但那是往供应链里再加一个 pin 不住的东西(C4)。</li>
 *   <li><b>震动</b>。{@code navigator.vibrate} 在 WebView 里通常可用,所以网页那边有一条退路;
 *       但 App 在后台时网页压根没在跑,那时只有这里震得动。</li>
 * </ol>
 *
 * <p><b>后台 / 锁屏(2026-10-03 改)</b>:09-21 写的「一条常驻通知就让系统别回收」在 Android 14 上不成立 ——
 * 没有前台服务的后台进程几秒就被冻住,网页里那条收铃的连接跟着停。现在由
 * {@link RingStandbyService}(specialUse 前台服务)保活,{@link #setStandby} 开关它;
 * 铃声也改由这里放({@code tone: "native"}),后台时网页的 {@code <audio>} 不保证放得出来。
 *
 * <p><b>做不到的那一件,如实写在这儿</b>:App 被<b>彻底杀掉</b>(多任务里划掉、重启后没打开过)
 * 之后叫不醒。那要推送(厂商通道),这一版不做。
 *
 * <p>三个方法与 MicPermissionPlugin 同一条路子:{@code status()} 如实回「做得到哪几样」,
 * 做不到的带一句人话回去,网页原样显示 —— <b>不装作开了</b>。
 */
@CapacitorPlugin(
    name = "DeskPhone",
    permissions = { @Permission(alias = DeskPhonePlugin.NOTIFY, strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class DeskPhonePlugin extends Plugin {

    static final String NOTIFY = "notify";

    /** 座机模式那条常驻通知的 id(4101 / 4105 是 Ringer 的,4103 / 4104 是 RingStandbyService 的)。 */
    private static final int NOTIFICATION_DESK = 4102;

    /** 网页那边认的「铃声由原生放了」(src/deskphone/deskPhone.ts 的 NATIVE_TONE)。 */
    private static final String TONE_NATIVE = "native";

    private boolean deskPhoneOn = false;

    // ———————————————————————— 频道 ————————————————————————

    private void ensureChannels() {
        Ringer.ensureChannels(getContext());
    }

    private PendingIntent openAppIntent() {
        return Ringer.openAppIntent(getContext());
    }

    private boolean canFullScreen() {
        return Ringer.canFullScreen(getContext());
    }

    private boolean canNotify() {
        return Ringer.canNotify(getContext());
    }

    /**
     * 来电时系统顶部弹不弹得出横幅。频道建出来是 IMPORTANCE_HIGH,但她(或小米把「悬浮通知」缺省关掉)
     * 能把它降下来 —— 降到 HIGH 以下就只进下拉栏、不往下弹。只认系统此刻回的那个值,不猜。
     */
    private boolean canBanner() {
        if (!canNotify()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        ensureChannels();
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) return false;
        NotificationChannel ring = manager.getNotificationChannel(Ringer.CHANNEL_RING);
        return ring != null && ring.getImportance() >= NotificationManager.IMPORTANCE_HIGH;
    }

    // ———————————————————————— 响铃 ————————————————————————

    /**
     * 开始响(网页那一路,App 在前台时)。响铃本身在 {@link Ringer}:与熄屏后原生那一路(NativeRingListener)
     * 是同一套,并<b>按来电 id 去重</b> —— 同一通已经在响(原生先收到了),这里不重响,照样回 {@code tone:"native"}。
     */
    @PluginMethod
    public void startRinging(PluginCall call) {
        String callId = call.getString("callId", "");
        String title = call.getString("title", "事务官来电");
        String text = call.getString("text", "");
        boolean silent = Boolean.TRUE.equals(call.getBoolean("silent", false));

        if (silent) {
            // 只发一条普通通知:与 postNotice 同一条路,callId 当 tag(不再占座机常驻那条的 id)。
            JSObject quiet = noticeResult(Ringer.postNotice(getContext(), callId, title, text));
            quiet.put("started", Boolean.TRUE.equals(quiet.getBool("posted")));
            quiet.put("fullScreen", false);
            call.resolve(quiet);
            return;
        }

        Ringer.Result ring = Ringer.start(getContext(), callId, title, text, 0L, "web");
        JSObject result = new JSObject();
        result.put("started", ring.started);
        result.put("fullScreen", ring.fullScreen);
        if (ring.nativeTone) result.put("tone", TONE_NATIVE);
        if (ring.note != null) result.put("note", ring.note);
        if (ring.deduped) result.put("deduped", true);
        // 锁着屏的时候把屏幕点亮:座机响了就该亮。全屏通知不一定点得亮(降级时不会)。
        if (!ring.deduped) wakeScreen();
        call.resolve(result);
    }

    /**
     * 只发一条普通通知:不响铃、不震、不拉起来电页。{@code key} 当 tag —— 不同 key 各占一条,
     * 同一个 key 再发是更新那一条。答案来找她、夜间静默那条来电都走这里。
     */
    @PluginMethod
    public void postNotice(PluginCall call) {
        call.resolve(noticeResult(Ringer.postNotice(getContext(), call.getString("key", ""), call.getString("title", "事务官"), call.getString("text", ""))));
    }

    private static JSObject noticeResult(String note) {
        JSObject result = new JSObject();
        result.put("posted", note == null);
        if (note != null) result.put("note", note);
        return result;
    }

    /** 停铃。带 {@code callId} 只停那一通(原生自己收到的那一通不许被顺手掐掉);不带照旧全停。 */
    @PluginMethod
    public void stopRinging(PluginCall call) {
        String callId = call.getString("callId", null);
        Ringer.stop(getContext(), callId == null || callId.isEmpty() ? null : callId);
        call.resolve();
    }

    // ———————————————————————— 原生听铃(2026-10-20,卡 E) ————————————————————————

    /**
     * 熄屏后由原生进房听铃(网页那一条先让出来,见 src/call/ringHandoff.ts)。凭证只放内存,不落盘、不打日志。
     * 待机服务没在跑就回 {@code on:false} + 一句话 —— 那时网页别把房间让出来。
     */
    @PluginMethod
    public void listenRing(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        String identity = call.getString("identity", "");
        Double expires = call.getDouble("expires_at");
        JSObject result = new JSObject();
        if (url == null || url.isEmpty() || token == null || token.isEmpty() || identity == null || identity.isEmpty() || expires == null) {
            result.put("on", false);
            result.put("note", "凭证缺字段");
            call.resolve(result);
            return;
        }
        String note = RingStandbyService.listen(new NativeRingListener.Credential(url, token, identity, expires.longValue()));
        result.put("on", note == null);
        if (note != null) result.put("note", note);
        call.resolve(result);
    }

    @PluginMethod
    public void unlistenRing(PluginCall call) {
        RingStandbyService.unlisten();
        call.resolve();
    }

    // ———————————————————————— 座机模式 ————————————————————————

    @PluginMethod
    public void setDeskPhone(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        deskPhoneOn = on;
        ensureChannels();
        applyDeskPhoneFlags(on);
        if (on) showDeskNotice(); else NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_DESK);
        JSObject result = new JSObject();
        result.put("on", on);
        call.resolve(result);
    }

    /**
     * 常亮 / 锁屏上也显示 / 来电时点亮屏幕。
     *
     * <p>{@code FLAG_KEEP_SCREEN_ON} 是那台外壳里的机器真正要的东西:它一直插着电,
     * 屏幕该一直亮着。<b>必须在 UI 线程上设</b>(窗口标志只能在 UI 线程改)。
     */
    private void applyDeskPhoneFlags(boolean on) {
        final android.app.Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                activity.setShowWhenLocked(on);
                activity.setTurnScreenOn(on);
            }
        });
    }

    /** 座机模式那条常驻通知。IMPORTANCE_MIN:不出声、不弹,只是让系统别急着回收这个进程。 */
    private void showDeskNotice() {
        if (!canNotify()) return;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), Ringer.CHANNEL_DESK)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("座机模式开着")
            .setContentText("屏幕常亮,随时能接事务官的电话")
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        try { NotificationManagerCompat.from(getContext()).notify(NOTIFICATION_DESK, builder.build()); }
        catch (SecurityException ignored) { /* 权限被撤了:常亮那一半照样生效 */ }
    }

    /** 锁着屏时把屏幕点亮。全屏通知降级成平抬头通知时,这是唯一还能让他看见的一下。 */
    private void wakeScreen() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return;
        final android.app.Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            activity.setShowWhenLocked(true);
            activity.setTurnScreenOn(true);
        });
    }

    // ———————————————————————— 后台待机(2026-10-03) ————————————————————————

    @PluginMethod
    public void setStandby(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        JSObject result = new JSObject();
        try {
            if (on) RingStandbyService.start(getContext()); else RingStandbyService.stop(getContext());
            result.put("on", on);
        } catch (Exception error) {
            // Android 12+ 不许从后台起前台服务(ForegroundServiceStartNotAllowedException):
            // 下一次回到前台网页会再调一次。如实回去。
            result.put("on", !on);
            result.put("note", "后台待机没起来:" + error.getMessage());
        }
        call.resolve(result);
    }

    private boolean batteryUnrestricted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private static boolean isXiaomi() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT);
        return maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco");
    }

    /** 只弹系统那个框;给不给由她,给没给下一次 status() 如实回。 */
    @PluginMethod
    public void requestBatteryUnrestricted(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !batteryUnrestricted()) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getContext().getPackageName()));
            if (!startSettings(intent)) startSettings(appDetails());
        }
        call.resolve();
    }

    /** 小米的「自启动」管理页;打不开(系统版本不同包名不同)退到本应用的系统设置页。 */
    @PluginMethod
    public void openVendorSettings(PluginCall call) {
        boolean opened = false;
        if (isXiaomi()) {
            Intent autostart = new Intent();
            autostart.setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity");
            opened = startSettings(autostart);
        }
        if (!opened) startSettings(appDetails());
        call.resolve();
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        boolean opened = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            opened = startSettings(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                Uri.parse("package:" + getContext().getPackageName())));
        }
        if (!opened) startSettings(appDetails());
        call.resolve();
    }

    /** 总开关关着:去本应用的通知页;开着:直接去「事务官来电」那个频道(横幅 / 悬浮通知在那儿)。 */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        boolean opened = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ensureChannels();
            Intent intent;
            if (NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
                intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, Ringer.CHANNEL_RING);
            } else {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            }
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            opened = startSettings(intent);
        }
        if (!opened) startSettings(appDetails());
        call.resolve();
    }

    private Intent appDetails() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
    }

    private boolean startSettings(Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    /** Activity 真的结束了(不是转屏):WebView 没了,待机收场并改口,见 RingStandbyService.appGone。 */
    @Override
    protected void handleOnDestroy() {
        android.app.Activity activity = getActivity();
        if (activity != null && activity.isFinishing() && !activity.isChangingConfigurations()) {
            Ringer.stop(getContext(), null);
            RingStandbyService.appGone(getContext());
        }
        // 不是真的结束(系统收了 Activity、进程还在):原生那一路可能正响着它自己收到的那一通,不掐。
        super.handleOnDestroy();
    }

    // ———————————————————————— 这台机器做得到哪几样 ————————————————————————

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean notify = canNotify();
        boolean full = canFullScreen();
        result.put("notifications", notify);
        result.put("banner", canBanner());
        result.put("fullScreen", notify && full);
        result.put("deskPhone", deskPhoneOn);
        result.put("standby", RingStandbyService.isRunning());
        // 原生听铃此刻在做什么(卡 E):off / connecting / listening / reconnecting / retrying / taken_over / failed。
        result.put("nativeRing", RingStandbyService.listenState());
        String ringNote = RingStandbyService.listenNote();
        if (ringNote != null) result.put("nativeRingNote", ringNote);
        result.put("batteryUnrestricted", batteryUnrestricted());
        if (isXiaomi()) result.put("vendor", "xiaomi");
        if (!notify) result.put("note", "没有通知权限:App 在后台或锁屏时叫不醒你");
        else if (!full) result.put("note", "这台机器上不能在锁屏时自动弹出来电页:去系统设置里给「事务官」打开「全屏通知」");
        call.resolve(result);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (canNotify()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(NOTIFY, call, "notifyResult");
    }

    @PermissionCallback
    private void notifyResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(NOTIFY) == PermissionState.GRANTED);
        call.resolve(result);
    }
}
