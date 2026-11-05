package com.llm.live2d.nativelive2d;

/** Fixed, content-free lifecycle log formatter shared by Android hosts. */
public final class LifecycleTraceFormatter {
    private LifecycleTraceFormatter() {}

    public static String format(String prefix, long id, String phase, long elapsedMs) {
        return prefix + " id=" + id + " phase=" + phase
            + " elapsed=" + Math.max(0L, elapsedMs) + "ms";
    }
}
