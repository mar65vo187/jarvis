/** Verbindet die reine Logik mit der echten Obsidian-Oberfläche. */
import { App, MarkdownView, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import type { JsonPersist } from './learn/store';
import type { MemoryNoteFs } from './learn/notes';
import type { VaultFileInfo, VaultReader, IndexPersist, Embedder } from './rag/vault-index';
import type { VaultFileSystem } from './github/sync';
import type { OllamaProvider } from './providers/ollama';
import type { ToolVault } from './tools/types';
import type { ObsidianKontrolle } from './tools/obsidian';

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

/** Bekannte Ollama-Embedding-Modelle als Rückfall, wenn das Wunschmodell fehlt. */
export const OLLAMA_EMBED_MODEL_FALLBACKS = [
  'nomic-embed-text',
  'qwen3-embedding',
  'embeddinggemma',
  'mxbai-embed-large',
  'bge-m3',
];

/** Embeddings über das lokale Ollama-Modell. Fällt still aus, wenn keines läuft. */
export class OllamaEmbedder implements Embedder {
  private resolvedKey: string | null = null;
  private resolvedModel: string | null = null;
  private resolvedAt = 0;
  private resolving: { key: string; promise: Promise<string | null> } | null = null;
  private readonly missingRetryMs = 30_000;

  constructor(
    private provider: OllamaProvider,
    private settings: () => { useEmbeddings: boolean; embedModel: string },
  ) {}

  private settingsKey(settings = this.settings()): string {
    return JSON.stringify([settings.useEmbeddings, settings.embedModel.trim()]);
  }

  modelName(): string | null {
    const settings = this.settings();
    if (!settings.useEmbeddings) return null;
    const key = this.settingsKey(settings);
    return this.resolvedKey === key ? this.resolvedModel : null;
  }

  /** Vor dem Indexlauf das tatsächlich installierte Modell auflösen. */
  async resolveModel(): Promise<string | null> {
    while (true) {
      const settings = this.settings();
      const key = this.settingsKey(settings);
      if (!settings.useEmbeddings) {
        this.resolvedKey = key;
        this.resolvedModel = null;
        this.resolvedAt = Date.now();
        return null;
      }

      if (this.resolvedKey === key &&
          (this.resolvedModel !== null || Date.now() - this.resolvedAt < this.missingRetryMs)) {
        return this.resolvedModel;
      }

      let pending = this.resolving?.key === key ? this.resolving.promise : null;
      if (!pending) {
        const candidates = [...new Set([settings.embedModel.trim(), ...OLLAMA_EMBED_MODEL_FALLBACKS].filter(Boolean))];
        let promise: Promise<string | null>;
        promise = Promise.resolve()
          .then(() => this.provider.findEmbedModel(candidates))
          .catch(() => null)
          .then((found) => {
            // A stale lookup must not overwrite a result for newer settings.
            if (this.resolving?.key === key && this.resolving.promise === promise) {
              this.resolvedKey = key;
              this.resolvedModel = found;
              this.resolvedAt = Date.now();
            }
            return found;
          });
        this.resolving = { key, promise };
        pending = promise;
      }

      try {
        await pending;
      } finally {
        if (this.resolving?.promise === pending) this.resolving = null;
      }
      const latest = this.settings();
      if (this.settingsKey(latest) !== key) continue;
      if (this.resolvedKey === key) return this.resolvedModel;
      // Settings may have changed away and back while a previous lookup was in flight.
      // Loop once more so the current configuration always gets a cached resolution.
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
    const model = await this.resolveModel();
    if (!model) return null;
    try {
      return await this.provider.embed(model, texts, signal);
    } catch {
      // Keep the model resolution so a transient request failure can recover on retry.
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
/**
 * Die Obsidian-Oberfläche für Jarvis: geöffnete Notiz, Auswahl im Editor,
 * Tagesnotiz, Verweise und Tags. Alles defensiv — fehlt etwas, kommt eine
 * verständliche Meldung statt eines Absturzes.
 */
export function obsidianKontrolle(app: App, tagesnotizOrdner: () => string): ObsidianKontrolle {
  const datei = (pfad: string): TFile | null => {
    const treffer = app.vault.getAbstractFileByPath(normalizePath(pfad));
    return treffer instanceof TFile ? treffer : null;
  };

  const offenerEditor = (): { notiz: string; auswahl: string; ersetzen: (text: string) => void } | null => {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;
    const editor = view.editor;
    if (!editor) return null;
    return {
      notiz: view.file.path,
      auswahl: editor.getSelection(),
      ersetzen: (text: string) => {
        if (editor.getSelection()) {
          editor.replaceSelection(text);
          return;
        }
        // Nichts markiert: am Ende der Notiz einfügen.
        const zeile = editor.lastLine();
        const ende = editor.getLine(zeile).length;
        editor.replaceRange(text.startsWith('\n') ? text : `\n${text}`, { line: zeile, ch: ende });
      },
    };
  };

  return {
    aktuelleNotiz: () => offenerEditor()?.notiz ?? '',
    leseAktuelle: async () => {
      const pfad = offenerEditor()?.notiz;
      if (!pfad) return null;
      return obsidianToolVaultLesen(app, pfad);
    },
    auswahl: () => offenerEditor()?.auswahl ?? '',
    auswahlNotiz: () => offenerEditor()?.notiz ?? '',
    ersetzeAuswahl: async (text: string) => {
      const editor = offenerEditor();
      if (!editor) return { ok: false, text: 'Es ist gerade keine Notiz geöffnet.' };
      try {
        editor.ersetzen(text);
        return { ok: true, text: `Der Text wurde in "${editor.notiz}" eingefügt.`, summary: 'eingefügt' };
      } catch (fehler) {
        return { ok: false, text: `Der Text konnte nicht eingefügt werden: ${(fehler as Error).message}` };
      }
    },
    oeffne: async (pfad: string) => {
      const ziel = datei(pfad);
      if (!ziel) return false;
      try {
        await app.workspace.getLeaf(false).openFile(ziel);
        return true;
      } catch {
        return false;
      }
    },
    verweise: (pfad: string) => {
      const ziel = datei(pfad);
      const ausgehend: string[] = [];
      const eingehend: string[] = [];
      if (!ziel) return { ausgehend, eingehend };
      try {
        const cache = app.metadataCache.getFileCache(ziel);
        for (const link of cache?.links ?? []) {
          const zielDatei = app.metadataCache.getFirstLinkpathDest(link.link, pfad);
          const name = zielDatei?.path ?? link.link;
          if (name && !ausgehend.includes(name)) ausgehend.push(name);
        }
        const aufgeloest = app.metadataCache.resolvedLinks ?? {};
        for (const [quelle, ziele] of Object.entries(aufgeloest)) {
          if (quelle === pfad) continue;
          if (ziele && Object.prototype.hasOwnProperty.call(ziele, pfad) && !eingehend.includes(quelle)) eingehend.push(quelle);
        }
      } catch {
        /* Metadaten nicht verfügbar */
      }
      return { ausgehend: ausgehend.slice(0, 60), eingehend: eingehend.slice(0, 60) };
    },
    tags: () => {
      const zaehler = new Map<string, number>();
      try {
        const eintraege = (app.metadataCache as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
        for (const [tag, anzahl] of Object.entries(eintraege)) {
          zaehler.set(tag.replace(/^#/, ''), typeof anzahl === 'number' ? anzahl : 0);
        }
      } catch {
        /* Tags nicht verfügbar */
      }
      return [...zaehler.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },
    tagesnotizPfad: () => {
      const ordner = (tagesnotizOrdner() || '').replace(/^\/+|\/+$/g, '');
      const heute = new Date();
      const name = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}.md`;
      return ordner ? `${ordner}/${name}` : name;
    },
    lesePfad: async (pfad: string) => obsidianToolVaultLesen(app, pfad),
    schreibe: async (pfad: string, text: string) => {
      const ziel = datei(pfad);
      try {
        if (ziel) {
          await app.vault.append(ziel, text.startsWith('\n') ? text : `\n${text}`);
          return { ok: true, text: `An "${pfad}" angehängt.`, summary: 'angehängt' };
        }
        const ordner = pfad.split('/').slice(0, -1).join('/');
        if (ordner && !app.vault.getAbstractFileByPath(ordner)) await app.vault.createFolder(ordner).catch(() => undefined);
        await app.vault.create(normalizePath(pfad), `${text}\n`);
        return { ok: true, text: `"${pfad}" wurde angelegt.`, summary: 'angelegt' };
      } catch (fehler) {
        return { ok: false, text: `Schreiben fehlgeschlagen: ${(fehler as Error).message}` };
      }
    },
  };
}

async function obsidianToolVaultLesen(app: App, pfad: string): Promise<string | null> {
  const treffer = app.vault.getAbstractFileByPath(normalizePath(pfad));
  if (treffer instanceof TFile) {
    try {
      return await app.vault.cachedRead(treffer);
    } catch {
      /* fällt unten auf den Adapter zurück */
    }
  }
  try {
    if (await app.vault.adapter.exists(normalizePath(pfad))) return await app.vault.adapter.read(normalizePath(pfad));
  } catch {
    /* nicht lesbar */
  }
  return null;
}

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
