# Fixture validation evidence

Compatibility update: main restores the exact pre-merge Vercel API and preserves its rewrite. The original evidence below describes the SQLite port commit `cc97d288`; its no-Blob runtime guarantee applies to `server/dev.js` and `server/serve.js`. The public Vercel API intentionally continues using Blob pending an authorized host migration. The compatibility regression test verifies that API against isolated mocked Blob records, never production data.

Baseline: `40f435bd02e0c3d246496280729e965e53cdb612` (current main at checkout).
The port retains all frontend, template, font and portfolio files byte-for-byte.
This is synthetic test evidence, not a copy or validation of the live board.

- Node 24.22.3: **84/84** unit/integration tests pass; static build and `git diff --check` pass.
- Desktop Chromium 141 and WebKit 26 with iPhone 13 emulation: four complete baseline/port runs pass through `/everything/`.
- Four locked/editor screenshot pairs and six full-resolution PNG export pairs are byte-identical. SHA-256 values and each run's checks are in [parity-results.json](parity-results.json).
- Each run starts at revision 37 with 7 layers and 2 unique original PNGs (one image ID reused). Upload, clipboard text/image and a stale second session produce revision 42 with 11 layers, including one tested 409 reconciliation.
- Portrait exports: original 720×1280 and Instagram 1024×1280; landscape with overlays: 1200×800. Exports leave board data unchanged.
- Refresh returns to password entry; unauthenticated board/media reads are denied; browser storage holds no session. Unlock restores the saved board; logout leaves the independent second session usable.
- No external browser requests or JavaScript errors. The port is started with a deliberately invalid Blob token and a loader that rejects Blob imports plus all external server fetches. The runtime import graph test covers dev, private host and the Vercel API; HTTP tests cover login throttling too.
- Backup/restore and rollback compare exact board JSON bytes, revision, IDs and media bytes after disk reopen; malformed/missing media, corruption, source changes and existing destinations are rejected. CLI round-trip and mocked Blob exact-key export pass without any live credential.

| Screen | Baseline | Private HTTPS port |
| --- | --- | --- |
| Desktop board | [PNG](desktop-chromium-baseline-board.png) | [PNG](desktop-chromium-port-board.png) |
| iPhone WebKit board | [PNG](iphone-webkit-baseline-board.png) | [PNG](iphone-webkit-port-board.png) |

The original baseline test run was 76/77: its Safari pinch test mixed a real Event timestamp with synthetic times. Only that test's timestamp was corrected; gesture code remains unchanged.

Playwright browser downloads used its public Microsoft mirror after the primary CDN returned 403. Missing WebKit libraries were unpacked in a private temporary folder, without system installation. WebKit itself launched and ran successfully. `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` bypassed its system-package presence check after those runtime libraries were supplied; it did not skip browser tests.

Limitations: no physical iPhone or actual Tailscale host was used. Mobile tap is native browser automation; mobile pinch uses dispatched WebKit gesture events because Playwright cannot synthesize native mobile WebKit wheel/pinch. Clipboard tests dispatch actual browser ClipboardEvents with DataTransfer contents, not OS clipboard permission UI. Native Photos/HEIC picker, share/download, network-loss, host reboot, real HTTPS forwarding and tailnet policy checks remain before activation. The local baseline uses its SQLite adapter with the same fixtures, not live Blob. Live source export, migration, URL routing and production retirement have not occurred.

See [the deployment and rollback runbook](../private-host.md) for the remaining steps.
