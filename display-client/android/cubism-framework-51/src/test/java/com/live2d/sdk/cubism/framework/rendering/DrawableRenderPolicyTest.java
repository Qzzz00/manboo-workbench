package com.live2d.sdk.cubism.framework.rendering;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DrawableRenderPolicyTest {
    @Test
    public void visibleOpaqueDrawableRenders() {
        assertTrue(DrawableRenderPolicy.shouldRender(true, 1.0f));
        assertTrue(DrawableRenderPolicy.shouldRender(true, 0.5f));
    }

    @Test
    public void invisibleDrawableIsSkipped() {
        assertFalse(DrawableRenderPolicy.shouldRender(false, 1.0f));
    }

    @Test
    public void effectivelyTransparentDrawableIsSkipped() {
        assertFalse(DrawableRenderPolicy.shouldRender(true, 0.0f));
        assertFalse(DrawableRenderPolicy.shouldRender(true, 0.001f));
        assertFalse(DrawableRenderPolicy.shouldRender(true, -0.1f));
    }
}
