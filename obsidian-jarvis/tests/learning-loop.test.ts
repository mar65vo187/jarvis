/**
 * Integrationstest des Verbesserungskreislaufs:
 *
 *   Frage -> lokale Antwort (schwach) -> Cloud übernimmt -> daraus lernen
 *         -> nächste Frage: lokale KI nutzt das Gelernte -> Antwort ist gut
 *         -> keine Cloud mehr nötig.
 *
 * Der lokale Testserver verhält sich dabei wie ein echtes Modell: Er antwortet
 * schlecht, solange ihm die Information fehlt, und gut, sobald sie ihm als
 * gelerntes Wissen mitgeliefert wird.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, json, ndjson, sse, type TestServer } from './helpers/server';
import { Brain } from '../src/brain';
import { Assistant } from '../src/chat/assistant';
import { LearningStore, type JsonPersist } from '../src/learn/store';
import { MemoryNotes, type MemoryNoteFs } from '../src/learn/notes';
import { Distiller } from '../src/learn/distill';
import { mergeSettings } from '../src/settings';
import { VaultIndex, type RagOptions } from '../src/rag/vault-index';
import { MemoryPersist, MemoryVault, FakeEmbedder } from './helpers/mock-vault';
import type { JarvisSettings } from '../src/types';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const RAG: RagOptions = {
  excludeFolders: [],
  maxNoteBytes: 300_000,
  topK: 5,
  contextChars: 6000,
};

const NOTES = {
  'Projekt Alpha.md':
    '# Projekt Alpha\n\n## Status\n\nProjekt Alpha endet am 15. November. Ansprechpartnerin ist Frau Berger. Der Lieferant hat noch keine Zusage gegeben. Die Rechnung RE-2026-114 ist offen.\n',
};

/** Ein Ollama, das sich wie ein echtes Modell verhält: ohne Wissen schlecht, mit Wissen gut. */
function ollamaHandler(serverRef: () => TestServer) {
  return (_req: unknown, res: import('node:http').ServerResponse, body: string) => {
    const payload = JSON.parse(body) as { messages?: Array<{ content: string }> };
    const last = payload.messages?.at(-1)?.content ?? '';
    const hasLearned = last.includes('GELERNTES WISSEN');
    const answer = hasLearned
      ? 'Laut [Q1] endet Projekt Alpha am 15. November. Ansprechpartnerin ist Frau Berger, die Zusage des Lieferanten fehlt noch; die Rechnung RE-2026-114 ist offen.'
      : last.includes('Projekt Alpha')
        ? 'Dazu habe ich in meinen Notizen keine vollständigen Angaben.'
        : 'Keine passenden Informationen gefunden.';
    void serverRef;
    ndjson(res, [
      JSON.stringify({ message: { role: 'assistant', content: answer.slice(0, 60) }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: answer.slice(60) }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 400, eval_count: 45 }),
    ]);
  };
}

const CLOUD_ANSWER =
  'Laut [Q1] endet Projekt Alpha am 15. November. Ansprechpartnerin ist Frau Berger, die Zusage des Lieferanten steht noch aus, und die Rechnung RE-2026-114 ist offen.';

class MemoryJson implements JsonPersist {
  data: string | null = null;
  async read(): Promise<string | null> {
    return this.data;
  }
  async write(text: string): Promise<void> {
    this.data = text;
  }
}

class MemoryNoteStore implements MemoryNoteFs {
  files = new Map<string, string>();
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }
  async ensureFolder(): Promise<void> {
    /* noop */
  }
}

interface Setup {
  settings: JarvisSettings;
  assistant: Assistant;
  store: LearningStore;
  notes: MemoryNoteStore;
  server: TestServer;
  cloudCalls: () => number;
}

async function setup(overrides: {
  cloudHandler?: (res: import('node:http').ServerResponse) => void;
  learning?: Record<string, unknown>;
  withNotes?: boolean;
} = {}): Promise<Setup> {
  const serverRef = { current: null as TestServer | null };
  let cloudCalls = 0;
  const api = await startServer((req, res, body) => {
    if (req.url === '/api/tags') {
      json(res, 200, { models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text:latest' }] });
      return;
    }
    if (req.url === '/api/embed') {
      const payload = JSON.parse(body) as { input?: string[] };
      json(res, 200, { embeddings: (payload.input ?? []).map((_i, index) => [Math.sin(index), Math.cos(index), 0.5]) });
      return;
    }
    if (req.url === '/api/chat') {
      ollamaHandler(() => serverRef.current!)(req, res, body);
      return;
    }
    if (req.url === '/chat/completions') {
      cloudCalls++;
      if (overrides.cloudHandler) {
        overrides.cloudHandler(res);
        return;
      }
      sse(res, [
        JSON.stringify({ choices: [{ delta: { content: CLOUD_ANSWER } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 60 } }),
      ]);
      return;
    }
    json(res, 404, { error: 'unbekannt' });
  });
  serverRef.current = api;
  server = api;

  const settings = mergeSettings({
    routeMode: 'auto',
    autoEscalate: true,
    local: { baseUrl: api.url, defaultModel: 'qwen3:8b', temperature: 0.2 },
    rag: { topK: 5, contextChars: 6000, excludeFolders: [], deepMode: false, maxNoteBytes: 300_000, includeActiveNote: true },
    learning: { enabled: true, saveMode: 'auto', learnFrom: 'escalations', injectLessons: 3, injectChars: 4000, ...(overrides.learning ?? {}) },
    cloud: {
      ...mergeSettings(null).cloud,
      openai: { ...mergeSettings(null).cloud.openai, enabled: true, baseUrl: api.url, defaultModel: 'gpt-6-astra' },
      anthropic: { ...mergeSettings(null).cloud.anthropic, enabled: false },
      gemini: { ...mergeSettings(null).cloud.gemini, enabled: false },
      openrouter: { ...mergeSettings(null).cloud.openrouter, enabled: false },
      custom: { ...mergeSettings(null).cloud.custom, enabled: false },
    },
  });

  const brain = new Brain(() => settings, '2.0.0');
  brain.setKeyReader((id) => (id === 'openai' ? 'sk-test' : ''));

  const vault = new MemoryVault(NOTES);
  const index = new VaultIndex(vault, new MemoryPersist(), RAG, new FakeEmbedder(null));
  await index.ensureFresh(true);

  const store = new LearningStore(new MemoryJson(), () => settings.learning, 0);
  await store.load();
  const notes = new MemoryNoteStore();
  const memoryNotes = new MemoryNotes(notes, () => settings.learning);

  const assistant = new Assistant({
    settings: () => settings,
    index,
    brain,
    vaultName: () => 'Testvault',
    learning: { store, notes: memoryNotes },
  });

  return { settings, assistant, store, notes, server: api, cloudCalls: () => cloudCalls };
}

describe('Verbesserungskreislauf: aus Cloud-Antworten lernen', () => {
  it('erkennt die schwache lokale Antwort, wertet sie auf und lernt daraus', async () => {
    const { assistant, store, notes, settings, cloudCalls } = await setup();
    const question = 'Wann endet Projekt Alpha und welche Rechnung ist offen?';

    const first = await assistant.ask({ question, mode: 'vault', route: 'auto', history: [] });

    // 1. Die lokale Antwort war schwach und wurde ersetzt
    expect(first.replacedLocalAnswer).toBeTruthy();
    expect(first.answer.providerId).toBe('openai');
    expect(first.answer.model).toBe('gpt-6-astra');
    expect(first.answer.escalated).toBe(true);
    expect(first.quality?.cloud?.coverage).toBeGreaterThan(0.7);
    expect(first.quality?.local.coverage).toBeLessThan(0.4);
    expect(first.notice).toContain('Lokale Antwort war zu schwach');
    expect(cloudCalls()).toBe(1);

    // 2. Daraus wurde gelernt: Speicher + Markdown-Notiz im Vault
    expect(first.learned?.saved).toBe(true);
    expect(store.count()).toBe(1);
    const lesson = store.list()[0];
    expect(lesson.reason).toBe('upgrade');
    expect(lesson.model).toBe('gpt-6-astra');
    expect(lesson.sources[0].path).toBe('Projekt Alpha.md');
    expect(notes.files.size).toBe(1);
    expect([...notes.files.values()][0]).toContain('jarvis-gelernt: true');
    expect(first.notice).toContain('gelernt');

    // 3. Der Gedächtnisordner wird automatisch von der Vault-Suche ausgenommen
    expect(settings.rag.excludeFolders).toContain(settings.learning.memoryFolder);
  });

  it('nutzt das Gelernte bei der nächsten Frage — lokal antwortet jetzt gut, ohne Cloud', async () => {
    const { assistant, store, cloudCalls } = await setup();
    const question = 'Wann endet Projekt Alpha und welche Rechnung ist offen?';

    const first = await assistant.ask({ question, mode: 'vault', route: 'auto', history: [] });
    expect(first.learned?.saved).toBe(true);
    expect(cloudCalls()).toBe(1);

    // Zweite Frage: das Gelernte ist im Prompt -> das lokale Modell antwortet vollständig
    const second = await assistant.ask({ question, mode: 'vault', route: 'auto', history: [] });
    expect(second.answer.providerId).toBe('ollama');
    expect(second.replacedLocalAnswer).toBeUndefined();
    expect(second.quality?.local.coverage).toBeGreaterThan(0.7);
    expect(second.lessons.map((lesson) => lesson.id)).toEqual([store.list()[0].id]);
    expect(second.notice).toContain('gelernt');

    // Entscheidend: die Cloud wurde kein zweites Mal gebraucht
    expect(cloudCalls()).toBe(1);

    // Und das Gelernte stand wirklich in der Anfrage an das lokale Modell
    const sent = JSON.parse(
      server!.requests.filter((request) => request.url === '/api/chat').at(-1)!.body,
    ) as { messages: Array<{ role: string; content: string }> };
    const lastMessage = sent.messages.at(-1)!.content;
    expect(lastMessage).toContain('GELERNTES WISSEN');
    expect(lastMessage).toContain('[W1]');
    expect(lastMessage).toContain('15. November');
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('[W1]');

    // Statistik: die Lektion wurde als benutzt vermerkt und der Verlauf zeigt den Sprung
    const snapshot = store.snapshot();
    expect(snapshot.lessons).toBe(1);
    expect(store.list()[0].usedCount).toBeGreaterThan(0);

    const trend = store.qualityTrend();
    expect(trend).toHaveLength(2);
    expect(trend[0].kind).toBe('upgrade');
    expect(trend[0].local).toBeLessThan(0.4); // schwache lokale Antwort
    expect(trend[0].cloud ?? 0).toBeGreaterThan(0.7); // starke Cloud-Antwort
    expect(trend[1].local).toBeGreaterThan(0.6); // lokale Antwort nach dem Lernen

    // Mitteilung an den Nutzer: das Gelernte kam zum Einsatz
    expect(second.notice).toContain('passende Lektion');
  });

  it('verbessert sich sichtbar über mehrere Runden (messbare Qualität)', async () => {
    const question = 'Was ist der Stand bei Projekt Alpha?';
    const { assistant, store } = await setup();

    const before = (await assistant.ask({ question, mode: 'vault', route: 'auto', history: [] })).quality!;
    expect(before.local.coverage).toBeLessThan(0.4);

    // Ab hier ist das Gelernte vorhanden -> lokale Antworten werden besser
    const after = (await assistant.ask({ question, mode: 'vault', route: 'auto', history: [] })).quality!;
    expect(after.local.coverage).toBeGreaterThan(before.local.coverage);
    expect(after.local.coverage - before.local.coverage).toBeGreaterThan(0.3);

    const snapshot = store.snapshot();
    expect(snapshot.modelStats.length).toBeGreaterThan(0);
    expect(store.historyText(5).join('\n')).toMatch(/lokal \d+ %/);
  });

  it('fragt nach ("nachfragen"-Modus) statt automatisch zu merken', async () => {
    const { assistant, store } = await setup({ learning: { saveMode: 'ask' } });
    const result = await assistant.ask({ question: 'Wann endet Projekt Alpha und was ist offen?', mode: 'vault', route: 'auto', history: [] });

    expect(store.count()).toBe(0);
    expect(result.pendingLesson).toBeTruthy();
    expect(result.pendingLesson?.question).toContain('Projekt Alpha');

    // Erst der Klick in der Oberfläche speichert
    const saved = await assistant.saveLesson(result.pendingLesson!);
    expect(saved.saved).toBe(true);
    expect(store.count()).toBe(1);
  });

  it('lernt nicht, wenn nur Ausweich-Antworten gewünscht sind und keine Ausweichung nötig war', async () => {
    const { assistant, store } = await setup({ learning: { learnFrom: 'escalations' } });
    // Cloud direkt gewählt, lokal ist gut -> keine Ausweichung, also auch kein Lernen
    const result = await assistant.ask({ question: 'Wann endet Projekt Alpha?', mode: 'vault', route: 'cloud', history: [] });
    expect(result.answer.providerId).toBe('openai');
    expect(store.count()).toBe(0);
    expect(result.learned).toBeUndefined();
  });

  it('lernt aus jeder Cloud-Antwort, wenn so eingestellt', async () => {
    const { assistant, store } = await setup({ learning: { learnFrom: 'all' } });
    await assistant.ask({ question: 'Wann endet Projekt Alpha?', mode: 'vault', route: 'cloud', history: [] });
    expect(store.count()).toBe(1);
  });

  it('lernt nichts aus einer fehlerhaften Cloud-Antwort', async () => {
    const { assistant, store } = await setup({
      cloudHandler: (res) => {
        json(res, 429, { error: { message: 'Rate limit' } });
      },
    });
    await expect(assistant.ask({ question: 'Wann endet Projekt Alpha?', mode: 'vault', route: 'cloud', history: [] })).rejects.toThrow();
    expect(store.count()).toBe(0);
  });

  it('macht eine Nutzerkorrektur verbindlich und nimmt sie ins lokale Modell auf', async () => {
    const { assistant, store, notes } = await setup();
    await assistant.ask({ question: 'Was ist der Stand bei Projekt Alpha?', mode: 'vault', route: 'auto', history: [] });
    const lesson = store.list()[0];

    await assistant.correctLesson(lesson.id, 'Verbindlich: Abgabetermin ist der 20. November (nicht der 15.).');
    const corrected = store.get(lesson.id)!;
    expect(corrected.correction).toContain('20. November');
    expect(corrected.reason).toBe('correction');
    expect(corrected.rating).toBe('good');
    // Die Korrektur steht in der Notiz im Vault (dadurch auch im GitHub-Backup)
    const noteContent = [...notes.files.values()][0];
    expect(noteContent).toContain('Deine Korrektur (verbindlich)');
    expect(noteContent).toContain('20. November');

    // Sie fließt als Regel ins lokale Modell ein
    const settings = (assistant as unknown as { deps: { settings: () => JarvisSettings } }).deps.settings();
    expect(settings.learning.systemHints.join(' ')).toContain('20. November');

    const distiller = new Distiller({
      ollama: { createModel: async () => undefined, deleteModel: async () => undefined, listModels: async () => [] },
      learning: () => settings.learning,
      local: () => settings.local,
      lessons: () => store.list(),
    });
    const plan = distiller.plan();
    expect(plan.rules.join(' ')).toContain('20. November');
    expect(plan.modelfile).toContain('Korrigierte Fassung (verbindlich)');
  });

  it('mischt Notizwissen und gelerntes Wissen richtig', async () => {
    const { assistant } = await setup();
    const first = await assistant.ask({ question: 'Welche Rechnung ist offen?', mode: 'vault', route: 'auto', history: [] });
    expect(first.learned?.saved).toBe(true);

    const second = await assistant.ask({ question: 'Welche Rechnung ist offen?', mode: 'vault', route: 'auto', history: [] });
    const userMessage = second.userMessage;
    expect(userMessage).toContain('NOTIZ-AUSSCHNITTE AUS DEM VAULT');
    expect(userMessage).toContain('GELERNTES WISSEN');
    // Beides steht in der Aufgabe: Quellen und Lektionen
    expect(userMessage).toContain('[Q1]');
    expect(userMessage).toContain('[W1]');
  });

  it('läuft auch mit abgeschaltetem Lernen unverändert', async () => {
    const { assistant, store, cloudCalls } = await setup({ learning: { enabled: false } });
    const result = await assistant.ask({ question: 'Wann endet Projekt Alpha?', mode: 'vault', route: 'auto', history: [] });
    expect(result.answer.providerId).toBe('openai');
    expect(store.count()).toBe(0);
    expect(result.lessons).toHaveLength(0);
    expect(cloudCalls()).toBe(1);
    const sent = JSON.parse(server!.requests.filter((request) => request.url === '/api/chat').at(-1)!.body) as {
      messages: Array<{ content: string }>;
    };
    expect(sent.messages.at(-1)!.content).not.toContain('GELERNTES WISSEN');
  });
});
