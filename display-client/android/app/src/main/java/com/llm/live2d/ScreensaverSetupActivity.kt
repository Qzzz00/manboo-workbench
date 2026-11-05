package com.llm.live2d

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat

/**
 * 屏保设置页。被注册为 DreamService 的 settingsActivity——用户在
 * 「设置 > 显示 > 屏保」选中本屏保后点旁边的齿轮即可进入。
 *
 * 提供：申请日历权限、开启通知读取（深链系统设置）、跳转屏保选择、
 * 填写后端服务器地址与天气城市（写入 ScreensaverPrefs）。
 */
class ScreensaverSetupActivity : Activity() {

    private val reqCalendar = 1001
    private val reqLocation = 1002

    private lateinit var statusView: TextView
    private lateinit var serverInput: EditText
    private lateinit var cityInput: EditText
    private lateinit var fpsInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
        }

        fun heading(text: String) = TextView(this).apply {
            this.text = text
            textSize = 16f
            setPadding(0, dp(16), 0, dp(6))
        }

        root.addView(TextView(this).apply {
            text = "Aiboo 屏保设置"
            textSize = 22f
            setPadding(0, 0, 0, dp(8))
        })

        statusView = TextView(this).apply { textSize = 14f }
        root.addView(statusView)

        // 服务器地址
        root.addView(heading("后端服务器地址（DJ / 天气）"))
        serverInput = EditText(this).apply {
            hint = "http://192.168.x.x:3456"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(ScreensaverPrefs.getServerBaseUrl(this@ScreensaverSetupActivity))
        }
        root.addView(serverInput)

        // 天气城市
        root.addView(heading("天气城市（留空用默认）"))
        cityInput = EditText(this).apply {
            hint = "Beijing / 上海 / Shanghai"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(ScreensaverPrefs.getWeatherCity(this@ScreensaverSetupActivity))
        }
        root.addView(cityInput)

        // 屏保刷新率（仅影响屏保的 Live2D 渲染帧率）
        root.addView(heading("屏保刷新率 fps（默认 15，越高越流畅但越耗电/发热；10–60）"))
        fpsInput = EditText(this).apply {
            hint = "15"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(ScreensaverPrefs.getScreensaverFps(this@ScreensaverSetupActivity).toString())
        }
        root.addView(fpsInput)

        root.addView(button("保存设置") {
            ScreensaverPrefs.setServerBaseUrl(this, serverInput.text.toString())
            ScreensaverPrefs.setWeatherCity(this, cityInput.text.toString())
            ScreensaverPrefs.setScreensaverFps(this, fpsInput.text.toString().toIntOrNull() ?: 15)
            Toast.makeText(this, "已保存（屏保刷新率重进屏保生效）", Toast.LENGTH_SHORT).show()
            refreshStatus()
        })

        // 权限
        root.addView(heading("权限"))
        root.addView(button("申请日历读取权限") {
            requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), reqCalendar)
        })
        root.addView(button("申请定位权限（天气跟随本地）") {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), reqLocation)
        })
        root.addView(button("开启通知读取（系统设置）") {
            startActivitySafe(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })

        // 屏保选择
        root.addView(heading("启用屏保"))
        root.addView(button("打开系统屏保设置") {
            startActivitySafe(Intent(Settings.ACTION_DREAM_SETTINGS))
        })

        val scroll = ScrollView(this).apply {
            addView(root, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ))
        }
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun button(label: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }
    }

    private fun startActivitySafe(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            Toast.makeText(this, "无法打开该系统设置页", Toast.LENGTH_SHORT).show()
        }
    }

    private fun refreshStatus() {
        val calOk = checkSelfPermission(Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED
        val locOk = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val notifOk = try {
            NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        } catch (_: Throwable) {
            false
        }
        val server = ScreensaverPrefs.getServerBaseUrl(this)
        statusView.text = buildString {
            append("日历权限：").append(if (calOk) "已授予 ✓" else "未授予 ✗").append('\n')
            append("定位权限：").append(if (locOk) "已授予 ✓" else "未授予 ✗").append('\n')
            append("通知读取：").append(if (notifOk) "已开启 ✓" else "未开启 ✗").append('\n')
            append("服务器地址：").append(if (server.isNotEmpty()) server else "未设置（DJ/天气将不可用）").append('\n')
            append("屏保刷新率：").append(ScreensaverPrefs.getScreensaverFps(this@ScreensaverSetupActivity)).append(" fps")
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }
}
