# DAIS — OBJECT CREATION COMPANY

A replacement homepage built on the `mug` branch: the Stripe Press composition adapted to Shilpa's scanned mug and three scan photographs.

## Preview

From this directory, run `npm start`, then open <http://127.0.0.1:5188>. Python 3 is required for the local static server. There is no dependency installation or build step. `npm run check` checks the JavaScript syntax.

The site is static HTML, CSS, and browser JavaScript and can use the existing Vercel static-site configuration.

## Editing

- `index.html`: identity, photographs, and photo gallery.
- `styles.css`: layout, reference typography, responsive rules, and non-destructive photograph crops.
- `mug-viewer.js`: the complete STL rendered by Three.js. `ELEVATION_DEGREES` fixes the camera to 14°. Only the turntable's Y rotation changes in response to input; there are no zoom, pan, or vertical rotation controls.
- `app.js`: angle navigation and photo gallery.
- `assets/mug.stl`: the original full 501,912-triangle scan. STL carries geometry; the neutral ceramic material is defined in the viewer. The color photographs are separate original scan images.

The source scan has its opening facing negative Z. The viewer rotates the source geometry 90° around X to stand it upright, keeping its body centered on the rotation axis.

The images are cropped in CSS to keep the mug against the black scanning platform and exclude surrounding desk equipment. The original pixels are preserved in the image files. Crop origins are (630, 810) for images 6 and 12 and (630, 660) for image 17, all with a 950 × 950 window.

## Controls

Click and drag the mug horizontally for a full rotation. Moving the cursor without holding the mouse button does not rotate the mug. On touchscreens, drag horizontally; vertical swipes scroll the page. With the canvas focused, use Left/Right or Home. The left rail selects among 18 angles. Select a photograph to enlarge it and use Left/Right to browse. Escape closes the photo gallery.

## Sources

- Layout, colors, and Ivar font files: <https://press.stripe.com/>. Font assets retain their original ownership.
- Three.js 0.186.1 and STLLoader: npm's official `three` package, vendored locally. MIT license in `vendor/THREE-LICENSE.txt`.
- Mug scan and photographs: supplied Keyence scan files.

No analytics, external runtime scripts, or remote form submissions are included.
