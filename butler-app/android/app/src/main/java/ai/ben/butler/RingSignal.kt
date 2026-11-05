package ai.ben.butler

import org.json.JSONObject

/**
 * 原生收铃认的那两条房间消息(2026-10-20,卡 E)。与网页那一份 butler-app/src/channel/channelProtocol.ts 的
 * `parseWbchInbound`(`ring` / `ring_end` 两支)同一个口径;两边的字符串由 tests/nativeRing.test.ts 读源头文件比对。
 *
 * 只认这两条:`call_state`(通话状态)只给网页画页面用,原生不画页面;别的(字幕、代理回包)与收铃无关。
 * 解不出就 null —— 网络上来的东西,一次抛异常就能把整个服务带走。
 */
object RingWire {
    /** 工人广播铃声用的文本流 topic(channel-worker/src/agent.ts 的 RPC_TOPIC)。 */
    const val RPC_TOPIC = "wb.rpc"

    /** 只认工人发的;房里别人说的一概不当来电。 */
    const val WORKER_IDENTITY = "wb-channel-worker"

    /** 来电理由那几句人话(与 src/call/incomingModel.ts 的 RING_REASON_TITLES 同一份)。 */
    val REASON_TITLES: Map<String, String> = mapOf(
        "confirm" to "等你确认",
        "failed" to "运行失败",
        "done" to "完成",
        "ask" to "等你回答",
        "relay" to "回话来了",
    )
}

sealed class RingSignal {
    abstract val callId: String

    data class Ring(
        override val callId: String,
        val reason: String,
        val title: String,
        val silent: Boolean,
        /** 响到这个时刻为止(毫秒,电脑的钟)。读不出来就 0。 */
        val until: Long,
        val note: String?,
    ) : RingSignal() {
        /** 通知上那一行,与网页来电页同一个写法。 */
        fun headline(): String = "${RingWire.REASON_TITLES[reason] ?: "事务官来电"} · $title"
    }

    data class End(override val callId: String, val outcome: String) : RingSignal()

    companion object {
        private val OUTCOMES = setOf("answered", "missed", "canceled", "hung_up")

        @JvmStatic
        fun parse(text: String): RingSignal? {
            val msg = try { JSONObject(text) } catch (_: Exception) { return null }
            val callId = (msg.opt("call_id") as? String)?.trim().orEmpty()
            if (callId.isEmpty()) return null
            return when (msg.opt("type")) {
                "ring" -> {
                    val reason = msg.opt("reason") as? String ?: return null
                    if (reason !in RingWire.REASON_TITLES) return null
                    val title = msg.opt("title") as? String ?: return null
                    val until = (msg.opt("until") as? Number)?.toDouble()?.takeIf { it.isFinite() }?.toLong() ?: 0L
                    val note = (msg.opt("note") as? String)?.trim()?.takeIf { it.isNotEmpty() }
                    Ring(callId, reason, title, msg.opt("silent") == true, until, note)
                }
                "ring_end" -> {
                    val outcome = msg.opt("outcome") as? String ?: return null
                    if (outcome !in OUTCOMES) return null
                    End(callId, outcome)
                }
                else -> null
            }
        }
    }
}
