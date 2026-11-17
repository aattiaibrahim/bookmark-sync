import { GitHubStore } from '../src/github.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FIELDS = ['token', 'owner', 'repo', 'branch', 'path'];

const DEFAULTS = { branch: 'main', path: 'bookmarks.json' };

function readForm() {
  const cfg = {};
  for (const f of FIELDS) cfg[f] = $(f).value.trim() || DEFAULTS[f] || '';
  return cfg;
}

function say(msg) { $('status').textContent = msg; }

async function restore() {
  const { config } = await api.storage.local.get('config');
  for (const f of FIELDS) $(f).value = config?.[f] ?? DEFAULTS[f] ?? '';
  renderStatus();
}

async function renderStatus() {
  const { status } = await api.storage.local.get('status');
  if (!status) return;
  const when = status.at ? new Date(status.at).toLocaleTimeString() : '';
  const count = status.count != null ? ` · ${status.count} bookmarks` : '';
  say(`${status.state}${when ? ` at ${when}` : ''}${count}\n${status.message || ''}`.trim());
}

$('save').onclick = async () => {
  const config = readForm();
  if (!config.token || !config.owner || !config.repo) {
    return say('Token, owner and repo are all required.');
  }
  await api.storage.local.set({ config });
  say('Saved.');
};

$('test').onclick = async () => {
  say('Checking…');
  try {
    const info = await new GitHubStore(readForm()).check();
    say(`Connected to ${info.full_name} (${info.private ? 'private' : 'PUBLIC — your bookmarks would be world-readable'}).`);
  } catch (e) {
    say(String(e.message || e));
  }
};

$('sync').onclick = async () => {
  say('Syncing…');
  try {
    const res = await api.runtime.sendMessage({ type: 'sync-now' });
    if (res?.ok) await renderStatus();
    else say(res?.error || 'Sync failed.');
  } catch (e) {
    say(String(e.message || e));
  }
};

api.storage.onChanged.addListener((changes) => { if (changes.status) renderStatus(); });
restore();
