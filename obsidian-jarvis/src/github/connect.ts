/**
 * Fenster für die Anmeldung bei GitHub per Geräte-Code.
 *
 * Ablauf: Jarvis zeigt einen Code → Nutzer gibt ihn auf github.com/login/device
 * ein und bestätigt → Jarvis holt den Schlüssel ab und speichert ihn.
 */
import { App, Modal, Notice } from 'obsidian';
import { DeviceFlowError, GithubDeviceAuth, type DeviceCodeStart } from './oauth';

export interface ConnectOptions {
  /** OAuth-Client-ID der eigenen GitHub-App. */
  clientId: string;
  /** Adresse von github.com (bei GitHub Enterprise abweichend). */
  host?: string;
  /** Nach erfolgreicher Anmeldung aufgerufen. */
  onToken: (token: string) => Promise<void>;
  /** Meldungen an die Umgebung (z. B. zum Nachladen der Einstellungen). */
  onDone?: () => void;
}

export class GithubConnectModal extends Modal {
  private controller = new AbortController();
  private statusEl: HTMLElement | null = null;
  private codeEl: HTMLElement | null = null;
  private buttonsEl: HTMLElement | null = null;
  private laufend = false;
  private geschlossen = false;

  constructor(
    app: App,
    private options: ConnectOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('jarvis-modal');
    contentEl.createEl('h3', { text: 'Mit GitHub verbinden' });

    if (!this.options.clientId.trim()) {
      this.renderAnleitung(contentEl);
      return;
    }

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Gib den angezeigten Code auf github.com ein und bestätige dort. ' +
        'Jarvis wartet, bis du fertig bist — das Fenster kann offen bleiben.',
    });

    this.codeEl = contentEl.createEl('div', { cls: 'jarvis-device-code', text: '…' });
    this.statusEl = contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Code wird bei GitHub angefordert …',
    });
    this.buttonsEl = contentEl.createDiv({ cls: 'jarvis-modal-buttons' });

    void this.starten();
  }

  /** Anleitung, wenn noch keine OAuth-Client-ID hinterlegt ist. */
  private renderAnleitung(contentEl: HTMLElement): void {
    const liste = contentEl.createEl('ol', { cls: 'jarvis-steps' });
    const schritte = [
      'Auf github.com → Einstellungen → Developer settings → OAuth Apps → "New OAuth App" öffnen.',
      'Name: Jarvis AI (Obsidian). Homepage: https://github.com/mar65vo187/jarvis',
      'Authorization callback URL: http://localhost (wird nicht benutzt, muss aber ausgefüllt sein).',
      'Haken setzen bei "Enable Device flow".',
      'Client-ID kopieren und in den Jarvis-Einstellungen unter "OAuth-Client-ID" eintragen.',
    ];
    for (const schritt of schritte) liste.createEl('li', { text: schritt });

    const buttons = contentEl.createDiv({ cls: 'jarvis-modal-buttons' });
    const open = buttons.createEl('button', { cls: 'mod-cta', text: 'GitHub-Einstellungen öffnen' });
    open.onclick = () => window.open('https://github.com/settings/developers', '_blank');
    const close = buttons.createEl('button', { text: 'Schließen' });
    close.onclick = () => this.close();
  }

  private async starten(): Promise<void> {
    if (this.laufend) return;
    this.laufend = true;
    try {
      const auth = new GithubDeviceAuth({
        clientId: this.options.clientId,
        host: this.options.host,
        signal: this.controller.signal,
        onPoll: (info) => this.status(info.message),
      });
      const start: DeviceCodeStart = await auth.start();
      this.zeigeCode(start);
      const token = await auth.waitForToken(start);
      if (this.geschlossen) return;
      this.status('Angemeldet — Schlüssel wird gespeichert …');
      await this.options.onToken(token);
      new Notice('Mit GitHub verbunden. Du kannst jetzt sichern und wiederherstellen.', 10000);
      this.options.onDone?.();
      this.close();
    } catch (error) {
      if (this.geschlossen) return;
      const text =
        error instanceof DeviceFlowError ? error.message : `Anmeldung fehlgeschlagen: ${(error as Error).message}`;
      this.status(`❌ ${text}`);
      new Notice(text, 15000);
      const wiederholen = this.buttonsEl?.createEl('button', { cls: 'mod-cta', text: 'Erneut versuchen' });
      if (wiederholen) {
        wiederholen.onclick = () => {
          this.laufend = false;
          this.status('Code wird bei GitHub angefordert …');
          void this.starten();
        };
      }
    } finally {
      this.laufend = false;
    }
  }

  private zeigeCode(start: DeviceCodeStart): void {
    if (this.codeEl) this.codeEl.setText(start.userCode);
    const buttons = this.buttonsEl;
    if (!buttons) return;
    buttons.empty();

    const open = buttons.createEl('button', { cls: 'mod-cta', text: 'GitHub öffnen und Code eingeben' });
    open.onclick = () => window.open(start.verificationUri, '_blank');

    const copy = buttons.createEl('button', { text: 'Code kopieren' });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(start.userCode);
        new Notice(`Code ${start.userCode} kopiert.`);
      } catch {
        new Notice(`Bitte manuell eingeben: ${start.userCode}`);
      }
    };

    const abort = buttons.createEl('button', { text: 'Abbrechen' });
    abort.onclick = () => this.close();

    this.status(`Code gilt ${Math.max(1, Math.round(start.expiresIn / 60))} Minuten.`);
  }

  private status(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  onClose(): void {
    this.geschlossen = true;
    this.controller.abort();
    this.contentEl.empty();
  }
}

/** Hinweis-Zeile für die Einstellungen: wie ist Jarvis gerade verbunden? */
export function verbindungsText(optionen: {
  token: string;
  login: string;
  scopes: string;
  owner: string;
  repo: string;
}): string {
  if (!optionen.token.trim()) return 'Nicht verbunden — bitte unten "Mit GitHub verbinden" wählen.';
  const teile: string[] = [];
  teile.push(optionen.login.trim() ? `Verbunden als ${optionen.login.trim()}.` : 'Verbunden (Schlüssel vorhanden).');
  if (optionen.owner.trim() && optionen.repo.trim()) teile.push(`Ziel: ${optionen.owner}/${optionen.repo}.`);
  if (optionen.scopes.trim()) teile.push(`Rechte: ${optionen.scopes.trim()}.`);
  return teile.join(' ');
}
