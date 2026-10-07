/**
 * Tests für die GitHub-Anbindung: Anmeldung per Geräte-Code, Konto/Rechte,
 * Repository-Auswahl und -Erstellung, Konfliktbehandlung beim Sichern.
 */
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { startServer, json, text, type TestServer } from './helpers/server';
import { GithubClient, bytesToBase64, base64ToBytes } from '../src/github/client';
import { GithubSync } from '../src/github/sync';
import { GithubDeviceAuth, DeviceFlowError, hasContentsWrite, DEVICE_SCOPE } from '../src/github/oauth';
import { MemoryVault } from './helpers/mock-vault';
import type { GithubSettings } from '../src/types';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function gitSha(data: Uint8Array): string {
  const header = Buffer.from(`blob ${data.length}\u0000`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, Buffer.from(data)])).digest('hex');
}

function einstellungen(teil: Partial<GithubSettings> = {}): GithubSettings & { onlyMarkdown: boolean } {
  return {
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
    checkRemoteOnStart: false,
    oauthClientId: '',
    login: '',
    scopes: '',
    lastCommitSha: '',
    lastBackupAt: '',
    lastBackupIso: '',
    ...teil,
  };
}

interface DeviceState {
  anfragen: number;
  antworten: Array<Record<string, unknown>>;
  /** Wie oft vor dem Erfolg "authorization_pending" gemeldet wird. */
  pending: number;
}

/** Server, der den Geräte-Code-Ablauf nachbildet. */
async function fakeDeviceFlow(state: DeviceState): Promise<TestServer> {
  server = await startServer((req, res, body) => {
    const url = req.url ?? '';
    if (url === '/login/device/code') {
      expect(body).toContain('client_id=Iv1.test');
      expect(body).toContain(`scope=${encodeURIComponent(DEVICE_SCOPE)}`);
      json(res, 200, {
        device_code: 'devicecode-abc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
      return;
    }
    if (url === '/login/oauth/access_token') {
      expect(body).toContain('device_code=devicecode-abc');
      expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
      state.anfragen++;
      // Ohne ausdrückliche Antwort bleibt GitHub dabei: noch nicht bestätigt.
      const antwort = state.antworten.shift() ?? { error: 'authorization_pending' };
      json(res, 200, antwort);
      return;
    }
    json(res, 404, { message: 'Not Found' });
  });
  return server;
}

function keinWarten(): (ms: number) => Promise<void> {
  return async () => undefined;
}

describe('Anmeldung per Geräte-Code', () => {
  it('zeigt einen Code an und holt den Schlüssel, sobald bestätigt wurde', async () => {
    const state: DeviceState = { anfragen: 0, antworten: [{ error: 'authorization_pending' }, { access_token: 'gho_token' }], pending: 0 };
    const srv = await fakeDeviceFlow(state);
    const meldungen: string[] = [];
    const auth = new GithubDeviceAuth({
      clientId: 'Iv1.test',
      host: srv.url,
      sleep: keinWarten(),
      onPoll: (info) => meldungen.push(info.message),
    });

    const start = await auth.start();
    expect(start.userCode).toBe('ABCD-1234');
    expect(start.verificationUri).toBe('https://github.com/login/device');
    expect(start.interval).toBeGreaterThanOrEqual(5);

    const token = await auth.waitForToken(start);
    expect(token).toBe('gho_token');
    expect(state.anfragen).toBe(2);
    expect(meldungen.some((meldung) => meldung.includes('Warte auf die Bestätigung'))).toBe(true);
  });

  it('verlangsamt die Abfragen, wenn GitHub "slow_down" meldet', async () => {
    const state: DeviceState = {
      anfragen: 0,
      antworten: [{ error: 'slow_down' }, { error: 'authorization_pending' }, { access_token: 'gho_ok' }],
      pending: 0,
    };
    const srv = await fakeDeviceFlow(state);
    const wartezeiten: number[] = [];
    const auth = new GithubDeviceAuth({
      clientId: 'Iv1.test',
      host: srv.url,
      sleep: async (ms) => {
        wartezeiten.push(ms);
      },
    });
    const start = await auth.start();
    expect(await auth.waitForToken(start)).toBe('gho_ok');
    expect(wartezeiten[0]).toBe(5000);
    expect(wartezeiten[1]).toBe(10000); // slow_down: +5 Sekunden
  });

  it('meldet verständlich, wenn der Code abgelaufen oder abgelehnt wurde', async () => {
    const ablauf: DeviceState = { anfragen: 0, antworten: [{ error: 'expired_token' }], pending: 0 };
    const srv1 = await fakeDeviceFlow(ablauf);
    const auth1 = new GithubDeviceAuth({ clientId: 'Iv1.test', host: srv1.url, sleep: keinWarten() });
    const start1 = await auth1.start();
    await expect(auth1.waitForToken(start1)).rejects.toThrow(/abgelaufen/i);

    await srv1.close();
    const abgelehnt: DeviceState = { anfragen: 0, antworten: [{ error: 'access_denied' }], pending: 0 };
    const srv2 = await fakeDeviceFlow(abgelehnt);
    const auth2 = new GithubDeviceAuth({ clientId: 'Iv1.test', host: srv2.url, sleep: keinWarten() });
    const start2 = await auth2.start();
    await expect(auth2.waitForToken(start2)).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it('bricht ab, wenn niemand den Code bestätigt (Ablaufzeit erreicht)', async () => {
    const state: DeviceState = { anfragen: 0, antworten: [{ error: 'authorization_pending' }], pending: 0 };
    const srv = await fakeDeviceFlow(state);
    let uhr = 0;
    const auth = new GithubDeviceAuth({
      clientId: 'Iv1.test',
      host: srv.url,
      sleep: keinWarten(),
      now: () => {
        uhr += 400_000;
        return uhr;
      },
    });
    const start = await auth.start();
    await expect(auth.waitForToken(start)).rejects.toThrow(/abgelaufen/i);
  });

  it('erklärt ohne Client-ID, was zu tun ist', async () => {
    const auth = new GithubDeviceAuth({ clientId: '   ', sleep: keinWarten() });
    await expect(auth.start()).rejects.toThrow(/Client-ID/i);
  });
});

describe('Rechteprüfung', () => {
  it('erkennt fehlendes Schreibrecht', () => {
    expect(hasContentsWrite(['repo', 'read:user'])).toBe(true);
    expect(hasContentsWrite(['public_repo'])).toBe(true);
    expect(hasContentsWrite(['read:user'])).toBe(false);
    expect(hasContentsWrite([])).toBe(true); // feingranulare Token melden nichts
  });
});

interface KontoState {
  scopes?: string;
  repos?: Array<Record<string, unknown>>;
  createAntwort?: { status: number; payload: unknown };
  refFehler?: Array<number>;
}

/** Server für Konto-, Repository- und Git-Data-Endpunkte. */
async function fakeGithub(state: KontoState = {}): Promise<TestServer> {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Array<{ path: string; mode: string; type: string; sha: string; size: number }>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  const fehler = [...(state.refFehler ?? [])];

  server = await startServer((req, res, body) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (url === '/user' && method === 'GET') {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (state.scopes !== undefined) headers['x-oauth-scopes'] = state.scopes;
      res.writeHead(200, headers);
      res.end(JSON.stringify({ login: 'mar65vo187', name: 'Marvin' }));
      return;
    }
    if (url.startsWith('/user/repos') && method === 'GET') {
      json(res, 200, state.repos ?? []);
      return;
    }
    if (url === '/user/repos' && method === 'POST') {
      const payload = JSON.parse(body) as { name?: string; private?: boolean; auto_init?: boolean };
      if (state.createAntwort) {
        json(res, state.createAntwort.status, state.createAntwort.payload);
        return;
      }
      json(res, 201, {
        full_name: `mar65vo187/${payload.name}`,
        name: payload.name,
        owner: { login: 'mar65vo187' },
        default_branch: 'main',
        private: payload.private !== false,
      });
      return;
    }
    if (url === '/rate_limit') {
      json(res, 200, { rate: { remaining: 4999, limit: 5000 } });
      return;
    }
    if (url === '/repos/o/r' && method === 'GET') {
      json(res, 200, { full_name: 'o/r', default_branch: 'main', private: true });
      return;
    }
    if (url.startsWith('/repos/o/r/git/ref/heads/') && method === 'GET') {
      const sha = refs.get('main');
      if (!sha) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { object: { sha } });
      return;
    }
    // Ref-Update: hier kann ein Konflikt (422) eingebaut werden.
    if (url.startsWith('/repos/o/r/git/refs/heads/') && method === 'PATCH') {
      const naechster = fehler.shift();
      if (naechster === 422) {
        // Gleichzeitig hat ein anderer Rechner einen Commit gesetzt.
        const tree = trees.get('tree-remote') ?? [];
        trees.set('tree-remote', tree);
        const sha = crypto.createHash('sha1').update(`remote-${refs.size}`).digest('hex');
        commits.set(sha, { tree: 'tree-remote', parents: [] });
        refs.set('main', sha);
        json(res, 422, { message: 'Update is not a fast forward' });
        return;
      }
      const payload = JSON.parse(body) as { sha?: string };
      refs.set('main', payload.sha ?? '');
      json(res, 200, { object: { sha: payload.sha } });
      return;
    }
    if (url === '/repos/o/r/git/refs' && method === 'POST') {
      const payload = JSON.parse(body) as { sha?: string };
      refs.set('main', payload.sha ?? '');
      json(res, 201, { object: { sha: payload.sha } });
      return;
    }
    if (url.startsWith('/repos/o/r/git/commits/') && method === 'GET') {
      const commit = commits.get(url.split('/').pop()!);
      if (!commit) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { tree: { sha: commit.tree } });
      return;
    }
    if (url === '/repos/o/r/git/commits' && method === 'POST') {
      const payload = JSON.parse(body) as { tree?: string; parents?: string[] };
      const sha = crypto.createHash('sha1').update(`${payload.tree}-${refs.size}`).digest('hex');
      commits.set(sha, { tree: payload.tree ?? '', parents: payload.parents ?? [] });
      json(res, 201, { sha });
      return;
    }
    if (url === '/repos/o/r/git/trees' && method === 'POST') {
      const payload = JSON.parse(body) as {
        base_tree?: string;
        tree: Array<{ path: string; mode: string; type: string; sha: string | null }>;
      };
      const entries = new Map<string, { path: string; mode: string; type: string; sha: string; size: number }>();
      for (const entry of payload.base_tree ? trees.get(payload.base_tree) ?? [] : []) entries.set(entry.path, entry);
      for (const item of payload.tree) {
        if (item.sha === null) {
          entries.delete(item.path);
          continue;
        }
        const data = blobs.get(item.sha);
        entries.set(item.path, { path: item.path, mode: item.mode, type: item.type, sha: item.sha, size: data?.length ?? 0 });
      }
      const sha = crypto.createHash('sha1').update(JSON.stringify([...entries.keys()])).digest('hex');
      trees.set(sha, [...entries.values()]);
      json(res, 201, { sha });
      return;
    }
    if (url.startsWith('/repos/o/r/git/trees/') && method === 'GET') {
      const sha = url.replace('/repos/o/r/git/trees/', '').split('?')[0];
      const entries = trees.get(sha) ?? [];
      json(res, 200, { tree: entries, truncated: false });
      return;
    }
    if (url === '/repos/o/r/git/blobs' && method === 'POST') {
      const payload = JSON.parse(body) as { content?: string };
      const data = base64ToBytes(payload.content ?? '');
      const sha = gitSha(data);
      blobs.set(sha, data);
      json(res, 201, { sha });
      return;
    }
    if (url.startsWith('/repos/o/r/git/blobs/') && method === 'GET') {
      const data = blobs.get(url.split('/').pop()!);
      if (!data) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      json(res, 200, { content: bytesToBase64(data), encoding: 'base64' });
      return;
    }
    text(res, 404, '{"message":"Not Found"}');
  });
  return server;
}

function client(srv: TestServer, token = 'gho_test'): GithubClient {
  return new GithubClient(() => token, 'JarvisAI-Test/2.2.0', srv.url);
}

describe('Konto und Repositories', () => {
  it('liest Benutzername und gemeldete Rechte', async () => {
    const srv = await fakeGithub({ scopes: 'repo, read:user' });
    const konto = await client(srv).whoami();
    expect(konto.login).toBe('mar65vo187');
    expect(konto.name).toBe('Marvin');
    expect(konto.scopes).toEqual(['repo', 'read:user']);
  });

  it('meldet fehlendes Schreibrecht verständlich', async () => {
    const srv = await fakeGithub({ scopes: 'read:user' });
    const sync = new GithubSync(client(srv), new MemoryVault(), () => einstellungen());
    const konto = await sync.account();
    expect(konto.ok).toBe(true);
    expect(konto.message).toMatch(/es fehlt "repo"/);
  });

  it('erklärt einen abgelehnten Schlüssel', async () => {
    server = await startServer((_req, res) => {
      json(res, 401, { message: 'Bad credentials' });
    });
    await expect(client(server).whoami()).rejects.toThrow(/nicht mehr angenommen|Bad credentials/);
  });

  it('listet eigene Repositories auf', async () => {
    const srv = await fakeGithub({
      repos: [
        { full_name: 'mar65vo187/jarvis', name: 'jarvis', owner: { login: 'mar65vo187' }, default_branch: 'main', private: false, pushed_at: '2026-10-07T10:00:00Z' },
        { full_name: 'mar65vo187/vault', name: 'vault', owner: { login: 'mar65vo187' }, default_branch: 'trunk', private: true, pushed_at: '2026-10-07T12:00:00Z' },
      ],
    });
    const repos = await client(srv).listRepos();
    expect(repos.map((repo) => repo.fullName)).toEqual(['mar65vo187/jarvis', 'mar65vo187/vault']);
    expect(repos[1].defaultBranch).toBe('trunk');
    expect(repos[1].private).toBe(true);
  });

  it('legt ein neues privates Repository an und initialisiert es', async () => {
    const srv = await fakeGithub();
    const repo = await client(srv).createRepo({ name: 'jarvis-vault', isPrivate: true });
    expect(repo.fullName).toBe('mar65vo187/jarvis-vault');
    expect(repo.owner).toBe('mar65vo187');
    const angelegt = server?.requests.find((eintrag) => eintrag.url === '/user/repos' && eintrag.method === 'POST');
    expect(angelegt?.body).toContain('"auto_init":true');
    expect(angelegt?.body).toContain('"private":true');
  });

  it('meldet einen doppelten Namen verständlich', async () => {
    const srv = await fakeGithub({
      createAntwort: { status: 422, payload: { message: 'Repository creation failed. Name already exists on this account' } },
    });
    await expect(client(srv).createRepo({ name: 'jarvis-vault' })).rejects.toThrow(/gibt es bereits/);
  });
});

describe('Prüfen, ob GitHub neuer ist', () => {
  it('erkennt einen fremden Commit auf dem Branch', async () => {
    const srv = await fakeGithub();
    const sync = new GithubSync(client(srv), new MemoryVault(), () => einstellungen());

    expect(await sync.remoteHead()).toBeNull(); // Branch fehlt noch

    const vault = new MemoryVault({ 'Notiz.md': 'erste Fassung' });
    const sync2 = new GithubSync(client(srv), vault, () => einstellungen());
    const erst = await sync2.backup();
    expect(await sync2.remoteHead()).toBe(erst.commitSha);

    // Zweiter Rechner lädt etwas hoch.
    vault.write('Neu.md', 'vom anderen Rechner');
    const zweit = await sync2.backup();
    expect(zweit.commitSha).toBeTruthy();
    expect(await sync.remoteHead()).toBe(zweit.commitSha);
  });

  it('meldet fehlende Angaben verständlich', async () => {
    const srv = await fakeGithub();
    const sync = new GithubSync(client(srv), new MemoryVault(), () => einstellungen({ repo: '' }));
    await expect(sync.remoteHead()).rejects.toThrow(/Repository/i);
  });
});

describe('Sichern bei gleichzeitigen Änderungen', () => {
  it('versucht es bei "non-fast-forward" automatisch erneut', async () => {
    const srv = await fakeGithub({ refFehler: [422] });
    const vault = new MemoryVault({ 'Notiz.md': 'erste Fassung' });
    const sync = new GithubSync(client(srv), vault, () => einstellungen());

    // Erste Sicherung legt den Branch an.
    const erst = await sync.backup();
    expect(erst.commitSha).toBeTruthy();

    // Danach: ein anderer Rechner hat einen Commit gesetzt -> 422 -> automatischer zweiter Versuch.
    vault.write('Notiz.md', 'zweite Fassung');
    const zweit = await sync.backup();
    expect(zweit.message).toMatch(/hochgeladen|unverändert/);
    expect(zweit.detail ?? '').toMatch(/erneut versucht/);
  });

  it('bricht nach zwei Konflikten mit einer verständlichen Meldung ab', async () => {
    const srv = await fakeGithub({ refFehler: [422, 422] });
    const vault = new MemoryVault({ 'Notiz.md': 'erste Fassung' });
    const sync = new GithubSync(client(srv), vault, () => einstellungen());

    await sync.backup();
    vault.write('Notiz.md', 'zweite Fassung');
    await expect(sync.backup()).rejects.toThrow(/zweiten Rechner/);
  });

  it('nutzt eine eigene API-Adresse (GitHub Enterprise)', async () => {
    const srv = await fakeGithub();
    let abfragen = 0;
    const enterprise = new GithubClient(
      () => 'gho_test',
      'JarvisAI-Test/2.2.0',
      () => {
        abfragen++;
        return `${srv.url}/api/v3`;
      },
    );
    expect(enterprise.webHost()).toBe(srv.url);
    await expect(enterprise.whoami()).rejects.toThrow(); // /api/v3/user gibt es im Testserver nicht
    expect(abfragen).toBeGreaterThan(0);
  });
});
