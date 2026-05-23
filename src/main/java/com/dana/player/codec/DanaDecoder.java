package com.dana.player.codec;

import java.io.IOException;
import java.io.InputStream;

/**
 * Contract for the custom .dana lossless codec decoder.
 *
 * The developer plugs in the real implementation here.
 * The decoder reads from an InputStream (the .dana file),
 * and exposes a stream of raw PCM bytes.
 *
 * Output format assumed: PCM 16-bit, 44100 Hz, Stereo (2 channels), Little-Endian.
 */
public interface DanaDecoder {

    /**
     * Opens the .dana file at the given path and prepares the decoder.
     *
     * @param filePath absolute path to the .dana file
     * @throws IOException if the file cannot be opened or the header is invalid
     */
    void open(String filePath) throws IOException;

    /**
     * Reads the next chunk of decoded raw PCM bytes.
     *
     * This method is called repeatedly by the producer thread.
     * It should block until a chunk is ready, or return null/empty
     * when the stream is fully decoded (EOF).
     *
     * @param chunkSize the desired number of bytes to read (hint, may return fewer at EOF)
     * @return a byte array with raw PCM data, or null/empty array when done
     * @throws IOException if a decoding error occurs
     */
    byte[] readNextChunk(int chunkSize) throws IOException;

    /**
     * Returns true if there are more bytes to decode.
     */
    boolean hasMore();

    /**
     * Releases any resources held by the decoder (file handles, buffers, etc).
     */
    void close() throws IOException;

    /**
     * Returns the sample rate of the decoded audio (e.g., 44100).
     */
    int getSampleRate();

    /**
     * Returns the number of channels (1 = mono, 2 = stereo).
     */
    int getChannels();

    /**
     * Returns the bit depth (e.g., 16).
     */
    int getBitDepth();
}
