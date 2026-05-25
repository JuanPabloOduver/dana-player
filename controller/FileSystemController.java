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
 * Notes about LibraryController and HealthController:
 * - Separation of concerns: In a larger API the "library" (search/filter/listing)
 *   and "health" (liveness/readiness) endpoints are usually placed in dedicated
 *   controllers (LibraryController, HealthController) to keep each controller focused.
 * - Why they may be empty / missing:
 *   * The project may intentionally keep a minimal single controller (this one)
 *     until more library features are required, so LibraryController isn't created yet.
 *   * Health endpoints are optional during early development; they are added when
 *     you need orchestration probes or diagnostics.
 * - When to extract:
 *   * Add LibraryController when you need search, filtering, per-track metadata endpoints,
 *     paging, or more complex library-related operations.
 *   * Add HealthController when you need standardized health/readiness endpoints for
 *     deployment orchestration or external monitoring.
 *
 * This FileSystemController provides basic listing and server info. Consider extracting
 * endpoints into dedicated controllers as the API surface grows.
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
