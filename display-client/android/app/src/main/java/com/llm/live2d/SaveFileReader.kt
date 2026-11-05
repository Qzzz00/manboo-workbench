package com.llm.live2d

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 在磁盘上找玩家的 RetroArch 存档（.srm）并读回来。
 *
 * 分工：**候选路径由 JS 侧算好**（src/lib/strategist/saveFile.ts，那边有单测），
 * 这里只做笨活——按清单找、挑 mtime 最新的那个、读出来。
 * 之所以这么分：路径推导是纯逻辑（去扩展名、一个 ROM 两种存档命名），值得单测；
 * 而「哪个目录真的存在」只有真机知道，写死在哪一侧都一样。
 *
 * ★为什么不去读 RetroArch 的配置来定位存档目录：真配置在
 * /storage/emulated/0/Android/data/com.retroarch.aarch64/files/retroarch.cfg，
 * 而 Android 11+ 起别的 App 读不到 Android/data 下别人的目录（File 与 SAF 都不行）。
 * 读不到就承认读不到，在几个常见落点里找；找不到如实回 found:false，
 * 军师那边会退回「没有进度」的老行为，不猜。
 */
object SaveFileReader {
    private const val TAG = "SaveFileReader"

    /** 存档合法大小上限。三代存档是 128KB；给一倍余量，再大就不是存档。 */
    private const val MAX_BYTES = 256 * 1024

    /**
     * @param candidatesJson [{dir, names:[…], scanSubdirs}] —— 见 saveFile.ts 的 SaveCandidate
     * @param sinceMtimeMs   上次已经上传过的那份存档的 mtime；没变就只回 unchanged，
     *                       不搬那 128KB（每次开口问之前都会调一次，白搬没有意义）
     * @return JSON 字符串：
     *   {found:false}
     *   {found:true, unchanged:true, path, mtimeMs, sizeBytes}
     *   {found:true, unchanged:false, path, mtimeMs, sizeBytes, base64}
     *   {found:false, error:"…"}
     */
    fun read(candidatesJson: String, sinceMtimeMs: Long): String {
        return try {
            val newest = findNewest(candidatesJson)
                ?: return JSONObject().put("found", false)
                    // ★找不到时把「每个候选目录到底怎么了」一起报出来。
                    // 掌机是 Ben 的日用机不是测试台，一次真机要把信息取全：
                    // 「目录不存在」（存档在别处）和「目录读不到」（没存储权限）
                    // 是两个完全不同的毛病，只回一句 found:false 就得再跑一趟才分得清。
                    .put("probe", probe(candidatesJson)).toString()

            val out = JSONObject()
                .put("found", true)
                .put("path", newest.absolutePath)
                .put("mtimeMs", newest.lastModified())
                .put("sizeBytes", newest.length())

            if (newest.lastModified() == sinceMtimeMs) {
                return out.put("unchanged", true).toString()
            }
            if (newest.length() > MAX_BYTES) {
                // 找到的东西太大，不是存档。说清楚，别把一坨字节传上去让服务端猜。
                return JSONObject().put("found", false)
                    .put("error", "文件 ${newest.length()} 字节，不像 GBA 存档").toString()
            }
            val bytes = newest.readBytes()
            Log.i(TAG, "读到存档 ${newest.absolutePath}（${bytes.size} 字节）")
            out.put("unchanged", false)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .toString()
        } catch (e: Exception) {
            // 读存档失败绝不能让玩家问不了问题——如实回报，上层静默降级。
            Log.w(TAG, "读存档失败", e)
            JSONObject().put("found", false).put("error", e.message ?: e.javaClass.simpleName).toString()
        }
    }

    /** 每个候选目录的状态，只在没找到存档时附上，供真机一次定位问题。 */
    private fun probe(candidatesJson: String): JSONArray {
        val out = JSONArray()
        val arr = JSONArray(candidatesJson)
        for (i in 0 until arr.length()) {
            val dir = File(arr.getJSONObject(i).getString("dir"))
            val kids = dir.listFiles()
            val state = when {
                !dir.exists() -> "目录不存在"
                // listFiles() 返回 null 而目录存在 = 分区存储把我们挡在外面（没存储权限）
                kids == null -> "读不到（没有存储权限？）"
                else -> "可读，${kids.size} 项"
            }
            out.put(JSONObject().put("dir", dir.absolutePath).put("state", state))
            Log.i(TAG, "候选目录 ${dir.absolutePath}：$state")
        }
        return out
    }

    private fun findNewest(candidatesJson: String): File? {
        val arr = JSONArray(candidatesJson)
        var best: File? = null
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val dir = File(c.getString("dir"))
            val names = c.getJSONArray("names").let { n -> (0 until n.length()).map { n.getString(it) } }
            val dirs = mutableListOf(dir)
            if (c.optBoolean("scanSubdirs")) {
                // 只下探一层：RetroArch 开了 sort_savefiles_enable 时按核心名分目录
                // （saves/mGBA/xxx.srm），核心名不确定就扫一层，不做无限递归。
                dir.listFiles()?.filter { it.isDirectory }?.let { dirs.addAll(it) }
            }
            for (d in dirs) {
                for (n in names) {
                    val f = File(d, n)
                    if (f.isFile && (best == null || f.lastModified() > best!!.lastModified())) best = f
                }
            }
        }
        return best
    }
}
