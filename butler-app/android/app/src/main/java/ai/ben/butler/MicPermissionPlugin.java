package ai.ben.butler;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 录音权限(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
 *
 * <p>为什么要一个原生插件,而不是靠 WebView 自己弹:
 * Capacitor 的 BridgeWebChromeClient 确实会在网页调 getUserMedia 时把
 * RECORD_AUDIO 要一遍,但那是**进房、发布麦克风的那一刻**才发生的——
 * 弹框会压在一通已经接通的电话上,开场白正说到一半。而且一旦被拒过两次,
 * Android 从此不再弹,网页那条路只会拿到一个静默失败:人对着屏幕说话,她听不到,
 * 屏幕上什么都不说。这正是 Ben 看到的样子。
 *
 * <p>所以这里把三件事显式交给网页:
 * <ul>
 *   <li>{@code check()} —— 现在是什么状态(granted / prompt / denied);</li>
 *   <li>{@code request()} —— 现在就问一次(**进房之前**,不压在通话上);</li>
 *   <li>{@code openSettings()} —— 已经被永久拒了,只能去系统设置里开,直接送他到那一页。</li>
 * </ul>
 *
 * <p>三个状态照 Capacitor 的 {@link PermissionState} 口径直说,不合并:
 * {@code prompt} 还问得动,{@code denied} 是「别再问了」——界面上这两句话不一样。
 */
@CapacitorPlugin(
    name = "MicPermission",
    permissions = { @Permission(alias = MicPermissionPlugin.MIC, strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class MicPermissionPlugin extends Plugin {

    static final String MIC = "mic";

    /** 回给网页的那一格。granted / prompt / denied,与 PermissionState 一一对应。 */
    private JSObject stateResult() {
        PermissionState state = getPermissionState(MIC);
        JSObject result = new JSObject();
        result.put("state", state == null ? "prompt" : state.toString());
        result.put("granted", state == PermissionState.GRANTED);
        return result;
    }

    @PluginMethod
    public void check(PluginCall call) {
        call.resolve(stateResult());
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (getPermissionState(MIC) == PermissionState.GRANTED) {
            call.resolve(stateResult());
            return;
        }
        requestPermissionForAlias(MIC, call, "micResult");
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        call.resolve(stateResult());
    }

    /**
     * 打开本应用在系统设置里的那一页。被永久拒之后这是**唯一**的路——
     * 再 request 一次不会弹任何东西,只会立刻回一个 denied。
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null)
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            // 打不开就如实说一句,由网页原样显示——不要静默。
            call.reject("打不开系统设置:" + error.getMessage());
        }
    }
}
