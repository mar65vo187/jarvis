/**
 * Ende-zu-Ende-Test auf dem fertigen Bündel (main.js).
 *
 * Hier wird nicht der Quellcode, sondern genau die ausgelieferte Datei geladen -
 * mit einer nachgebauten Obsidian-Umgebung und einem echten lokalen Ollama-Server.
 * Damit fallen Bündel-, Lade- und Verdrahtungsfehler auf, die Unit-Tests nicht sehen.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as obsidianMock from './mocks/obsidian';
import { startServer, json, ndjson, sse, type TestServer } from './helpers/server';

/** Dieselbe TFile-Klasse, die auch das Bündel über "obsidian" bekommt. */
const TFile = (obsidianMock as unknown as { TFile: new (path: string) => { path: string; stat: { mtime: number; size: number } } }).TFile;

interface LoadedPlugin {
  settings: {
    local: { baseUrl: string; defaultModel: string };
    routeMode: string;
    github: { owner: string };
    rag: { excludeFolders: string[] };
    learning: { enabled: boolean; saveMode: string };
  };
  brain: { models: (id: string, force?: boolean) => Promise<Array<{ id: string }>> };
  index: { stats: () => { chunks: number; files: number }; ensureFresh: (force: boolean) => Promise<unknown> };
  assistant: {
    ask: (options: Record<string, unknown>) => Promise<{
      answer: { text: string; providerId: string; model: string };
      sources: Array<{ path: string; id: string }>;
      lessons: Array<{ id: string; question: string }>;
      learned?: { saved: boolean; id?: string; notePath?: string };
      toolSteps?: Array<{ tool: string; ok: boolean; summary?: string }>;
      userMessage: string;
    }>;
    restoreLessonsFromNotes: () => Promise<number>;
    syncMemoryNotes: () => Promise<{ written: number; existing: number }>;
  };
  listAllModels: () => Promise<Array<{ id: string; local: boolean }>>;
  testEverything: () => Promise<string[]>;
  learning: { count: () => number; add: (input: Record<string, unknown>) => Promise<unknown>; list: () => unknown[] };
  distiller: {
    plan: () => { model: string; base: string };
    run: (plan: unknown) => Promise<{ model: string; message: string }>;
  };
  learningReport: () => string[];
  onload: () => Promise<void>;
  onunload: () => void;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
}

const BUNDLE = path.resolve(__dirname, '..', 'main.js');

function loadBundle(): { plugin: new (app: unknown, manifest: unknown) => LoadedPlugin; exports: Record<string, unknown> } {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const moduleObject = { exports: {} as Record<string, unknown> };
  const requireShim = (name: string): unknown => {
    if (name === 'obsidian') return obsidianMock;
    throw new Error(`Das Bündel verlangt ein unbekanntes Modul: ${name}`);
  };
  const wrapper = [
    '(function (module, exports, require, window, document, fetch, crypto, btoa, atob, TextEncoder, TextDecoder,',
    '  structuredClone, AbortController, AbortSignal, navigator, URL, URLSearchParams, Response, Request, Headers,',
    '  ReadableStream, setTimeout, clearTimeout, setInterval, clearInterval, console) {',
    code,
    '\n})',
  ].join('\n');
  const factory = vm.runInThisContext(wrapper, { filename: 'main.js' }) as (
    module: unknown,
    exports: unknown,
    require: unknown,
    ...globals: unknown[]
  ) => void;
  factory(
    moduleObject,
    moduleObject.exports,
    requireShim,
    globalThis.window ?? globalThis,
    globalThis.document,
    globalThis.fetch,
    globalThis.crypto,
    globalThis.btoa?.bind(globalThis),
    globalThis.atob?.bind(globalThis),
    TextEncoder,
    TextDecoder,
    structuredClone,
    AbortController,
    AbortSignal,
    globalThis.navigator,
    URL,
    URLSearchParams,
    Response,
    Request,
    Headers,
    ReadableStream,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  );
  const plugin = (moduleObject.exports as { default?: unknown }).default;
  if (typeof plugin !== 'function') {
    throw new Error('Das Bündel exportiert keine Plugin-Klasse als Standardexport.');
  }
  return { plugin: plugin as never, exports: moduleObject.exports };
}

/** Ein kleiner Vault im Arbeitsspeicher, wie ihn das Plugin sieht. */
function makeApp(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  const configDir = '.obsidian';
  const app = {
    vault: {
      configDir,
      getName: () => 'Testvault',
      getMarkdownFiles: () => [...store.keys()].map((target) => new TFile(target)),
      getAllLoadedFiles: () => [...store.keys()].map((target) => new TFile(target)),
      getAbstractFileByPath: (target: string) => (store.has(target) ? new TFile(target) : null),
      cachedRead: async (file: { path: string }) => store.get(file.path) ?? '',
      createFolder: async (folder: string) => {
        void folder;
      },
      create: async (target: string, data: string) => {
        store.set(target, data);
        return new TFile(target);
      },
      modifyBinary: async () => undefined,
      adapter: {
        exists: async (target: string) => store.has(target) || target === configDir,
        read: async (target: string) => store.get(target) ?? '',
        write: async (target: string, data: string) => {
          store.set(target, data);
        },
        readBinary: async (target: string) => new TextEncoder().encode(store.get(target) ?? '').buffer,
        writeBinary: async (target: string, data: ArrayBuffer) => {
          store.set(target, new TextDecoder().decode(data));
        },
        mkdir: async () => undefined,
        remove: async (target: string) => {
          store.delete(target);
        },
      },
      on: () => ({ id: 'event' }),
      getFiles: () => [...store.keys()].map((target) => new TFile(target)),
    },
    workspace: {
      getLeavesOfType: () => [] as unknown[],
      getRightLeaf: () => null,
      revealLeaf: async () => undefined,
      getLeaf: () => ({ openFile: async () => undefined }),
      getActiveViewOfType: () => ({
        file: new TFile('Projekt Alpha.md'),
        editor: {
          getSelection: () => editorAuswahl,
          getCursor: () => ({ line: 0, ch: 0 }),
          lastLine: () => 0,
          getLine: () => 'Der letzte Satz.',
          replaceSelection: (text: string) => {
            editorErsetzt.push(text);
          },
          replaceRange: (text: string) => {
            editorErsetzt.push(text);
          },
        },
      }),
      on: () => ({ id: 'event' }),
    },
    metadataCache: {
      getFileCache: () => ({ links: [{ link: 'Rezepte/Kuchen' }] }),
      getFirstLinkpathDest: (link: string) => new TFile(`${link}.md`),
      resolvedLinks: { 'Index.md': { 'Projekt Alpha.md': 1 } },
      getTags: () => ({ '#projekt': 3, '#idee': 1 }),
    },
    fileManager: { trashFile: async () => undefined },
  };
  return { app, store };
}

let server: TestServer;
const created: Array<{ model: string; modelfile: string }> = [];
const webSuchen: string[] = [];
const dienstRufe: string[] = [];
const editorErsetzt: string[] = [];
let editorAuswahl = '';
const deleted: Array<{ model: string }> = [];

const NOTES = {
  'Projekt Alpha.md':
    '# Projekt Alpha\n\nDas Projekt Alpha endet am 15. November. Ansprechpartnerin ist Frau Berger.\n\n## Risiken\n\nDer Lieferant hat noch keine Zusage gegeben.\n',
  'Rezepte/Kuchen.md': '# Kuchen\n\nZucker, Mehl, Eier. Bei 180 Grad backen.\n',
};

beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url?.startsWith('/search')) {
      // Spielt den Suchdienst (Tavily-Form)
      const payload = JSON.parse((server.requests.at(-1)?.body as string) || '{}') as { query?: string };
      webSuchen.push(payload.query ?? '');
      json(res, 200, { results: [{ title: 'Obsidian-Handbuch', url: 'https://help.obsidian.md/x', content: 'Notizen, Links, Anhänge.' }] });
      return;
    }
    if (req.url?.startsWith('/seite')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Handbuch-Seite</title></head><body><h1>Vault</h1><p>Ein Vault ist ein Ordner mit Notizen.</p></body></html>');
      return;
    }
    if ((req.url ?? '').startsWith('/repos/')) {
      if (req.method === 'PUT') {
        dienstRufe.push(`PUT ${req.url}`);
        json(res, 201, { commit: { sha: 'abcdef1234', html_url: 'https://github.com/x/y/commit/abcdef1' } });
        return;
      }
      dienstRufe.push(`GET ${req.url}`);
      if ((req.url ?? '').includes('/contents/')) {
        json(res, 200, { path: 'README.md', encoding: 'base64', content: Buffer.from('# Jarvis\n\nLäuft lokal und online.').toString('base64') });
        return;
      }
      if ((req.url ?? '').includes('/issues')) {
        json(res, 200, [{ number: 7, title: 'Release 2.1.0', state: 'open', labels: [{ name: 'release' }] }]);
        return;
      }
      json(res, 200, {});
      return;
    }
    if ((req.url ?? '').startsWith('/api/models/Qwen/')) {
      dienstRufe.push(`GET ${req.url}`);
      json(res, 200, { id: 'Qwen/Qwen3-8B', downloads: 4711, likes: 12, pipeline_tag: 'text-generation', cardData: { license: 'apache-2.0' } });
      return;
    }
    if ((req.url ?? '').startsWith('/api/models?search=')) {
      dienstRufe.push(`GET ${req.url}`);
      json(res, 200, [{ id: 'Qwen/Qwen3-8B', downloads: 4711, likes: 12, pipeline_tag: 'text-generation' }]);
      return;
    }
    if (req.url === '/webhook/jarvis') {
      dienstRufe.push('POST /webhook/jarvis');
      json(res, 200, { ok: true, nachricht: 'Workflow lief' });
      return;
    }
    if (req.url === '/api/tags') {
      // Angelegte Profile erscheinen - wie bei echtem Ollama - in der Modellliste.
      json(res, 200, {
        models: [
          { name: 'qwen3:8b', size: 5_000_000_000 },
          { name: 'nomic-embed-text:latest' },
          ...created.map((entry) => ({ name: entry.model })),
        ],
      });
      return;
    }
    if (req.url === '/api/embed') {
      // Wie Ollama: für jeden Eingabetext genau einen Vektor zurückgeben.
      const payload = JSON.parse(server.requests.at(-1)?.body || '{}') as { input?: string[] };
      const inputs = payload.input ?? [];
      json(res, 200, { embeddings: inputs.map((_input, index) => [0.1 + index * 0.001, 0.2, 0.3]) });
      return;
    }
    if (req.url === '/chat/completions') {
      sse(res, [
        JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  'Laut [Q1] endet Projekt Alpha am 15. November. Ansprechpartnerin ist Frau Berger, und die Zusage des Lieferanten fehlt noch.',
              },
            },
          ],
        }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 40 } }),
      ]);
      return;
    }
    if (req.url === '/api/create') {
      const payload = JSON.parse(server.requests.at(-1)?.body as string) as { model: string; modelfile: string };
      created.push(payload);
      json(res, 200, { status: 'success' });
      return;
    }
    if (req.url === '/api/delete') {
      deleted.push(JSON.parse(server.requests.at(-1)?.body as string) as { model: string });
      json(res, 200, { status: 'success' });
      return;
    }
    if (req.url === '/api/chat') {
      const payload = JSON.parse(
        // Der Prompt steht im Rumpf der Anfrage; wir beantworten ihn fest.
        (server.requests.at(-1)?.body as string) || '{}',
      ) as { messages?: Array<{ role: string; content: string }> };
      const system = payload.messages?.[0]?.content ?? '';
      const asked = payload.messages?.at(-1)?.content ?? '';
      const werkzeugAngeboten = system.includes('WERKZEUGE');
      // Ein Werkzeugergebnis steht immer in einer Nutzer-Nachricht (nicht in der Systemanweisung).
      const ergebnisDa = (payload.messages ?? []).some(
        (m) => m.role === 'user' && m.content.includes('WERKZEUG-ERGEBNIS'),
      );
      if (werkzeugAngeboten && ergebnisDa) {
        ndjson(res, [
          JSON.stringify({ message: { role: 'assistant', content: 'Laut Werkzeug: Obsidian-Handbuch beschreibt Vaults. [W-Tool]' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 500, eval_count: 30 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /geöffnete[n]? notiz|offene[n]? notiz/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({ message: { role: 'assistant', content: '```jarvis-tool\n{"tool": "note_current", "args": {}}\n```' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /tagesnotiz/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '```jarvis-tool\n{"tool": "daily_append", "args": {"content": "- 14:00 Review"}}\n```',
            },
            done: false,
          }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /github/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({ message: { role: 'assistant', content: '```jarvis-tool\n{"tool": "github_file", "args": {"path": "README.md"}}\n```' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /huggingface/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({ message: { role: 'assistant', content: '```jarvis-tool\n{"tool": "hf_search", "args": {"query": "qwen3"}}\n```' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /n8n/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({ message: { role: 'assistant', content: '```jarvis-tool\n{"tool": "n8n_run", "args": {"payload": "{\\"text\\":\\"Hallo\\"}"}}\n```' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /lies\s+bitte\s+https?:\/\//i.test(asked)) {
        const adresse = /(https?:\/\/[^\s,]+)/.exec(asked)?.[1] ?? `${server.url}/seite`;
        ndjson(res, [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: `\`\`\`jarvis-tool\n{"tool": "web_read", "args": {"url": "${adresse}"}}\n\`\`\``,
            },
            done: false,
          }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      if (werkzeugAngeboten && /recherchiere|internet|suche im netz/i.test(asked)) {
        ndjson(res, [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '```jarvis-tool\n{"tool": "web_search", "args": {"query": "Obsidian Vault Grundlagen"}}\n```',
            },
            done: false,
          }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 20 }),
        ]);
        return;
      }
      const answer = asked.includes('Projekt Alpha')
        ? 'Laut [Q1] endet Projekt Alpha am 15. November; offen ist die Zusage des Lieferanten.'
        : 'Dazu habe ich keine Notiz gefunden.';
      ndjson(res, [
        JSON.stringify({ message: { role: 'assistant', content: answer.slice(0, 40) }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: answer.slice(40) }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 350, eval_count: 40 }),
      ]);
      return;
    }
    json(res, 404, { error: 'unbekannt' });
  });
});

afterAll(async () => {
  await server?.close();
});

describe('Ausgeliefertes Bündel main.js', () => {
  it('lädt, richtet sich ein und beantwortet eine Frage mit Quellenangabe', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });

    plugin.loadData = async () => ({ settings: { local: { baseUrl: server.url, defaultModel: 'qwen3:8b' } }, keys: {} });
    plugin.saveData = async () => undefined;

    await plugin.onload();
    expect(plugin.settings.local.baseUrl).toBe(server.url);

    // Modelle wirklich vom Testserver holen
    const models = await plugin.listAllModels();
    expect(models.map((model) => model.id)).toContain('qwen3:8b');

    // Wissensindex über den echten Vault-Zugriff aufbauen
    await plugin.index.ensureFresh(true);
    const stats = plugin.index.stats();
    expect(stats.files).toBe(2);
    expect(stats.chunks).toBeGreaterThan(0);

    // Komplette Frage durch alle Schichten
    const result = await plugin.assistant.ask({
      question: 'Wann endet Projekt Alpha und was ist offen?',
      mode: 'vault',
      route: 'local',
      history: [],
    });

    expect(result.answer.providerId).toBe('ollama');
    expect(result.answer.model).toBe('qwen3:8b');
    expect(result.answer.text).toContain('15. November');
    expect(result.sources[0].path).toBe('Projekt Alpha.md');
    expect(result.sources[0].id).toBe('Q1');

    // Gesendeter Prompt enthält die Notiz als Quelle
    const sent = JSON.parse(server.requests.at(-1)!.body) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages.at(-1)!.content).toContain('QUELLEN');
    expect(sent.messages.at(-1)!.content).toContain('Projekt Alpha.md');

    plugin.onunload();
  });

  it('führt einen echten Werkzeugeinsatz aus (Internetsuche) und zeigt die Schritte', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        routeMode: 'local',
        tools: {
          enabled: true,
          mode: 'always',
          effort: 'normal',
          maxSteps: 3,
          allowInternet: true,
          searchProvider: 'tavily',
          searchApiKey: 'tv-test',
          searchBaseUrl: server.url,
          showSteps: true,
        },
      },
      keys: {},
    });
    await plugin.onload();

    const vorher = webSuchen.length;
    const ergebnis = await plugin.assistant.ask({
      question: 'Recherchiere im Internet: Was ist ein Obsidian Vault?',
      mode: 'auto',
      route: 'local',
      history: [],
    });

    // Das Modell hat den Werkzeugblock geschickt, das Plugin hat ihn wirklich ausgeführt.
    expect(webSuchen.length).toBeGreaterThan(vorher);
    expect(webSuchen.at(-1)).toBe('Obsidian Vault Grundlagen');
    expect(ergebnis.toolSteps?.length).toBeGreaterThan(0);
    expect(ergebnis.toolSteps?.[0].tool).toBe('web_search');
    expect(ergebnis.toolSteps?.[0].ok).toBe(true);
    // Die Antwort entstand aus dem Werkzeugergebnis, nicht aus einer Erfindung.
    expect(ergebnis.answer.text).toContain('Werkzeug');
    // Die Suchanfrage ging wirklich an den Dienst (Tavily-Form mit Schlüssel).
    const suchAnfragen = server.requests.filter((eintrag) => (eintrag.url ?? '').startsWith('/search'));
    const suchAnfrage = suchAnfragen[suchAnfragen.length - 1];
    expect(suchAnfrage).toBeTruthy();
    const suchRumpf = JSON.parse(suchAnfrage!.body) as { api_key: string; query: string };
    expect(suchRumpf.api_key).toBe('tv-test');
    expect(suchRumpf.query).toBe('Obsidian Vault Grundlagen');

    plugin.onunload();
  });

  it('liest eine Internetseite über das Werkzeug web_read', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        routeMode: 'local',
        tools: {
          enabled: true,
          mode: 'always',
          maxSteps: 2,
          allowInternet: true,
          searchProvider: 'tavily',
          searchApiKey: 'tv-test',
          searchBaseUrl: server.url,
          showSteps: true,
        },
      },
      keys: {},
    });
    await plugin.onload();
    const ergebnis = await plugin.assistant.ask({
      question: `Lies bitte ${server.url}/seite und fasse sie zusammen.`,
      mode: 'auto',
      route: 'local',
      history: [],
    });
    const schritt = ergebnis.toolSteps?.find((eintrag) => eintrag.tool === 'web_read');
    expect(schritt).toBeTruthy();
    expect(schritt!.ok).toBe(true);
    // Der gelesene Seitentext ging wirklich an das Modell zurück
    const letzterRuf = JSON.parse(server.requests.filter((eintrag) => eintrag.url === '/api/chat').at(-1)!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const ergebnisBlock = letzterRuf.messages.filter((nachricht) => nachricht.role === 'user').at(-1)!.content;
    expect(ergebnisBlock).toContain('WERKZEUG-ERGEBNIS');
    expect(ergebnisBlock).toContain('Ein Vault ist ein Ordner mit Notizen.');
    plugin.onunload();
  });

  it('benutzt GitHub, HuggingFace und n8n über das fertige Bündel', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        routeMode: 'local',
        github: { enabled: true, owner: 'mar65vo187', repo: 'jarvis', branch: 'main' },
        tools: {
          enabled: true,
          mode: 'always',
          maxSteps: 2,
          allowInternet: true,
          githubApiBase: server.url,
          hfBaseUrl: server.url,
          n8nWebhookUrl: `${server.url}/webhook/jarvis`,
          showSteps: true,
        },
      },
      keys: {
        'jarvis-ai-github': 'gh-test',
        'jarvis-ai-n8n': 'n8n-test',
        'jarvis-ai-huggingface': 'hf-test',
      },
    });
    await plugin.onload();

    const vorher = dienstRufe.length;
    const gelesen = await plugin.assistant.ask({
      question: 'Lies mir bitte die README aus dem GitHub-Repository vor.',
      mode: 'auto',
      route: 'local',
      history: [],
    });
    expect(gelesen.toolSteps?.some((schritt) => schritt.tool === 'github_file')).toBe(true);
    expect(gelesen.toolSteps?.every((schritt) => schritt.ok)).toBe(true);
    expect(dienstRufe.some((ruf) => ruf.includes('/repos/mar65vo187/jarvis/contents/README.md'))).toBe(true);

    const modelle = await plugin.assistant.ask({
      question: 'Suche bei HuggingFace nach qwen3-Modellen.',
      mode: 'auto',
      route: 'local',
      history: [],
    });
    expect(modelle.toolSteps?.some((schritt) => schritt.tool === 'hf_search')).toBe(true);
    expect(dienstRufe.some((ruf) => ruf.includes('/api/models?search=qwen3'))).toBe(true);

    const workflow = await plugin.assistant.ask({
      question: 'Löse bitte den n8n-Workflow mit einer kurzen Nachricht aus.',
      mode: 'auto',
      route: 'local',
      history: [],
    });
    expect(workflow.toolSteps?.some((schritt) => schritt.tool === 'n8n_run')).toBe(true);
    expect(dienstRufe).toContain('POST /webhook/jarvis');
    expect(dienstRufe.length).toBeGreaterThan(vorher + 2);
    plugin.onunload();
  });

  it('benutzt die Obsidian-Oberfläche: geöffnete Notiz lesen und Tagesnotiz ergänzen', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app, store } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        routeMode: 'local',
        tools: {
          enabled: true,
          mode: 'always',
          maxSteps: 2,
          allowVaultWrite: true,
          dailyNoteFolder: 'Journal',
          showSteps: true,
        },
      },
      keys: {},
    });
    await plugin.onload();

    const geoeffnet = await plugin.assistant.ask({
      question: 'Was steht in meiner geöffneten Notiz?',
      mode: 'auto',
      route: 'local',
      history: [],
    });
    expect(geoeffnet.toolSteps?.some((schritt) => schritt.tool === 'note_current')).toBe(true);
    const gesendet = JSON.parse(server.requests.filter((eintrag) => eintrag.url === '/api/chat').at(-1)!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const ergebnisBlock = gesendet.messages.filter((nachricht) => nachricht.role === 'user').at(-1)!.content;
    expect(ergebnisBlock).toContain('GEÖFFNETE NOTIZ: Projekt Alpha.md');
    expect(ergebnisBlock).toContain('15. November');

    // Tagesnotiz: das Tagesdatum wird über die echte Plugin-Verdrahtung ermittelt.
    editorAuswahl = '';
    const tagesnotiz = await plugin.assistant.ask({
      question: 'Häng bitte einen Eintrag an meine Tagesnotiz an.',
      mode: 'auto',
      route: 'local',
      history: [],
    });
    expect(tagesnotiz.toolSteps?.some((schritt) => schritt.tool === 'daily_append')).toBe(true);
    const heute = new Date();
    const name = `Journal/${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}.md`;
    expect(store.get(name) ?? '').toContain('- 14:00 Review');
    plugin.onunload();
  });

  it('liefert einen vollständigen Diagnosebericht', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({ settings: { local: { baseUrl: server.url, defaultModel: 'qwen3:8b' } }, keys: {} });
    plugin.saveData = async () => undefined;
    await plugin.onload();

    const lines = await plugin.testEverything();
    const report = lines.join('\n');
    expect(report).toContain('— Ollama —');
    expect(report).toContain('✅ Ollama erreichbar');
    expect(report).toContain('— Cloud —');
    expect(report).toContain('— GitHub —');
    expect(report).toContain('— Wissen —');
    expect(report).toContain('2 Notizen');
    plugin.onunload();
  });

  it('lernt aus einer Cloud-Antwort und legt das Gelernte als Notiz im Vault ab', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app, store } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        learning: { enabled: true, saveMode: 'auto', learnFrom: 'all', writeNotes: true, memoryFolder: 'Jarvis Gedächtnis' },
        cloud: {
          openai: { enabled: true, baseUrl: server.url, defaultModel: 'gpt-6-astra', kind: 'openai', label: 'GPT' },
        },
      },
      keys: { 'jarvis-ai-openai': 'sk-test' },
    });
    plugin.saveData = async () => undefined;
    await plugin.onload();

    // Cloud-Antwort erzwingen -> Lernen
    const result = await plugin.assistant.ask({
      question: 'Wann endet Projekt Alpha und wer ist Ansprechpartnerin?',
      mode: 'vault',
      route: 'cloud',
      history: [],
    });
    expect(result.answer.providerId).toBe('openai');
    expect(result.learned?.saved).toBe(true);
    expect(plugin.learning.count()).toBe(1);

    // Gelerntes liegt als Notiz im Vault (geht damit ins GitHub-Backup)
    const paths = [...store.keys()].filter((path) => path.startsWith('Jarvis Gedächtnis/'));
    expect(paths).toHaveLength(1);
    expect(store.get(paths[0])).toContain('jarvis-gelernt: true');
    expect(result.learned?.notePath).toBe(paths[0]);

    // Der Gedächtnisordner wird aus der Vault-Suche herausgehalten
    expect(plugin.settings.rag.excludeFolders).toContain('Jarvis Gedächtnis');

    // Zweite Frage: das Gelernte steckt im Prompt an das lokale Modell
    const second = await plugin.assistant.ask({
      question: 'Wann endet Projekt Alpha und wer ist Ansprechpartnerin?',
      mode: 'vault',
      route: 'local',
      history: [],
    });
    expect(second.lessons).toHaveLength(1);
    const sent = JSON.parse(server.requests.filter((request) => request.url === '/api/chat').at(-1)!.body) as {
      messages: Array<{ content: string }>;
    };
    expect(sent.messages.at(-1)!.content).toContain('GELERNTES WISSEN');

    // Weitere gelernter Inhalt -> destillieren (echter Ollama-Aufruf an /api/create)
    await plugin.learning.add({
      question: 'Wer ist Ansprechpartnerin im Projekt Alpha?',
      answer: 'Frau Berger ist die Ansprechpartnerin.',
      provider: 'openai',
      model: 'gpt-6-astra',
      reason: 'escalation',
      sources: [{ path: 'Projekt Alpha.md' }],
    });
    const plan = plugin.distiller.plan();
    const outcome = await plugin.distiller.run(plan);
    expect(outcome.model).toBe('jarvis-brain-v1');
    expect(created).toHaveLength(1);
    expect(created[0].model).toBe('jarvis-brain-v1');
    expect(created[0].modelfile).toContain('FROM qwen3:8b');
    expect(created[0].modelfile).toContain('MESSAGE user');
    expect(created[0].modelfile).toContain('MESSAGE assistant');
    expect(created[0].modelfile).toContain('SYSTEM');

    // Bericht enthält den Lernstand
    const report = plugin.learningReport().join('\n');
    expect(report).toContain('Lektionen:');
    expect(report).toContain('Qualitätsverlauf');
    plugin.onunload();
  });

  it('holt nach einer Neuinstallation das Gelernte aus den Notizen zurück', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app, store } = makeApp(NOTES);
    const EINSTELLUNGEN = {
      settings: {
        local: { baseUrl: server.url, defaultModel: 'qwen3:8b' },
        learning: { enabled: true, saveMode: 'auto', learnFrom: 'all', writeNotes: true, memoryFolder: 'Jarvis Gedächtnis' },
        cloud: { openai: { enabled: true, baseUrl: server.url, defaultModel: 'gpt-6-astra', kind: 'openai', label: 'GPT' } },
      },
      keys: { 'jarvis-ai-openai': 'sk-test' },
    };
    const starten = async () => {
      const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
      plugin.loadData = async () => EINSTELLUNGEN;
      plugin.saveData = async () => undefined;
      await plugin.onload();
      return plugin;
    };

    // Erste Installation: zwei Lektionen lernen
    const erste = await starten();
    await erste.assistant.ask({ question: 'Wann endet Projekt Alpha?', mode: 'vault', route: 'cloud', history: [] });
    await erste.assistant.ask({ question: 'Wer ist Ansprechpartnerin im Projekt Alpha?', mode: 'vault', route: 'cloud', history: [] });
    expect(erste.learning.count()).toBe(2);
    const notizen = [...store.keys()].filter((path) => path.startsWith('Jarvis Gedächtnis/') && path.endsWith('.md'));
    expect(notizen).toHaveLength(2);
    erste.onunload();

    // Neuinstallation: Zwischenspeicher weg, Notizen im Vault bleiben
    store.delete('.obsidian/plugins/jarvis-ai/cache/learning.json');
    expect(store.has('.obsidian/plugins/jarvis-ai/cache/learning.json')).toBe(false);

    const zweite = await starten();
    expect(zweite.learning.count()).toBe(0); // wirklich leer gestartet
    const zurueck = await zweite.assistant.restoreLessonsFromNotes();
    expect(zurueck).toBe(2);
    expect(zweite.learning.count()).toBe(2);
    expect(zweite.learning.list()).toHaveLength(2);

    // Das wiederhergestellte Wissen wird sofort wieder verwendet
    const antwort = await zweite.assistant.ask({
      question: 'Wann endet Projekt Alpha?',
      mode: 'vault',
      route: 'local',
      history: [],
    });
    expect(antwort.lessons.length).toBeGreaterThan(0);
    const gesendet = JSON.parse(server.requests.filter((request) => request.url === '/api/chat').at(-1)!.body) as {
      messages: Array<{ content: string }>;
    };
    expect(gesendet.messages.at(-1)!.content).toContain('GELERNTES WISSEN');

    // Erneutes Wiederherstellen erzeugt keine Dubletten
    expect(await zweite.assistant.restoreLessonsFromNotes()).toBe(0);
    expect(zweite.learning.count()).toBe(2);
    zweite.onunload();
  });

  it('erklärt verständlich, wenn kein Modell antworten kann', async () => {
    const { plugin: PluginClass } = loadBundle();
    const { app } = makeApp(NOTES);
    const plugin = new PluginClass(app, { id: 'jarvis-ai', version: '2.0.0' });
    plugin.loadData = async () => ({ settings: { local: { baseUrl: 'http://127.0.0.1:1', defaultModel: 'qwen3:8b' } }, keys: {} });
    plugin.saveData = async () => undefined;
    await plugin.onload();

    await expect(
      plugin.assistant.ask({ question: 'Test', mode: 'vault', route: 'local', history: [] }),
    ).rejects.toThrow(/Kein Modell konnte antworten/);
    plugin.onunload();
  });
});
