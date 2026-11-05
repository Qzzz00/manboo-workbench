/*
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at http://live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

package com.live2d.sdk.cubism.framework.rendering;

/**
 * Decides whether a drawable can contribute visible pixels to the current frame.
 */
public final class DrawableRenderPolicy {
    private static final float MIN_VISIBLE_OPACITY = 0.001f;

    private DrawableRenderPolicy() {
    }

    public static boolean shouldRender(boolean visible, float opacity) {
        return visible && opacity > MIN_VISIBLE_OPACITY;
    }
}
