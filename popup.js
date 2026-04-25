// Aperture popup — checks the active tab and offers a one-tap entry point.

const $ = (id) => document.getElementById(id);

const setStatus = (state, text, help) => {
  const dot = $('statusDot');
  dot.classList.remove('ok', 'warn');
  if (state === 'ok') dot.classList.add('ok');
  if (state === 'warn') dot.classList.add('warn');
  $('statusText').textContent = text;
  $('statusHelp').innerHTML = help || '&nbsp;';
};

const isFacebookUrl = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)facebook\.com$/i.test(u.hostname);
  } catch (e) {
    return false;
  }
};

const looksLikePhotosPage = (url) => {
  try {
    const u = new URL(url);
    return /\/photos\b|\/media\/set\b|\/photo(\.php)?\b|\bset=/.test(u.pathname + u.search);
  } catch (e) {
    return false;
  }
};

const init = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url) {
    setStatus('warn', 'No active tab', 'Open a Facebook tab to get started.');
    return;
  }

  if (!isFacebookUrl(tab.url)) {
    setStatus('warn', 'Not on Facebook',
      'Aperture works on <em>facebook.com</em>. Open an album or photos tab and try again.');
    $('ctaLabel').textContent = 'Open Facebook';
    $('ctaBtn').disabled = false;
    $('ctaBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.facebook.com/' });
      window.close();
    });
    return;
  }

  if (!looksLikePhotosPage(tab.url)) {
    setStatus('ok', 'Connected to Facebook',
      'Navigate to an <em>album</em> or the <em>Photos</em> tab — the Aperture pill will appear at the bottom-right.');
    $('ctaLabel').textContent = 'Got it';
    $('ctaBtn').disabled = false;
    $('ctaBtn').addEventListener('click', () => window.close());
    return;
  }

  setStatus('ok', 'Album detected',
    'Press the floating <em>Aperture</em> pill on the page to scan and download.');
  $('ctaLabel').textContent = 'Focus the page';
  $('ctaBtn').disabled = false;
  $('ctaBtn').addEventListener('click', async () => {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
    window.close();
  });
};

init();
