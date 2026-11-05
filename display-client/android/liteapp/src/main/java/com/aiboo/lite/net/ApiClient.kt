package com.aiboo.lite.net

import android.content.Context
import android.content.SharedPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 后端业务错误（携带 HTTP 状态码；429=配额/限流，401=登录态失效）。 */
class ApiException(message: String, val status: Int) : IOException(message)

/**
 * 阿里云后端 HTTP 客户端（src/lib/apiClient.ts 协议的 Kotlin 版）：
 * baseUrl 可配 + Bearer 注入 + x-device-id + 401 静默 refresh 重试一次。
 * 所有方法为阻塞调用，请在 [io] 线程池执行。
 */
object ApiClient {

    private const val PREFS = "aiboo_lite_api"
    private const val KEY_BASE_URL = "base_url"
    const val DEFAULT_BASE_URL = "http://your-aiboo-host:3456"

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** 网络任务统一线程池（聊天/TTS/下载共用，低端机上限 3 并发足够）。 */
    val io: ExecutorService = Executors.newFixedThreadPool(3)

    private lateinit var prefs: SharedPreferences

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS) // LLM/TTS 生成可能要数十秒
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        AuthStore.init(context)
    }

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL)!!.trimEnd('/')
        set(value) = prefs.edit().putString(KEY_BASE_URL, value.trimEnd('/')).apply()

    // ---- 认证 ----

    /** 登录：成功后持久化 token/refresh。抛 ApiException(401) = 账号或密码错。 */
    fun login(username: String, password: String) {
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .put("deviceUuid", AuthStore.deviceUuid)
        val resp = rawPost("/api/auth/login", body, auth = false)
        AuthStore.saveLogin(
            token = resp.getString("token"),
            refreshToken = resp.optString("refreshToken", null),
            username = resp.optJSONObject("user")?.optString("username") ?: username,
        )
    }

    /** 401 时静默刷新（单飞防并发多刷）。成功返回新 token，失败返回 null（登录态作废）。 */
    @Synchronized
    private fun refreshOnce(staleToken: String?): String? {
        val current = AuthStore.token
        // 别的线程已经刷新过了
        if (current != null && current != staleToken) return current
        val refresh = AuthStore.refreshToken ?: return null
        return try {
            val resp = rawPost("/api/auth/refresh", JSONObject().put("refreshToken", refresh), auth = false)
            val newToken = resp.getString("token")
            AuthStore.saveLogin(newToken, resp.optString("refreshToken", refresh), AuthStore.username)
            newToken
        } catch (t: Throwable) {
            AuthStore.clear()
            null
        }
    }

    // ---- 请求核心 ----

    private fun buildRequest(path: String, body: JSONObject?, token: String?): Request {
        val builder = Request.Builder().url(baseUrl + path)
        builder.header("x-device-id", AuthStore.deviceUuid)
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (body != null) builder.post(body.toString().toRequestBody(JSON))
        return builder.build()
    }

    /** POST JSON → JSON（auth=true 时 401 自动 refresh 重试一次）。 */
    fun postJson(path: String, body: JSONObject, auth: Boolean = true): JSONObject =
        JSONObject(execute(path, body, auth).use { it.body!!.string() })

    /** POST JSON → 原始字节（TTS 音频）。 */
    fun postBytes(path: String, body: JSONObject, auth: Boolean = true): ByteArray =
        execute(path, body, auth).use { it.body!!.bytes() }

    /** GET → JSON。 */
    fun getJson(path: String, auth: Boolean = true): JSONObject =
        JSONObject(execute(path, null, auth).use { it.body!!.string() })

    private fun rawPost(path: String, body: JSONObject, auth: Boolean): JSONObject =
        JSONObject(execute(path, body, auth).use { it.body!!.string() })

    private fun execute(path: String, body: JSONObject?, auth: Boolean): okhttp3.Response {
        val token = if (auth) AuthStore.token else null
        if (auth && token == null) throw ApiException("未登录", 401)

        var resp = http.newCall(buildRequest(path, body, token)).execute()
        if (auth && resp.code == 401) {
            resp.close()
            val newToken = refreshOnce(token)
                ?: throw ApiException("登录已过期，请重新登录", 401)
            resp = http.newCall(buildRequest(path, body, newToken)).execute()
        }
        if (!resp.isSuccessful) {
            val status = resp.code
            val text = try { resp.body?.string() ?: "" } catch (t: Throwable) { "" }
            resp.close()
            val message = try { JSONObject(text).optString("error", "") } catch (t: Throwable) { "" }
            throw ApiException(message.ifEmpty { "请求失败($status)" }, status)
        }
        return resp
    }
}
