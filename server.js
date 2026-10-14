const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const archiver = require('archiver');

// ─── Setup ──────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TIMELAPSES_DIR = path.join(__dirname, 'timelapses');
fs.mkdirSync(TIMELAPSES_DIR, { recursive: true });

// Check FFmpeg (optional)
let ffmpegAvailable = false;
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  ffmpegAvailable = true;
  console.log('✓ FFmpeg found (optional video assembly enabled)');
} catch {
  console.log('ℹ FFmpeg not found — timelapse will export frames as a ZIP archive');
}

/** Package directory into a zip file */
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(output.bytesWritten));
    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ─── State ──────────────────────────────────────────────────────────────────────
let activeRecording = null;

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Validate that an IP string looks reasonable (no path traversal etc.) */
function validateIp(ip) {
  return /^[\d.]+$/.test(ip) || /^[a-zA-Z0-9.\-]+$/.test(ip);
}

/** Format seconds into human-readable duration */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format bytes into human-readable size */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Capture a single JPEG frame from the printer.
 * Goes directly to the MJPEG stream and extracts the first frame.
 * (The Adventurer 3 firmware does not support ?action=snapshot)
 */
function captureSnapshot(ip) {
  return captureFrameFromStream(ip);
}

/**
 * Grab the first complete JPEG frame from the MJPEG stream
 * by looking for SOI (0xFFD8) and EOI (0xFFD9) markers.
 */
function captureFrameFromStream(ip) {
  return new Promise((resolve, reject) => {
    const url = `http://${ip}:8080/?action=stream`;

    const req = http.get(url, { timeout: 10000 }, (res) => {
      let buffer = Buffer.alloc(0);

      res.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        const soiIndex = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (soiIndex >= 0) {
          const eoiIndex = buffer.indexOf(Buffer.from([0xff, 0xd9]), soiIndex + 2);
          if (eoiIndex >= 0) {
            const frame = buffer.slice(soiIndex, eoiIndex + 2);
            req.destroy();
            res.destroy();
            resolve(frame);
          }
        }

        // Safety: don't buffer more than 5 MB
        if (buffer.length > 5 * 1024 * 1024) {
          req.destroy();
          res.destroy();
          reject(new Error('Frame too large or not found'));
        }
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Stream timeout'));
    });
  });
}

// ─── API: Stream proxy ──────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  const ip = req.query.ip;
  if (!ip || !validateIp(ip)) {
    return res.status(400).json({ error: 'Valid printer IP is required' });
  }

  const url = `http://${ip}:8080/?action=stream`;

  const proxyReq = http.get(url, { timeout: 10000 }, (proxyRes) => {
    res.writeHead(200, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
    });
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.end());
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Cannot connect to printer camera', details: err.message });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Connection to printer timed out' });
    }
  });

  // Clean up when client disconnects
  req.on('close', () => proxyReq.destroy());
});

// ─── API: Connection test ───────────────────────────────────────────────────────

app.get('/api/test', async (req, res) => {
  const ip = req.query.ip;
  if (!ip || !validateIp(ip)) {
    return res.status(400).json({ error: 'Valid printer IP is required' });
  }

  try {
    const frame = await captureSnapshot(ip);
    res.json({ success: true, message: 'Camera connected', frameSize: frame.length });
  } catch (err) {
    res.status(502).json({ success: false, error: 'Cannot reach camera', details: err.message });
  }
});

// ─── API: Timelapse ─────────────────────────────────────────────────────────────

// Start recording
app.post('/api/timelapse/start', async (req, res) => {
  if (activeRecording) {
    return res.status(409).json({ error: 'A recording is already in progress' });
  }

  const { ip, interval = 10 } = req.body;
  if (!ip || !validateIp(ip)) {
    return res.status(400).json({ error: 'Valid printer IP is required' });
  }
  if (interval < 1 || interval > 3600) {
    return res.status(400).json({ error: 'Interval must be between 1 and 3600 seconds' });
  }

  // Test connection first
  try {
    await captureSnapshot(ip);
  } catch (err) {
    return res.status(502).json({ error: 'Cannot connect to printer camera', details: err.message });
  }

  const id = Date.now().toString();
  const framesDir = path.join(TIMELAPSES_DIR, id, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  let frameCount = 0;
  let lastError = null;
  const startTime = Date.now();

  const captureFrame = async () => {
    try {
      const buffer = await captureSnapshot(ip);
      const frameNum = String(frameCount).padStart(6, '0');
      const framePath = path.join(framesDir, `frame_${frameNum}.jpg`);
      fs.writeFileSync(framePath, buffer);
      frameCount++;
      lastError = null;
      console.log(`  📸 Frame ${frameCount} captured`);
    } catch (err) {
      lastError = err.message;
      console.error(`  ⚠ Frame capture error: ${err.message}`);
    }
  };

  // Capture first frame immediately
  await captureFrame();

  const timer = setInterval(captureFrame, interval * 1000);

  activeRecording = {
    id,
    ip,
    interval,
    framesDir,
    timer,
    startTime,
    getFrameCount: () => frameCount,
    getLastError: () => lastError,
  };

  console.log(`\n🔴 Timelapse recording started (ID: ${id}, interval: ${interval}s)`);
  res.json({ id, message: 'Timelapse recording started', frameCount });
});

// Stop recording and package frames as ZIP
app.post('/api/timelapse/stop', async (req, res) => {
  if (!activeRecording) {
    return res.status(404).json({ error: 'No active recording' });
  }

  clearInterval(activeRecording.timer);
  const { id, framesDir, getFrameCount, interval } = activeRecording;
  const frameCount = getFrameCount();
  activeRecording = null;

  console.log(`\n⏹ Timelapse stopped (ID: ${id}, ${frameCount} frames)`);

  if (frameCount === 0) {
    return res.json({ id, message: 'Recording stopped — no frames captured', zipReady: false });
  }

  // 1. Package all captured frames into a ZIP archive
  const zipPath = path.join(TIMELAPSES_DIR, id, 'frames.zip');
  console.log(`  📦 Packaging ${frameCount} frames into ZIP archive...`);
  let zipSize = 0;
  try {
    zipSize = await zipDirectory(framesDir, zipPath);
    console.log(`  ✅ ZIP ready: ${formatBytes(zipSize)}`);
  } catch (zErr) {
    console.error(`  ⚠ Failed to create ZIP: ${zErr.message}`);
  }

  // 2. Optional: Assemble video if FFmpeg is available
  let videoReady = false;
  let videoSize = 0;
  let outputFps = 1;
  if (ffmpegAvailable) {
    const outputPath = path.join(TIMELAPSES_DIR, id, 'timelapse.mp4');
    const inputPattern = path.join(framesDir, 'frame_%06d.jpg');
    const targetDuration = 30;
    outputFps = Math.max(1, Math.min(30, Math.ceil(frameCount / targetDuration)));

    console.log(`  🎬 Optional: assembling ${frameCount} frames with FFmpeg...`);
    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-y',
          '-framerate', String(outputFps),
          '-i', inputPattern,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-crf', '23',
          '-preset', 'fast',
          '-movflags', '+faststart',
          outputPath,
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
        ffmpeg.on('error', reject);
      });

      videoReady = true;
      videoSize = fs.statSync(outputPath).size;
      console.log(`  ✅ MP4 video ready: ${formatBytes(videoSize)}`);
    } catch (err) {
      console.warn(`  (Video assembly skipped: ${err.message})`);
    }
  }

  const metadata = {
    id,
    createdAt: new Date(parseInt(id)).toISOString(),
    frameCount,
    interval,
    zipReady: fs.existsSync(zipPath),
    zipSize,
    zipSizeFormatted: formatBytes(zipSize),
    videoReady,
    videoSize,
    videoSizeFormatted: videoReady ? formatBytes(videoSize) : undefined,
    outputFps: videoReady ? outputFps : undefined,
    duration: videoReady ? (frameCount / outputFps).toFixed(1) : undefined,
  };
  fs.writeFileSync(path.join(TIMELAPSES_DIR, id, 'metadata.json'), JSON.stringify(metadata, null, 2));

  res.json({
    id,
    message: `Timelapse stopped! ${frameCount} frames packaged in ZIP.`,
    frameCount,
    zipReady: metadata.zipReady,
    videoReady,
    metadata,
  });
});

// Recording status
app.get('/api/timelapse/status', (req, res) => {
  if (!activeRecording) {
    return res.json({ active: false });
  }

  const elapsed = Math.floor((Date.now() - activeRecording.startTime) / 1000);
  res.json({
    active: true,
    id: activeRecording.id,
    ip: activeRecording.ip,
    interval: activeRecording.interval,
    frameCount: activeRecording.getFrameCount(),
    elapsed,
    elapsedFormatted: formatDuration(elapsed),
    lastError: activeRecording.getLastError(),
  });
});

// List all timelapses
app.get('/api/timelapse/list', (req, res) => {
  if (!fs.existsSync(TIMELAPSES_DIR)) return res.json([]);

  const entries = fs.readdirSync(TIMELAPSES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(TIMELAPSES_DIR, e.name);
      const metaPath = path.join(dir, 'metadata.json');
      const videoPath = path.join(dir, 'timelapse.mp4');
      const zipPath = path.join(dir, 'frames.zip');
      const framesDir = path.join(dir, 'frames');

      let metadata = { id: e.name };
      if (fs.existsSync(metaPath)) {
        try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
      }

      metadata.hasZip = fs.existsSync(zipPath);
      if (metadata.hasZip) {
        metadata.zipSize = fs.statSync(zipPath).size;
        metadata.zipSizeFormatted = formatBytes(metadata.zipSize);
      }

      metadata.hasVideo = fs.existsSync(videoPath);
      if (metadata.hasVideo) {
        metadata.videoSize = fs.statSync(videoPath).size;
        metadata.videoSizeFormatted = formatBytes(metadata.videoSize);
      }

      if (fs.existsSync(framesDir)) {
        metadata.frameCount = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).length;
      }

      if (!metadata.createdAt) {
        metadata.createdAt = new Date(parseInt(e.name)).toISOString();
      }

      return metadata;
    })
    .sort((a, b) => parseInt(b.id) - parseInt(a.id));

  res.json(entries);
});

// Download timelapse ZIP or video
app.get('/api/timelapse/download/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });

  const dir = path.join(TIMELAPSES_DIR, id);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Timelapse not found' });
  }

  const zipPath = path.join(dir, 'frames.zip');
  const videoPath = path.join(dir, 'timelapse.mp4');

  if (req.query.type === 'video' && fs.existsSync(videoPath)) {
    return res.download(videoPath, `timelapse_${id}.mp4`);
  }

  if (fs.existsSync(zipPath)) {
    return res.download(zipPath, `timelapse_${id}_frames.zip`);
  }

  // If zip does not exist yet, build it now
  const framesDir = path.join(dir, 'frames');
  if (fs.existsSync(framesDir)) {
    try {
      await zipDirectory(framesDir, zipPath);
      return res.download(zipPath, `timelapse_${id}_frames.zip`);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create zip', details: err.message });
    }
  }

  res.status(404).json({ error: 'No frames found for this timelapse' });
});

// Delete timelapse
app.delete('/api/timelapse/:id', (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });

  const dir = path.join(TIMELAPSES_DIR, id);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Timelapse not found' });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`🗑 Timelapse ${id} deleted`);
  res.json({ message: 'Timelapse deleted' });
});

// ─── Start server ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎥 FlashForge Adventurer 3 — Camera & Timelapse`);
  console.log(`   Open http://localhost:${PORT} in your browser`);
  console.log(`   FFmpeg: ${ffmpegAvailable ? '✓ available' : '✗ not found'}\n`);
});
