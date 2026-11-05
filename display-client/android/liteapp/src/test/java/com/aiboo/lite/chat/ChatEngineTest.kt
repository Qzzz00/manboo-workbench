package com.aiboo.lite.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** ChatEngine 解析降级链（复刻 llm.ts parseAssistantPayload 语义）的 JVM 单测。 */
class ChatEngineTest {

    @Test
    fun `extract plain json`() {
        val obj = ChatEngine.extractJsonObject("""{"reply":"你好呀","emotion":"happy","intensity":0.7}""")!!
        assertEquals("你好呀", obj.getString("reply"))
    }

    @Test
    fun `extract json inside markdown fence`() {
        val raw = "```json\n{\"reply\":\"嗯嗯\",\"emotion\":\"gentle\",\"intensity\":0.4}\n```"
        val obj = ChatEngine.extractJsonObject(raw)!!
        assertEquals("gentle", obj.getString("emotion"))
    }

    @Test
    fun `extract json surrounded by prose`() {
        val raw = "好的，这是回复：{\"reply\":\"喵\",\"emotion\":\"happy\",\"intensity\":1} 以上。"
        val obj = ChatEngine.extractJsonObject(raw)!!
        assertEquals("喵", obj.getString("reply"))
    }

    @Test
    fun `no json returns null`() {
        assertNull(ChatEngine.extractJsonObject("今天天气不错"))
    }

    @Test
    fun `parse full envelope`() {
        val r = ChatEngine.parseReply("""{"reply":"抱抱你","emotion":"gentle","intensity":0.8}""")
        assertEquals("抱抱你", r.reply)
        assertEquals("gentle", r.emotion)
        assertEquals(0.8, r.intensity, 1e-9)
    }

    @Test
    fun `illegal emotion falls back to neutral`() {
        val r = ChatEngine.parseReply("""{"reply":"哦","emotion":"ecstatic","intensity":0.5}""")
        assertEquals("neutral", r.emotion)
    }

    @Test
    fun `intensity clamped to unit range`() {
        val r = ChatEngine.parseReply("""{"reply":"哇","emotion":"excited","intensity":7}""")
        assertEquals(1.0, r.intensity, 1e-9)
    }

    @Test
    fun `plain text degrades to neutral reply`() {
        val r = ChatEngine.parseReply("今晚的月亮很好看呢")
        assertEquals("今晚的月亮很好看呢", r.reply)
        assertEquals("neutral", r.emotion)
    }

    @Test
    fun `broken json degrades with envelope words stripped`() {
        val r = ChatEngine.parseReply("""{"reply":"月亮很圆""")
        assertEquals("neutral", r.emotion)
        assertEquals("月亮很圆", r.reply)
    }

    @Test
    fun `empty content yields ellipsis`() {
        assertEquals("…", ChatEngine.parseReply("").reply)
    }
}
