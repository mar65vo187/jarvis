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

export class GithubClient {
  constructor(
    private token: () => string,
    private userAgent: string,
    /** Adresse der API - änderbar für GitHub Enterprise oder Tests. */
    private apiBase = 'https://api.github.com',
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

  private api(path: string): string {
    return `${this.apiBase.replace(/\/+$/, '')}${path}`;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.token().trim());
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

  async updateRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await streamRequest({
      url: this.api(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`),
      method: 'PATCH',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ sha, force: false }),
      timeoutMs: 30_000,
      allowStream: false,
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
