// Aperture popup — drives scan + download via messages to the active tab's
// content script. Lives entirely in the toolbar dialog.

const $ = (id) => document.getElementById(id);

let activeTab = null;
let pollTimer = null;

const isFacebook = (url) => {
  try { return /(^|\.)facebook\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
};

const setDot = (state) => {
  const d = $('statusDot');
  d.classList.remove('ok', 'warn', 'busy');
  if (state) d.classList.add(state);
};

const setError = (msg) => {
  const b = $('errorBanner');
  if (msg) {
    b.hidden = false;
    $('errorText').textContent = msg;
  } else {
    b.hidden = true;
  }
};

const setProgress = (frac, label, indeterminate = false) => {
  const wrap = $('progressWrap');
  const bar = $('progressBar');
  if (label || indeterminate || frac > 0) wrap.classList.add('show');
  else wrap.classList.remove('show');
  wrap.classList.toggle('indeterminate', !!indeterminate);
  if (!indeterminate) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
  $('progressLabel').innerHTML = label || '&nbsp;';
};

const setCTA = (label, { disabled = false, action = null } = {}) => {
  $('ctaLabel').textContent = label;
  $('ctaBtn').disabled = !!disabled;
  $('ctaBtn').onclick = action;
};

const sendToTab = (type, payload) =>
  new Promise((resolve) => {
    if (!activeTab) return resolve(null);
    chrome.tabs.sendMessage(activeTab.id, { type, payload }, (resp) => {
      // chrome.runtime.lastError fires if no listener; ignore.
      void chrome.runtime.lastError;
      resolve(resp || null);
    });
  });

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '—');

const renderState = (snap) => {
  if (!snap) {
    setDot('warn');
    $('statusText').textContent = 'Page not responding yet.';
    $('albumName').textContent = '—';
    $('photoCount').textContent = '—';
    setProgress(0, '');
    setCTA('Reload page & retry', { disabled: false, action: () => {
      if (activeTab) chrome.tabs.reload(activeTab.id);
      window.close();
    }});
    return;
  }

  $('albumName').textContent = truncate(snap.albumName, 28);
  $('photoCount').textContent = String(snap.photoCount || 0);
  setError(snap.lastError || '');

  if (snap.scanning) {
    setDot('busy');
    $('statusText').textContent = 'Scanning the album…';
    setProgress(0, snap.progress?.label || 'Scanning…', true);
    setCTA('Working…', { disabled: true });
    return;
  }

  if (snap.downloading) {
    setDot('busy');
    $('statusText').textContent = 'Downloading photos…';
    const frac = snap.progress?.total ? snap.progress.done / snap.progress.total : 0;
    setProgress(frac, snap.progress?.label || 'Saving…');
    setCTA('Saving…', { disabled: true });
    return;
  }

  // Idle states
  if (!snap.isPhotosPage) {
    setDot('warn');
    $('statusText').textContent = 'Open a Facebook album or photos tab.';
    setProgress(0, '');
    setCTA('Browse Facebook albums', {
      disabled: false,
      action: () => {
        chrome.tabs.update(activeTab.id, { url: 'https://www.facebook.com/me/photos' });
        window.close();
      },
    });
    return;
  }

  // On a photos page, idle.
  setDot('ok');
  if (snap.progress?.phase === 'done') {
    $('statusText').textContent = `Saved ${snap.progress.done} photo${snap.progress.done === 1 ? '' : 's'}.`;
    setProgress(1, snap.progress.label || 'Done');
  } else if (snap.photoCount > 0) {
    $('statusText').textContent = `Found ${snap.photoCount} photo${snap.photoCount === 1 ? '' : 's'}. Ready to save.`;
    setProgress(0, '');
  } else {
    $('statusText').textContent = 'Photos page detected.';
    setProgress(0, '');
  }

  setCTA(
    snap.photoCount > 0 ? `Download ${snap.photoCount} photo${snap.photoCount === 1 ? '' : 's'}`
                        : 'Scan & download album',
    {
      disabled: false,
      action: async () => {
        setCTA('Working…', { disabled: true });
        setDot('busy');
        setProgress(0, 'Starting…', true);
        const resp = await sendToTab('APERTURE_DOWNLOAD_ALL');
        if (!resp) {
          setError('Could not reach the page. Try refreshing the Facebook tab and reopening Aperture.');
          setDot('warn');
        }
        // Status will be polled and re-rendered.
      },
    }
  );
};

const poll = async () => {
  if (!activeTab) return;
  const snap = await sendToTab('APERTURE_GET_STATUS');
  renderState(snap);
};

const init = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab || !tab.url) {
    setDot('warn');
    $('statusText').textContent = 'No active tab.';
    setCTA('Close', { disabled: false, action: () => window.close() });
    return;
  }

  if (!isFacebook(tab.url)) {
    setDot('warn');
    $('statusText').textContent = 'Not on Facebook.';
    $('albumName').textContent = '—';
    $('photoCount').textContent = '—';
    setCTA('Open Facebook', {
      disabled: false,
      action: () => {
        chrome.tabs.create({ url: 'https://www.facebook.com/me/photos' });
        window.close();
      },
    });
    return;
  }

  // First poll — establishes whether the content script is responding.
  await poll();

  // Listen for live progress broadcasts from the content script.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'APERTURE_PROGRESS') {
      renderState(msg.payload);
    }
  });

  // Light polling as a safety net.
  pollTimer = setInterval(poll, 1200);
  window.addEventListener('beforeunload', () => clearInterval(pollTimer));
};

init();
