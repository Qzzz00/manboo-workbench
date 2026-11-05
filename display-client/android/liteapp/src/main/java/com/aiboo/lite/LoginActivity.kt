package com.aiboo.lite

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.aiboo.lite.net.ApiClient

/** 极简登录页：账号 + 密码(邀请码) → /api/auth/login。成功即返回。 */
class LoginActivity : Activity() {

    private lateinit var status: TextView
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ApiClient.init(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF14141E.toInt())
            setPadding(dp(36), 0, dp(36), 0)
        }

        val title = TextView(this).apply {
            text = "登录 Aiboo"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
        }
        val userInput = makeInput("手机号 / 账号").apply {
            inputType = InputType.TYPE_CLASS_TEXT
        }
        val passInput = makeInput("密码 / 邀请码").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        status = TextView(this).apply {
            setTextColor(0xFFFF8A80.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        val button = TextView(this).apply {
            text = "登  录"
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            background = GradientDrawable().apply {
                cornerRadius = dp(24).toFloat()
                setColor(0xFF7C6BF0.toInt())
            }
            setPadding(0, dp(13), 0, dp(13))
            setOnClickListener {
                val u = userInput.text.toString().trim()
                val p = passInput.text.toString()
                if (u.isEmpty() || p.isEmpty()) {
                    status.text = "请输入账号和密码"
                    return@setOnClickListener
                }
                status.setTextColor(0xB3FFFFFF.toInt())
                status.text = "登录中…"
                isEnabled = false
                ApiClient.io.execute {
                    val error = try {
                        ApiClient.login(u, p)
                        null
                    } catch (t: Throwable) {
                        t.message ?: "登录失败"
                    }
                    mainHandler.post {
                        isEnabled = true
                        if (error == null) {
                            setResult(RESULT_OK)
                            finish()
                        } else {
                            status.setTextColor(0xFFFF8A80.toInt())
                            status.text = error
                        }
                    }
                }
            }
        }

        fun lp(topDp: Int) = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(topDp) }

        root.addView(title, lp(0))
        root.addView(userInput, lp(28))
        root.addView(passInput, lp(14))
        root.addView(status, lp(10))
        root.addView(button, lp(18))
        setContentView(root)
    }

    private fun makeInput(hintText: String): EditText = EditText(this).apply {
        hint = hintText
        setHintTextColor(0x66FFFFFF)
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(0x1AFFFFFF)
        }
        setPadding(dp(16), dp(13), dp(16), dp(13))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
