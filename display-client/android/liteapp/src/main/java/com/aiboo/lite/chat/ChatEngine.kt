package com.aiboo.lite.chat

import com.aiboo.lite.net.ApiClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * 聊天大脑（lite 版）：拼 messages → POST /ai/chat → 解析 {reply, emotion, intensity}。
 *
 * 与主 App 的对齐点：
 * - emotion 枚举 = src/lib/emotion.ts 的 EMOTIONS 契约（服务端 TTS 语气也吃它）；
 * - 解析降级链 = llm.ts parseAssistantPayload 思路：剥 markdown 围栏 → 取首尾大括号
 *   切 JSON → 失败则整段文本当 reply + neutral；
 * - 不移植 AU solver/prompt_template 渲染（lite 裁剪）：表情反应用 emotion→motion 映射。
 */
class ChatEngine(
    private val avatarId: String,
    private val personaPrompt: String,
) {

    data class Reply(val reply: String, val emotion: String, val intensity: Double)

    companion object {
        val EMOTIONS = setOf("neutral", "happy", "sad", "angry", "surprised", "shy", "gentle", "excited")
        private const val MAX_HISTORY = 12

        fun normalizeEmotion(raw: String?): String {
            val v = raw?.trim()?.lowercase() ?: return "neutral"
            return if (v in EMOTIONS) v else "neutral"
        }

        /** 剥 ```json 围栏 → 取第一个 { 到最后一个 } → JSONObject；失败返回 null。 */
        fun extractJsonObject(raw: String): JSONObject? {
            var text = raw.trim()
            if (text.startsWith("```")) {
                text = text.removePrefix("```json").removePrefix("```").trim()
                if (text.endsWith("```")) text = text.removeSuffix("```").trim()
            }
            val start = text.indexOf('{')
            val end = text.lastIndexOf('}')
            if (start < 0 || end <= start) return null
            return try {
                JSONObject(text.substring(start, end + 1))
            } catch (t: Throwable) {
                null
            }
        }

        /** LLM 原文 → Reply（结构化失败时整段降级为纯文本回复）。 */
        fun parseReply(content: String): Reply {
            val obj = extractJsonObject(content)
            if (obj != null && obj.has("reply")) {
                return Reply(
                    reply = obj.optString("reply", "").ifEmpty { "…" },
                    emotion = normalizeEmotion(obj.optString("emotion")),
                    intensity = obj.optDouble("intensity", 0.5).coerceIn(0.0, 1.0),
                )
            }
            val fallback = content
                .replace(Regex("```[a-z]*"), "")
                .replace(Regex("[{}\"\\[\\]]"), "")
                .replace(Regex("(reply|emotion|intensity)\\s*:", RegexOption.IGNORE_CASE), "")
                .trim()
            return Reply(fallback.ifEmpty { "…" }, "neutral", 0.5)
        }
    }

    /** 会话内存历史（lite 不持久化：摆件重启从头聊）。 */
    private val history = ArrayDeque<Pair<String, String>>() // role to content

    private fun systemPrompt(): String = buildString {
        append(personaPrompt.trim())
        append("\n\n")
        append("回复格式要求：严格只输出一个 JSON 对象，不要 markdown 围栏、不要 JSON 之外的任何文字：\n")
        append("""{"reply":"要说的话(简短口语化,1-2句)","emotion":"情绪","intensity":0.6}""")
        append("\nemotion 只能取: neutral / happy / sad / angry / surprised / shy / gentle / excited")
        append("\nintensity 是 0~1 的情绪强度。")
    }

    /** 阻塞调用（在 ApiClient.io 执行）：发送一轮用户消息并返回解析后的回复。 */
    fun send(userText: String): Reply {
        val messages = JSONArray()
        messages.put(JSONObject().put("role", "system").put("content", systemPrompt()))
        history.forEach { (role, content) ->
            messages.put(JSONObject().put("role", role).put("content", content))
        }
        messages.put(JSONObject().put("role", "user").put("content", userText))

        val payload = JSONObject()
            .put("messages", messages)
            .put("temperature", 0.8)
            .put("avatarId", avatarId)
        val resp = ApiClient.postJson("/ai/chat", payload)
        val content = resp.optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.optString("content")
            ?: ""

        val reply = parseReply(content)
        history.addLast("user" to userText)
        history.addLast("assistant" to reply.reply)
        while (history.size > MAX_HISTORY) history.removeFirst()
        return reply
    }
}
