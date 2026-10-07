/** Gemeinsame Typen für das Jarvis-AI-Plugin. */
import type { LearningSettings } from './learn/types';

export type CloudKind = 'openai' | 'anthropic' | 'gemini';

export type CloudProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'huggingface'
  | 'n8n'
  | 'custom';

export type ProviderId = 'ollama' | CloudProviderId;

/**
 * Wie soll Jarvis antworten?
 *
 *  - `local`  : nur Ollama auf diesem Rechner (privat, offline möglich)
 *  - `cloud`  : die stärksten Cloud-Modelle
 *  - `auto`   : lokal zuerst, bei Schwäche automatisch in die Cloud (und Lernen)
 *  - `max`    : Cloud-Spitzenmodelle, schwere Fragen über mehrere Modelle abstimmen
 *  - `oracle` : „Orakel" — erst antworten, dann von mehreren Top-Modellen prüfen
 *               lassen und aus den Einwänden die beste Endfassung bauen
 */
export type RouteMode = 'local' | 'cloud' | 'auto' | 'max' | 'oracle';

/** Ein einzelner Chat-Baustein. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  /** Modell-ID, wie sie an die API gesendet wird. */
  id: string;
  /** Für die Anzeige. */
  label: string;
  providerId: ProviderId;
  /** true = läuft auf dem eigenen Rechner, false = Cloud. */
  local: boolean;
  /** Kurze Einordnung, z. B. "Top-Leistung" oder "klein & schnell". */
  note?: string;
  /** Ungefähre Kontextgröße in Token, falls bekannt. */
  contextTokens?: number;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatResult {
  text: string;
  providerId: ProviderId;
  model: string;
  usage?: ChatUsage;
  /** true, wenn der Nutzer abgebrochen hat. */
  aborted?: boolean;
  /** true, wenn die Antwort über die Nicht-Streaming-Ersatzroute kam. */
  buffered?: boolean;
  durationMs: number;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  onDelta?: (chunk: string) => void;
  /** Wird aufgerufen, wenn sichtbarer Text (nicht "Denken") ankommt. */
  signal?: AbortSignal;
  /** false = Antwort am Stück statt im Stream (Standard: true). */
  allowStream?: boolean;
  /** Zusätzliche Felder für die Anfrage (z. B. Reasoning-Stärke, Top-P). */
  extraParams?: Record<string, unknown>;
}

export interface CloudProviderSettings {
  /** Vom Nutzer aktiviert? */
  enabled: boolean;
  /**
   * Wie stark das Modell nachdenken soll.
   * 'off' = nichts senden (Standard, immer sicher).
   * Die anderen Stufen senden die jeweils üblichen Felder; kann eine Schnittstelle
   * das Feld nicht, wird die Anfrage automatisch ohne dieses Feld wiederholt.
   */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  kind: CloudKind;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** Eigene Modellliste (leer = automatisch von der API holen). */
  models: string[];
  /** Temperatur senden? Standard: nicht senden (Top-Modelle haben eigene Vorgaben). */
  temperature: number;
  /** 0 = kein Limit senden. */
  maxTokens: number;
}

export interface LocalSettings {
  baseUrl: string;
  defaultModel: string;
  embedModel: string;
  useEmbeddings: boolean;
  numCtx: number;
  temperature: number;
  /** Wie lange soll das Modell im RAM bleiben? (Ollama keep_alive) */
  keepAlive: string;
  /** Bevorzugte lokale Modelle, wenn mehrere installiert sind (Reihenfolge = Priorität). */
  preferred: string[];
}

export interface RagSettings {
  enabled: boolean;
  topK: number;
  /** Wie viel Text der Quellen maximal in den Prompt geht (Zeichen). */
  contextChars: number;
  maxNoteBytes: number;
  /** Ordner, die nie durchsucht werden. */
  excludeFolders: string[];
  /** Wenn die Frage zur aktuell geöffneten Notiz gehört, diese immer mitnehmen. */
  includeActiveNote: boolean;
  /** Zwei Durchgänge: Entwurf + Prüfung. Nur für schwere Aufgaben. */
  deepMode: boolean;
}

export interface GithubSettings {
  enabled: boolean;
  owner: string;
  repo: string;
  branch: string;
  /** Unterordner im Repo. Leer = Wurzel. */
  pathPrefix: string;
  /** Dateiendungen/Ordner, die ausgeschlossen sind. */
  exclude: string[];
  /** Automatisches Backup-Intervall in Minuten (0 = aus). */
  autoBackupMinutes: number;
  /** Beim Speichern einer Notiz backupen (gebündelt). */
  backupOnChange: boolean;
  /** Beim Wiederherstellen lokale Dateien löschen, die im Repo fehlen. */
  mirrorDelete: boolean;
  /** Nur Markdown-Notizen sichern (Anhänge auslassen). */
  onlyMarkdown: boolean;
  /** Letzter erfolgreicher Commit (nur Info). */
  lastCommitSha: string;
  /** Anzeigetext, z. B. "07.10.2026, 18:45". */
  lastBackupAt: string;
  /** Maschinenlesbarer Zeitpunkt der letzten Sicherung (ISO). */
  lastBackupIso: string;
}

export interface UiSettings {
  showSources: boolean;
  /** Zielordner für neue Notizen aus Antworten. */
  outputFolder: string;
  /** Antworten standardmäßig streamen. */
  stream: boolean;
  /** Wie viele Nachrichten der Verlauf behält. */
  historyLimit: number;
  /** Kostenhinweis anzeigen. */
  showCost: boolean;
}

/** Suche im Internet: welcher Dienst benutzt wird. */
export type SearchProviderId = 'duckduckgo' | 'tavily' | 'brave' | 'searxng';

/** Ein MCP-Server (fremde Werkzeuge, die Jarvis benutzen darf). */
export interface McpServerSettings {
  name: string;
  enabled: boolean;
  transport: 'http' | 'stdio';
  url: string;
  command: string;
  args: string[];
  headers: Record<string, string>;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/** Werkzeuge: was Jarvis zusätzlich zum Antworten darf. */
export interface ToolsSettings {
  /** Hauptschalter. */
  enabled: boolean;
  /** Wann Werkzeuge benutzt werden: nie, bei Bedarf oder immer. */
  mode: 'off' | 'auto' | 'always';
  /** Wie gründlich gearbeitet wird. */
  effort: 'normal' | 'max';
  /** Höchstzahl Werkzeugrunden (Schutz vor Endlosschleifen). */
  maxSteps: number;
  /** Zugriff auf das Internet (Suchen, Seiten lesen). */
  allowInternet: boolean;
  searchProvider: SearchProviderId;
  searchApiKey: string;
  searchBaseUrl: string;
  /** Notizen anlegen oder ändern. */
  allowVaultWrite: boolean;
  /** Befehle auf dem Rechner ausführen (nur Desktop). */
  allowShell: boolean;
  /** Dateien außerhalb des Vaults lesen/schreiben (nur Desktop). */
  allowFiles: boolean;
  /** Fremde MCP-Werkzeuge benutzen. */
  allowMcp: boolean;
  /** Dateien im verbundenen GitHub-Repository schreiben (Commits). */
  allowGithubWrite: boolean;
  /** Eigene Adressen für Dienste (leer = Standard). */
  githubApiBase: string;
  hfBaseUrl: string;
  /** n8n-Webhook, den Jarvis auslösen darf. */
  n8nWebhookUrl: string;
  mcpServers: McpServerSettings[];
  commandTimeoutSeconds: number;
  /** Zusätzlich gesperrte Befehlsbausteine. */
  shellBlocklist: string[];
  /** Schritte unter der Antwort anzeigen. */
  showSteps: boolean;
}

export interface JarvisSettings {
  routeMode: RouteMode;
  /** Bei auto: lokal antworten, aber bei Bedarf automatisch auf Cloud ausweichen. */
  autoEscalate: boolean;
  /** Bei auto: welche Cloud (Prioritätsreihenfolge). */
  autoOrder: CloudProviderId[];
  local: LocalSettings;
  cloud: Record<CloudProviderId, CloudProviderSettings>;
  rag: RagSettings;
  learning: LearningSettings;
  tools: ToolsSettings;
  github: GithubSettings;
  ui: UiSettings;
  /** Zusätzliche Anweisungen vom Nutzer an das Modell. */
  customInstructions: string;
  /** Sprache der Antworten. */
  answerLanguage: string;
}
