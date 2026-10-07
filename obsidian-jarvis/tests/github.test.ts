import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { startServer, json, text, type TestServer } from './helpers/server';
import { GithubClient, gitBlobSha, sha1Hex, bytesToBase64, base64ToBytes } from '../src/github/client';
import { GithubSync } from '../src/github/sync';
import { MemoryVault } from './helpers/mock-vault';
import type { GithubSettings } from '../src/types';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

/** Echter Git-Blob-Hash, damit der Testserver sich wie GitHub verhält. */
function gitSha(data: Uint8Array): string {
  const header = Buffer.from(`blob ${data.length}\u0000`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, Buffer.from(data)])).digest('hex');
}

interface FakeGithubState {
  blobs: Map<string, Uint8Array>;
  trees: Map<string, Array<{ path: string; mode: string; type: string; sha: string; size: number }>>;
  commits: Map<string, { tree: string; parents: string[] }>;
  refs: Map<string, string>;
  blobUploads: number;
}

/** Ein kleiner, aber echter Nachbau der GitHub-Git-Data-API. */
async function fakeGithub(): Promise<{ server: TestServer; state: FakeGithubState }> {
  const state: FakeGithubState = {
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    refs: new Map(),
    blobUploads: 0,
  };

  server = await startServer((req, res, body) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (url === '/repos/o/r' && method === 'GET') {
      json(res, 200, { full_name: 'o/r', default_branch: 'main', private: true });
      return;
    }
    if (url === '/rate_limit') {
      json(res, 200, { rate: { remaining: 4999, limit: 5000 } });
      return;
    }
    if (url.startsWith('/repos/o/r/git/ref/heads/') && method === 'GET') {
      const branch = url.split('/').pop()!;
      const sha = state.refs.get(branch);
      if (!sha) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { object: { sha } });
      return;
    }
    if (url.startsWith('/repos/o/r/git/commits/') && method === 'GET') {
      const sha = url.split('/').pop()!;
      const commit = state.commits.get(sha);
      if (!commit) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { tree: { sha: commit.tree } });
      return;
    }
    if (url.startsWith('/repos/o/r/git/trees/') && method === 'GET') {
      const sha = url.replace('/repos/o/r/git/trees/', '').split('?')[0];
      const entries = state.trees.get(sha);
      if (!entries) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { tree: entries, truncated: false });
      return;
    }
    if (url.startsWith('/repos/o/r/git/blobs/') && method === 'GET') {
      const sha = url.split('/').pop()!;
      const data = state.blobs.get(sha);
      if (!data) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { content: bytesToBase64(data), encoding: 'base64' });
      return;
    }
    if (url === '/repos/o/r/git/blobs' && method === 'POST') {
      const payload = JSON.parse(body) as { content: string; encoding: string };
      expect(payload.encoding).toBe('base64');
      const data = base64ToBytes(payload.content);
      const sha = gitSha(data);
      state.blobs.set(sha, data);
      state.blobUploads++;
      json(res, 201, { sha });
      return;
    }
    if (url === '/repos/o/r/git/trees' && method === 'POST') {
      const payload = JSON.parse(body) as {
        base_tree?: string;
        tree: Array<{ path: string; mode: string; type: string; sha: string | null }>;
      };
      const entries = new Map<string, { path: string; mode: string; type: string; sha: string; size: number }>();
      if (payload.base_tree) {
        for (const entry of state.trees.get(payload.base_tree) ?? []) entries.set(entry.path, entry);
      }
      for (const item of payload.tree) {
        if (item.sha === null) {
          entries.delete(item.path);
          continue;
        }
        entries.set(item.path, {
          path: item.path,
          mode: item.mode,
          type: item.type,
          sha: item.sha,
          size: state.blobs.get(item.sha)?.length ?? 0,
        });
      }
      const list = [...entries.values()];
      const treeSha = sha1(JSON.stringify(list));
      state.trees.set(treeSha, list);
      json(res, 201, { sha: treeSha });
      return;
    }
    if (url === '/repos/o/r/git/commits' && method === 'POST') {
      const payload = JSON.parse(body) as { tree: string; parents: string[]; message: string };
      const sha = sha1(JSON.stringify(payload));
      state.commits.set(sha, { tree: payload.tree, parents: payload.parents });
      json(res, 201, { sha });
      return;
    }
    if (url === '/repos/o/r/git/refs' && method === 'POST') {
      const payload = JSON.parse(body) as { ref: string; sha: string };
      state.refs.set(payload.ref.replace('refs/heads/', ''), payload.sha);
      json(res, 201, { ref: payload.ref, object: { sha: payload.sha } });
      return;
    }
    if (url.startsWith('/repos/o/r/git/refs/heads/') && method === 'PATCH') {
      const branch = url.split('/').pop()!;
      const payload = JSON.parse(body) as { sha: string };
      if (!state.refs.has(branch)) {
        json(res, 422, { message: 'Reference does not exist' });
        return;
      }
      state.refs.set(branch, payload.sha);
      json(res, 200, { object: { sha: payload.sha } });
      return;
    }
    text(res, 404, JSON.stringify({ message: `Nicht nachgebaut: ${method} ${url}` }));
  });

  return { server, state };
}

function makeSettings(overrides: Partial<GithubSettings & { onlyMarkdown: boolean }> = {}) {
  return () =>
    ({
      enabled: true,
      owner: 'o',
      repo: 'r',
      branch: 'main',
      pathPrefix: '',
      exclude: [],
      autoBackupMinutes: 0,
      backupOnChange: false,
      mirrorDelete: false,
      onlyMarkdown: true,
      lastCommitSha: '',
      lastBackupAt: '',
      ...overrides,
    }) as GithubSettings & { onlyMarkdown: boolean };
}

function makeSync(url: string, vault: MemoryVault, overrides: Partial<GithubSettings & { onlyMarkdown: boolean }> = {}) {
  const client = new GithubClient(() => 'github_pat_test', 'JarvisAI-Test/1.0.0', url);
  const settings = makeSettings({ ...overrides });
  return { sync: new GithubSync(client, vault, settings), client };
}

describe('Git-Blob-Hash', () => {
  it('reine JavaScript-SHA-1 stimmt mit Node überein (Rückfall für Mobilgeräte)', () => {
    for (const text of ['', 'a', 'hello world', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]) {
      const bytes = new TextEncoder().encode(text);
      const expected = crypto.createHash('sha1').update(Buffer.from(bytes)).digest('hex');
      expect(sha1Hex(bytes)).toBe(expected);
    }
  });

  it('stimmt mit dem Git-Hash überein', async () => {
    // git hash-object von "hello world\n"
    expect(await gitBlobSha(new TextEncoder().encode('hello world\n'))).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
    expect(await gitBlobSha(new TextEncoder().encode(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('Vault nach GitHub sichern', () => {
  it('legt beim ersten Mal Branch, Blobs, Commit an', async () => {
    const { server: fake, state } = await fakeGithub();
    const vault = new MemoryVault({
      'Notiz A.md': '# A\n\nInhalt A\n',
      'Ordner/Notiz B.md': '# B\n\nInhalt B\n',
    });
    const { sync } = makeSync(fake.url, vault);

    const test = await sync.test();
    expect(test.ok).toBe(true);
    expect(test.message).toContain('noch nicht vorhanden');

    const plan = await sync.planBackup();
    expect(plan.added.sort()).toEqual(['Notiz A.md', 'Ordner/Notiz B.md']);
    expect(plan.changed).toHaveLength(0);

    const outcome = await sync.backup({});
    expect(outcome.message).toContain('2 Datei(en) hochgeladen');
    expect(state.refs.get('main')).toBeTruthy();
    expect(state.blobUploads).toBe(2);
    const branchSha = state.refs.get('main')!;
    const tree = state.trees.get(state.commits.get(branchSha)!.tree)!;
    expect(tree.map((entry) => entry.path).sort()).toEqual(['Notiz A.md', 'Ordner/Notiz B.md']);
  });

  it('überträgt beim zweiten Mal nur Änderungen', async () => {
    const { server: fake, state } = await fakeGithub();
    const vault = new MemoryVault({ 'A.md': 'eins\n', 'B.md': 'zwei\n', 'C.md': 'drei\n' });
    const { sync } = makeSync(fake.url, vault);
    await sync.backup({});
    expect(state.blobUploads).toBe(3);

    const unchanged = await sync.planBackup();
    expect(unchanged.added).toHaveLength(0);
    expect(unchanged.changed).toHaveLength(0);
    expect(unchanged.unchanged).toBe(3);
    const second = await sync.backup({});
    expect(second.message).toContain('Nichts zu sichern');
    expect(state.blobUploads).toBe(3);

    vault.touch('B.md', 'zwei geändert\n');
    const changed = await sync.planBackup();
    expect(changed.changed).toEqual(['B.md']);
    await sync.backup({});
    expect(state.blobUploads).toBe(4);
  });

  it('entfernt gelöschte Dateien nur auf Wunsch', async () => {
    const { server: fake, state } = await fakeGithub();
    const vault = new MemoryVault({ 'A.md': 'eins\n', 'B.md': 'zwei\n' });
    const { sync } = makeSync(fake.url, vault);
    await sync.backup({});

    vault.files.delete('B.md');
    const plan = await sync.planBackup();
    expect(plan.deleted).toEqual(['B.md']);

    await sync.backup({ applyDeletions: false });
    let tree = state.trees.get(state.commits.get(state.refs.get('main')!)!.tree)!;
    expect(tree.map((entry) => entry.path)).toContain('B.md');

    await sync.backup({ applyDeletions: true });
    tree = state.trees.get(state.commits.get(state.refs.get('main')!)!.tree)!;
    expect(tree.map((entry) => entry.path)).not.toContain('B.md');
  });

  it('sichert auch in einen Unterordner und überträgt nur Markdown, wenn gewünscht', async () => {
    const { server: fake, state } = await fakeGithub();
    const vault = new MemoryVault({ 'A.md': 'inhalt\n', 'bild.png': 'PNG-Daten' });
    const { sync } = makeSync(fake.url, vault, { pathPrefix: 'vault' });
    await sync.backup({});
    const tree = state.trees.get(state.commits.get(state.refs.get('main')!)!.tree)!;
    expect(tree.map((entry) => entry.path)).toEqual(['vault/A.md']);
  });

  it('meldet fehlenden Token oder fehlende Angaben verständlich', async () => {
    const { server: fake } = await fakeGithub();
    const vault = new MemoryVault({ 'A.md': 'x' });
    const { sync } = makeSync(fake.url, vault, { owner: '', repo: '' });
    await expect(sync.planBackup()).rejects.toThrow(/GitHub-Benutzer und Repository/);
  });
});

describe('Vault aus GitHub wiederherstellen', () => {
  it('lädt fehlende und geänderte Dateien, überspringt identische', async () => {
    const { server: fake } = await fakeGithub();
    const source = new MemoryVault({ 'A.md': 'Inhalt A\n', 'Ordner/B.md': 'Inhalt B\n' });
    const { sync: backupSync } = makeSync(fake.url, source);
    await backupSync.backup({});

    // Neuer "Rechner": leerer Vault
    const target = new MemoryVault({});
    const { sync: restoreSync } = makeSync(fake.url, target);
    const plan = await restoreSync.planRestore();
    expect(plan.download.map((item) => item.path).sort()).toEqual(['A.md', 'Ordner/B.md']);
    expect(plan.download.every((item) => item.status === 'neu')).toBe(true);

    const outcome = await restoreSync.restore(plan, {});
    expect(outcome.message).toContain('2 Datei(en) geschrieben');
    expect(target.files.get('A.md')).toBe('Inhalt A\n');
    expect(target.files.get('Ordner/B.md')).toBe('Inhalt B\n');
  });

  it('schreibt unveränderte Dateien nicht erneut', async () => {
    const { server: fake } = await fakeGithub();
    const vault = new MemoryVault({ 'A.md': 'gleich\n' });
    const { sync } = makeSync(fake.url, vault);
    await sync.backup({});

    const plan = await sync.planRestore();
    const outcome = await sync.restore(plan, {});
    expect(outcome.message).toContain('0 Datei(en) geschrieben');
    expect(outcome.message).toContain('1 waren bereits identisch');
  });

  it('stellt den Zustand nach Änderungen des Quellrechners wieder her', async () => {
    const { server: fake } = await fakeGithub();
    const source = new MemoryVault({ 'A.md': 'Version 1\n' });
    const { sync: backupSync } = makeSync(fake.url, source);
    await backupSync.backup({});

    source.touch('A.md', 'Version 2\n');
    source.write('Neu.md', 'Neu dazu\n');
    await backupSync.backup({});

    const target = new MemoryVault({ 'A.md': 'Version 1\n' });
    const { sync: restoreSync } = makeSync(fake.url, target);
    const plan = await restoreSync.planRestore();
    await restoreSync.restore(plan, {});
    expect(target.files.get('A.md')).toBe('Version 2\n');
    expect(target.files.get('Neu.md')).toBe('Neu dazu\n');
  });
});
