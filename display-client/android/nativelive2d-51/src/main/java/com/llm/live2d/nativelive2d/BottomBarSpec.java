package com.llm.live2d.nativelive2d;

/** GL 底栏：先画纯色底色，再画 Live2D，最后由透明 WebView 画可点击按钮。 */
final class BottomBarSpec {
    final float heightFraction;
    final float redPremultiplied;
    final float greenPremultiplied;
    final float bluePremultiplied;
    final float alpha;

    BottomBarSpec(float heightFraction, int argb) {
        this.heightFraction = Math.max(0f, Math.min(1f, heightFraction));
        this.alpha = ((argb >>> 24) & 0xff) / 255f;
        this.redPremultiplied = (((argb >>> 16) & 0xff) / 255f) * alpha;
        this.greenPremultiplied = (((argb >>> 8) & 0xff) / 255f) * alpha;
        this.bluePremultiplied = ((argb & 0xff) / 255f) * alpha;
    }

    int pixelHeight(int surfaceHeight) {
        return Math.round(Math.max(0, surfaceHeight) * heightFraction);
    }
}
