package com.llm.live2d.nativelive2d;

import java.util.ArrayDeque;

/**
 * 将必须持有当前 EGL 上下文的工作延后到 {@code onSurfaceCreated} 完成之后。
 *
 * <p>所有方法都只能由同一个 GL 线程调用，所以不需要同步；控制器会先通过宿主的
 * {@code queueEvent} 切到该线程。这样 GLSurfaceView 在线程刚建立、但 EGL 尚未可用时
 * 提前处理的事件，不会错误地编译 shader 或上传纹理。
 */
final class GlContextWorkQueue {
    private final ArrayDeque<Runnable> pending = new ArrayDeque<>();
    private boolean ready;

    void enqueue(Runnable work) {
        if (ready) {
            work.run();
        } else {
            pending.addLast(work);
        }
    }

    void markNotReady() {
        ready = false;
    }

    void markReady() {
        ready = true;
        while (!pending.isEmpty()) {
            pending.removeFirst().run();
        }
    }
}
