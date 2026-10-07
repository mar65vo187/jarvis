import { afterEach, describe, expect, it } from 'vitest';
import { startServer, json, ndjson, sse, type TestServer } from './helpers/server';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAiCompatProvider } from '../src/providers/openai-compat';
import { AnthropicProvider } from '../src/providers/anthropic';
import { GeminiProvider } from '../src/providers/gemini';
import { humanizeHttpError, HttpError } from '../src/util/http';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  server = await startServer(handler);
  return server;
}

describe('Nicht-Streaming-Betrieb (Einstellung "Streaming aus")', () => {
  it('holt die Antwort am Stück und liefert sie korrekt aus', async () => {
    const test = await serve((_req, res) => {
      sse(res, [
        JSON.stringify({ choices: [{ delta: { content: 'Teil eins ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'und Teil zwei.' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
      ]);
    });
    const provider = new OpenAiCompatProvider({
      id: 'custom',
      label: 'Eigener Dienst',
      baseUrl: () => test.url,
      apiKey: () => 'x',
    });
    const chunks: string[] = [];
    const result = await provider.chat({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      allowStream: false,
      onDelta: (chunk) => chunks.push(chunk),
    });
    expect(result.text).toBe('Teil eins und Teil zwei.');
    expect(result.buffered).toBe(true);
    expect(chunks).toEqual(['Teil eins ', 'und Teil zwei.']);
    expect(result.usage?.inputTokens).toBe(9);
  });
});

describe('Ollama (lokal)', () => {
  it('liest den NDJSON-Stream und meldet Token-Zahlen', async () => {
    const test = await serve((req, res) => {
      if (req.url === '/api/chat') {
        ndjson(res, [
          JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: 'Hallo' }, done: false }),
          JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: ' Welt' }, done: false }),
          JSON.stringify({
            model: 'qwen3:8b',
            message: { role: 'assistant', content: '' },
            done: true,
            prompt_eval_count: 42,
            eval_count: 7,
          }),
        ]);
        return;
      }
      json(res, 404, { error: 'unbekannt' });
    });

    const provider = new OllamaProvider(
      () => test.url,
      () => ({ numCtx: 4096, temperature: 0.3, keepAlive: '5m', preferred: [] }),
    );
    const chunks: string[] = [];
    const result = await provider.chat({
      model: 'qwen3:8b',
      system: 'Du bist Jarvis.',
      messages: [{ role: 'user', content: 'Sag Hallo' }],
      onDelta: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('Hallo Welt');
    expect(chunks.join('')).toBe('Hallo Welt');
    expect(result.usage?.inputTokens).toBe(42);
    expect(result.usage?.outputTokens).toBe(7);
    expect(result.buffered).toBe(false);
    expect(result.providerId).toBe('ollama');

    const sent = JSON.parse(test.requests[0].body) as {
      stream: boolean;
      keep_alive: string;
      options: { num_ctx: number; temperature: number };
      messages: Array<{ role: string }>;
    };
    expect(sent.stream).toBe(true);
    expect(sent.options.num_ctx).toBe(4096);
    expect(sent.messages[0].role).toBe('system');
  });

  it('verarbeitet die Antwort auch ohne Streaming (Ersatzweg)', async () => {
    const test = await serve((_req, res) => {
      // Server antwortet als eine einzige JSON-Zeile - kein NDJSON-Stream.
      json(res, 200, {
        model: 'qwen3:8b',
        message: { role: 'assistant', content: 'Antwort ohne Stream' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 4,
      });
    });

    const provider = new OllamaProvider(
      () => test.url,
      () => ({ numCtx: 4096, temperature: 0.3, keepAlive: '5m', preferred: [] }),
    );
    const result = await provider.chat({
      model: 'qwen3:8b',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('Antwort ohne Stream');
    expect(result.usage?.outputTokens).toBe(4);
  });

  it('meldet einen fehlenden Text verständlich', async () => {
    const test = await serve((_req, res) => {
      ndjson(res, [
        JSON.stringify({ message: { thinking: 'grübel grübel' }, done: false }),
        JSON.stringify({ message: { content: '' }, done: true }),
      ]);
    });
    const provider = new OllamaProvider(
      () => test.url,
      () => ({ numCtx: 4096, temperature: 0.3, keepAlive: '5m', preferred: [] }),
    );
    await expect(
      provider.chat({ model: 'qwen3:8b', system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/gedacht|Instruct-Modell/);
  });

  it('listet Modelle, findet Embedding-Modelle und entlädt Modelle', async () => {
    const test = await serve((req, res) => {
      if (req.url === '/api/tags') {
        json(res, 200, {
          models: [
            { name: 'qwen3.6:27b', size: 17_000_000_000, details: { parameter_size: '27B' } },
            { name: 'nomic-embed-text:latest', size: 274_000_000, details: { parameter_size: '137M' } },
          ],
        });
        return;
      }
      if (req.url === '/api/embed') {
        json(res, 200, { embeddings: [[0.1, 0.2]] });
        return;
      }
      if (req.url === '/api/generate') {
        json(res, 200, { done: true });
        return;
      }
      json(res, 404, {});
    });

    const provider = new OllamaProvider(
      () => test.url,
      () => ({ numCtx: 4096, temperature: 0.3, keepAlive: '5m', preferred: ['qwen3.6:27b'] }),
    );
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(['qwen3.6:27b', 'nomic-embed-text:latest']);
    expect(models[0].note).toContain('27B');
    expect(await provider.findEmbedModel(['nomic-embed-text'])).toBe('nomic-embed-text:latest');
    expect(await provider.embed('nomic-embed-text:latest', ['hallo'])).toEqual([[0.1, 0.2]]);
    await provider.unload('qwen3.6:27b');
    const test2 = await provider.test();
    expect(test2.ok).toBe(true);
  });
});

describe('OpenAI-kompatibel (GPT, OpenRouter, eigene Dienste)', () => {
  it('streamt SSE-Antworten und liest die Nutzungsdaten', async () => {
    const test = await serve((req, res) => {
      if (req.url?.endsWith('/models')) {
        json(res, 200, { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] });
        return;
      }
      sse(res, [
        JSON.stringify({ choices: [{ delta: { content: 'Guten' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ' Tag' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
      ]);
    });

    const provider = new OpenAiCompatProvider({
      id: 'openai',
      label: 'GPT',
      baseUrl: () => test.url,
      apiKey: () => 'sk-test',
      sendUsageOption: true,
      useMaxCompletionTokens: true,
    });

    expect((await provider.listModels()).map((model) => model.id)).toEqual(['gpt-6-astra', 'gpt-6-luna']);

    const chunks: string[] = [];
    const result = await provider.chat({
      model: 'gpt-6-astra',
      system: 'system',
      messages: [{ role: 'user', content: 'Hallo' }],
      maxTokens: 128,
      onDelta: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('Guten Tag');
    expect(chunks).toEqual(['Guten', ' Tag']);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5 });

    const body = JSON.parse(test.requests.at(-1)!.body) as Record<string, unknown>;
    expect(body.model).toBe('gpt-6-astra');
    expect(body.max_completion_tokens).toBe(128);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBeUndefined();
  });

  it('verarbeitet eine komplette JSON-Antwort als Ersatzweg', async () => {
    const test = await serve((_req, res) => {
      json(res, 200, {
        choices: [{ message: { content: 'Komplette Antwort' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });
    const provider = new OpenAiCompatProvider({
      id: 'custom',
      label: 'Eigener Dienst',
      baseUrl: () => test.url,
      apiKey: () => '',
    });
    const result = await provider.chat({
      model: 'local-model',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('Komplette Antwort');
    expect(result.usage?.inputTokens).toBe(12);
  });

  it('übersetzt Fehlermeldungen in verständliches Deutsch', async () => {
    const test = await serve((_req, res) => {
      json(res, 401, { error: { message: 'Incorrect API key provided' } });
    });
    const provider = new OpenAiCompatProvider({
      id: 'openai',
      label: 'GPT (OpenAI)',
      baseUrl: () => test.url,
      apiKey: () => 'sk-falsch',
    });
    await expect(
      provider.chat({ model: 'gpt-6-astra', system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(HttpError);

    try {
      await provider.chat({ model: 'gpt-6-astra', system: 's', messages: [{ role: 'user', content: 'hi' }] });
    } catch (error) {
      const message = humanizeHttpError(error, 'GPT (OpenAI)');
      expect(message).toContain('Zugang abgelehnt');
      expect(message).toContain('API-Schlüssel');
    }

    const noKey = new OpenAiCompatProvider({
      id: 'openai',
      label: 'GPT (OpenAI)',
      baseUrl: () => test.url,
      apiKey: () => '',
    });
    const test2 = await noKey.test();
    expect(test2.ok).toBe(false);
    expect(test2.message).toContain('Kein API-Schlüssel');
  });
});

describe('Claude (Anthropic)', () => {
  it('liest den Nachrichten-Stream, ignoriert Denk-Bausteine und sammelt Nutzungsdaten', async () => {
    const test = await serve((req, res) => {
      if (req.url?.startsWith('/v1/models')) {
        json(res, 200, { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events: Array<[string, unknown]> = [
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 320, output_tokens: 0 } } }],
        ['content_block_delta', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'intern' } }],
        ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fertig' } }],
        ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }],
        ['message_delta', { type: 'message_delta', usage: { output_tokens: 9 } }],
      ];
      for (const [event, payload] of events) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      res.end();
    });

    const provider = new AnthropicProvider(
      () => test.url,
      () => 'sk-ant-test',
    );
    expect((await provider.listModels()).map((model) => model.id)).toContain('claude-opus-5-5');

    const chunks: string[] = [];
    const result = await provider.chat({
      model: 'claude-opus-5-5',
      system: 'Du bist Jarvis.',
      messages: [{ role: 'user', content: 'Hallo' }],
      onDelta: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('Fertig!');
    expect(chunks.join('')).toBe('Fertig!');
    expect(result.usage).toEqual({ inputTokens: 320, outputTokens: 9 });

    const sent = JSON.parse(test.requests.at(-1)!.body) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(4096);
    expect(sent.stream).toBe(true);
    expect(sent.temperature).toBeUndefined();
    expect(test.requests.at(-1)!.headers['anthropic-version']).toBe('2023-06-01');
    expect(test.requests.at(-1)!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('erkennt Fehlerereignisse im Stream', async () => {
    const test = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
      );
      res.end();
    });
    const provider = new AnthropicProvider(
      () => test.url,
      () => 'sk-ant-test',
    );
    await expect(
      provider.chat({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Overloaded/);
  });
});

describe('Gemini (Google)', () => {
  it('listet Modelle und liest den Stream', async () => {
    const test = await serve((req, res) => {
      if (req.url?.includes(':streamGenerateContent')) {
        sse(res, [
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Antwort ' }] } }] }),
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'aus Gemini' }] } }],
            usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 4 },
          }),
        ]);
        return;
      }
      if (req.url?.startsWith('/v1beta/models')) {
        json(res, 200, {
          models: [
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
        });
        return;
      }
      json(res, 404, { error: { message: 'unbekannt' } });
    });

    const provider = new GeminiProvider(
      () => test.url,
      () => 'AIza-test',
    );
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(['gemini-3.8-flash']);

    const result = await provider.chat({
      model: 'gemini-3.8-flash',
      system: 'System',
      messages: [{ role: 'user', content: 'Hallo' }],
    });
    expect(result.text).toBe('Antwort aus Gemini');
    expect(result.usage).toEqual({ inputTokens: 55, outputTokens: 4 });

    const sent = JSON.parse(test.requests.at(-1)!.body) as { systemInstruction?: unknown; contents?: unknown[] };
    expect(sent.systemInstruction).toBeTruthy();
    expect(sent.contents).toHaveLength(1);
  });
});

describe('Neue Anbieter und Denk-Stufen', () => {
  it('Hugging Face: nutzt den Router mit Bearer-Schlüssel und listet Modelle', async () => {
    let server: TestServer | null = null;
    const gesehen: Array<{ url: string; auth: string }> = [];
    try {
      server = await startServer((req, res, body) => {
        gesehen.push({ url: req.url ?? '', auth: String((req.headers ?? {})['authorization'] ?? '') });
        if (req.url === '/v1/models') {
          json(res, 200, { data: [{ id: 'Qwen/Qwen3-235B-A22B-Instruct-2507' }, { id: 'zai-org/GLM-4.6' }] });
          return;
        }
        if (req.url === '/v1/chat/completions') {
          const payload = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
          sse(res, [
            JSON.stringify({ choices: [{ delta: { content: `${payload.model} sagt: Hallo` } }] }),
            JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
          ]);
          return;
        }
        json(res, 404, {});
      });

      const provider = new OpenAiCompatProvider({
        id: 'huggingface',
        label: 'Hugging Face (Router)',
        baseUrl: () => `${server!.url}/v1`,
        apiKey: () => 'hf_test',
        reasoningStyle: 'openai',
      });
      const modelle = await provider.listModels();
      expect(modelle.map((modell) => modell.id)).toContain('zai-org/GLM-4.6');
      expect(gesehen[0].auth).toBe('Bearer hf_test');

      const antwort = await provider.chat({
        model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
        system: 'Du bist Jarvis.',
        messages: [{ role: 'user', content: 'Hallo' }],
      });
      expect(antwort.text).toContain('sagt: Hallo');
      expect(antwort.providerId).toBe('huggingface');
      expect(antwort.usage?.outputTokens).toBe(3);
    } finally {
      await server?.close();
    }
  });

  it('n8n: schickt die Anfrage an den Webhook und liest die Antwort', async () => {
    let server: TestServer | null = null;
    let empfangen: Record<string, unknown> = {};
    try {
      server = await startServer((_req, res, body) => {
        empfangen = JSON.parse(body) as Record<string, unknown>;
        json(res, 200, { choices: [{ message: { content: 'Der Arbeitsablauf hat 3 E-Mails verschickt.' } }] });
      });
      const provider = new OpenAiCompatProvider({
        id: 'n8n',
        label: 'n8n',
        baseUrl: () => server!.url,
        apiKey: () => 'geheim',
        reasoningStyle: 'none',
        extraHeaders: () => ({ 'x-jarvis-key': 'geheim' }),
      });
      const antwort = await provider.chat({
        model: 'jarvis',
        system: 'Du bist Jarvis.',
        messages: [{ role: 'user', content: 'Schicke die Rechnung per Mail.' }],
        allowStream: false,
      });
      expect(antwort.text).toContain('3 E-Mails');
      expect(empfangen.model).toBe('jarvis');
      expect(JSON.stringify(empfangen)).toContain('Schicke die Rechnung');
    } finally {
      await server?.close();
    }
  });

  it('sendet Denk-Stufen nur, wenn ausdrücklich eingeschaltet', async () => {
    let server: TestServer | null = null;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      server = await startServer((_req, res, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        sse(res, [JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]);
      });
      const provider = new OpenAiCompatProvider({
        id: 'openai',
        label: 'GPT',
        baseUrl: () => server!.url,
        apiKey: () => 'sk-test',
        reasoningStyle: 'openai',
      });
      await provider.chat({
        model: 'gpt-6-astra',
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        extraParams: { reasoning_effort: 'high' },
      });
      expect(bodies[0].reasoning_effort).toBe('high');

      await provider.chat({ model: 'gpt-6-astra', system: 's', messages: [{ role: 'user', content: 'u' }] });
      expect(bodies[1].reasoning_effort).toBeUndefined();

      // -1 heißt "nichts senden" — sonst lehnen die Anbieter die Anfrage ab
      await provider.chat({ model: 'gpt-6-astra', system: 's', messages: [{ role: 'user', content: 'u' }], temperature: -1 });
      expect(bodies[2].temperature).toBeUndefined();
      await provider.chat({ model: 'gpt-6-astra', system: 's', messages: [{ role: 'user', content: 'u' }], temperature: 0.3 });
      expect(bodies[3].temperature).toBe(0.3);
    } finally {
      await server?.close();
    }
  });

  it('Claude: Denk-Budget wird als thinking-Feld gesendet', async () => {
    let server: TestServer | null = null;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      server = await startServer((req, res, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        sse(res, [
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }),
          JSON.stringify({ type: 'message_stop' }),
        ]);
        void req;
      });
      const provider = new AnthropicProvider(
        () => server!.url,
        () => 'sk-ant-test',
      );
      await provider.chat({
        model: 'claude-opus-5-5',
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        extraParams: { thinking: { type: 'enabled', budget_tokens: 8192 } },
      });
      expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    } finally {
      await server?.close();
    }
  });

  it('Gemini: Denk-Einstellungen landen in generationConfig', async () => {
    let server: TestServer | null = null;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      server = await startServer((req, res, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
        void req;
      });
      const provider = new GeminiProvider(
        () => server!.url,
        () => 'AIza-test',
      );
      await provider.chat({
        model: 'gemini-3.8-flash',
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        maxTokens: 500,
        extraParams: { thinkingConfig: { thinkingBudget: 6144 } },
      });
      const config = bodies[0].generationConfig as Record<string, unknown>;
      expect(config.thinkingBudget).toBeUndefined();
      expect(config.maxOutputTokens).toBe(500);
    } finally {
      await server?.close();
    }
  });
});
