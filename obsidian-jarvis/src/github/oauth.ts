/**
 * Anmeldung bei GitHub über den Geräte-Code (OAuth Device Flow, RFC 8628).
 *
 * Warum? Damit niemand mehr per Hand einen Token erzeugen und einfügen muss:
 * Jarvis zeigt einen kurzen Code an, der Nutzer bestätigt ihn auf github.com,
 * das Plugin holt den Zugang selbst ab. Der Ablauf braucht kein Client-Secret
 * und funktioniert deshalb auch in einem Open-Source-Plugin.
 *
 * Benötigt wird eine OAuth-App des Nutzers (github.com/settings/developers →
 * "OAuth Apps" → "New OAuth App") mit Haken bei "Enable Device Flow".
 * Deren Client-ID wird in den Jarvis-Einstellungen eingetragen.
 */
import { streamRequest } from '../util/http';

/** Rechte, die Jarvis braucht: Inhalte lesen und schreiben, Konto erkennen. */
export const DEVICE_SCOPE = 'repo read:user';

export interface DeviceCodeStart {
  /** Interner Code zum Abholen des Tokens. */
  deviceCode: string;
  /** Code, den der Nutzer auf github.com eingibt, z. B. "ABCD-1234". */
  userCode: string;
  /** Seite, auf der der Code eingegeben wird. */
  verificationUri: string;
  /** Gültigkeit in Sekunden. */
  expiresIn: number;
  /** Wartezeit zwischen zwei Abfragen in Sekunden. */
  interval: number;
}

export interface DeviceAuthOptions {
  clientId: string;
  /** Adresse von github.com (bei GitHub Enterprise abweichend). */
  host?: string;
  /** Gewünschte Rechte. Standard: {@link DEVICE_SCOPE}. */
  scope?: string;
  /** Nur für Tests: Warten ersetzen. */
  sleep?: (ms: number) => Promise<void>;
  /** Nur für Tests: Uhr ersetzen. */
  now?: () => number;
  /** Abbruch von außen (z. B. wenn das Fenster geschlossen wird). */
  signal?: AbortSignal;
  /** Rückmeldung nach jeder Abfrage. */
  onPoll?: (info: { waiting: boolean; message: string }) => void;
}

export class DeviceFlowError extends Error {
  /** Grund, damit die Oberfläche unterscheiden kann. */
  reason: 'abgebrochen' | 'abgelehnt' | 'abgelaufen' | 'keine-client-id' | 'fehler';

  constructor(reason: DeviceFlowError['reason'], message: string) {
    super(message);
    this.name = 'DeviceFlowError';
    this.reason = reason;
  }
}

interface StartResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function formBody(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function parseBody<T>(text: string): T {
  // GitHub antwortet je nach Endpunkt mit JSON oder Formular-Format.
  try {
    return JSON.parse(text) as T;
  } catch {
    const out: Record<string, string> = {};
    for (const pair of text.split('&')) {
      if (!pair) continue;
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? '' : pair.slice(index + 1);
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
    return out as T;
  }
}

/** Anmeldung per Geräte-Code. */
export class GithubDeviceAuth {
  private readonly options: DeviceAuthOptions;

  constructor(options: DeviceAuthOptions) {
    this.options = options;
  }

  private host(): string {
    const raw = (this.options.host ?? '').trim();
    if (raw) return raw.replace(/\/+$/, '');
    return 'https://github.com';
  }

  private scope(): string {
    return (this.options.scope ?? DEVICE_SCOPE).trim() || DEVICE_SCOPE;
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Schritt 1: Code bei GitHub anfordern. */
  async start(): Promise<DeviceCodeStart> {
    const clientId = (this.options.clientId ?? '').trim();
    if (!clientId) {
      throw new DeviceFlowError(
        'keine-client-id',
        'Keine OAuth-Client-ID eingetragen. Bitte unten im Feld eintragen (Anleitung siehe "Client-ID einrichten").',
      );
    }

    const { text } = await streamRequest({
      url: `${this.host()}/login/device/code`,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formBody({ client_id: clientId, scope: this.scope() }),
      timeoutMs: 30_000,
      allowStream: false,
      retries: 0,
    });

    const data = parseBody<StartResponse>(text);
    if (!data.device_code || !data.user_code) {
      throw new DeviceFlowError(
        'fehler',
        data.error_description || data.error || 'GitHub hat keinen Geräte-Code geschickt. Bitte Client-ID prüfen.',
      );
    }

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri || `${this.host()}/login/device`,
      expiresIn: data.expires_in && data.expires_in > 0 ? data.expires_in : 900,
      interval: Math.max(5, data.interval && data.interval > 0 ? data.interval : 5),
    };
  }

  /**
   * Schritt 2: warten, bis der Nutzer den Code bestätigt hat.
   * Liefert den Zugangsschlüssel.
   */
  async waitForToken(start: DeviceCodeStart): Promise<string> {
    const deadline = this.now() + start.expiresIn * 1000;
    let interval = start.interval;

    while (this.now() < deadline) {
      if (this.options.signal?.aborted) {
        throw new DeviceFlowError('abgebrochen', 'Anmeldung abgebrochen.');
      }
      await this.sleep(interval * 1000);

      const { text } = await streamRequest({
        url: `${this.host()}/login/oauth/access_token`,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: formBody({
          client_id: this.options.clientId.trim(),
          device_code: start.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        timeoutMs: 30_000,
        allowStream: false,
        retries: 1,
        signal: this.options.signal,
      });

      const data = parseBody<TokenResponse>(text);
      if (data.access_token) {
        this.options.onPoll?.({ waiting: false, message: 'Angemeldet.' });
        return data.access_token;
      }

      switch (data.error) {
        case 'authorization_pending':
          this.options.onPoll?.({ waiting: true, message: 'Warte auf die Bestätigung auf github.com …' });
          break;
        case 'slow_down':
          interval += 5;
          this.options.onPoll?.({ waiting: true, message: 'GitHub bittet um langsamere Abfragen — wird angepasst.' });
          break;
        case 'expired_token':
          throw new DeviceFlowError('abgelaufen', 'Der Code ist abgelaufen. Bitte die Anmeldung erneut starten.');
        case 'access_denied':
          throw new DeviceFlowError('abgelehnt', 'Die Anmeldung wurde auf github.com abgelehnt.');
        default:
          throw new DeviceFlowError(
            'fehler',
            data.error_description || data.error || 'GitHub hat die Anmeldung nicht bestätigt.',
          );
      }
    }

    throw new DeviceFlowError('abgelaufen', 'Der Code ist abgelaufen. Bitte die Anmeldung erneut starten.');
  }
}

/** Rechte eines Tokens prüfen (klassische Token liefern ihre Rechte mit). */
export function hasContentsWrite(scopes: string[]): boolean {
  if (!scopes.length) return true; // feingranulare Token melden ihre Rechte nicht
  return scopes.some((scope) => scope === 'repo' || scope === 'public_repo' || scope.startsWith('write:'));
}
