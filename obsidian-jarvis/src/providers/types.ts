/** Anbieter-Schnittstelle: alles, was ein Modell-Anbieter können muss. */
import type { ChatRequest, ChatResult, ModelInfo, ProviderId } from '../types';

export interface ProviderContext {
  pluginVersion: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly local: boolean;
  /** Modelle auflisten (für die Auswahl im Plugin). */
  listModels(): Promise<ModelInfo[]>;
  /** Eine Antwort erzeugen. Streamt über request.onDelta, falls möglich. */
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Kurzer Verbindungstest. */
  test(): Promise<{ ok: boolean; message: string }>;
}

/** Aus einem Fehlerobjekt der Anbieter eine lesbare Meldung bauen. */
export function extractApiErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string } | string;
      message?: string;
      detail?: string;
    };
    const err = parsed.error;
    if (typeof err === 'string') return err;
    if (err?.message) return err.message;
    return parsed.message ?? parsed.detail ?? '';
  } catch {
    return body.slice(0, 300);
  }
}
