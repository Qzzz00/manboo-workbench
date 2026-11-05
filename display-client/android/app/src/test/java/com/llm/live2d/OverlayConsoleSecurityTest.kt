package com.llm.live2d

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayConsoleSecurityTest {
    @Test
    fun `overlay web console never forwards raw message or source to Android logs`() {
        val relative = "src/main/java/com/llm/live2d/OverlayWindow.kt"
        val sourceFile = listOf(
            File(relative),
            File("app/$relative"),
            File("android/app/$relative"),
        ).firstOrNull(File::isFile)

        assertTrue("OverlayWindow.kt must be inspected by the security gate", sourceFile != null)
        val source = sourceFile!!.readText()
        assertFalse("raw console message must not reach a Log sink", source.contains("msg.message()"))
        assertFalse("raw console source must not reach a Log sink", source.contains("msg.sourceId()"))
    }
}
