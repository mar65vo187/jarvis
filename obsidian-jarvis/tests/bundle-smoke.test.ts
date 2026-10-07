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
    }>;
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
        editor: { getSelection: () => '', getCursor: () => ({ line: 0, ch: 0 }), replaceRange: () => undefined },
      }),
      on: () => ({ id: 'event' }),
    },
    fileManager: { trashFile: async () => undefined },
  };
  return { app, store };
}

let server: TestServer;
const created: Array<{ model: string; modelfile: string }> = [];
const deleted: Array<{ model: string }> = [];

const NOTES = {
  'Projekt Alpha.md':
    '# Projekt Alpha\n\nDas Projekt Alpha endet am 15. November. Ansprechpartnerin ist Frau Berger.\n\n## Risiken\n\nDer Lieferant hat noch keine Zusage gegeben.\n',
  'Rezepte/Kuchen.md': '# Kuchen\n\nZucker, Mehl, Eier. Bei 180 Grad backen.\n',
};

beforeAll(async () => {
  server = await startServer((req, res) => {
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
      ) as { messages?: Array<{ content: string }> };
      const asked = payload.messages?.at(-1)?.content ?? '';
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
