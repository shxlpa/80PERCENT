
<img width="1470" height="956" alt="readme1" src="assets/Screenshot 2026-05-08 at 11.12.40 PM.png" />
<img width="1470" height="956" alt="readme2" src="assets/Screenshot 2026-05-08 at 11.12.49 PM.png" />
<img width="1470" height="956" alt="readme3" src="assets/Screenshot 2026-05-08 at 11.13.01 PM.png" />

Designed and built from scratch in CA, with love.
## Everything

The private idea canvas lives at `/everything/`. Use the Home link to return to the portfolio. Drop or paste an image, paste text, or use the floating toolbar. Space-drag pans, pinch or Ctrl-scroll zooms, and Shift-drag with a shape tool draws a square or circle. **Re-center** beside the zoom percentage brings all your layers into view (Shift+1). Select a layer to resize it, change its appearance, or move it forward or backward. With the Select tool (V), drag on empty canvas to select multiple layers. Shift-click toggles a layer, Shift-drag adds to the selection, and Ctrl/⌘+A selects all layers. Drag any selected layer to move the selection together, or press Delete to remove it. Edits save automatically as you work. The status reads **Autosaved** after the server confirms the save.

The image picker, clipboard, and drag-and-drop accept HEIC and HEIF photos. Your browser converts the primary still image before uploading it so the saved layer can open on other computers.

For text layers, use **Italic** in the inspector to toggle italics. Fill colors update live while you adjust the picker; Undo restores the color from before that adjustment.

Drag layers near matching edges or centers to snap into alignment. Text snaps to an image’s horizontal and vertical centers and to matching placements on aligned neighboring images. Move images edge-to-edge, then resize near a neighbor’s height or width to match it while preserving the photo’s proportions. Pink guides show the match; hold **Alt / Option** to move or resize freely.

Select a photo and choose **Save photo + overlays** to download a lossless PNG with the text, shapes, and images above it, clipped to the photo’s edges. Exports use the saved photo’s full resolution, regardless of canvas zoom. Selecting one photo together with text also works. JPEGs up to 4 MB are stored unchanged; larger uploads are reduced before storage, and exporting cannot recover detail removed during an earlier upload.

For an Instagram feed post, choose the separate **Save for Instagram** button. It centers the complete photo and its overlays inside a white **4:5** frame, adding borders on the sides of tall photos (or above and below wider photos). It retains the saved photo’s pixel dimensions without downsampling, cropping, or stretching it and leaves the canvas unchanged. For example, a 1152 × 2048 photo exports at 1640 × 2050 with white padding; 1080 × 1350 is the same ratio, but this export preserves the larger source. Filenames end in `-instagram-4x5.png`. Use **Save photo + overlays** for the original proportions.

Instagram’s native app [supports 3:4 photos](https://www.threads.com/@mosseri/post/DKOIbJkRNIb/), while [Meta’s publishing API](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media) specifies a 4:5 portrait limit. The Instagram button uses 4:5 for compatibility. In Instagram’s crop step, choose Original or 4:5 rather than Square; a square crop can still trim a portrait export. Use the same framing for every slide in a carousel.

### Run locally

Use Node.js 22.13 or later. Install dependencies with `npm ci`. The owner password comes from `EVERYTHING_PASSWORD` in the gitignored `.env.local`. On a fresh checkout, generate the file once with the following command. It creates an owner-readable file and stops if one already exists.

```sh
node -e "const fs = require('node:fs'); const pw = require('node:crypto').randomBytes(32).toString('base64url'); fs.writeFileSync('.env.local', 'EVERYTHING_PASSWORD=' + pw + '\\n', { mode: 0o600, flag: 'wx' })"
```

Run `npm run dev` and open `http://127.0.0.1:3000/everything/`. Local edits persist in the ignored `.everything-data/` directory. Run `npm test` to check access control, private image storage, and concurrent saves.

### Private hosting without Blob

The `vercel-workaround` branch runs Everything on persistent SQLite with the same editor. Use `npm start` on the chosen private HTTPS host; `npm run dev` remains loopback-only by default. Both private-server entry points use SQLite exclusively, even if a Blob token is present. The existing Vercel API and rewrite are preserved on main, so the current public workspace continues using its existing Blob configuration until a separately authorized host migration. Git deployment is disabled only for the development branch.

See [private hosting, migration, verification and rollback](docs/private-host.md) for setup and the lossless backup commands. Hosting and production migration require the owner's host/URL decision; no production cutover is part of this branch. A private Tailscale hostname preserves `/everything/` but does not automatically preserve the public portfolio hostname.

Unlocking applies only to the current page. Refreshing, leaving, closing the tab, or opening another tab requires the password again. Switching tabs keeps the open canvas unlocked. Board content and image files live on the server. Each save checks the board revision. Edits from different computers can be combined, and simultaneous edits to the same property preserve both versions as separate layers.
