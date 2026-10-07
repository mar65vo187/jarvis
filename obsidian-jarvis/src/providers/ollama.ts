/** Ollama-Anbindung: lokale Modelle, Embeddings, Modellverwaltung. */
import { getJson, isAbortError, postJson, streamRequest, humanizeHttpError } from '../util/http';
import { formatBytes } from '../util/format';
import type { ChatRequest, ChatResult, ModelInfo } from '../types';
import type { Provider } from './types';

export interface OllamaTag {
  name: string;
  model: string;
  size?: number;
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

export interface OllamaTagsResponse {
  models?: OllamaTag[];
}

export interface OllamaShowResponse {
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  modelfile?: string;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama (lokal)';
  readonly local = true;

  constructor(
    private baseUrl: () => string,
    private options: () => {
      numCtx: number;
      temperature: number;
      keepAlive: string;
      preferred: string[];
    },
  ) {}

  private url(path: string): string {
    return `${this.baseUrl().replace(/\/+$/, '')}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await getJson<OllamaTagsResponse>({ url: this.url('/api/tags'), timeoutMs: 8000, retries: 0 });
    const preferred = this.options().preferred ?? [];
    const models = (data.models ?? []).map((tag) => {
      const id = tag.name;
      const size = tag.size ? formatBytes(tag.size) : '';
      const params = tag.details?.parameter_size ?? '';
      const isEmbedding = /\b(embed|bge|nomic-embed|mxbai)/i.test(id);
      const note = [isEmbedding ? 'Embedding-Modell' : 'lokal', params, size].filter(Boolean).join(' · ');
      return { id, label: id, providerId: 'ollama' as const, local: true, note };
    });
    models.sort((a, b) => {
      const ai = preferred.indexOf(a.id);
      const bi = preferred.indexOf(b.id);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.id.localeCompare(b.id);
    });
    return models;
  }

  async show(model: string): Promise<OllamaShowResponse> {
    const { json } = await postJson<OllamaShowResponse>({
      url: this.url('/api/show'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      timeoutMs: 8000,
      retries: 0,
    });
    return json;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const opts = this.options();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
      keep_alive: opts.keepAlive,
      options: {
        num_ctx: opts.numCtx,
        temperature: request.temperature ?? opts.temperature,
      },
    };

    let text = '';
    let streamed = false;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let thinkingChars = 0;

    const handleObject = (obj: Record<string, unknown>) => {
      const message = obj.message as { content?: string; thinking?: string } | undefined;
      if (message?.thinking) thinkingChars += message.thinking.length;
      const chunk = message?.content ?? '';
      if (chunk) {
        text += chunk;
        request.onDelta?.(chunk);
      }
      if (obj.done) {
        const promptCount = obj.prompt_eval_count;
        const evalCount = obj.eval_count;
        if (typeof promptCount === 'number' || typeof evalCount === 'number') {
          usage = {
            inputTokens: typeof promptCount === 'number' ? promptCount : undefined,
            outputTokens: typeof evalCount === 'number' ? evalCount : undefined,
          };
        }
      }
      if (obj.error) throw new Error(String(obj.error));
    };

    const result = await streamRequest({
      url: this.url('/api/chat'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
      streamFormat: 'ndjson',
      allowStream: request.allowStream !== false,
      timeoutMs: 600_000,
      retries: 0,
      onEvent: (event) => {
        if (!event.data || event.data === '[DONE]') return;
        try {
          const obj = JSON.parse(event.data) as Record<string, unknown>;
          handleObject(obj);
        } catch {
          // unvollständige Zeile ignorieren
        }
      },
    });

    if (!result.streamed && result.text) {
      // Kein Streaming möglich: der ganze Text kam auf einmal (NDJSON oder JSON).
      const lines = result.text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length <= 1) {
        const obj = JSON.parse(result.text) as Record<string, unknown>;
        handleObject(obj);
        streamed = false;
      } else {
        for (const line of lines) {
          try {
            handleObject(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // unvollständige Zeile ignorieren
          }
        }
      }
    } else {
      streamed = true;
    }

    if (!text && !request.signal?.aborted) {
      throw new Error(
        'Das lokale Modell hat keinen Text geliefert.' +
          (thinkingChars > 0
            ? ' Es hat nur "gedacht". Bitte in den Einstellungen "Denken" abschalten oder ein Instruct-Modell wählen.'
            : ''),
      );
    }

    return {
      text,
      providerId: 'ollama',
      model: request.model,
      usage,
      aborted: request.signal?.aborted === true,
      buffered: !streamed,
      durationMs: Date.now() - started,
    };
  }

  /** Verfügbare Embedding-Modelle ermitteln. */
  async findEmbedModel(preferredList: string[]): Promise<string | null> {
    try {
      const models = await this.listModels();
      const names = models.map((m) => m.id);
      for (const want of preferredList) {
        const match = names.find((name) => name === want || name.startsWith(`${want}:`));
        if (match) return match;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Vektoren für mehrere Texte holen (mit Rückfall auf die alte API). */
  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][] | null> {
    if (!inputs.length) return [];
    try {
      const { json } = await postJson<{ embeddings?: number[][] }>({
        url: this.url('/api/embed'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: inputs, truncate: true }),
        timeoutMs: 120_000,
        retries: 0,
      });
      if (json.embeddings && json.embeddings.length === inputs.length) return json.embeddings;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      // weiter mit alter Schnittstelle
    }
    const out: number[][] = [];
    for (const input of inputs) {
      const { json } = await postJson<{ embedding?: number[] }>({
        url: this.url('/api/embeddings'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: input }),
        timeoutMs: 60_000,
        retries: 0,
      });
      if (!json.embedding) return null;
      out.push(json.embedding);
    }
    return out;
  }

  async unload(model: string): Promise<void> {
    await postJson({
      url: this.url('/api/generate'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      timeoutMs: 20_000,
      retries: 0,
    });
  }

  async warmup(model: string): Promise<void> {
    await postJson({
      url: this.url('/api/generate'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: ' ', keep_alive: this.options().keepAlive }),
      timeoutMs: 600_000,
      retries: 0,
    });
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const models = await this.listModels();
      if (!models.length) {
        return {
          ok: false,
          message: 'Ollama läuft, aber es ist kein Modell installiert. Im Terminal: ollama pull qwen3.6:27b',
        };
      }
      return {
        ok: true,
        message: `Ollama erreichbar. ${models.length} Modell(e) installiert: ${models.slice(0, 5).map((m) => m.id).join(', ')}${models.length > 5 ? ' …' : ''}`,
      };
    } catch (error) {
      return { ok: false, message: humanizeHttpError(error, 'Ollama') };
    }
  }

  /** Kontextgröße des Modells ermitteln (falls Ollama sie meldet). */
  async contextLength(model: string): Promise<number | undefined> {
    try {
      const info = await this.show(model);
      const values = Object.entries(info.model_info ?? {})
        .filter(([key]) => /context_length$/i.test(key))
        .map(([, value]) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (values.length) return Math.max(...values);
      return undefined;
    } catch {
      return undefined;
    }
  }
}
