package ai.ben.butler;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * 手机此刻在哪个网络上(2026-10-21,局域网 M4)。网页那一侧是 src/channel/networkWatch.ts,路线驱动靠它判在家 / 出门。
 *
 * <ul>
 *   <li>{@code current()}:此刻的缺省网络 —— 类型(wifi / ethernet / cellular / none)、标识(见 {@link NetworkId})、
 *       给人看的名字、本地网络权限;</li>
 *   <li>{@code change} 事件:{@code ConnectivityManager} 的缺省网络回调,Wi-Fi 换了、切到 4G、断网当场来一声
 *       (攒 300 毫秒再报,切网时回调会连着来好几下);</li>
 *   <li>{@code requestLocalNetwork()}:Android 17(SDK 37)的 {@code ACCESS_LOCAL_NETWORK}。没有它,连局域网地址一律失败。</li>
 * </ul>
 *
 * <p><b>本地网络权限怎么要</b>:读到 {@code granted} 就不要;读到「还要问」才走系统那一套。manifest 写上这一条之后,
 * targetSdk 36 的包在 Android 17 上就没有兼容那一份了(10-22 真机:{@code granted=false}),所以会去要 —— 那台手机上系统当场给了、没弹框。
 * 拒了网页那边按出门走,设置页写去哪儿打开。
 * Android 17 以前没有这一条,回 {@code not_needed}。
 */
@CapacitorPlugin(
    name = "NetworkWatch",
    permissions = { @Permission(alias = NetworkWatchPlugin.LOCAL, strings = { NetworkWatchPlugin.ACCESS_LOCAL_NETWORK }) }
)
public class NetworkWatchPlugin extends Plugin {

    static final String LOCAL = "localNetwork";
    /** SDK 37 才有的权限;编译用的 SDK 36 里没有这个常量,写字面量。 */
    static final String ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK";
    /** Android 17 的 API 级别(编译用的 SDK 36 里没有 VERSION_CODES 常量)。 */
    static final int SDK_LOCAL_NETWORK = 37;
    private static final String TAG = "NetworkWatch";
    private static final long SETTLE_MS = 300;

    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable report = () -> {
        JSObject reading = read();
        Log.i(TAG, "change kind=" + reading.getString("kind") + " id=" + reading.getString("id"));
        notifyListeners("change", reading);
    };

    @Override
    public void load() {
        connectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return;
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { schedule(); }
            @Override public void onLost(Network network) { schedule(); }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { schedule(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties props) { schedule(); }
        };
        try {
            connectivity.registerDefaultNetworkCallback(callback);
        } catch (RuntimeException e) {
            // 回调登记不上(极少见):网页那边还有 online / connection.change 两样兜底。
            Log.w(TAG, "registerDefaultNetworkCallback failed", e);
            callback = null;
        }
    }

    private void schedule() {
        main.removeCallbacks(report);
        main.postDelayed(report, SETTLE_MS);
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacks(report);
        if (connectivity != null && callback != null) {
            try { connectivity.unregisterNetworkCallback(callback); } catch (RuntimeException ignored) { /* 已经撤了 */ }
        }
        callback = null;
    }

    /** 此刻的缺省网络。读不到的格子不放。 */
    private JSObject read() {
        JSObject out = new JSObject();
        out.put("local", localState());
        Network network = connectivity == null ? null : connectivity.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : connectivity.getNetworkCapabilities(network);
        String kind = "none";
        if (caps != null) {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) kind = "wifi";
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) kind = "ethernet";
            // 只剩 VPN(底下是什么看不出):当移动网络,按出门走。
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) kind = "cellular";
        }
        out.put("kind", kind);
        if (!kind.equals("wifi") && !kind.equals("ethernet")) return out;
        LinkProperties props = connectivity.getLinkProperties(network);
        if (props == null) return out;
        String gateway = null;
        for (RouteInfo route : props.getRoutes()) {
            InetAddress gw = route.getGateway();
            if (route.isDefaultRoute() && gw instanceof Inet4Address && !gw.isAnyLocalAddress()) { gateway = gw.getHostAddress(); break; }
        }
        Integer prefix = null;
        for (LinkAddress address : props.getLinkAddresses()) {
            if (address.getAddress() instanceof Inet4Address) { prefix = address.getPrefixLength(); break; }
        }
        String id = NetworkId.INSTANCE.of(gateway, prefix, props.getDomains());
        if (id != null) out.put("id", id);
        String label = NetworkId.INSTANCE.label(gateway);
        if (label != null) out.put("label", label);
        return out;
    }

    /** granted / denied / prompt;Android 17 以前没有这一条:not_needed。 */
    private String localState() {
        if (Build.VERSION.SDK_INT < SDK_LOCAL_NETWORK) return "not_needed";
        PermissionState state = getPermissionState(LOCAL);
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    @PluginMethod
    public void current(PluginCall call) {
        call.resolve(read());
    }

    @PluginMethod
    public void requestLocalNetwork(PluginCall call) {
        String state = localState();
        if (!state.equals("prompt")) {
            JSObject out = new JSObject();
            out.put("local", state);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias(LOCAL, call, "localNetworkAnswered");
    }

    @PermissionCallback
    private void localNetworkAnswered(PluginCall call) {
        JSObject out = new JSObject();
        out.put("local", localState());
        Log.i(TAG, "local network permission → " + out.getString("local"));
        call.resolve(out);
    }
}
