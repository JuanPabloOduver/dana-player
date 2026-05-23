package com.dana.player.buffer;

import com.dana.player.codec.DanaDecoder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Producer Thread — Codec → CircularBuffer
 *
 * Runs on its own thread. Calls the DanaDecoder repeatedly,
 * reads PCM chunks, and puts them into the CircularBuffer.
 *
 * If the buffer is full, put() blocks (backpressure) — the producer
 * will naturally slow down instead of consuming unbounded memory.
 *
 * A sentinel value (POISON_PILL) is enqueued at EOF to signal
 * the consumer that the stream is over.
 */
public class CodecProducer implements Runnable {

    private static final Logger log = LoggerFactory.getLogger(CodecProducer.class);

    /** Special marker placed in the buffer to signal end of stream. */
    public static final byte[] POISON_PILL = new byte[0];

    private final DanaDecoder      decoder;
    private final CircularBuffer<byte[]> buffer;
    private final String           filePath;
    private final int              chunkSize;
    private volatile boolean       cancelled = false;

    public CodecProducer(DanaDecoder decoder,
                         CircularBuffer<byte[]> buffer,
                         String filePath,
                         int chunkSize) {
        this.decoder   = decoder;
        this.buffer    = buffer;
        this.filePath  = filePath;
        this.chunkSize = chunkSize;
    }

    @Override
    public void run() {
        log.info("[Producer] Starting decode: {}", filePath);
        try {
            decoder.open(filePath);

            while (!cancelled && decoder.hasMore()) {
                byte[] chunk = decoder.readNextChunk(chunkSize);

                if (chunk == null || chunk.length == 0) {
                    break; // EOF
                }

                buffer.put(chunk); // blocks if buffer is full — this is the backpressure
            }

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.info("[Producer] Interrupted, stopping: {}", filePath);
        } catch (Exception e) {
            log.error("[Producer] Decoding error on file {}: {}", filePath, e.getMessage(), e);
        } finally {
            try {
                decoder.close();
            } catch (Exception e) {
                log.warn("[Producer] Error closing decoder: {}", e.getMessage());
            }
            // Always enqueue poison pill so the consumer knows to stop
            try {
                buffer.put(POISON_PILL);
                log.info("[Producer] Done, poison pill sent: {}", filePath);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Signals the producer to stop at the next opportunity.
     * Call this when the user skips or stops playback.
     */
    public void cancel() {
        this.cancelled = true;
    }
}
