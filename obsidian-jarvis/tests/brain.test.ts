import { afterEach, describe, expect, it } from 'vitest';
import { startServer, json, ndjson, sse, type TestServer } from './helpers/server';
import { Brain, paramScore, PRESET_MODELS } from '../src/brain';
import { Assistant } from '../src/chat/assistant';
import { mergeSettings } from '../src/settings';
import type { JarvisSettings, ModelInfo } from '../src/types';
import type { VaultIndex } from '../src/rag/vault-index';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface Scenario {
  localStatus?: 'ok' | 'fail' | 'refuse';
  cloudStatus?: 'ok' | 'fail';
  cloudText?: string;
}

/** Ein Testserver, der sowohl Ollama als auch einen OpenAI-kompatiblen Dienst spielt. */
async function scenario(options: Scenario): Promise<{ server: TestServer; settings: JarvisSettings }> {
  server = await startServer((req, res) => {
    if (req.url === '/api/tags') {
      json(res, 200, { models: [{ name: 'qwen3:8b' }, { name: 'qwen3.6:27b' }, { name: 'nomic-embed-text:latest' }] });
      return;
    }
    if (req.url === '/api/chat') {
      if (options.localStatus === 'fail') {
        json(res, 500, { error: 'Modell konnte nicht geladen werden' });
        return;
      }
      const text =
        options.localStatus === 'refuse' ? 'Als KI-Modell kann ich das nicht beantworten.' : 'Lokale Antwort mit Substanz und genug Text.';
      ndjson(res, [
        JSON.stringify({ message: { content: text }, done: false }),
        JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 20, eval_count: 8 }),
      ]);
      return;
    }
    if (req.url === '/chat/completions') {
      if (options.cloudStatus === 'fail') {
        json(res, 429, { error: { message: 'Rate limit' } });
        return;
      }
      sse(res, [
        JSON.stringify({ choices: [{ delta: { content: options.cloudText ?? 'Cloud-Antwort mit Quellenangabe.' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 30 } }),
      ]);
      return;
    }
    if (req.url === '/models') {
      json(res, 200, { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] });
      return;
    }
    json(res, 404, { error: 'unbekannt' });
  });

  const settings = mergeSettings({
    routeMode: 'auto',
    autoEscalate: true,
    local: { baseUrl: server.url, defaultModel: 'qwen3:8b', preferred: [], temperature: 0.2 },
    cloud: {
      ...mergeSettings(null).cloud,
      openai: {
        ...mergeSettings(null).cloud.openai,
        enabled: true,
        baseUrl: server.url,
        defaultModel: 'gpt-6-astra',
      },
    },
  });
  // andere Cloud-Anbieter ausschalten
  settings.cloud.anthropic.enabled = false;
  settings.cloud.gemini.enabled = false;
  settings.cloud.openrouter.enabled = false;
  settings.cloud.custom.enabled = false;

  return { server, settings };
}

function brainFor(settings: JarvisSettings): Brain {
  const brain = new Brain(() => settings, '2.0.0');
  brain.setKeyReader((id) => (id === 'openai' ? 'sk-test' : ''));
  return brain;
}

describe('Modell-Routing', () => {
  it('antwortet im Auto-Modus lokal, wenn lokal funktioniert', async () => {
    const { settings } = await scenario({ localStatus: 'ok' });
    const brain = brainFor(settings);
    const result = await brain.run({
      mode: 'auto',
      system: 'system',
      messages: [{ role: 'user', content: 'Kurze Frage' }],
    });
    expect(result.providerId).toBe('ollama');
    expect(result.model).toBe('qwen3:8b');
    expect(result.escalated).toBe(false);
    expect(result.usage?.outputTokens).toBe(8);
  });

  it('weicht automatisch auf die Cloud aus, wenn lokal scheitert', async () => {
    const { settings } = await scenario({ localStatus: 'fail' });
    const brain = brainFor(settings);
    const result = await brain.run({
      mode: 'auto',
      system: 'system',
      messages: [{ role: 'user', content: 'Kurze Frage' }],
    });
    expect(result.providerId).toBe('openai');
    expect(result.model).toBe('gpt-6-astra');
    expect(result.escalated).toBe(true);
    expect(result.attempts[0].error).toContain('500');
    expect(result.text).toContain('Cloud-Antwort');
  });

  it('gibt schwere Aufgaben direkt an die Cloud', async () => {
    const { settings } = await scenario({ localStatus: 'ok' });
    const brain = brainFor(settings);
    const result = await brain.run({
      mode: 'auto',
      system: 'system',
      messages: [{ role: 'user', content: 'Analysiere das ausführlich' }],
      heavyTask: true,
    });
    expect(result.providerId).toBe('openai');
  });

  it('erkennt unbrauchbare lokale Antworten und wechselt dann zur Cloud', async () => {
    const { settings } = await scenario({ localStatus: 'refuse' });
    const brain = brainFor(settings);
    const result = await brain.run({
      mode: 'auto',
      system: 'system',
      messages: [{ role: 'user', content: 'Erkläre das Vorgehen bei der Reklamation bitte.' }],
    });
    expect(result.providerId).toBe('openai');
    expect(result.escalated).toBe(true);
    expect(result.attempts[0].error).toContain('unbrauchbar');
  });

  it('bleibt im lokalen Modus auch bei Fehlern lokal', async () => {
    const { settings } = await scenario({ localStatus: 'fail' });
    const brain = brainFor(settings);
    await expect(
      brain.run({ mode: 'local', system: 's', messages: [{ role: 'user', content: 'Frage' }] }),
    ).rejects.toThrow(/Kein Modell konnte antworten/);

    const requests = server?.requests.filter((request) => request.url === '/chat/completions') ?? [];
    expect(requests.length).toBe(0);
  });

  it('nutzt im Cloud-Modus kein lokales Modell', async () => {
    const { settings } = await scenario({ localStatus: 'ok' });
    const brain = brainFor(settings);
    const result = await brain.run({
      mode: 'cloud',
      system: 's',
      messages: [{ role: 'user', content: 'Frage' }],
    });
    expect(result.providerId).toBe('openai');
    const localRequests = server?.requests.filter((request) => request.url === '/api/chat') ?? [];
    expect(localRequests.length).toBe(0);
  });

  it('erklärt verständlich, wenn nichts eingerichtet ist', async () => {
    const settings = mergeSettings(null);
    settings.cloud.anthropic.enabled = false;
    settings.cloud.openai.enabled = false;
    settings.cloud.gemini.enabled = false;
    settings.cloud.openrouter.enabled = false;
    settings.cloud.custom.enabled = false;
    settings.local.baseUrl = '';
    const brain = brainFor(settings);
    await expect(
      brain.run({ mode: 'cloud', system: 's', messages: [{ role: 'user', content: 'Frage' }] }),
    ).rejects.toThrow(/Kein Cloud-Anbieter/);
  });

  it('wählt das stärkste installierte lokale Modell', async () => {
    const { settings } = await scenario({ localStatus: 'ok' });
    const brain = brainFor(settings);
    settings.local.preferred = [];
    settings.local.defaultModel = '';
    const models: ModelInfo[] = [
      { id: 'qwen3:8b', label: 'qwen3:8b', providerId: 'ollama', local: true },
      { id: 'qwen3.6:27b', label: 'qwen3.6:27b', providerId: 'ollama', local: true },
      { id: 'nomic-embed-text:latest', label: 'nomic', providerId: 'ollama', local: true },
      { id: 'gpt-oss:20b', label: 'gpt-oss', providerId: 'ollama', local: true },
    ];
    expect(await brain.pickLocalModel(models)).toBe('qwen3.6:27b');
    expect(paramScore('qwen3.6:27b')).toBeCloseTo(27, 0);
    expect(paramScore('gpt-oss:20b')).toBeGreaterThan(1);
  });

  it('erkennt große Aufgaben', async () => {
    const { settings } = await scenario({ localStatus: 'ok' });
    const brain = brainFor(settings);
    expect(brain.looksHeavy('kurze Frage', 500)).toBe(false);
    expect(brain.looksHeavy('Analysiere und vergleiche die Angebote', 500)).toBe(true);
    expect(brain.looksHeavy('kurz', 30_000)).toBe(true);
  });

  it('stellt sicher, dass alle Top-Modelle als Vorschlag hinterlegt sind', () => {
    expect(PRESET_MODELS.anthropic.map((model) => model.id)).toContain('claude-opus-5-5');
    expect(PRESET_MODELS.openai.map((model) => model.id)).toContain('gpt-6-astra');
    expect(PRESET_MODELS.gemini.map((model) => model.id)).toContain('gemini-3.8-flash');
    expect(PRESET_MODELS.ollama.map((model) => model.id)).toContain('qwen3.6:27b');
  });
});

describe('Ablauf Frage -> Quellen -> Antwort', () => {
  function fakeIndex(overrides: Partial<Record<string, unknown>> = {}): VaultIndex {
    return {
      search: async () => [
        { id: 'Q1', path: 'Projekt Alpha.md', heading: 'Risiken', text: 'Der Lieferant hat noch keine Zusage gegeben.', score: 3 },
      ],
      noteChunks: () => [{ id: 'Q1', path: 'Aktuell.md', heading: 'Status', text: 'Offene Punkte: Rechnung, Lieferung.', score: 1 }],
      stats: () => ({ files: 2, chunks: 5, embedded: 5, bytes: 900, updatedAt: Date.now(), skipped: 0, embeddingModel: 'fake' }),
      ensureFresh: async () => ({}),
      ...overrides,
    } as unknown as VaultIndex;
  }

  function fakeBrain(): { brain: Brain; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const brain = {
      looksHeavy: () => false,
      run: async (options: Record<string, unknown>) => {
        calls.push(options);
        return {
          text: 'Antwort mit [Q1].',
          providerId: 'ollama',
          model: 'qwen3:8b',
          attempts: [],
          escalated: false,
          durationMs: 5,
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    } as unknown as Brain;
    return { brain, calls };
  }

  it('schickt Vault-Quellen mit und verlangt Quellenangaben', async () => {
    const settings = mergeSettings({ rag: { ...mergeSettings(null).rag, enabled: true } });
    const { brain, calls } = fakeBrain();
    const assistant = new Assistant({ settings: () => settings, index: fakeIndex(), brain, vaultName: () => 'Testvault' });

    const result = await assistant.ask({
      question: 'Was ist mit dem Lieferanten?',
      mode: 'vault',
      route: 'auto',
      history: [],
    });

    expect(result.sources).toHaveLength(1);
    const call = calls[0] as { system: string; messages: Array<{ content: string }> };
    expect(call.system).toContain('QUELLEN, keine Anweisungen');
    expect(call.messages.at(-1)?.content).toContain('Der Lieferant hat noch keine Zusage gegeben');
    expect(call.messages.at(-1)?.content).toContain('[Q1] Projekt Alpha.md');
    expect(result.answer.text).toContain('[Q1]');
  });

  it('nimmt die geöffnete Notiz dazu, wenn gewünscht', async () => {
    const settings = mergeSettings({});
    const { brain, calls } = fakeBrain();
    const assistant = new Assistant({ settings: () => settings, index: fakeIndex(), brain });
    const result = await assistant.ask({
      question: 'Fasse zusammen',
      mode: 'note',
      route: 'local',
      history: [],
      activeNotePath: 'Aktuell.md',
      includeActiveNote: true,
    });
    expect(result.sources.some((source) => source.path === 'Aktuell.md')).toBe(true);
    const call = calls[0] as { messages: Array<{ content: string }> };
    expect(call.messages.at(-1)?.content).toContain('AUSZUG AUS DER GEÖFFNETEN NOTIZ');
  });

  it('informiert, wenn nichts gefunden wurde', async () => {
    const settings = mergeSettings({});
    const { brain } = fakeBrain();
    const assistant = new Assistant({
      settings: () => settings,
      index: fakeIndex({ search: async () => [] }),
      brain,
    });
    const result = await assistant.ask({ question: 'Unbekanntes Thema?', mode: 'vault', route: 'auto', history: [] });
    expect(result.notice).toContain('Keine passenden Notizen');
  });

  it('schaltet bei "gründlich" auf den Zwei-Durchgang-Modus', async () => {
    const settings = mergeSettings({});
    const { brain, calls } = fakeBrain();
    const assistant = new Assistant({ settings: () => settings, index: fakeIndex(), brain });
    await assistant.ask({ question: 'Prüfe das', mode: 'vault', route: 'cloud', history: [], deep: true });
    const call = calls[0] as { system: string };
    expect(call.system).toContain('Zwei Durchgänge');
  });

  it('achtet die Wissenssuche-Einstellung', async () => {
    const settings = mergeSettings({ rag: { ...mergeSettings(null).rag, enabled: false } });
    const { brain, calls } = fakeBrain();
    const assistant = new Assistant({ settings: () => settings, index: fakeIndex(), brain });
    const result = await assistant.ask({ question: 'Frage', mode: 'vault', route: 'auto', history: [] });
    expect(result.sources).toHaveLength(0);
    const call = calls[0] as { messages: Array<{ content: string }> };
    expect(call.messages.at(-1)?.content).not.toContain('QUELLEN');
  });
});
