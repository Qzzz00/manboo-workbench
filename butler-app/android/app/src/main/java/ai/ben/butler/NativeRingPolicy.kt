package ai.ben.butler

/**
 * 原生收铃那条连接断了之后怎么办、一通铃响多久(2026-10-20,卡 E)。纯的,用 JUnit 测。
 *
 * 断开原因用 LiveKit `DisconnectReason` 的名字(字符串),这样这里不依赖 SDK。
 */
object NativeRingPolicy {

    sealed class Next {
        /** 不重连:我们自己离房的,或者网页用同一个身份收回了房间。 */
        data class Stop(val takenOver: Boolean) : Next()
        /** 隔一会儿再进。 */
        data class Retry(val delayMs: Long) : Next()
        /** 原生这一侧修不好了:如实说一句,等她打开 App(网页那条路能续凭证、能重配对)。 */
        data class GiveUp(val note: String) : Next()
    }

    /** 重连的几档(毫秒)。到顶就一直用最后一个:服务活着就一直试,网回来最多晚一分钟。 */
    @JvmField
    val BACKOFF_MS = longArrayOf(2_000, 5_000, 10_000, 20_000, 60_000)

    /** 凭证剩这么点就不再拿它进房(秒)。 */
    const val TOKEN_FLOOR_S = 60L

    const val EXPIRED_NOTE = "房间凭证到期了,熄屏时接不到电话:打开事务官,它会自己续一张"
    const val REMOVED_NOTE = "电脑那边把这台手机请出了房间,熄屏时接不到电话:打开事务官看看"

    @JvmStatic
    fun afterDisconnect(reason: String, failures: Int, expiresAtS: Long, nowS: Long): Next {
        when (reason) {
            "CLIENT_INITIATED" -> return Next.Stop(takenOver = false)
            "DUPLICATE_IDENTITY" -> return Next.Stop(takenOver = true)
            "PARTICIPANT_REMOVED", "ROOM_DELETED", "USER_REJECTED" -> return Next.GiveUp(REMOVED_NOTE)
        }
        if (expiresAtS - nowS <= TOKEN_FLOOR_S) return Next.GiveUp(EXPIRED_NOTE)
        val index = failures.coerceIn(0, BACKOFF_MS.size - 1)
        return Next.Retry(BACKOFF_MS[index])
    }

    /** 工人那一通响 60 秒(channel-worker/src/callOut.ts 的 RING_TIMEOUT_MS);没给 `until` 时按这个。 */
    const val DEFAULT_RING_MS = 60_000L

    /**
     * 一通铃最多响多久(毫秒),不论谁起的头。工人那边 60 秒一定收场并广播 `ring_end`;这一条是兜底:
     * 网页起的头、网页随后被冻住、`ring_end` 又恰好落在交接的空档里 —— 不兜底就会一直响下去。
     */
    const val MAX_RING_MS = 75_000L

    /** 按 `until`(电脑的钟)算还响多久;两台机器的钟差一两秒无所谓,上下各兜一刀。 */
    @JvmStatic
    fun ringTimeoutMs(untilMs: Long, nowMs: Long): Long {
        if (untilMs <= 0) return DEFAULT_RING_MS
        return (untilMs - nowMs).coerceIn(5_000L, MAX_RING_MS)
    }
}
