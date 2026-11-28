# Everything without runtime Blob operations

This branch is a prepared port, not a live migration. Production, its Blob store,
credentials, hostname and access policy have not been changed. The screenshot's
75% warning concerns Vercel Hobby **Blob Advanced Operations** (2,000 allowance),
not an invoice. Moving only images would leave authentication, throttling and
board saves using Blob; this port moves every Everything object to SQLite.

## What runs where

`npm start` runs the same `/everything/` editor and `/api/everything` contract on
one persistent owner-controlled host. The server binds only `127.0.0.1`, accepts
one configured Host, builds requests from one exact HTTPS `EVERYTHING_ORIGIN`,
and continues checking the browser's exact Origin on mutations. Forwarded Host,
Proto and client-IP headers cannot widen that trust. Login throttling behind the
proxy intentionally shares the loopback bucket, so spoofed IP headers cannot
bypass it (ten failed attempts temporarily block all users of this workspace).

SQLite stores sessions, login attempts, board JSON and original uploaded bytes.
It retains compare-and-swap writes across processes, revisions, seven-day bearer
sessions and page-memory-only authentication: refresh still locks the board.
The frontend, HTML, fonts, public assets, paste/HEIC conversion, gestures, sync
reconciliation and original/Instagram export code are unchanged. Existing upload
conversion rules still apply to *new* uploads; migration never re-encodes media.

The runtime import graph cannot reach the Blob SDK. `BLOB_READ_WRITE_TOKEN` has
no effect on the new dev or private server. The Vercel API entry point fails
closed because Vercel's ephemeral filesystem is not a persistent database.
`server/storage.js` remains solely for explicit offline migration and mocked
adapter tests. The writing feed and portfolio static allowlist are retained.

`vercel.json` disables Git deployments specifically for `vercel-workaround`.
Do not merge or deploy this branch as a public-site cutover: its Everything API
would deliberately be unavailable there until a separate routing decision.

## Hosting choice and limits

The leading route is the always-on Wi-Fi server plus **private Tailscale Serve**,
with a persistent local SSD, Node 22.13+ (Node 24 used in tests), a service manager,
and an existing authorized tailnet. Use a local disk, not NFS/shared cloud storage.
An example systemd unit is in `deployment/everything.service`; it is not installed.

Tailscale Serve exposes a loopback HTTP service over private HTTPS within a
tailnet. Serve the entire application at the origin root, so `/everything/`,
`/api/everything`, `/everything-assets`, Home and portfolio links remain same-origin.
Do not serve only the HTML directory or enable public Funnel. Require the proxy
to preserve the original Host, as in the [Tailscale TCP proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go). Confirm that behavior on the actual host before
cutover; arbitrary `X-Forwarded-*` trust has intentionally not been added.

Example configuration, **to fill in only after selecting and authorizing a host**:

```text
EVERYTHING_ORIGIN=https://YOUR-EXISTING-HOST.YOUR-TAILNET.ts.net
EVERYTHING_DATA_DIR=/var/lib/everything/restored-YYYYMMDD
EVERYTHING_PASSWORD=<the existing owner password, stored privately>
PORT=3000
```

Keep the environment file owner-readable only. Do not put either Blob token in
it. `npm start` does not read `.env.local`, requires an existing restored database
and refuses a non-HTTPS origin. The SQLite file is mode 0600; new data and backup
directories are 0700. Keep the database and backups out of the repository/web root
and on encrypted storage with an owner-controlled second backup copy.

After the host, tailnet and policy are approved, an operator can run the service
and configure `tailscale serve --bg http://127.0.0.1:3000`. Check `tailscale serve
status` and use the exact displayed HTTPS origin in `EVERYTHING_ORIGIN`. This is a
configuration example, not a command performed by this task.

This preserves the **path** `/everything/`, not automatically the existing public
portfolio **hostname**. The tailnet hostname and Tailscale connectivity on the
Mac/iPhone are observable changes. Keeping the current hostname requires an
explicit DNS/TLS/split-routing design and authorization; a public Vercel rewrite
cannot simply reach a private tailnet server. Public portfolio hosting can stay
as-is, while its private counterpart serves the unchanged Home links. A private
hostname avoids a public inbound port, VPS, storage subscription or domain purchase.
Whether Tailscale is free for this owner's existing account must be checked before
activation; no signup, purchase or access change is included. Electricity, disk
capacity, backups and host/network availability remain the owner's responsibility.
No implementation can honestly promise uninterrupted availability on an unchosen
Wi-Fi host or unchanged public URL without that routing decision.

Sources: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
and [Vercel Git deployment configuration](https://vercel.com/docs/project-configuration/git-configuration).

## Migration, verification and rollback

A PNG export is a flattened rendering, **not a board backup**. The backup format
contains the exact `board.json` bytes and revision, every unique referenced
`images/<original UUID>.<extension>` byte stream, and an ordered size/SHA-256
manifest. Reused media IDs stay reused. Missing files, mismatched formats,
truncated bytes, duplicate/missing inventory entries, or a board changing during
export abort the operation. No session records, passwords, or login attempts are
copied. The manifest detects corruption; it is not a cryptographic signature.
Unreferenced orphan uploads are outside this board snapshot.

The export reads board/media only; it does not list, write, or delete source Blob
objects. It reads the board a second time and requires unchanged storage ETag and
bytes. Restore writes into an inaccessible staging directory, compares every
object, closes and reopens the database, compares again, and atomically renames
it to a new destination. Existing destination directories are never overwritten.
The serving process must be stopped while changing its configured data directory.

1. Before any live operation, choose/authorize the host and hostname, test its
   HTTPS proxy and tailnet access with a synthetic backup, confirm durable storage,
   backup ownership, restart behavior, and real Mac/iPhone behavior below.
2. With separate approval for migration, save and lock **every** open production
   tab first. Freeze the old API server-side so no pending client can still write.
   A controlled deployment of this branch's storage-free `api/everything.js` alone
   is a possible freeze/retirement step; it deliberately makes Everything
   unavailable at that origin. Do not deploy it during preparation. Merely asking
   users not to edit is insufficient. Keep the old deployment and Blob data intact.
3. In a controlled one-time operator environment, explicitly provide
   `MIGRATION_BLOB_TOKEN` and run the opt-in command below. Never put the token in
   command arguments, logs, the service environment, or this repository. This is
   the only command capable of contacting Blob. It may consume one-time source
   reads; normal private-host operation consumes zero Blob operations. No live
   export was run during implementation.
4. Verify the bundle and restore into a fresh directory; verify again on the
   chosen host. Retain the immutable original backup and its manifest separately.
5. With the source still frozen, start the private service on the restored path,
   using the existing owner password. Check revision, layer IDs/counts, all image
   hashes, UI unlock, saves from two devices and exports. Then explicitly approve
   the chosen URL/routing switch. Ensure the old Vercel API stays retired; otherwise
   old tabs/bots could continue generating Blob operations against it.

```sh
# Only after separate source-read authorization, with MIGRATION_BLOB_TOKEN set:
node server/migrate.js export-blob --allow-blob-read /private/new-backup

# Entirely offline; destinations must not already exist:
node server/migrate.js verify /private/new-backup
node server/migrate.js restore /private/new-backup /var/lib/everything/restored-YYYYMMDD
node server/migrate.js verify-store /private/new-backup /var/lib/everything/restored-YYYYMMDD

# Recurring local backup; this does not contact Blob:
node server/migrate.js export-local /var/lib/everything/restored-YYYYMMDD /private/another-new-backup
```

**Rollback drill:** stop the private service, export and retain the *current*
SQLite board (including edits made after cutover), restore the selected earlier
bundle into another fresh directory, verify it, change `EVERYTHING_DATA_DIR`, and
restart. Check refresh-lock, revision and media before reconnecting clients.
If rolling back application code rather than data, keep the latest verified
backup and use compatible code with the latest restored database. Reverting to
an older board intentionally omits newer edits from the active view, so preserve
and review that newer backup first. Do not flip back to the old writable Vercel
board after new edits: it is stale. A lossless reverse migration into Blob would
require a separately authorized source freeze and write workflow; this tooling
never writes to Blob. No DNS changes are needed to roll back the private server's
data directory while retaining its hostname.

## Reproduce fixture validation

```sh
npm ci
npm test
npm run build
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The browser harness archives baseline commit
`40f435bd02e0c3d246496280729e965e53cdb612`, uses generated landscape/portrait PNGs
(1200×800 and 720×1280), seven editable layers and revision 37, then runs the
original server and the new service behind a local HTTPS reverse proxy. All
browser requests must remain same-origin; a preload rejects Blob imports and
all external fetches in the port server, even with an invalid Blob token present.
Screenshots, PNG downloads and a JSON result are saved under ignored
`test-results/parity/`. The browser tests use temporary directories and never
load `.env.local` or contact the live board. Set `BASELINE_REF` only to a reviewed
compatible baseline when intentionally updating the comparison.

The original gesture suite had one nondeterministic sample mixing real Event
startup time with synthetic wheel timestamps. This branch fixes the test's clock,
not the gesture implementation.

Before real cutover, still test on the chosen host: actual TLS/Host forwarding,
private tailnet reachability and policy on both devices, power/reboot persistence,
network interruption/reconnect, physical iPhone Safari pinch/touch, native paste
permissions/Photos/HEIC picker and save/share behavior. Emulation is not evidence
that those device/host integrations have been verified. The baseline comparison
also uses synthetic data and a local adapter, not the live Blob board.
