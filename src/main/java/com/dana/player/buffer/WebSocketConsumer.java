package com.dana.player.buffer;

import org.slf4j.Logger;
<parameter name="file_text">package com.dana.player.buffer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Consumer Thread — CircularBuffer → WebSocket
 *
 * Runs on its own thread. Pulls decoded PCM chunks from the CircularBuffer
 * and immediately sends them as binary WebSocket messages to the client.
 *
 * Stops when it receives the POISON_PILL from the producer,
 * or when cancel() is called externally (e.g., user skips track).
 */
public class WebSocketConsumer implements Runnable {

    private static final Logger log = LoggerFactory.getLogger(WebSocketConsumer.class);

    /** How long (ms) to wait on an empty buffer before checking if cancelled. */
    private static final long POLL_TIMEOUT_MS = 100;

    private final CircularBuffer<byte[]> buffer;
    private final WebSocketSession       session;
    private volatile boolean             cancelled = false;

    /** Callback invoked when the stream finishes (for auto-advance to next track). */
    private final Runnable onComplete;

    public WebSocketConsumer(CircularBuffer<byte[]> buffer,
                             WebSocketSession session,
                             Runnable onComplete) {
        this.buffer     = buffer;
        this.session    = session;
        this.onComplete = onComplete;
    }

    @Override
    public void run() {
        log.info("[Consumer] Starting stream to session: {}", session.getId());

        try {
            while (!cancelled) {
                byte[] chunk = buffer.poll(POLL_TIMEOUT_MS);

                if (chunk == null) {
                    // Timeout — check if cancelled and retry
                    continue;
                }

                // POISON_PILL signals end of track
                if (chunk == CodecProducer.POISON_PILL || chunk.length == 0) {
                    log.info("[Consumer] Received poison pill, stream complete.");
                    break;
                }

                // Send the raw PCM chunk over WebSocket
                if (session.isOpen()) {
                    try {
                        session.sendMessage(new BinaryMessage(ByteBuffer.wrap(chunk)));
                    } catch (IOException e) {
                        log.warn("[Consumer] WebSocket send error: {}", e.getMessage());
                        break; // Session likely closed
                    }
                } else {
                    log.info("[Consumer] Session closed, stopping.");
                    break;
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.info("[Consumer] Interrupted.");
        } finally {
            buffer.close();
            if (onComplete != null && !cancelled) {
                onComplete.run();
            }
            log.info("[Consumer] Stopped for session: {}", session.getId());
        }
    }

    /**
     * Cancels the consumer gracefully (e.g., user skipped track or disconnected).
     */
    public void cancel() {
        this.cancelled = true;
    }
}
