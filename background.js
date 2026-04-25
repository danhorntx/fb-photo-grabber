// Aperture - Background Service Worker
// Handles downloads requested from the content script.

const sanitizeFilename = (name) => {
  return (name || 'photo')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
};

const inferExtension = (url) => {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const m = path.match(/\.(jpe?g|png|webp|gif|bmp|heic|heif)(?:$|\?)/);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  } catch (e) {}
  return 'jpg';
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'APERTURE_DOWNLOAD') {
    const { url, folder, filename } = message.payload;
    const safeFolder = sanitizeFilename(folder || 'Aperture');
    const ext = inferExtension(url);
    const safeName = sanitizeFilename(filename || `photo-${Date.now()}`);
    const finalName = safeName.toLowerCase().endsWith(`.${ext}`)
      ? safeName
      : `${safeName}.${ext}`;

    chrome.downloads.download(
      {
        url,
        filename: `${safeFolder}/${finalName}`,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, id: downloadId });
        }
      }
    );

    return true; // async response
  }

  if (message?.type === 'APERTURE_PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
});
