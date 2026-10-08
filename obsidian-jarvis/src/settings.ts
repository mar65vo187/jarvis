/** Einstellungen: Standardwerte und die Oberfläche im Einstellungsfenster. */
import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { CloudProviderId, JarvisSettings, ModelInfo } from './types';
import type { Brain } from './brain';
import { CLOUD_ORDER_LABELS } from './brain';
import { verbindungsText } from './github/connect';

export const DEFAULT_SETTINGS: JarvisSettings = {
  routeMode: 'auto',
  autoEscalate: true,
  autoOrder: ['anthropic', 'openai', 'gemini', 'openrouter', 'huggingface', 'n8n', 'custom'],
  local: {
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: '',
    embedModel: 'nomic-embed-text',
    useEmbeddings: true,
    numCtx: 8192,
    temperature: 0.4,
    keepAlive: '10m',
    preferred: [],
  },
  cloud: {
    anthropic: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'anthropic',
      label: 'Claude (Anthropic)',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-5-5',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    openai: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'openai',
      label: 'GPT (OpenAI)',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6-astra',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    gemini: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'gemini',
      label: 'Gemini (Google)',
      baseUrl: 'https://generativelanguage.googleapis.com',
      defaultModel: 'gemini-3.8-flash',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    openrouter: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'openai',
      label: 'OpenRouter (alle Modelle)',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-opus-5-5',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    huggingface: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'openai',
      label: 'Hugging Face (Router)',
      baseUrl: 'https://router.huggingface.co/v1',
      defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    n8n: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'openai',
      label: 'n8n (eigener Arbeitsablauf)',
      baseUrl: 'http://127.0.0.1:5678/webhook/jarvis',
      defaultModel: 'jarvis',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
    custom: {
      enabled: false,
      thinkingLevel: 'off',
      kind: 'openai',
      label: 'Eigener Dienst (OpenAI-kompatibel)',
      baseUrl: 'http://127.0.0.1:1234/v1',
      defaultModel: '',
      models: [],
      temperature: -1,
      maxTokens: 0,
    },
  },
  rag: {
    enabled: true,
    topK: 6,
    contextChars: 14000,
    maxNoteBytes: 300_000,
    excludeFolders: ['90 Vorlagen', '99 Archiv', '61 KI Ergebnisse'],
    includeActiveNote: true,
    deepMode: false,
  },
  learning: {
    enabled: true,
    memoryFolder: 'Jarvis Gedächtnis',
    writeNotes: true,
    saveMode: 'auto',
    learnFrom: 'escalations',
    qualityThreshold: 0.55,
    maxLessons: 400,
    injectLessons: 3,
    injectChars: 4000,
    autoDistillAfter: 0,
    distillMaxExamples: 8,
    systemHints: [],
    distillBase: '',
    distillVersion: 0,
    lastDistillAt: '',
    lastDistillModel: '',
    qualityHistory: [],
  },
  tools: {
    enabled: true,
    mode: 'auto',
    effort: 'normal',
    maxSteps: 4,
    allowInternet: false,
    searchProvider: 'duckduckgo',
    searchApiKey: '',
    searchBaseUrl: '',
    allowVaultWrite: false,
    allowShell: false,
    allowFiles: false,
    allowMcp: false,
    allowGithubWrite: false,
    githubApiBase: '',
    hfBaseUrl: '',
    n8nWebhookUrl: '',
    dailyNoteFolder: '',
    mcpServers: [],
    commandTimeoutSeconds: 60,
    shellBlocklist: [],
    showSteps: true,
  },
  github: {
    enabled: false,
    owner: '',
    repo: '',
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
  },
  ui: {
    showSources: true,
    outputFolder: 'Jarvis-Ausgaben',
    stream: true,
    historyLimit: 8,
    showCost: true,
  },
  customInstructions: '',
  answerLanguage: 'Deutsch',
};

/** Erlaubt auch teilweise ausgefüllte Unterobjekte in Tests und alten Dateien. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Fehlende Felder aus älteren Versionen ergänzen. */
export function mergeSettings(loaded: DeepPartial<JarvisSettings> | null | undefined): JarvisSettings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!loaded) return base;
  const merged: JarvisSettings = {
    ...base,
    ...loaded,
    local: { ...base.local, ...(loaded.local ?? {}) },
    rag: { ...base.rag, ...(loaded.rag ?? {}) },
    learning: { ...base.learning, ...(loaded.learning ?? {}) },
    tools: { ...base.tools, ...(loaded.tools ?? {}) },
    github: { ...base.github, ...(loaded.github ?? {}) },
    ui: { ...base.ui, ...(loaded.ui ?? {}) },
    cloud: { ...base.cloud },
  };
  for (const id of Object.keys(base.cloud) as CloudProviderId[]) {
    merged.cloud[id] = { ...base.cloud[id], ...(loaded.cloud?.[id] ?? {}) };
  }
  // MCP-Server: fehlende Felder einzelner Einträge ergänzen, Einträge ohne Namen verwerfen.
  merged.tools.mcpServers = (merged.tools.mcpServers ?? [])
    .filter((eintrag) => eintrag && typeof eintrag.name === 'string' && eintrag.name.trim())
    .map((eintrag) => ({
      name: eintrag.name.trim(),
      enabled: eintrag.enabled !== false,
      transport: eintrag.transport === 'stdio' ? 'stdio' : 'http',
      url: eintrag.url ?? '',
      command: eintrag.command ?? '',
      args: Array.isArray(eintrag.args) ? eintrag.args.map((wert) => String(wert)) : [],
      headers: eintrag.headers && typeof eintrag.headers === 'object' ? eintrag.headers : {},
      env: eintrag.env && typeof eintrag.env === 'object' ? eintrag.env : {},
      timeoutSeconds: Number.isFinite(Number(eintrag.timeoutSeconds)) ? Math.max(5, Number(eintrag.timeoutSeconds)) : 30,
    }));
  return merged;
}

/** Ein Repository aus der Kontoliste (für die Auswahl in den Einstellungen). */
export interface GithubRepoChoice {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private?: boolean;
  pushedAt?: string;
}

/** Schlüssel-IDs: Cloud-Anbieter plus GitHub. */
export type KeyId = CloudProviderId | 'github';

export interface SettingsHost {
  app: App;
  settings: JarvisSettings;
  brain: Brain;
  saveSettings(): Promise<void>;
  getKey(id: KeyId): string;
  setKey(id: KeyId, value: string): Promise<void>;
  keyStorageDescription(): string;
  loadModels(id: CloudProviderId | 'ollama'): Promise<ModelInfo[]>;
  githubBackup(): Promise<void>;
  githubRestore(): Promise<void>;
  githubTest(): Promise<string>;
  githubAccount(): Promise<{ ok: boolean; message: string }>;
  githubConnect(): Promise<void>;
  githubDisconnect(): Promise<void>;
  githubRepos(): Promise<Array<GithubRepoChoice>>;
  githubCreateRepo(name: string, isPrivate: boolean): Promise<GithubRepoChoice | null>;
  testEverything(): Promise<string[]>;
  indexStats(): { files: number; chunks: number; embedded: number; embeddingModel: string | null };
  resetIndex(): Promise<void>;
  /** Werkzeuge */
  testTools(): Promise<string[]>;
  mcpStatus(force?: boolean): Promise<Array<{ name: string; ok: boolean; info: string; tools: string[] }>>;
  closeTools(): void;
  /** Lernsystem */
  learningReport(): string[];
  distillNow(): Promise<string>;
  wipeLearning(): Promise<void>;
  learningSnapshot(): { lessons: number; corrections: number; avgLocalQuality: number; avgCloudQuality: number; improvement: number; pending: number };
}

export class JarvisSettingTab extends PluginSettingTab {
  private host: SettingsHost;
  /** Zuletzt geladene Repositories des Kontos (für die Auswahl unten). */
  private repoListe: GithubRepoChoice[] = [];

  constructor(app: App, host: SettingsHost) {
    super(app, host as never);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Jarvis KI — Einstellungen' });

    this.renderMode(containerEl);
    this.renderLocal(containerEl);
    this.renderCloud(containerEl);
    this.renderVault(containerEl);
    this.renderLearning(containerEl);
    this.renderTools(containerEl);
    this.renderGithub(containerEl);
    this.renderBehaviour(containerEl);
    this.renderDiagnose(containerEl);
  }

  private save = async (): Promise<void> => {
    await this.host.saveSettings();
  };

  // ------------------------------------------------------------- Modus

  private renderMode(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Wo soll gerechnet werden?' });
    const settings = this.host.settings;

    new Setting(containerEl)
      .setName('Standardmodus')
      .setDesc(
        'Lokal = nur auf diesem Rechner (Ollama). Auto = lokal, bei Bedarf automatisch Cloud. Cloud = immer das stärkste Modell.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ local: '🏠 Nur lokal', auto: '⚡ Automatisch', cloud: '☁️ Immer Cloud' })
          .setValue(settings.routeMode)
          .onChange(async (value) => {
            settings.routeMode = value as JarvisSettings['routeMode'];
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Automatisch auf Cloud ausweichen')
      .setDesc(
        'Nur im Modus "Automatisch": Wenn lokal kein Modell läuft, die Frage sehr groß ist oder die lokale Antwort unbrauchbar wirkt, übernimmt ein Top-Cloud-Modell.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoEscalate).onChange(async (value) => {
          settings.autoEscalate = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Reihenfolge der Cloud-Anbieter')
      .setDesc('Mit Komma, zuerst genannter Anbieter gewinnt. Möglich: anthropic, openai, gemini, openrouter, custom.')
      .addText((text) =>
        text
          .setPlaceholder('anthropic, openai, gemini')
          .setValue(settings.autoOrder.join(', '))
          .onChange(async (value) => {
            const parsed = value
              .split(',')
              .map((entry) => entry.trim().toLowerCase())
              .filter((entry): entry is CloudProviderId => entry in settings.cloud);
            if (parsed.length) settings.autoOrder = parsed;
            await this.save();
          }),
      );
  }

  // ------------------------------------------------------------- Lokal

  private renderLocal(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Lokales Modell (Ollama)' });
    const local = this.host.settings.local;

    new Setting(containerEl)
      .setName('Adresse des Ollama-Dienstes')
      .setDesc('Standard: http://127.0.0.1:11434 — muss laufen, damit lokale Modelle antworten.')
      .addText((text) =>
        text.setValue(local.baseUrl).onChange(async (value) => {
          local.baseUrl = value.trim() || 'http://127.0.0.1:11434';
          this.host.brain.refresh();
          this.host.brain.invalidateModelCache('ollama');
          await this.save();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Modelle laden').onClick(async () => {
          try {
            const models = await this.host.loadModels('ollama');
            new Notice(`Ollama: ${models.length} Modell(e) gefunden.`);
            this.display();
          } catch (error) {
            new Notice(`Ollama nicht erreichbar: ${(error as Error).message}`, 10000);
          }
        }),
      );

    const modelNames = local.preferred.length ? local.preferred : [];
    new Setting(containerEl)
      .setName('Standard-Modell (lokal)')
      .setDesc(
        modelNames.length
          ? `Gefunden: ${modelNames.join(', ')}`
          : 'Noch keine Liste geladen — "Modelle laden" antippen. Empfohlen: qwen3.6:27b, qwen3:30b, gpt-oss:20b, qwen3:8b.',
      )
      .addText((text) =>
        text
          .setPlaceholder('qwen3.6:27b')
          .setValue(local.defaultModel)
          .onChange(async (value) => {
            local.defaultModel = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Kontextgröße (num_ctx)')
      .setDesc('Wie viel Text das lokale Modell gleichzeitig sieht. 8192 ist ein guter Start; höher braucht mehr Speicher.')
      .addText((text) =>
        text.setValue(String(local.numCtx)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 2048) local.numCtx = parsed;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Kreativität (Temperatur)')
      .setDesc('0 = sehr sachlich, 1 = sehr frei. Für Faktenfragen 0,2–0,5.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(local.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            local.temperature = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Modell im Speicher halten')
      .setDesc('Wie lange das lokale Modell nach einer Antwort geladen bleibt (z. B. 10m, 30m, 1h). Größer = schnellere Folgefragen, mehr RAM.')
      .addText((text) =>
        text.setValue(local.keepAlive).onChange(async (value) => {
          local.keepAlive = value.trim() || '10m';
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Embedding-Modell für die Wissenssuche')
      .setDesc('Kleines Modell für die Bedeutungssuche, z. B. nomic-embed-text: ollama pull nomic-embed-text. Ohne Modell nutzt Jarvis die Stichwortsuche.')
      .addText((text) =>
        text.setValue(local.embedModel).onChange(async (value) => {
          local.embedModel = value.trim();
          await this.save();
        }),
      )
      .addToggle((toggle) =>
        toggle.setValue(local.useEmbeddings).onChange(async (value) => {
          local.useEmbeddings = value;
          await this.save();
        }),
      );
  }

  // ------------------------------------------------------------- Cloud

  private renderCloud(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Cloud-Modelle (Top-Leistung)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Schlüssel werden ' +
        this.host.keyStorageDescription() +
        '. Nur aktivierte Anbieter werden verwendet. Ohne Cloud-Schlüssel arbeitet Jarvis vollständig lokal.',
    });

    const providers: Array<{ id: CloudProviderId; hint: string; keyHint: string }> = [
      {
        id: 'anthropic',
        hint: 'Claude Opus 5.5 führt die Qualitätslisten an und ist die beste Wahl für lange, anspruchsvolle Aufgaben. Schlüssel: console.anthropic.com',
        keyHint: 'sk-ant-…',
      },
      {
        id: 'openai',
        hint: 'GPT-6 Astra ist OpenAIs stärkstes Modell. Schlüssel: platform.openai.com',
        keyHint: 'sk-…',
      },
      {
        id: 'gemini',
        hint: 'Gemini 3.8 Flash ist sehr schnell und stark. Schlüssel: aistudio.google.com (kostenloses Kontingent vorhanden)',
        keyHint: 'AIza…',
      },
      {
        id: 'openrouter',
        hint: 'Ein Schlüssel für sehr viele Modelle (Claude, GPT, Gemini, Grok, DeepSeek). Schlüssel: openrouter.ai/keys',
        keyHint: 'sk-or-…',
      },
      {
        id: 'huggingface',
        hint:
          'Offene Spitzenmodelle über den Hugging-Face-Router (Qwen3 235B, Kimi K2, DeepSeek, GLM …). ' +
          'Schlüssel: huggingface.co/settings/tokens (Recht „Make calls to Inference Providers")',
        keyHint: 'hf_…',
      },
      {
        id: 'n8n',
        hint:
          'Dein eigener n8n-Arbeitsablauf als Modell: Jarvis schickt die Anfrage an einen Webhook und bekommt die Antwort. ' +
          'So kann Jarvis alles auslösen, was n8n kann (Mails, Kalender, Datenbanken, Dienste). Adresse: http://127.0.0.1:5678/webhook/jarvis',
        keyHint: 'optionaler geheimer Schlüssel',
      },
      {
        id: 'custom',
        hint: 'Jeder Dienst, der wie OpenAI antwortet (LM Studio, vLLM, Groq, DeepSeek, Mistral …).',
        keyHint: 'Schlüssel oder leer',
      },
    ];

    for (const provider of providers) {
      const cloud = this.host.settings.cloud[provider.id];
      containerEl.createEl('h4', { text: cloud.label });

      new Setting(containerEl)
        .setName('Aktiv')
        .setDesc(provider.hint)
        .addToggle((toggle) =>
          toggle.setValue(cloud.enabled).onChange(async (value) => {
            cloud.enabled = value;
            await this.save();
          }),
        );

      new Setting(containerEl)
        .setName('API-Schlüssel')
        .setDesc(`Aktuell: ${this.maskKey(this.host.getKey(provider.id))}`)
        .addText((text) => {
          text.inputEl.type = 'password';
          text.setPlaceholder(provider.keyHint);
          text.onChange(async (value) => {
            await this.host.setKey(provider.id, value.trim());
            this.display();
          });
          return text;
        });

      new Setting(containerEl)
        .setName('Adresse (Base URL)')
        .setDesc('Nur ändern, wenn du einen anderen Zugang nutzt.')
        .addText((text) =>
          text.setValue(cloud.baseUrl).onChange(async (value) => {
            cloud.baseUrl = value.trim();
            this.host.brain.refresh();
            await this.save();
          }),
        );

      new Setting(containerEl)
        .setName('Modell')
        .setDesc('Empfehlungen sind eingetragen. Mit "Modelle laden" holst du die echte Liste deines Kontos.')
        .addText((text) =>
          text.setValue(cloud.defaultModel).onChange(async (value) => {
            cloud.defaultModel = value.trim();
            await this.save();
          }),
        )
        .addButton((button) =>
          button.setButtonText('Modelle laden').onClick(async () => {
            try {
              const models = await this.host.loadModels(provider.id);
              cloud.models = models.map((model) => model.id);
              new Notice(`${cloud.label}: ${models.length} Modell(e) gefunden.`);
              this.display();
            } catch (error) {
              new Notice(`${cloud.label}: ${(error as Error).message}`, 12000);
            }
          }),
        )
        .addButton((button) =>
          button.setButtonText('Testen').onClick(async () => {
            try {
              const models = await this.host.loadModels(provider.id);
              new Notice(`${cloud.label} ✅ verbunden — ${models.length} Modelle.`, 8000);
            } catch (error) {
              new Notice(`${cloud.label} ❌ ${(error as Error).message}`, 12000);
            }
          }),
        );

      new Setting(containerEl)
        .setName('Nachdenken')
        .setDesc(
          'Wie gründlich das Modell rechnen soll. „aus" sendet nichts Zusätzliches (immer sicher). ' +
            'Höhere Stufen kosten mehr Zeit und Geld, sind aber bei schwierigen Aufgaben genauer. ' +
            'Kann eine Schnittstelle das Feld nicht, wird die Anfrage automatisch ohne es wiederholt.',
        )
        .addDropdown((dropdown) => {
          const stufen: Array<{ id: 'off' | 'low' | 'medium' | 'high'; label: string }> = [
            { id: 'off', label: 'aus (Standard)' },
            { id: 'low', label: 'wenig' },
            { id: 'medium', label: 'mittel' },
            { id: 'high', label: 'viel (Maximum)' },
          ];
          for (const stufe of stufen) dropdown.addOption(stufe.id, stufe.label);
          dropdown.setValue(cloud.thinkingLevel ?? 'off').onChange(async (value) => {
            cloud.thinkingLevel = value as 'off' | 'low' | 'medium' | 'high';
            await this.save();
          });
          return dropdown;
        });

      if (cloud.models.length) {
        const list = containerEl.createEl('p', { cls: 'setting-item-description' });
        list.setText(`Bekannte Modelle: ${cloud.models.slice(0, 12).join(', ')}${cloud.models.length > 12 ? ' …' : ''}`);
      }
    }
  }

  // ------------------------------------------------------------- Werkzeuge

  private renderTools(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Werkzeuge — Jarvis handeln lassen' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Werkzeuge machen Jarvis stärker: Internet durchsuchen, Seiten lesen, Notizen lesen und schreiben, rechnen, ' +
        'Befehle auf dem Rechner ausführen und fremde MCP-Werkzeuge benutzen. Alles ist freiwillig — ' +
        'was du nicht einschaltest, kann Jarvis nicht.',
    });
    const tools = this.host.settings.tools;

    new Setting(containerEl)
      .setName('Werkzeuge benutzen')
      .setDesc('Hauptschalter. Ohne diesen antwortet Jarvis wie bisher nur aus Wissen und Notizen.')
      .addToggle((toggle) =>
        toggle.setValue(tools.enabled).onChange(async (value) => {
          tools.enabled = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Wann benutzen?')
      .setDesc('„Bei Bedarf" ist sparsam und schnell; „immer" gibt dem Modell jedes Mal die volle Werkzeugliste.')
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', 'Bei Bedarf (empfohlen)');
        dropdown.addOption('always', 'Immer anbieten');
        dropdown.addOption('off', 'Nie');
        dropdown.setValue(tools.mode).onChange(async (value) => {
          tools.mode = value as 'off' | 'auto' | 'always';
          await this.save();
        });
        return dropdown;
      });

    new Setting(containerEl)
      .setName('Arbeitsweise')
      .setDesc(
        '„Maximal" arbeitet gründlicher: mehr Werkzeugrunden und am Ende eine Selbstprüfung gegen die Werkzeug-Ergebnisse. ' +
          'Etwas langsamer, aber deutlich genauer.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('normal', 'Ausgewogen');
        dropdown.addOption('max', 'Maximal (mehrfach prüfen)');
        dropdown.setValue(tools.effort).onChange(async (value) => {
          tools.effort = value as 'normal' | 'max';
          await this.save();
        });
        return dropdown;
      });

    new Setting(containerEl)
      .setName('Höchstzahl Werkzeugschritte')
      .setDesc('Schutz vor Endlosschleifen. 4 ist ein guter Wert, 8 für komplizierte Recherchen.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setValue(tools.maxSteps)
          .setDynamicTooltip()
          .onChange(async (value) => {
            tools.maxSteps = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Internet')
      .setDesc('Jarvis darf suchen und Seiten lesen. Die Inhalte gehen an das gewählte Modell (auch in die Cloud).')
      .addToggle((toggle) =>
        toggle.setValue(tools.allowInternet).onChange(async (value) => {
          tools.allowInternet = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Suchdienst')
      .setDesc(
        'DuckDuckGo braucht keinen Schlüssel. Tavily und Brave sind zuverlässiger (kostenlose Kontingente). ' +
          'SearXNG: Adresse deiner eigenen Instanz — dort muss die JSON-Ausgabe eingeschaltet sein.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('duckduckgo', 'DuckDuckGo (ohne Schlüssel)');
        dropdown.addOption('tavily', 'Tavily');
        dropdown.addOption('brave', 'Brave Search');
        dropdown.addOption('searxng', 'SearXNG (eigene Instanz)');
        dropdown.setValue(tools.searchProvider).onChange(async (value) => {
          tools.searchProvider = value as typeof tools.searchProvider;
          await this.save();
        });
        return dropdown;
      });

    new Setting(containerEl)
      .setName('Schlüssel des Suchdienstes')
      .setDesc(`Aktuell: ${this.maskKey(tools.searchApiKey)}`)
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('leer lassen bei DuckDuckGo');
        text.onChange(async (value) => {
          tools.searchApiKey = value.trim();
          await this.save();
        });
        return text;
      })
      .addText((text) =>
        text
          .setPlaceholder('Adresse (nur SearXNG), z. B. http://127.0.0.1:8080')
          .setValue(tools.searchBaseUrl)
          .onChange(async (value) => {
            tools.searchBaseUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Notizen anlegen und ändern')
      .setDesc('Jarvis darf Notizen im Vault schreiben. Jede Änderung wird dir in der Antwort genannt; die GitHub-Sicherung nimmt sie mit.')
      .addToggle((toggle) =>
        toggle.setValue(tools.allowVaultWrite).onChange(async (value) => {
          tools.allowVaultWrite = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Befehle auf dem Rechner')
      .setDesc(
        'Nur Desktop. Jarvis darf Programme starten (z. B. git, npm, Skripte). Gefährliche Befehle sind gesperrt. ' +
          'Gib das nur frei, wenn du es wirklich willst.',
      )
      .addToggle((toggle) =>
        toggle.setValue(tools.allowShell).onChange(async (value) => {
          tools.allowShell = value;
          await this.save();
        }),
      );

    // --- Verbundene Dienste: GitHub, HuggingFace, n8n ---
    containerEl.createEl('h4', { text: 'Verbundene Dienste (GitHub, HuggingFace, n8n)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'GitHub-Werkzeuge (Dateien lesen, Baum ansehen, suchen, Aufgaben) nutzen das Repository und den Schlüssel aus dem GitHub-Abschnitt. ' +
        'HuggingFace (Modelle und Datensätze finden) und n8n (Workflows auslösen) sind unten einstellbar.',
    });

    new Setting(containerEl)
      .setName('GitHub: Dateien schreiben')
      .setDesc('Erlaubt Jarvis, Dateien im verbundenen Repository zu ändern (jede Änderung wird commitet). Standardmäßig aus.')
      .addToggle((toggle) =>
        toggle.setValue(tools.allowGithubWrite).onChange(async (value) => {
          tools.allowGithubWrite = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('n8n-Webhook')
      .setDesc('Adresse des n8n-Webhooks, den Jarvis auslösen darf (z. B. https://n8n.example.com/webhook/jarvis).')
      .addText((text) =>
        text
          .setPlaceholder('https://…/webhook/…')
          .setValue(tools.n8nWebhookUrl)
          .onChange(async (value) => {
            tools.n8nWebhookUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Tagesnotizen-Ordner')
      .setDesc(
        'Ordner deiner Tagesnotizen (leer = Vault-Wurzel), z. B. "Journal". Jarvis liest die Tagesnotiz im Format JJJJ-MM-TT.md und darf sie ergänzen.',
      )
      .addText((text) =>
        text
          .setPlaceholder('Journal')
          .setValue(tools.dailyNoteFolder)
          .onChange(async (value) => {
            tools.dailyNoteFolder = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('GitHub-API-Adresse')
      .setDesc('Leer lassen für https://api.github.com. Für GitHub Enterprise die eigene Adresse eintragen.')
      .addText((text) =>
        text
          .setPlaceholder('https://api.github.com')
          .setValue(tools.githubApiBase)
          .onChange(async (value) => {
            tools.githubApiBase = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('HuggingFace-Adresse')
      .setDesc('Leer lassen für https://huggingface.co. Für einen eigenen Spiegel die Adresse eintragen.')
      .addText((text) =>
        text
          .setPlaceholder('https://huggingface.co')
          .setValue(tools.hfBaseUrl)
          .onChange(async (value) => {
            tools.hfBaseUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Umgebungstest der Werkzeuge')
      .setDesc('Prüft die Werkzeuge mit echten Aufrufen (Rechnen, Vault, Internet, MCP).')
      .addButton((button) =>
        button.setButtonText('Werkzeuge testen').onClick(async () => {
          const notice = new Notice('Jarvis prüft die Werkzeuge …', 60_000);
          try {
            const zeilen = await this.host.testTools();
            notice.hide();
            new ReportModal(this.app, 'Werkzeug-Selbsttest', zeilen).open();
          } catch (error) {
            notice.hide();
            new Notice(`Werkzeugtest fehlgeschlagen: ${(error as Error).message}`, 12000);
          }
        }),
      );

    // --- MCP-Server ---
    containerEl.createEl('h4', { text: 'MCP-Server (fremde Werkzeuge)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'MCP ist ein offener Standard: Programme bieten darüber Werkzeuge an (Dateien, Browser, Datenbanken, GitHub, n8n …). ' +
        'Jarvis kann sie benutzen. HTTP läuft auch auf dem Tablet; „Programm" (stdio) nur auf dem Desktop.',
    });

    tools.mcpServers.forEach((server, index) => {
      const box = containerEl.createDiv({ cls: 'jarvis-mcp-entry' });
      box.createEl('h5', { text: `Server ${index + 1}: ${server.name || '(ohne Namen)'}` });

      new Setting(box)
        .setName('Name')
        .setDesc('Nur für die Anzeige und die Werkzeugnamen (z. B. files, browser, n8n).')
        .addText((text) =>
          text.setValue(server.name).onChange(async (value) => {
            server.name = value.trim();
            await this.save();
          }),
        );

      new Setting(box)
        .setName('Aktiv')
        .addToggle((toggle) =>
          toggle.setValue(server.enabled).onChange(async (value) => {
            server.enabled = value;
            this.host.closeTools();
            await this.save();
          }),
        );

      new Setting(box)
        .setName('Transport')
        .setDesc('HTTP = Adresse eines Servers. Programm = lokales Programm, das über stdin/stdout spricht (nur Desktop).')
        .addDropdown((dropdown) => {
          dropdown.addOption('http', 'HTTP (Adresse)');
          dropdown.addOption('stdio', 'Programm (stdio, nur Desktop)');
          dropdown.setValue(server.transport).onChange(async (value) => {
            server.transport = value === 'stdio' ? 'stdio' : 'http';
            await this.save();
          });
          return dropdown;
        });

      new Setting(box)
        .setName('HTTP-Adresse')
        .setDesc('z. B. https://mcp.example.com/mcp oder http://127.0.0.1:3000/mcp')
        .addText((text) =>
          text.setValue(server.url).onChange(async (value) => {
            server.url = value.trim();
            this.host.closeTools();
            await this.save();
          }),
        );

      new Setting(box)
        .setName('Programm und Argumente')
        .setDesc('z. B. npx -y @modelcontextprotocol/server-filesystem /pfad/zu/ordner (Argumente mit Leerzeichen trennen)')
        .addText((text) =>
          text
            .setPlaceholder('npx')
            .setValue(server.command)
            .onChange(async (value) => {
              server.command = value.trim();
              this.host.closeTools();
              await this.save();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('-y @modelcontextprotocol/server-filesystem /pfad')
            .setValue(server.args.join(' '))
            .onChange(async (value) => {
              server.args = value.split(/\s+/).map((teil) => teil.trim()).filter(Boolean);
              this.host.closeTools();
              await this.save();
            }),
        );

      new Setting(box)
        .setName('Zeitlimit (Sekunden)')
        .addSlider((slider) =>
          slider
            .setLimits(5, 180, 5)
            .setValue(server.timeoutSeconds)
            .setDynamicTooltip()
            .onChange(async (value) => {
              server.timeoutSeconds = value;
              await this.save();
            }),
        )
        .addButton((button) =>
          button.setButtonText('Verbindung testen').onClick(async () => {
            const notice = new Notice(`Prüfe „${server.name}" …`, 60_000);
            try {
              const liste = await this.host.mcpStatus(true);
              const eigener = liste.find((eintrag) => eintrag.name === server.name) ?? liste[0];
              notice.hide();
              if (!eigener) new Notice('Kein MCP-Server eingetragen.', 8000);
              else if (eigener.ok)
                new Notice(`„${eigener.name}" ✅ ${eigener.info} — ${eigener.tools.length} Werkzeug(e): ${eigener.tools.slice(0, 8).join(', ')}`, 15000);
              else new Notice(`„${eigener.name}" ❌ ${eigener.info}`, 15000);
            } catch (error) {
              notice.hide();
              new Notice(`Test fehlgeschlagen: ${(error as Error).message}`, 12000);
            }
          }),
        )
        .addButton((button) =>
          button.setButtonText('Entfernen').onClick(async () => {
            tools.mcpServers = tools.mcpServers.filter((eintrag) => eintrag !== server);
            this.host.closeTools();
            await this.save();
            this.display();
          }),
        );
    });

    new Setting(containerEl)
      .setName('MCP-Server hinzufügen')
      .setDesc('Nach dem Hinzufügen Name, Transport und Adresse ausfüllen und „Verbindung testen" drücken.')
      .addButton((button) =>
        button.setButtonText('Server hinzufügen').onClick(async () => {
          tools.mcpServers = [
            ...tools.mcpServers,
            {
              name: `server${tools.mcpServers.length + 1}`,
              enabled: true,
              transport: 'http',
              url: '',
              command: '',
              args: [],
              headers: {},
              env: {},
              timeoutSeconds: 30,
            },
          ];
          await this.save();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Schritte unter der Antwort zeigen')
      .setDesc('Zeigt, welche Werkzeuge Jarvis benutzt hat — gut zum Nachvollziehen.')
      .addToggle((toggle) =>
        toggle.setValue(tools.showSteps).onChange(async (value) => {
          tools.showSteps = value;
          await this.save();
        }),
      );
  }

  private maskKey(key: string): string {
    if (!key) return 'nicht hinterlegt';
    if (key.length <= 8) return '••••';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  // -------------------------------------------------------------- Vault

  private renderVault(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Wissen aus dem Vault' });
    const rag = this.host.settings.rag;

    new Setting(containerEl)
      .setName('Notizen durchsuchen')
      .setDesc('Jarvis sucht passende Abschnitte in deinen Notizen und gibt sie dem Modell als Quellen mit.')
      .addToggle((toggle) =>
        toggle.setValue(rag.enabled).onChange(async (value) => {
          rag.enabled = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Wie viele Quellen')
      .setDesc('Anzahl der Notiz-Abschnitte, die mitgeschickt werden (3–10 ist sinnvoll).')
      .addSlider((slider) =>
        slider
          .setLimits(1, 15, 1)
          .setValue(rag.topK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            rag.topK = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Textmenge für Quellen (Zeichen)')
      .setDesc('Mehr Kontext = genauere Antworten, aber langsamer und teurer. 14.000 Zeichen entsprechen etwa 4.000 Token.')
      .addText((text) =>
        text.setValue(String(rag.contextChars)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 2000) rag.contextChars = parsed;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Ausgeschlossene Ordner')
      .setDesc('Diese Ordner werden nie durchsucht (eine Zeile pro Ordner).')
      .addTextArea((area) => {
        area.setValue(rag.excludeFolders.join('\n')).onChange(async (value) => {
          rag.excludeFolders = value.split('\n').map((line) => line.trim()).filter(Boolean);
          await this.save();
        });
        area.inputEl.rows = 4;
        return area;
      });

    new Setting(containerEl)
      .setName('Geöffnete Notiz immer einbeziehen')
      .setDesc('Jarvis liest zusätzlich die Notiz, die gerade offen ist.')
      .addToggle((toggle) =>
        toggle.setValue(rag.includeActiveNote).onChange(async (value) => {
          rag.includeActiveNote = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Gründlicher Modus als Standard')
      .setDesc('Zwei Durchgänge (Antwort + Selbstprüfung). Besser bei schwierigen Aufgaben, dauert länger.')
      .addToggle((toggle) =>
        toggle.setValue(rag.deepMode).onChange(async (value) => {
          rag.deepMode = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Private Notizen ausschließen')
      .setDesc(
        'Notizen mit der Eigenschaft ki-privat: true (auch jarvis-privat: true) werden nie gelesen. ' +
          'Aktueller Index: ' +
          `${this.host.indexStats().chunks} Abschnitte aus ${this.host.indexStats().files} Notizen.`,
      )
      .addButton((button) =>
        button.setButtonText('Index neu aufbauen').onClick(async () => {
          await this.host.resetIndex();
          new Notice('Jarvis: Index gelöscht. Beim nächsten Aufruf wird neu gelesen.', 8000);
        }),
      );
  }

  // ------------------------------------------------------------- Lernen

  private renderLearning(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Lernen & Selbstverbesserung' });
    const learning = this.host.settings.learning;
    const snapshot = this.host.learningSnapshot();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `Gelernt: ${snapshot.lessons} Lektion(en), davon ${snapshot.corrections} mit deiner Korrektur. ` +
        `Qualität lokal im Schnitt ${Math.round(snapshot.avgLocalQuality * 100)} %` +
        (snapshot.avgCloudQuality ? `, Cloud ${Math.round(snapshot.avgCloudQuality * 100)} %` : '') +
        (snapshot.improvement ? `, Veränderung nach dem letzten Verbessern ${snapshot.improvement > 0 ? '+' : ''}${Math.round(snapshot.improvement * 100)} %` : '') +
        `. ${snapshot.pending} neue Lektion(en) seit dem letzten Verbessern.`,
    });

    new Setting(containerEl)
      .setName('Lernen aktiv')
      .setDesc(
        'Wenn die Cloud antwortet, speichert Jarvis die Antwort als Wissen und nutzt sie bei späteren Fragen — ' +
          'die lokale KI braucht dadurch seltener die Cloud und antwortet besser.',
      )
      .addToggle((toggle) =>
        toggle.setValue(learning.enabled).onChange(async (value) => {
          learning.enabled = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Wann merken?')
      .setDesc(
        'automatisch = sofort speichern · nachfragen = Knopf unter der Antwort · aus = nichts speichern. ' +
          'Das Lernen ist keine Modell-Schulung: es sind gespeicherte Antworten und Regeln, die als Kontext dienen.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ auto: 'automatisch', ask: 'nachfragen', off: 'aus' })
          .setValue(learning.saveMode)
          .onChange(async (value) => {
            learning.saveMode = value as 'auto' | 'ask' | 'off';
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Woraus lernen?')
      .setDesc('Nur aus Ausweich-/Aufwertungs-Antworten (sparsam) oder aus jeder Cloud-Antwort (lernt mehr, kostet mehr Speicher).')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ escalations: 'nur wenn lokal nicht reichte', all: 'aus jeder Cloud-Antwort' })
          .setValue(learning.learnFrom)
          .onChange(async (value) => {
            learning.learnFrom = value as 'escalations' | 'all';
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Qualitätsschwelle')
      .setDesc(
        'Wie viel von dem, was in deinen Notizen steht, muss die lokale Antwort treffen (0–1)? ' +
          'Darunter wertet Jarvis die Antwort auf (Cloud) und lernt daraus. Empfehlung: 0,5–0,6.',
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 0.9, 0.05)
          .setValue(learning.qualityThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            learning.qualityThreshold = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Gelerntes als Notizen im Vault')
      .setDesc('Jede Lektion wird zusätzlich als Markdown abgelegt — dadurch sichert GitHub sie automatisch mit und du kannst sie lesen/ändern.')
      .addToggle((toggle) =>
        toggle.setValue(learning.writeNotes).onChange(async (value) => {
          learning.writeNotes = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Gedächtnisordner')
      .setDesc('Ordner für die gelernten Notizen. Er wird bei der Vault-Suche nicht doppelt gelesen, aber bei GitHub gesichert.')
      .addText((text) =>
        text.setValue(learning.memoryFolder).onChange(async (value) => {
          learning.memoryFolder = value.trim() || 'Jarvis Gedächtnis';
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Lektionen im Prompt')
      .setDesc('Wie viele passende Lektionen die lokale KI mitgeschickt bekommt.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 8, 1)
          .setValue(learning.injectLessons)
          .setDynamicTooltip()
          .onChange(async (value) => {
            learning.injectLessons = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Obergrenze gespeicherter Lektionen')
      .setDesc('Bei Erreichen werden schlecht bewertete und ungenutzte Einträge zuerst entfernt.')
      .addText((text) =>
        text.setValue(String(learning.maxLessons)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 50) learning.maxLessons = parsed;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Automatisch verbessern (Destillieren)')
      .setDesc(
        'Nach so vielen neuen Lektionen wird automatisch ein neues lokales Ollama-Profil erstellt ' +
          '(0 = aus). Es wird nur ein Profil angelegt — nichts heruntergeladen, keine Modellgewichte trainiert.',
      )
      .addText((text) =>
        text.setValue(String(learning.autoDistillAfter)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          learning.autoDistillAfter = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Beispiele im lokalen Modell')
      .setDesc('Wie viele gelernte Frage/Antwort-Paare ins Profil geschrieben werden (mehr = klüger, aber größer).')
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(learning.distillMaxExamples)
          .setDynamicTooltip()
          .onChange(async (value) => {
            learning.distillMaxExamples = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Regeln aus Korrekturen')
      .setDesc('Eine Regel pro Zeile. Diese Regeln sind im lokalen Modell fest eingebaut (und im Chat immer aktiv).')
      .addTextArea((area) => {
        area.setValue((learning.systemHints ?? []).join('\n')).onChange(async (value) => {
          learning.systemHints = value.split('\n').map((line) => line.trim()).filter(Boolean);
          await this.save();
        });
        area.inputEl.rows = 3;
        return area;
      });

    new Setting(containerEl)
      .setName('Aktionen')
      .setDesc(
        learning.distillVersion
          ? `Aktuelles Lernmodell: ${learning.lastDistillModel || `jarvis-brain-v${learning.distillVersion}`}` +
            (learning.lastDistillAt ? ` (${learning.lastDistillAt})` : '')
          : 'Noch kein Lernmodell erstellt.',
      )
      .addButton((button) =>
        button
          .setButtonText('Jetzt verbessern')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Arbeite …');
            try {
              const message = await this.host.distillNow();
              new Notice(message, 15000);
              this.display();
            } catch (error) {
              new Notice(`Verbessern fehlgeschlagen: ${(error as Error).message}`, 15000);
            } finally {
              button.setDisabled(false);
              button.setButtonText('Jetzt verbessern');
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText('Verlauf anzeigen').onClick(() => {
          this.showReport(this.host.learningReport(), 'Jarvis: was gelernt wurde');
        }),
      )
      .addButton((button) =>
        button.setWarning().setButtonText('Gelerntes löschen').onClick(async () => {
          await this.host.wipeLearning();
          new Notice('Gelerntes Wissen gelöscht (lokale Notizen bleiben erhalten, bis du sie löschst).', 10000);
          this.display();
        }),
      );
  }

  // ------------------------------------------------------------- GitHub

  private renderGithub(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'GitHub: Vault sichern und wiederherstellen' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Sichert deinen Vault als echte Commits in ein GitHub-Repository (Versionen, Verlauf, zweiter Rechner). ' +
        'Der Schlüssel kommt aus deinem eigenen GitHub-Konto — das Plugin selbst stellt keinen Server.',
    });
    const github = this.host.settings.github;

    // --- Verbindung (ein Knopf statt Token-Bastelei) ---
    new Setting(containerEl)
      .setName('Verbindung')
      .setDesc(
        verbindungsText({
          token: this.host.getKey('github'),
          login: github.login ?? '',
          scopes: github.scopes ?? '',
          owner: github.owner,
          repo: github.repo,
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Mit GitHub verbinden')
          .setCta()
          .onClick(async () => {
            await this.host.githubConnect();
            this.display();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Rechte prüfen').onClick(async () => {
          const ergebnis = await this.host.githubAccount();
          new Notice(ergebnis.message, 12000);
        }),
      )
      .addButton((button) =>
        button.setButtonText('Trennen').onClick(async () => {
          await this.host.githubDisconnect();
          this.repoListe = [];
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('OAuth-Client-ID (einmalig, für die Anmeldung per Code)')
      .setDesc(
        'Auf github.com → Einstellungen → Developer settings → OAuth Apps → "New OAuth App": ' +
          'Name frei, Homepage https://github.com/mar65vo187/jarvis, Callback http://localhost, Haken bei ' +
          '"Enable Device flow". Danach die Client-ID hier eintragen. Alternativ unten einen Token von Hand einfügen.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Iv1.… (leer = Knopf zeigt die Anleitung)');
        text.setValue(github.oauthClientId ?? '');
        text.onChange(async (value) => {
          github.oauthClientId = value.trim();
          await this.save();
        });
        return text;
      });

    // --- Ziel-Repository: auswählen oder anlegen ---
    new Setting(containerEl)
      .setName('Repository auswählen')
      .setDesc(
        this.repoListe.length
          ? `${this.repoListe.length} Repository(ies) geladen. Auswahl trägt Benutzer, Namen und Branch ein.`
          : 'Lädt deine Repositories aus dem Konto — die Auswahl trägt Benutzer, Namen und Branch automatisch ein.',
      )
      .addButton((button) =>
        button.setButtonText('Repositories laden').onClick(async () => {
          const liste = await this.host.githubRepos();
          if (liste.length) {
            this.repoListe = liste;
            new Notice(`${liste.length} Repository(ies) geladen.`, 8000);
            this.display();
          }
        }),
      );

    if (this.repoListe.length) {
      const aktuell = `${github.owner}/${github.repo}`;
      new Setting(containerEl)
        .setName('Deine Repositories')
        .setDesc('Zuletzt genutzte zuerst.')
        .addDropdown((dropdown) => {
          const optionen: Record<string, string> = {};
          for (const repo of this.repoListe) {
            optionen[repo.fullName] = `${repo.fullName}${repo.private ? ' (privat)' : ''}`;
          }
          if (aktuell !== '/' && !optionen[aktuell]) optionen[aktuell] = `${aktuell} (eingetragen)`;
          dropdown.addOptions(optionen);
          dropdown.setValue(aktuell);
          dropdown.onChange(async (value) => {
            const repo = this.repoListe.find((eintrag) => eintrag.fullName === value);
            if (!repo) return;
            github.owner = repo.owner;
            github.repo = repo.name;
            github.branch = repo.defaultBranch || 'main';
            github.enabled = true;
            await this.save();
            new Notice(`Ziel: ${repo.fullName} (Branch ${github.branch}).`, 8000);
            this.display();
          });
        });
    }

    let neuerRepoName = 'jarvis-vault';
    new Setting(containerEl)
      .setName('Neues Repository anlegen')
      .setDesc('Legt ein privates Repository an (mit README, damit der Branch sofort existiert) und trägt es als Ziel ein.')
      .addText((text) => {
        text.setValue(neuerRepoName);
        text.onChange((value) => {
          neuerRepoName = value.trim() || 'jarvis-vault';
        });
        return text;
      })
      .addButton((button) =>
        button.setButtonText('Anlegen').onClick(async () => {
          const repo = await this.host.githubCreateRepo(neuerRepoName, true);
          if (repo) {
            this.repoListe = [
              repo,
              ...this.repoListe.filter((eintrag) => eintrag.fullName !== repo.fullName),
            ];
            this.display();
          }
        }),
      );

    new Setting(containerEl)
      .setName('GitHub-Sicherung aktiv')
      .setDesc('Wenn aus, wird nichts hochgeladen und nichts heruntergeladen.')
      .addToggle((toggle) =>
        toggle.setValue(github.enabled).onChange(async (value) => {
          github.enabled = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('GitHub-Benutzer (Owner)')
      .setDesc('Wird beim Verbinden oder Auswählen eines Repositories automatisch eingetragen (z. B. mar65vo187).')
      .addText((text) =>
        text.setValue(github.owner).onChange(async (value) => {
          github.owner = value.trim();
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Repository-Name')
      .setDesc('Zum Beispiel jarvis-vault. Wird beim Auswählen oder Anlegen automatisch eingetragen.')
      .addText((text) =>
        text.setValue(github.repo).onChange(async (value) => {
          github.repo = value.trim();
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('GitHub-Token von Hand (Alternative zur Anmeldung)')
      .setDesc(
        `Aktuell: ${this.maskKey(this.host.getKey('github'))}. Auf github.com/settings/personal-access-tokens erstellen: ` +
          'Repository access = nur dieses Repository, Berechtigung "Contents" = Read and write. ' +
          'Wird ' + this.host.keyStorageDescription() + '.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('github_pat_…');
        text.onChange(async (value) => {
          await this.host.setKey('github', value.trim());
          this.display();
        });
        return text;
      });

    new Setting(containerEl)
      .setName('Branch')
      .setDesc('Zielbranch. Wird beim ersten Sichern angelegt, falls er fehlt.')
      .addText((text) =>
        text.setValue(github.branch).onChange(async (value) => {
          github.branch = value.trim() || 'main';
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Unterordner im Repository')
      .setDesc('Leer lassen, um den Vault in die Wurzel zu legen (z. B. vault für einen Unterordner).')
      .addText((text) =>
        text.setValue(github.pathPrefix).onChange(async (value) => {
          github.pathPrefix = value.trim();
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Nur Markdown-Notizen sichern')
      .setDesc('Empfohlen. Aus = alle Dateien inkl. Anhänge (kann groß werden).')
      .addToggle((toggle) =>
        toggle.setValue(github.onlyMarkdown ?? true).onChange(async (value) => {
          github.onlyMarkdown = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Zusätzliche Ausschlüsse')
      .setDesc('Eine Zeile pro Muster (Ordner oder Dateiname, z. B. .git, Anhänge, workspace.json).')
      .addTextArea((area) => {
        area.setValue(github.exclude.join('\n')).onChange(async (value) => {
          github.exclude = value.split('\n').map((line) => line.trim()).filter(Boolean);
          await this.save();
        });
        area.inputEl.rows = 3;
        return area;
      });

    new Setting(containerEl)
      .setName('Automatisch sichern (Minuten)')
      .setDesc('0 = aus. Sinnvoll: 30 bis 120 Minuten. Es wird nur übertragen, was sich geändert hat.')
      .addText((text) =>
        text.setValue(String(github.autoBackupMinutes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          github.autoBackupMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Nach Änderungen sichern')
      .setDesc('Sammelt Änderungen und sichert sie gebündelt (mindestens 5 Minuten Abstand).')
      .addToggle((toggle) =>
        toggle.setValue(github.backupOnChange).onChange(async (value) => {
          github.backupOnChange = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Beim Start prüfen, ob GitHub neuer ist')
      .setDesc('Meldet sich nach dem Start, wenn auf GitHub neuere Commits liegen (z. B. vom zweiten Rechner). Es wird nichts automatisch überschrieben.')
      .addToggle((toggle) =>
        toggle.setValue(github.checkRemoteOnStart ?? false).onChange(async (value) => {
          github.checkRemoteOnStart = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Beim Wiederherstellen lokale Dateien löschen')
      .setDesc('Nur einschalten, wenn der Vault exakt dem Repository entsprechen soll. Standard: aus.')
      .addToggle((toggle) =>
        toggle.setValue(github.mirrorDelete).onChange(async (value) => {
          github.mirrorDelete = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Aktionen')
      .setDesc(
        github.lastBackupAt
          ? `Letzte Sicherung: ${github.lastBackupAt}${github.lastCommitSha ? ` (Commit ${github.lastCommitSha.slice(0, 7)})` : ''}`
          : 'Noch keine Sicherung durchgeführt.',
      )
      .addButton((button) =>
        button.setButtonText('Verbindung testen').onClick(async () => {
          const result = await this.host.githubTest();
          new Notice(result, 12000);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Jetzt sichern')
          .setCta()
          .onClick(async () => {
            await this.host.githubBackup();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Wiederherstellen …').onClick(async () => {
          await this.host.githubRestore();
        }),
      );
  }

  // --------------------------------------------------------- Verhalten

  private renderBehaviour(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Verhalten' });
    const settings = this.host.settings;

    new Setting(containerEl)
      .setName('Sprache der Antworten')
      .setDesc('Standard: Deutsch')
      .addText((text) =>
        text.setValue(settings.answerLanguage).onChange(async (value) => {
          settings.answerLanguage = value.trim() || 'Deutsch';
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Zusätzliche Anweisungen an Jarvis')
      .setDesc('Gilt für jede Anfrage, z. B. "Antworte knapp. Keine Aufzählungen in der Einleitung." oder "Immer mit Quellenangabe."')
      .addTextArea((area) => {
        area.setValue(settings.customInstructions).onChange(async (value) => {
          settings.customInstructions = value;
          await this.save();
        });
        area.inputEl.rows = 4;
        return area;
      });

    new Setting(containerEl)
      .setName('Quellenangaben anzeigen')
      .setDesc('Zeigt unter der Antwort die benutzten Notizen als anklickbare Verweise.')
      .addToggle((toggle) =>
        toggle.setValue(settings.ui.showSources).onChange(async (value) => {
          settings.ui.showSources = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Zielordner für neue Notizen')
      .setDesc('Antworten, die du als neue Notiz speicherst, landen hier.')
      .addText((text) =>
        text.setValue(settings.ui.outputFolder ?? '').onChange(async (value) => {
          settings.ui.outputFolder = value.trim();
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Antworten live mitschreiben (Streaming)')
      .setDesc(
        'Normalerweise tippt die Antwort mit. Kann ein Dienst nicht direkt angefragt werden ' +
          '(z. B. Ollama ohne OLLAMA_ORIGINS), holt Jarvis die Antwort automatisch am Stück — das funktioniert immer. ' +
          'Ausschalten, wenn du grundsätzlich die fertige Antwort sehen willst.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.ui.stream).onChange(async (value) => {
          settings.ui.stream = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Kostenschätzung anzeigen')
      .setDesc('Zeigt bei Cloud-Antworten eine grobe Preisschätzung (ohne Gewähr).')
      .addToggle((toggle) =>
        toggle.setValue(settings.ui.showCost).onChange(async (value) => {
          settings.ui.showCost = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Verlaufslänge')
      .setDesc('Wie viele vorherige Nachrichten als Gesprächskontext mitgeschickt werden.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 20, 1)
          .setValue(settings.ui.historyLimit)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.ui.historyLimit = value;
            await this.save();
          }),
      );
  }

  // --------------------------------------------------------- Diagnose

  private renderDiagnose(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Diagnose' });
    const stats = this.host.indexStats();
    const info = containerEl.createEl('p', { cls: 'setting-item-description' });
    info.setText(
      `Index: ${stats.files} Notizen, ${stats.chunks} Abschnitte, ${stats.embedded} mit Vektoren` +
        `${stats.embeddingModel ? ` (${stats.embeddingModel})` : ' (kein Embedding-Modell aktiv)'}.`,
    );

    new Setting(containerEl)
      .setName('Alle Verbindungen prüfen')
      .setDesc('Testet Ollama und alle aktivierten Cloud-Anbieter inklusive GitHub.')
      .addButton((button) =>
        button.setButtonText('Jetzt prüfen').onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Prüfe …');
          try {
            const lines = await this.host.testEverything();
            this.showReport(lines, 'Jarvis-Diagnose');
          } finally {
            button.setDisabled(false);
            button.setButtonText('Jetzt prüfen');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Anbieter-Reihenfolge')
      .setDesc(Object.entries(CLOUD_ORDER_LABELS).map(([id, label]) => `${id} = ${label}`).join(' · '));

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Hinweis zu langen lokalen Antworten: Beim ersten Mal lädt Ollama das Modell in den Speicher. ' +
        'Das dauert je nach Rechner und Modellgröße. Spätere Fragen sind deutlich schneller, solange das Modell geladen bleibt.',
    });
  }

  private showReport(lines: string[], title: string): void {
    new ReportModal(this.app, title, lines).open();
  }
}

/** Fenster für längere Textberichte (Diagnose, Diff-Vorschau). */
export class ReportModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private lines: string[],
    private onConfirm?: () => void | Promise<void>,
    private confirmLabel?: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('jarvis-modal');
    contentEl.createEl('h3', { text: this.title });
    const pre = contentEl.createEl('pre', { cls: 'jarvis-report' });
    pre.setText(this.lines.join('\n'));

    const buttons = contentEl.createDiv({ cls: 'jarvis-modal-buttons' });
    if (this.onConfirm) {
      const confirm = buttons.createEl('button', { cls: 'mod-cta', text: this.confirmLabel ?? 'Ausführen' });
      confirm.onclick = async () => {
        this.close();
        await this.onConfirm?.();
      };
    }
    const close = buttons.createEl('button', { text: 'Schließen' });
    close.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
