/**
 * Werkzeuge für fremde Dienste: GitHub, HuggingFace und n8n.
 *
 * Alle drei laufen über eine einzige HTTP-Funktion, die das Plugin bereitstellt
 * (auf dem Desktop über Obsidians requestUrl — also ohne CORS-Probleme).
 * Lesen ist erlaubt, sobald der Dienst eingerichtet ist; Schreiben nur, wenn der
 * Nutzer es ausdrücklich freigeschaltet hat.
 */
import type { JarvisSettings } from '../types';
import { argNumber, argText, type ToolSpec } from './types';

/** Ein HTTP-Aufruf, wie ihn das Plugin bereitstellt. */
export interface DienstHttp {
  (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text: string; headers: Record<string, string> }>;
}

export interface DienstDeps {
  /** Beliebige HTTP-Anfragen (GitHub, HuggingFace, n8n). */
  http?: DienstHttp;
  /** Zugangsschlüssel lesen (z. B. "github", "huggingface", "n8n"). */
  key?: (id: string) => string;
}

const STANDARD_GITHUB = 'https://api.github.com';
const STANDARD_HF = 'https://huggingface.co';

function kuerzen(text: string, grenze: number): string {
  if (text.length <= grenze) return text;
  return `${text.slice(0, grenze)}\n\n[… gekürzt: ${text.length - grenze} Zeichen]`;
}

function fehlerText(status: number, text: string, was: string): string {
  const sauber = text.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) {
    return `${was} wurde abgelehnt (${status}). Bitte den Zugangsschlüssel in den Jarvis-Einstellungen prüfen. ${sauber}`;
  }
  if (status === 404) return `${was}: nicht gefunden (404). ${sauber}`;
  if (status === 429) return `${was}: zu viele Anfragen (429). Bitte kurz warten. ${sauber}`;
  return `${was} ist fehlgeschlagen (${status}). ${sauber}`;
}

/** JSON lesen, Fehler als lesbaren Text zurückgeben. */
async function holeJson(
  deps: DienstDeps,
  options: { url: string; method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; was: string },
): Promise<{ ok: true; daten: unknown } | { ok: false; text: string }> {
  if (!deps.http) {
    return { ok: false, text: 'Für diesen Dienst fehlt der Netzzugriff (nur auf dem Rechner möglich).' };
  }
  try {
    const antwort = await deps.http({
      url: options.url,
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
    if (antwort.status < 200 || antwort.status >= 300) {
      return { ok: false, text: fehlerText(antwort.status, antwort.text, options.was) };
    }
    if (!antwort.text.trim()) return { ok: true, daten: null };
    try {
      return { ok: true, daten: JSON.parse(antwort.text) as unknown };
    } catch {
      return { ok: false, text: `${options.was}: Die Antwort war kein gültiges JSON.` };
    }
  } catch (error) {
    return { ok: false, text: `${options.was} ist fehlgeschlagen: ${(error as Error).message}` };
  }
}

function githubBasis(settings: JarvisSettings): string {
  const eigen = settings.tools.githubApiBase?.trim();
  return (eigen || STANDARD_GITHUB).replace(/\/+$/, '');
}

function hfBasis(settings: JarvisSettings): string {
  const eigen = settings.tools.hfBaseUrl?.trim();
  return (eigen || STANDARD_HF).replace(/\/+$/, '');
}

function githubKopf(settings: JarvisSettings, deps: DienstDeps): Record<string, string> {
  const token = (deps.key?.('github') ?? '').trim();
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'jarvis-obsidian/1.0',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Liest die Antwort von GitHub, die Base64-kodiert sein kann. */
function githubDateiInhalt(daten: unknown): { text: string; path: string } | null {
  if (!daten || typeof daten !== 'object') return null;
  const datei = daten as { content?: string; encoding?: string; path?: string; download_url?: string };
  const pfad = datei.path ?? '';
  if (!datei.content) return null;
  if ((datei.encoding ?? 'base64') === 'base64') {
    try {
      const roh = datei.content.replace(/\n/g, '');
      const binaer = typeof atob === 'function' ? atob(roh) : Buffer.from(roh, 'base64').toString('binary');
      // UTF-8 aus Binärstring zurückholen
      const bytes = new Uint8Array(binaer.length);
      for (let i = 0; i < binaer.length; i += 1) bytes[i] = binaer.charCodeAt(i);
      return { text: new TextDecoder().decode(bytes), path: pfad };
    } catch {
      return null;
    }
  }
  return { text: datei.content, path: pfad };
}

/**
 * Alle Dienst-Werkzeuge, die laut Einstellungen erlaubt sind.
 * Gibt eine leere Liste zurück, wenn nichts eingerichtet ist.
 */
export function buildServiceTools(settings: JarvisSettings, deps: DienstDeps): ToolSpec[] {
  const t = settings.tools;
  const specs: ToolSpec[] = [];
  if (!deps.http) return specs;

  // ------------------------------------------------------------------ GitHub
  const githubBereit = Boolean(settings.github.enabled && settings.github.owner && settings.github.repo);
  if (githubBereit) {
    const owner = () => settings.github.owner;
    const repo = () => settings.github.repo;

    specs.push({
      name: 'github_file',
      summary: 'Liest eine Datei aus dem verbundenen GitHub-Repository.',
      params: [
        { name: 'path', description: 'Pfad im Repository, z. B. "src/index.ts"', required: true },
        { name: 'ref', description: 'Branch oder Commit (Standard: der eingestellte Branch)', required: false },
      ],
      handler: async (args, context) => {
        const pfad = argText(args, 'path').replace(/^\/+/, '');
        if (!pfad) return { ok: false, text: 'Es fehlt "path" (der Dateipfad).' };
        const ref = argText(args, 'ref') || settings.github.branch || 'main';
        const ergebnis = await holeJson(deps, {
          url: `${githubBasis(settings)}/repos/${owner()}/${repo()}/contents/${pfad.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
          headers: githubKopf(settings, deps),
          signal: context.signal,
          was: `GitHub-Datei "${pfad}"`,
        });
        if (!ergebnis.ok) {
          return { ok: false, text: `${ergebnis.text} (Tipp: für Ordner github_tree benutzen)` };
        }
        const inhalt = githubDateiInhalt(ergebnis.daten);
        if (!inhalt) {
          if (Array.isArray(ergebnis.daten)) {
            const eintraege = (ergebnis.daten as Array<{ path?: string; type?: string }>)
              .slice(0, 60)
              .map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path ?? ''}`)
              .join('\n');
            return { ok: true, text: `"${pfad}" ist ein Ordner mit:\n${eintraege}`, summary: 'Ordner' };
          }
          return { ok: false, text: `"${pfad}" konnte nicht gelesen werden.` };
        }
        const grenze = argNumber(args, 'maxChars', 12_000, 500, 60_000);
        return {
          ok: true,
          text: `# ${inhalt.path}\n\n${kuerzen(inhalt.text, grenze)}`,
          summary: `${inhalt.text.length} Zeichen`,
        };
      },
    });

    specs.push({
      name: 'github_tree',
      summary: 'Zeigt den Dateibaum des verbundenen GitHub-Repositories (Ordner und Dateien).',
      params: [
        { name: 'path', description: 'Unterordner (leer = ganze Wurzel)', required: false },
        { name: 'limit', description: 'Höchstzahl Einträge (Standard 80)', required: false },
      ],
      handler: async (args, context) => {
        const pfad = argText(args, 'path').replace(/^\/+|\/+$/g, '');
        const grenze = argNumber(args, 'limit', 80, 5, 500);
        const ref = settings.github.branch || 'main';
        const ergebnis = await holeJson(deps, {
          url: `${githubBasis(settings)}/repos/${owner()}/${repo()}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          headers: githubKopf(settings, deps),
          signal: context.signal,
          was: 'GitHub-Dateibaum',
        });
        if (!ergebnis.ok) {
          // Fallback über die Contents-API
          const zweiter = await holeJson(deps, {
            url: `${githubBasis(settings)}/repos/${owner()}/${repo()}/contents/${pfad}`,
            headers: githubKopf(settings, deps),
            signal: context.signal,
            was: 'GitHub-Ordner',
          });
          if (!zweiter.ok) return { ok: false, text: ergebnis.text };
          const liste = Array.isArray(zweiter.daten) ? (zweiter.daten as Array<{ path?: string; type?: string }>) : [];
          const text = liste.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path ?? ''}`).join('\n');
          return { ok: true, text: text || 'Der Ordner ist leer.', summary: `${liste.length} Einträge` };
        }
        const baum = (ergebnis.daten as { tree?: Array<{ path?: string; type?: string; size?: number }> })?.tree ?? [];
        const gefiltert = baum
          .filter((e) => (pfad ? (e.path ?? '').startsWith(`${pfad}/`) || e.path === pfad : true))
          .slice(0, grenze);
        if (!gefiltert.length) return { ok: true, text: 'Keine Einträge gefunden.', summary: '0 Einträge' };
        const text = gefiltert.map((e) => `${e.type === 'tree' ? '📁' : '📄'} ${e.path ?? ''}`).join('\n');
        return { ok: true, text, summary: `${gefiltert.length} Einträge` };
      },
    });

    specs.push({
      name: 'github_search',
      summary: 'Sucht im verbundenen GitHub-Repository nach Textstellen (oder in einem Benutzer/Repo).',
      params: [
        { name: 'query', description: 'Suchbegriff oder Suchausdruck', required: true },
        { name: 'limit', description: 'Höchstzahl Treffer (Standard 8)', required: false },
        { name: 'repoOnly', description: '"false" sucht in ganz GitHub statt nur im eigenen Repository', required: false },
      ],
      handler: async (args, context) => {
        const query = argText(args, 'query');
        if (!query) return { ok: false, text: 'Es fehlt "query" (der Suchbegriff).' };
        const grenze = argNumber(args, 'limit', 8, 1, 30);
        const nurRepo = argText(args, 'repoOnly').toLowerCase() !== 'false';
        const bereich = nurRepo ? `repo:${owner()}/${repo()} ` : '';
        const ergebnis = await holeJson(deps, {
          url: `${githubBasis(settings)}/search/code?q=${encodeURIComponent(`${bereich}${query}`)}&per_page=${grenze}`,
          headers: githubKopf(settings, deps),
          signal: context.signal,
          was: 'GitHub-Suche',
        });
        if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
        const treffer = (ergebnis.daten as { items?: Array<{ path?: string; html_url?: string; repository?: { full_name?: string } }> })?.items ?? [];
        if (!treffer.length) return { ok: true, text: `Keine Treffer für "${query}".`, summary: '0 Treffer' };
        const text = treffer
          .map((t, index) => `${index + 1}. ${t.repository?.full_name ?? `${owner()}/${repo()}`} › ${t.path ?? ''}\n   ${t.html_url ?? ''}`)
          .join('\n');
        return { ok: true, text, summary: `${treffer.length} Treffer` };
      },
    });

    specs.push({
      name: 'github_issues',
      summary: 'Listet offene (oder geschlossene) Aufgaben und Fehlerberichte aus dem verbundenen Repository.',
      params: [
        { name: 'state', description: '"open" (Standard), "closed" oder "all"', required: false },
        { name: 'limit', description: 'Höchstzahl (Standard 10)', required: false },
        { name: 'labels', description: 'Nur mit diesem Label', required: false },
      ],
      handler: async (args, context) => {
        const zustand = argText(args, 'state') || 'open';
        const grenze = argNumber(args, 'limit', 10, 1, 50);
        const labels = argText(args, 'labels');
        const url = `${githubBasis(settings)}/repos/${owner()}/${repo()}/issues?state=${encodeURIComponent(zustand)}&per_page=${grenze}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`;
        const ergebnis = await holeJson(deps, { url, headers: githubKopf(settings, deps), signal: context.signal, was: 'GitHub-Aufgaben' });
        if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
        const liste = Array.isArray(ergebnis.daten)
          ? (ergebnis.daten as Array<{ number?: number; title?: string; state?: string; labels?: Array<{ name?: string }>; html_url?: string }>)
          : [];
        if (!liste.length) return { ok: true, text: `Keine ${zustand}-Aufgaben gefunden.`, summary: '0 Aufgaben' };
        const text = liste
          .filter((eintrag) => !('pull_request' in eintrag))
          .map((eintrag) => {
            const labels2 = (eintrag.labels ?? []).map((l) => l.name).filter(Boolean).join(', ');
            return `#${eintrag.number ?? '?'} [${eintrag.state ?? '?'}] ${eintrag.title ?? ''}${labels2 ? ` (${labels2})` : ''}`;
          })
          .join('\n');
        return { ok: true, text, summary: `${liste.length} Aufgaben` };
      },
    });

    if (t.allowGithubWrite) {
      specs.push({
        name: 'github_write',
        summary: 'Schreibt oder aktualisiert eine Datei im verbundenen GitHub-Repository (mit Commit).',
        danger: 'write',
        params: [
          { name: 'path', description: 'Pfad im Repository', required: true },
          { name: 'content', description: 'Der neue Dateiinhalt', required: true },
          { name: 'message', description: 'Commit-Nachricht', required: false },
          { name: 'branch', description: 'Branch (Standard: der eingestellte)', required: false },
        ],
        handler: async (args, context) => {
          const pfad = argText(args, 'path').replace(/^\/+/, '');
          const inhalt = typeof args.content === 'string' ? args.content : '';
          if (!pfad) return { ok: false, text: 'Es fehlt "path" (der Dateipfad).' };
          const branch = argText(args, 'branch') || settings.github.branch || 'main';
          const nachricht = argText(args, 'message') || `Jarvis: ${pfad} aktualisiert`;
          const basisUrl = `${githubBasis(settings)}/repos/${owner()}/${repo()}/contents/${pfad.split('/').map(encodeURIComponent).join('/')}`;
          // Vorhandene Datei? Dann braucht GitHub den SHA.
          const vorhanden = await holeJson(deps, {
            url: `${basisUrl}?ref=${encodeURIComponent(branch)}`,
            headers: githubKopf(settings, deps),
            signal: context.signal,
            was: 'GitHub-Datei prüfen',
          });
          const sha = vorhanden.ok && vorhanden.daten && !Array.isArray(vorhanden.daten)
            ? (vorhanden.daten as { sha?: string }).sha
            : undefined;
          const bytes = new TextEncoder().encode(inhalt);
          let binaer = '';
          for (const byte of bytes) binaer += String.fromCharCode(byte);
          const base64 = typeof btoa === 'function' ? btoa(binaer) : Buffer.from(bytes).toString('base64');
          const ergebnis = await holeJson(deps, {
            url: basisUrl,
            method: 'PUT',
            headers: { ...githubKopf(settings, deps), 'content-type': 'application/json' },
            body: JSON.stringify({ message: nachricht, content: base64, branch, ...(sha ? { sha } : {}) }),
            signal: context.signal,
            was: 'GitHub-Schreibvorgang',
          });
          if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
          const daten = ergebnis.daten as { commit?: { html_url?: string; sha?: string } } | null;
          return {
            ok: true,
            text: `Gespeichert: ${pfad} im Branch ${branch}${sha ? ' (aktualisiert)' : ' (neu)'}.${daten?.commit?.sha ? ` Commit ${daten.commit.sha.slice(0, 7)}.` : ''}`,
            summary: sha ? 'aktualisiert' : 'neu angelegt',
          };
        },
      });
    }
  }

  // -------------------------------------------------------------- HuggingFace
  specs.push({
    name: 'hf_search',
    summary: 'Sucht Modelle, Datensätze oder Apps (Spaces) auf HuggingFace.',
    params: [
      { name: 'query', description: 'Suchbegriff, z. B. "qwen" oder "deutsch"', required: true },
      { name: 'kind', description: '"model" (Standard), "dataset" oder "space"', required: false },
      { name: 'limit', description: 'Höchstzahl (Standard 10)', required: false },
    ],
    handler: async (args, context) => {
      const query = argText(args, 'query');
      if (!query) return { ok: false, text: 'Es fehlt "query" (der Suchbegriff).' };
      const artRoh = argText(args, 'kind') || 'model';
      const art = artRoh === 'dataset' ? 'datasets' : artRoh === 'space' ? 'spaces' : 'models';
      const grenze = argNumber(args, 'limit', 10, 1, 30);
      const token = (deps.key?.('huggingface') ?? '').trim();
      const url = `${hfBasis(settings)}/api/${art}?search=${encodeURIComponent(query)}&limit=${grenze}&full=false`;
      const ergebnis = await holeJson(deps, {
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: context.signal,
        was: 'HuggingFace-Suche',
      });
      if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
      const liste = Array.isArray(ergebnis.daten)
        ? (ergebnis.daten as Array<{ id?: string; downloads?: number; likes?: number; pipeline_tag?: string; tags?: string[] }>)
        : [];
      if (!liste.length) return { ok: true, text: `Keine Treffer für "${query}" bei HuggingFace.`, summary: '0 Treffer' };
      const text = liste
        .map((eintrag, index) => {
          const heruntergeladen = typeof eintrag.downloads === 'number' ? `${eintrag.downloads.toLocaleString('de-DE')} Downloads` : '';
          const likes = typeof eintrag.likes === 'number' ? `${eintrag.likes} ♥` : '';
          const art2 = eintrag.pipeline_tag ?? (eintrag.tags ?? []).slice(0, 3).join(', ');
          return `${index + 1}. ${eintrag.id ?? ''}${art2 ? ` — ${art2}` : ''}${[heruntergeladen, likes].filter(Boolean).length ? ` (${[heruntergeladen, likes].filter(Boolean).join(', ')})` : ''}`;
        })
        .join('\n');
      return { ok: true, text, summary: `${liste.length} Treffer` };
    },
  });

  specs.push({
    name: 'hf_info',
    summary: 'Holt Einzelheiten zu einem HuggingFace-Modell oder Datensatz (Beschreibung, Größe, Lizenz).',
    params: [
      { name: 'id', description: 'Kennung, z. B. "Qwen/Qwen3-8B"', required: true },
      { name: 'kind', description: '"model" (Standard) oder "dataset"', required: false },
    ],
    handler: async (args, context) => {
      const id = argText(args, 'id');
      if (!id) return { ok: false, text: 'Es fehlt "id" (die Kennung des Modells).' };
      const art = argText(args, 'kind') === 'dataset' ? 'datasets' : 'models';
      const token = (deps.key?.('huggingface') ?? '').trim();
      const ergebnis = await holeJson(deps, {
        url: `${hfBasis(settings)}/api/${art}/${id.split('/').map(encodeURIComponent).join('/')}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: context.signal,
        was: 'HuggingFace-Info',
      });
      if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
      const daten = ergebnis.daten as {
        id?: string;
        author?: string;
        downloads?: number;
        likes?: number;
        pipeline_tag?: string;
        library_name?: string;
        tags?: string[];
        lastModified?: string;
        cardData?: { license?: string; language?: string[] | string };
        siblings?: Array<{ rfilename?: string }>;
      } | null;
      if (!daten) return { ok: false, text: 'Keine Angaben gefunden.' };
      const sprachen = Array.isArray(daten.cardData?.language)
        ? daten.cardData?.language.join(', ')
        : daten.cardData?.language ?? '';
      const zeilen = [
        `${daten.id ?? id}`,
        daten.pipeline_tag ? `Aufgabe: ${daten.pipeline_tag}` : '',
        daten.library_name ? `Bibliothek: ${daten.library_name}` : '',
        daten.cardData?.license ? `Lizenz: ${daten.cardData.license}` : '',
        sprachen ? `Sprachen: ${sprachen}` : '',
        typeof daten.downloads === 'number' ? `Downloads: ${daten.downloads.toLocaleString('de-DE')}` : '',
        typeof daten.likes === 'number' ? `Likes: ${daten.likes}` : '',
        daten.lastModified ? `Zuletzt geändert: ${daten.lastModified}` : '',
        (daten.siblings ?? []).length ? `Dateien (${daten.siblings?.length}): ${(daten.siblings ?? []).slice(0, 12).map((s) => s.rfilename).join(', ')}` : '',
      ].filter(Boolean);
      return { ok: true, text: zeilen.join('\n'), summary: daten.id ?? id };
    },
  });

  // ---------------------------------------------------------------------- n8n
  const webhook = (t.n8nWebhookUrl || '').trim();
  if (webhook) {
    specs.push({
      name: 'n8n_run',
      summary: 'Löst einen n8n-Workflow aus (Webhook) und gibt die Antwort zurück.',
      danger: 'write',
      params: [
        { name: 'payload', description: 'Daten für den Workflow als JSON, z. B. {"text": "Hallo"}', required: false },
        { name: 'url', description: 'Andere Webhook-Adresse als die eingestellte', required: false },
      ],
      handler: async (args, context) => {
        const adresse = argText(args, 'url') || webhook;
        let daten: Record<string, unknown> = {};
        const roh = argText(args, 'payload');
        if (roh) {
          try {
            const geparst = JSON.parse(roh) as unknown;
            daten = geparst && typeof geparst === 'object' && !Array.isArray(geparst) ? (geparst as Record<string, unknown>) : { value: geparst };
          } catch {
            daten = { text: roh };
          }
        }
        const token = (deps.key?.('n8n') ?? '').trim();
        const ergebnis = await holeJson(deps, {
          url: adresse,
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { 'x-jarvis-key': token } : {}) },
          body: JSON.stringify(daten),
          signal: context.signal,
          was: 'n8n-Webhook',
        });
        if (!ergebnis.ok) return { ok: false, text: ergebnis.text };
        const text = typeof ergebnis.daten === 'string' ? ergebnis.daten : JSON.stringify(ergebnis.daten);
        return { ok: true, text: kuerzen(text || 'Der Workflow lief ohne Rückgabe.', 6000), summary: 'ausgeführt' };
      },
    });
  }

  return specs;
}
