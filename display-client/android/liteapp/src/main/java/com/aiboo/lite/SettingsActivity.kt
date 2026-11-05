package com.aiboo.lite

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.aiboo.lite.avatar.AvatarRepo
import com.aiboo.lite.net.ApiClient
import com.aiboo.lite.net.AuthStore
import org.json.JSONObject

/** 设置页：账号 / 服务器地址 / 帧率 / 角色（切换 + 服务端下载）。 */
class SettingsActivity : Activity() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var listContainer: LinearLayout
    private lateinit var accountRow: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ApiClient.init(this)
        AvatarRepo.init(this)

        val root = ScrollView(this).apply { setBackgroundColor(0xFF14141E.toInt()) }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(40))
        }
        root.addView(column)
        setContentView(root)

        column.addView(sectionTitle("设置", 24f))

        // ---- 账号 ----
        column.addView(sectionTitle("账号", 15f, top = 22))
        accountRow = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(0, dp(8), 0, dp(8))
            setOnClickListener {
                if (AuthStore.loggedIn) {
                    AuthStore.clear()
                    refreshAccount()
                } else {
                    startActivity(Intent(this@SettingsActivity, LoginActivity::class.java))
                }
            }
        }
        column.addView(accountRow)

        // ---- 服务器 ----
        column.addView(sectionTitle("服务器地址", 15f, top = 18))
        val serverInput = EditText(this).apply {
            setText(ApiClient.baseUrl)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = pill(0x1AFFFFFF)
            setPadding(dp(14), dp(10), dp(14), dp(10))
        }
        column.addView(serverInput)
        column.addView(actionButton("保存地址") {
            ApiClient.baseUrl = serverInput.text.toString().trim()
            toastText("已保存")
        })

        // ---- 帧率 ----
        column.addView(sectionTitle("帧率（重进生效）", 15f, top = 18))
        val fpsRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf(10, 15, 20).forEach { fps ->
            fpsRow.addView(
                TextView(this).apply {
                    text = "${fps}fps"
                    gravity = Gravity.CENTER
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    setPadding(dp(18), dp(8), dp(18), dp(8))
                    refreshFpsChip(this, fps)
                    setOnClickListener {
                        AvatarRepo.targetFps = fps
                        for (i in 0 until fpsRow.childCount) {
                            val chip = fpsRow.getChildAt(i) as TextView
                            refreshFpsChip(chip, listOf(10, 15, 20)[i])
                        }
                    }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { rightMargin = dp(10) },
            )
        }
        column.addView(fpsRow)

        // ---- 角色 ----
        column.addView(sectionTitle("角色", 15f, top = 18))
        listContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(listContainer)

        refreshAccount()
        renderLocalAvatars()
        loadCatalog()
    }

    override fun onResume() {
        super.onResume()
        refreshAccount()
    }

    private fun refreshAccount() {
        accountRow.text = if (AuthStore.loggedIn) {
            "已登录：${AuthStore.username ?: ""}（点击退出）"
        } else {
            "未登录（点击登录）"
        }
    }

    private fun refreshFpsChip(chip: TextView, fps: Int) {
        val active = AvatarRepo.targetFps == fps
        chip.setTextColor(if (active) Color.WHITE else 0x99FFFFFF.toInt())
        chip.background = pill(if (active) 0xE67C6BF0.toInt() else 0x1AFFFFFF)
    }

    // ---- 角色列表 ----

    private fun renderLocalAvatars() {
        listContainer.removeAllViews()
        val current = AvatarRepo.currentAvatarId
        AvatarRepo.localAvatars().forEach { avatar ->
            listContainer.addView(avatarRow(
                title = avatar.name + if (avatar.id == current) "（当前）" else "",
                subtitle = if (avatar.builtin) "内置" else "已下载",
                actionLabel = if (avatar.id == current) null else "使用",
            ) {
                AvatarRepo.currentAvatarId = avatar.id
                renderLocalAvatars()
            })
        }
    }

    private fun loadCatalog() {
        val loading = TextView(this).apply {
            text = "正在获取角色列表…"
            setTextColor(0x66FFFFFF)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(8), 0, dp(8))
        }
        listContainer.addView(loading)
        ApiClient.io.execute {
            val result = runCatching { AvatarRepo.catalog() }
            mainHandler.post {
                listContainer.removeView(loading)
                result.fold(
                    onSuccess = { arr ->
                        val localIds = AvatarRepo.localAvatars().map { it.id }.toSet()
                        for (i in 0 until arr.length()) {
                            val item = arr.optJSONObject(i) ?: continue
                            val id = item.optString("id")
                            if (id.isEmpty() || id in localIds) continue
                            addCatalogRow(item)
                        }
                    },
                    onFailure = { e ->
                        listContainer.addView(TextView(this).apply {
                            text = if (e is com.aiboo.lite.net.ApiException && e.status == 401) {
                                "登录后可下载更多角色"
                            } else {
                                "角色列表获取失败（离线？）"
                            }
                            setTextColor(0x66FFFFFF)
                            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                        })
                    },
                )
            }
        }
    }

    private fun addCatalogRow(item: JSONObject) {
        val id = item.optString("id")
        val sizeMb = item.optLong("size_bytes", 0) / 1024 / 1024
        var row: LinearLayout? = null
        row = avatarRow(
            title = item.optString("name", id),
            subtitle = "云端 · ${if (sizeMb > 0) "${sizeMb}MB" else "大小未知"}",
            actionLabel = "下载",
        ) {
            val action = row!!.getChildAt(1) as TextView
            action.isEnabled = false
            ApiClient.io.execute {
                val result = runCatching {
                    AvatarRepo.download(id) { pct ->
                        mainHandler.post { action.text = "$pct%" }
                    }
                }
                mainHandler.post {
                    result.fold(
                        onSuccess = {
                            listContainer.removeView(row)
                            renderLocalAvatarsKeepCatalog()
                        },
                        onFailure = { e ->
                            action.isEnabled = true
                            action.text = "重试"
                            toastText(e.message ?: "下载失败")
                        },
                    )
                }
            }
        }
        listContainer.addView(row)
    }

    /** 下载完成后刷新本地区块：简单粗暴整页重画（列表很短）。 */
    private fun renderLocalAvatarsKeepCatalog() {
        renderLocalAvatars()
        loadCatalog()
    }

    // ---- 小部件 ----

    private fun avatarRow(
        title: String,
        subtitle: String,
        actionLabel: String?,
        onAction: () -> Unit,
    ): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = pill(0x14FFFFFF, radius = 14)
        }
        val textCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textCol.addView(TextView(this).apply {
            text = title
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        })
        textCol.addView(TextView(this).apply {
            text = subtitle
            setTextColor(0x66FFFFFF)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        })
        row.addView(textCol, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(TextView(this).apply {
            text = actionLabel ?: ""
            visibility = if (actionLabel == null) android.view.View.INVISIBLE else android.view.View.VISIBLE
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            background = pill(0xE67C6BF0.toInt())
            setPadding(dp(16), dp(7), dp(16), dp(7))
            setOnClickListener { if (actionLabel != null) onAction() }
        })
        (row.layoutParams ?: ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        )).let {
            row.layoutParams = (it as ViewGroup.MarginLayoutParams).apply { topMargin = dp(8) }
        }
        return row
    }

    private fun sectionTitle(text: String, sizeSp: Float, top: Int = 0): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(if (sizeSp > 20f) Color.WHITE else 0x99FFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            setPadding(0, dp(top), 0, dp(6))
        }

    private fun actionButton(label: String, onClick: () -> Unit): TextView =
        TextView(this).apply {
            text = label
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = pill(0x33FFFFFF)
            setPadding(dp(16), dp(9), dp(16), dp(9))
            setOnClickListener { onClick() }
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(8) }
        }

    private fun pill(color: Int, radius: Int = 20): GradientDrawable =
        GradientDrawable().apply {
            cornerRadius = dp(radius).toFloat()
            setColor(color)
        }

    private fun toastText(text: String) {
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
