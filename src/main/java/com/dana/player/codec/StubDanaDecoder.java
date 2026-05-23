package com.dana.player.codec;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * STUB IMPLEMENTATION — Replace with the real .dana codec.
 *
 * This stub reads a real .dana file if it exists, treating its raw bytes
 * as PCM data (for testing). If the file doesn't exist, it generates
 * a synthetic stereo sine wave so the pipeline can be fully tested
 * without actual .dana files.
 *
 * IMPORTANT: Swap this class out with the real codec implementation
 * once the codec classes are available. The interface is DanaDecoder.
 */
@Component
public class StubDanaDecoder implements DanaDecoder {

    private static final int SAMPLE_RATE = 44100;
    private static final int CHANNELS    = 2;
    private static final int BIT_DEPTH   = 16;

    // Sine wave generation state (used when no real file is loaded)
    private long    sampleIndex = 0;
    private long    totalSamples;   // duration * sampleRate * channels
    private boolean useSineWave = false;
    private boolean done        = false;

    // Real file reading state
    private RandomAccessFile fileHandle;
    private long             fileSize;
    private long             bytesRead;

    @Override
    public void open(String filePath) throws IOException {
        sampleIndex = 0;
        done        = false;
        bytesRead   = 0;

        try {
            fileHandle  = new RandomAccessFile(filePath, "r");
            fileSize    = fileHandle.length();
            useSineWave = false;
            System.out.println("[StubDecoder] Opened file: " + filePath + " (" + fileSize + " bytes)");
        } catch (IOException e) {
            // Fallback: generate a 30-second stereo sine wave
            System.out.println("[StubDecoder] File not found, generating synthetic audio: " + filePath);
            useSineWave  = true;
            totalSamples = (long) SAMPLE_RATE * 30 * CHANNELS; // 30 seconds
        }
    }

    @Override
    public byte[] readNextChunk(int chunkSize) throws IOException {
        if (done) return new byte[0];

        if (useSineWave) {
            return readSineChunk(chunkSize);
        } else {
            return readFileChunk(chunkSize);
        }
    }

    private byte[] readSineChunk(int chunkSize) {
        // Each PCM frame = 2 bytes (16-bit) * 2 channels = 4 bytes
        int framesToGenerate = chunkSize / (BIT_DEPTH / 8 * CHANNELS);
        if (framesToGenerate == 0) framesToGenerate = 1;

        ByteBuffer buf = ByteBuffer.allocate(framesToGenerate * (BIT_DEPTH / 8) * CHANNELS);
        buf.order(ByteOrder.LITTLE_ENDIAN);

        double frequency = 440.0; // A4

        for (int i = 0; i < framesToGenerate; i++) {
            if (sampleIndex >= totalSamples / CHANNELS) {
                done = true;
                break;
            }
            double t       = (double) sampleIndex / SAMPLE_RATE;
            short  sample  = (short) (Short.MAX_VALUE * 0.6 * Math.sin(2.0 * Math.PI * frequency * t));
            buf.putShort(sample); // Left channel
            buf.putShort(sample); // Right channel
            sampleIndex++;
        }

        byte[] result = new byte[buf.position()];
        buf.rewind();
        buf.get(result);
        return result;
    }

    private byte[] readFileChunk(int chunkSize) throws IOException {
        long remaining = fileSize - bytesRead;
        if (remaining <= 0) {
            done = true;
            return new byte[0];
        }

        int toRead = (int) Math.min(chunkSize, remaining);
        byte[] chunk = new byte[toRead];
        int actualRead = fileHandle.read(chunk);

        if (actualRead <= 0) {
            done = true;
            return new byte[0];
        }

        bytesRead += actualRead;

        if (actualRead < toRead) {
            // Partial read at EOF
            byte[] trimmed = new byte[actualRead];
            System.arraycopy(chunk, 0, trimmed, 0, actualRead);
            done = true;
            return trimmed;
        }

        return chunk;
    }

    @Override
    public boolean hasMore() {
        return !done;
    }

    @Override
    public void close() throws IOException {
        done = true;
        if (fileHandle != null) {
            fileHandle.close();
            fileHandle = null;
        }
    }

    @Override
    public int getSampleRate() { return SAMPLE_RATE; }

    @Override
    public int getChannels() { return CHANNELS; }

    @Override
    public int getBitDepth() { return BIT_DEPTH; }
}
