/**
 * Vault <-> GitHub.
 *
 * Sicherung: alle Dateien werden als ein einziger Commit hochgeladen.
 * Nur geänderte Dateien werden übertragen (Vergleich über den Git-Hash).
 * Wiederherstellung: Vorschau, dann werden nur geänderte Dateien geschrieben.
 */
import { GithubClient, gitBlobSha, textToBase64, bytesToBase64, type GithubRepoEntry } from './client';
import { hasContentsWrite } from './oauth';
import { HttpError } from '../util/http';
import type { GithubSettings } from '../types';

export interface VaultFileSystem {
  list(options: { onlyMarkdown: boolean; exclude: string[] }): Promise<Array<{ path: string; size: number }>>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface BackupPlan {
  total: number;
  added: string[];
  changed: string[];
  unchanged: number;
  deleted: string[];
  bytes: number;
}

export interface RestorePlan {
  download: Array<{ path: string; sha: string; size: number; status: 'neu' | 'geändert'; bytes: number }>;
  unchanged: number;
  remoteOnly: string[];
  bytes: number;
}

export interface SyncOutcome {
  commitSha?: string;
  message: string;
  detail?: string;
}

const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Meldet GitHub, dass der Branch inzwischen woanders weitergelaufen ist? */
function isNonFastForward(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 422) return false;
  const text = `${error.body ?? ''} ${error.message ?? ''}`;
  return /fast.?forward|is at .* but expected|does not match/i.test(text);
}

export class GithubSync {
  constructor(
    private client: GithubClient,
    private fs: VaultFileSystem,
    private settings: () => GithubSettings & { onlyMarkdown: boolean },
  ) {}

  private remotePath(localPath: string): string {
    const prefix = (this.settings().pathPrefix ?? '').trim().replace(/^\/+|\/+$/g, '');
    const clean = localPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return prefix ? `${prefix}/${clean}` : clean;
  }

  private localPath(remotePath: string): string | null {
    const prefix = (this.settings().pathPrefix ?? '').trim().replace(/^\/+|\/+$/g, '');
    const clean = remotePath.replace(/\\/g, '/');
    if (!prefix) return clean;
    if (clean === prefix) return null;
    if (!clean.startsWith(`${prefix}/`)) return null;
    return clean.slice(prefix.length + 1);
  }

  private validate(): void {
    const settings = this.settings();
    if (!settings.owner?.trim() || !settings.repo?.trim()) {
      throw new Error('Bitte in den Einstellungen GitHub-Benutzer und Repository angeben.');
    }
    if (!settings.branch?.trim()) {
      throw new Error('Bitte in den Einstellungen einen Branch angeben (z. B. main).');
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      this.validate();
      const settings = this.settings();
      const repo = await this.client.repo(settings.owner, settings.repo);
      const head = await this.client.branchHead(settings.owner, settings.repo, settings.branch);
      const rate = await this.client.rateLimit();
      const parts = [
        `✅ Verbunden mit ${repo.full_name} (Standard-Branch: ${repo.default_branch}).`,
        head
          ? `Branch "${settings.branch}" existiert, letzter Commit ${head.slice(0, 7)}.`
          : `Branch "${settings.branch}" ist noch nicht vorhanden und wird beim ersten Sichern angelegt.`,
      ];
      if (rate) parts.push(`GitHub-Kontingent: ${rate.remaining}/${rate.limit} Anfragen übrig.`);
      if (settings.branch !== repo.default_branch) {
        parts.push(`Hinweis: Gesichert wird nach "${settings.branch}", nicht nach "${repo.default_branch}".`);
      }
      return { ok: true, message: parts.join('\n') };
    } catch (error) {
      return { ok: false, message: `GitHub: ${(error as Error).message}` };
    }
  }

  /** Konto und Rechte prüfen — ohne Repository-Angaben nutzbar. */
  async account(): Promise<{ ok: boolean; message: string; login?: string; scopes?: string[] }> {
    try {
      const konto = await this.client.whoami();
      const parts = [
        konto.name ? `✅ Angemeldet als ${konto.login} (${konto.name}).` : `✅ Angemeldet als ${konto.login}.`,
      ];
      if (konto.scopes.length) {
        parts.push(
          hasContentsWrite(konto.scopes)
            ? `Rechte: ${konto.scopes.join(', ')} — Inhalte schreiben ist erlaubt.`
            : `⚠️ Rechte: ${konto.scopes.join(', ')} — es fehlt "repo" (Inhalte lesen und schreiben). ` +
                'Bitte neu verbinden oder einen Schlüssel mit Schreibrecht verwenden.',
        );
      } else {
        parts.push('Rechte: feingranularer Schlüssel (GitHub meldet die Rechte nicht mit — geprüft wird beim Sichern).');
      }
      return {
        ok: true,
        message: parts.join('\n'),
        login: konto.login,
        scopes: konto.scopes,
      };
    } catch (error) {
      return { ok: false, message: `GitHub: ${(error as Error).message}` };
    }
  }

  /** Letzter Commit auf dem Sicherungsbranch (null, wenn der Branch fehlt). */
  async remoteHead(): Promise<string | null> {
    this.validate();
    const settings = this.settings();
    return this.client.branchHead(settings.owner, settings.repo, settings.branch);
  }

  /** Eigene Repositories auflisten (für die Auswahl in den Einstellungen). */
  async repos(): Promise<GithubRepoEntry[]> {
    try {
      return await this.client.listRepos();
    } catch (error) {
      throw new Error(`Repository-Liste konnte nicht geladen werden: ${(error as Error).message}`);
    }
  }

  /** Neues Repository anlegen. */
  async createRepo(options: { name: string; isPrivate?: boolean }): Promise<GithubRepoEntry> {
    try {
      return await this.client.createRepo(options);
    } catch (error) {
      throw new Error(`${(error as Error).message}`);
    }
  }

  /** Ermitteln, was ein Backup tun würde (ohne etwas zu ändern). */
  async planBackup(): Promise<BackupPlan> {
    this.validate();
    const settings = this.settings();
    const files = await this.fs.list({ onlyMarkdown: settings.onlyMarkdown, exclude: settings.exclude ?? [] });
    const head = await this.client.branchHead(settings.owner, settings.repo, settings.branch);
    const remote = new Map<string, string>();
    if (head) {
      const treeSha = await this.client.commitTree(settings.owner, settings.repo, head);
      for (const entry of await this.client.remoteTree(settings.owner, settings.repo, treeSha)) {
        remote.set(entry.path, entry.sha);
      }
    }

    const added: string[] = [];
    const changed: string[] = [];
    let unchanged = 0;
    let bytes = 0;
    const seen = new Set<string>();

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) continue;
      const path = this.remotePath(file.path);
      seen.add(path);
      let content: Uint8Array;
      try {
        content = await this.fs.readBinary(file.path);
      } catch {
        continue;
      }
      const sha = await gitBlobSha(content);
      const remoteSha = remote.get(path);
      if (!remoteSha) {
        added.push(file.path);
        bytes += content.length;
      } else if (remoteSha !== sha) {
        changed.push(file.path);
        bytes += content.length;
      } else {
        unchanged++;
      }
    }

    const prefix = (settings.pathPrefix ?? '').trim().replace(/^\/+|\/+$/g, '');
    const deleted: string[] = [];
    for (const remotePath of remote.keys()) {
      if (prefix && !remotePath.startsWith(`${prefix}/`)) continue;
      if (!prefix && remotePath.startsWith('.github/')) continue;
      const local = this.localPath(remotePath);
      if (local === null) continue;
      if (!seen.has(remotePath)) deleted.push(local);
    }

    return { total: files.length, added, changed, unchanged, deleted, bytes };
  }

  /**
   * Dateien nach GitHub sichern (ein Commit).
   *
   * Meldet GitHub "non-fast-forward" (HTTP 422), hat ein anderer Rechner inzwischen
   * etwas hochgeladen. Dann wird der Stand einmal neu geholt und erneut gesichert,
   * statt mit einer kryptischen Meldung abzubrechen.
   */
  async backup(options: { message?: string; applyDeletions?: boolean } = {}): Promise<SyncOutcome> {
    try {
      return await this.runBackup(options);
    } catch (error) {
      if (isNonFastForward(error)) {
        try {
          const wiederholt = await this.runBackup(options);
          return {
            ...wiederholt,
            detail: `${wiederholt.detail ?? ''} · nach fremder Änderung automatisch erneut versucht`.trim(),
          };
        } catch (zweiterFehler) {
          if (isNonFastForward(zweiterFehler)) {
            throw new Error(
              'Das Repository hat sich während der Sicherung erneut geändert (z. B. durch einen zweiten Rechner). ' +
                'Bitte zuvor "Wiederherstellen" ausführen oder den Sicherungsbranch wechseln.',
            );
          }
          throw zweiterFehler;
        }
      }
      throw error;
    }
  }

  private async runBackup(options: { message?: string; applyDeletions?: boolean }): Promise<SyncOutcome> {
    this.validate();
    const settings = this.settings();
    const started = Date.now();
    const files = await this.fs.list({ onlyMarkdown: settings.onlyMarkdown, exclude: settings.exclude ?? [] });
    const head = await this.client.branchHead(settings.owner, settings.repo, settings.branch);

    let baseTree: string | null = null;
    const remote = new Map<string, string>();
    if (head) {
      baseTree = await this.client.commitTree(settings.owner, settings.repo, head);
      for (const entry of await this.client.remoteTree(settings.owner, settings.repo, baseTree)) {
        remote.set(entry.path, entry.sha);
      }
    }

    const treeEntries: Array<{ path: string; sha: string | null }> = [];
    let uploaded = 0;
    let skipped = 0;
    let bytes = 0;
    const seen = new Set<string>();

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) continue;
      const path = this.remotePath(file.path);
      seen.add(path);
      let content: Uint8Array;
      try {
        content = await this.fs.readBinary(file.path);
      } catch {
        continue;
      }
      const sha = await gitBlobSha(content);
      if (remote.get(path) === sha) {
        skipped++;
        continue;
      }
      const blobSha = await this.client.createBlob(settings.owner, settings.repo, bytesToBase64(content));
      treeEntries.push({ path, sha: blobSha });
      uploaded++;
      bytes += content.length;
    }

    let deleted = 0;
    if (options.applyDeletions) {
      const prefix = (settings.pathPrefix ?? '').trim().replace(/^\/+|\/+$/g, '');
      for (const remotePath of remote.keys()) {
        if (prefix && !remotePath.startsWith(`${prefix}/`)) continue;
        const local = this.localPath(remotePath);
        if (local === null) continue;
        if (!seen.has(remotePath)) {
          treeEntries.push({ path: remotePath, sha: null });
          deleted++;
        }
      }
    }

    if (!treeEntries.length) {
      return {
        commitSha: head ?? undefined,
        message: 'Nichts zu sichern - GitHub ist bereits auf dem neuesten Stand.',
        detail: `${skipped} Datei(en) unverändert.`,
      };
    }

    const treeSha = await this.client.createTree(settings.owner, settings.repo, baseTree, treeEntries);
    const now = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    const defaultMessage = `Jarvis-Sicherung ${now} (${uploaded} Datei(en)${deleted ? `, ${deleted} gelöscht` : ''})`;
    const commitSha = await this.client.createCommit(
      settings.owner,
      settings.repo,
      options.message?.trim() || defaultMessage,
      treeSha,
      head ? [head] : [],
    );
    if (head) {
      await this.client.updateRef(settings.owner, settings.repo, settings.branch, commitSha);
    } else {
      await this.client.createRef(settings.owner, settings.repo, settings.branch, commitSha);
    }

    return {
      commitSha,
      message: `Sicherung abgeschlossen: ${uploaded} Datei(en) hochgeladen, ${skipped} unverändert${deleted ? `, ${deleted} entfernt` : ''}.`,
      detail: `${(bytes / 1024).toFixed(1)} KB übertragen in ${((Date.now() - started) / 1000).toFixed(1)} s · Commit ${commitSha.slice(0, 7)}`,
    };
  }

  /** Ermitteln, welche Dateien aus GitHub geholt werden müssten. */
  async planRestore(): Promise<RestorePlan> {
    this.validate();
    const settings = this.settings();
    const head = await this.client.branchHead(settings.owner, settings.repo, settings.branch);
    if (!head) {
      throw new Error(`Branch "${settings.branch}" existiert noch nicht - es gibt nichts zum Wiederherstellen.`);
    }
    const treeSha = await this.client.commitTree(settings.owner, settings.repo, head);
    const entries = await this.client.remoteTree(settings.owner, settings.repo, treeSha);
    const localFiles = await this.fs.list({ onlyMarkdown: false, exclude: [] });
    const localPaths = new Set(localFiles.map((file) => file.path.replace(/\\/g, '/')));

    const download: RestorePlan['download'] = [];
    const remoteOnly: string[] = [];
    let unchanged = 0;
    let bytes = 0;

    for (const entry of entries) {
      const local = this.localPath(entry.path);
      if (local === null) continue;
      if (entry.size && entry.size > MAX_FILE_BYTES) continue;
      if (settings.onlyMarkdown && !/\.(md|markdown|txt|canvas)$/i.test(local)) {
        remoteOnly.push(local);
        continue;
      }
      const exists = localPaths.has(local);
      download.push({
        path: local,
        sha: entry.sha,
        size: entry.size ?? 0,
        status: exists ? 'geändert' : 'neu',
        bytes: entry.size ?? 0,
      });
      bytes += entry.size ?? 0;
      if (exists) unchanged++;
    }

    return { download, unchanged, remoteOnly, bytes };
  }

  /** Dateien aus GitHub in den Vault schreiben. */
  async restore(
    plan: RestorePlan,
    options: { onProgress?: (done: number, total: number, path: string) => void; deleteMissing?: boolean },
  ): Promise<SyncOutcome> {
    this.validate();
    const settings = this.settings();
    let written = 0;
    let skipped = 0;
    let index = 0;
    for (const item of plan.download) {
      index++;
      options.onProgress?.(index, plan.download.length, item.path);
      const data = await this.client.readBlob(settings.owner, settings.repo, item.sha);
      let existing: Uint8Array | null = null;
      try {
        existing = await this.fs.readBinary(item.path);
      } catch {
        existing = null;
      }
      if (existing) {
        const sameSha = await gitBlobSha(existing);
        if (sameSha === item.sha) {
          skipped++;
          continue;
        }
      }
      await this.fs.writeBinary(item.path, data);
      written++;
    }

    let removed = 0;
    if (options.deleteMissing && plan.remoteOnly.length) {
      for (const path of plan.remoteOnly) {
        try {
          await this.fs.remove(path);
          removed++;
        } catch {
          // Datei nicht vorhanden
        }
      }
    }

    return {
      message: `Wiederherstellung fertig: ${written} Datei(en) geschrieben, ${skipped} waren bereits identisch${removed ? `, ${removed} entfernt` : ''}.`,
    };
  }

  /** Kleine Hilfe für das manuelle Erstellen eines Blobs (Tests). */
  static toBase64(text: string): string {
    return textToBase64(text);
  }
}
