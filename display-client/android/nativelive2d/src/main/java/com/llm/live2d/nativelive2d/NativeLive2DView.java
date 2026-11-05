package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.graphics.PixelFormat;
import android.opengl.GLSurfaceView;
import android.view.View;
import android.view.ViewGroup;

/**
 * 垫在透明 WebView 之下的 GL 层。默认 z-order 在窗口面之下（SurfaceView 穿透），
 * 上面所有窗口内容（窗口背景/WebView/页面 CSS）透明处即透出本层。
 *
 * <p>实现 {@link Live2DGLHost}：EGL 与渲染线程由 GLSurfaceView 代管，这是 View 树内的宿主形态。
 * 动态壁纸没有 View 树，用 {@link WallpaperGLHost}。
 */
final class NativeLive2DView extends GLSurfaceView implements Live2DGLHost {
    private final NativeLive2DRenderer renderer;

    NativeLive2DView(Context context) {
        this(context, false);
    }

    /**
     * @param transparentOverlay true=悬浮窗透明合成（GL surface 走 media overlay 层参与 alpha 混合，
     *   透明处露出下层窗口，用于 U3 固定浮窗）；false=默认 punch-hole 垫在窗口之下（主App/屏保，GL 在 WebView 之下）。
     */
    NativeLive2DView(Context context, boolean transparentOverlay) {
        super(context);
        setEGLContextClientVersion(2);
        setEGLConfigChooser(8, 8, 8, 8, 16, 0);
        // ★SurfaceHolder 默认 format 不透明——即便 EGL 有 alpha、renderer clear alpha=0，合成仍忽略 alpha 显黑底。
        // 设 TRANSLUCENT 让合成认 alpha：浮窗 clear alpha=0 → 透明；有背景场景 clear alpha=1 → 仍不透明，零影响。
        getHolder().setFormat(PixelFormat.TRANSLUCENT);
        // ★悬浮窗透明关键：default punch-hole 在 overlay window 里被 SurfaceFlinger 合成成黑（不透下层）；
        // media overlay 层让 GL surface 参与 alpha 混合、透明处露出下层窗口。仅浮窗需要——主App/屏保保持
        // default（GL 须在 WebView 之下让 UI 盖在上面），故用参数区分。setZOrder* 必须在 surface 创建(setRenderer)前调。
        if (transparentOverlay) setZOrderMediaOverlay(true);
        // 暂停(手动 onPause/切后台)时尽量保住 EGL 上下文，避免回前台重传 80MB 纹理
        setPreserveEGLContextOnPause(true);
        renderer = new NativeLive2DRenderer(context);
        setRenderer(renderer);
        setRenderMode(RENDERMODE_CONTINUOUSLY);
    }

    @Override
    public NativeLive2DRenderer getLive2DRenderer() {
        return renderer;
    }

    // ---- Live2DGLHost ----
    // queueEvent(Runnable) 由 GLSurfaceView 直接提供，已满足接口。

    @Override
    public void setHostVisible(boolean visible) {
        setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    @Override
    public boolean isHostVisible() {
        return getVisibility() == View.VISIBLE;
    }

    @Override
    public void onHostPause() {
        onPause();
    }

    @Override
    public void onHostResume() {
        onResume();
    }

    @Override
    public void detachFromHost() {
        ViewGroup parent = (ViewGroup) getParent();
        if (parent != null) parent.removeView(this);
    }
}
