package com.llm.live2d.nativelive2d;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.webkit.WebView;

import androidx.coordinatorlayout.widget.CoordinatorLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

/**
 * 低端机原生 Live2D 渲染层（Capacitor 桥，主 App 宿主）。
 *
 * 架构：透明 WebView（React UI 照常）下面垫一层 GLSurfaceView 跑 Cubism（关物理）。
 * JS 是大脑：表情拍平/构图数学都在 JS（与 WebView 渲染同一份逻辑）。
 * 渲染编排在宿主无关的 {@link NativeLive2DController}（与充电屏保 DreamService 共用）；
 * 本类只做 Capacitor 参数转换 + 主 App 特有的「WebView/窗口透明」。
 */
@CapacitorPlugin(name = "NativeLive2D")
public class NativeLive2DPlugin extends Plugin {
    private NativeLive2DController controller;

    private NativeLive2DController controller() {
        if (controller == null) controller = new NativeLive2DController(getContext());
        return controller;
    }

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("coreLoaded", controller().isCoreAvailable());
        result.put("layerActive", controller().isAttached());
        call.resolve(result);
    }

    /** UI 线程建 GL 层。首屏阶段暂不透明化 WebView，确保 Android 12 能立即交付掌机前景。 */
    private void ensureLayerOnUiThread() {
        NativeLive2DController c = controller();
        if (c.isAttached()) return;
        Activity activity = getActivity();
        WebView webView = getBridge().getWebView();
        if (activity == null || webView == null) return;

        ViewGroup parent = (ViewGroup) webView.getParent();
        // 高度锁为父容器当前全高，不用 MATCH_PARENT：键盘弹出时父容器被 adjustResize 压小，
        // GL surface 跟着缩会让角色等比压缩、SurfaceView 缩放重建还会闪黑。
        // 锁全高后键盘直接盖在 GL 层上（与 WebView 渲染路径的观感一致）。
        ViewGroup.LayoutParams params = parent instanceof CoordinatorLayout
            ? new CoordinatorLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, parent.getHeight())
            : new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, parent.getHeight());
        c.attachUnderOnUiThread(parent, 0, params);
        keepGlLayerFullHeight(parent);
    }

    /** 模型已有首帧后再执行穿透三件套的宿主侧两件，避免启动屏等待 GL。 */
    private void makeStageTransparentOnUiThread() {
        Activity activity = getActivity();
        WebView webView = getBridge().getWebView();
        if (activity == null || webView == null) return;
        activity.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        webView.setBackgroundColor(Color.TRANSPARENT);
    }

    /** 键盘只会把父容器压小：GL 高度只增不减；宽度变化（转屏）则以新父容器尺寸重锁。 */
    private void keepGlLayerFullHeight(final ViewGroup parent) {
        parent.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
            private int lastWidth = parent.getWidth();

            @Override
            public void onGlobalLayout() {
                Live2DGLHost host = controller().getHost();
                if (!(host instanceof View)) return;
                View gl = (View) host;
                int h = parent.getHeight();
                ViewGroup.LayoutParams lp = gl.getLayoutParams();
                if (lp == null) return;
                if (h > lp.height || parent.getWidth() != lastWidth) {
                    lastWidth = parent.getWidth();
                    lp.height = h;
                    gl.setLayoutParams(lp);
                }
            }
        });
    }

    @PluginMethod
    public void showModel(PluginCall call) {
        NativeLive2DController c = controller();
        if (!c.isCoreAvailable()) {
            call.reject("cubism core unavailable on this device", "CORE_UNAVAILABLE");
            return;
        }
        c.runOnUi(() -> {
            ensureLayerOnUiThread();
            c.showModel(call.getData(), (result, error) -> {
                if (result == null) {
                    call.reject(error != null ? error : "showModel failed");
                    return;
                }
                // 首帧回调来自 GL 线程。先回主线程切透明，再通知 WebView 收起自己的不透明首页底，
                // 避免 Android 12 启动屏只能等到 GLSurfaceView 出帧才退出。
                c.runOnUi(() -> {
                    makeStageTransparentOnUiThread();
                    try {
                        call.resolve(JSObject.fromJSONObject(result));
                    } catch (JSONException e) {
                        call.reject("result serialization failed: " + e.getMessage());
                    }
                });
            });
        });
    }

    @PluginMethod
    public void releaseModel(PluginCall call) {
        controller().releaseModel();
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        controller().hideAfterPause(call::resolve);
    }

    @PluginMethod
    public void show(PluginCall call) {
        controller().showAfterFrame(call.getLong("lifecycleTraceId"), null, call::resolve);
    }

    @PluginMethod
    public void setOverlayTargets(PluginCall call) {
        controller().setOverlayTargets(call.getObject("params"));
        call.resolve();
    }

    @PluginMethod
    public void setPersistentParams(PluginCall call) {
        controller().setPersistentParams(call.getObject("params"));
        call.resolve();
    }

    @PluginMethod
    public void setMouthParams(PluginCall call) {
        controller().setMouthParams(call.getObject("params"));
        call.resolve();
    }

    @PluginMethod
    public void playMotion(PluginCall call) {
        controller().playMotion(call.getString("group"));
        call.resolve();
    }

    @PluginMethod
    public void setFocus(PluginCall call) {
        controller().setFocus(
            (float) call.getDouble("x", 0.0).doubleValue(),
            (float) call.getDouble("y", 0.0).doubleValue());
        call.resolve();
    }

    @PluginMethod
    public void setLayout(PluginCall call) {
        controller().setLayout(call.getData());
        call.resolve();
    }

    @PluginMethod
    public void setBottomFade(PluginCall call) {
        controller().setBottomFade(call.getData());
        call.resolve();
    }

    @PluginMethod
    public void setBackground(PluginCall call) {
        controller().setBackground(call.getData());
        call.resolve();
    }

    @PluginMethod
    public void setBackgroundParallax(PluginCall call) {
        controller().setBackgroundParallax(
            (float) call.getDouble("x", 0.0).doubleValue(),
            (float) call.getDouble("y", 0.0).doubleValue());
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        if (controller != null) controller.pauseIfVisible();
    }

    @Override
    protected void handleOnResume() {
        if (controller != null) controller.resumeIfVisible();
    }
}
