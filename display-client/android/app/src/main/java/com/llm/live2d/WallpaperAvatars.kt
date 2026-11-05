package com.llm.live2d

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * 动态壁纸的模型元数据来源。
 *
 * 壁纸是纯原生、没有 WebView，拿不到 `avatarData.ts` 里的角色清单；而模型的 model3.json
 * **自身不带任何 Motions 组与 Expressions**（实测 ghostpuppy/tororo/hijiki 皆为空），
 * 动作全靠 `createAugmentedSettings` 在 JS 侧注入。因此壁纸不能直接读 model3.json，
 * 必须读构建期预先烘好的 augmented settings。
 *
 * 索引文件由 `scripts/export-wallpaper-avatars.mjs` 在构建期生成，格式：
 * ```
 * { "<avatarId>": {
 *     "settingsFile": "public/live2D/_wallpaper/<id>.settings.json",
 *     "modelDir":     "public/live2D/<dir>/",
 *     "idleMotionGroup": "idle",
 *     "idleBeatGroups": [],
 *     "layout": { "anchorXFrac":0.5, "bottomYFrac":0.95, "widthFrac":0.9, "heightFrac":0.9 }
 * } }
 * ```
 * 路径前缀 `public/` 与 JS 侧 `assetPathFromUrl()` 的约定一致，AssetLoader 直接可读。
 */
object WallpaperAvatars {

    private const val TAG = "Live2DWallpaper"
    private const val INDEX_ASSET = "public/live2D/_wallpaper/index.json"

    data class Entry(
        val avatarId: String,
        val settingsJson: String,
        val modelDir: String,
        val idleMotionGroup: String?,
        val idleBeatGroups: JSONArray,
        val layout: JSONObject?,
    )

    /**
     * 解析出该用哪个角色。角色 id 取自 [ScreensaverPrefs]（与屏保共用同一套设置）。
     *
     * 缺省策略：prefs 无值、或该 id 在索引里查不到（角色已下线）时，回落到索引第一个条目。
     * 壁纸绝不能因为配置缺失而黑屏——它是常驻显示，黑屏比显示错角色严重得多。
     */
    fun resolve(context: Context): Entry? {
        val index = readJsonAsset(context, INDEX_ASSET)?.let {
            runCatching { JSONObject(it) }.getOrNull()
        } ?: run {
            Log.e(TAG, "wallpaper avatar index missing or unparsable: $INDEX_ASSET")
            return null
        }
        if (index.length() == 0) {
            Log.e(TAG, "wallpaper avatar index is empty")
            return null
        }

        val wanted = ScreensaverPrefs.getScreensaverAvatarId(context)
        val id = when {
            wanted.isNotBlank() && index.has(wanted) -> wanted
            else -> pickFallback(index).also {
                Log.w(TAG, "avatar '$wanted' not in wallpaper index, falling back to '$it'")
            }
        }

        val entry = index.optJSONObject(id) ?: return null
        val settingsFile = entry.optString("settingsFile").takeIf { it.isNotBlank() } ?: run {
            Log.e(TAG, "entry '$id' has no settingsFile")
            return null
        }
        val settings = readJsonAsset(context, settingsFile) ?: run {
            Log.e(TAG, "baked settings missing: $settingsFile (构建期脚本没跑？)")
            return null
        }

        return Entry(
            avatarId = id,
            settingsJson = settings,
            modelDir = entry.optString("modelDir"),
            idleMotionGroup = entry.optString("idleMotionGroup").takeIf { it.isNotBlank() },
            idleBeatGroups = entry.optJSONArray("idleBeatGroups") ?: JSONArray(),
            layout = entry.optJSONObject("layout"),
        )
    }

    /**
     * 回落时优先挑**有 idle 动作组**的角色。
     *
     * 模型自身不带动作，idle 靠清单注入，目前 9 个角色里有 5 个没有匹配 /^idle/i 的组
     * （且索引第一个 yumi 恰好就是其中之一）。选到它们壁纸上就是个静止的木头人——
     * 对常驻显示来说这和坏了没区别。
     */
    private fun pickFallback(index: JSONObject): String {
        val keys = index.keys()
        var first: String? = null
        while (keys.hasNext()) {
            val key = keys.next()
            if (first == null) first = key
            val idle = index.optJSONObject(key)?.optString("idleMotionGroup").orEmpty()
            if (idle.isNotBlank()) return key
        }
        return first ?: ""
    }

    private fun readJsonAsset(context: Context, path: String): String? = runCatching {
        context.assets.open(path).use { it.readBytes().toString(StandardCharsets.UTF_8) }
    }.onFailure { Log.w(TAG, "asset read failed: $path (${it.message})") }.getOrNull()
}
