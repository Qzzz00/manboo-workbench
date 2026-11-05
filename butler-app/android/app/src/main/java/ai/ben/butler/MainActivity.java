package ai.ben.butler;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 自己那一件插件要在 super.onCreate 之前登记(2026-09-18):Bridge 是在 super 里搭起来的,
     * 搭完之后再 registerPlugin,网页那边就查不到它 —— `MicPermission.check()` 会以
     * 「没这个实现」收场,于是又回到「没人去要录音权限」那个老毛病。
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MicPermissionPlugin.class);
        // 座机(2026-09-21):常亮 / 不锁屏 / 后台与锁屏时把来电页拉起来。同一条规矩 —— 必须在 super 之前。
        registerPlugin(DeskPhonePlugin.class);
        // 会议录音(2026-09-21):同一条规矩,**在 super.onCreate 之前**登记。
        registerPlugin(MeetingRecorderPlugin.class);
        // 打开 / 分享电脑发来的文件(2026-09-25,卡 J)。同一条规矩,**在 super.onCreate 之前**登记。
        registerPlugin(FileOpenerPlugin.class);
        // 在 App 里下载并装上新手机包(2026-10-03)。同一条规矩,**在 super.onCreate 之前**登记 ——
        // 登记晚了,设置里那颗「下载并安装」按下去会以「没这个实现」收场,又回到跳官网那条路。
        registerPlugin(ApkUpdatePlugin.class);
        // 在家 / 出门(2026-10-21,局域网 M4):网络回调与本地网络权限。同一条规矩,**在 super.onCreate 之前**登记 ——
        // 登记晚了网页那边以「没这个实现」收场,只剩浏览器那两样事件,网络标识一律读不到(一直按出门走)。
        registerPlugin(NetworkWatchPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
