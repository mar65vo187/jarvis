/** Minimaler GitHub-Client (REST, Git-Data-API) - läuft über Obsidians requestUrl, also ohne CORS-Probleme. */
import { HttpError, getJson, postJson, streamRequest } from '../util/http';

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url?: string;
}

export interface GithubRepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  size?: number;
  pushed_at?: string;
}

/** Eintrag aus der eigenen Repository-Liste. */
export interface GithubRepoEntry {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string;
}

/** Angemeldetes Konto inklusive gemeldeter Rechte. */
export interface GithubAccount {
  login: string;
  name: string;
  /** Leer bei feingranularen Token - die melden ihre Rechte nicht. */
  scopes: string[];
}

export class GithubClient {
  constructor(
    private token: () => string,
    private userAgent: string,
    /** Adresse der API - änderbar für GitHub Enterprise oder Tests. */
    private apiBase: string | (() => string) = 'https://api.github.com',
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.token().trim();
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  private basis(): string {
    const value = typeof this.apiBase === 'function' ? this.apiBase() : this.apiBase;
    const trimmed = (value ?? '').trim();
    return trimmed || 'https://api.github.com';
  }

  private api(path: string): string {
    return `${this.basis().replace(/\/+$/, '')}${path}`;
  }

  /** Web-Adresse von github.com (für GitHub Enterprise passend zur API-Adresse). */
  webHost(): string {
    const basis = this.basis();
    if (basis.includes('api.github.com')) return 'https://github.com';
    const enterprise = basis.replace(/\/api\/v3\/?$/, '');
    return enterprise || 'https://github.com';
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.token().trim());
  }

  /** Angemeldetes Konto und gemeldete Rechte (Rechte stehen im Antwortkopf). */
  async whoami(): Promise<GithubAccount> {
    const { text, headers } = await this.requestUser();
    let login = '';
    let name = '';
    try {
      const data = JSON.parse(text) as { login?: string; name?: string | null; message?: string };
      login = data.login ?? '';
      name = data.name ?? '';
      if (!login && data.message) {
        throw new Error(
          /bad credentials/i.test(data.message)
            ? 'Der GitHub-Schlüssel wird nicht mehr angenommen (Bad credentials). Bitte neu verbinden.'
            : data.message,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message && !login) throw error;
      throw new Error('Antwort von GitHub war nicht lesbar.');
    }
    return { login, name, scopes: parseScopes(headers['x-oauth-scopes'] ?? headers['X-OAuth-Scopes']) };
  }

  /** GET /user mit verständlicher Fehlermeldung bei abgelehntem Schlüssel. */
  private async requestUser(): Promise<{ text: string; headers: Record<string, string> }> {
    try {
      return await streamRequest({
        url: this.api('/user'),
        method: 'GET',
        headers: this.headers(),
        timeoutMs: 20_000,
        allowStream: false,
        retries: 1,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const nachricht = githubFehlerText(error);
        if (error.status === 401) {
          if (/bad credentials|requires authentication/i.test(nachricht)) {
            throw new Error(
              'Der GitHub-Schlüssel wird nicht mehr angenommen (Bad credentials). Bitte unter "Mit GitHub verbinden" neu anmelden.',
            );
          }
        }
        if (error.status === 403 && /rate limit/i.test(nachricht)) {
          throw new Error('GitHub-Kontingent erschöpft. Bitte in einigen Minuten erneut versuchen.');
        }
        if (nachricht) throw new Error(`GitHub: ${nachricht}`);
      }
      throw error;
    }
  }

  /** Eigene Repositories (zuletzt genutzt zuerst). */
  async listRepos(limit = 100): Promise<GithubRepoEntry[]> {
    const perPage = Math.max(1, Math.min(100, limit));
    const data = await getJson<Array<Record<string, unknown>>>({
      url: this.api(`/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`),
      headers: this.headers(),
      timeoutMs: 30_000,
    });
    return (Array.isArray(data) ? data : [])
      .map((entry) => {
        const owner = (entry.owner as { login?: string } | undefined)?.login ?? '';
        const fullName = String(entry.full_name ?? (owner ? `${owner}/${entry.name ?? ''}` : ''));
        return {
          fullName,
          owner,
          name: String(entry.name ?? ''),
          defaultBranch: String(entry.default_branch ?? 'main'),
          private: Boolean(entry.private),
          pushedAt: String(entry.pushed_at ?? ''),
        };
      })
      .filter((entry) => entry.fullName.includes('/'))
      .slice(0, limit);
  }

  /** Neues Repository anlegen (auto_init sorgt dafür, dass der Branch existiert). */
  async createRepo(options: {
    name: string;
    description?: string;
    isPrivate?: boolean;
  }): Promise<GithubRepoEntry> {
    const name = options.name.trim();
    const body = JSON.stringify({
      name,
      description: options.description?.trim() || 'Vault-Sicherung von Jarvis AI (Obsidian)',
      private: options.isPrivate !== false,
      auto_init: true,
    });
    let json: {
      full_name?: string;
      name?: string;
      default_branch?: string;
      private?: boolean;
      owner?: { login?: string };
      message?: string;
    };
    try {
      json = (
        await postJson<{
          full_name?: string;
          name?: string;
          default_branch?: string;
          private?: boolean;
          owner?: { login?: string };
          message?: string;
        }>({
          url: this.api('/user/repos'),
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body,
          timeoutMs: 60_000,
        })
      ).json;
    } catch (error) {
      if (error instanceof HttpError) {
        const text = githubFehlerText(error);
        if (/name already exists/i.test(text)) {
          throw new Error(`Ein Repository mit dem Namen "${name}" gibt es bereits. Bitte einen anderen Namen wählen.`);
        }
        if (error.status === 403 && /rate limit/i.test(text)) {
          throw new Error('GitHub-Kontingent erschöpft. Bitte in einigen Minuten erneut versuchen.');
        }
        throw new Error(text || 'Das Repository konnte nicht angelegt werden.');
      }
      throw error;
    }
    if (!json.full_name) {
      throw new Error(
        /name already exists/i.test(json.message ?? '')
          ? `Ein Repository mit dem Namen "${name}" gibt es bereits. Bitte einen anderen Namen wählen.`
          : json.message || 'Das Repository konnte nicht angelegt werden.',
      );
    }
    const owner = json.owner?.login ?? json.full_name.split('/')[0];
    return {
      fullName: json.full_name,
      owner,
      name: json.name ?? options.name.trim(),
      defaultBranch: json.default_branch ?? 'main',
      private: Boolean(json.private),
      pushedAt: '',
    };
  }

  async repo(owner: string, repo: string): Promise<GithubRepoInfo> {
    return getJson<GithubRepoInfo>({
      url: this.api(`/repos/${owner}/${repo}`),
      headers: this.headers(),
      timeoutMs: 20_000,
    });
  }

  async branchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const data = await getJson<{ object?: { sha?: string } }>({
        url: this.api(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`),
        headers: this.headers(),
        timeoutMs: 20_000,
      });
      return data.object?.sha ?? null;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  async commitTree(owner: string, repo: string, commitSha: string): Promise<string> {
    const data = await getJson<{ tree?: { sha?: string } }>({
      url: this.api(`/repos/${owner}/${repo}/git/commits/${commitSha}`),
      headers: this.headers(),
      timeoutMs: 20_000,
    });
    if (!data.tree?.sha) throw new Error('Der letzte Commit hat keinen Baum (tree).');
    return data.tree.sha;
  }

  async remoteTree(owner: string, repo: string, treeSha: string): Promise<GitTreeEntry[]> {
    const data = await getJson<{ tree?: GitTreeEntry[]; truncated?: boolean }>({
      url: this.api(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`),
      headers: this.headers(),
      timeoutMs: 60_000,
    });
    return (data.tree ?? []).filter((entry) => entry.type === 'blob');
  }

  async createBlob(owner: string, repo: string, base64Content: string): Promise<string> {
    const { json } = await postJson<{ sha?: string }>({
      url: this.api(`/repos/${owner}/${repo}/git/blobs`),
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: base64Content, encoding: 'base64' }),
      timeoutMs: 120_000,
    });
    if (!json.sha) throw new Error('Blob konnte nicht angelegt werden.');
    return json.sha;
  }

  async readBlob(owner: string, repo: string, blobSha: string): Promise<Uint8Array> {
    const data = await getJson<{ content?: string; encoding?: string }>({
      url: this.api(`/repos/${owner}/${repo}/git/blobs/${blobSha}`),
      headers: this.headers(),
      timeoutMs: 120_000,
    });
    if (!data.content) return new Uint8Array();
    return base64ToBytes(data.content);
  }

  async createTree(
    owner: string,
    repo: string,
    baseTree: string | null,
    entries: Array<{ path: string; sha: string | null }>,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: '100644',
        type: 'blob',
        sha: entry.sha,
      })),
    };
    if (baseTree) body.base_tree = baseTree;
    const { json } = await postJson<{ sha?: string }>({
      url: this.api(`/repos/${owner}/${repo}/git/trees`),
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });
    if (!json.sha) throw new Error('Baum (tree) konnte nicht angelegt werden.');
    return json.sha;
  }

  async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parents: string[],
  ): Promise<string> {
    const { json } = await postJson<{ sha?: string }>({
      url: this.api(`/repos/${owner}/${repo}/git/commits`),
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message, tree: treeSha, parents }),
      timeoutMs: 60_000,
    });
    if (!json.sha) throw new Error('Commit konnte nicht erstellt werden.');
    return json.sha;
  }

  async updateRef(owner: string, repo: string, branch: string, sha: string, force = false): Promise<void> {
    await streamRequest({
      url: this.api(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`),
      method: 'PATCH',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ sha, force }),
      timeoutMs: 30_000,
      allowStream: false,
      // 422 (non-fast-forward) ist ein Konflikt, kein Netzfehler - nicht wiederholen.
      retries: 0,
    });
  }

  async createRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await streamRequest({
      url: this.api(`/repos/${owner}/${repo}/git/refs`),
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      timeoutMs: 30_000,
      allowStream: false,
    });
  }

  async rateLimit(): Promise<{ remaining: number; limit: number } | null> {
    try {
      const data = await getJson<{ rate?: { remaining?: number; limit?: number } }>({
        url: this.api('/rate_limit'),
        headers: this.headers(),
        timeoutMs: 15_000,
        retries: 0,
      });
      return { remaining: data.rate?.remaining ?? 0, limit: data.rate?.limit ?? 0 };
    } catch {
      return null;
    }
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Fehlermeldung aus einer GitHub-Antwort lesen (JSON mit "message"). */
export function githubFehlerText(error: HttpError): string {
  const body = (error.body ?? '').trim();
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { message?: string; error_description?: string };
    return parsed.message ?? parsed.error_description ?? '';
  } catch {
    return body.slice(0, 300);
  }
}

/** Rechte aus dem Antwortkopf "x-oauth-scopes" lesen. */
export function parseScopes(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** Reine JavaScript-Umsetzung von SHA-1 (Rückfall für Umgebungen ohne crypto.subtle,
 *  z. B. Obsidian Mobile auf Android). */
export function sha1Hex(data: Uint8Array): string {
  const messageLength = data.length;
  // Nachricht + Pflichtbyte + 8-Byte-Längenangabe auf 64-Byte-Blöcke aufrunden.
  const paddedLength = Math.max(64, ((messageLength + 9 + 63) >> 6) << 6);
  const withPadding = new Uint8Array(paddedLength);
  withPadding.set(data);
  withPadding[messageLength] = 0x80;
  const bitLength = messageLength * 8;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false);
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index++) {
      const value = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
      words[index] = ((value << 1) | (value >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, '0')).join('');
}

/** Git-Blob-Hash (SHA-1 über "blob <länge>\0<inhalt>"). */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const combined = new Uint8Array(header.length + content.length);
  combined.set(header, 0);
  combined.set(content, header.length);
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle?.digest) {
    try {
      const digest = await subtle.digest('SHA-1', combined);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Rückfall unten
    }
  }
  return sha1Hex(combined);
}
