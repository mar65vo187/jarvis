/** Verbindet die reine Logik mit der echten Obsidian-Oberfläche. */
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { JsonPersist } from './learn/store';
import type { MemoryNoteFs } from './learn/notes';
import type { VaultFileInfo, VaultReader, IndexPersist, Embedder } from './rag/vault-index';
import type { VaultFileSystem } from './github/sync';
import type { OllamaProvider } from './providers/ollama';

const ALWAYS_IGNORED = ['.git', '.trash', 'node_modules', '.obsidian/plugins/jarvis-ai/cache'];

export class ObsidianVaultReader implements VaultReader {
  constructor(private app: App) {}

  async list(): Promise<VaultFileInfo[]> {
    return this.app.vault.getMarkdownFiles().map((file) => ({
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
    }));
  }

  async read(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Notiz nicht gefunden: ${path}`);
    return this.app.vault.cachedRead(file);
  }
}

export class ObsidianVaultFileSystem implements VaultFileSystem {
  constructor(
    private app: App,
    private pluginId: string,
  ) {}

  private isIgnored(path: string, exclude: string[]): boolean {
    const normalized = path.replace(/\\/g, '/');
    const patterns = [...ALWAYS_IGNORED, ...exclude.map((entry) => entry.trim()).filter(Boolean)];
    return patterns.some((pattern) => {
      const clean = pattern.replace(/^\/+|\/+$/g, '');
      if (!clean) return false;
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return true;
      // Muster ohne Ordnerpfad gilt für jede Ebene
      if (!clean.includes('/')) {
        return normalized.split('/').includes(clean) || new RegExp(`(^|/)${escapeRegExp(clean)}$`, 'i').test(normalized);
      }
      return false;
    });
  }

  async list(options: { onlyMarkdown: boolean; exclude: string[] }): Promise<Array<{ path: string; size: number }>> {
    const out: Array<{ path: string; size: number }> = [];
    const files = options.onlyMarkdown
      ? this.app.vault.getMarkdownFiles()
      : this.app.vault.getAllLoadedFiles().filter((item): item is TFile => item instanceof TFile);
    for (const file of files) {
      if (this.isIgnored(file.path, options.exclude)) continue;
      if (file.path.startsWith(`${this.app.vault.configDir}/plugins/${this.pluginId}/`)) continue;
      if (/\.obsidian-plugin-cache\.json$/i.test(file.path)) continue;
      out.push({ path: file.path, size: file.stat.size });
    }
    return out;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) {
      return new Uint8Array(await this.app.vault.readBinary(file));
    }
    const adapter = this.app.vault.adapter;
    const buffer = await adapter.readBinary(normalizePath(path));
    return new Uint8Array(buffer);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const adapter = this.app.vault.adapter;
    const parent = normalized.split('/').slice(0, -1).join('/');
    if (parent && !(await adapter.exists(parent))) {
      await adapter.mkdir(parent);
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
    } else {
      await adapter.writeBinary(normalized, buffer);
    }
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file) {
      await this.app.fileManager.trashFile(file);
      return;
    }
    await this.app.vault.adapter.remove(normalized);
  }
}

export class PluginIndexPersist implements IndexPersist {
  constructor(
    private app: App,
    private pluginId: string,
  ) {}

  private get path(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}/cache/vault-index.json`);
  }

  private async ensureFolder(): Promise<void> {
    const folder = this.path.split('/').slice(0, -1).join('/');
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }
  }

  async read(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.path))) return null;
      return await adapter.read(this.path);
    } catch {
      return null;
    }
  }

  async write(text: string): Promise<void> {
    if (!text) {
      const adapter = this.app.vault.adapter;
      try {
        if (await adapter.exists(this.path)) await adapter.remove(this.path);
      } catch {
        // egal
      }
      return;
    }
    await this.ensureFolder();
    await this.app.vault.adapter.write(this.path, text);
  }
}

/** Beliebige JSON-Datei im Plugin-Ordner (z. B. der Lernspeicher). */
export class ObsidianJsonFile implements JsonPersist {
  constructor(
    private app: App,
    private path: string,
  ) {}

  private async ensureFolder(): Promise<void> {
    const folder = normalizePath(this.path).split('/').slice(0, -1).join('/');
    const adapter = this.app.vault.adapter;
    if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
  }

  async read(): Promise<string | null> {
    try {
      const target = normalizePath(this.path);
      if (!(await this.app.vault.adapter.exists(target))) return null;
      return await this.app.vault.adapter.read(target);
    } catch {
      return null;
    }
  }

  async write(text: string): Promise<void> {
    await this.ensureFolder();
    await this.app.vault.adapter.write(normalizePath(this.path), text);
  }
}

/** Zugriff auf die gelernten Notizen im Vault. */
export class ObsidianMemoryNoteFs implements MemoryNoteFs {
  constructor(private app: App) {}

  async ensureFolder(folder: string): Promise<void> {
    const target = normalizePath(folder);
    if (!(await this.app.vault.adapter.exists(target))) {
      await this.app.vault.adapter.mkdir(target);
    }
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const folder = normalized.split('/').slice(0, -1).join('/');
    if (folder) await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.adapter.write(normalized, content);
  }

  async read(path: string): Promise<string | null> {
    try {
      const normalized = normalizePath(path);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) return await this.app.vault.cachedRead(file);
      if (await this.app.vault.adapter.exists(normalized)) return await this.app.vault.adapter.read(normalized);
      return null;
    } catch {
      return null;
    }
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file) {
      await this.app.vault.delete(file);
      return;
    }
    if (await this.app.vault.adapter.exists(normalized)) await this.app.vault.adapter.remove(normalized);
  }

  async list(prefix: string): Promise<string[]> {
    const folder = normalizePath(prefix);
    const out: string[] = [];
    const walk = (current: string): void => {
      const entry = this.app.vault.getAbstractFileByPath(current);
      if (entry instanceof TFolder) {
        for (const child of entry.children) {
          if (child instanceof TFile) out.push(child.path);
          else if (child instanceof TFolder) walk(child.path);
        }
        return;
      }
      for (const file of this.app.vault.getFiles()) {
        if (file.path === folder || file.path.startsWith(`${folder}/`)) out.push(file.path);
      }
    };
    walk(folder);
    return out;
  }
}

/** Embeddings über das lokale Ollama-Modell. Fällt still aus, wenn keines läuft. */
export class OllamaEmbedder implements Embedder {
  private broken = false;
  private resolved: string | null = null;

  constructor(
    private provider: OllamaProvider,
    private settings: () => { useEmbeddings: boolean; embedModel: string; preferred: string[] },
  ) {}

  modelName(): string | null {
    if (this.broken) return null;
    const settings = this.settings();
    if (!settings.useEmbeddings) return null;
    return this.resolved ?? (settings.embedModel || null);
  }

  /** Beim Start prüfen, welches Embedding-Modell wirklich installiert ist. */
  async resolve(): Promise<string | null> {
    if (this.broken) return null;
    const settings = this.settings();
    if (!settings.useEmbeddings) return null;
    if (this.resolved) return this.resolved;
    const candidates = [
      settings.embedModel,
      'nomic-embed-text',
      'qwen3-embedding',
      'embeddinggemma',
      'mxbai-embed-large',
      'bge-m3',
      ...settings.preferred,
    ].filter(Boolean);
    const found = await this.provider.findEmbedModel(candidates);
    if (found) this.resolved = found;
    else this.broken = true;
    return this.resolved;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
    const model = (await this.resolve()) ?? this.modelName();
    if (!model) return null;
    try {
      const vectors = await this.provider.embed(model, texts, signal);
      if (!vectors) {
        this.broken = true;
        return null;
      }
      return vectors;
    } catch {
      return null;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function folderExists(app: App, path: string): boolean {
  const folder = app.vault.getAbstractFileByPath(normalizePath(path));
  return folder instanceof TFolder;
}
