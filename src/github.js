/**
 * GitHub Contents API storage adapter.
 *
 * The synced state is a single `bookmarks.json` in a private repo. Using git
 * as the backend buys three things for free: version history, a diff for every
 * sync, and `git revert` as the recovery path when a merge goes wrong.
 *
 * Concurrency is handled by the blob SHA: GitHub rejects a PUT whose `sha`
 * no longer matches HEAD, which gives us optimistic locking without a server.
 */

const API = 'https://api.github.com';

export class GitHubStore {
  /**
   * @param {{token:string, owner:string, repo:string, path?:string, branch?:string}} cfg
   */
  constructor(cfg) {
    this.cfg = { path: 'bookmarks.json', branch: 'main', ...cfg };
    this.sha = null; // blob SHA of the last version we read
  }

  get #headers() {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  #url() {
    const { owner, repo, path } = this.cfg;
    return `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  }

  /** Verify credentials and repo access before we ever try to write. */
  async check() {
    const { owner, repo } = this.cfg;
    const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: this.#headers });
    if (res.status === 401) throw new Error('GitHub token rejected (401). Is it expired?');
    if (res.status === 404) {
      throw new Error(
        `Cannot see ${owner}/${repo} (404). For a private repo the token needs ` +
        `Contents: Read and write on that repository.`
      );
    }
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const repoInfo = await res.json();
    if (!repoInfo.private) {
      console.warn('[bookmark-sync] Repo is PUBLIC. Your bookmarks will be world-readable.');
    }
    return repoInfo;
  }

  /**
   * Read the remote store. Returns null when the file does not exist yet,
   * which is the normal first-run case.
   */
  async read() {
    const res = await fetch(`${this.#url()}?ref=${this.cfg.branch}`, { headers: this.#headers });
    if (res.status === 404) { this.sha = null; return null; }
    if (!res.ok) throw new Error(`GitHub read failed ${res.status}: ${await res.text()}`);

    const body = await res.json();
    this.sha = body.sha;
    return JSON.parse(decodeBase64(body.content));
  }

  /**
   * Write the store back. Returns false on a lost race (someone else pushed
   * between our read and write) so the caller can re-read and re-merge rather
   * than clobber — never pass force here, the merge is cheap.
   */
  async write(store, message) {
    const payload = {
      message: message || `sync: ${new Date().toISOString()}`,
      content: encodeBase64(JSON.stringify(store, null, 2)),
      branch: this.cfg.branch,
    };
    if (this.sha) payload.sha = this.sha;

    const res = await fetch(this.#url(), {
      method: 'PUT',
      headers: { ...this.#headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // 409 = branch moved on. 422 = our `sha` is stale. Both mean re-merge.
    if (res.status === 409 || res.status === 422) return false;
    if (!res.ok) throw new Error(`GitHub write failed ${res.status}: ${await res.text()}`);

    this.sha = (await res.json()).content.sha;
    return true;
  }
}

/* base64 <-> UTF-8. btoa/atob are byte-oriented, so non-ASCII bookmark
 * titles (which are extremely common) corrupt without this round-trip. */

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
