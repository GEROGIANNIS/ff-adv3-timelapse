// ─── DOM Elements ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const connectBtn = $('connectBtn');
const printerIpInput = $('printerIp');
const connectError = $('connectError');
const connectionBadge = $('connectionBadge');
const mainContent = $('mainContent');
const gallerySection = $('gallerySection');

const cameraFeed = $('cameraFeed');
const feedPlaceholder = $('feedPlaceholder');
const liveIndicator = $('liveIndicator');

const intervalSelect = $('intervalSelect');
const startRecBtn = $('startRecBtn');
const stopRecBtn = $('stopRecBtn');
const tlIdle = $('tlIdle');
const tlRecording = $('tlRecording');
const tlProcessing = $('tlProcessing');
const statFrames = $('statFrames');
const statElapsed = $('statElapsed');
const statInterval = $('statInterval');
const captureError = $('captureError');

const refreshGalleryBtn = $('refreshGalleryBtn');
const galleryList = $('galleryList');
const galleryEmpty = $('galleryEmpty');

// ─── State ───────────────────────────────────────────────────────────────────
let connectedIp = null;
let statusPollTimer = null;

// ─── Connection ──────────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const ip = printerIpInput.value.trim();
  if (!ip) {
    showError(connectError, 'Please enter a printer IP address');
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  hideError(connectError);

  try {
    const res = await fetch(`/api/test?ip=${encodeURIComponent(ip)}`);
    const data = await res.json();

    if (data.success) {
      connectedIp = ip;
      connectToStream(ip);
      connectionBadge.className = 'badge badge-connected';
      connectionBadge.textContent = `Connected — ${ip}`;
      mainContent.hidden = false;
      gallerySection.hidden = false;
      loadGallery();
      checkRecordingStatus();
    } else {
      showError(connectError, `Could not reach camera: ${data.error || data.details}`);
    }
  } catch (err) {
    showError(connectError, `Connection failed: ${err.message}`);
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

// Enter key to connect
printerIpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

function connectToStream(ip) {
  feedPlaceholder.classList.remove('hidden');
  cameraFeed.classList.remove('loaded');
  liveIndicator.classList.remove('active');

  cameraFeed.onload = () => {
    feedPlaceholder.classList.add('hidden');
    cameraFeed.classList.add('loaded');
    liveIndicator.classList.add('active');
  };

  cameraFeed.onerror = () => {
    feedPlaceholder.textContent = '⚠ Camera feed lost — trying to reconnect...';
    feedPlaceholder.classList.remove('hidden');
    cameraFeed.classList.remove('loaded');
    liveIndicator.classList.remove('active');

    // Attempt reconnect after 3 seconds
    setTimeout(() => {
      if (connectedIp) {
        cameraFeed.src = `/api/stream?ip=${encodeURIComponent(connectedIp)}&t=${Date.now()}`;
      }
    }, 3000);
  };

  cameraFeed.src = `/api/stream?ip=${encodeURIComponent(ip)}`;
}

// ─── Timelapse Controls ─────────────────────────────────────────────────────

startRecBtn.addEventListener('click', async () => {
  if (!connectedIp) return;

  startRecBtn.disabled = true;
  const interval = parseInt(intervalSelect.value, 10);

  try {
    const res = await fetch('/api/timelapse/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: connectedIp, interval }),
    });
    const data = await res.json();

    if (res.ok) {
      showRecordingUI(interval);
      startStatusPolling();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to start recording: ${err.message}`);
  } finally {
    startRecBtn.disabled = false;
  }
});

stopRecBtn.addEventListener('click', async () => {
  stopRecBtn.disabled = true;
  stopStatusPolling();

  // Show processing state
  tlRecording.hidden = true;
  tlProcessing.hidden = false;

  try {
    const res = await fetch('/api/timelapse/stop', { method: 'POST' });
    const data = await res.json();

    tlProcessing.hidden = true;
    tlIdle.hidden = false;

    if (data.zipReady || data.frameCount > 0) {
      alert(`✅ Timelapse saved! ${data.frameCount} frames packaged into ZIP.`);
    } else {
      alert('No frames were captured.');
    }

    loadGallery();
  } catch (err) {
    tlProcessing.hidden = true;
    tlIdle.hidden = false;
    alert(`Error stopping recording: ${err.message}`);
  } finally {
    stopRecBtn.disabled = false;
  }
});

function showRecordingUI(interval) {
  tlIdle.hidden = true;
  tlRecording.hidden = false;
  tlProcessing.hidden = true;
  statInterval.textContent = `${interval}s`;
  statFrames.textContent = '0';
  statElapsed.textContent = '0s';
  hideError(captureError);
}

// ─── Status Polling ─────────────────────────────────────────────────────────

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(pollStatus, 1000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/timelapse/status');
    const data = await res.json();

    if (data.active) {
      statFrames.textContent = data.frameCount;
      statElapsed.textContent = data.elapsedFormatted;

      if (data.lastError) {
        showError(captureError, `Last error: ${data.lastError}`);
      } else {
        hideError(captureError);
      }
    } else {
      // Recording stopped externally?
      stopStatusPolling();
      tlRecording.hidden = true;
      tlIdle.hidden = false;
      loadGallery();
    }
  } catch (err) {
    console.warn('Status poll error:', err);
  }
}

async function checkRecordingStatus() {
  try {
    const res = await fetch('/api/timelapse/status');
    const data = await res.json();

    if (data.active) {
      showRecordingUI(data.interval);
      statFrames.textContent = data.frameCount;
      statElapsed.textContent = data.elapsedFormatted;
      startStatusPolling();
    }
  } catch (err) {
    // ignore
  }
}

// ─── Gallery ─────────────────────────────────────────────────────────────────

refreshGalleryBtn.addEventListener('click', loadGallery);

async function loadGallery() {
  try {
    const res = await fetch('/api/timelapse/list');
    const items = await res.json();

    galleryList.innerHTML = '';

    if (items.length === 0) {
      galleryEmpty.classList.remove('hidden');
      return;
    }

    galleryEmpty.classList.add('hidden');

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'gallery-item';

      const date = new Date(item.createdAt || parseInt(item.id));
      const dateStr = date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const metaParts = [];
      if (item.frameCount) metaParts.push(`${item.frameCount} frames`);
      if (item.interval) metaParts.push(`${item.interval}s interval`);
      if (item.zipSizeFormatted) metaParts.push(`ZIP: ${item.zipSizeFormatted}`);
      else if (item.videoSizeFormatted) metaParts.push(item.videoSizeFormatted);

      let downloadBtns = '';
      if (item.hasZip || item.frameCount > 0) {
        downloadBtns += `<a href="/api/timelapse/download/${item.id}" class="btn btn-small btn-download">⬇ Download ZIP</a>`;
      }
      if (item.hasVideo) {
        downloadBtns += ` <a href="/api/timelapse/download/${item.id}?type=video" class="btn btn-small btn-ghost">⬇ MP4</a>`;
      }
      if (!downloadBtns) {
        downloadBtns = `<span class="btn btn-small" style="opacity:0.4;cursor:default">No files</span>`;
      }

      el.innerHTML = `
        <div class="gallery-info">
          <span class="gallery-date">${dateStr}</span>
          <span class="gallery-meta">${metaParts.map((p) => `<span>${p}</span>`).join('')}</span>
        </div>
        <div class="gallery-actions">
          ${downloadBtns}
          <button class="btn btn-small btn-delete" data-id="${item.id}">🗑</button>
        </div>
      `;

      // Delete handler
      const deleteBtn = el.querySelector('.btn-delete');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this timelapse?')) return;
        try {
          await fetch(`/api/timelapse/${item.id}`, { method: 'DELETE' });
          loadGallery();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      });

      galleryList.appendChild(el);
    }
  } catch (err) {
    console.error('Failed to load gallery:', err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

function hideError(el) {
  el.textContent = '';
  el.hidden = true;
}
