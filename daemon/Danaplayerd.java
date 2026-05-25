package com.dana.daemon;

// ═══════════════════════════════════════════════════════════════════════════
//  danaplayerd — Dana Decoder Daemon
//
//  Proceso independiente que expone el codec .dana a través de un
//  Unix Domain Socket en /tmp/danaplayerd.sock.
//
//  Responsabilidades:
//    - Abrir y mantener el Unix Domain Socket como servidor
//    - Aceptar conexiones del cliente Electron
//    - Leer comandos JSON length-prefixed del cliente
//    - Ejecutar el codec en un hilo Productor → pila circular → hilo Consumidor
//    - Enviar frames PCM crudos y frames JSON de control al cliente
//
//  Protocolo de frame (ambas direcciones):
//    [4 bytes: uint32 big-endian = longitud del payload] [N bytes: payload]
//
//    Payload JSON  → comienza con '{'  → mensaje de control
//    Payload binario → cualquier otro byte → PCM crudo 16-bit LE estéreo
//
//  Para conectar el codec real:
//    1. Implementar la interfaz DanaDecoder (al final de este archivo)
//    2. En startProducer(), cambiar `new StubDecoder()` por la implementación real
//       (buscar el bloque marcado con // [CODEC])
//
//  Requisitos: Java 17+ (UnixDomainSocketAddress disponible desde Java 16)
//  Compilar:   javac Danaplayerd.java
//  Ejecutar:   java com.dana.daemon.Danaplayerd
// ═══════════════════════════════════════════════════════════════════════════

import java.io.*;
import java.net.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Danaplayerd {

    // ── Configuración ──────────────────────────────────────────────────────
    static final String SOCK_PATH   = System.getenv().getOrDefault("DANA_SOCK", "/tmp/danaplayerd.sock");
    static final int    CHUNK_BYTES = 4096;  // ~23ms a 44100Hz/16bit/estéreo
    static final int    BUF_CAP     = 64;    // capacidad de la pila circular (chunks)

    // ── Estado global ──────────────────────────────────────────────────────
    static final AtomicBoolean running = new AtomicBoolean(true);
    static volatile SocketChannel clientChannel = null;

    // ── Pila circular (Productor → Consumidor) ────────────────────────────
    static ArrayBlockingQueue<byte[]> circularBuf = null;
    static volatile boolean           bufOpen     = false;

    // ── Hilo productor ────────────────────────────────────────────────────
    static volatile Thread      producerThread = null;
    static volatile DanaDecoder decoder        = null;
    static final AtomicBoolean  paused         = new AtomicBoolean(false);
    static final AtomicBoolean  stopped        = new AtomicBoolean(false);

    // ─────────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        Path sockFile = Path.of(SOCK_PATH);
        Files.deleteIfExists(sockFile);

        UnixDomainSocketAddress addr   = UnixDomainSocketAddress.of(sockFile);
        ServerSocketChannel     server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(addr);
        server.configureBlocking(true);

        System.out.println("[danaplayerd] Socket abierto en " + SOCK_PATH);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            running.set(false);
            try { server.close(); Files.deleteIfExists(sockFile); } catch (Exception ignored) {}
            System.out.println("[danaplayerd] Detenido.");
        }));

        while (running.get()) {
            System.out.println("[danaplayerd] Esperando cliente…");
            clientChannel = server.accept();
            System.out.println("[danaplayerd] Cliente conectado.");
            try {
                handleClient(clientChannel);
            } catch (Exception e) {
                System.err.println("[danaplayerd] Error de cliente: " + e.getMessage());
            } finally {
                stopProducer();
                try { clientChannel.close(); } catch (Exception ignored) {}
                clientChannel = null;
                System.out.println("[danaplayerd] Cliente desconectado.");
            }
        }
    }

    // ── Bucle de comandos ─────────────────────────────────────────────────
    static void handleClient(SocketChannel ch) throws Exception {
        DataInputStream in = new DataInputStream(Channels.newInputStream(ch));

        while (ch.isOpen()) {
            int len;
            try { len = in.readInt(); }
            catch (EOFException e) { break; }

            if (len <= 0 || len > 1_048_576) {
                System.err.println("[danaplayerd] Longitud de frame inválida: " + len);
                break;
            }

            byte[] payload = new byte[len];
            in.readFully(payload);
            handleCommand(new String(payload, StandardCharsets.UTF_8), ch);
        }
    }

    static void handleCommand(String json, SocketChannel ch) throws Exception {
        String cmd  = extractString(json, "cmd");
        String path = extractString(json, "path");

        System.out.println("[CMD] " + cmd + (path != null ? " → " + path : ""));

        switch (cmd != null ? cmd : "") {
            case "load_play" -> {
                stopProducer();
                if (circularBuf != null) circularBuf.clear();
                startProducer(path, ch);
            }
            case "pause" -> {
                paused.set(true);
                sendJson(ch, "{\"type\":\"paused\"}");
            }
            case "resume" -> {
                paused.set(false);
                sendJson(ch, "{\"type\":\"resumed\"}");
            }
            case "stop" -> {
                stopProducer();
                sendJson(ch, "{\"type\":\"stopped\"}");
            }
            case "get_metadata" -> {
                // El codec real debe leer los metadatos del header del archivo .dana
                // y completar los valores reales de sampleRate, channels, bitDepth y durationMs.
                String fileSafe = path == null ? "" : path.replace("\"", "\\\"");
                sendJson(ch, String.format(
                    "{\"type\":\"metadata\",\"data\":{\"sampleRate\":44100,\"channels\":2,\"bitDepth\":16,\"durationMs\":0,\"path\":\"%s\"}}",
                    fileSafe
                ));
            }
            case "request_chunk" -> {
                if (circularBuf != null) {
                    byte[] chunk = circularBuf.poll(50, TimeUnit.MILLISECONDS);
                    if (chunk != null && chunk.length > 0) sendPcm(ch, chunk);
                }
            }
            case "buffer_open" -> {
                circularBuf = new ArrayBlockingQueue<>(BUF_CAP);
                bufOpen     = true;
                sendJson(ch, "{\"type\":\"buffer_open\"}");
            }
            case "buffer_close" -> {
                stopProducer();
                circularBuf = null;
                bufOpen     = false;
                sendJson(ch, "{\"type\":\"buffer_close\"}");
            }
            default -> System.err.println("[danaplayerd] Comando desconocido: " + cmd);
        }
    }

    // ── Productor + Consumidor ────────────────────────────────────────────
    static void startProducer(String filePath, SocketChannel ch) {
        stopped.set(false);
        paused.set(false);

        if (circularBuf == null) {
            circularBuf = new ArrayBlockingQueue<>(BUF_CAP);
            bufOpen     = true;
        }

        // [CODEC] ─────────────────────────────────────────────────────────
        // Sustituir StubDecoder por la implementación real del codec .dana.
        // La clase debe implementar la interfaz DanaDecoder definida al final
        // de este archivo.
        decoder = new StubDecoder();
        // ─────────────────────────────────────────────────────────────────

        producerThread = new Thread(() -> {
            try {
                decoder.open(filePath);

                // Hilo Consumidor: extrae de la pila circular y envía PCM al cliente
                Thread consumerThread = new Thread(() -> {
                    try {
                        while (!stopped.get() || !circularBuf.isEmpty()) {
                            while (paused.get() && !stopped.get()) Thread.sleep(10);
                            byte[] chunk = circularBuf.poll(100, TimeUnit.MILLISECONDS);
                            if (chunk == null) continue;
                            if (chunk.length == 0) break; // pill de veneno → fin de stream
                            sendPcm(ch, chunk);
                        }
                        if (!stopped.get()) {
                            sendJson(ch, "{\"type\":\"track_end\"}");
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } catch (Exception e) {
                        System.err.println("[Consumidor] " + e.getMessage());
                    }
                }, "dana-consumer");
                consumerThread.setDaemon(true);
                consumerThread.start();

                // Hilo Productor: decodifica y llena la pila circular
                while (!stopped.get() && decoder.hasMore()) {
                    while (paused.get() && !stopped.get()) Thread.sleep(5);
                    byte[] chunk = decoder.readNextChunk(CHUNK_BYTES);
                    if (chunk == null || chunk.length == 0) break;
                    circularBuf.put(chunk); // bloquea si la pila está llena (backpressure)
                }

                circularBuf.put(new byte[0]); // pill de veneno para el consumidor
                consumerThread.join(5000);

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                System.err.println("[Productor] " + e.getMessage());
                try {
                    sendJson(ch, "{\"type\":\"error\",\"message\":\"" +
                        e.getMessage().replace("\"", "'") + "\"}");
                } catch (Exception ignored) {}
            } finally {
                if (decoder != null) {
                    try { decoder.close(); } catch (Exception ignored) {}
                }
            }
        }, "dana-producer");
        producerThread.setDaemon(true);
        producerThread.start();
    }

    static void stopProducer() {
        stopped.set(true);
        if (producerThread != null) {
            producerThread.interrupt();
            producerThread = null;
        }
        if (circularBuf != null) circularBuf.clear();
    }

    // ── Envío de frames al cliente ────────────────────────────────────────
    static synchronized void sendJson(SocketChannel ch, String json) throws Exception {
        if (ch == null || !ch.isOpen()) return;
        byte[]     payload = json.getBytes(StandardCharsets.UTF_8);
        ByteBuffer frame   = ByteBuffer.allocate(4 + payload.length);
        frame.putInt(payload.length);
        frame.put(payload);
        frame.flip();
        while (frame.hasRemaining()) ch.write(frame);
    }

    static synchronized void sendPcm(SocketChannel ch, byte[] pcm) {
        if (ch == null || !ch.isOpen() || pcm.length == 0) return;
        try {
            ByteBuffer frame = ByteBuffer.allocate(4 + pcm.length);
            frame.putInt(pcm.length);
            frame.put(pcm);
            frame.flip();
            while (frame.hasRemaining()) ch.write(frame);
        } catch (Exception e) {
            System.err.println("[sendPcm] " + e.getMessage());
        }
    }

    // ── Extractor JSON minimalista (sin dependencias externas) ─────────────
    static String extractString(String json, String key) {
        String pat = "\"" + key + "\":\"";
        int s = json.indexOf(pat);
        if (s < 0) return null;
        s += pat.length();
        int e = json.indexOf('"', s);
        return e < 0 ? null : json.substring(s, e);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Interfaz DanaDecoder
    //
    //  Contrato que debe cumplir la implementación del codec .dana.
    //  Sustituir StubDecoder por la clase concreta en startProducer().
    // ═══════════════════════════════════════════════════════════════════════
    interface DanaDecoder {
        /** Abre el archivo .dana en filePath y prepara el estado interno del codec. */
        void open(String filePath) throws Exception;

        /**
         * Decodifica y devuelve hasta `size` bytes de PCM crudo.
         * Formato de salida: 16-bit signed, little-endian, 44100 Hz, estéreo (interleaved L/R).
         * Devuelve un array vacío (length == 0) al llegar a EOF.
         */
        byte[] readNextChunk(int size) throws Exception;

        /** Devuelve true mientras haya datos sin decodificar en el archivo. */
        boolean hasMore();

        /** Libera todos los recursos del codec (handles de archivo, buffers internos, etc.). */
        void close() throws Exception;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  StubDecoder — generador de prueba (tono senoidal 440 Hz, 30 segundos)
    //
    //  Permite verificar toda la pipeline de audio de forma autónoma antes
    //  de conectar el codec real. Sustituir por DanaDecoder real en producción.
    // ═══════════════════════════════════════════════════════════════════════
    static class StubDecoder implements DanaDecoder {

        private static final int    SAMPLE_RATE = 44100;
        private static final double FREQ_HZ     = 440.0;
        private static final int    DURATION_S  = 30;

        private long    sampleIndex = 0;
        private final long totalFrames = (long) SAMPLE_RATE * DURATION_S;
        private boolean done = false;

        @Override
        public void open(String filePath) {
            sampleIndex = 0;
            done        = false;
            System.out.println("[StubDecoder] Generando tono de prueba para: " + filePath);
        }

        @Override
        public byte[] readNextChunk(int size) {
            int frames = size / 4; // 4 bytes por frame estéreo (2 × int16)
            if (sampleIndex + frames >= totalFrames) {
                frames = (int) (totalFrames - sampleIndex);
                done   = true;
            }
            if (frames <= 0) return new byte[0];

            ByteBuffer buf = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < frames; i++) {
                double t = (double) (sampleIndex + i) / SAMPLE_RATE;
                short  s = (short) (Short.MAX_VALUE * 0.5 * Math.sin(2.0 * Math.PI * FREQ_HZ * t));
                buf.putShort(s); // canal izquierdo
                buf.putShort(s); // canal derecho
            }
            sampleIndex += frames;
            return buf.array();
        }

        @Override public boolean hasMore() { return !done; }
        @Override public void close()      { done = true;  }
    }
}
