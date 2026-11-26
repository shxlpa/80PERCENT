
<img width="1470" height="956" alt="readme1" src="assets/Screenshot 2026-05-08 at 11.12.40 PM.png" />
<img width="1470" height="956" alt="readme2" src="assets/Screenshot 2026-05-08 at 11.12.49 PM.png" />
<img width="1470" height="956" alt="readme3" src="assets/Screenshot 2026-05-08 at 11.13.01 PM.png" />

Designed and built from scratch in CA, with love.
## Everything

The private idea canvas lives at `/everything/`. Use the Home link to return to the portfolio. Drop or paste an image, paste text, or use the floating toolbar. Space-drag pans, pinch or Ctrl-scroll zooms, and Shift-drag with a shape tool draws a square or circle. **Re-center** beside the zoom percentage brings all your layers into view (Shift+1). Select a layer to resize it, change its appearance, or move it forward or backward. With the Select tool (V), drag on empty canvas to select multiple layers. Shift-click toggles a layer, Shift-drag adds to the selection, and Ctrl/⌘+A selects all layers. Drag any selected layer to move the selection together, or press Delete to remove it. Edits save automatically as you work. The status reads **Autosaved** after the server confirms the save.

The image picker, clipboard, and drag-and-drop accept HEIC and HEIF photos. Your browser converts the primary still image before uploading it so the saved layer can open on other computers.

For text layers, use **Italic** in the inspector to toggle italics. Fill colors update live while you adjust the picker; Undo restores the color from before that adjustment.

Drag layers near matching edges or centers to snap into alignment. Text snaps to an image’s horizontal and vertical centers and to matching placements on aligned neighboring images. Move images edge-to-edge, then resize near a neighbor’s height or width to match it while preserving the photo’s proportions. Pink guides show the match; hold **Alt / Option** to move or resize freely.

### Run locally

Use Node.js 22.13 or later. Install dependencies with `npm ci`. The owner password comes from `EVERYTHING_PASSWORD` in the gitignored `.env.local`. On a fresh checkout, generate the file once with the following command. It creates an owner-readable file and stops if one already exists.

```sh
node -e "const fs = require('node:fs'); const pw = require('node:crypto').randomBytes(32).toString('base64url'); fs.writeFileSync('.env.local', 'EVERYTHING_PASSWORD=' + pw + '\\n', { mode: 0o600, flag: 'wx' })"
```

Run `npm run dev` and open `http://127.0.0.1:3000/everything/`. Local edits persist in the ignored `.everything-data/` directory. Run `npm test` to check access control, private image storage, and concurrent saves.

### Host on Vercel

The hosted board needs a private Vercel Blob store connected to the deployment environment, its `BLOB_READ_WRITE_TOKEN`, and the same owner password set as a sensitive `EVERYTHING_PASSWORD` environment variable. The `figma` branch uses the Preview environment. The build copies portfolio assets into `dist/` and the server function delivers the password form or editor. Password changes take effect on redeployment and invalidate existing sessions.

Unlocking applies only to the current page. Refreshing, leaving, closing the tab, or opening another tab requires the password again. Switching tabs keeps the open canvas unlocked. Board content and image files live on the server. Each save checks the board revision. Edits from different computers can be combined, and simultaneous edits to the same property preserve both versions as separate layers.
