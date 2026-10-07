import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { JarvisChatView, type JarvisChatHost } from '../src/chat/view';
import { SessionStore, createSession, sessionTitle } from '../src/chat/session';
import { mergeSettings } from '../src/settings';
import type { AnswerMode } from '../src/rag/prompt';

function makeHost(overrides: Partial<JarvisChatHost> = {}) {
  const settings = mergeSettings({ routeMode: 'local' });
  const sessions = new SessionStore([], async () => undefined);
  const askCalls: Array<Record<string, unknown>> = [];
  const host = {
    app: new App(),
    settings,
    sessions,
    brain: { invalidateModelCache: () => undefined } as never,
    index: { stats: () => ({ files: 3, chunks: 9, embedded: 9, embeddingModel: 'fake', bytes: 100, updatedAt: 0, skipped: 0 }) } as never,
    listAllModels: async () => [
      { id: 'qwen3:8b', label: 'qwen3:8b', providerId: 'ollama' as const, local: true, note: 'lokal' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', providerId: 'anthropic' as const, local: false, note: 'Top' },
    ],
    saveSettings: async () => undefined,
    insertText: async () => undefined,
    openSettings: () => undefined,
    notify: () => undefined,
    refreshIndex: async () => ({ files: 3, chunks: 9, embedded: 9, bytes: 0, updatedAt: 0, skipped: 0, embeddingModel: null }),
    activeNotePath: () => 'Aktuell.md',
    assistant: {
      ask: async (options: Record<string, unknown>) => {
        askCalls.push(options);
        const onDelta = options.onDelta as ((chunk: string) => void) | undefined;
        onDelta?.('Antwort ');
        onDelta?.('mit [Q1].');
        return {
          answer: {
            text: 'Antwort mit [Q1].',
            providerId: 'ollama',
            model: 'qwen3:8b',
            attempts: [{ providerId: 'ollama', model: 'qwen3:8b' }],
            escalated: false,
            buffered: false,
            durationMs: 12,
            usage: { inputTokens: 200, outputTokens: 30 },
          },
          sources: [{ id: 'Q1', path: 'Notiz.md', heading: 'Titel', text: 'Inhalt', score: 2 }],
          system: 'system',
          userMessage: 'frage',
          heavy: false,
        };
      },
    } as never,
    ...overrides,
  } as unknown as JarvisChatHost;
  return { host, sessions, askCalls, settings };
}

function newView(host: JarvisChatHost) {
  return new JarvisChatView({} as never, host);
}

describe('Unterhaltungen', () => {
  it('erzeugt Titel aus der ersten Frage und begrenzt die Länge', () => {
    const session = createSession();
    session.turns.push({ role: 'user', content: 'Wie ist der Stand bei Projekt Alpha und was fehlt noch?', at: Date.now() });
    expect(sessionTitle(session)).toContain('Wie ist der Stand');
    expect(sessionTitle(session).length).toBeLessThanOrEqual(49);
  });

  it('speichert Verlauf, wechselt und löscht Sitzungen', async () => {
    const saved: unknown[] = [];
    const store = new SessionStore([], async (sessions) => {
      saved.push(sessions);
    });
    const first = store.active();
    store.addTurn({ role: 'user', content: 'Hallo', at: Date.now() });
    expect(store.active().turns).toHaveLength(1);
    expect(saved.length).toBeGreaterThan(0);

    const second = store.startNew();
    expect(second.id).not.toBe(first.id);
    store.addTurn({ role: 'user', content: 'Zweite Frage', at: Date.now() });
    expect(store.list()).toHaveLength(2);

    store.select(first.id);
    expect(store.active().id).toBe(first.id);
    store.remove(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.active().id).toBe(second.id);
  });

  it('begrenzt die Anzahl der Beiträge je Unterhaltung', () => {
    const store = new SessionStore([], async () => undefined);
    for (let index = 0; index < 60; index++) {
      store.addTurn({ role: 'user', content: `Frage ${index}`, at: Date.now() });
    }
    expect(store.active().turns.length).toBeLessThanOrEqual(40);
    expect(store.active().turns.at(-1)?.content).toBe('Frage 59');
  });
});

describe('Chat-Oberfläche', () => {
  it('baut die Bedienelemente auf und zeigt den Status', async () => {
    const { host } = makeHost();
    const view = newView(host);
    await view.onOpen();

    expect(view.contentEl.querySelector('.jarvis-toolbar')).toBeTruthy();
    expect(view.contentEl.querySelector('.jarvis-input')).toBeTruthy();
    expect(view.contentEl.querySelector('.jarvis-status')?.textContent).toContain('Lokal');
    const options = Array.from(view.contentEl.querySelectorAll<HTMLOptionElement>('.jarvis-model-select option'));
    expect(options.map((option) => option.value)).toContain('ollama:qwen3:8b');
    expect(options.map((option) => option.value)).toContain('anthropic:claude-opus-5-5');
    // Umschalten auf Cloud schaltet den Modus mit um
    const select = view.contentEl.querySelector<HTMLSelectElement>('.jarvis-model-select')!;
    select.value = 'anthropic:claude-opus-5-5';
    await select.onchange?.(new Event('change'));
    expect(host.settings.routeMode).toBe('cloud');
  });

  it('sendet die Frage, streamt die Antwort und zeigt Quellen', async () => {
    const { host, askCalls, sessions } = makeHost();
    const view = newView(host);
    await view.onOpen();

    const input = view.contentEl.querySelector<HTMLTextAreaElement>('.jarvis-input')!;
    input.value = 'Was ist mit dem Lieferanten?';
    (view as unknown as { send: () => Promise<void> }).send = (view as unknown as { send: () => Promise<void> }).send.bind(view);
    await (view as unknown as { ask: (q: string, m: AnswerMode) => Promise<void> }).ask(
      'Was ist mit dem Lieferanten?',
      'vault',
    );

    expect(askCalls).toHaveLength(1);
    expect(askCalls[0].question).toBe('Was ist mit dem Lieferanten?');
    expect(askCalls[0].route).toBe('local');

    const text = view.contentEl.textContent ?? '';
    expect(text).toContain('Antwort mit');
    expect(text).toContain('[Q1] Notiz.md');
    expect(text).toContain('lokal · qwen3:8b');
    expect(text).toContain('200 → 30 Token');
    expect(sessions.active().turns).toHaveLength(2);
    expect(sessions.active().turns[1].sources?.[0].path).toBe('Notiz.md');
  });

  it('zeigt Fehler mit Hilfestellung und bietet den Cloud-Weg an', async () => {
    const { host } = makeHost({
      assistant: {
        ask: async () => {
          throw new Error('Keine Verbindung. Mögliche Ursachen: Dienst läuft nicht');
        },
      } as never,
    });
    const view = newView(host);
    await view.onOpen();
    await (view as unknown as { ask: (q: string, m: AnswerMode) => Promise<void> }).ask('Frage', 'vault');

    const error = view.contentEl.querySelector('.jarvis-error');
    expect(error?.textContent).toContain('Keine Verbindung');
    expect(error?.textContent).toContain('ollama serve');
    const retry = view.contentEl.querySelector<HTMLButtonElement>('.jarvis-action');
    expect(retry?.textContent).toContain('Cloud');
    expect(view.contentEl.querySelector('.jarvis-actions')).toBeNull();
  });

  it('sendet den Abbruch an das Modell weiter', async () => {
    let received: AbortSignal | undefined;
    const { host } = makeHost({
      assistant: {
        ask: async (options: Record<string, unknown>) => {
          received = options.signal as AbortSignal;
          return {
            answer: { text: 'ok', providerId: 'ollama', model: 'qwen3:8b', attempts: [], escalated: false, durationMs: 1 },
            sources: [],
            system: '',
            userMessage: '',
            heavy: false,
          };
        },
      } as never,
    });
    const view = newView(host);
    await view.onOpen();
    await (view as unknown as { ask: (q: string, m: AnswerMode) => Promise<void> }).ask('Frage', 'vault');
    expect(received).toBeInstanceOf(AbortSignal);
  });

  it('übernimmt den Standardwert für "geöffnete Notiz einbeziehen"', async () => {
    const { host } = makeHost();
    host.settings.rag.includeActiveNote = false;
    const view = newView(host);
    await view.onOpen();
    const toggle = view.contentEl.querySelector<HTMLInputElement>('.jarvis-checkbox input')!;
    expect(toggle.checked).toBe(false);
  });

  it('schaltet gründliche Aufgaben in den Cloud-Modus', async () => {
    const { host, settings } = makeHost();
    const view = newView(host);
    await view.onOpen();
    await view.askExternal('Fasse zusammen', 'summarize', 'cloud');
    expect(settings.routeMode).toBe('cloud');
    expect(view.contentEl.textContent).toContain('Cloud');
  });

  it('zeigt Ausweich-Hinweis, wenn lokal auf Cloud gewechselt wurde', async () => {
    const { host } = makeHost({
      assistant: {
        ask: async () => ({
          answer: {
            text: 'Cloud-Antwort',
            providerId: 'anthropic',
            model: 'claude-opus-5-5',
            attempts: [
              { providerId: 'ollama', model: 'qwen3:8b', error: 'lokal nicht erreichbar' },
              { providerId: 'anthropic', model: 'claude-opus-5-5' },
            ],
            escalated: true,
            buffered: true,
            durationMs: 2500,
            usage: { inputTokens: 1000, outputTokens: 200 },
          },
          sources: [],
          system: '',
          userMessage: '',
          heavy: false,
        }),
      } as never,
    });
    const view = newView(host);
    await view.onOpen();
    await (view as unknown as { ask: (q: string, m: AnswerMode) => Promise<void> }).ask('Frage', 'vault');
    const text = view.contentEl.textContent ?? '';
    expect(text).toContain('Ausweichkette');
    expect(text).toContain('auf Cloud ausgewichen');
    expect(text).toContain('ohne Streaming');
  });

  it('erzeugt beim Klick auf eine Quelle einen funktionierenden Verweis', async () => {
    const { host } = makeHost();
    const view = newView(host);
    await view.onOpen();
    await (view as unknown as { ask: (q: string, m: AnswerMode) => Promise<void> }).ask('Frage', 'vault');
    const chip = view.contentEl.querySelector<HTMLButtonElement>('.jarvis-source-chip');
    expect(chip?.textContent).toContain('[Q1] Notiz.md');
    expect(() => chip?.click()).not.toThrow();
  });

  it('räumt beim Schließen die laufende Anfrage auf', async () => {
    const { host } = makeHost();
    const view = newView(host);
    await view.onOpen();
    const abort = vi.fn();
    (view as unknown as { controller: { abort: () => void } | null }).controller = { abort };
    await view.onClose();
    expect(abort).toHaveBeenCalled();
  });
});
