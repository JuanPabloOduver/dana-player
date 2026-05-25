package com.dana.player.controller;

import com.dana.player.dto.PlaybackStateDto;
import com.dana.player.service.PlaybackService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/*
 * PlaybackController: controls play/pause/stop and exposes playback state.
 *
 * Context note:
 * - This controller focuses strictly on playback commands and state.
 * - LibraryController (if/when created) would focus on searching, browsing,
 *   and per-track metadata; HealthController would expose liveness/readiness.
 * - Keeping these concerns separate makes the API easier to evolve and test.
 */

/**
 * REST API for playback control and status.
 *
 * GET  /api/playback/status      → current playback state
 * POST /api/playback/play         → start playing a track
 * POST /api/playback/pause        → pause current playback
 * POST /api/playback/resume       → resume paused playback
 * POST /api/playback/stop         → stop current playback
 * GET  /api/playback/current      → get currently playing track info
 */
@RestController
@RequestMapping("/api/playback")
public class PlaybackController {

    private final PlaybackService playbackService;

    public PlaybackController(PlaybackService playbackService) {
        this.playbackService = playbackService;
    }

    /**
     * Get the current playback state.
     */
    @GetMapping("/status")
    public ResponseEntity<PlaybackStateDto> getStatus() {
        PlaybackStateDto state = playbackService.getCurrentState();
        return ResponseEntity.ok(state);
    }

    /**
     * Start playing a track (identified by trackId).
     */
    @PostMapping("/play")
    public ResponseEntity<Map<String, String>> play(@RequestParam String trackId) {
        playbackService.play(trackId);
        Map<String, String> response = new HashMap<>();
        response.put("status", "playing");
        response.put("trackId", trackId);
        return ResponseEntity.ok(response);
    }

    /**
     * Pause current playback.
     */
    @PostMapping("/pause")
    public ResponseEntity<Map<String, String>> pause() {
        playbackService.pause();
        Map<String, String> response = new HashMap<>();
        response.put("status", "paused");
        return ResponseEntity.ok(response);
    }

    /**
     * Resume paused playback.
     */
    @PostMapping("/resume")
    public ResponseEntity<Map<String, String>> resume() {
        playbackService.resume();
        Map<String, String> response = new HashMap<>();
        response.put("status", "resumed");
        return ResponseEntity.ok(response);
    }

    /**
     * Stop current playback.
     */
    @PostMapping("/stop")
    public ResponseEntity<Map<String, String>> stop() {
        playbackService.stop();
        Map<String, String> response = new HashMap<>();
        response.put("status", "stopped");
        return ResponseEntity.ok(response);
    }

    /**
     * Get info about the currently playing track.
     */
    @GetMapping("/current")
    public ResponseEntity<Map<String, Object>> getCurrentTrack() {
        Map<String, Object> current = playbackService.getCurrentTrackInfo();
        if (current.isEmpty()) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(current);
    }
}
