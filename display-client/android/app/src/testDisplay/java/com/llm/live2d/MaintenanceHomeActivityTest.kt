package com.llm.live2d

import android.app.Activity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class MaintenanceHomeActivityTest {
    @Test
    fun maintenanceHomeIsAnActivity() {
        assertTrue(Activity::class.java.isAssignableFrom(MaintenanceHomeActivity::class.java))
    }

    @Test
    fun displayManifestDeclaresDisabledMaintenanceHome() {
        val manifest = DocumentBuilderFactory.newInstance()
            .newDocumentBuilder()
            .parse(File("src/display/AndroidManifest.xml"))
        val activities = manifest.getElementsByTagName("activity")
        val maintenance = (0 until activities.length)
            .map { activities.item(it) as Element }
            .firstOrNull {
                it.getAttribute("android:name") == ".MaintenanceHomeActivity"
            }

        assertNotNull(maintenance)
        assertEquals("false", maintenance!!.getAttribute("android:enabled"))

        val categories = maintenance.getElementsByTagName("category")
        assertTrue((0 until categories.length).any {
            (categories.item(it) as Element).getAttribute("android:name") ==
                "android.intent.category.HOME"
        })
    }
}
