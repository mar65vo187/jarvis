/** Anthropic (Claude) direkt über die Messages-API. */
import { extractSsePayloads, getJson, humanizeHttpError, streamRequest } from '../util/http';
import type { ChatRequest, ChatResult, ModelInfo } from '../types';
import type { Provider } from './types';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicModelsResponse {
  data?: Array<{ id?: string; display_name?: string; created_at?: string }>;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: Array<{ type?: string; text?: string }>;
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly label = 'Claude (Anthropic)';
  readonly local = false;

  constructor(
    private baseUrl: () => string,
    private apiKey: () => string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey().trim(),
      'anthropic-version': ANTHROPIC_VERSION,
      // Erlaubt den Aufruf direkt aus Obsidian (Browser-Kontext).
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  private url(path: string): string {
    const base = this.baseUrl().replace(/\/+$/, '');
    return `${base}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey().trim()) throw new Error('Kein API-Schlüssel hinterlegt.');
    const data = await getJson<AnthropicModelsResponse>({
      url: this.url('/v1/models?limit=100'),
      headers: this.headers(),
      timeoutMs: 15_000,
    });
    return (data.data ?? [])
      .map((row) => row.id ?? '')
      .filter(Boolean)
      .map((id) => ({
        id,
        label: id,
        providerId: 'anthropic' as const,
        local: false,
        note: 'Claude',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const body = {
      model: request.model,
      max_tokens: request.maxTokens && request.maxTokens > 0 ? request.maxTokens : 4096,
      system: request.system,
      messages: request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      stream: true,
      // Bei Claude Opus 5.x ist adaptives Denken immer aktiv; Temperatur wird
      // deshalb bewusst nicht gesendet, um Widersprüche zu vermeiden.
    };

    let text = '';
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let thinkingChars = 0;
    let apiError = '';

    const handleEvent = (parsed: AnthropicStreamEvent) => {
      if (parsed.type === 'error' && parsed.error) {
        apiError = parsed.error.message ?? 'Unbekannter Fehler';
        return;
      }
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        usage = { inputTokens: parsed.message.usage.input_tokens, outputTokens: usage?.outputTokens };
      }
      if (parsed.type === 'content_block_delta' && parsed.delta) {
        if (parsed.delta.type === 'thinking_delta' && parsed.delta.thinking) {
          thinkingChars += parsed.delta.thinking.length;
          return;
        }
        const piece = parsed.delta.text ?? '';
        if (piece) {
          text += piece;
          request.onDelta?.(piece);
        }
      }
      if (parsed.type === 'message_delta' && parsed.usage) {
        usage = { inputTokens: usage?.inputTokens, outputTokens: parsed.usage.output_tokens };
      }
      if (parsed.type === 'message' && parsed.content) {
        for (const block of parsed.content) {
          if (block.type === 'text' && block.text) {
            text += block.text;
            request.onDelta?.(block.text);
          }
        }
      }
    };

    const result = await streamRequest({
      url: this.url('/v1/messages'),
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
      allowStream: request.allowStream !== false,
      timeoutMs: 600_000,
      retries: 1,
      onEvent: (event) => {
        if (!event.data) return;
        try {
          handleEvent(JSON.parse(event.data) as AnthropicStreamEvent);
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
            handleEvent(JSON.parse(payload) as AnthropicStreamEvent);
          } catch {
            // ignorieren
          }
        }
      } else {
        handleEvent(JSON.parse(result.text) as AnthropicStreamEvent);
      }
    }

    if (apiError) throw new Error(apiError);
    if (!text && !request.signal?.aborted) {
      throw new Error(
        thinkingChars > 0
          ? 'Claude hat nur intern gedacht und keinen Text ausgegeben. Bitte erneut versuchen oder eine kürzere Frage stellen.'
          : 'Claude hat keinen Text geliefert.',
      );
    }

    return {
      text,
      providerId: 'anthropic',
      model: request.model,
      usage,
      aborted: request.signal?.aborted === true,
      buffered: !result.streamed,
      durationMs: Date.now() - started,
    };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey().trim()) {
      return { ok: false, message: 'Claude: Kein API-Schlüssel hinterlegt.' };
    }
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `Claude: Verbindung steht. ${models.length} Modelle verfügbar (z. B. ${models
          .slice(0, 3)
          .map((m) => m.id)
          .join(', ')}).`,
      };
    } catch (error) {
      return { ok: false, message: humanizeHttpError(error, 'Claude') };
    }
  }
}
