# Aperture — Facebook Photo Grabber

A small, beautifully designed Chrome extension that downloads full-resolution photos from Facebook albums and photo pages. Open an album, click the floating Aperture pill, pick the photos you want, and they save straight to your Downloads folder.

## Install (unpacked)

1. Open Chrome and visit `chrome://extensions`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked**.
4. Select this `fb-photo-grabber` folder.

The Aperture icon will appear in your Chrome toolbar. Pin it for quick access.

## Use

1. Open any Facebook album, the **Photos** tab on a page, or a single photo.
2. Look for the floating **Aperture** pill at the bottom-right of the page.
3. Click it. The panel slides in and starts auto-scanning the album.
4. Aperture gently scrolls to discover every photo, then resolves each one's full-resolution URL from Facebook's CDN.
5. Tap photos to deselect any you don't want, or use **All / None**.
6. Click **Download**. Files save to `Downloads / Aperture / [Album Name] / `.

You can also click the Aperture icon in the Chrome toolbar to see the current page status and instructions.

## How it works

For each photo card on the page, Aperture grabs the photo permalink, fetches the photo page from Facebook in the background (using your existing session cookies), and parses the `og:image` meta tag — that's the original-resolution image Facebook keeps on its CDN. No third-party servers are touched.

## File map

```
fb-photo-grabber/
├── manifest.json        Manifest V3 declaration & permissions
├── background.js        Service worker — bridges chrome.downloads
├── content.js           Injects the floating UI (Shadow DOM, fully isolated)
├── popup.html / .css / .js   Toolbar popup
└── icons/               16 / 32 / 48 / 128 PNGs
```

## Privacy

Aperture runs entirely in your browser. It does not send any of your data, photo URLs, or activity anywhere outside Facebook itself.

## Notes

- Facebook updates its DOM frequently. If the floating pill stops finding photos, refresh the page or re-scan. The detector falls back through several patterns.
- Some very old albums may serve `og:image` at a slightly compressed size — that's a Facebook-side limit, not Aperture's.
- For very large albums, the auto-scroll capture is capped at 10 passes. Re-scan after scrolling further to pick up additional photos.
