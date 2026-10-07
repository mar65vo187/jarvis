/** Jarvis AI für Obsidian — Plugin-Einstieg. */
import { Editor, Notice, Plugin, WorkspaceLeaf, MarkdownView, normalizePath } from 'obsidian';
import type { CloudProviderId, JarvisSettings, ModelInfo } from './types';
import { Brain, PRESET_MODELS } from './brain';
import { Assistant } from './chat/assistant';
import { JARVIS_VIEW_TYPE, JarvisChatView } from './chat/view';
import { SessionStore, type ChatSession } from './chat/session';
import { VaultIndex, type IndexStats } from './rag/vault-index';
import {
  ObsidianJsonFile,
  ObsidianMemoryNoteFs,
  ObsidianVaultFileSystem,
  ObsidianVaultReader,
  OllamaEmbedder,
  PluginIndexPersist,
} from './obsidian-bridge';
import { LearningStore } from './learn/store';
import { MemoryNotes } from './learn/notes';
import { Distiller, modelNameForVersion } from './learn/distill';
import type { PendingLesson } from './chat/assistant';
import type { Lesson } from './learn/types';
import {
  DEFAULT_SETTINGS,
  JarvisSettingTab,
  ReportModal,
  mergeSettings,
  type DeepPartial,
  type KeyId,
} from './settings';
import { GithubClient } from './github/client';
import { GithubSync, type RestorePlan } from './github/sync';
import { OllamaProvider } from './providers/ollama';
import { formatBytes } from './util/format';

interface PluginData {
  settings?: unknown;
  keys?: Record<string, string>;
  sessions?: ChatSession[];
}

const CHANGE_BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

export default class JarvisPlugin extends Plugin {
  settings = structuredClone(DEFAULT_SETTINGS);
  brain!: Brain;
  index!: VaultIndex;
  assistant!: Assistant;
  sessions!: SessionStore;
  learning!: LearningStore;
  memoryNotes!: MemoryNotes;
  distiller!: Distiller;
  private keys: Record<string, string> = {};
  private githubSync!: GithubSync;
  private saveTimer: number | null = null;
  private lastChangeBackup = 0;
  private pendingChangeBackup = false;
  private distillRunning = false;

  async onload(): Promise<void> {
    const raw = (await this.loadData()) as PluginData | null;
    this.settings = mergeSettings(raw?.settings as DeepPartial<JarvisSettings> | null);
    this.keys = raw?.keys ?? {};

    this.brain = new Brain(() => this.settings, this.manifest.version);
    this.brain.setKeyReader((id) => this.getKey(id));

    const ollama = this.brain.provider('ollama') as OllamaProvider;
    const embedder = new OllamaEmbedder(ollama, () => ({
      useEmbeddings: this.settings.local.useEmbeddings,
      embedModel: this.settings.local.embedModel,
      preferred: this.settings.local.preferred,
    }));

    this.index = new VaultIndex(
      new ObsidianVaultReader(this.app),
      new PluginIndexPersist(this.app, this.manifest.id),
      this.settings.rag,
      embedder,
    );

    this.learning = new LearningStore(
      new ObsidianJsonFile(this.app, `${this.app.vault.configDir}/plugins/${this.manifest.id}/cache/learning.json`),
      () => this.settings.learning,
    );
    await this.learning.load();
    this.memoryNotes = new MemoryNotes(new ObsidianMemoryNoteFs(this.app), () => this.settings.learning);
    this.distiller = new Distiller({
      ollama: this.brain.provider('ollama') as OllamaProvider,
      learning: () => this.settings.learning,
      local: () => this.settings.local,
      lessons: () => this.learning.list(),
    });

    this.assistant = new Assistant({
      settings: () => this.settings,
      index: this.index,
      brain: this.brain,
      vaultName: () => this.app.vault.getName(),
      learning: { store: this.learning, notes: this.memoryNotes },
      persistSettings: () => this.saveSettings(),
    });

    this.sessions = new SessionStore(raw?.sessions ?? [], async (sessions) => {
      await this.persist({ sessions });
    });

    this.githubSync = new GithubSync(
      new GithubClient(() => this.getKey('github'), `JarvisAI-Obsidian/${this.manifest.version}`),
      new ObsidianVaultFileSystem(this.app, this.manifest.id),
      () => ({ ...this.settings.github, onlyMarkdown: this.settings.github.onlyMarkdown ?? true }),
    );

    this.registerView(JARVIS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new JarvisChatView(leaf, this));
    this.addSettingTab(new JarvisSettingTab(this.app, this));

    this.addRibbonIcon('sparkles', 'Jarvis KI öffnen', () => void this.activateView());

    this.registerCommands();
    this.registerGithubScheduling();
    this.registerVaultWatchers();

    // Index im Hintergrund aufbauen (blockiert den Start nicht)
    window.setTimeout(() => {
      void this.index
        .ensureFresh(false)
        .then(() => this.refreshOpenView())
        .catch(() => undefined);
    }, 2500);

    // Gelerntes Wissen als Notizen nachziehen (z. B. nach einem Update oder Sync)
    window.setTimeout(() => {
      void this.assistant
        .restoreLessonsFromNotes()
        .then((wiederhergestellt) => {
          if (wiederhergestellt > 0) {
            new Notice(
              `Jarvis: ${wiederhergestellt} gelernte Lektion(en) aus "${this.settings.learning.memoryFolder}" wiederhergestellt.`,
              8000,
            );
          }
          return this.assistant.syncMemoryNotes();
        })
        .then((result) => {
          if (result.written > 0) {
            new Notice(`Jarvis: ${result.written} gelernte Notiz(en) im Ordner "${this.settings.learning.memoryFolder}" angelegt.`, 8000);
          }
        })
        .catch(() => undefined);
    }, 5000);
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    // Lernen sofort auf Festplatte schreiben - nichts darf verloren gehen.
    void this.learning?.flush();
    void this.persist({});
  }

  // ------------------------------------------------------------ Speichern

  private async persist(patch: Partial<PluginData>): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      keys: this.keys,
      sessions: patch.sessions ?? this.sessions?.list() ?? [],
      ...patch,
    };
    if (patch.sessions) {
      data.sessions = patch.sessions;
    }
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    this.index.setOptions(this.settings.rag);
    this.brain.refresh();
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.persist({});
    }, 300);
    this.refreshOpenView();
  }

  private refreshOpenView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(JARVIS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof JarvisChatView) {
        void view.refreshModels();
      }
    }
  }

  // -------------------------------------------------------------- Schlüssel

  private secretStorage(): {
    getSecret(id: string): string | null;
    setSecret(id: string, value: string): void;
    deleteSecret?(id: string): void;
  } | null {
    const storage = (this.app as unknown as { secretStorage?: unknown }).secretStorage;
    const candidate = storage as {
      getSecret?: (id: string) => string | null;
      setSecret?: (id: string, value: string) => void;
    } | null;
    if (candidate && typeof candidate.getSecret === 'function' && typeof candidate.setSecret === 'function') {
      return candidate as never;
    }
    return null;
  }

  getKey(id: KeyId): string {
    const storage = this.secretStorage();
    const secretId = `jarvis-ai-${id}`;
    if (storage) {
      try {
        const value = storage.getSecret(secretId);
        if (value) return value;
      } catch {
        // weiter mit dem lokalen Speicher
      }
    }
    return this.keys[secretId] ?? '';
  }

  async setKey(id: KeyId, value: string): Promise<void> {
    const secretId = `jarvis-ai-${id}`;
    const storage = this.secretStorage();
    if (storage) {
      try {
        if (value) storage.setSecret(secretId, value);
        else storage.deleteSecret?.(secretId);
        delete this.keys[secretId];
        await this.persist({});
        this.brain.refresh();
        return;
      } catch {
        // Rückfall auf den lokalen Speicher
      }
    }
    if (value) this.keys[secretId] = value;
    else delete this.keys[secretId];
    await this.persist({});
    this.brain.refresh();
  }

  keyStorageDescription(): string {
    return this.secretStorage()
      ? 'im Schlüsseltresor von Obsidian gespeichert (Einstellungen → Schlüsseltresor)'
      : 'in der Plugin-Datei data.json gespeichert (nicht verschlüsselt — Obsidian ab Version 1.11 bietet einen verschlüsselten Tresor)';
  }

  // ---------------------------------------------------------------- Modelle

  async listAllModels(): Promise<ModelInfo[]> {
    const result: ModelInfo[] = [];
    // Lokal
    try {
      const local = await this.brain.models('ollama');
      result.push(...local);
      this.settings.local.preferred = local.map((model) => model.id);
    } catch {
      result.push(...PRESET_MODELS.ollama.map((model) => ({ ...model, note: `${model.note} (nicht installiert?)` })));
    }
    // Cloud
    for (const id of Object.keys(this.settings.cloud) as CloudProviderId[]) {
      const cloud = this.settings.cloud[id];
      const hasKey = Boolean(this.getKey(id).trim());
      if (!cloud.enabled && !hasKey) {
        continue;
      }
      const presets = PRESET_MODELS[id] ?? [];
      if (hasKey && cloud.enabled) {
        try {
          const live = await this.brain.models(id);
          if (live.length) {
            const liveIds = new Set(live.map((model) => model.id));
            result.push(...presets.filter((preset) => liveIds.has(preset.id)));
            result.push(...live.filter((model) => !presets.some((preset) => preset.id === model.id)));
            continue;
          }
        } catch {
          // Rückfall auf Vorschläge
        }
      }
      result.push(...presets);
      for (const modelId of cloud.models ?? []) {
        if (!presets.some((preset) => preset.id === modelId)) {
          result.push({ id: modelId, label: modelId, providerId: id, local: false, note: 'gemerkt' });
        }
      }
    }
    return result;
  }

  async loadModels(id: CloudProviderId | 'ollama'): Promise<ModelInfo[]> {
    const models = await this.brain.models(id, true);
    if (id === 'ollama') {
      this.settings.local.preferred = models.map((model) => model.id);
      if (!this.settings.local.defaultModel && models.length) {
        const best = await this.brain.pickLocalModel(models);
        if (best) this.settings.local.defaultModel = best;
      }
    } else {
      this.settings.cloud[id].models = models.map((model) => model.id);
    }
    await this.saveSettings();
    this.refreshOpenView();
    return models;
  }

  // -------------------------------------------------------------- Vault/AI

  indexStats(): { files: number; chunks: number; embedded: number; embeddingModel: string | null } {
    const stats = this.index.stats();
    return {
      files: stats.files,
      chunks: stats.chunks,
      embedded: stats.embedded,
      embeddingModel: stats.embeddingModel,
    };
  }

  async refreshIndex(force: boolean): Promise<IndexStats> {
    const stats = await this.index.ensureFresh(force);
    this.refreshOpenView();
    return stats;
  }

  async resetIndex(): Promise<void> {
    await this.index.clear();
  }

  activeNotePath(): string | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path;
  }

  notify(message: string, timeout = 6000): void {
    new Notice(message, timeout);
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
    } else {
      new Notice('Einstellungen konnten nicht geöffnet werden. Bitte manuell: Einstellungen → Jarvis KI.');
    }
  }

  async insertText(text: string, mode: 'cursor' | 'replaceSelection' | 'newNote'): Promise<void> {
    if (mode === 'newNote') {
      await this.createNoteFromText(text);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!editor) {
      await this.createNoteFromText(text);
      return;
    }
    if (mode === 'replaceSelection' && editor.getSelection().length) {
      editor.replaceSelection(text);
    } else {
      const cursor = editor.getCursor();
      editor.replaceRange(`${text}\n`, cursor);
    }
    new Notice('In die Notiz eingefügt.');
  }

  private async createNoteFromText(text: string): Promise<void> {
    const folder = this.settings.ui.outputFolder?.trim() || 'Jarvis-Ausgaben';
    const firstLine = text.split('\n').find((line) => line.trim().length) ?? 'Jarvis';
    const title = firstLine.replace(/[#*_`>]/g, '').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 70) || 'Jarvis-Antwort';
    const stamp = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }).replace(/[.:,]/g, '-');
    const path = normalizePath(`${folder}/${title} (${stamp}).md`);
    try {
      if (!(await this.app.vault.adapter.exists(normalizePath(folder)))) {
        await this.app.vault.createFolder(normalizePath(folder));
      }
      const file = await this.app.vault.create(path, `${text}\n`);
      await this.app.workspace.getLeaf(false).openFile(file);
      new Notice(`Neue Notiz erstellt: ${file.path}`);
    } catch (error) {
      new Notice(`Notiz konnte nicht erstellt werden: ${(error as Error).message}`, 10000);
    }
  }

  private insertIntoEditor(editor: Editor, text: string, replaceSelection: boolean): void {
    if (replaceSelection && editor.getSelection().length) editor.replaceSelection(text);
    else editor.replaceRange(text, editor.getCursor());
  }

  // -------------------------------------------------------------- Befehle

  private registerCommands(): void {
    this.addCommand({
      id: 'open-chat',
      name: 'Chat öffnen',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'ask-selection',
      name: 'Markierten Text erklären/verbessern (Auswahl in Chat)',
      editorCallback: async (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice('Bitte zuerst Text markieren.');
          return;
        }
        const view = await this.activateView();
        await view?.askExternal(`Erkläre und verbessere diesen Text:\n\n${selection}`, 'rewrite');
      },
    });

    this.addCommand({
      id: 'summarize-note-local',
      name: 'Diese Notiz zusammenfassen (lokal)',
      editorCallback: async (_editor, view) => {
        const file = view.file;
        if (!file) return;
        const chat = await this.activateView();
        await chat?.askExternal(`Fasse die Notiz "${file.path}" zusammen und nenne die offenen Punkte.`, 'summarize', 'local');
      },
    });

    this.addCommand({
      id: 'summarize-note-cloud',
      name: 'Diese Notiz zusammenfassen (bestes Cloud-Modell)',
      editorCallback: async (_editor, view) => {
        const file = view.file;
        if (!file) return;
        const chat = await this.activateView();
        await chat?.askExternal(`Fasse die Notiz "${file.path}" zusammen und nenne die offenen Punkte.`, 'summarize', 'cloud');
      },
    });

    this.addCommand({
      id: 'tasks-from-note',
      name: 'Aufgaben aus dieser Notiz ableiten',
      editorCallback: async (_editor, view) => {
        const file = view.file;
        if (!file) return;
        const chat = await this.activateView();
        await chat?.askExternal(
          `Leite aus der Notiz "${file.path}" eine Aufgabenliste ab. Nur Aufgaben, die wirklich im Text stehen.`,
          'tasks',
        );
      },
    });

    this.addCommand({
      id: 'ask-vault',
      name: 'Frage an meinen Vault stellen',
      callback: async () => {
        const chat = await this.activateView();
        chat?.setInput('');
      },
    });

    this.addCommand({
      id: 'improve-selection-cloud',
      name: 'Auswahl mit Cloud-Modell überarbeiten und ersetzen',
      editorCallback: async (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice('Bitte zuerst Text markieren.');
          return;
        }
        const notice = new Notice('Jarvis überarbeitet den Text …', 0);
        try {
          const result = await this.assistant.ask({
            question: `Überarbeite diesen Text: Rechtschreibung, Klarheit, gleiche Bedeutung, gleicher Ton.\n\n${selection}`,
            mode: 'rewrite',
            route: 'cloud',
            history: [],
          });
          this.insertIntoEditor(editor, result.answer.text.trim(), true);
          notice.hide();
          new Notice(`Text ersetzt (${result.answer.providerId}/${result.answer.model}).`);
        } catch (error) {
          notice.hide();
          new Notice(`Fehlgeschlagen: ${(error as Error).message}`, 12000);
        }
      },
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Wissensindex neu aufbauen',
      callback: async () => {
        const notice = new Notice('Jarvis: Index wird aufgebaut …', 0);
        const stats = await this.refreshIndex(true);
        notice.hide();
        new Notice(
          `Index fertig: ${stats.files} Notizen, ${stats.chunks} Abschnitte, ${formatBytes(stats.bytes)} Text.`,
          8000,
        );
      },
    });

    this.addCommand({
      id: 'unload-local-model',
      name: 'Lokales Modell aus dem Speicher entladen',
      callback: async () => {
        const model = this.settings.local.defaultModel;
        if (!model) {
          new Notice('Kein lokales Modell eingestellt.');
          return;
        }
        try {
          await (this.brain.provider('ollama') as OllamaProvider).unload(model);
          new Notice(`Modell "${model}" entladen — Speicher freigegeben.`);
        } catch (error) {
          new Notice(`Entladen fehlgeschlagen: ${(error as Error).message}`, 10000);
        }
      },
    });

    this.addCommand({
      id: 'github-backup',
      name: 'GitHub: Vault jetzt sichern',
      callback: async () => {
        await this.githubBackup();
      },
    });

    this.addCommand({
      id: 'github-restore',
      name: 'GitHub: Vault wiederherstellen (Vorschau)',
      callback: async () => {
        await this.githubRestore();
      },
    });

    this.addCommand({
      id: 'learning-report',
      name: 'Lernen: Was hat Jarvis gelernt?',
      callback: () => {
        new ReportModal(this.app, 'Jarvis: was gelernt wurde', this.learningReport()).open();
      },
    });

    this.addCommand({
      id: 'learning-distill',
      name: 'Lernen: Lokales Modell aus Gelerntem verbessern',
      callback: async () => {
        try {
          await this.distillNow();
        } catch (error) {
          new Notice(`Verbessern nicht möglich: ${(error as Error).message}`, 15000);
        }
      },
    });

    this.addCommand({
      id: 'learning-sync-notes',
      name: 'Lernen: Gelerntes als Notizen im Vault ablegen',
      callback: async () => {
        const result = await this.assistant.syncMemoryNotes();
        new Notice(`Gelernte Notizen: ${result.written} neu angelegt, ${result.existing} bereits vorhanden.`, 10000);
      },
    });

    this.addCommand({
      id: 'learning-restore',
      name: 'Lernen: Gelerntes aus den Notizen wiederherstellen',
      callback: async () => {
        const anzahl = await this.assistant.restoreLessonsFromNotes();
        new Notice(
          anzahl > 0
            ? `Jarvis: ${anzahl} Lektion(en) aus den Notizen wiederhergestellt.`
            : 'Jarvis: keine neuen Lektionen in den Notizen gefunden (oder das Lernen ist abgeschaltet).',
          10000,
        );
      },
    });

    this.addCommand({
      id: 'learning-wipe',
      name: 'Lernen: Gelerntes Wissen löschen',
      callback: async () => {
        await this.wipeLearning();
      },
    });

    this.addCommand({
      id: 'test-connections',
      name: 'Verbindungen testen (Ollama + Cloud + GitHub)',
      callback: async () => {
        const notice = new Notice('Jarvis prüft alle Verbindungen …', 0);
        const lines = await this.testEverything();
        notice.hide();
        new ReportModal(this.app, 'Jarvis-Diagnose', lines).open();
      },
    });
  }

  // ------------------------------------------------------------- Oberfläche

  async activateView(): Promise<JarvisChatView | null> {
    const existing = this.app.workspace.getLeavesOfType(JARVIS_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: JARVIS_VIEW_TYPE, active: true });
    }
    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof JarvisChatView) {
        await view.refreshModels();
        return view;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- GitHub

  async githubTest(): Promise<string> {
    const result = await this.githubSync.test();
    return result.message;
  }

  private githubReady(): boolean {
    const github = this.settings.github;
    if (!github.enabled) {
      new Notice('GitHub-Sicherung ist in den Einstellungen ausgeschaltet.');
      return false;
    }
    if (!github.owner || !github.repo) {
      new Notice('Bitte GitHub-Benutzer und Repository in den Einstellungen eintragen.');
      return false;
    }
    if (!this.getKey('github').trim()) {
      new Notice('Bitte einen GitHub-Token in den Einstellungen hinterlegen (Berechtigung "Contents: Read and write").');
      return false;
    }
    return true;
  }

  async githubBackup(): Promise<void> {
    if (!this.githubReady()) return;
    const notice = new Notice('Jarvis vergleicht den Vault mit GitHub …', 0);
    try {
      const plan = await this.githubSync.planBackup();
      notice.hide();
      if (!plan.added.length && !plan.changed.length && !plan.deleted.length) {
        new Notice(`Alles aktuell: ${plan.unchanged} Datei(en) unverändert.`);
        this.settings.github.lastBackupIso = new Date().toISOString();
        await this.saveSettings();
        return;
      }
      const lines = [
        `Repository: ${this.settings.github.owner}/${this.settings.github.repo} (Branch ${this.settings.github.branch})`,
        this.settings.github.pathPrefix ? `Unterordner: ${this.settings.github.pathPrefix}/` : 'Unterordner: (Wurzel)',
        '',
        `Neu:      ${plan.added.length}`,
        `Geändert: ${plan.changed.length}`,
        `Gelöscht: ${plan.deleted.length}`,
        `Unverändert: ${plan.unchanged}`,
        `Zu übertragen: ${formatBytes(plan.bytes)}`,
        '',
        'Dateien (max. 60):',
        ...[...plan.added.map((path) => `+ ${path}`), ...plan.changed.map((path) => `~ ${path}`), ...plan.deleted.map((path) => `- ${path}`)].slice(0, 60),
      ];
      new ReportModal(
        this.app,
        'Vault nach GitHub sichern?',
        lines,
        async () => {
          const progress = new Notice('Jarvis lädt hoch …', 0);
          try {
            const outcome = await this.githubSync.backup({
              applyDeletions: this.settings.github.mirrorDelete,
            });
            progress.hide();
            this.settings.github.lastBackupAt = new Date().toLocaleString('de-DE');
            this.settings.github.lastBackupIso = new Date().toISOString();
            this.settings.github.lastCommitSha = outcome.commitSha ?? '';
            await this.saveSettings();
            new Notice(`${outcome.message}\n${outcome.detail ?? ''}`, 10000);
          } catch (error) {
            progress.hide();
            new Notice(`Sicherung fehlgeschlagen: ${(error as Error).message}`, 15000);
          }
        },
        'Jetzt sichern',
      ).open();
    } catch (error) {
      notice.hide();
      new Notice(`GitHub-Vergleich fehlgeschlagen: ${(error as Error).message}`, 12000);
    }
  }

  async githubRestore(): Promise<void> {
    if (!this.githubReady()) return;
    const notice = new Notice('Jarvis liest die Dateiliste von GitHub …', 0);
    try {
      const plan: RestorePlan = await this.githubSync.planRestore();
      notice.hide();
      const lines = [
        `Repository: ${this.settings.github.owner}/${this.settings.github.repo} (Branch ${this.settings.github.branch})`,
        '',
        `Dateien im Repository: ${plan.download.length}`,
        `Zu laden: ${formatBytes(plan.bytes)}`,
        plan.remoteOnly.length ? `Nicht geladene Typen (z. B. Anhänge): ${plan.remoteOnly.length}` : '',
        '',
        'Alle Dateien werden überschrieben, wenn sie sich unterscheiden.',
        this.settings.github.mirrorDelete
          ? 'Achtung: lokale Dateien, die in GitHub fehlen, werden gelöscht (Einstellung aktiv).'
          : 'Lokale Dateien, die in GitHub fehlen, bleiben unangetastet.',
        '',
        'Dateien (max. 60):',
        ...plan.download.slice(0, 60).map((item) => `${item.status === 'neu' ? '+' : '~'} ${item.path}`),
      ];
      new ReportModal(
        this.app,
        'Vault aus GitHub wiederherstellen?',
        lines.filter(Boolean),
        async () => {
          const progress = new Notice('Jarvis stellt wieder her …', 0);
          try {
            const outcome = await this.githubSync.restore(plan, {
              deleteMissing: this.settings.github.mirrorDelete,
              onProgress: (done, total, path) => {
                new Notice(`Wiederherstellen ${done}/${total}: ${path}`, 1500);
              },
            });
            progress.hide();
            new Notice(outcome.message, 12000);
          } catch (error) {
            progress.hide();
            new Notice(`Wiederherstellen fehlgeschlagen: ${(error as Error).message}`, 15000);
          }
        },
        'Jetzt wiederherstellen',
      ).open();
    } catch (error) {
      notice.hide();
      new Notice(`GitHub-Wiederherstellung fehlgeschlagen: ${(error as Error).message}`, 12000);
    }
  }

  private registerGithubScheduling(): void {
    this.registerInterval(
      window.setInterval(() => {
        void this.tickGithub();
      }, 60_000),
    );
  }

  private async tickGithub(): Promise<void> {
    void this.tickLearning();
    const github = this.settings.github;
    if (!github.enabled || !github.owner || !github.repo || !this.getKey('github')) return;

    const now = Date.now();
    if (github.autoBackupMinutes > 0) {
      const parsed = github.lastBackupIso ? Date.parse(github.lastBackupIso) : Number.NaN;
      const last = Number.isFinite(parsed) ? parsed : 0;
      if (!last || now - last >= github.autoBackupMinutes * 60_000) {
        await this.runSilentBackup('Zeitplan');
        return;
      }
    }
    if (github.backupOnChange && this.pendingChangeBackup && now - this.lastChangeBackup >= CHANGE_BACKUP_MIN_INTERVAL_MS) {
      this.pendingChangeBackup = false;
      await this.runSilentBackup('Änderung');
    }
  }

  private async runSilentBackup(reason: string): Promise<void> {
    try {
      const outcome = await this.githubSync.backup({ applyDeletions: this.settings.github.mirrorDelete });
      this.lastChangeBackup = Date.now();
      if (outcome.commitSha) {
        this.settings.github.lastBackupAt = new Date().toLocaleString('de-DE');
        this.settings.github.lastBackupIso = new Date().toISOString();
        this.settings.github.lastCommitSha = outcome.commitSha;
        await this.saveSettings();
        new Notice(`GitHub-Sicherung (${reason}): ${outcome.message}`, 6000);
      }
    } catch (error) {
      new Notice(`GitHub-Sicherung (${reason}) fehlgeschlagen: ${(error as Error).message}`, 12000);
    }
  }

  /** Automatisches Destillieren, wenn genug Neues gelernt wurde. */
  private async tickLearning(): Promise<void> {
    const learning = this.settings.learning;
    if (!learning.enabled || learning.autoDistillAfter <= 0) return;
    if (this.distillRunning) return;
    if (this.learning.pendingForDistill() < learning.autoDistillAfter) return;
    this.distillRunning = true;
    try {
      await this.runDistill({ silent: true });
    } catch (error) {
      new Notice(`Automatisches Verbessern fehlgeschlagen: ${(error as Error).message}`, 12000);
    } finally {
      this.distillRunning = false;
    }
  }

  private registerVaultWatchers(): void {
    let debounce: number | null = null;
    const markDirty = () => {
      if (!this.settings.github.enabled || !this.settings.github.backupOnChange) return;
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        this.pendingChangeBackup = true;
        if (Date.now() - this.lastChangeBackup >= CHANGE_BACKUP_MIN_INTERVAL_MS) {
          this.pendingChangeBackup = false;
          void this.runSilentBackup('Änderung');
        }
      }, 20_000);
    };
    this.registerEvent(this.app.vault.on('modify', markDirty));
    this.registerEvent(this.app.vault.on('create', markDirty));
    this.registerEvent(this.app.vault.on('delete', markDirty));
    this.registerEvent(this.app.vault.on('rename', markDirty));
  }

  // ---------------------------------------------------------------- Lernen

  /** Schnittstelle für die Chat-Ansicht. */
  learningStats(): { lessons: number; corrections: number; avgLocalQuality: number; avgCloudQuality: number; improvement: number; pending: number } {
    return this.learningSnapshot();
  }

  async saveLesson(payload: PendingLesson): Promise<void> {
    await this.learningSaveLesson(payload);
  }

  async rateLesson(id: string, rating: Lesson['rating']): Promise<void> {
    await this.learningRate(id, rating);
  }

  async correctLesson(id: string, correction: string): Promise<void> {
    await this.learningCorrect(id, correction);
  }

  async distill(): Promise<string> {
    return this.distillNow();
  }

  showLearningReport(): void {
    new ReportModal(this.app, 'Jarvis: was gelernt wurde', this.learningReport()).open();
  }

  learningSnapshot(): { lessons: number; corrections: number; avgLocalQuality: number; avgCloudQuality: number; improvement: number; pending: number } {
    const snapshot = this.learning.snapshot();
    return {
      lessons: snapshot.lessons,
      corrections: snapshot.corrections,
      avgLocalQuality: snapshot.avgLocalQuality,
      avgCloudQuality: snapshot.avgCloudQuality,
      improvement: snapshot.improvement,
      pending: this.learning.pendingForDistill(),
    };
  }

  /** Bericht: was wurde gelernt, wie gut ist die lokale KI, was hat sie verbessert. */
  learningReport(): string[] {
    const snapshot = this.learning.snapshot();
    const learning = this.settings.learning;
    const lines: string[] = [];
    lines.push('— Stand —');
    lines.push(`Lektionen: ${snapshot.lessons} (davon ${snapshot.corrections} mit deiner Korrektur, ${snapshot.good} als gut, ${snapshot.bad} als schlecht bewertet)`);
    lines.push(`Neue Lektionen seit dem letzten Verbessern: ${this.learning.pendingForDistill()}`);
    lines.push(`Qualität im Schnitt (Quellenabdeckung): lokal ${Math.round(snapshot.avgLocalQuality * 100)} %` + (snapshot.avgCloudQuality ? `, Cloud ${Math.round(snapshot.avgCloudQuality * 100)} %` : ''));
    if (snapshot.improvement) {
      lines.push(`Veränderung seit dem letzten Verbessern: ${snapshot.improvement > 0 ? '+' : ''}${Math.round(snapshot.improvement * 100)} %`);
    }
    lines.push(`Lernmodelle erstellt: ${snapshot.distills}`);
    if (learning.distillVersion) {
      lines.push(`Aktuelles Lernmodell: ${learning.lastDistillModel || modelNameForVersion(learning.distillVersion)}${learning.lastDistillAt ? ` (${learning.lastDistillAt})` : ''}`);
    }
    lines.push('');
    lines.push('— Qualitätsverlauf (neueste unten) —');
    lines.push(...this.learning.historyText(24));
    if (snapshot.modelStats.length) {
      lines.push('');
      lines.push('— Modelle —');
      for (const stat of snapshot.modelStats.slice(0, 12)) {
        lines.push(
          `${stat.model}: ${stat.calls} Aufruf(e), ${stat.failures} Fehler, ${stat.avgMs} ms im Schnitt` +
            (stat.avgQuality ? `, Qualität ${Math.round(stat.avgQuality * 100)} %` : ''),
        );
      }
    }
    lines.push('');
    lines.push('— Wie das Lernen funktioniert —');
    lines.push('Gelernt werden fertige Antworten starker Modelle und deine Korrekturen - als Kontext und Regeln,');
    lines.push('nicht als trainierte Modellgewichte. Deshalb ist alles nachvollziehbar, änderbar und löschbar.');
    return lines;
  }

  async wipeLearning(): Promise<void> {
    await this.learning.wipe();
    new Notice('Gelerntes Wissen wurde gelöscht. Bereits erstellte Notizen bleiben im Ordner erhalten.', 10000);
    this.refreshOpenView();
  }

  /** Lektion speichern (wenn „nachfragen" eingestellt ist) und Notiz anlegen. */
  async learningSaveLesson(payload: PendingLesson): Promise<void> {
    const result = await this.assistant.saveLesson(payload);
    if (result.saved) {
      await this.saveSettings();
      new Notice(
        result.notePath
          ? `Gemerkt. Notiz erstellt: ${result.notePath}`
          : `Gemerkt (${this.learning.count()} Lektionen).`,
        8000,
      );
    }
    this.refreshOpenView();
  }

  async learningRate(id: string, rating: Lesson['rating']): Promise<void> {
    await this.assistant.rateLesson(id, rating);
    new Notice(rating === 'good' ? 'Als hilfreich bewertet — wird beim Verbessern bevorzugt.' : 'Als schlecht bewertet — wird nicht mehr verwendet.');
    this.refreshOpenView();
  }

  async learningCorrect(id: string, correction: string): Promise<void> {
    await this.assistant.correctLesson(id, correction);
    await this.saveSettings();
    new Notice('Korrektur gespeichert. Sie gilt ab jetzt als verbindlich und fließt ins lokale Modell ein.', 10000);
    this.refreshOpenView();
  }

  /** Destillieren: aus dem Gelernten ein lokales Ollama-Modell erstellen. */
  async distillNow(): Promise<string> {
    return this.runDistill({ silent: false });
  }

  private async runDistill(options: { silent: boolean }): Promise<string> {
    const plan = this.distiller.plan();
    const problem = this.distiller.validate(plan);
    if (problem) throw new Error(problem);

    if (options.silent) {
      return this.applyDistill(plan);
    }

    const lines = [
      `Basismodell: ${plan.base}`,
      `Neues Profil: ${plan.model}`,
      `Beispiele aus dem Gelernten: ${plan.examples.length}`,
      `Regeln aus Korrekturen: ${plan.rules.length}`,
      `Größe des Modellprofils: ${(plan.bytes / 1024).toFixed(1)} KB`,
      '',
      plan.examples.length ? 'Diese Fragen werden eingebaut (gekürzt):' : 'Keine Beispiele.',
      ...plan.examples.slice(0, 12).map((lesson) => `+ ${lesson.question.replace(/\s+/g, ' ').slice(0, 70)}`),
      plan.skipped.length ? '' : '',
      plan.skipped.length ? 'Nicht übernommen:' : '',
      ...plan.skipped.slice(0, 6).map((entry) => `- ${entry}`),
      '',
      'Wichtig: Es werden keine Modellgewichte trainiert und nichts heruntergeladen.',
      'Ollama legt aus deinem Basismodell ein neues Profil mit diesen Beispielen an.',
      'Das Basismodell bleibt erhalten; du kannst jederzeit zurückwechseln.',
    ].filter(Boolean);

    return new Promise<string>((resolve, reject) => {
      new ReportModal(
        this.app,
        'Lokales Modell aus Gelerntem verbessern?',
        lines,
        async () => {
          try {
            resolve(await this.applyDistill(plan));
          } catch (error) {
            reject(error);
          }
        },
        'Jetzt verbessern',
      ).open();
    });
  }

  private async applyDistill(plan: ReturnType<Distiller['plan']>): Promise<string> {
    const notice = new Notice(`Jarvis baut ${plan.model} aus ${plan.examples.length} Beispiel(en) …`, 0);
    try {
      const result = await this.distiller.run(plan);
      // Einstellungen aktualisieren: neues Profil wird das lokale Standardmodell.
      this.settings.local.defaultModel = result.model;
      this.settings.learning.distillVersion = plan.version;
      this.settings.learning.distillBase = plan.base;
      this.settings.learning.lastDistillAt = new Date().toLocaleString('de-DE');
      this.settings.learning.lastDistillModel = result.model;
      await this.learning.recordDistill();
      await this.saveSettings();
      this.brain.invalidateModelCache('ollama');
      const removed = await this.distiller.cleanup(plan.version).catch(() => []);
      notice.hide();
      new Notice(
        `${result.message}\nStandardmodell ist jetzt ${result.model}.` +
          (removed.length ? `\nAlte Profile entfernt: ${removed.join(', ')}` : ''),
        18000,
      );
      this.refreshOpenView();
      return result.message;
    } catch (error) {
      notice.hide();
      throw error;
    }
  }

  // -------------------------------------------------------------- Diagnose

  async testEverything(): Promise<string[]> {
    const lines: string[] = [];
    lines.push('— Ollama —');
    const ollama = this.brain.provider('ollama') as OllamaProvider;
    const ollamaTest = await ollama.test();
    lines.push(`${ollamaTest.ok ? '✅' : '❌'} ${ollamaTest.message}`);
    if (ollamaTest.ok) {
      const model = this.settings.local.defaultModel;
      const models = this.settings.local.preferred;
      if (model && !models.includes(model)) {
        lines.push(`⚠️ Eingestelltes Modell "${model}" ist nicht installiert. Vorschlag: ${models.slice(0, 3).join(', ') || 'keines'}`);
      }
      if (this.settings.local.useEmbeddings) {
        const embed = await ollama.findEmbedModel([this.settings.local.embedModel, 'nomic-embed-text', 'qwen3-embedding', 'embeddinggemma']);
        lines.push(embed ? `✅ Embedding-Modell: ${embed}` : `⚠️ Kein Embedding-Modell gefunden (ollama pull nomic-embed-text). Suche läuft dann über Stichworte.`);
      }
    }

    lines.push('', '— Cloud —');
    let anyCloud = false;
    for (const id of Object.keys(this.settings.cloud) as CloudProviderId[]) {
      const cloud = this.settings.cloud[id];
      if (!cloud.enabled) {
        lines.push(`➖ ${cloud.label}: nicht aktiviert`);
        continue;
      }
      anyCloud = true;
      const test = await this.brain.provider(id).test();
      lines.push(`${test.ok ? '✅' : '❌'} ${test.message}`);
    }
    if (!anyCloud) lines.push('➖ Kein Cloud-Anbieter aktiv — Jarvis arbeitet rein lokal.');

    lines.push('', '— GitHub —');
    if (!this.settings.github.enabled) lines.push('➖ Sicherung nicht aktiviert');
    else lines.push(await this.githubTest());

    lines.push('', '— Wissen —');
    let stats = this.index.stats();
    if (!stats.files) {
      try {
        stats = await this.refreshIndex(false);
      } catch {
        // egal
      }
    }
    lines.push(
      `📚 ${stats.files} Notizen, ${stats.chunks} Abschnitte, ${stats.embedded} Vektoren, ${formatBytes(stats.bytes)} Text` +
        `${stats.embeddingModel ? ` (Modell ${stats.embeddingModel})` : ' (ohne Embeddings)'}`,
    );
    lines.push('', '— Einstellungen —');
    lines.push(`Modus: ${this.settings.routeMode} · Automatisches Ausweichen: ${this.settings.autoEscalate ? 'an' : 'aus'}`);
    lines.push(`Schlüsselspeicher: ${this.keyStorageDescription()}`);
    lines.push(`Plugin-Version: ${this.manifest.version} · Obsidian: ${(this.app as unknown as { getVersion?(): string }).getVersion?.() ?? 'unbekannt'}`);
    return lines;
  }
}
