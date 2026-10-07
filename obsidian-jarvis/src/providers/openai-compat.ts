/**
 * OpenAI-kompatible Anbieter.
 * Deckt OpenAI direkt, OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio,
 * llama.cpp-Server, vLLM usw. ab - alles, was /chat/completions spricht.
 */
import {
  extractSsePayloads,
  getJson,
  humanizeHttpError,
  postJson,
  streamRequest,
} from '../util/http';
import type { ChatRequest, ChatResult, ModelInfo, ProviderId } from '../types';
import type { Provider } from './types';

interface OpenAiModelsResponse {
  data?: Array<{ id?: string; name?: string }>;
  models?: Array<{ id?: string; name?: string }>;
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string } | string;
}

export interface OpenAiCompatOptions {
  id: ProviderId;
  label: string;
  baseUrl: () => string;
  apiKey: () => string;
  /** Zusätzliche Kopfzeilen (z. B. OpenRouter-Ranking). */
  extraHeaders?: () => Record<string, string>;
  sendUsageOption?: boolean;
  /** Bei OpenAI direkt heißt das Limit max_completion_tokens. */
  useMaxCompletionTokens?: boolean;
  /** Wie Zusatzfelder fürs Nachdenken heißen (Standard: openai). */
  reasoningStyle?: 'openai' | 'openrouter' | 'none';
}

export class OpenAiCompatProvider implements Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly local = false;

  constructor(private options: OpenAiCompatOptions) {
    this.id = options.id;
    this.label = options.label;
  }

  private url(path: string): string {
    return `${this.options.baseUrl().replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const key = this.options.apiKey().trim();
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(this.options.extraHeaders?.() ?? {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.options.apiKey().trim()) throw new Error('Kein API-Schlüssel hinterlegt.');
    const data = await getJson<OpenAiModelsResponse>({
      url: this.url('/models'),
      headers: this.headers(),
      timeoutMs: 15_000,
    });
    const rows = data.data ?? data.models ?? [];
    return rows
      .map((row) => row.id ?? row.name ?? '')
      .filter(Boolean)
      .map((id) => ({ id, label: id, providerId: this.id, local: false, note: 'verfügbar' }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    // -1 bedeutet „nichts senden" (Top-Modelle haben eigene Vorgaben).
    if (request.temperature !== undefined && request.temperature >= 0) body.temperature = request.temperature;
    if (request.maxTokens && request.maxTokens > 0) {
      if (this.options.useMaxCompletionTokens) body.max_completion_tokens = request.maxTokens;
      else body.max_tokens = request.maxTokens;
    }
    if (this.options.sendUsageOption) body.stream_options = { include_usage: true };
    applyExtraParams(body, request.extraParams);

    let text = '';
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let reasoningChars = 0;
    let apiError = '';

    const handleChunk = (chunk: OpenAiChunk) => {
      if (chunk.error) {
        apiError = typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'Unbekannter Fehler';
        return;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      reasoningChars += (delta?.reasoning?.length ?? 0) + (delta?.reasoning_content?.length ?? 0);
      const piece = delta?.content ?? choice?.message?.content ?? '';
      if (piece) {
        text += piece;
        request.onDelta?.(piece);
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    };

    const result = await streamRequest({
      url: this.url('/chat/completions'),
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
      allowStream: request.allowStream !== false,
      timeoutMs: 600_000,
      retries: 1,
      onEvent: (event) => {
        if (!event.data || event.data === '[DONE]') return;
        try {
          handleChunk(JSON.parse(event.data) as OpenAiChunk);
        } catch {
          // unvollständige Nutzlast ignorieren
        }
      },
    });

    if (!result.streamed && result.text) {
      const payloads = extractSsePayloads(result.text);
      if (payloads.length) {
        for (const payload of payloads) {
          try {
            handleChunk(JSON.parse(payload) as OpenAiChunk);
          } catch {
            // ignorieren
          }
        }
      } else {
        const parsed = JSON.parse(result.text) as OpenAiChunk;
        handleChunk(parsed);
      }
    }

    if (apiError) throw new Error(apiError);
    if (!text && !request.signal?.aborted) {
      throw new Error(
        reasoningChars > 0
          ? 'Das Modell hat nur "gedacht" und keinen Text ausgegeben. Anderes Modell wählen oder mehr Ausgabebudget erlauben.'
          : 'Der Dienst hat keinen Text geliefert.',
      );
    }

    return {
      text,
      providerId: this.id,
      model: request.model,
      usage,
      aborted: request.signal?.aborted === true,
      buffered: !result.streamed,
      durationMs: Date.now() - started,
    };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.options.apiKey().trim()) {
      return { ok: false, message: `${this.label}: Kein API-Schlüssel hinterlegt.` };
    }
    try {
      const models = await this.listModels();
      if (!models.length) {
        return { ok: false, message: `${this.label}: Verbindung steht, aber die Modellliste ist leer.` };
      }
      return {
        ok: true,
        message: `${this.label}: Verbindung steht, ${models.length} Modelle verfügbar.`,
      };
    } catch (error) {
      return { ok: false, message: humanizeHttpError(error, this.label) };
    }
  }

  /** Wird für den "einmal antworten"-Test benutzt. */
  async ping(model: string): Promise<string> {
    const { json } = await postJson<OpenAiChunk>({
      url: this.url('/chat/completions'),
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: this.options.useMaxCompletionTokens ? undefined : 20,
        max_completion_tokens: this.options.useMaxCompletionTokens ? 20 : undefined,
        messages: [{ role: 'user', content: 'Antworte mit genau einem Wort: bereit' }],
      }),
      timeoutMs: 60_000,
      retries: 0,
    });
    return json.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * Zusatzfelder (z. B. Denk-Stufen) in die Anfrage eintragen. Der Name bleibt so,
 * wie ihn der Anbieter erwartet — die Umrechnung passiert im Gehirn.
 */
export function applyExtraParams(body: Record<string, unknown>, extra?: Record<string, unknown>): void {
  if (!extra) return;
  for (const [schluessel, wert] of Object.entries(extra)) {
    if (wert === undefined || wert === null) continue;
    body[schluessel] = wert;
  }
}
