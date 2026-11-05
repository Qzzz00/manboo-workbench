package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 模型资源读字节（等价 Sample 的 LAppPal.loadFileAsBytes，但持 Context 而非单例 Activity）。
 * 路径以 '/' 开头视为文件系统绝对路径（服务端下载到 filesDir 的角色包），否则读 APK assets。
 */
final class AssetLoader {
    private static final String TAG = "NativeLive2D";

    private AssetLoader() {}

    /** 打开资源流：'/' 前缀走文件系统，其余走 assets。调用方负责关闭。 */
    static InputStream openStream(Context context, String path) throws IOException {
        if (path != null && path.startsWith("/")) {
            return new FileInputStream(path);
        }
        return context.getAssets().open(path);
    }

    static byte[] loadBytes(Context context, String path) {
        try (InputStream in = openStream(context, path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(in.available(), 32 * 1024));
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) {
                out.write(chunk, 0, n);
            }
            return out.toByteArray();
        } catch (IOException e) {
            Log.w(TAG, "asset read failed: " + path, e);
            return new byte[0];
        }
    }
}
