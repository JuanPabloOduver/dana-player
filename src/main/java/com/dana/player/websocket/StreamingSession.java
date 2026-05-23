package com.dana.player.websocket;

import com.dana.player.buffer.CircularBuffer;
import com.dana.player.buffer.CodecProducer;
import com.dana.player.buffer.WebSocketConsumer;

/**
 * Encapsulates a single active playback session:
 * one producer thread decoding a track + one consumer thread streaming it.
 *
 * Call stop() to cancel both threads (e.g., on skip or disconnect).
 */
public class StreamingSession {

    private final CircularBuffer<byte[]> buffer;
    private final CodecProducer          producer;
    private final WebSocketConsumer      consumer;
    private final Thread                 producerThread;
    private final Thread                 consumerThread;
    private final String                 trackId;

    public StreamingSession(CircularBuffer<byte[]> buffer,
                            CodecProducer producer,
                            WebSocketConsumer consumer,
                            String trackId) {
        this.buffer   = buffer;
        this.producer = producer;
        this.consumer = consumer;
        this.trackId  = trackId;

        this.producerThread = new Thread(producer, "producer-" + trackId);
        this.consumerThread = new Thread(consumer, "consumer-" + trackId);

        this.producerThread.setDaemon(true);
        this.consumerThread.setDaemon(true);
    }

    /** Starts both threads. Call once after constructing. */
    public void start() {
        producerThread.start();
        consumerThread.start();
    }

    /**
     * Stops both threads gracefully.
     * Safe to call multiple times.
     */
    public void stop() {
        producer.cancel();
        consumer.cancel();
        buffer.close();

        producerThread.interrupt();
        consumerThread.interrupt();
    }

    public String getTrackId() {
        return trackId;
    }

    public boolean isProducerAlive() {
        return producerThread.isAlive();
    }

    public boolean isConsumerAlive() {
        return consumerThread.isAlive();
    }
}
