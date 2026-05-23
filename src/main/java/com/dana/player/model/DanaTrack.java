package com.dana.player.model;

/**
 * Represents a single .dana audio track on the filesystem.
 */
public class DanaTrack {

    private String id;       // sanitized filename used as identifier
    private String name;     // display name (filename without extension)
    private String filename; // e.g. "song.dana"
    private String path;     // absolute path on server

    public DanaTrack() {}

    public DanaTrack(String id, String name, String filename, String path) {
        this.id       = id;
        this.name     = name;
        this.filename = filename;
        this.path     = path;
    }

    // ---- Getters & Setters ----

    public String getId()       { return id; }
    public void   setId(String id) { this.id = id; }

    public String getName()     { return name; }
    public void   setName(String name) { this.name = name; }

    public String getFilename() { return filename; }
    public void   setFilename(String filename) { this.filename = filename; }

    public String getPath()     { return path; }
    public void   setPath(String path) { this.path = path; }
}
