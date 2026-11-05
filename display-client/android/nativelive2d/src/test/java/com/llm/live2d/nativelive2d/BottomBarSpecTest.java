package com.llm.live2d.nativelive2d;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class BottomBarSpecTest {
    @Test
    public void mapsTheFigmaBottomBandToThePhysicalOverlayHeight() {
        BottomBarSpec spec = new BottomBarSpec(0.2f, 0x1AFFFFFF);

        assertEquals(48, spec.pixelHeight(240));
    }

    @Test
    public void clampsInvalidBandFractionsToTheSurface() {
        BottomBarSpec spec = new BottomBarSpec(1.4f, 0x1AFFFFFF);

        assertEquals(240, spec.pixelHeight(240));
    }
}
