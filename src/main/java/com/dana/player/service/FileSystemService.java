package com.dana.player.service;

import com.dana.player.model.DanaTrack;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Scans the configured music folder for .dana files
 * and returns metadata about each one.
 */
@Service
public class FileSystemService {

    private static final Logger log = LoggerFactory.getLogger(FileSystemService.class);

    @Value("${dana.music.folder:./music}")
    private String musicFolder;

    /**
     * Returns all .dana files found in the configured folder.
     */
    public List<DanaTrack> listTracks() {
        List<DanaTrack> tracks = new ArrayList<>();

        Path folder = Paths.get(musicFolder).toAbsolutePath().normalize();
        log.info("Scanning folder: {}", folder);

        if (!Files.exists(folder)) {
            log.warn("Music folder does not exist: {}. Creating it.", folder);
            try {
                Files.createDirectories(folder);
            } catch (Exception e) {
                log.error("Cannot create music folder: {}", e.getMessage());
            }
            return tracks;
        }

        File[] files = folder.toFile().listFiles(
                (dir, name) -> name.toLowerCase().endsWith(".dana")
        );

        if (files == null || files.length == 0) {
            log.info("No .dana files found in: {}", folder);
            return tracks;
        }

        for (File file : files) {
            String filename    = file.getName();
            String nameNoExt   = filename.substring(0, filename.lastIndexOf('.'));
            // Use base64 of the filename as a URL-safe ID
            String id          = Base64.getUrlEncoder().withoutPadding()
                                       .encodeToString(filename.getBytes());
            tracks.add(new DanaTrack(id, nameNoExt, filename, file.getAbsolutePath()));
        }

        log.info("Found {} .dana file(s)", tracks.size());
        return tracks;
    }

    /**
     * Resolves a track ID back to its absolute path.
     * Validates the path is inside the music folder (path traversal protection).
     */
    public String resolveTrackPath(String trackId) {
        String filename = new String(Base64.getUrlDecoder().decode(trackId));

        // Security: ensure no path traversal
        if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
            throw new SecurityException("Invalid track ID");
        }

        Path folder     = Paths.get(musicFolder).toAbsolutePath().normalize();
        Path targetPath = folder.resolve(filename).normalize();

        // Double-check the resolved path is still inside the music folder
        if (!targetPath.startsWith(folder)) {
            throw new SecurityException("Path traversal attempt detected");
        }

        return targetPath.toString();
    }

    public String getMusicFolder() {
        return Paths.get(musicFolder).toAbsolutePath().normalize().toString();
    }
}
