/**
 * HTTP-Schicht.
 *
 * Warum zwei Wege?
 * - `fetch()` kann streamen (Antwort Wort für Wort), unterliegt aber der
 *   CORS-Regel des Browsers/Electron. Manche Dienste (lokales Ollama ohne
 *   OLLAMA_ORIGINS, die OpenAI-API direkt) blocken das.
 * - Obsidians `requestUrl()` umgeht CORS vollständig, kann aber nicht streamen.
 *
 * Deshalb: erst Stream versuchen, bei Netz-/CORS-Fehler automatisch auf
 * `requestUrl` umschalten und die Antwort als Ganzes anzeigen.
 */
import { requestUrl } from 'obsidian';

export interface HttpErrorDetails {
  status: number;
  message: string;
  body: string;
  url: string;
}

export class HttpError extends Error {
  status: number;
  body: string;
  url: string;

  constructor(details: HttpErrorDetails) {
    super(details.message);
    this.name = 'HttpError';
    this.status = details.status;
    this.body = details.body;
    this.url = details.url;
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

export interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Anzahl Wiederholungen bei 429/5xx. Standard 2. */
  retries?: number;
}

export interface StreamResult {
  status: number;
  /** Nur gefüllt, wenn nicht gestreamt werden konnte. */
  text: string;
  /** true, wenn wirklich per SSE gestreamt wurde. */
  streamed: boolean;
  headers: Record<string, string>;
}

/** Läuft der Code in echten Tests (Node) statt in Obsidian? */
const hasObsidianRequestUrl = typeof requestUrl === 'function';

export function userAgentString(pluginVersion: string): string {
  return `JarvisAI-Obsidian/${pluginVersion}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name;
  const message = String((error as { message?: string })?.message ?? error);
  return name === 'AbortError' || /abort/i.test(message);
}

/** Fehler, der einen Wechsel von fetch auf requestUrl rechtfertigt. */
function isTransportFailure(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error);
  const name = (error as { name?: string }).name;
  return (
    name === 'TypeError' ||
    /failed to fetch|load failed|network|networkerror|connection refused|err_connection|fetch failed|cors/i.test(message)
  );
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Einfache Anfrage ohne Streaming über Obsidians requestUrl (CORS-frei). */
export async function requestBuffered(options: RequestOptions): Promise<{
  status: number;
  text: string;
  headers: Record<string, string>;
}> {
  const response = await requestUrl({
    url: options.url,
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    throw: false,
    contentType: undefined,
  });
  return {
    status: response.status,
    text: typeof response.text === 'string' ? response.text : JSON.stringify(response.json ?? {}),
    headers: (response.headers ?? {}) as Record<string, string>,
  };
}

/** Rohdaten per fetch holen (Streaming oder Volltext). */
async function rawFetch(options: RequestOptions, timeoutMs: number) {
  const { signal, cleanup } = combineSignals(options.signal, timeoutMs);
  try {
    const init = {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal,
      cache: 'no-store',
      mode: 'cors',
    } as RequestInit;
    const response = await fetch(options.url, init);
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** SSE-Zeilen aus einem Datenstrom lesen. */
export async function* sseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
      index = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  const rest = parseSseBlock(buffer);
  if (rest) yield rest;
}

function parseSseBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!dataLines.length && !event) return null;
  return { event, data: dataLines.join('\n') };
}

/** NDJSON-Zeilen (Ollama) aus einem Datenstrom lesen. */
export async function* ndjsonEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield { data: line };
      index = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  const rest = buffer.trim();
  if (rest) yield { data: rest };
}

/**
 * Wenn eine SSE-Antwort als kompletter Text vorliegt (kein Streaming möglich),
 * alle data-Nutzlasten herausziehen.
 */
export function extractSsePayloads(text: string): string[] {
  const payloads: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    payloads.push(data);
  }
  return payloads;
}

export interface StreamOptions extends RequestOptions {
  onEvent?: (event: SseEvent) => void;
  /** false = niemals streamen (z. B. wenn der Nutzer es abgeschaltet hat). */
  allowStream?: boolean;
  /** Datenformat des Streams: SSE (Standard) oder NDJSON (Ollama). */
  streamFormat?: 'sse' | 'ndjson';
}

/**
 * POST/GET mit SSE-Streaming und automatischem Rückfall auf requestUrl.
 * Wirft HttpError bei Statusfehlern.
 */
export async function streamRequest(options: StreamOptions): Promise<StreamResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const allowStream = options.allowStream !== false;
  const retries = options.retries ?? 2;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Abgebrochen');

    // 1) Versuch: echtes Streaming
    if (allowStream && typeof fetch === 'function') {
      try {
        const { response, cleanup } = await rawFetch(options, timeoutMs);
        try {
          const headers = headersToObject(response.headers);
          const contentType = headers['content-type'] ?? '';

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            if (shouldRetry(response.status) && attempt < retries) {
              lastError = new HttpError({
                status: response.status,
                message: `HTTP ${response.status}`,
                body: text,
                url: options.url,
              });
              await sleep(600 * Math.pow(2, attempt));
              break;
            }
            throw new HttpError({
              status: response.status,
              message: `HTTP ${response.status}`,
              body: text,
              url: options.url,
            });
          }

          const isSse = contentType.includes('text/event-stream');
          const isNdjson =
            options.streamFormat === 'ndjson' ||
            contentType.includes('application/x-ndjson') ||
            contentType.includes('application/jsonl');
          if ((isSse || isNdjson) && options.onEvent && response.body) {
            const reader = response.body.getReader();
            const events = isSse && !isNdjson ? sseEvents(reader) : ndjsonEvents(reader);
            for await (const event of events) {
              options.onEvent(event);
            }
            return { status: response.status, text: '', streamed: true, headers };
          }

          const text = await response.text();
          return { status: response.status, text, streamed: false, headers };
        } finally {
          cleanup();
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof HttpError) {
          if (attempt < retries && shouldRetry(error.status)) {
            await sleep(600 * Math.pow(2, attempt));
            continue;
          }
          throw error;
        }
        // Netz-/CORS-Fehler -> unten weiter mit requestUrl
        if (!isTransportFailure(error)) throw error;
        lastError = error;
      }
    }

    // 2) Versuch: requestUrl ohne Streaming (CORS-frei, funktioniert immer)
    if (hasObsidianRequestUrl) {
      try {
        const result = await requestBuffered(options);
        if (!isOk(result.status)) {
          if (shouldRetry(result.status) && attempt < retries) {
            await sleep(600 * Math.pow(2, attempt));
            continue;
          }
          throw new HttpError({
            status: result.status,
            message: `HTTP ${result.status}`,
            body: result.text,
            url: options.url,
          });
        }
        return { status: result.status, text: result.text, streamed: false, headers: result.headers };
      } catch (error) {
        if (isAbortError(error) || error instanceof HttpError) throw error;
        lastError = error;
      }
    } else if (typeof fetch === 'function') {
      // Testumgebung ohne Obsidian-API: reiner fetch als Volltext
      try {
        const { response, cleanup } = await rawFetch(options, timeoutMs);
        try {
          const text = await response.text();
          if (!response.ok) {
            if (shouldRetry(response.status) && attempt < retries) {
              await sleep(300 * Math.pow(2, attempt));
              continue;
            }
            throw new HttpError({
              status: response.status,
              message: `HTTP ${response.status}`,
              body: text,
              url: options.url,
            });
          }
          return { status: response.status, text, streamed: false, headers: headersToObject(response.headers) };
        } finally {
          cleanup();
        }
      } catch (error) {
        if (isAbortError(error) || error instanceof HttpError) throw error;
        lastError = error;
      }
    }

    if (attempt < retries) await sleep(600 * Math.pow(2, attempt));
  }

  throw new HttpError({
    status: 0,
    message:
      'Keine Verbindung. Mögliche Ursachen: Dienst läuft nicht, Internet fehlt, Adresse falsch oder Firewall blockt. ' +
      String((lastError as { message?: string })?.message ?? lastError ?? ''),
    body: '',
    url: options.url,
  });
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

/** POST mit JSON-Antwort (kein Streaming). */
export async function postJson<T>(options: RequestOptions): Promise<{ status: number; json: T; text: string }> {
  const result = await streamRequest({ ...options, method: options.method ?? 'POST', allowStream: false });
  let json: T;
  try {
    json = JSON.parse(result.text) as T;
  } catch {
    throw new HttpError({
      status: result.status,
      message: 'Antwort war kein JSON. Bitte Adresse und Dienst prüfen.',
      body: result.text.slice(0, 400),
      url: options.url,
    });
  }
  return { status: result.status, json, text: result.text };
}

/** GET mit JSON-Antwort. */
export async function getJson<T>(options: RequestOptions): Promise<T> {
  const result = await streamRequest({ ...options, method: 'GET', allowStream: false, retries: 1 });
  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new HttpError({
      status: result.status,
      message: 'Antwort war kein JSON. Bitte Adresse und Dienst prüfen.',
      body: result.text.slice(0, 400),
      url: options.url,
    });
  }
}

export { isAbortError };

/** Fehlermeldungen in verständliches Deutsch übersetzen. */
export function humanizeHttpError(error: unknown, providerLabel: string): string {
  if (error instanceof HttpError) {
    const body = error.body || '';
    let detail = '';
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; type?: string } | string;
        message?: string;
      };
      const err = parsed?.error;
      detail =
        (typeof err === 'string' ? err : err?.message) ??
        parsed?.message ??
        '';
    } catch {
      detail = body.slice(0, 300);
    }
    if (error.status === 401 || error.status === 403) {
      return `${providerLabel}: Zugang abgelehnt (${error.status}). API-Schlüssel prüfen bzw. Zugriff für dieses Modell freischalten. ${detail}`;
    }
    if (error.status === 404) {
      return `${providerLabel}: Modell oder Adresse nicht gefunden (404). Modellnamen prüfen. ${detail}`;
    }
    if (error.status === 429) {
      return `${providerLabel}: Limit erreicht (429). Kurz warten, anderes Modell wählen oder Kontingent prüfen. ${detail}`;
    }
    if (error.status >= 500) {
      return `${providerLabel}: Der Dienst meldet einen Serverfehler (${error.status}). Später erneut versuchen. ${detail}`;
    }
    if (error.status === 0) {
      return `${providerLabel}: ${error.message}`;
    }
    return `${providerLabel}: Fehler ${error.status}. ${detail || error.message}`;
  }
  const message = String((error as { message?: string })?.message ?? error);
  if (/abort/i.test(message)) return 'Abgebrochen.';
  return `${providerLabel}: ${message}`;
}
