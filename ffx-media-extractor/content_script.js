// content_script.js

// Helper: detect if a URL looks like media
function looksLikeMedia(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // common media extensions
  const extMedia = ['.mp4', '.webm', '.ogg', '.mp3', '.wav', '.m4a', '.flac', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.mov'];
  if (extMedia.some(e => lower.includes(e))) return true;
  if (lower.startsWith('blob:') || lower.startsWith('data:')) return true;
  return false;
}

// Extract filename suggestion from URL
function suggestFilename(url) {
  try {
    if (!url) return 'download.bin';
    if (url.startsWith('data:')) {
      // data:[<mediatype>][;base64],...
      const m = url.match(/^data:([^;]+);/);
      const ext = m ? m[1].split('/').pop() : 'bin';
      return `file.${ext}`;
    }
    if (url.startsWith('blob:')) {
      return 'blob.bin';
    }
    const u = new URL(url, location.href);
    const base = u.pathname.split('/').pop() || 'download';
    return decodeURIComponent(base);
  } catch (e) {
    return 'download.bin';
  }
}

// Build thumbnail for an image URL (works for data:, blob:, http(s))
async function buildImageThumbnail(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // draw into canvas small size
      const max = 240;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > max || h > max) {
        const scale = Math.min(max / w, max / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const dataUrl = c.toDataURL('image/png');
        resolve(dataUrl);
      } catch (err) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
    // if image is already cached and complete, onload might not fire—safety:
    if (img.complete) {
      img.onload();
    }
  });
}

// Build thumbnail for video: grab first frame
async function buildVideoThumbnail(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    let resolved = false;
    const cleanup = () => {
      if (video.srcObject) {
        try { video.srcObject.getTracks().forEach(t => t.stop()); } catch(e) {}
      }
      video.remove();
    };
    video.addEventListener('loadeddata', () => {
      try {
        const canvas = document.createElement('canvas');
        const max = 240;
        let w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { cleanup(); return resolve(null); }
        if (w > max || h > max) {
          const scale = Math.min(max / w, max / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png');
        resolved = true;
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        resolve(null);
      }
    }, { once: true });

    video.addEventListener('error', () => {
      if (!resolved) { cleanup(); resolve(null); }
    }, { once: true });

    video.src = url;
    // try to load, some browsers block cross-origin video from canvas drawing; errors may occur
    // add a fallback timeout
    setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolve(null);
      }
    }, 5000);
  });
}

// Collect media candidates from page
async function collectMediaCandidates() {
  const items = [];
  const seen = new Set();

  // gather from <img>, <video>, <audio>, <source>, <a>
  const imgs = Array.from(document.querySelectorAll('img'));
  const videos = Array.from(document.querySelectorAll('video'));
  const audios = Array.from(document.querySelectorAll('audio'));
  const sources = Array.from(document.querySelectorAll('source'));
  const anchors = Array.from(document.querySelectorAll('a'));

  function pushIf(url, typeHint) {
    if (!url) return;
    if (!looksLikeMedia(url) && !typeHint) return;
    if (seen.has(url)) return;
    seen.add(url);
    items.push({ url, typeHint: typeHint || null, filename: suggestFilename(url) });
  }

  imgs.forEach(i => pushIf(i.currentSrc || i.src, 'image'));
  videos.forEach(v => pushIf(v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src), 'video'));
  audios.forEach(a => pushIf(a.currentSrc || a.src || (a.querySelector('source') && a.querySelector('source').src), 'audio'));
  sources.forEach(s => pushIf(s.src, null));
  anchors.forEach(a => {
    const href = a.href;
    pushIf(href, null);
  });

  // Now build thumbnails where possible
  const withThumbs = [];
  for (const it of items) {
    let thumb = null;
    try {
      if (it.typeHint === 'image' || (it.url && it.url.match(/\.(png|jpg|jpeg|gif|svg)$/i))) {
        thumb = await buildImageThumbnail(it.url);
      } else if (it.typeHint === 'video' || (it.url && it.url.match(/\.(mp4|webm|mov|ogg)$/i))) {
        thumb = await buildVideoThumbnail(it.url);
      } else {
        // try image fallback
        thumb = null;
      }
    } catch (e) {
      thumb = null;
    }
    withThumbs.push({ ...it, thumb });
  }

  return withThumbs;
}

// Respond to messages from popup/background
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.action === 'collectMedia') {
    return collectMediaCandidates();
  }
  if (message.action === 'extractBlob') {
    const { url } = message;
    // We expect url to be blob:... or data:
    if (!url) return Promise.resolve({ success: false, error: 'no url' });

    // if data: URL, convert to blob
    if (url.startsWith('data:')) {
      try {
        const parts = url.split(',');
        const header = parts[0];
        const isBase64 = header.indexOf(';base64') !== -1;
        const mime = header.split(':')[1].split(';')[0] || 'application/octet-stream';
        const dataPart = parts[1] || '';
        let byteArray;
        if (isBase64) {
          const binary = atob(dataPart);
          byteArray = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) byteArray[i] = binary.charCodeAt(i);
        } else {
          // percent-decoded
          const decoded = decodeURIComponent(dataPart);
          byteArray = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) byteArray[i] = decoded.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: mime });
        // send blob to background for download
        return browser.runtime.sendMessage({ action: 'downloadBlob', blob, filename: message.filename, saveAs: message.saveAs || true })
          .then(res => res).catch(err => ({ success: false, error: String(err) }));
      } catch (err) {
        return Promise.resolve({ success: false, error: String(err) });
      }
    }

    // otherwise try fetch for blob (works for blob: and http(s) same-origin)
    return fetch(url).then(async (res) => {
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const blob = await res.blob();
      // forward to background
      return browser.runtime.sendMessage({ action: 'downloadBlob', blob, filename: message.filename, saveAs: message.saveAs || true })
        .then(res => res).catch(err => ({ success: false, error: String(err) }));
    }).catch(err => ({ success: false, error: String(err) }));
  }
});

