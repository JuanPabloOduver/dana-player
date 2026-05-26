package com.dana.daemon;

// ═══════════════════════════════════════════════════════════════════════════
//  danaplayd — Dana Playback Daemon  (protocolo texto, MPD-style)
//
//  Implementa exactamente la API descrita en el documento de referencia:
//    IPC Integration Guide & API Reference (DANA Audio Codec Project, 2026)
//
//  Protocolo:
//    - Unix Domain Socket en /tmp/danaplayd.sock  (o $DANA_SOCK)
//    - Una conexión por comando: el cliente abre, envía "comando\n", recibe
//      la respuesta y el daemon cierra la conexión.
//    - Respuestas de texto terminan con \n.
//    - get_cover devuelve bytes binarios crudos (JPEG/PNG) o "NONE\n".
//
//  Comandos soportados:
//    play <filepath>   → OK
//    pause             → OK   (toggle PLAYING↔PAUSED)
//    stop              → OK
//    seek <segundos>   → OK
//    set_vol <0-200>   → OK
//    get_data          → JSON (DanaTags completo, ver sección 4 del doc)
//    get_cover         → bytes binarios o "NONE\n"
//    quit              → SHUTTING DOWN
//
//  Para conectar el codec real:
//    1. Implementar la interfaz DanaDecoder (al final de este archivo).
//    2. En startPlayback(), reemplazar `new StubDecoder()` por la
//       implementación real (bloque marcado con // [CODEC]).
//
//  Requisitos: Java 17+   (UnixDomainSocketAddress desde Java 16)
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
    static final String SOCK_PATH = System.getenv().getOrDefault("DANA_SOCK", "/tmp/danaplayd.sock");

    // ── Estado de reproducción ─────────────────────────────────────────────
    enum State { STOPPED, PLAYING, PAUSED }

    static volatile State          state       = State.STOPPED;
    static volatile String         currentFile = null;
    static volatile int            volume      = 100;   // 0–200
    static volatile int            elapsedSec  = 0;
    static volatile int            durationSec = 0;

    // Metadatos del track actual
    static volatile String  metaTitle    = "Unknown";
    static volatile String  metaArtist   = "Unknown";
    static volatile String  metaAlbum    = "Unknown";
    static volatile String  metaYear     = "";
    static volatile String  metaGenre    = "";
    static volatile String  metaTrack    = "";
    static volatile String  metaBpm      = "";
    static volatile String  metaKey      = "";
    static volatile String  metaLyrics   = "";
    static volatile boolean hasCover     = false;
    static volatile byte[]  coverBytes   = null;

    // ── Hilo de reproducción (productor + consumidor) ──────────────────────
    static final AtomicBoolean  pbRunning = new AtomicBoolean(false);
    static final AtomicBoolean  pbPaused  = new AtomicBoolean(false);
    static volatile Thread      pbThread  = null;
    static volatile DanaDecoder decoder   = null;

    // ── Servidor ───────────────────────────────────────────────────────────
    static final AtomicBoolean serverRunning = new AtomicBoolean(true);

    // ──────────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        Path sockFile = Path.of(SOCK_PATH);
        Files.deleteIfExists(sockFile);

        UnixDomainSocketAddress addr   = UnixDomainSocketAddress.of(sockFile);
        ServerSocketChannel     server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(addr);
        server.configureBlocking(true);

        System.out.println("[danaplayd] Socket listo en " + SOCK_PATH);
        System.out.println("[danaplayd] Protocolo: texto plano (MPD-style)");

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            serverRunning.set(false);
            stopPlayback();
            try { server.close(); Files.deleteIfExists(sockFile); } catch (Exception ignored) {}
            System.out.println("[danaplayd] Detenido limpiamente.");
        }));

        // Bucle principal: acepta una conexión, atiende UN comando, cierra.
        while (serverRunning.get()) {
            SocketChannel client;
            try {
                client = server.accept();
            } catch (ClosedChannelException e) {
                break;
            }
            try {
                handleConnection(client);
            } catch (Exception e) {
                System.err.println("[danaplayd] Error en conexión: " + e.getMessage());
            } finally {
                try { client.close(); } catch (Exception ignored) {}
            }
        }
    }

    // ── Manejo de una conexión (un comando por conexión) ───────────────────
    static void handleConnection(SocketChannel ch) throws Exception {
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(Channels.newInputStream(ch), StandardCharsets.UTF_8));

        String line = reader.readLine();
        if (line == null || line.isBlank()) return;

        line = line.trim();
        System.out.println("[CMD] " + line);

        if (line.startsWith("play ")) {
            String path = line.substring(5).trim();
            cmdPlay(path, ch);

        } else if (line.equals("pause")) {
            cmdPause(ch);

        } else if (line.equals("stop")) {
            cmdStop(ch);

        } else if (line.startsWith("seek ")) {
            String arg = line.substring(5).trim();
            cmdSeek(arg, ch);

        } else if (line.startsWith("set_vol ")) {
            String arg = line.substring(8).trim();
            cmdSetVol(arg, ch);

        } else if (line.equals("get_data")) {
            cmdGetData(ch);

        } else if (line.equals("get_cover")) {
            cmdGetCover(ch);

        } else if (line.equals("quit")) {
            sendText(ch, "SHUTTING DOWN");
            serverRunning.set(false);
            stopPlayback();
            System.exit(0);

        } else {
            sendText(ch, "ERROR: UNKNOWN COMMAND");
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Implementaciones de comandos
    // ══════════════════════════════════════════════════════════════════════

    // ── play <filepath> ────────────────────────────────────────────────────
    static void cmdPlay(String filePath, SocketChannel ch) throws Exception {
        if (filePath == null || filePath.isEmpty()) {
            sendText(ch, "ERROR: filepath required");
            return;
        }

        // Detener reproducción previa
        stopPlayback();

        // Resetear metadatos
        currentFile  = filePath;
        elapsedSec   = 0;
        metaTitle    = fileBaseName(filePath);
        metaArtist   = "Unknown";
        metaAlbum    = "Unknown";
        metaYear     = "";
        metaGenre    = "";
        metaTrack    = "";
        metaBpm      = "";
        metaKey      = "";
        metaLyrics   = "";
        hasCover     = false;
        coverBytes   = null;
        durationSec  = 0;
        state        = State.PLAYING;

        startPlayback(filePath);
        sendText(ch, "OK");
    }

    // ── pause (toggle PLAYING ↔ PAUSED) ───────────────────────────────────
    static void cmdPause(SocketChannel ch) throws Exception {
        if (state == State.PLAYING) {
            state = State.PAUSED;
            pbPaused.set(true);
            System.out.println("[danaplayd] Pausado.");
        } else if (state == State.PAUSED) {
            state = State.PLAYING;
            pbPaused.set(false);
            System.out.println("[danaplayd] Reanudado.");
        }
        // Si está STOPPED no hace nada, pero responde OK igualmente.
        sendText(ch, "OK");
    }

    // ── stop ───────────────────────────────────────────────────────────────
    static void cmdStop(SocketChannel ch) throws Exception {
        stopPlayback();
        state       = State.STOPPED;
        elapsedSec  = 0;
        currentFile = null;
        sendText(ch, "OK");
    }

    // ── seek <segundos> ────────────────────────────────────────────────────
    static void cmdSeek(String arg, SocketChannel ch) throws Exception {
        try {
            int target = Integer.parseInt(arg);
            if (decoder != null) {
                decoder.seek(target);
                elapsedSec = target;
            }
            // Si el decoder no soporta seek, ignoramos silenciosamente (doc: "safely ignore")
        } catch (NumberFormatException e) {
            sendText(ch, "ERROR: invalid seek value");
            return;
        }
        sendText(ch, "OK");
    }

    // ── set_vol <0-200> ────────────────────────────────────────────────────
    static void cmdSetVol(String arg, SocketChannel ch) throws Exception {
        try {
            int v = Integer.parseInt(arg);
            volume = Math.max(0, Math.min(200, v));
            if (decoder != null) decoder.setVolume(volume);
        } catch (NumberFormatException e) {
            sendText(ch, "ERROR: invalid volume value");
            return;
        }
        sendText(ch, "OK");
    }

    // ── get_data → JSON DanaTags ───────────────────────────────────────────
    static void cmdGetData(SocketChannel ch) throws Exception {
        String stateStr = switch (state) {
            case PLAYING -> "PLAYING";
            case PAUSED  -> "PAUSED";
            case STOPPED -> "STOPPED";
        };

        String json = buildDanaTagsJson(stateStr);
        sendText(ch, json);
    }

    // ── get_cover → bytes binarios o "NONE\n" ──────────────────────────────
    static void cmdGetCover(SocketChannel ch) throws Exception {
        if (!hasCover || coverBytes == null || coverBytes.length == 0) {
            sendText(ch, "NONE");
            return;
        }
        // Enviar los bytes crudos directamente (sin framing, sin base64)
        OutputStream out = Channels.newOutputStream(ch);
        out.write(coverBytes);
        out.flush();
        System.out.println("[get_cover] Enviados " + coverBytes.length + " bytes.");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Pipeline de reproducción
    // ══════════════════════════════════════════════════════════════════════

    static void startPlayback(String filePath) {
        pbRunning.set(true);
        pbPaused.set(false);

        // [CODEC] ──────────────────────────────────────────────────────────
        // Reemplazar StubDecoder por la implementación real del codec .dana.
        decoder = new StubDecoder();
        // ──────────────────────────────────────────────────────────────────

        pbThread = new Thread(() -> {
            try {
                decoder.open(filePath);

                // Leer metadatos del codec (cover, tags, duración)
                DanaMetadata meta = decoder.readMetadata();
                if (meta != null) {
                    if (meta.title    != null) metaTitle   = meta.title;
                    if (meta.artist   != null) metaArtist  = meta.artist;
                    if (meta.album    != null) metaAlbum   = meta.album;
                    if (meta.year     != null) metaYear    = meta.year;
                    if (meta.genre    != null) metaGenre   = meta.genre;
                    if (meta.track    != null) metaTrack   = meta.track;
                    if (meta.bpm      != null) metaBpm     = meta.bpm;
                    if (meta.key      != null) metaKey     = meta.key;
                    if (meta.lyrics   != null) metaLyrics  = meta.lyrics;
                    durationSec = meta.durationSec;
                    hasCover    = meta.hasCover;
                    coverBytes  = meta.coverBytes;
                }

                // Bucle de decodificación: mantiene elapsed actualizado
                // El audio real se reproduce por el sistema de audio del codec;
                // aquí solo medimos el tiempo para reportarlo en get_data.
                long startNano = System.nanoTime();
                int  startElapsed = elapsedSec;

                while (pbRunning.get() && decoder.hasMore()) {
                    while (pbPaused.get() && pbRunning.get()) Thread.sleep(10);
                    if (!pbRunning.get()) break;

                    decoder.decodeNextFrame();

                    // Actualizar elapsed desde el codec o por tiempo real
                    int reported = decoder.getElapsedSeconds();
                    elapsedSec = (reported >= 0) ? reported
                            : (startElapsed + (int)((System.nanoTime() - startNano) / 1_000_000_000L));
                }

                if (pbRunning.get()) {
                    // Llegó al final de forma natural
                    state      = State.STOPPED;
                    elapsedSec = durationSec;
                    System.out.println("[danaplayd] Track finalizado: " + filePath);
                }

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                System.err.println("[Playback] Error: " + e.getMessage());
                state = State.STOPPED;
            } finally {
                if (decoder != null) {
                    try { decoder.close(); } catch (Exception ignored) {}
                    decoder = null;
                }
            }
        }, "dana-playback");
        pbThread.setDaemon(true);
        pbThread.start();
    }

    static void stopPlayback() {
        pbRunning.set(false);
        pbPaused.set(false);
        if (pbThread != null) {
            pbThread.interrupt();
            try { pbThread.join(2000); } catch (InterruptedException ignored) {}
            pbThread = null;
        }
        if (decoder != null) {
            try { decoder.close(); } catch (Exception ignored) {}
            decoder = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ══════════════════════════════════════════════════════════════════════

    /** Envía texto + \n al cliente. */
    static void sendText(SocketChannel ch, String text) throws Exception {
        byte[] bytes = (text + "\n").getBytes(StandardCharsets.UTF_8);
        ByteBuffer buf = ByteBuffer.wrap(bytes);
        while (buf.hasRemaining()) ch.write(buf);
    }

    /** Construye el JSON de DanaTags según el esquema del documento (sección 4). */
    static String buildDanaTagsJson(String stateStr) {
        return "{"
                + "\"state\":"       + jsonStr(stateStr)   + ","
                + "\"file\":"        + jsonStr(currentFile != null ? currentFile : "") + ","
                + "\"title\":"       + jsonStr(metaTitle)  + ","
                + "\"artist\":"      + jsonStr(metaArtist) + ","
                + "\"album\":"       + jsonStr(metaAlbum)  + ","
                + "\"year\":"        + jsonStr(metaYear)   + ","
                + "\"genre\":"       + jsonStr(metaGenre)  + ","
                + "\"track\":"       + jsonStr(metaTrack)  + ","
                + "\"bpm\":"         + jsonStr(metaBpm)    + ","
                + "\"key\":"         + jsonStr(metaKey)    + ","
                + "\"lyrics\":"      + jsonStr(metaLyrics) + ","
                + "\"has_cover\":"   + hasCover            + ","
                + "\"time\":"        + elapsedSec          + ","
                + "\"duration\":"    + durationSec         + ","
                + "\"volume\":"      + volume
                + "}";
    }

    /** Escapa y envuelve un valor en comillas JSON. */
    static String jsonStr(String s) {
        if (s == null) return "\"\"";
        return "\"" + s
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t")
                + "\"";
    }

    /** Extrae el nombre base de un path (sin extensión). */
    static String fileBaseName(String path) {
        if (path == null) return "Unknown";
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String name = (slash >= 0) ? path.substring(slash + 1) : path;
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Interfaz DanaDecoder
    //
    //  Contrato que debe cumplir la implementación real del codec .dana.
    //  Reemplazar StubDecoder por la clase concreta en startPlayback().
    // ══════════════════════════════════════════════════════════════════════
    interface DanaDecoder {
        /** Abre el archivo y prepara el estado interno del codec. */
        void open(String filePath) throws Exception;

        /**
         * Lee los metadatos del header del archivo (DanaTags, cover art, etc.)
         * Llamar una sola vez justo después de open().
         * Puede devolver null si el codec no soporta metadatos todavía.
         */
        DanaMetadata readMetadata() throws Exception;

        /** Decodifica y reproduce el siguiente frame de audio. */
        void decodeNextFrame() throws Exception;

        /** Devuelve true mientras haya frames sin decodificar. */
        boolean hasMore();

        /**
         * Devuelve el tiempo reproducido en segundos según el codec,
         * o -1 si el codec no lleva cuenta (el daemon usará tiempo real).
         */
        int getElapsedSeconds();

        /**
         * Salta a la posición indicada (en segundos).
         * Si el archivo no tiene tabla de seek (SKTB), ignorar silenciosamente.
         */
        void seek(int seconds) throws Exception;

        /** Ajusta el volumen interno del codec (0–200). */
        void setVolume(int volume);

        /** Libera todos los recursos (handles de archivo, buffers, etc.). */
        void close() throws Exception;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  DanaMetadata — contenedor de metadatos devuelto por readMetadata()
    // ══════════════════════════════════════════════════════════════════════
    static class DanaMetadata {
        String  title, artist, album, year, genre, track, bpm, key, lyrics;
        int     durationSec;
        boolean hasCover;
        byte[]  coverBytes;   // null si no hay portada
    }

    // ══════════════════════════════════════════════════════════════════════
    //  StubDecoder — decodificador de prueba
    //
    //  Simula una pista de 30 segundos sin audio real.
    //  Permite verificar la pipeline de IPC antes de conectar el codec real.
    //  Reemplazar por DanaDecoder real en producción.
    // ══════════════════════════════════════════════════════════════════════
    static class StubDecoder implements DanaDecoder {

        private static final int DURATION_S = 30;
        private static final int SAMPLE_RATE = 44100;

        private long   frameIndex   = 0;
        private long   totalFrames  = (long) SAMPLE_RATE * DURATION_S;
        private boolean done        = false;
        private String  openedPath  = null;
        private int     volume      = 100;

        @Override
        public void open(String filePath) {
            frameIndex  = 0;
            done        = false;
            openedPath  = filePath;
            System.out.println("[StubDecoder] Abierto (stub): " + filePath);
        }

        @Override
        public DanaMetadata readMetadata() {
            DanaMetadata m = new DanaMetadata();
            m.title       = fileBaseName(openedPath);
            m.artist      = "Unknown";
            m.album       = "Unknown";
            m.year        = "";
            m.genre       = "";
            m.track       = "01";
            m.bpm         = "";
            m.key         = "";
            m.lyrics      = "";
            m.durationSec = DURATION_S;
            m.hasCover    = false;
            m.coverBytes  = null;
            return m;
        }

        @Override
        public void decodeNextFrame() throws Exception {
            if (done) return;
            // Simular tiempo de procesamiento de ~23ms por frame (4096 bytes a 44100Hz)
            Thread.sleep(23);
            frameIndex += (long)(SAMPLE_RATE * 0.023); // ~1021 samples por tick
            if (frameIndex >= totalFrames) done = true;
        }

        @Override public boolean hasMore()           { return !done; }
        @Override public int    getElapsedSeconds()  { return (int)(frameIndex / SAMPLE_RATE); }

        @Override
        public void seek(int seconds) {
            frameIndex = Math.min((long) seconds * SAMPLE_RATE, totalFrames);
            done       = frameIndex >= totalFrames;
            System.out.println("[StubDecoder] Seek a " + seconds + "s");
        }

        @Override public void setVolume(int v) { this.volume = v; }
        @Override public void close()          { done = true; }
    }
}