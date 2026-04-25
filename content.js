// Aperture — Facebook Photo Grabber
// Content script. Renders a Shadow-DOM UI that detects photos on the current
// Facebook page (album, photos tab, or photo viewer) and downloads them at
// full resolution.

(() => {
  if (window.__apertureLoaded) return;
  window.__apertureLoaded = true;

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const STATE = {
    photos: new Map(), // fbid -> { fbid, href, thumb, fullUrl, status, selected }
    open: false,
    scanning: false,
    downloading: false,
    albumName: null,
  };

  const SUBSCRIBERS = new Set();
  const subscribe = (fn) => {
    SUBSCRIBERS.add(fn);
    return () => SUBSCRIBERS.delete(fn);
  };
  const notify = () => SUBSCRIBERS.forEach((fn) => fn());

  // Try to read a friendly album/page title for the download folder name.
  const detectAlbumName = () => {
    const h1 = document.querySelector('h1');
    if (h1 && h1.innerText && h1.innerText.length < 80) {
      return h1.innerText.trim();
    }
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) return ogTitle.content;
    return document.title?.replace(/\s*\|\s*Facebook\s*$/, '').trim() || 'Facebook Photos';
  };

  // Pull every plausible photo link on the page.
  const collectPhotoLinks = () => {
    const selectors = [
      'a[href*="/photo/?fbid="]',
      'a[href*="/photo.php?fbid="]',
      'a[href*="/photos/"][role="link"]',
    ];
    const seen = new Map();
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((a) => {
        const href = a.getAttribute('href') || a.href;
        const fbid = extractFbid(href);
        if (!fbid) return;
        if (seen.has(fbid)) return;
        const img = a.querySelector('img');
        const thumb = img?.currentSrc || img?.src || null;
        seen.set(fbid, {
          fbid,
          href: new URL(href, location.origin).toString(),
          thumb,
          fullUrl: null,
          status: 'pending', // pending | resolving | ready | error | downloaded
          selected: true,
        });
      });
    });
    return seen;
  };

  const extractFbid = (href) => {
    if (!href) return null;
    const m = href.match(/[?&]fbid=(\d+)/);
    if (m) return m[1];
    const m2 = href.match(/\/photos\/[^/]+\/(\d+)/);
    if (m2) return m2[1];
    return null;
  };

  // Auto-scroll the page so Facebook's virtual list materialises more photos.
  const autoScrollAndCollect = async (rounds = 8) => {
    const acc = new Map();
    const merge = (m) => m.forEach((v, k) => { if (!acc.has(k)) acc.set(k, v); });
    merge(collectPhotoLinks());
    notifyProgress(acc.size);

    let lastHeight = document.documentElement.scrollHeight;
    for (let i = 0; i < rounds; i++) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      await sleep(900);
      merge(collectPhotoLinks());
      notifyProgress(acc.size);
      const newHeight = document.documentElement.scrollHeight;
      if (newHeight === lastHeight) break;
      lastHeight = newHeight;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    return acc;
  };

  const notifyProgress = (count) => {
    const el = ui?.shadow?.getElementById('scanCount');
    if (el) el.textContent = String(count);
  };

  // Resolve the full-resolution image URL by fetching the photo permalink
  // and pulling the og:image / largest scontent URL from the response.
  const resolveFullUrl = async (item) => {
    item.status = 'resolving';
    notify();
    try {
      const res = await fetch(item.href, { credentials: 'include' });
      const html = await res.text();

      // 1. og:image meta — most reliable.
      let m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      if (!m) m = html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

      // 2. image_src link tag (some legacy pages).
      if (!m) m = html.match(/<link[^>]+rel="image_src"[^>]+href="([^"]+)"/i);

      // 3. Find any scontent / fbcdn URL and prefer a long, _o or _n flavor.
      let found = m ? decodeHTML(m[1]) : null;
      if (!found) {
        const all = [...html.matchAll(/https:\/\/[^"\s\\]*?(?:scontent|fbcdn)[^"\s\\]+\.(?:jpg|jpeg|png|webp)[^"\s\\]*/gi)]
          .map((x) => x[0]);
        if (all.length) {
          all.sort((a, b) => b.length - a.length);
          found = all.find((u) => /_o\.(jpg|jpeg|png|webp)/i.test(u))
            || all.find((u) => /_n\.(jpg|jpeg|png|webp)/i.test(u))
            || all[0];
        }
      }

      if (found) {
        item.fullUrl = found;
        item.status = 'ready';
      } else {
        item.status = 'error';
      }
    } catch (err) {
      console.warn('[Aperture] resolve failed', item.fbid, err);
      item.status = 'error';
    }
    notify();
    return item;
  };

  const decodeHTML = (s) => s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Run resolveFullUrl against many items with a small concurrency limit.
  const resolveAll = async (items, concurrency = 4) => {
    let i = 0;
    const queue = [...items];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await resolveFullUrl(item);
        i++;
      }
    });
    await Promise.all(workers);
    return i;
  };

  // Download a single photo via the background service worker.
  const requestDownload = (url, folder, filename) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'APERTURE_DOWNLOAD', payload: { url, folder, filename } },
        (resp) => resolve(resp || { ok: false })
      );
    });

  // -------------------------------------------------------------------------
  // UI — Shadow DOM
  // -------------------------------------------------------------------------

  let ui = null;

  const createUI = () => {
    const host = document.createElement('div');
    host.id = 'aperture-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    ui = { host, shadow };
    wireUI();
  };

  const TEMPLATE = `
<style>
  :host, * { box-sizing: border-box; }
  .root {
    --ink: #0e0f12;
    --ink-soft: #51535a;
    --ink-mute: #8a8d95;
    --paper: #fbfaf7;
    --paper-2: #f3f1ec;
    --line: rgba(14, 15, 18, 0.08);
    --line-strong: rgba(14, 15, 18, 0.14);
    --accent: #1f6f55;
    --accent-soft: #e7f1ec;
    --shadow-soft: 0 24px 60px -28px rgba(20, 22, 26, 0.18), 0 8px 22px -12px rgba(20, 22, 26, 0.12);
    --shadow-deep: 0 40px 80px -28px rgba(15, 18, 22, 0.28), 0 12px 32px -16px rgba(15, 18, 22, 0.16);
    --ring-inset: inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.04);
    --easing: cubic-bezier(0.32, 0.72, 0, 1);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
    font-feature-settings: "ss01", "cv11";
    color: var(--ink);
  }

  /* ---------------- Floating Action Button ---------------- */
  .fab {
    position: fixed;
    right: 22px;
    bottom: 22px;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 18px;
    background: rgba(251, 250, 247, 0.78);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    border-radius: 999px;
    border: 1px solid var(--line);
    box-shadow: var(--shadow-soft), var(--ring-inset);
    color: var(--ink);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: transform 600ms var(--easing), box-shadow 600ms var(--easing), background 400ms var(--easing);
    transform: translateY(0);
  }
  .fab:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-deep), var(--ring-inset);
    background: rgba(255, 255, 255, 0.92);
  }
  .fab:active { transform: translateY(0) scale(0.985); }
  .fab .label { padding-right: 4px; }
  .fab .badge {
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--ink);
    color: var(--paper);
    border-radius: 999px;
    transition: transform 600ms var(--easing);
  }
  .fab:hover .badge { transform: translate(2px, -1px) scale(1.04); }
  .fab svg { width: 16px; height: 16px; }

  /* ---------------- Side Panel ---------------- */
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(15, 17, 20, 0.36);
    backdrop-filter: blur(2px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 500ms var(--easing);
  }
  .root.open .scrim { opacity: 1; pointer-events: auto; }

  .panel {
    position: fixed;
    top: 16px;
    right: 16px;
    bottom: 16px;
    width: min(440px, calc(100vw - 32px));
    background: var(--paper);
    border-radius: 28px;
    border: 1px solid var(--line);
    box-shadow: var(--shadow-deep);
    transform: translateX(calc(100% + 32px));
    opacity: 0;
    pointer-events: none;
    transition: transform 720ms var(--easing), opacity 600ms var(--easing);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .root.open .panel { transform: translateX(0); opacity: 1; pointer-events: auto; }

  /* Subtle inner refraction edge */
  .panel::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(255,255,255,0.4);
  }
  /* Subtle paper grain */
  .panel::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.04 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
    mix-blend-mode: multiply;
    opacity: 0.5;
  }

  .panel-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header.top {
    padding: 22px 22px 14px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 4px 8px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--ink-soft);
    font-weight: 500;
  }
  .eyebrow .dot {
    width: 6px; height: 6px; border-radius: 999px; background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .title {
    margin-top: 14px;
    font-size: 28px;
    line-height: 1.05;
    letter-spacing: -0.025em;
    font-weight: 500;
  }
  .title em { font-style: italic; font-family: ui-serif, "Iowan Old Style", Georgia, serif; font-weight: 500; color: var(--ink); }
  .subtitle {
    margin-top: 8px;
    font-size: 13.5px;
    color: var(--ink-soft);
    line-height: 1.5;
    max-width: 36ch;
  }

  .close-btn {
    flex-shrink: 0;
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    cursor: pointer;
    color: var(--ink);
    transition: transform 400ms var(--easing), background 300ms var(--easing);
  }
  .close-btn:hover { background: #ebe8e2; transform: rotate(90deg); }
  .close-btn svg { width: 14px; height: 14px; }

  /* Scan section */
  .scan-card {
    margin: 4px 22px 0;
    padding: 4px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 22px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
  }
  .scan-card-inner {
    background: #fff;
    border-radius: 18px;
    padding: 16px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.7);
  }
  .scan-meta { display: flex; flex-direction: column; gap: 2px; }
  .scan-meta .count {
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .scan-meta .label {
    font-size: 11px;
    color: var(--ink-mute);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .scan-action {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 16px;
    background: var(--ink);
    color: var(--paper);
    border-radius: 999px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: transform 500ms var(--easing), background 300ms var(--easing);
  }
  .scan-action:hover { background: #1c1d22; }
  .scan-action:active { transform: scale(0.97); }
  .scan-action[disabled] { opacity: 0.6; cursor: progress; }
  .scan-action .arrow {
    width: 26px; height: 26px;
    background: rgba(255,255,255,0.12);
    border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform 500ms var(--easing);
  }
  .scan-action:hover .arrow { transform: translate(2px, -1px); }
  .scan-action svg { width: 12px; height: 12px; }

  /* Toolbar */
  .toolbar {
    margin: 14px 22px 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .chip-row { display: inline-flex; gap: 6px; }
  .chip {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-soft);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    cursor: pointer;
    transition: background 250ms var(--easing), color 250ms var(--easing), border 250ms var(--easing);
  }
  .chip:hover { background: var(--paper-2); }
  .chip[aria-pressed="true"] {
    background: #fff;
    border-color: var(--line);
    color: var(--ink);
  }
  .selected-count {
    font-size: 12px;
    color: var(--ink-mute);
    font-variant-numeric: tabular-nums;
  }
  .selected-count strong { color: var(--ink); font-weight: 500; }

  /* Grid */
  .grid-wrap {
    flex: 1;
    overflow-y: auto;
    padding: 8px 22px 24px;
    scrollbar-gutter: stable;
  }
  .grid-wrap::-webkit-scrollbar { width: 8px; }
  .grid-wrap::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 8px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .tile {
    position: relative;
    aspect-ratio: 1 / 1;
    border-radius: 14px;
    overflow: hidden;
    background: var(--paper-2);
    border: 1px solid var(--line);
    cursor: pointer;
    transition: transform 500ms var(--easing), box-shadow 500ms var(--easing);
  }
  .tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-soft); }
  .tile img {
    width: 100%; height: 100%; object-fit: cover; display: block;
    transition: transform 700ms var(--easing), filter 400ms var(--easing);
  }
  .tile:hover img { transform: scale(1.04); }
  .tile.selected img { filter: brightness(0.9); }
  .tile .check {
    position: absolute;
    top: 8px; left: 8px;
    width: 22px; height: 22px;
    border-radius: 999px;
    background: rgba(255,255,255,0.85);
    backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,0.9);
    box-shadow: 0 4px 10px rgba(0,0,0,0.18);
    display: inline-flex; align-items: center; justify-content: center;
    color: transparent;
    transition: background 300ms var(--easing), color 300ms var(--easing), transform 400ms var(--easing);
  }
  .tile.selected .check { background: var(--ink); color: #fff; transform: scale(1.05); }
  .tile .check svg { width: 12px; height: 12px; }
  .tile .pill {
    position: absolute;
    bottom: 8px; right: 8px;
    padding: 3px 8px;
    background: rgba(15,17,20,0.66);
    color: white;
    font-size: 10px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    backdrop-filter: blur(6px);
  }
  .tile.status-resolving .pill { background: rgba(31, 111, 85, 0.85); }
  .tile.status-error .pill { background: rgba(170, 60, 60, 0.85); }
  .tile.status-downloaded .pill { background: rgba(31, 111, 85, 0.85); }

  .empty {
    text-align: center;
    padding: 60px 30px;
    color: var(--ink-mute);
  }
  .empty .icon-wrap {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 18px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .empty .icon-wrap svg { width: 22px; height: 22px; color: var(--ink-mute); }
  .empty h3 { font-size: 16px; font-weight: 500; color: var(--ink); margin: 0 0 4px; letter-spacing: -0.01em; }
  .empty p { font-size: 13px; line-height: 1.5; max-width: 36ch; margin: 0 auto; }

  /* Footer */
  footer.bottom {
    padding: 14px 22px 18px;
    border-top: 1px solid var(--line);
    background: rgba(255,255,255,0.55);
    backdrop-filter: blur(14px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .progress {
    flex: 1;
    height: 4px;
    background: var(--paper-2);
    border-radius: 999px;
    overflow: hidden;
    position: relative;
  }
  .progress-bar {
    position: absolute;
    inset: 0;
    background: var(--ink);
    transform-origin: left;
    transform: scaleX(0);
    transition: transform 400ms var(--easing);
  }
  .download-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 18px;
    background: var(--ink);
    color: var(--paper);
    border: none;
    border-radius: 999px;
    font-size: 13.5px;
    font-weight: 500;
    cursor: pointer;
    letter-spacing: -0.005em;
    transition: transform 500ms var(--easing), background 300ms var(--easing), opacity 300ms var(--easing);
  }
  .download-btn:hover { background: #1c1d22; }
  .download-btn:active { transform: scale(0.97); }
  .download-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  .download-btn .arrow {
    width: 28px; height: 28px;
    background: rgba(255,255,255,0.12);
    border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform 500ms var(--easing);
  }
  .download-btn:hover .arrow { transform: translate(2px, 1px); }
  .download-btn svg { width: 12px; height: 12px; }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 22px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    padding: 10px 16px;
    background: var(--ink);
    color: var(--paper);
    border-radius: 999px;
    font-size: 12.5px;
    letter-spacing: -0.005em;
    box-shadow: var(--shadow-deep);
    opacity: 0;
    pointer-events: none;
    transition: opacity 400ms var(--easing), transform 500ms var(--easing);
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* Pulse for resolving/scanning state */
  @keyframes apShimmer {
    0% { background-position: -200px 0; }
    100% { background-position: 200px 0; }
  }
  .shimmer {
    background: linear-gradient(90deg, var(--paper-2) 0%, #f7f5f0 40%, var(--paper-2) 80%);
    background-size: 400px 100%;
    animation: apShimmer 1.6s linear infinite;
  }

  /* Mobile fallback */
  @media (max-width: 520px) {
    .panel { width: calc(100vw - 16px); top: 8px; right: 8px; bottom: 8px; border-radius: 22px; }
    .grid { grid-template-columns: repeat(2, 1fr); }
    .fab { right: 12px; bottom: 12px; }
  }
</style>

<div class="root" id="root">
  <button class="fab" id="fab" title="Open Aperture">
    <span class="label">Aperture</span>
    <span class="badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="13" r="4"/>
        <path d="M5 7h2l1.5-2h7L17 7h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>
      </svg>
    </span>
  </button>

  <div class="scrim" id="scrim"></div>

  <aside class="panel" id="panel" role="dialog" aria-label="Aperture photo grabber">
    <div class="panel-inner">
      <header class="top">
        <div>
          <span class="eyebrow"><span class="dot"></span> Photo grabber</span>
          <h2 class="title">Take the <em>full-resolution</em> set.</h2>
          <p class="subtitle">Aperture scans this album and pulls every photo at its native size — straight from Facebook's CDN.</p>
        </div>
        <button class="close-btn" id="closeBtn" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </header>

      <div class="scan-card">
        <div class="scan-card-inner">
          <div class="scan-meta">
            <span class="count" id="scanCount">0</span>
            <span class="label">Photos detected</span>
          </div>
          <button class="scan-action" id="scanBtn">
            <span id="scanLabel">Scan album</span>
            <span class="arrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-3-6.7"/>
                <path d="M21 4v5h-5"/>
              </svg>
            </span>
          </button>
        </div>
      </div>

      <div class="toolbar" id="toolbar" style="display:none;">
        <div class="chip-row">
          <button class="chip" id="chipAll" aria-pressed="true">All</button>
          <button class="chip" id="chipNone" aria-pressed="false">None</button>
        </div>
        <span class="selected-count"><strong id="selCount">0</strong> selected</span>
      </div>

      <div class="grid-wrap">
        <div class="empty" id="empty">
          <div class="icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"/>
              <path d="m20 20-3.5-3.5"/>
            </svg>
          </div>
          <h3>Nothing yet</h3>
          <p>Open a Facebook album or photos tab, then press <em>Scan album</em>. Aperture will gently scroll the page to discover every photo.</p>
        </div>
        <div class="grid" id="grid"></div>
      </div>

      <footer class="bottom">
        <div class="progress"><div class="progress-bar" id="progressBar"></div></div>
        <button class="download-btn" id="downloadBtn" disabled>
          <span id="downloadLabel">Download</span>
          <span class="arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4v12"/>
              <path d="m6 12 6 6 6-6"/>
              <path d="M5 20h14"/>
            </svg>
          </span>
        </button>
      </footer>
    </div>
  </aside>

  <div class="toast" id="toast"></div>
</div>
`;

  // -------------------------------------------------------------------------
  // UI Wiring
  // -------------------------------------------------------------------------

  const $ = (id) => ui.shadow.getElementById(id);

  const showToast = (msg, ms = 2400) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), ms);
  };

  const setOpen = (open) => {
    STATE.open = open;
    $('root').classList.toggle('open', open);
    if (open && STATE.photos.size === 0 && !STATE.scanning) {
      // Auto-scan on first open for convenience.
      handleScan();
    }
  };

  const renderGrid = () => {
    const grid = $('grid');
    const empty = $('empty');
    const items = [...STATE.photos.values()];
    if (items.length === 0) {
      empty.style.display = '';
      grid.innerHTML = '';
      $('toolbar').style.display = 'none';
      $('downloadBtn').disabled = true;
      return;
    }
    empty.style.display = 'none';
    $('toolbar').style.display = '';

    // Diff-friendly render: build innerHTML once.
    grid.innerHTML = items.map((item) => `
      <button class="tile ${item.selected ? 'selected' : ''} status-${item.status}" data-id="${item.fbid}" title="Photo ${item.fbid}">
        ${item.thumb ? `<img loading="lazy" src="${escapeAttr(item.thumb)}" />` : '<div class="shimmer" style="width:100%;height:100%"></div>'}
        <span class="check">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="m5 12 5 5L20 7"/>
          </svg>
        </span>
        ${statusPill(item)}
      </button>
    `).join('');

    grid.querySelectorAll('.tile').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const it = STATE.photos.get(id);
        if (!it) return;
        it.selected = !it.selected;
        el.classList.toggle('selected', it.selected);
        updateSelectionUI();
      });
    });

    updateSelectionUI();
  };

  const statusPill = (item) => {
    if (item.status === 'resolving') return '<span class="pill">Resolving</span>';
    if (item.status === 'ready') return '<span class="pill">Hi-res</span>';
    if (item.status === 'error') return '<span class="pill">Failed</span>';
    if (item.status === 'downloaded') return '<span class="pill">Saved</span>';
    return '';
  };

  const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');

  const updateSelectionUI = () => {
    const items = [...STATE.photos.values()];
    const selected = items.filter((p) => p.selected).length;
    $('selCount').textContent = String(selected);
    $('downloadBtn').disabled = selected === 0 || STATE.downloading;
    $('chipAll').setAttribute('aria-pressed', String(selected === items.length));
    $('chipNone').setAttribute('aria-pressed', String(selected === 0));
  };

  const setProgress = (frac) => {
    $('progressBar').style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
  };

  const wireUI = () => {
    $('fab').addEventListener('click', () => setOpen(true));
    $('closeBtn').addEventListener('click', () => setOpen(false));
    $('scrim').addEventListener('click', () => setOpen(false));

    $('scanBtn').addEventListener('click', () => handleScan());
    $('downloadBtn').addEventListener('click', () => handleDownload());

    $('chipAll').addEventListener('click', () => {
      STATE.photos.forEach((p) => (p.selected = true));
      renderGrid();
    });
    $('chipNone').addEventListener('click', () => {
      STATE.photos.forEach((p) => (p.selected = false));
      renderGrid();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && STATE.open) setOpen(false);
    });

    subscribe(renderGrid);
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleScan = async () => {
    if (STATE.scanning) return;
    STATE.scanning = true;
    $('scanBtn').disabled = true;
    $('scanLabel').textContent = 'Scanning…';
    showToast('Scrolling the album to find every photo…');

    STATE.albumName = detectAlbumName();

    const found = await autoScrollAndCollect(10);
    // Merge, keep existing selection state.
    found.forEach((v, k) => {
      if (!STATE.photos.has(k)) STATE.photos.set(k, v);
    });
    notify();

    $('scanLabel').textContent = 'Resolving…';
    showToast(`${STATE.photos.size} photos detected — fetching full-size URLs.`);

    const items = [...STATE.photos.values()].filter((p) => !p.fullUrl && p.status !== 'error');
    await resolveAll(items, 4);

    STATE.scanning = false;
    $('scanBtn').disabled = false;
    $('scanLabel').textContent = 'Re-scan';
    showToast('Ready. Pick the ones you want and hit Download.');
  };

  const handleDownload = async () => {
    if (STATE.downloading) return;
    const items = [...STATE.photos.values()].filter((p) => p.selected);
    if (items.length === 0) return;

    STATE.downloading = true;
    $('downloadBtn').disabled = true;
    $('downloadLabel').textContent = 'Saving…';
    setProgress(0);

    const folder = `Aperture/${(STATE.albumName || 'Facebook Photos').slice(0, 60)}`;
    let done = 0;

    for (const item of items) {
      // Lazy-resolve any photo that didn't get a full URL yet.
      if (!item.fullUrl) await resolveFullUrl(item);
      if (item.fullUrl) {
        const filename = `${item.fbid}`;
        const resp = await requestDownload(item.fullUrl, folder, filename);
        if (resp.ok) {
          item.status = 'downloaded';
        } else {
          item.status = 'error';
          console.warn('[Aperture] download error', resp.error);
        }
      } else {
        item.status = 'error';
      }
      done++;
      setProgress(done / items.length);
      notify();
      await sleep(120); // gentle pacing
    }

    STATE.downloading = false;
    $('downloadBtn').disabled = false;
    $('downloadLabel').textContent = 'Download';
    setProgress(0);
    showToast(`Saved ${done} photo${done === 1 ? '' : 's'} to your Downloads folder.`);
  };

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  const isRelevantPage = () => {
    const u = location.pathname + location.search;
    return /\/photos\b/.test(u) || /\/media\/set\b/.test(u) || /\/photo\b/.test(u) || /\bset=/.test(u);
  };

  const boot = () => {
    if (!ui) createUI();
    // Always render FAB; user can use Aperture anywhere on Facebook to scan
    // whatever links happen to be visible. We just hint relevance via the page.
  };

  // Re-detect on SPA navigation (Facebook is a single-page app).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Clear photos when navigating to a different album/page so users
      // get a clean scan on the new page.
      STATE.photos.clear();
      STATE.albumName = null;
      notify();
      $('scanCount') && ($('scanCount').textContent = '0');
      $('scanLabel') && ($('scanLabel').textContent = 'Scan album');
    }
  }, 1500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
