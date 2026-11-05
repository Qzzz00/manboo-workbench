package ai.ben.butler

/**
 * 「这是哪个网络」的标识(2026-10-21,局域网 M4)。路线规格靠它记「她确认过的家里 / 办公室的网」。
 *
 * 为什么不用 Wi-Fi 名:安卓读 Wi-Fi 名(SSID)要定位权限,这个 App 不要定位(manifest 蓝牙那一段写了为什么)。
 * 所以取这个网络**自己报的**几样:缺省路由的网关地址、本机地址的网段长度、DHCP 给的 DNS 域名。
 * 两个网关地址一样的网络(都是 192.168.1.1/24)会被认成同一个 —— 判在家另有一条「答话的是配对过的那台 Mac」兜着
 * (规格第二节),代价写在 src/channel/networkWatch.ts 的文件头。
 *
 * 纯函数,单测在 NetworkIdTest.kt。
 */
object NetworkId {
    /** 网关地址、网段长度、DNS 域名 → `lan:192.168.1.1/24` 或 `lan:10.0.0.1/24;corp.example`。没有网关(读不到)回 null。 */
    fun of(gateway: String?, prefixLength: Int?, domain: String?): String? {
        val gw = gateway?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val prefix = prefixLength?.takeIf { it in 1..128 }
        val dom = domain?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        return buildString {
            append("lan:").append(gw)
            if (prefix != null) append('/').append(prefix)
            if (dom != null) append(';').append(dom)
        }
    }

    /** 给人看的那一个:`网关 192.168.1.1`。 */
    fun label(gateway: String?): String? = gateway?.trim()?.takeIf { it.isNotEmpty() }?.let { "网关 $it" }
}
