package ai.ben.butler

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 核查 E3(2026-10-20):房间事件的收集协程必须跟着「这一次进房」走 ——
 * 以前它挂在 listener 的长寿命 scope 下,stop() 取消不到,每次亮屏收回漏一个,
 * 还会在网页收回之后把常驻通知改成「正在重连」。
 */
class RoomWatchTest {

    private suspend fun waitSubscribed(flow: MutableSharedFlow<String>) {
        withTimeout(1_000) { while (flow.subscriptionCount.value == 0) yield() }
    }

    @Test
    fun returnsTheEndReasonAndStopsCollecting() = runBlocking {
        val flow = MutableSharedFlow<String>(extraBufferCapacity = 8)
        val states = mutableListOf<String>()
        val result = async {
            RoomWatch.connectAndAwaitEnd(
                events = flow,
                classify = { if (it.startsWith("end:")) RoomWatch.Seen.End(it.removePrefix("end:")) else RoomWatch.Seen.State(it) },
                connect = { waitSubscribed(flow) },
                onConnected = { states.add("listening") },
                onState = { states.add(it) },
            )
        }
        waitSubscribed(flow)
        flow.emit("reconnecting")
        flow.emit("end:SIGNAL_CLOSE")
        assertEquals("SIGNAL_CLOSE", result.await())
        assertEquals(listOf("listening", "reconnecting"), states)
        // 收完就不再订着。
        assertEquals(0, flow.subscriptionCount.value)
    }

    @Test
    fun cancellingTheJobCancelsTheCollector() = runBlocking {
        val flow = MutableSharedFlow<String>(extraBufferCapacity = 8)
        val states = mutableListOf<String>()
        val job = launch {
            RoomWatch.connectAndAwaitEnd(
                events = flow,
                classify = { RoomWatch.Seen.State(it) },
                connect = { },
                onConnected = { },
                onState = { states.add(it) },
            )
        }
        waitSubscribed(flow)
        job.cancelAndJoin()
        assertEquals(0, flow.subscriptionCount.value)
        // 取消之后再来的事件不许再改状态(那正是「网页收回后通知变成正在重连」)。
        flow.tryEmit("reconnecting")
        delay(20)
        assertTrue(states.isEmpty())
    }

    @Test
    fun connectFailureIsJoinFailure() = runBlocking {
        val flow = MutableSharedFlow<String>(extraBufferCapacity = 8)
        val reason = RoomWatch.connectAndAwaitEnd(
            events = flow,
            classify = { RoomWatch.Seen.State(it) },
            connect = { throw IllegalStateException("boom") },
            onConnected = { },
            onState = { },
        )
        assertEquals("JOIN_FAILURE", reason)
        assertEquals(0, flow.subscriptionCount.value)
    }

    @Test
    fun endBeforeConnectReturnsIsStillSeen() = runBlocking {
        val flow = MutableSharedFlow<String>(extraBufferCapacity = 8)
        val gate = CompletableDeferred<Unit>()
        val result = async {
            RoomWatch.connectAndAwaitEnd(
                events = flow,
                classify = { if (it.startsWith("end:")) RoomWatch.Seen.End(it.removePrefix("end:")) else RoomWatch.Seen.State(it) },
                connect = { waitSubscribed(flow); flow.emit("end:DUPLICATE_IDENTITY"); gate.await() },
                onConnected = { },
                onState = { },
            )
        }
        gate.complete(Unit)
        assertEquals("DUPLICATE_IDENTITY", result.await())
    }
}
