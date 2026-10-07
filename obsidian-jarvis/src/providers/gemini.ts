/** Google Gemini über die Generative-Language-API. */
import { extractSsePayloads, getJson, humanizeHttpError, streamRequest } from '../util/http';
import type { ChatMessage, ChatRequest, ChatResult, ModelInfo } from '../types';
import type { Provider } from './types';

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
  }>;
}

interface GeminiPart {
  text?: string;
}

interface GeminiPayload {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini (Google)';
  readonly local = false;

  constructor(
    private baseUrl: () => string,
    private apiKey: () => string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl().replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey().trim(),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey().trim()) throw new Error('Kein API-Schlüssel hinterlegt.');
    const data = await getJson<GeminiModelsResponse>({
      url: this.url('/v1beta/models?pageSize=200'),
      headers: this.headers(),
      timeoutMs: 15_000,
    });
    return (data.models ?? [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => {
        const id = (model.name ?? '').replace(/^models\//, '');
        return {
          id,
          label: model.displayName ? `${id} — ${model.displayName}` : id,
          providerId: 'gemini' as const,
          local: false,
          note: 'Gemini',
          contextTokens: model.inputTokenLimit,
        };
      })
      .filter((model) => Boolean(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message: ChatMessage) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: request.system }] },
    };
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxTokens && request.maxTokens > 0) generationConfig.maxOutputTokens = request.maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    let text = '';
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let apiError = '';

    const handlePayload = (payload: GeminiPayload) => {
      if (payload.error) {
        apiError = payload.error.message ?? 'Unbekannter Fehler';
        return;
      }
      for (const candidate of payload.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            text += part.text;
            request.onDelta?.(part.text);
          }
        }
      }
      if (payload.usageMetadata) {
        usage = {
          inputTokens: payload.usageMetadata.promptTokenCount,
          outputTokens: payload.usageMetadata.candidatesTokenCount,
        };
      }
    };

    const url = this.url(
      `/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
    );

    const result = await streamRequest({
      url,
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
          handlePayload(JSON.parse(event.data) as GeminiPayload);
        } catch {
          // ignorieren
        }
      },
    });

    if (!result.streamed && result.text) {
      const payloads = extractSsePayloads(result.text);
      if (payloads.length) {
        for (const payload of payloads) {
          try {
            handlePayload(JSON.parse(payload) as GeminiPayload);
          } catch {
            // ignorieren
          }
        }
      } else {
        handlePayload(JSON.parse(result.text) as GeminiPayload);
      }
    }

    if (apiError) throw new Error(apiError);
    if (!text && !request.signal?.aborted) {
      throw new Error('Gemini hat keinen Text geliefert (evtl. blockiert eine Sicherheitsregel die Anfrage).');
    }

    return {
      text,
      providerId: 'gemini',
      model: request.model,
      usage,
      aborted: request.signal?.aborted === true,
      buffered: !result.streamed,
      durationMs: Date.now() - started,
    };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey().trim()) {
      return { ok: false, message: 'Gemini: Kein API-Schlüssel hinterlegt.' };
    }
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `Gemini: Verbindung steht. ${models.length} Modelle verfügbar.`,
      };
    } catch (error) {
      return { ok: false, message: humanizeHttpError(error, 'Gemini') };
    }
  }
}
