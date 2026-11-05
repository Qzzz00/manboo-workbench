package ai.ben.butler

/**
 * 两路收铃的去重(2026-10-20,卡 E)。铃声 / 震动 / 来电通知只有一套(Ringer),网页那一路(App 在前台)
 * 和原生那一路(熄屏后,NativeRingListener)都往这里报;**按来电 id 认**:
 *
 *  - 同一通已经在响 → 不重响(网页亮屏回来,工人会把还在响的那一通补发一次,见 channel-worker 的 resendRingTo);
 *  - 刚收场的那几通 → 不再响(补发与收场在路上交错时,不让一通已经结束的电话又响起来);
 *  - 停铃带 id 只停那一通;不带 id 照旧全停(老调用方)。
 *
 * 纯的,没有 Android 依赖,用 JUnit 测。
 */
class RingBook(private val endedCap: Int = 32) {

    enum class Start { RING, ALREADY, ENDED }

    var ringing: String? = null
        private set

    private val ended = ArrayDeque<String>()

    fun start(callId: String): Start {
        if (callId == ringing) return Start.ALREADY
        if (callId in ended) return Start.ENDED
        ringing = callId
        return Start.RING
    }

    /** 回 true = 该把铃声 / 震动 / 来电通知停掉。 */
    fun stop(callId: String?): Boolean {
        if (callId == null) {
            ringing?.let { remember(it) }
            ringing = null
            return true
        }
        remember(callId)
        if (callId != ringing) return false
        ringing = null
        return true
    }

    private fun remember(callId: String) {
        if (callId in ended) return
        ended.addLast(callId)
        while (ended.size > endedCap) ended.removeFirst()
    }
}
