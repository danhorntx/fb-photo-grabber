# Aperture — Facebook Photo Grabber

A small, beautifully designed Chrome extension that downloads full-resolution photos from Facebook albums and photo pages. Open the album, click the Aperture icon in your toolbar, hit one button, done.

## Install (unpacked)

1. Open Chrome and visit `chrome://extensions`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked** and choose this `fb-photo-grabber` folder.
4. Pin the Aperture icon to your toolbar for quick access.

## Use

1. Open any Facebook album, the **Photos** tab on a page, or a single photo.
2. Click the **Aperture** icon in your Chrome toolbar.
3. The popup shows the album name and how many photos were detected.
4. Click **Download N photos**. A progress bar shows the work in real time.
5. Files save to `Downloads / Aperture / [Album Name] / `.

If Aperture finds a recognizable album title on the page, you'll also see a small dark **"Download album"** button injected next to the title — same action, no need to open the popup.

## How it works

For each photo on the page, Aperture grabs the photo permalink, fetches the photo page from Facebook in the background (using your existing session cookies), and parses the `og:image` meta tag — the original-resolution image Facebook keeps on its CDN. Everything runs in your browser; nothing is sent anywhere else.

## File map

```
fb-photo-grabber/
├── manifest.json     Manifest V3 declaration & permissions
├── background.js     Service worker — bridges chrome.downloads
├── content.js        Headless content script — message API + inline button
├── popup.html / .css / .js  Toolbar popup (the primary UI)
└── icons/            16 / 32 / 48 / 128 PNGs
```

## Notes

- After modifying any extension file, click the small reload icon on the Aperture card at `chrome://extensions/`.
- For very large albums, the content script auto-scrolls up to ~12 passes to materialize photos before downloading. Re-open the popup and click the action again to pick up anything missed.
- Some very old albums may serve `og:image` at a slightly compressed size — that's a Facebook-side limit, not Aperture's.
