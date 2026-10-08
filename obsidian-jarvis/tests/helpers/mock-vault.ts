import type { VaultFileInfo, VaultReader, IndexPersist, Embedder } from '../../src/rag/vault-index';
import type { VaultFileSystem } from '../../src/github/sync';

export class MemoryVault implements VaultReader, VaultFileSystem {
  files = new Map<string, string>();
  private clock = 1_000;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.write(path, content);
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
    this.clock += 1000;
  }

  touch(path: string, content?: string): void {
    if (content !== undefined) this.files.set(path, content);
    this.clock += 1000;
  }

  async list(options?: { onlyMarkdown?: boolean; exclude?: string[] }): Promise<VaultFileInfo[]> {
    const exclude = options?.exclude ?? [];
    const onlyMarkdown = options?.onlyMarkdown ?? true;
    const out: VaultFileInfo[] = [];
    for (const [path, content] of this.files) {
      if (onlyMarkdown && !/\.(md|markdown)$/i.test(path)) continue;
      if (exclude.some((entry) => path === entry || path.startsWith(`${entry}/`))) continue;
      out.push({ path, mtime: this.clock, size: content.length });
    }
    return out;
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`nicht gefunden: ${path}`);
    return content;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.read(path));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, new TextDecoder().decode(data));
    this.clock += 1000;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

export class MemoryPersist implements IndexPersist {
  data: string | null = null;
  writes = 0;

  async read(): Promise<string | null> {
    return this.data;
  }

  async write(text: string): Promise<void> {
    this.data = text || null;
    this.writes++;
  }
}

/** Deterministischer Ersatz für ein Embedding-Modell.
 *  Vektoren entstehen aus Wort-Hashes - ähnliche Texte liegen dadurch näher beieinander. */
export class FakeEmbedder implements Embedder {
  readonly embeddedTexts: string[] = [];
  failNext = false;

  constructor(private model: string | null = 'fake-embed') {}

  modelName(): string | null {
    return this.model;
  }

  setModel(model: string | null): void {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    this.embeddedTexts.push(...texts);
    if (this.failNext) {
      this.failNext = false;
      return null;
    }
    if (!this.model) return null;
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-zäöü0-9]{3,}/g) ?? []) {
        let hash = 0;
        for (let index = 0; index < word.length; index++) hash = (hash * 31 + word.charCodeAt(index)) % 64;
        vector[hash] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}
