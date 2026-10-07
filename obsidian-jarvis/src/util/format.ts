/** Kleine Helfer für Anzeige, Token-Schätzung und Kostenhinweise. */

/** Grobe Token-Schätzung. Deutsch braucht etwas mehr Zeichen pro Token als Englisch. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.6));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestamp(iso: string | number | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

/** Preise pro 1 Mio. Token (USD). Nur für einen groben Kostenhinweis. */
interface Price {
  input: number;
  output: number;
  label: string;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, label: 'Claude Opus 5.5' },
  'claude-opus-5': { input: 5, output: 25, label: 'Claude Opus 5' },
  'claude-sonnet-5-5': { input: 2, output: 10, label: 'Claude Sonnet 5.5' },
  'claude-sonnet-5': { input: 2, output: 10, label: 'Claude Sonnet 5' },
  'claude-fable-5-1': { input: 10, output: 50, label: 'Claude Fable 5.1' },
  'claude-fable-5': { input: 10, output: 50, label: 'Claude Fable 5' },
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Claude Haiku 4.5' },
  'gpt-6-astra': { input: 10, output: 50, label: 'GPT-6 Astra' },
  'gpt-6.1-sol': { input: 2, output: 10, label: 'GPT-6.1 Sol' },
  'gpt-6-sol': { input: 2, output: 10, label: 'GPT-6 Sol' },
  'gpt-6-luna': { input: 0.1, output: 0.5, label: 'GPT-6 Luna' },
  'gpt-5.6-sol': { input: 4, output: 20, label: 'GPT-5.6 Sol' },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, label: 'Gemini 3.8 Flash' },
  'gemini-3.6-flash': { input: 1.5, output: 7.5, label: 'Gemini 3.6 Flash' },
  'gemini-3.1-pro': { input: 2, output: 12, label: 'Gemini 3.1 Pro' },
  'grok-4.5': { input: 2, output: 6, label: 'Grok 4.5' },
};

export function lookupPrice(modelId: string): Price | undefined {
  const clean = modelId.includes('/') ? modelId.split('/').pop() ?? modelId : modelId;
  if (PRICES[clean]) return PRICES[clean];
  const base = clean.replace(/-latest$/, '').replace(/:.*$/, '');
  return PRICES[base];
}

/** Grobe Kostenschätzung in US-Dollar. Gibt undefined zurück, wenn kein Preis bekannt ist. */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = lookupPrice(modelId);
  if (!price) return undefined;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '';
  if (usd < 0.0001) return '< 0,01 Cent';
  if (usd < 0.01) return `${(usd * 100).toFixed(2)} Cent`;
  return `${usd.toFixed(usd < 1 ? 3 : 2).replace('.', ',')} $`;
}

/** Markdown-Sonderzeichen für einfache Titel entfernen. */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#[\]^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Jarvis Notiz'
  );
}

/** Antworttext für die Ausgabe in Markdown entschärfen (keine Bild-Einbettung, kein HTML). */
export function sanitizeModelOutput(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/!\[\[/g, '\\[\\[')
    .replace(/!\[/g, '\\[')
    .replace(/<script/gi, '&lt;script')
    .replace(/<iframe/gi, '&lt;iframe');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Wörter für die Stichwortsuche normalisieren. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss');
}
