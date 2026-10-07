/**
 * Werkzeuge (Tools): alles, was Jarvis zusätzlich zu seinem Wissen tun kann —
 * im Internet suchen, Seiten lesen, Notizen lesen/schreiben, rechnen, Befehle
 * ausführen, fremde MCP-Werkzeuge benutzen.
 *
 * Wichtig: Jarvis benutzt Werkzeuge nur, wenn der Nutzer sie in den
 * Einstellungen freigeschaltet hat. Schreibende und ausführende Werkzeuge sind
 * standardmäßig aus.
 */
import type { JarvisSettings } from '../types';
import type { VaultIndex } from '../rag/vault-index';

/** Zugriff auf den Vault, den die Werkzeuge benutzen dürfen. */
export interface ToolVault {
  /** Notizinhalt lesen (null, wenn es sie nicht gibt). */
  read(path: string): Promise<string | null>;
  /** Gibt es die Datei? */
  exists(path: string): Promise<boolean>;
  /** Datei anlegen (Ordner werden erstellt). */
  create(path: string, content: string): Promise<void>;
  /** An eine Datei anhängen (legt sie an, falls nötig). */
  append(path: string, content: string): Promise<void>;
  /** Datei überschreiben. */
  overwrite(path: string, content: string): Promise<void>;
  /** Alle Markdown-Pfade im Vault. */
  listMarkdown(): Promise<string[]>;
  /** Absoluter Pfad des Vaults (nur Desktop), sonst leer. */
  vaultPath(): string;
  /** Vault-Name für Anzeigen. */
  name(): string;
}

export interface ToolContext {
  settings: () => JarvisSettings;
  index: VaultIndex;
  vault: ToolVault;
  pluginVersion: string;
  /** Für die Anzeige im Chat: was Jarvis gerade tut. */
  note?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ToolParameter {
  name: string;
  description: string;
  required?: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  /** Ergebnistext, der dem Modell zurückgegeben wird. */
  text: string;
  /** Kurzinfo für die Anzeige, z. B. "5 Treffer". */
  summary?: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Wie das Modell den Aufruf geschrieben hat (für die Anzeige). */
  raw?: string;
}

export interface ToolSpec {
  name: string;
  /** Ein Satz für die Modell-Anweisung. */
  summary: string;
  params: ToolParameter[];
  /** Gefährliche Werkzeuge brauchen eine ausdrückliche Freigabe. */
  danger?: 'write' | 'shell';
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Aus einem Argument einen Text holen (verträgt Zahlen und fehlende Werte). */
export function argText(args: Record<string, unknown>, name: string): string {
  const wert = args[name];
  if (wert === undefined || wert === null) return '';
  if (typeof wert === 'string') return wert.trim();
  if (typeof wert === 'number' || typeof wert === 'boolean') return String(wert);
  if (Array.isArray(wert)) return wert.map((item) => String(item)).join(', ');
  return JSON.stringify(wert);
}

/** Aus einem Argument eine Zahl holen (mit Grenzen). */
export function argNumber(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const wert = args[name];
  const zahl = typeof wert === 'number' ? wert : Number.parseFloat(String(wert ?? ''));
  if (!Number.isFinite(zahl)) return fallback;
  return Math.min(max, Math.max(min, zahl));
}

/** Pfad sicher machen: nie aus dem Vault heraus, nie in den Plugin-Ordner. */
export function safeVaultPath(path: string, configDir = '.obsidian'): string {
  let sauber = path.replace(/\\/g, '/').trim();
  sauber = sauber.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const teile = sauber
    .split('/')
    .filter((teil) => teil && teil !== '.' && teil !== '..')
    .map((teil) => teil.replace(/[\\:*?"<>|]/g, '-'));
  sauber = teile.join('/');
  const verboten = ['configdir', 'trash', 'git'];
  if (teile.some((teil) => teil.toLowerCase() === configDir.replace(/^\./, ''))) return '';
  if (teile.some((teil) => verboten.includes(teil.toLowerCase()))) return '';
  if (teile.some((teil) => teil.toLowerCase() === '.obsidian')) return '';
  return sauber;
}
