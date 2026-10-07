/**
 * Internet: Suche, Seiten lesen, HTML in Text verwandeln.
 *
 * Suchdienste: Tavily, Brave, SearXNG (eigene Instanz) und DuckDuckGo (ohne
 * Schlüssel). Alle Anfragen laufen über den Obsidian-Zugriff (kein CORS-Problem).
 */
import { requestUrl } from 'obsidian';
import { userAgentString } from '../util/http';

export type SearchProvider = 'tavily' | 'brave' | 'searxng' | 'duckduckgo';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebDeps {
  /** Ausgelagerte HTTP-Anfrage (für Tests ersetzbar). */
  fetchText(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ status: number; text: string }>;
}

export interface SearchOptions {
  provider: SearchProvider;
  apiKey: string;
  baseUrl: string;
  /** Ergebnisse, die das Modell bekommt. */
  maxResults: number;
  signal?: AbortSignal;
  language?: string;
}

/** Tavily-Adresse: fehlender Pfad wird zu /search ergänzt (eigene Instanzen bleiben gültig). */
export function tavilyUrl(baseUrl: string): string {
  const basis = (baseUrl || 'https://api.tavily.com').replace(/\/+$/, '');
  if (!basis) return 'https://api.tavily.com/search';
  try {
    const geparst = new URL(basis);
    if (!geparst.pathname || geparst.pathname === '/' || geparst.pathname === '') {
      geparst.pathname = '/search';
    }
    return geparst.toString().replace(/\/$/, '');
  } catch {
    return 'https://api.tavily.com/search';
  }
}

/** Standard-Zugriff über Obsidian (umgeht CORS, nutzt die System-Zertifikate). */
export function obsidianFetch(): WebDeps['fetchText'] {
  return async (options) => {
    const antwort = await requestUrl({
      url: options.url,
      method: options.method ?? 'GET',
      headers: {
        'user-agent': userAgentString('jarvis-ai'),
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(options.headers ?? {}),
      },
      body: options.body,
      throw: false,
    });
    return { status: antwort.status, text: antwort.text };
  };
}

/** Suche im Internet. Gibt Treffer zurück oder wirft eine verständliche Meldung. */
export async function webSearch(query: string, options: SearchOptions, deps: WebDeps): Promise<WebSearchHit[]> {
  const suche = query.trim();
  if (!suche) throw new Error('Die Suche braucht einen Suchbegriff.');
  const grenze = Math.min(10, Math.max(1, options.maxResults));

  if (options.provider === 'tavily') {
    if (!options.apiKey.trim()) throw new Error('Für Tavily fehlt der API-Schlüssel (Einstellungen → Werkzeuge).');
    const antwort = await deps.fetchText({
      url: tavilyUrl(options.baseUrl),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: options.apiKey.trim(),
        query: suche,
        max_results: grenze,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: options.signal,
      timeoutMs: 30_000,
    });
    if (antwort.status >= 400) throw new Error(`Tavily antwortete mit HTTP ${antwort.status}: ${antwort.text.slice(0, 200)}`);
    const daten = JSON.parse(antwort.text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (daten.results ?? []).slice(0, grenze).map((treffer) => ({
      title: (treffer.title ?? '').trim() || treffer.url || '(ohne Titel)',
      url: treffer.url ?? '',
      snippet: (treffer.content ?? '').replace(/\s+/g, ' ').trim(),
    }));
  }

  if (options.provider === 'brave') {
    if (!options.apiKey.trim()) throw new Error('Für Brave fehlt der API-Schlüssel (Einstellungen → Werkzeuge).');
    const url = `${(options.baseUrl || 'https://api.search.brave.com').replace(/\/$/, '')}/res/v1/web/search?q=${encodeURIComponent(
      suche,
    )}&count=${grenze}`;
    const antwort = await deps.fetchText({
      url,
      headers: { accept: 'application/json', 'x-subscription-token': options.apiKey.trim() },
      signal: options.signal,
      timeoutMs: 30_000,
    });
    if (antwort.status >= 400) throw new Error(`Brave antwortete mit HTTP ${antwort.status}: ${antwort.text.slice(0, 200)}`);
    const daten = JSON.parse(antwort.text) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (daten.web?.results ?? []).slice(0, grenze).map((treffer) => ({
      title: (treffer.title ?? '').trim() || treffer.url || '(ohne Titel)',
      url: treffer.url ?? '',
      snippet: (treffer.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));
  }

  if (options.provider === 'searxng') {
    if (!options.baseUrl.trim()) throw new Error('Für SearXNG fehlt die Adresse deiner Instanz (Einstellungen → Werkzeuge).');
    const url = `${options.baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(suche)}&format=json&safesearch=1${
      options.language ? `&language=${encodeURIComponent(options.language)}` : ''
    }`;
    const antwort = await deps.fetchText({
      url,
      headers: options.apiKey.trim() ? { authorization: `Bearer ${options.apiKey.trim()}` } : undefined,
      signal: options.signal,
      timeoutMs: 30_000,
    });
    if (antwort.status >= 400) {
      throw new Error(
        `SearXNG antwortete mit HTTP ${antwort.status}. Meist ist die JSON-Ausgabe abgeschaltet (settings.yml: search.formats: [html, json]).`,
      );
    }
    const daten = JSON.parse(antwort.text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (daten.results ?? []).slice(0, grenze).map((treffer) => ({
      title: (treffer.title ?? '').trim() || treffer.url || '(ohne Titel)',
      url: treffer.url ?? '',
      snippet: (treffer.content ?? '').replace(/\s+/g, ' ').trim(),
    }));
  }

  // DuckDuckGo: ohne Schlüssel, über die HTML-Seite
  const antwort = await deps.fetchText({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(suche)}`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(suche)}`,
    signal: options.signal,
    timeoutMs: 30_000,
  });
  if (antwort.status >= 400) {
    throw new Error(
      `DuckDuckGo antwortete mit HTTP ${antwort.status}. Ohne Schlüssel ist die Suche nicht immer erreichbar — Tavily, Brave oder eine eigene SearXNG-Instanz sind zuverlässiger.`,
    );
  }
  return parseDuckDuckGo(antwort.text).slice(0, grenze);
}

/** Treffer aus der DuckDuckGo-HTML-Seite lesen. */
export function parseDuckDuckGo(html: string): WebSearchHit[] {
  const treffer: WebSearchHit[] = [];
  const bloecke = html.split(/<div[^>]+class="[^"]*result__body/).slice(1);
  for (const block of bloecke) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    treffer.push({
      title: decodeEntities(link[2].replace(/<[^>]+>/g, '')).trim(),
      url: unwrapDuckDuckGoUrl(decodeEntities(link[1])),
      snippet: decodeEntities((snippet?.[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    });
  }
  return treffer;
}

/** DuckDuckGo verpackt Ziele in /l/?uddg=… — wieder auspacken. */
export function unwrapDuckDuckGoUrl(url: string): string {
  const treffer = /[?&]uddg=([^&]+)/.exec(url);
  if (treffer) {
    try {
      return decodeURIComponent(treffer[1]);
    } catch {
      return url;
    }
  }
  return url.startsWith('//') ? `https:${url}` : url;
}

/** Eine Seite laden und als Text zurückgeben. */
export async function webFetch(
  url: string,
  options: { maxChars: number; signal?: AbortSignal },
  deps: WebDeps,
): Promise<{ title: string; url: string; text: string; truncated: boolean; contentType: string }> {
  let ziel = url.trim();
  if (!ziel) throw new Error('Es fehlt die Adresse (url).');
  const schema = /^([a-z][a-z0-9+.-]*):/i.exec(ziel);
  if (schema && !/^https?$/i.test(schema[1])) {
    throw new Error(`Es werden nur http- und https-Adressen gelesen (angegeben: ${schema[1]}).`);
  }
  if (!/^https?:\/\//i.test(ziel)) ziel = `https://${ziel}`;
  let geparst: URL;
  try {
    geparst = new URL(ziel);
  } catch {
    throw new Error(`Das ist keine gültige Internetadresse: ${url}`);
  }
  if (!['http:', 'https:'].includes(geparst.protocol)) throw new Error('Es werden nur http- und https-Adressen gelesen.');

  const antwort = await deps.fetchText({ url: geparst.toString(), signal: options.signal, timeoutMs: 30_000 });
  if (antwort.status >= 400) {
    throw new Error(`Die Seite antwortete mit HTTP ${antwort.status}. Manche Seiten sperren automatische Zugriffe.`);
  }
  const inhalt = antwort.text ?? '';
  const istHtml = /^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<html)/i.test(inhalt) || /<body[\s>]/i.test(inhalt.slice(0, 4000));
  const title = istHtml ? (extractTitle(inhalt) || geparst.hostname) : geparst.hostname;
  const text = istHtml ? htmlToText(inhalt) : inhalt;
  const sauber = text.replace(/\n{3,}/g, '\n\n').trim();
  const grenze = Math.max(200, options.maxChars);
  return {
    title,
    url: geparst.toString(),
    text: sauber.length > grenze ? `${sauber.slice(0, grenze)}\n\n[… gekürzt, die Seite war länger]` : sauber,
    truncated: sauber.length > grenze,
    contentType: istHtml ? 'text/html' : 'text/plain',
  };
}

export function extractTitle(html: string): string {
  const treffer = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return treffer ? decodeEntities(treffer[1].replace(/\s+/g, ' ')).trim().slice(0, 200) : '';
}

/**
 * HTML in lesbaren Text verwandeln (Überschriften, Listen, Links, Absätze).
 * Bewusst ohne Fremdbibliothek, damit das Plug-in klein bleibt.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|canvas|template|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_treffer, href: string, label: string) => {
    const beschriftung = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!beschriftung) return '';
    const ziel = decodeEntities(href).trim();
    if (!/^https?:/i.test(ziel)) return beschriftung;
    return `[${beschriftung}](${ziel})`;
  });
  text = text
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_t, stufe: string, inhalt: string) => {
      const sauber = inhalt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return sauber ? `\n\n${'#'.repeat(Number(stufe))} ${sauber}\n\n` : '\n\n';
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_t, inhalt: string) => {
      const sauber = inhalt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return sauber ? `\n- ${sauber}` : '';
    })
    .replace(/<(p|div|section|article|tr|br|table)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|h[1-6])>/gi, '\n')
    // Übrige Auszeichnungen (fett, kursiv, Code …) verschwinden ohne Leerzeichen,
    // damit "mit <b>Fett</b>." zu "mit Fett." wird.
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((zeile) => zeile.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  euro: '€',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_t, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_t, dezimal: string) => safeChar(Number.parseInt(dezimal, 10)))
    .replace(/&([a-z]+);/gi, (treffer, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? treffer);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Treffer für das Modell aufbereiten. */
export function renderHits(query: string, hits: WebSearchHit[]): string {
  if (!hits.length) return `Suche "${query}": keine Treffer. Andere Suchbegriffe versuchen oder eine Seite direkt laden.`;
  const zeilen = hits.map(
    (treffer, index) => `[${index + 1}] ${treffer.title}\n    ${treffer.url}\n    ${truncateText(treffer.snippet, 500)}`,
  );
  return `Suchergebnisse für "${query}" (${hits.length}):\n${zeilen.join('\n')}`;
}

function truncateText(text: string, grenze: number): string {
  return text.length > grenze ? `${text.slice(0, grenze)}…` : text;
}
