package com.dana.player.controller;

import com.dana.player.model.DanaTrack;
import com.dana.player.service.FileSystemService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST API for browsing the music library.
 *
 * GET /api/tracks  → list all .dana files
 * GET /api/info    → player info (folder path, buffer config)
 */
@RestController
@RequestMapping("/api")
public class FileSystemController {

    private final FileSystemService fileSystemService;

    public FileSystemController(FileSystemService fileSystemService) {
        this.fileSystemService = fileSystemService;
    }

    /**
     * Returns the list of all available .dana tracks.
     */
    @GetMapping("/tracks")
    public ResponseEntity<List<DanaTrack>> getTracks() {
        List<DanaTrack> tracks = fileSystemService.listTracks();
        return ResponseEntity.ok(tracks);
    }

    /**
     * Returns server info useful for the UI.
     */
    @GetMapping("/info")
    public ResponseEntity<Map<String, Object>> getInfo() {
        Map<String, Object> info = new HashMap<>();
        info.put("folder",      fileSystemService.getMusicFolder());
        info.put("sampleRate",  44100);
        info.put("channels",    2);
        info.put("bitDepth",    16);
        info.put("status",      "running");
        return ResponseEntity.ok(info);
    }
}
