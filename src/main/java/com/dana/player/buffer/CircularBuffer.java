package com.dana.player.buffer;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Thread-safe Circular Buffer backed by an ArrayBlockingQueue.
 *
 * This is the core of the Producer-Consumer pipeline.
 * The producer (codec thread) puts() decoded PCM chunks here.
 * The consumer (WebSocket thread) takes() chunks and sends them to the client.
 *
 * ArrayBlockingQueue is already circular and thread-safe under the hood —
 * it uses a single ReentrantLock with two Conditions (notFull, notEmpty)
 * for efficient blocking without busy-waiting.
 *
 * @param <T> typically byte[] for raw PCM data
 */
public class CircularBuffer<T> {

    private final ArrayBlockingQueue<T> queue;
    private final int capacity;
    private volatile boolean closed = false;

    /**
     * @param capacity maximum number of chunks the buffer can hold at once.
     *                 At 4096 bytes/chunk and 44100Hz/16bit/stereo (~23ms per chunk),
     *                 a capacity of 32 gives ~736ms of buffer — enough for network jitter
     *                 while keeping latency minimal.
     */
    public CircularBuffer(int capacity) {
        this.capacity = capacity;
        this.queue    = new ArrayBlockingQueue<>(capacity);
    }

    /**
     * Puts a chunk into the buffer. Blocks if the buffer is full (backpressure).
     * This prevents the producer from decoding too far ahead and wasting memory.
     *
     * @param chunk decoded PCM bytes from the codec
     * @throws InterruptedException if the thread is interrupted while waiting
     */
    public void put(T chunk) throws InterruptedException {
        if (closed) return;
        queue.put(chunk);
    }

    /**
     * Takes a chunk from the buffer. Blocks if the buffer is empty.
     * Returns null if the buffer has been closed and drained.
     *
     * @param timeoutMs how long to wait if empty before returning null
     * @return a chunk, or null on timeout / closed
     * @throws InterruptedException if interrupted
     */
    public T poll(long timeoutMs) throws InterruptedException {
        return queue.poll(timeoutMs, TimeUnit.MILLISECONDS);
    }

    /**
     * Closes the buffer and drains remaining contents.
     * Signals to the consumer that no more data will arrive.
     */
    public void close() {
        closed = true;
        queue.clear();
    }

    /**
     * Whether the buffer has been closed.
     */
    public boolean isClosed() {
        return closed;
    }

    /**
     * Current number of chunks waiting in the buffer.
     */
    public int size() {
        return queue.size();
    }

    /**
     * Maximum capacity of the buffer.
     */
    public int capacity() {
        return capacity;
    }
}
