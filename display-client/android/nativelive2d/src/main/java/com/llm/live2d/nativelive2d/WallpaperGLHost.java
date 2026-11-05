package com.llm.live2d.nativelive2d;

import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.SurfaceHolder;

/**
 * 动态壁纸的 GL 宿主：{@code WallpaperService.Engine} 只提供 SurfaceHolder、没有 View 树，
 * 因此 {@link android.opengl.GLSurfaceView} 帮我们做的那套 EGL 初始化 + 渲染线程必须自管。
 *
 * <p><b>与 {@link NativeLive2DView} 的一致性</b>：EGL 配置刻意保持相同（RGBA 8888 / depth 16 /
 * GLES2），否则同一个 {@link NativeLive2DRenderer} 在两种宿主下渲染结果会不一致。
 *
 * <p><b>一处有意差异</b>：壁纸是合成的最底层，透明处只会显示黑色，不存在「透出下层窗口」的场景，
 * 故不设 TRANSLUCENT、clear alpha 固定 1，由背景色/背景图铺满。
 *
 * <p><b>★渲染循环为什么不能用 postDelayed 控帧</b>：{@link NativeLive2DRenderer#onDrawFrame} 末尾
 * 会 {@code Thread.sleep()} 睡满帧预算来节流（为 GLSurfaceView 的 RENDERMODE_CONTINUOUSLY 设计）。
 * 若这里再 postDelayed(1000/fps)，两层节流会叠成双倍间隔、实际帧率减半。所以本类连续投递、
 * 不加 delay，帧率单点由 {@code renderer.setTargetFps} 控制——与现有三个宿主完全同一套逻辑。
 *
 * <p>线程约定：所有 EGL 与 GL 操作都在内部渲染线程；公开方法可任意线程调用，内部自行投递。
 */
public final class WallpaperGLHost implements Live2DGLHost {

    private static final String TAG = "NativeLive2D";

    private final NativeLive2DRenderer renderer;
    private final HandlerThread thread;
    private final Handler handler;

    private EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;
    private EGLConfig eglConfig;

    // ★可见性是两个正交维度，不能合并（合并会导致 pauseIfVisible 打掉可见性、
    // resumeIfVisible 再也恢复不了——View 宿主靠 visibility 与 onPause 两套状态天然分开）：
    /** 用户意图的显示状态，由 Controller 的 hide()/show() 驱动。 */
    private volatile boolean hostVisible;
    /** 宿主生命周期状态，由 Controller 的 pauseIfVisible()/resumeIfVisible() 驱动（壁纸即 Engine 可见性）。 */
    private volatile boolean hostResumed = true;

    /** 渲染循环是否已在排队，防重复投递把队列灌爆。仅渲染线程访问。 */
    private boolean loopScheduled;
    /** surface 尺寸已就绪，未就绪时不画。仅渲染线程访问。 */
    private boolean surfaceReady;

    private final Runnable frameTask = new Runnable() {
        @Override
        public void run() {
            loopScheduled = false;
            if (!shouldRender()) return;
            drawOneFrame();
            scheduleLoop();
        }
    };

    private boolean shouldRender() {
        return surfaceReady && hostVisible && hostResumed;
    }

    /** 包内构造：只由 {@link NativeLive2DController#attachToSurfaceHolder()} 创建。 */
    WallpaperGLHost(NativeLive2DRenderer renderer) {
        this.renderer = renderer;
        this.thread = new HandlerThread("Live2DWallpaperGL");
        this.thread.start();
        this.handler = new Handler(this.thread.getLooper());
    }

    // ---- 由 WallpaperService.Engine 驱动 ----

    /** Engine.onSurfaceCreated：建 EGL（首次）或仅重建窗口 surface（上下文仍在）。 */
    public void onEngineSurfaceCreated(SurfaceHolder holder) {
        handler.post(() -> {
            boolean contextExisted = eglContext != EGL14.EGL_NO_CONTEXT;
            if (!contextExisted && !initEgl()) return;
            if (!createWindowSurface(holder)) return;

            // 上下文是新建的才走 onSurfaceCreated——它内部会丢弃并重建 shader/纹理，
            // 上下文仍在时重复调用等于白白重传纹理（记忆里量级到过 80MB）。
            if (!contextExisted) {
                renderer.onSurfaceCreated(null, null);
            }
        });
    }

    /** Engine.onSurfaceChanged */
    public void onEngineSurfaceChanged(int width, int height) {
        handler.post(() -> {
            if (eglSurface == EGL14.EGL_NO_SURFACE) return;
            renderer.onSurfaceChanged(null, width, height);
            surfaceReady = width > 0 && height > 0;
            scheduleLoop();
        });
    }

    /** Engine.onSurfaceDestroyed：只拆窗口 surface，保住上下文，避免回来重传全部纹理。 */
    public void onEngineSurfaceDestroyed() {
        handler.post(() -> {
            surfaceReady = false;
            destroyWindowSurface();
        });
    }

    // ---- Live2DGLHost ----

    @Override
    public void queueEvent(Runnable r) {
        if (r != null) handler.post(r);
    }

    @Override
    public NativeLive2DRenderer getLive2DRenderer() {
        return renderer;
    }

    @Override
    public void setHostVisible(boolean visible) {
        hostVisible = visible;
        handler.post(this::scheduleLoop);
    }

    @Override
    public boolean isHostVisible() {
        return hostVisible;
    }

    /**
     * ★功耗闸门：壁纸在用户打开任何 app 时都不可见，此时照跑纯属白烧电。
     * 可见性为 true 的场景恰好只有桌面与锁屏——正是目标场景。
     */
    @Override
    public void onHostPause() {
        hostResumed = false;
        // 不投递 scheduleLoop：循环体自己会在下一帧检查 shouldRender() 后自然停住。
    }

    @Override
    public void onHostResume() {
        hostResumed = true;
        handler.post(this::scheduleLoop);
    }

    @Override
    public void detachFromHost() {
        handler.post(() -> {
            surfaceReady = false;
            hostVisible = false;
            hostResumed = false;
            destroyWindowSurface();
            releaseEgl();
            thread.quitSafely();
        });
    }

    // ---- 内部 ----

    /** 仅渲染线程调用。 */
    private void scheduleLoop() {
        if (loopScheduled || !shouldRender()) return;
        loopScheduled = true;
        handler.post(frameTask); // 不加 delay，见类注释
    }

    private void drawOneFrame() {
        if (eglSurface == EGL14.EGL_NO_SURFACE) return;
        renderer.onDrawFrame(null);
        if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) {
            int err = EGL14.eglGetError();
            Log.w(TAG, "eglSwapBuffers failed: 0x" + Integer.toHexString(err));
            // surface 已失效（壁纸被系统回收窗口）：拆掉等 Engine 重新给 holder，别死循环刷错。
            if (err == EGL14.EGL_BAD_SURFACE || err == EGL14.EGL_BAD_NATIVE_WINDOW) {
                surfaceReady = false;
                destroyWindowSurface();
            }
        }
    }

    private boolean initEgl() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) {
            Log.e(TAG, "eglGetDisplay failed");
            return false;
        }
        int[] version = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) {
            Log.e(TAG, "eglInitialize failed");
            eglDisplay = EGL14.EGL_NO_DISPLAY;
            return false;
        }

        // 与 NativeLive2DView.setEGLConfigChooser(8,8,8,8,16,0) 严格对齐
        int[] attribs = {
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_DEPTH_SIZE, 16,
            EGL14.EGL_STENCIL_SIZE, 0,
            EGL14.EGL_NONE,
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] numConfigs = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, attribs, 0, configs, 0, 1, numConfigs, 0)
            || numConfigs[0] <= 0) {
            Log.e(TAG, "eglChooseConfig failed");
            releaseEgl();
            return false;
        }
        eglConfig = configs[0];

        int[] ctxAttribs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
        eglContext = EGL14.eglCreateContext(
            eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT, ctxAttribs, 0);
        if (eglContext == EGL14.EGL_NO_CONTEXT) {
            Log.e(TAG, "eglCreateContext failed: 0x" + Integer.toHexString(EGL14.eglGetError()));
            releaseEgl();
            return false;
        }
        Log.i(TAG, "wallpaper EGL initialized (GLES2, RGBA8888, depth16)");
        return true;
    }

    private boolean createWindowSurface(SurfaceHolder holder) {
        destroyWindowSurface();
        if (holder == null || holder.getSurface() == null || !holder.getSurface().isValid()) {
            Log.w(TAG, "surface holder not usable yet");
            return false;
        }
        try {
            eglSurface = EGL14.eglCreateWindowSurface(
                eglDisplay, eglConfig, holder.getSurface(), new int[]{EGL14.EGL_NONE}, 0);
        } catch (Throwable t) {
            Log.e(TAG, "eglCreateWindowSurface threw", t);
            eglSurface = EGL14.EGL_NO_SURFACE;
            return false;
        }
        if (eglSurface == EGL14.EGL_NO_SURFACE) {
            Log.e(TAG, "eglCreateWindowSurface failed: 0x" + Integer.toHexString(EGL14.eglGetError()));
            return false;
        }
        if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
            Log.e(TAG, "eglMakeCurrent failed: 0x" + Integer.toHexString(EGL14.eglGetError()));
            destroyWindowSurface();
            return false;
        }
        return true;
    }

    private void destroyWindowSurface() {
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) return;
        if (eglSurface != EGL14.EGL_NO_SURFACE) {
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE,
                EGL14.EGL_NO_CONTEXT);
            EGL14.eglDestroySurface(eglDisplay, eglSurface);
            eglSurface = EGL14.EGL_NO_SURFACE;
        }
    }

    private void releaseEgl() {
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) return;
        destroyWindowSurface();
        if (eglContext != EGL14.EGL_NO_CONTEXT) {
            EGL14.eglDestroyContext(eglDisplay, eglContext);
            eglContext = EGL14.EGL_NO_CONTEXT;
        }
        EGL14.eglReleaseThread();
        EGL14.eglTerminate(eglDisplay);
        eglDisplay = EGL14.EGL_NO_DISPLAY;
        eglConfig = null;
        Log.i(TAG, "wallpaper EGL released");
    }
}
