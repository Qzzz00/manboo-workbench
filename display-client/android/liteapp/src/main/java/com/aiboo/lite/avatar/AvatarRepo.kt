package com.aiboo.lite.avatar

import android.content.Context
import android.content.SharedPreferences
import com.aiboo.lite.net.ApiClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** 读 model3.json 文本：'/' 前缀走文件系统（下载角色），否则读 APK assets（内置角色）。 */
fun readModelJson(context: Context, path: String): String =
    if (path.startsWith("/")) {
        File(path).readText()
    } else {
        context.assets.open(path).use { it.readBytes() }.toString(Charsets.UTF_8)
    }

/**
 * 保纵横比构图：以「高度分数 + 底边位置」描述取景，宽度分数按模型画布比例与屏幕
 * 比例换算得出——框的像素纵横比恒等于模型画布纵横比，任何屏幕上角色都不变形。
 * （此前写死 width/heightFrac 各 0.95，在 3:5 矮胖屏上角色被横向压扁。）
 *
 * @param heightFrac 模型整高 = 屏高的多少倍（半身特写 >1，底边溢出屏下方）
 * @param bottomYFrac 模型底边落在屏高的位置（>1 = 屏幕下方之外）
 */
fun aspectFitLayout(
    heightFrac: Double,
    bottomYFrac: Double,
    canvasAspect: Double,   // 模型画布 宽/高
    screenW: Int,
    screenH: Int,
): org.json.JSONObject {
    val safeAspect = if (canvasAspect.isFinite() && canvasAspect > 0) canvasAspect else 0.5
    val widthFrac = heightFrac * safeAspect * screenH.toDouble() / screenW.toDouble().coerceAtLeast(1.0)
    return org.json.JSONObject()
        .put("anchorXFrac", 0.5)
        .put("bottomYFrac", bottomYFrac)
        .put("widthFrac", widthFrac)
        .put("heightFrac", heightFrac)
}

/**
 * 角色仓库：内置角色 + 服务端 catalog/manifest/zip 下载（SHA-256 校验 + 防 zip-slip 解压）。
 *
 * 磁盘布局：filesDir/avatars/<id>/v<N>/ 解压内容 + filesDir/avatars/<id>/local.json
 * （name/version/modelDir/modelJson/personaPrompt，重启后据此列出已下载角色）。
 * 模型路径以 '/' 开头，:nativelive2d AssetLoader 自动走文件系统源。
 */
object AvatarRepo {

    /** 一个可加载的本地角色（内置或已下载）。 */
    data class LocalAvatar(
        val id: String,
        val name: String,
        /** 模型资源目录：assets 相对路径或以 '/' 开头的绝对路径，尾带 '/'。 */
        val modelDir: String,
        /** model3.json 路径（同上两种形态）。 */
        val modelJson: String,
        val personaPrompt: String,
        val builtin: Boolean,
    )

    private const val PREFS = "aiboo_lite_avatar"
    private const val KEY_CURRENT = "current_avatar"

    private const val BUILTIN_PERSONA = """你是「双生」(Shuang Sheng)，一只银发猫耳少女，深粉色眼眸，穿浅粉吊带睡裙。
性格：甜软温柔，像蜷缩在阳光下呼噜的小猫；有猫一样的好奇心，害羞又贪玩，轻声细语。
说话风格：柔美不紧不慢，用温馨意象（毯子、星空、牛奶蜂蜜），像亲昵伙伴深夜闲聊；简短甜蜜，永不严厉冷漠。用中文回复。"""

    val BUILTIN = LocalAvatar(
        id = "shuangsheng",
        name = "双生",
        modelDir = "live2D/shuangsheng/",
        modelJson = "live2D/shuangsheng/shuangsheng03.model3.json",
        personaPrompt = BUILTIN_PERSONA,
        builtin = true,
    )

    private lateinit var prefs: SharedPreferences
    private lateinit var avatarsRoot: File

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        avatarsRoot = File(context.applicationContext.filesDir, "avatars").apply { mkdirs() }
    }

    var currentAvatarId: String
        get() = prefs.getString(KEY_CURRENT, BUILTIN.id)!!
        set(value) = prefs.edit().putString(KEY_CURRENT, value).apply()

    var targetFps: Int
        get() = prefs.getInt("target_fps", 15)
        set(value) = prefs.edit().putInt("target_fps", value).apply()

    /** 本地可用角色：内置 + 已下载（localAvatar.json 存在即有效）。 */
    fun localAvatars(): List<LocalAvatar> {
        val downloaded = avatarsRoot.listFiles { f -> f.isDirectory }?.mapNotNull { dir ->
            readLocalManifest(File(dir, "local.json"))
        } ?: emptyList()
        return listOf(BUILTIN) + downloaded.filter { it.id != BUILTIN.id }
    }

    fun resolve(id: String): LocalAvatar? = localAvatars().firstOrNull { it.id == id }

    // ---- 服务端（阻塞调用，须在 ApiClient.io 执行） ----

    /** GET /api/avatars/catalog → [{id,name,summary,version,size_bytes,checksum}]（需登录）。 */
    fun catalog(): JSONArray =
        ApiClient.getJson("/api/avatars/catalog").optJSONArray("avatars") ?: JSONArray()

    /** 下载并落地一个角色（manifest→zip→SHA256 校验→解压→local.json）。 */
    fun download(id: String, onProgress: (Int) -> Unit): LocalAvatar {
        val manifest = ApiClient.getJson("/api/avatars/$id")
        val version = manifest.optInt("version", 1)
        val checksum = manifest.optString("checksum", "")
        val modelEntry = manifest.optString("model_entry", "")
        require(modelEntry.isNotEmpty()) { "角色缺少 model_entry" }

        val zipFile = File(avatarsRoot, "$id-v$version.zip")
        downloadZip(id, version, zipFile, manifest.optLong("size_bytes", 0L), onProgress)

        if (checksum.isNotEmpty()) {
            val actual = sha256Hex(zipFile)
            if (!actual.equals(checksum, ignoreCase = true)) {
                zipFile.delete()
                throw IllegalStateException("校验失败，请重试")
            }
        }

        val versionDir = File(File(avatarsRoot, id), "v$version")
        if (versionDir.exists()) versionDir.deleteRecursively()
        versionDir.mkdirs()
        unzip(zipFile, versionDir)
        zipFile.delete()

        val modelJsonFile = File(versionDir, modelEntry)
        require(modelJsonFile.isFile) { "包内缺少模型入口 $modelEntry" }

        val local = LocalAvatar(
            id = id,
            name = manifest.optString("name", id),
            modelDir = modelJsonFile.parentFile!!.absolutePath + "/",
            modelJson = modelJsonFile.absolutePath,
            personaPrompt = personaPromptOf(manifest),
            builtin = false,
        )
        writeLocalManifest(File(File(avatarsRoot, id), "local.json"), local)
        return local
    }

    private fun downloadZip(id: String, version: Int, dest: File, totalBytes: Long, onProgress: (Int) -> Unit) {
        val request = Request.Builder()
            .url("${ApiClient.baseUrl}/api/avatars/$id/asset/v$version.zip")
            .apply {
                com.aiboo.lite.net.AuthStore.token?.let { header("Authorization", "Bearer $it") }
                header("x-device-id", com.aiboo.lite.net.AuthStore.deviceUuid)
            }
            .build()
        ApiClient.http.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("下载失败(${resp.code})")
            val body = resp.body ?: throw IllegalStateException("下载失败(空响应)")
            val total = if (totalBytes > 0) totalBytes else body.contentLength()
            body.byteStream().use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) onProgress(((read * 100) / total).toInt().coerceIn(0, 100))
                    }
                }
            }
        }
    }

    /** 防 zip-slip：条目路径归一后必须落在目标目录内。 */
    private fun unzip(zip: File, destDir: File) {
        val destRoot = destDir.canonicalFile
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            while (true) {
                val entry = zin.nextEntry ?: break
                val out = File(destRoot, entry.name).canonicalFile
                if (!out.path.startsWith(destRoot.path + File.separator) && out != destRoot) {
                    throw SecurityException("非法压缩条目: ${entry.name}")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zin.copyTo(it) }
                }
                zin.closeEntry()
            }
        }
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 服务端 persona(JSON 对象) → prompt 文本（结构未知时整体注入，LLM 可读）。 */
    fun personaPromptOf(manifest: JSONObject): String {
        val name = manifest.optString("name", manifest.optString("id", "她"))
        val persona = manifest.optJSONObject("persona")
        val personaText = if (persona != null && persona.length() > 0) {
            "人设(JSON)：$persona"
        } else {
            manifest.optString("summary", "")
        }
        return "你是「$name」。$personaText\n回复简短口语化，用中文。"
    }

    private fun writeLocalManifest(file: File, avatar: LocalAvatar) {
        file.writeText(
            JSONObject()
                .put("id", avatar.id)
                .put("name", avatar.name)
                .put("modelDir", avatar.modelDir)
                .put("modelJson", avatar.modelJson)
                .put("personaPrompt", avatar.personaPrompt)
                .toString(),
        )
    }

    private fun readLocalManifest(file: File): LocalAvatar? {
        if (!file.isFile) return null
        return try {
            val obj = JSONObject(file.readText())
            val avatar = LocalAvatar(
                id = obj.getString("id"),
                name = obj.optString("name", obj.getString("id")),
                modelDir = obj.getString("modelDir"),
                modelJson = obj.getString("modelJson"),
                personaPrompt = obj.optString("personaPrompt", ""),
                builtin = false,
            )
            if (File(avatar.modelJson).isFile) avatar else null
        } catch (t: Throwable) {
            null
        }
    }

    // ---- 动作组自动发现（任意 model3.json 通用） ----

    data class MotionPlan(
        val idleGroup: String?,
        val beatGroups: List<String>,
        val tapGroups: List<String>,
        val emotionMotions: Map<String, String>,
    )

    /** 内置 shuangsheng 的手调映射；其他模型按组名启发式发现。 */
    fun motionPlan(avatar: LocalAvatar, model3JsonText: String): MotionPlan {
        if (avatar.builtin) {
            return MotionPlan(
                idleGroup = "Idle",
                beatGroups = listOf("Idle2", "Swing", "Think"),
                tapGroups = listOf("Happy", "Shy", "Nod", "Greeting", "Surprised", "Cheer"),
                emotionMotions = mapOf(
                    "happy" to "Happy", "excited" to "Cheer", "shy" to "Shy",
                    "surprised" to "Surprised", "sad" to "Pout", "angry" to "Panic",
                    "gentle" to "Nod",
                ),
            )
        }
        val groups = try {
            val refs = JSONObject(model3JsonText).optJSONObject("FileReferences")
            refs?.optJSONObject("Motions")?.keys()?.asSequence()?.toList() ?: emptyList()
        } catch (t: Throwable) {
            emptyList()
        }
        val idle = groups.firstOrNull { it.equals("Idle", true) }
            ?: groups.firstOrNull { it.contains("idle", true) }
        val nonIdle = groups.filter { it != idle }
        // emotion→组名包含匹配（happy→"Happy"/"TapHappy" 等）；没有就不播（气泡+口型仍在）
        val emotionMap = mutableMapOf<String, String>()
        for (emotion in listOf("happy", "sad", "angry", "surprised", "shy", "gentle", "excited")) {
            nonIdle.firstOrNull { it.contains(emotion, true) }?.let { emotionMap[emotion] = it }
        }
        return MotionPlan(
            idleGroup = idle,
            beatGroups = emptyList(),
            tapGroups = nonIdle.take(6),
            emotionMotions = emotionMap,
        )
    }
}
