/** Verbindet die reine Logik mit der echten Obsidian-Oberfläche. */
import { App, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import type { JsonPersist } from './learn/store';
import type { MemoryNoteFs } from './learn/notes';
import type { VaultFileInfo, VaultReader, IndexPersist, Embedder } from './rag/vault-index';
import type { VaultFileSystem } from './github/sync';
import type { OllamaProvider } from './providers/ollama';
import type { ToolVault } from './tools/types';

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

/**
 * Vault-Zugriff für die Werkzeuge (lesen, anlegen, anhängen).
 * Schreiben passiert nur, wenn der Nutzer „Notizen ändern" freigeschaltet hat.
 */
export class ObsidianToolVault implements ToolVault {
  constructor(private app: App) {}

  private async sicherstellen(pfad: string): Promise<void> {
    const sauber = normalizePath(pfad);
    const ordner = sauber.split('/').slice(0, -1).join('/');
    if (!ordner) return;
    if (!this.app.vault.getAbstractFileByPath(ordner)) {
      await this.app.vault.createFolder(ordner).catch(() => undefined);
    }
  }

  async read(path: string): Promise<string | null> {
    const ziel = normalizePath(path);
    const datei = this.app.vault.getAbstractFileByPath(ziel);
    if (datei instanceof TFile) {
      try {
        return await this.app.vault.cachedRead(datei);
      } catch {
        /* fällt unten auf den Adapter zurück */
      }
    }
    try {
      if (await this.app.vault.adapter.exists(ziel)) return await this.app.vault.adapter.read(ziel);
    } catch {
      /* nicht lesbar */
    }
    return null;
  }

  async exists(path: string): Promise<boolean> {
    const ziel = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(ziel)) return true;
    return this.app.vault.adapter.exists(ziel);
  }

  async create(path: string, content: string): Promise<void> {
    const ziel = normalizePath(path);
    await this.sicherstellen(ziel);
    const datei = this.app.vault.getAbstractFileByPath(ziel);
    if (datei instanceof TFile) {
      await this.app.vault.modify(datei, content);
      return;
    }
    await this.app.vault.create(ziel, content);
  }

  async append(path: string, content: string): Promise<void> {
    const vorhanden = await this.read(path);
    await this.overwrite(path, vorhenderInhalt(vorhanden, content));
  }

  async overwrite(path: string, content: string): Promise<void> {
    const ziel = normalizePath(path);
    await this.sicherstellen(ziel);
    const datei = this.app.vault.getAbstractFileByPath(ziel);
    if (datei instanceof TFile) {
      await this.app.vault.modify(datei, content);
      return;
    }
    await this.app.vault.adapter.write(ziel, content);
  }

  async listMarkdown(): Promise<string[]> {
    return this.app.vault.getMarkdownFiles().map((datei) => datei.path).sort((a, b) => a.localeCompare(b));
  }

  vaultPath(): string {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    try {
      return adapter.getBasePath?.() ?? '';
    } catch {
      return '';
    }
  }

  name(): string {
    try {
      return this.app.vault.getName();
    } catch {
      return 'Vault';
    }
  }
}

function vorhenderInhalt(vorhanden: string | null, neu: string): string {
  if (!vorhanden) return neu;
  const trenner = vorhanden.endsWith('\n') ? '' : '\n';
  return `${vorhanden}${trenner}${neu.startsWith('\n') ? neu.slice(1) : `\n${neu}`}`;
}

/**
 * Zugriff auf Node (Desktop): Programme starten, Dateien außerhalb des Vaults.
 *
 * Bewusst über globalThis/window statt über einen statischen Import — sonst
 * ließe sich das Bündel nicht für Obsidian bauen (Node-Module gibt es dort nur
 * auf dem Desktop). Auf Tablet/Handy kommt hier nichts zurück.
 */
export function desktopNodeRequire(): ((modul: string) => unknown) | undefined {
  const kandidaten: Array<unknown> = [
    (globalThis as { require?: unknown }).require,
    typeof window !== 'undefined' ? (window as unknown as { require?: unknown }).require : undefined,
  ];
  for (const kandidat of kandidaten) {
    if (typeof kandidat !== 'function') continue;
    const laden = kandidat as (modul: string) => unknown;
    try {
      laden('node:child_process');
      return (modul: string) => laden(modul);
    } catch {
      /* kein Node — weiter suchen */
    }
  }
  return undefined;
}

/** Befehle auf dem Rechner ausführen (nur Desktop, über node:child_process). */
export function nodeCommandRunner(
  laden: (modul: string) => unknown,
): (command: string, options: { cwd?: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }> {
  const cp = laden('node:child_process') as {
    exec(
      command: string,
      options: Record<string, unknown>,
      callback: (fehler: unknown, stdout: string, stderr: string) => void,
    ): void;
  };
  return (command, options) =>
    new Promise((resolve, reject) => {
      try {
        cp.exec(
          command,
          { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
          (fehler, stdout, stderr) => {
            if (fehler && typeof (fehler as { code?: unknown }).code !== 'number' && !stdout && !stderr) {
              reject(fehler instanceof Error ? fehler : new Error(String(fehler)));
              return;
            }
            const code = fehler ? Number((fehler as { code?: unknown }).code ?? 1) : 0;
            resolve({
              code: Number.isFinite(code) ? code : 1,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? '') || (fehler ? String((fehler as Error).message) : ''),
            });
          },
        );
      } catch (fehler) {
        reject(fehler instanceof Error ? fehler : new Error(String(fehler)));
      }
    });
}

/**
 * Beliebiges HTTP über Obsidian (requestUrl) — keine CORS-Probleme, funktioniert
 * auf Desktop und Mobil. Wird von MCP, GitHub, HuggingFace und n8n benutzt.
 */
export function obsidianHttp(): (options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: string; headers: Record<string, string> }> {
  return async (options) => {
    const antwort = await requestUrl({
      url: options.url,
      method: (options.method ?? 'GET') as never,
      headers: { accept: 'application/json, text/plain, text/event-stream', ...(options.headers ?? {}) },
      ...(options.body === undefined ? {} : { body: options.body }),
      throw: false,
    });
    const kopfzeilen: Record<string, string> = {};
    for (const [name, wert] of Object.entries(antwort.headers ?? {})) kopfzeilen[name.toLowerCase()] = String(wert);
    return { status: antwort.status, text: antwort.text, headers: kopfzeilen };
  };
}

/** HTTP-Zugriff für MCP-Server (POST mit JSON). */
export function obsidianFetchJson(): (options: {
  url: string;
  headers?: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const http = obsidianHttp();
  return async (options) =>
    http({
      url: options.url,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: options.body,
      signal: options.signal,
    });
}
