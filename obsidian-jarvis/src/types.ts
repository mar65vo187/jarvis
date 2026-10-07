/** Gemeinsame Typen für das Jarvis-AI-Plugin. */
import type { LearningSettings } from './learn/types';

export type CloudKind = 'openai' | 'anthropic' | 'gemini';

export type CloudProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom';

export type ProviderId = 'ollama' | CloudProviderId;

/** Wie soll Jarvis antworten? */
export type RouteMode = 'local' | 'cloud' | 'auto';

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
}

export interface CloudProviderSettings {
  /** Vom Nutzer aktiviert? */
  enabled: boolean;
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
  github: GithubSettings;
  ui: UiSettings;
  /** Zusätzliche Anweisungen vom Nutzer an das Modell. */
  customInstructions: string;
  /** Sprache der Antworten. */
  answerLanguage: string;
}
