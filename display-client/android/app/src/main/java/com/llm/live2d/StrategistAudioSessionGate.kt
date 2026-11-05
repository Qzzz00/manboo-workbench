package com.llm.live2d

/** Single-owner completion gate shared by natural completion, error, stop, and replacement. */
class StrategistAudioSessionGate {
    class Session internal constructor(
        internal val release: () -> Unit,
        internal val abandonFocus: () -> Unit,
        internal val onDone: () -> Unit,
    ) {
        internal var finished = false
    }

    private val lock = Any()
    private var current: Session? = null

    fun begin(
        release: () -> Unit,
        abandonFocus: () -> Unit,
        onDone: () -> Unit,
    ): Session {
        val next = Session(release, abandonFocus, onDone)
        val previous = synchronized(lock) {
            current.also { current = next }
        }
        previous?.let(::finish)
        return next
    }

    fun finish(session: Session) {
        val shouldFinish = synchronized(lock) {
            if (session.finished) {
                false
            } else {
                session.finished = true
                if (current === session) current = null
                true
            }
        }
        if (!shouldFinish) return
        invokeSafely(session.release)
        invokeSafely(session.abandonFocus)
        invokeSafely(session.onDone)
    }

    fun stop() {
        val active = synchronized(lock) { current }
        active?.let(::finish)
    }

    fun isActive(session: Session): Boolean = synchronized(lock) {
        current === session && !session.finished
    }

    private fun invokeSafely(action: () -> Unit) {
        try {
            action()
        } catch (_: Throwable) {
            // Lifecycle cleanup is best-effort; one callback cannot block focus release or onDone.
        }
    }
}
