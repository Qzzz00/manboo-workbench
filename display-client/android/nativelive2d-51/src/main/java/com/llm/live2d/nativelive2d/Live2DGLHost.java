package com.llm.live2d.nativelive2d;

/**
 * GL 宿主抽象：把 {@link NativeLive2DController} 与「GL 层具体挂在哪」解耦。
 *
 * <p>两种实现：
 * <ul>
 *   <li>{@link NativeLive2DView}（GLSurfaceView）——主 App / 屏保 / 悬浮窗，GL 层活在 View 树里；
 *   <li>{@link WallpaperGLHost}——动态壁纸，{@code WallpaperService.Engine} 只给 SurfaceHolder，
 *       没有 View 树，EGL 与渲染线程全部自管。
 * </ul>
 *
 * <p>Controller 只需要四类能力：投递 GL 线程、拿 renderer、开关可见性、脱离宿主。
 */
public interface Live2DGLHost {

    /** 把操作投递到 GL 线程执行（模型加载、动作起播、卸模型都必须在 GL 线程）。 */
    void queueEvent(Runnable r);

    /** 取渲染器。参数类 setter（setLayout/setBottomFade/setBackground）由 renderer 内部保证线程安全。 */
    NativeLive2DRenderer getLive2DRenderer();

    /**
     * 设置宿主可见性。View 实现映射到 VISIBLE/GONE；壁纸实现映射到渲染循环启停。
     * 语义是「该不该出画面」，不是「窗口在不在」。
     */
    void setHostVisible(boolean visible);

    boolean isHostVisible();

    /** 宿主暂停（Activity onPause / Dream stopped / 壁纸不可见）：停渲染线程，保留 EGL 上下文。 */
    void onHostPause();

    void onHostResume();

    /**
     * 从宿主脱离。View 实现＝从父 ViewGroup 移除；壁纸实现＝销毁 EGL（壁纸没有父容器）。
     * 由 {@link NativeLive2DController#destroy()} 在主线程调用。
     */
    void detachFromHost();
}
