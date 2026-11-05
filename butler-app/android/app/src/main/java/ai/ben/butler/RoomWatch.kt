package ai.ben.butler

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * 「进一次房、等它断」那一段(2026-10-20,核查 E3 从 NativeRingListener 里抽出来)。
 *
 * 房间事件的收集协程是**这一次进房的子协程**:这一段返回(断了)或被取消(stop)时它跟着停。
 * 以前它挂在 listener 的长寿命 scope 下,stop 取消不到 —— 每次亮屏收回漏一个,还会在网页收回之后
 * 把常驻通知改成「正在重连」。泛型、不碰 LiveKit 类型,所以能在 JVM 上用 MutableSharedFlow 测。
 */
object RoomWatch {

    sealed class Seen {
        /** 房间断了,带 LiveKit `DisconnectReason` 的名字。 */
        data class End(val reason: String) : Seen()
        /** 一个要报出去的状态(在重连 / 重连上了)。 */
        data class State(val state: String) : Seen()
        object Ignore : Seen()
    }

    /** 进房失败(connect 抛了)时那个「原因」:与 NativeRingPolicy 认的名字一致。 */
    const val JOIN_FAILURE = "JOIN_FAILURE"

    suspend fun <E> connectAndAwaitEnd(
        events: Flow<E>,
        classify: (E) -> Seen,
        connect: suspend () -> Unit,
        onConnected: () -> Unit,
        onState: (String) -> Unit,
    ): String = coroutineScope {
        val ended = CompletableDeferred<String>()
        // UNDISPATCHED:connect 之前就订上,连接过程中来的「断了」也收得到。
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (val seen = classify(event)) {
                    is Seen.End -> ended.complete(seen.reason)
                    is Seen.State -> if (!ended.isCompleted) onState(seen.state)
                    Seen.Ignore -> Unit
                }
            }
        }
        try {
            connect()
            if (!ended.isCompleted) onConnected()
        } catch (cancel: CancellationException) {
            collector.cancel()
            throw cancel
        } catch (_: Exception) {
            ended.complete(JOIN_FAILURE)
        }
        try { ended.await() } finally { collector.cancel() }
    }
}
