package com.llm.live2d

data class OverlayAuthSnapshot(
    val token: String,
    val aibooToken: String,
)

/** Thread-safe in-memory credentials for a WebView retained across strip requests. */
class OverlayAuthState(token: String, aibooToken: String) {
    @Volatile
    private var snapshot = OverlayAuthSnapshot(token, aibooToken)

    @Synchronized
    fun update(token: String, aibooToken: String) {
        snapshot = OverlayAuthSnapshot(token, aibooToken)
    }

    fun current(): OverlayAuthSnapshot = snapshot
}
