package com.aiboo.lite.net

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * 登录态持久化：access token(15m)/refresh token(7d)/用户名 + 安装级 deviceUuid。
 * 语义对齐 src/lib/apiClient.ts：401 时先静默 refresh 重试一次，刷新失败才判登出。
 */
object AuthStore {

    private const val PREFS = "aiboo_lite_auth"
    private const val KEY_TOKEN = "token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_USERNAME = "username"
    private const val KEY_DEVICE_UUID = "device_uuid"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(value) = prefs.edit().putString(KEY_REFRESH, value).apply()

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    val loggedIn: Boolean get() = !token.isNullOrEmpty()

    /** 安装级设备标识（服务端内测邀请体系绑定设备用），首次生成后固定。 */
    val deviceUuid: String
        get() {
            var id = prefs.getString(KEY_DEVICE_UUID, null)
            if (id.isNullOrEmpty()) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_UUID, id).apply()
            }
            return id
        }

    fun saveLogin(token: String, refreshToken: String?, username: String?) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_REFRESH, refreshToken)
            .putString(KEY_USERNAME, username)
            .apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_REFRESH).remove(KEY_USERNAME).apply()
    }
}
