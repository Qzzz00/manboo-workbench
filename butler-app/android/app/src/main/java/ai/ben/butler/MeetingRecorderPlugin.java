package ai.ben.butler;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.File;

/**
 * 会议录音(2026-09-21,Ben:「手机上还有『会议模式』」)。
 *
 * <p>网页那一侧只要四个动作 + 两条事件,真正干活的是 {@link MeetingRecorderService}
 * —— 一个挂着常驻通知的**前台服务**,这样锁屏之后还在录(理由写在那个文件的头上)。
 *
 * <p>为什么不用现成的 Capacitor 插件:官方 {@code @capacitor/*} 里没有录音;社区那几个
 * (capacitor-voice-recorder 一类)录的是一整段、没有前台服务、也不分段 —— 三条都不满足。
 * 所以照 {@link MicPermissionPlugin} 的先例自己写一件,**只写这一件事需要的那几个方法**。
 *
 * <p>录音权限本身**不在这里要**:会议页在开录之前已经用 {@code MicPermission} 问过了
 * (弹框不该压在一场已经开始的会上)。这里只声明,免得系统在 start 那一刻才发现没有。
 */
@CapacitorPlugin(
    name = "MeetingRecorder",
    permissions = { @Permission(alias = MeetingRecorderPlugin.MIC, strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class MeetingRecorderPlugin extends Plugin {

    static final String MIC = "mic";

    /** 录音落在 App 自己的文件目录下面这个文件夹里(不是公共下载目录,那一层 Capacitor 够不到)。 */
    private static final String DIR_NAME = "meetings";

    private final MeetingRecorderService.Listener listener = new MeetingRecorderService.Listener() {
        @Override
        public void onSegment(int seq, String path, long ms, String mimeType) {
            JSObject data = new JSObject();
            data.put("seq", seq);
            data.put("path", path);
            data.put("ms", ms);
            data.put("mimeType", mimeType);
            notifyListeners("segment", data);
        }

        @Override
        public void onError(String message) {
            JSObject data = new JSObject();
            data.put("message", message);
            notifyListeners("error", data);
        }
    };

    /**
     * 插件每次随网页那一半起来都把监听挂回去(2026-10-09)。从最近任务里划掉 App、或者系统回收了网页,
     * 前台服务可能还在录;重开之后网页那一侧 {@code status()} 看见还在录就接回来,
     * 之后报上来的段要落到**这一个**插件上,不能落到已经没了的那个上。
     */
    @Override
    public void load() {
        MeetingRecorderService.setListener(listener);
    }

    /** 前台服务此刻的样子:在不在录、暂停没有、录到第几段、落在哪个目录。网页重开时据此接回。 */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("recording", MeetingRecorderService.isRecording());
        result.put("paused", MeetingRecorderService.isPaused());
        result.put("seq", MeetingRecorderService.currentSeq());
        String dir = MeetingRecorderService.currentDir();
        if (dir != null) result.put("dir", dir);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        long segmentMs = call.getLong("segmentMs", 10 * 60 * 1000L);
        // 一场会一个目录:目录名用开始那一刻的毫秒数,**绝不往上一场的目录里叠**。
        File dir = new File(new File(getContext().getFilesDir(), DIR_NAME), String.valueOf(System.currentTimeMillis()));
        MeetingRecorderService.setListener(listener);
        Intent intent = new Intent(getContext(), MeetingRecorderService.class);
        intent.setAction(MeetingRecorderService.ACTION_START);
        intent.putExtra(MeetingRecorderService.EXTRA_DIR, dir.getAbsolutePath());
        intent.putExtra(MeetingRecorderService.EXTRA_SEGMENT_MS, segmentMs);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
        } catch (Exception error) {
            MeetingRecorderService.setListener(null);
            // 起不来就如实说,由网页原样显示并**退回 WebView 那条**(它锁屏会停,界面上会说清楚)。
            call.reject("后台录音起不来:" + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
            return;
        }
        JSObject result = new JSObject();
        result.put("dir", dir.getAbsolutePath());
        call.resolve(result);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        send(MeetingRecorderService.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        send(MeetingRecorderService.ACTION_RESUME);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        send(MeetingRecorderService.ACTION_STOP);
        // 监听器**不在这儿摘**:最后一段是 stop 触发的,摘早了那一段就没人收。
        // 网页那一侧 stop() 之后会把两条监听都 remove 掉(Capacitor 那层的事),这里只留服务的静态引用,
        // 下一次 start / load 会把它换成新的。
        call.resolve();
    }

    @PluginMethod
    public void level(PluginCall call) {
        JSObject result = new JSObject();
        result.put("level", MeetingRecorderService.currentLevel());
        call.resolve(result);
    }

    private void send(String action) {
        Intent intent = new Intent(getContext(), MeetingRecorderService.class);
        intent.setAction(action);
        try {
            getContext().startService(intent);
        } catch (Exception ignored) {
            // 服务已经没了:那就是已经停了,不用再说一遍。
        }
    }
}
