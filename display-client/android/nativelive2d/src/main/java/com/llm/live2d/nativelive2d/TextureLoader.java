package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 纹理管理（= Sample LAppTextureManager）：assets PNG → GL 纹理，乘算 alpha + mipmap。
 * 全部方法只能在 GL 线程调用。GL 上下文重建后调 releaseAll() 使缓存失效。
 */
final class TextureLoader {
    private static final String TAG = "NativeLive2D";

    static final class TextureInfo {
        int id;
        int width;
        int height;
        String filePath;
    }

    private final Context context;
    private final List<TextureInfo> textures = new ArrayList<>();

    TextureLoader(Context context) {
        this.context = context.getApplicationContext();
    }

    TextureInfo createTextureFromAsset(String filePath) {
        for (TextureInfo info : textures) {
            if (info.filePath.equals(filePath)) return info;
        }

        Bitmap bitmap = null;
        try (InputStream stream = AssetLoader.openStream(context, filePath)) {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inPremultiplied = true; // 渲染器按乘算 alpha 处理（isPremultipliedAlpha(true)）
            bitmap = BitmapFactory.decodeStream(stream, null, options);
        } catch (IOException e) {
            Log.w(TAG, "texture asset open failed: " + filePath, e);
        }
        if (bitmap == null) return null;

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        int[] textureId = new int[1];
        GLES20.glGenTextures(1, textureId, 0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId[0]);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR_MIPMAP_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);

        TextureInfo info = new TextureInfo();
        info.filePath = filePath;
        info.width = bitmap.getWidth();
        info.height = bitmap.getHeight();
        info.id = textureId[0];
        textures.add(info);

        bitmap.recycle(); // 立即释放解码内存（1GB 机峰值敏感）

        return info;
    }

    /** GL 上下文丢失重建后调用：旧纹理 id 已随上下文失效，只清缓存记录。 */
    void releaseAll() {
        textures.clear();
    }
}
