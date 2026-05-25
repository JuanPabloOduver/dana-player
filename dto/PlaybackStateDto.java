package com.dana.player.dto;

/**
 * Data Transfer Object for playback state.
 */
public class PlaybackStateDto {
    private String status; // "idle", "playing", "paused"
    private String currentTrackId;
    private String currentTrackName;
    private long bufferSize;
    private int bufferCapacity;

    public PlaybackStateDto(String status, String currentTrackId, String currentTrackName, 
                           long bufferSize, int bufferCapacity) {
        this.status = status;
        this.currentTrackId = currentTrackId;
        this.currentTrackName = currentTrackName;
        this.bufferSize = bufferSize;
        this.bufferCapacity = bufferCapacity;
    }

    // Getters
    public String getStatus() { return status; }
    public String getCurrentTrackId() { return currentTrackId; }
    public String getCurrentTrackName() { return currentTrackName; }
    public long getBufferSize() { return bufferSize; }
    public int getBufferCapacity() { return bufferCapacity; }
}

