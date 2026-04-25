// Aperture — Facebook Photo Grabber
// Content script. Headless: no floating UI of its own. Exposes a message API
// to the popup and (optionally) injects a single inline "Download album"
// button next to the album/page title when one can be found.

(() => {
  if (window.__apertureLoaded) return;
  window.__apertureLoaded = true;

  const log = (...a) => console.log('%c[Aperture]', 'color:#1f6f55;font-weight:600', ...a);
  log('content script loaded on', location.href);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const STATE = {
    photos: new Map(), // fbid -> { fbid, href, thumb, fullUrl, status }
    scanning: false,
    downloading: false,
    progress: { phase: 'idle', done: 0, total: 0, label: '' },
    albumName: null,
    lastError: null,
  };

  const broadcast = () => {
    try {
      chrome.runtime.sendMessage({ type: 'APERTURE_PROGRESS', payload: snapshot() });
    } catch (e) { /* popup may be closed; that's fine */ }
  };

  const snapshot = () => ({
    url: location.href,
    isPhotosPage: isPhotosPage(),
    albumName: STATE.albumName || detectAlbumName(),
    scanning: STATE.scanning,
    downloading: STATE.downloading,
    progress: STATE.progress,
    photoCount: STATE.photos.size,
    readyCount: [...STATE.photos.values()].filter(p => p.fullUrl).length,
    downloadedCount: [...STATE.photos.values()].filter(p => p.status === 'downloaded').length,
    lastError: STATE.lastError,
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const isPhotosPage = () => {
    const u = location.pathname + location.search;
    return /\/photos\b|\/media\/set\b|\/photo(\.php)?\b|\bset=/.test(u);
  };

  const detectAlbumName = () => {
    const h1 = document.querySelector('h1');
    if (h1 && h1.innerText && h1.innerText.length < 80) return h1.innerText.trim();
    const og = document.querySelector('meta[property="og:title"]');
    if (og) return og.content;
    return document.title?.replace(/\s*\|\s*Facebook\s*$/, '').trim() || 'Facebook Photos';
  };

  const extractFbid = (href) => {
    if (!href) return null;
    const m = href.match(/[?&]fbid=(\d+)/);
    if (m) return m[1];
    const m2 = href.match(/\/photos\/[^/]+\/(\d+)/);
    if (m2) return m2[1];
    return null;
  };

  const collectPhotoLinks = () => {
    const selectors = [
      'a[href*="/photo/?fbid="]',
      'a[href*="/photo.php?fbid="]',
      'a[href*="/photos/"][role="link"]',
    ];
    const seen = new Map();
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(a => {
        const href = a.getAttribute('href') || a.href;
        const fbid = extractFbid(href);
        if (!fbid || seen.has(fbid)) return;
        const img = a.querySelector('img');
        const thumb = img?.currentSrc || img?.src || null;
        seen.set(fbid, {
          fbid,
          href: new URL(href, location.origin).toString(),
          thumb,
          fullUrl: null,
          status: 'pending',
        });
      });
    });
    return seen;
  };

  const autoScrollAndCollect = async (rounds = 12) => {
    const acc = new Map();
    const merge = (m) => m.forEach((v, k) => { if (!acc.has(k)) acc.set(k, v); });
    merge(collectPhotoLinks());
    setProgress('scanning', 0, 0, `Scanning… ${acc.size} found`);

    let lastHeight = document.documentElement.scrollHeight;
    let stalled = 0;
    for (let i = 0; i < rounds; i++) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      await sleep(900);
      merge(collectPhotoLinks());
      setProgress('scanning', 0, 0, `Scanning… ${acc.size} found`);
      const newHeight = document.documentElement.scrollHeight;
      if (newHeight === lastHeight) {
        stalled++;
        if (stalled >= 2) break;
      } else {
        stalled = 0;
      }
      lastHeight = newHeight;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    return acc;
  };

  const decodeHTML = (s) => String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/')
    .replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const resolveFullUrl = async (item) => {
    item.status = 'resolving';
    try {
      const res = await fetch(item.href, { credentials: 'include' });
      const html = await res.text();

      let m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
           || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i)
           || html.match(/<link[^>]+rel="image_src"[^>]+href="([^"]+)"/i);

      let found = m ? decodeHTML(m[1]) : null;
      if (!found) {
        const all = [...html.matchAll(/https:\/\/[^"\s\\]*?(?:scontent|fbcdn)[^"\s\\]+\.(?:jpg|jpeg|png|webp)[^"\s\\]*/gi)]
          .map(x => x[0]);
        if (all.length) {
          all.sort((a, b) => b.length - a.length);
          found = all.find(u => /_o\.(jpg|jpeg|png|webp)/i.test(u))
               || all.find(u => /_n\.(jpg|jpeg|png|webp)/i.test(u))
               || all[0];
        }
      }
      if (found) { item.fullUrl = found; item.status = 'ready'; }
      else      { item.status = 'error'; }
    } catch (err) {
      log('resolve failed', item.fbid, err);
      item.status = 'error';
    }
    return item;
  };

  const resolveAll = async (items, concurrency = 4) => {
    const queue = [...items];
    let done = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await resolveFullUrl(item);
        done++;
        setProgress('resolving', done, items.length, `Resolving full-size URLs… ${done} / ${items.length}`);
      }
    });
    await Promise.all(workers);
    return done;
  };

  const requestDownload = (url, folder, filename) =>
    new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'APERTURE_DOWNLOAD', payload: { url, folder, filename } },
        (resp) => resolve(resp || { ok: false })
      );
    });

  const setProgress = (phase, done, total, label) => {
    STATE.progress = { phase, done, total, label };
    broadcast();
  };

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  const doScan = async () => {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.lastError = null;
    STATE.albumName = detectAlbumName();
    broadcast();

    try {
      const found = await autoScrollAndCollect(12);
      found.forEach((v, k) => { if (!STATE.photos.has(k)) STATE.photos.set(k, v); });
      setProgress('scanning', 0, 0, `${STATE.photos.size} photos detected`);

      const unresolved = [...STATE.photos.values()].filter(p => !p.fullUrl && p.status !== 'error');
      if (unresolved.length) await resolveAll(unresolved, 4);

      setProgress('idle', 0, 0, `${STATE.photos.size} photos ready`);
    } catch (e) {
      STATE.lastError = e.message || String(e);
      log('scan failed', e);
    } finally {
      STATE.scanning = false;
      broadcast();
    }
  };

  const doDownloadAll = async () => {
    if (STATE.downloading) return;
    if (STATE.photos.size === 0) await doScan();
    if (STATE.photos.size === 0) {
      STATE.lastError = 'No photos detected on this page.';
      broadcast();
      return;
    }

    STATE.downloading = true;
    STATE.lastError = null;
    broadcast();

    const items = [...STATE.photos.values()];
    const folder = `Aperture/${(STATE.albumName || 'Facebook Photos').slice(0, 60)}`;

    let done = 0;
    setProgress('downloading', 0, items.length, `Saving 0 / ${items.length}`);

    for (const item of items) {
      if (!item.fullUrl) await resolveFullUrl(item);
      if (item.fullUrl) {
        const resp = await requestDownload(item.fullUrl, folder, `${item.fbid}`);
        item.status = resp.ok ? 'downloaded' : 'error';
      } else {
        item.status = 'error';
      }
      done++;
      setProgress('downloading', done, items.length, `Saving ${done} / ${items.length}`);
      await sleep(80);
    }

    STATE.downloading = false;
    setProgress('done', done, items.length, `Saved ${done} photo${done === 1 ? '' : 's'}`);
  };

  // -------------------------------------------------------------------------
  // Inline button (best-effort, harmless if it fails)
  // -------------------------------------------------------------------------

  const INLINE_ID = 'aperture-inline-btn';

  const buildInlineButton = () => {
    const wrap = document.createElement('div');
    wrap.id = INLINE_ID;
    wrap.style.cssText = [
      'all: initial',
      'display: inline-flex',
      'margin: 8px 0 14px',
      'font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
      'z-index: 1',
    ].join(';');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = [
      'all: initial',
      'cursor: pointer',
      'display: inline-flex',
      'align-items: center',
      'gap: 10px',
      'padding: 8px 8px 8px 16px',
      'background: #0e0f12',
      'color: #fbfaf7',
      'border-radius: 999px',
      'font: 500 13px ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
      'letter-spacing: -0.005em',
      'box-shadow: 0 14px 30px -18px rgba(20,22,26,0.35)',
      'transition: transform 350ms cubic-bezier(0.32,0.72,0,1), background 200ms ease',
    ].join(';');

    btn.innerHTML = `
      <span style="all:initial;font:inherit;color:inherit;">Download album</span>
      <span style="all:initial;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:rgba(255,255,255,0.12);border-radius:999px;color:#fbfaf7;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 4v12"/><path d="m6 12 6 6 6-6"/><path d="M5 20h14"/>
        </svg>
      </span>
      <span data-status style="all:initial;font:500 11px ui-sans-serif,system-ui;color:rgba(251,250,247,0.62);margin-left:2px;"></span>
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = '#1c1d22'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0e0f12'; });
    btn.addEventListener('click', async () => {
      const statusEl = btn.querySelector('[data-status]');
      btn.disabled = true;
      btn.style.opacity = '0.85';
      btn.style.cursor = 'progress';
      const update = () => {
        if (!statusEl) return;
        statusEl.textContent = STATE.progress.label || '';
      };
      const off = onProgress(update);
      try {
        await doDownloadAll();
      } finally {
        off();
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
      }
    });

    wrap.appendChild(btn);
    return wrap;
  };

  // Local listeners for the inline button (fanned out from state changes).
  const progressListeners = new Set();
  const onProgress = (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); };
  let lastSig = '';
  setInterval(() => {
    const sig = `${STATE.progress.phase}|${STATE.progress.done}|${STATE.progress.total}|${STATE.progress.label}`;
    if (sig !== lastSig) {
      lastSig = sig;
      progressListeners.forEach(fn => { try { fn(); } catch (e) {} });
    }
  }, 200);

  const tryInjectInlineButton = () => {
    if (document.getElementById(INLINE_ID)) return false;
    if (!isPhotosPage()) return false;

    // Find the most likely "album/page title" h1 and append our button next to it.
    const candidates = [...document.querySelectorAll('h1')].filter(h => {
      const t = (h.innerText || '').trim();
      if (!t || t.length > 120) return false;
      if (/^facebook$/i.test(t)) return false;
      // Must be visible.
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!candidates.length) return false;

    const h1 = candidates[0];
    const parent = h1.parentElement;
    if (!parent) return false;
    const btn = buildInlineButton();
    if (h1.nextSibling) parent.insertBefore(btn, h1.nextSibling);
    else parent.appendChild(btn);
    log('inline button injected next to', h1);
    return true;
  };

  const ensureInlineButton = () => {
    // Try a few times — Facebook re-renders.
    let tries = 0;
    const i = setInterval(() => {
      tries++;
      if (document.getElementById(INLINE_ID)) { clearInterval(i); return; }
      tryInjectInlineButton();
      if (tries > 20) clearInterval(i);
    }, 700);
  };

  // -------------------------------------------------------------------------
  // Message API (popup ↔ content script)
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'APERTURE_GET_STATUS') {
      sendResponse(snapshot());
      return false;
    }
    if (msg.type === 'APERTURE_SCAN') {
      doScan().then(() => sendResponse({ ok: true, count: STATE.photos.size }));
      return true;
    }
    if (msg.type === 'APERTURE_DOWNLOAD_ALL') {
      doDownloadAll().then(() => sendResponse({ ok: true, count: STATE.progress.done }));
      return true;
    }
    if (msg.type === 'APERTURE_RESET') {
      STATE.photos.clear();
      STATE.albumName = null;
      STATE.lastError = null;
      setProgress('idle', 0, 0, '');
      sendResponse({ ok: true });
      return false;
    }
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  const boot = () => {
    log('boot — photos page?', isPhotosPage());
    ensureInlineButton();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-detect on SPA navigation.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // New page → clear photo cache (but keep album name fresh).
      STATE.photos.clear();
      STATE.albumName = null;
      setProgress('idle', 0, 0, '');
      // Remove a stale inline button so we re-inject on the new page.
      const old = document.getElementById(INLINE_ID);
      if (old) old.remove();
      ensureInlineButton();
    }
  }, 1500);
})();
