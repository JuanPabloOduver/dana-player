package com.dana.player.websocket;

import com.dana.player.buffer.CircularBuffer;
import com.dana.player.buffer.CodecProducer;
import com.dana.player.buffer.WebSocketConsumer;
import com.dana.player.codec.DanaDecoder;
import com.dana.player.codec.StubDanaDecoder;
import com.dana.player.service.FileSystemService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket Handler — /audio-stream
 *
 * Protocol (text messages from client → server):
 *
 *   PLAY:<trackId>   — start streaming the given track
 *   STOP             — stop current stream
 *
 * Binary messages flow server → client only (PCM chunks).
 *
 * One WebSocket session = one client. Multiple clients are supported.
 */
@Component
public class AudioStreamHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(AudioStreamHandler.class);

    @Value("${dana.buffer.capacity:32}")
    private int bufferCapacity;

    @Value("${dana.buffer.chunk-size:4096}")
    private int chunkSize;

    private final FileSystemService fileSystemService;

    /** Active streaming sessions keyed by WebSocket session ID */
    private final Map<String, StreamingSession> activeSessions = new ConcurrentHashMap<>();

    public AudioStreamHandler(FileSystemService fileSystemService) {
        this.fileSystemService = fileSystemService;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        log.info("[WS] Client connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload().trim();
        log.info("[WS] Message from {}: {}", session.getId(), payload);

        if (payload.startsWith("PLAY:")) {
            String trackId = payload.substring(5).trim();
            startStream(session, trackId);

        } else if (payload.equals("STOP")) {
            stopStream(session.getId());

        } else {
            log.warn("[WS] Unknown command: {}", payload);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        log.info("[WS] Client disconnected: {} ({})", session.getId(), status);
        stopStream(session.getId());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("[WS] Transport error on {}: {}", session.getId(), exception.getMessage());
        stopStream(session.getId());
    }

    // -----------------------------------------------------------------------

    private void startStream(WebSocketSession session, String trackId) {
        // Stop any previous stream for this session
        stopStream(session.getId());

        String filePath;
        try {
            filePath = fileSystemService.resolveTrackPath(trackId);
        } catch (Exception e) {
            log.error("[WS] Invalid trackId {}: {}", trackId, e.getMessage());
            sendText(session, "ERROR:Invalid track ID");
            return;
        }

        log.info("[WS] Starting stream: trackId={} file={}", trackId, filePath);

        // Build the pipeline
        CircularBuffer<byte[]> buffer  = new CircularBuffer<>(bufferCapacity);

        // NOTE: In production, inject/scope the real DanaDecoder bean here.
        // Using `new` here is intentional: each stream gets its own decoder instance.
        DanaDecoder decoder = new StubDanaDecoder();

        CodecProducer    producer = new CodecProducer(decoder, buffer, filePath, chunkSize);
        WebSocketConsumer consumer = new WebSocketConsumer(buffer, session, () -> {
            // Called when the track finishes playing naturally
            sendText(session, "TRACK_END:" + trackId);
            activeSessions.remove(session.getId());
            log.info("[WS] Track finished: {}", trackId);
        });

        StreamingSession streamSession = new StreamingSession(buffer, producer, consumer, trackId);
        activeSessions.put(session.getId(), streamSession);
        streamSession.start();

        sendText(session, "PLAYING:" + trackId);
    }

    private void stopStream(String sessionId) {
        StreamingSession existing = activeSessions.remove(sessionId);
        if (existing != null) {
            existing.stop();
            log.info("[WS] Stopped stream for session: {}", sessionId);
        }
    }

    private void sendText(WebSocketSession session, String text) {
        if (session.isOpen()) {
            try {
                session.sendMessage(new TextMessage(text));
            } catch (Exception e) {
                log.warn("[WS] Could not send text message: {}", e.getMessage());
            }
        }
    }
}
