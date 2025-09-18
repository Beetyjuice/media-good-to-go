// popup.js

const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const refreshBtn = document.getElementById('refresh');

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function scanPage() {
  statusEl.textContent = 'Scanning current page…';
  listEl.innerHTML = '';
  const tab = await getActiveTab();
  if (!tab) {
    statusEl.textContent = 'No active tab found.';
    return;
  }

  // Ask content script for list
  try {
    const results = await browser.tabs.sendMessage(tab.id, { action: 'collectMedia' });
    if (!results || results.length === 0) {
      statusEl.textContent = 'No media found on this page.';
      return;
    }
    statusEl.textContent = `Found ${results.length} items.`;
    renderList(results, tab.id);
  } catch (err) {
    statusEl.textContent = 'Failed to scan page. Make sure the extension has access to this site (some pages block content scripts).';
    console.error(err);
  }
}

function renderList(items, tabId) {
  listEl.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'item';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (it.thumb) {
      const im = document.createElement('img');
      im.src = it.thumb;
      thumb.appendChild(im);
    } else {
      thumb.textContent = it.typeHint ? it.typeHint : 'Media';
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const urlEl = document.createElement('div');
    urlEl.className = 'url';
    urlEl.textContent = it.url;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', () => initiateDownload(it, tabId));
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      browser.tabs.create({ url: it.url });
    });

    actions.appendChild(dlBtn);
    actions.appendChild(openBtn);

    meta.appendChild(urlEl);
    meta.appendChild(actions);

    div.appendChild(thumb);
    div.appendChild(meta);
    listEl.appendChild(div);
  }
}

async function initiateDownload(item, tabId) {
  // If normal http/https or data:, ask background to download directly
  const url = item.url;
  const filename = item.filename || 'download.bin';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    // direct download via background
    const resp = await browser.runtime.sendMessage({ action: 'downloadUrl', url, filename, saveAs: true });
    if (resp && resp.success) {
      statusEl.textContent = 'Download started (Save As dialog).';
    } else {
      statusEl.textContent = 'Failed to start download.';
      console.error(resp);
    }
    return;
  }

  // For blob: URLs (or other) we need the content from the page
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    try {
      statusEl.textContent = 'Extracting blob from page…';
      // Ask content script in the tab to fetch the blob and forward to background
      const res = await browser.tabs.sendMessage(tabId, { action: 'extractBlob', url, filename, saveAs: true });
      if (res && res.success) {
        statusEl.textContent = 'Download started.';
      } else {
        statusEl.textContent = 'Failed to extract blob: ' + (res && res.error ? res.error : 'unknown');
      }
    } catch (err) {
      statusEl.textContent = 'Failed to extract blob: ' + String(err);
      console.error(err);
    }
    return;
  }

  statusEl.textContent = 'Unsupported URL scheme for download.';
}

refreshBtn.addEventListener('click', () => scanPage());

// initial scan on popup open
scanPage();

