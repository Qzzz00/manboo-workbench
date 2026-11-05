package com.llm.live2d

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 桌面组件帧存储：filesDir/widgetFrames/<avatarId>/<loopKey>/NNN.png + meta.json。
 * meta.json: {"avatarId":"...","activeLoop":"...","fps":12,"frames":48}
 * 全部方法防崩：任何异常回 null/空，绝不让 provider 崩桌面。
 */
object WidgetFrameStore {

    private fun rootDir(ctx: Context) = File(ctx.filesDir, "widgetFrames")

    fun metaFile(ctx: Context) = File(rootDir(ctx), "meta.json")

    fun loopDir(ctx: Context, avatarId: String, loopKey: String) =
        File(rootDir(ctx), "$avatarId/$loopKey")

    fun readMeta(ctx: Context): JSONObject? = try {
        val f = metaFile(ctx)
        if (f.exists()) JSONObject(f.readText()) else null
    } catch (_: Throwable) {
        null
    }

    fun writeMeta(ctx: Context, avatarId: String, activeLoop: String, fps: Int, frames: Int) {
        try {
            rootDir(ctx).mkdirs()
            val o = JSONObject()
            o.put("avatarId", avatarId)
            o.put("activeLoop", activeLoop)
            o.put("fps", fps.coerceIn(1, 30))
            o.put("frames", frames)
            metaFile(ctx).writeText(o.toString())
        } catch (_: Throwable) {
            // 写失败：下次 readMeta 为 null → placeholder
        }
    }

    /** 当前 active 环的帧（RGB_565）+ fps。预算超限时隔帧降采。取不到返回 null。 */
    fun loadActiveFrames(ctx: Context): Pair<List<Bitmap>, Int>? {
        try {
            val meta = readMeta(ctx) ?: return null
            val avatarId = meta.optString("avatarId")
            val loopKey = meta.optString("activeLoop")
            var fps = meta.optInt("fps", 12).coerceIn(1, 30)
            if (avatarId.isEmpty() || loopKey.isEmpty()) return null
            val dir = loopDir(ctx, avatarId, loopKey)
            var files = dir.listFiles { f -> f.isFile && f.name.endsWith(".png") }
                ?.sortedBy { it.name } ?: return null
            if (files.isEmpty()) return null

            // 预算：RemoteViews 位图上限 ≈ 屏幕像素×4×1.5；留 15% 余量。超则隔帧+fps 减半。
            val dm = ctx.resources.displayMetrics
            val budget = (dm.widthPixels.toLong() * dm.heightPixels * 4 * 3 / 2 * 85 / 100)
            val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 }
            val probe = BitmapFactory.decodeFile(files[0].absolutePath, opts) ?: return null
            val perFrame = probe.byteCount.toLong()
            var stride = 1
            while (files.size / stride * perFrame > budget && stride < 8) stride *= 2
            if (stride > 1) {
                files = files.filterIndexed { i, _ -> i % stride == 0 }
                fps = (fps / stride).coerceAtLeast(1)
            }

            val frames = ArrayList<Bitmap>(files.size)
            frames.add(probe)
            for (i in 1 until files.size) {
                val b = BitmapFactory.decodeFile(files[i].absolutePath, opts) ?: continue
                frames.add(b)
            }
            if (frames.isEmpty()) return null
            return Pair(frames, fps)
        } catch (_: Throwable) {
            return null
        }
    }

    /** 某角色已烤的环列表：[{key, frames, fps}]（fps 取 meta 全局值）。 */
    fun listLoops(ctx: Context, avatarId: String): JSONArray {
        val arr = JSONArray()
        try {
            val fps = readMeta(ctx)?.optInt("fps", 12) ?: 12
            val dir = File(rootDir(ctx), avatarId)
            dir.listFiles { f -> f.isDirectory }?.sortedBy { it.name }?.forEach { d ->
                val n = d.listFiles { f -> f.isFile && f.name.endsWith(".png") }?.size ?: 0
                if (n > 0) {
                    val o = JSONObject()
                    o.put("key", d.name)
                    o.put("frames", n)
                    o.put("fps", fps)
                    arr.put(o)
                }
            }
        } catch (_: Throwable) {
            // 空数组
        }
        return arr
    }
}
