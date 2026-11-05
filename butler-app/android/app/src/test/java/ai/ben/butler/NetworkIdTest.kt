package ai.ben.butler

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetworkIdTest {
    @Test
    fun gatewayPrefixAndDomain() {
        assertEquals("lan:192.168.1.1/24", NetworkId.of("192.168.1.1", 24, null))
        assertEquals("lan:10.86.37.1/23;corp.example", NetworkId.of("10.86.37.1", 23, " Corp.Example "))
    }

    @Test
    fun noGatewayMeansUnknown() {
        assertNull(NetworkId.of(null, 24, "x"))
        assertNull(NetworkId.of("  ", 24, null))
    }

    @Test
    fun badPrefixIsDropped() {
        assertEquals("lan:192.168.1.1", NetworkId.of("192.168.1.1", 0, ""))
    }

    @Test
    fun labelForPeople() {
        assertEquals("网关 192.168.1.1", NetworkId.label("192.168.1.1"))
        assertNull(NetworkId.label(null))
    }
}
