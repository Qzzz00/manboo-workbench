package ai.ben.butler

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 原生收铃的三块纯逻辑:解析、去重、断线后怎么办(2026-10-20,卡 E)。 */
class NativeRingTest {

    // ———————————————— 解析 ————————————————

    @Test
    fun parsesRingLikeTheWebSide() {
        val ring = RingSignal.parse(
            """{"type":"ring","call_id":"c1","reason":"confirm","item_id":"i1","title":"把首页文案改一版","at":"x","silent":false,"until":1800000060000}"""
        ) as RingSignal.Ring
        assertEquals("c1", ring.callId)
        assertEquals("confirm", ring.reason)
        assertFalse(ring.silent)
        assertEquals(1800000060000L, ring.until)
        assertEquals("等你确认 · 把首页文案改一版", ring.headline())
    }

    @Test
    fun silentAndMissingUntil() {
        val ring = RingSignal.parse("""{"type":"ring","call_id":"c2","reason":"done","title":"t","silent":true}""") as RingSignal.Ring
        assertTrue(ring.silent)
        assertEquals(0L, ring.until)
    }

    @Test
    fun rejectsBrokenRings() {
        assertNull(RingSignal.parse("not json"))
        assertNull(RingSignal.parse("""{"type":"ring","reason":"confirm","title":"t"}"""))
        assertNull(RingSignal.parse("""{"type":"ring","call_id":"","reason":"confirm","title":"t"}"""))
        assertNull(RingSignal.parse("""{"type":"ring","call_id":"c","reason":"party","title":"t"}"""))
        assertNull(RingSignal.parse("""{"type":"ring","call_id":"c","reason":"confirm"}"""))
        assertNull(RingSignal.parse("""{"type":"ring","call_id":7,"reason":"confirm","title":"t"}"""))
    }

    @Test
    fun parsesRingEndAndIgnoresOthers() {
        assertEquals(RingSignal.End("c1", "answered"), RingSignal.parse("""{"type":"ring_end","call_id":"c1","outcome":"answered","by":"handset"}"""))
        assertNull(RingSignal.parse("""{"type":"ring_end","call_id":"c1","outcome":"exploded"}"""))
        // 通话状态、字幕、代理回包:原生不管。
        assertNull(RingSignal.parse("""{"type":"call_state","state":"idle","by":"worker","call_id":"c1","started_at":0}"""))
        assertNull(RingSignal.parse("""{"type":"caption","role":"butler","text":"喂","final":true}"""))
    }

    // ———————————————— 去重 ————————————————

    @Test
    fun sameCallRingsOnce() {
        val book = RingBook()
        assertEquals(RingBook.Start.RING, book.start("c1"))
        // 亮屏回来网页收到工人补发的那一份:不重响。
        assertEquals(RingBook.Start.ALREADY, book.start("c1"))
        assertEquals("c1", book.ringing)
    }

    @Test
    fun endedCallDoesNotRingAgain() {
        val book = RingBook()
        book.start("c1")
        assertTrue(book.stop("c1"))
        assertEquals(RingBook.Start.ENDED, book.start("c1"))
        // 下一通照响。
        assertEquals(RingBook.Start.RING, book.start("c2"))
    }

    @Test
    fun stopWithIdOnlyStopsThatCall() {
        val book = RingBook()
        book.start("c2")
        // 网页解冻后给上一通补的那一下「停」:不掐这一通。
        assertFalse(book.stop("c1"))
        assertEquals("c2", book.ringing)
        // 上一通记成收场了,晚到的补发也不再响。
        assertEquals(RingBook.Start.ENDED, book.start("c1"))
        // 不带 id 照旧全停(老调用方)。
        assertTrue(book.stop(null))
        assertNull(book.ringing)
        assertEquals(RingBook.Start.ENDED, book.start("c2"))
    }

    @Test
    fun endedListIsBounded() {
        val book = RingBook(endedCap = 2)
        book.stop("a"); book.stop("b"); book.stop("c")
        assertEquals(RingBook.Start.RING, book.start("a"))
        assertEquals(RingBook.Start.ENDED, book.start("c"))
    }

    // ———————————————— 断线之后 ————————————————

    private val now = 1_800_000_000L
    private val weekLater = now + 7 * 24 * 3600

    @Test
    fun ourOwnLeaveAndTakeoverDoNotReconnect() {
        assertEquals(NativeRingPolicy.Next.Stop(takenOver = false), NativeRingPolicy.afterDisconnect("CLIENT_INITIATED", 0, weekLater, now))
        // 网页用同一个身份收回了房间:原生让出来,不抢回去(抢就是两边踢来踢去)。
        assertEquals(NativeRingPolicy.Next.Stop(takenOver = true), NativeRingPolicy.afterDisconnect("DUPLICATE_IDENTITY", 3, weekLater, now))
    }

    @Test
    fun networkTroubleRetriesWithBackoff() {
        assertEquals(NativeRingPolicy.Next.Retry(2_000), NativeRingPolicy.afterDisconnect("SIGNAL_CLOSE", 0, weekLater, now))
        assertEquals(NativeRingPolicy.Next.Retry(10_000), NativeRingPolicy.afterDisconnect("JOIN_FAILURE", 2, weekLater, now))
        assertEquals(NativeRingPolicy.Next.Retry(60_000), NativeRingPolicy.afterDisconnect("UNKNOWN_REASON", 99, weekLater, now))
    }

    @Test
    fun expiredOrRemovedGivesUpHonestly() {
        assertEquals(NativeRingPolicy.Next.GiveUp(NativeRingPolicy.EXPIRED_NOTE), NativeRingPolicy.afterDisconnect("SIGNAL_CLOSE", 0, now + 30, now))
        assertEquals(NativeRingPolicy.Next.GiveUp(NativeRingPolicy.REMOVED_NOTE), NativeRingPolicy.afterDisconnect("PARTICIPANT_REMOVED", 0, weekLater, now))
    }

    @Test
    fun ringTimeout() {
        assertEquals(NativeRingPolicy.DEFAULT_RING_MS, NativeRingPolicy.ringTimeoutMs(0, 1_000))
        assertEquals(42_000L, NativeRingPolicy.ringTimeoutMs(1_042_000, 1_000_000))
        // 钟差 / 晚到:上下各兜一刀。
        assertEquals(5_000L, NativeRingPolicy.ringTimeoutMs(999_000, 1_000_000))
        assertEquals(NativeRingPolicy.MAX_RING_MS, NativeRingPolicy.ringTimeoutMs(10_000_000, 1_000_000))
    }
}
