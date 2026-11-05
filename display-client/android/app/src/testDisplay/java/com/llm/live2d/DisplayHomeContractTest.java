package com.llm.live2d;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

public class DisplayHomeContractTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    @Test
    public void displayBuildConfigEnablesLauncherBehaviorWithoutRadioBehavior() {
        assertTrue("display must use launcher window/lifecycle behavior", BuildConfig.IS_LAUNCHER);
        assertEquals("display", BuildConfig.LAUNCHER_KIND);
    }

    @Test
    public void mergedManifestDeclaresMainActivityAsHome() throws Exception {
        Path manifest = findMergedManifest();
        assertTrue("merged display manifest must exist: " + manifest, Files.isRegularFile(manifest));

        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Element mainActivity = findMainActivity(factory.newDocumentBuilder().parse(manifest.toFile()));
        assertNotNull("merged manifest must contain MainActivity", mainActivity);
        assertTrue(
            "MainActivity must expose one MAIN + HOME + DEFAULT intent filter",
            hasHomeIntentFilter(mainActivity)
        );
    }

    private static Path findMergedManifest() {
        Path cwd = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        Path relative = Paths.get(
            "build/intermediates/merged_manifest/displayDebug/",
            "processDisplayDebugMainManifest/AndroidManifest.xml"
        );
        Path direct = cwd.resolve(relative);
        if (Files.isRegularFile(direct)) return direct;
        return cwd.resolve("app").resolve(relative);
    }

    private static Element findMainActivity(org.w3c.dom.Document document) {
        NodeList activities = document.getElementsByTagName("activity");
        for (int i = 0; i < activities.getLength(); i++) {
            Element activity = (Element) activities.item(i);
            String name = activity.getAttributeNS(ANDROID_NS, "name");
            if ("com.llm.live2d.MainActivity".equals(name) || ".MainActivity".equals(name)) {
                return activity;
            }
        }
        return null;
    }

    private static boolean hasHomeIntentFilter(Element activity) {
        NodeList filters = activity.getElementsByTagName("intent-filter");
        for (int i = 0; i < filters.getLength(); i++) {
            Element filter = (Element) filters.item(i);
            boolean main = false;
            boolean home = false;
            boolean defaults = false;
            NodeList children = filter.getChildNodes();
            for (int j = 0; j < children.getLength(); j++) {
                Node node = children.item(j);
                if (!(node instanceof Element element)) continue;
                String name = element.getAttributeNS(ANDROID_NS, "name");
                if ("android.intent.action.MAIN".equals(name)) main = true;
                if ("android.intent.category.HOME".equals(name)) home = true;
                if ("android.intent.category.DEFAULT".equals(name)) defaults = true;
            }
            if (main && home && defaults) return true;
        }
        return false;
    }
}
