package ai.ben.butler

import android.content.Context
import android.util.Log
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.AudioOptions
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * **熄屏后由原生进房听铃**(2026-10-20,卡 E;为什么见 src/call/ringHandoff.ts 的文件头)。
 *
 * 跑在 RingStandbyService(specialUse 前台服务)里:前台服务进程在 Doze 里网络豁免、唤醒锁有效
 * (实测交接第四、六节),而 WebView 那一页熄屏 5 分钟后会被冻住 —— 所以「听铃」放在这里。
 *
 * 只做一件事:用网页借来的那张凭证(**同一个身份**)进房,订 `wb.rpc` 文本流,只认工人发的 `ring` / `ring_end`,
 * 收到就交给 [Ringer] 响 / 停。不订任何音轨、不发布任何东西、不碰音频模式(NoAudioHandler);
 * 不发 RPC、不答话 —— 接电话仍由网页那一页做(点通知回到 App,网页收回房间,工人补发那一通)。
 *
 * 凭证只在内存里:不落盘、不打日志。断线按 [NativeRingPolicy] 重连;网页用同一身份收回房间时
 * (DUPLICATE_IDENTITY)让出来,不抢回去。
 */
class NativeRingListener(
    private val context: Context,
    private val onState: (state: String, note: String?) -> Unit,
) {
    data class Credential(val url: String, val token: String, val identity: String, val expiresAtS: Long)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private var room: Room? = null

    @Volatile
    var state: String = STATE_OFF
        private set

    @Volatile
    var note: String? = null
        private set

    private fun set(next: String, why: String? = null) {
        state = next
        note = why
        Log.i(TAG, "listen state=$next${if (why == null) "" else " note=$why"}")
        onState(next, why)
    }

    /** 主线程调。已经在听就先放掉旧的(凭证可能换了一张)。 */
    fun start(credential: Credential) {
        stopRoom()
        job?.cancel()
        job = scope.launch { loop(credential) }
    }

    /** 主线程调。离房、停重连。 */
    fun stop() {
        job?.cancel()
        job = null
        stopRoom()
        if (state != STATE_OFF) set(STATE_OFF)
    }

    fun dispose() {
        stop()
        scope.cancel()
    }

    private fun stopRoom() {
        val current = room ?: return
        room = null
        try { current.disconnect() } catch (_: Exception) { /* 已经断了 */ }
        try { current.release() } catch (_: Exception) { /* 同上 */ }
    }

    private suspend fun loop(credential: Credential) {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            set(if (failures == 0) STATE_CONNECTING else STATE_RETRYING)
            val current = LiveKit.create(
                context.applicationContext,
                RoomOptions(adaptiveStream = false, dynacast = false),
                LiveKitOverrides(
                    // 只听数据:不要它去抢音频焦点、改通话模式(那会掐掉她正在听的音乐)。
                    audioOptions = AudioOptions(audioHandler = NoAudioHandler(), disableCommunicationModeWorkaround = true),
                ),
            )
            room = current
            /*
             * 这一次进房自己的 scope(核查 E3):读文本流的协程挂在它下面,房断了 / stop() 时一起取消 ——
             * 不许一条读到一半的 `ring` 在网页收回之后才落地、再响一遍。
             */
            val session = CoroutineScope(currentCoroutineContext() + SupervisorJob(currentCoroutineContext()[Job]))
            current.registerTextStreamHandler(RingWire.RPC_TOPIC) { reader, from ->
                if (from.value != RingWire.WORKER_IDENTITY) return@registerTextStreamHandler
                session.launch {
                    val text = try { reader.readAll().joinToString("") } catch (_: Exception) { return@launch }
                    handle(text)
                }
            }
            val reason = try {
                RoomWatch.connectAndAwaitEnd(
                    events = current.events.events,
                    classify = { event ->
                        when (event) {
                            is RoomEvent.Disconnected -> RoomWatch.Seen.End(event.reason.name)
                            is RoomEvent.Reconnecting -> RoomWatch.Seen.State(STATE_RECONNECTING)
                            is RoomEvent.Reconnected -> RoomWatch.Seen.State(STATE_LISTENING)
                            else -> RoomWatch.Seen.Ignore
                        }
                    },
                    connect = { current.connect(credential.url, credential.token, ConnectOptions(autoSubscribe = false)) },
                    onConnected = { failures = 0; set(STATE_LISTENING) },
                    onState = { set(it) },
                )
            } finally {
                session.cancel()
            }
            if (room === current) stopRoom()
            Log.i(TAG, "disconnected reason=$reason")
            when (val next = NativeRingPolicy.afterDisconnect(reason, failures, credential.expiresAtS, System.currentTimeMillis() / 1000)) {
                is NativeRingPolicy.Next.Stop -> { set(if (next.takenOver) STATE_TAKEN_OVER else STATE_OFF); return }
                is NativeRingPolicy.Next.GiveUp -> { set(STATE_FAILED, next.note); return }
                is NativeRingPolicy.Next.Retry -> { failures += 1; delay(next.delayMs) }
            }
        }
    }

    private fun handle(text: String) {
        when (val signal = RingSignal.parse(text) ?: return) {
            is RingSignal.Ring -> {
                Log.i(TAG, "got ring call=${signal.callId} silent=${signal.silent}")
                if (signal.silent) {
                    // 夜间静默:只发一条通知(同网页那一路,来电 id 当 tag,两路发同一条不会出两条)。
                    Ringer.postNotice(context, signal.callId, signal.headline(), signal.note ?: "夜间静默时段,没有响铃")
                    return
                }
                val result = Ringer.start(context, signal.callId, signal.headline(), "事务官打来的", signal.until, "native")
                if (!result.deduped) Ringer.wakeScreen(context)
            }
            is RingSignal.End -> {
                Log.i(TAG, "got ring_end call=${signal.callId} outcome=${signal.outcome}")
                Ringer.stop(context, signal.callId)
            }
        }
    }

    companion object {
        private const val TAG = "NativeRing"
        const val STATE_OFF = "off"
        const val STATE_CONNECTING = "connecting"
        const val STATE_LISTENING = "listening"
        const val STATE_RECONNECTING = "reconnecting"
        const val STATE_RETRYING = "retrying"
        /** 网页用同一身份收回了房间。 */
        const val STATE_TAKEN_OVER = "taken_over"
        const val STATE_FAILED = "failed"
    }
}
