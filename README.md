# bookmark-sync

Two-way bookmark sync across Firefox, Chromium browsers and Safari — through a
private GitHub repo. No iCloud for Windows, no paid service, no server.

```
Firefox   ─┐
Chrome    ─┼─ extension ─┐
Edge/Brave─┘             ├─► private GitHub repo (bookmarks.json)
                         │
Safari (Mac) ─ native ───┘        │
   └─ iCloud carries it to ───────┴─► iPhone / iPad / other Macs
```

## Why Safari has no extension

Safari is the only major browser that never implemented the `bookmarks`
extension API. Chrome, Firefox, Edge, Brave, Vivaldi and Opera all have it;
Apple has left the enhancement requests open for years, and as of 2026 it is
still unavailable. **A Safari extension cannot read or write a single
bookmark** — there is no API to call. Any extension claiming otherwise is doing
something else (usually just saving the current tab into its own storage).

So the Safari side is a native helper that reads and writes
`~/Library/Safari/Bookmarks.plist` directly. This is strictly better for you
anyway: iCloud already watches that file, so anything written there reaches
Safari on your iPhone automatically. That is what replaces iCloud for Windows —
the Mac is the bridge, and your PC never talks to Apple at all.

## Setup

### 1. The repo

Create a **private** repo (e.g. `yourname/bookmarks`). Leave it empty.

Then create a **fine-grained personal access token** at
<https://github.com/settings/personal-access-tokens/new>:

- Repository access: **Only select repositories** → your bookmarks repo
- Permissions: **Contents → Read and write**. Nothing else.

Scope it to the one repo. If it ever leaks, that is the entire blast radius,
and you can revoke it without touching anything else in your account.

### 2. The browsers

```bash
node --test test/model.test.mjs
```

```powershell
.\build.ps1
```

- **Chrome / Edge / Brave** — `chrome://extensions` → Developer mode → Load
  unpacked → `dist\chromium`
- **Firefox** — `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → `dist\firefox\manifest.json`

Open the extension's options, paste the token, owner and repo, hit **Test
connection**, then **Sync now**. Do the first browser alone and confirm the
repo has a sensible `bookmarks.json` before adding the second.

### 3. The Mac (optional, but it is what gets you the iPhone)

```bash
mkdir -p ~/.bookmark-sync
cat > ~/.bookmark-sync/config.json <<'EOF'
{ "token": "github_pat_...", "owner": "yourname", "repo": "bookmarks" }
EOF

node mac/safari-sync.mjs --dry-run
```

Grant **Full Disk Access** to Terminal (System Settings → Privacy & Security →
Full Disk Access) — `~/Library/Safari` is TCC-protected and you will get a
permission error without it.

Once the dry run looks right, quit Safari and run it for real. To automate,
edit the paths in `mac/com.bookmarksync.safari.plist` and load it with
`launchctl`.

## Website and releases

`docs/` is the public download page (GitHub Pages: Settings → Pages → Deploy
from branch → `main` / `docs`). Its buttons link to
`releases/latest/download/*.zip`, which `.github/workflows/release.yml`
produces when you push a version tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Keep the tag equal to `version` in both manifests. The release contains:

| File | For |
|---|---|
| `bookmark-sync-chromium.zip` | Chrome / Edge / Brave, and the Chrome Web Store upload |
| `bookmark-sync-firefox.zip` | Firefox, and the addons.mozilla.org upload |
| `bookmark-sync-mac.zip` | Safari bridge — unzip, run `bash mac/install.sh` |

Chrome Web Store submission is manual: upload the chromium zip in the
[developer dashboard](https://chrome.google.com/webstore/devconsole), using
`docs/privacy.html` (on your Pages URL) as the privacy policy.

## How the merge works

Naive sync tools either last-writer-wins the whole tree (which silently eats
bookmarks) or match on nothing (which duplicates everything). This does neither.

- **Own UUIDs.** Native bookmark IDs are per-profile and meaningless across
  browsers, so every bookmark gets a UUID plus a persistent `nativeId ↔ uuid`
  map. The first time a browser meets an existing repo, nodes are paired by
  content — folders on path, bookmarks on URL plus containing path — so you
  adopt shared IDs instead of duplicating your whole library.
- **Three-way merge.** Every device keeps a snapshot of the last synced state.
  Merges are `base → local, remote`, resolved **per field**, so renaming a
  bookmark on one machine while moving it on another keeps both changes.
- **Tombstones.** Deletions are recorded with timestamps and kept for 90 days.
  Without them, a delete on device A gets resurrected by device B forever. An
  edit newer than the delete does win — that is deliberate.
- **Repair over failure.** A merge can produce an impossible tree (orphans, or
  a folder cycle when A→B and B→A happen concurrently). Those get rehomed to
  "Other bookmarks" rather than throwing. Losing a bookmark's *placement* is
  recoverable; losing the bookmark is not.
- **Echo suppression.** Applying remote changes fires the same `onCreated`
  events a user edit does. A flag suppresses those, or every sync would trigger
  another one.

Because the backend is git, every sync is a commit. When something does go
wrong, `git log` shows you exactly what changed and `git revert` puts it back.

## Things you should know

- **The token is stored unencrypted** in extension storage. That is the only
  place a browser extension *can* put it. Anyone with access to your OS user
  account can read it — which is why it should be fine-grained and scoped to
  the one repo.
- **Back up before the first sync.** Export bookmarks to HTML from every
  browser involved. The initial merge is the riskiest moment in the whole
  system's life; after that you have git history.
- **Firefox temporary add-ons vanish on restart.** For a permanent install you
  need it signed, which is free but not instant: submit to addons.mozilla.org
  as an *unlisted* add-on and you get a signed `.xpi` back for self-install.
- **Safari must be closed to be written.** It holds bookmarks in memory and
  rewrites the file on quit, so it would discard our changes. The script
  detects this and refuses rather than racing it.
- **iPhone means Safari.** Chrome and Firefox on iOS use their vendors' own
  sync and cannot be reached by any of this.
- **Reading List is never touched.** The Safari writer clones the original
  plist and only replaces the bookmark roots, so Reading List and Safari's
  private keys survive untouched.

## Layout

| Path | What |
|---|---|
| `src/model.js` | Canonical model, three-way merge, repair. Pure, no I/O. |
| `src/github.js` | GitHub Contents API, optimistic locking via blob SHA. |
| `src/browser-adapter.js` | Live tree ↔ canonical model, ID mapping, root mapping. |
| `src/background.js` | Orchestration, debounce, echo guard, retry. |
| `mac/safari-sync.mjs` | Safari bridge. Reuses `model.js` — one copy of the rules. |
| `mac/install.sh` | Installs the Safari bridge and its launchd agent. |
| `docs/` | Public download page and privacy policy. |
| `test/model.test.mjs` | Merge engine tests. |
