/**
 * MCP (Model Context Protocol) — Jarvis kann fremde Werkzeuge benutzen.
 *
 * Damit bekommt Jarvis Fähigkeiten, die andere für ihn gebaut haben:
 * Dateisystem, Browser, Datenbanken, Shell, GitHub, n8n … alles, was als
 * MCP-Server angeboten wird. Zwei Transportwege:
 *
 *  - **http** : Server mit Adresse (z. B. https://server/mcp) — funktioniert auch auf dem Tablet.
 *  - **stdio**: Programm auf dem Rechner (z. B. `npx -y @modelcontextprotocol/server-filesystem /pfad`).
 *               Nur Desktop-Obsidian, weil dort Node läuft.
 *
 * Umgesetzt ist die übliche Abfolge: initialize → notifications/initialized →
 * tools/list → tools/call, mit Sitzungs-Kennung und SSE-Antworten.
 */
import type { ToolOutcome } from './types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: 'http' | 'stdio';
  /** Für http: Adresse des Servers. */
  url: string;
  /** Für stdio: Programm und Argumente. */
  command: string;
  args: string[];
  /** Zusätzliche Umgebungsvariablen (stdio). */
  env?: Record<string, string>;
  /** Kopfzeilen für http, z. B. Authorization. */
  headers?: Record<string, string>;
  /** Zeitlimit pro Aufruf in Sekunden. */
  timeoutSeconds: number;
}

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  /** Eingabeschema (JSON-Schema), wie geliefert. */
  inputSchema: Record<string, unknown>;
}

export interface McpTransport {
  /** Nachricht senden; die Antwort (falls es eine gibt) kommt über onMessage. */
  send(message: Record<string, unknown>): Promise<void>;
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  onClose?(handler: (grund: string) => void): void;
  close(): void;
}

export interface McpDeps {
  /** HTTP-Zugriff (Obsidian requestUrl) — wird von außen gereicht. */
  fetchJson(options: {
    url: string;
    headers?: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text: string; headers: Record<string, string> }>;
  /** Node-Zugriff für stdio (Desktop). Fehlt auf dem Tablet. */
  nodeRequire?: (modul: string) => unknown;
}

/** Transport über einen HTTP-Endpunkt (Streamable HTTP / SSE). */
export class HttpMcpTransport implements McpTransport {
  private empfaenger: ((message: Record<string, unknown>) => void) | null = null;
  private geschlossen: ((grund: string) => void) | null = null;
  private sitzung = '';
  private kopfzeilen: Record<string, string>;

  constructor(
    private url: string,
    private deps: McpDeps,
    extraHeaders: Record<string, string> = {},
    private signal?: AbortSignal,
  ) {
    this.kopfzeilen = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders };
  }

  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.empfaenger = handler;
  }

  onClose(handler: (grund: string) => void): void {
    this.geschlossen = handler;
  }

  async send(message: Record<string, unknown>): Promise<void> {
    const kopfzeilen = { ...this.kopfzeilen };
    if (this.sitzung) kopfzeilen['mcp-session-id'] = this.sitzung;
    const antwort = await this.deps.fetchJson({
      url: this.url,
      headers: kopfzeilen,
      body: JSON.stringify(message),
      signal: this.signal,
    });
    if (antwort.headers['mcp-session-id']) this.sitzung = antwort.headers['mcp-session-id'];
    if (antwort.status >= 400) {
      throw new Error(`MCP-Server antwortete mit HTTP ${antwort.status}: ${antwort.text.slice(0, 200)}`);
    }
    for (const nachricht of extractMcpMessages(antwort.text, antwort.headers['content-type'] ?? '')) {
      this.empfaenger?.(nachricht);
    }
  }

  close(): void {
    this.geschlossen?.('geschlossen');
  }
}

/** Antwort eines MCP-Servers lesen — reines JSON oder SSE-Zeilen. */
export function extractMcpMessages(text: string, contentType: string): Array<Record<string, unknown>> {
  const inhalt = (text ?? '').trim();
  if (!inhalt) return [];
  if (contentType.includes('text/event-stream') || inhalt.startsWith('event:') || inhalt.startsWith('data:')) {
    const nachrichten: Array<Record<string, unknown>> = [];
    for (const zeile of inhalt.split('\n')) {
      const treffer = /^data:\s*(.+)$/.exec(zeile.trim());
      if (!treffer) continue;
      const daten = treffer[1].trim();
      if (!daten || daten === '[DONE]') continue;
      try {
        nachrichten.push(JSON.parse(daten) as Record<string, unknown>);
      } catch {
        /* unvollständige Zeile ignorieren */
      }
    }
    if (nachrichten.length) return nachrichten;
  }
  try {
    const geparst = JSON.parse(inhalt) as unknown;
    if (Array.isArray(geparst)) return geparst.filter((eintrag) => eintrag && typeof eintrag === 'object') as Array<Record<string, unknown>>;
    if (geparst && typeof geparst === 'object') return [geparst as Record<string, unknown>];
  } catch {
    /* keine JSON-Antwort */
  }
  return [];
}

/** Transport über ein Programm auf dem Rechner (nur Desktop). */
export class StdioMcpTransport implements McpTransport {
  private kind: {
    stdin: { write(data: string): void };
    stdout: { on(event: string, handler: (daten: Buffer | string) => void): void };
    stderr?: { on(event: string, handler: (daten: Buffer | string) => void): void };
    kill(): void;
    on(event: string, handler: (code: number | null) => void): void;
  } | null = null;
  private puffer = '';
  private empfaenger: ((message: Record<string, unknown>) => void) | null = null;
  private geschlossen: ((grund: string) => void) | null = null;
  private fehler = '';

  constructor(
    private command: string,
    private args: string[],
    private deps: McpDeps,
    private env?: Record<string, string>,
  ) {}

  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.empfaenger = handler;
  }

  onClose(handler: (grund: string) => void): void {
    this.geschlossen = handler;
  }

  private starten(): void {
    if (this.kind) return;
    if (!this.deps.nodeRequire) {
      throw new Error('Programme (stdio) laufen nur in der Desktop-Version von Obsidian. Nutze sonst einen HTTP-MCP-Server.');
    }
    const cp = this.deps.nodeRequire('node:child_process') as {
      spawn(command: string, args: string[], options: Record<string, unknown>): StdioMcpTransport['kind'];
    };
    const kind = cp.spawn(this.command, this.args, {
      env: { ...(process.env as Record<string, string>), ...(this.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!kind) throw new Error(`Das Programm "${this.command}" konnte nicht gestartet werden.`);
    this.kind = kind;
    kind.stdout.on('data', (daten) => this.verarbeiten(String(daten)));
    kind.stderr?.on('data', (daten) => {
      const text = String(daten).trim();
      if (text) this.fehler = `${this.fehler}\n${text}`.trim().slice(-600);
    });
    kind.on('exit', (code) => {
      this.geschlossen?.(`Das Programm wurde beendet (Code ${code ?? 'unbekannt'}).${this.fehler ? ` Meldung: ${this.fehler}` : ''}`);
      this.kind = null;
    });
  }

  private verarbeiten(daten: string): void {
    this.puffer += daten;
    let index = this.puffer.indexOf('\n');
    while (index >= 0) {
      const zeile = this.puffer.slice(0, index).trim();
      this.puffer = this.puffer.slice(index + 1);
      if (zeile) {
        try {
          const nachricht = JSON.parse(zeile) as Record<string, unknown>;
          if (nachricht && typeof nachricht === 'object') this.empfaenger?.(nachricht);
        } catch {
          /* Zeilen, die kein JSON sind (z. B. Startmeldungen), ignorieren */
        }
      }
      index = this.puffer.indexOf('\n');
    }
  }

  async send(message: Record<string, unknown>): Promise<void> {
    this.starten();
    this.kind?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    try {
      this.kind?.kill();
    } catch {
      /* schon beendet */
    }
    this.kind = null;
  }
}

export interface McpCall {
  id: number;
  resolve: (wert: Record<string, unknown>) => void;
  reject: (fehler: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Verbindung zu einem MCP-Server: Werkzeuge auflisten und aufrufen. */
export class McpClient {
  private transport: McpTransport;
  private naechsteId = 1;
  private offen = new Map<number, McpCall>();
  private werkzeuge: McpToolInfo[] | null = null;
  private geschlossenGrund = '';
  private bereit = false;
  private serverInfo = '';

  constructor(
    private config: McpServerConfig,
    deps: McpDeps,
    signal?: AbortSignal,
  ) {
    if (config.transport === 'http') {
      this.transport = new HttpMcpTransport(config.url, deps, config.headers, signal);
    } else {
      this.transport = new StdioMcpTransport(config.command, config.args, deps, config.env);
    }
    this.transport.onMessage((message) => this.empfange(message));
    this.transport.onClose?.((grund) => {
      this.geschlossenGrund = grund;
      for (const [id, aufruf] of this.offen) {
        aufruf.reject(new Error(`Verbindung zu "${config.name}" beendet: ${grund}`));
        if (aufruf.timer) clearTimeout(aufruf.timer);
        this.offen.delete(id);
      }
    });
  }

  get name(): string {
    return this.config.name;
  }

  get info(): string {
    return this.serverInfo;
  }

  private empfangene(meldung: Record<string, unknown>, id: number): void {
    const aufruf = this.offen.get(id);
    if (!aufruf) return;
    this.offen.delete(id);
    if (aufruf.timer) clearTimeout(aufruf.timer);
    if (meldung.error) {
      const fehler = meldung.error as { message?: string };
      aufruf.reject(new Error(fehler.message ?? 'Der MCP-Server meldete einen Fehler.'));
      return;
    }
    aufruf.resolve((meldung.result ?? {}) as Record<string, unknown>);
  }

  private empfange(meldung: Record<string, unknown>): void {
    const id = typeof meldung.id === 'number' ? meldung.id : null;
    if (id !== null) this.empfangene(meldung, id);
  }

  private async anfrage(methode: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.geschlossenGrund) throw new Error(`Verbindung zu "${this.config.name}" ist beendet: ${this.geschlossenGrund}`);
    const id = this.naechsteId++;
    const grenze = timeoutMs ?? Math.max(5, this.config.timeoutSeconds || 30) * 1000;
    const versprechen = new Promise<Record<string, unknown>>((resolve, reject) => {
      const aufruf: McpCall = { id, resolve, reject, timer: null };
      aufruf.timer = setTimeout(() => {
        this.offen.delete(id);
        reject(new Error(`"${this.config.name}" hat nicht innerhalb von ${Math.round(grenze / 1000)} s geantwortet.`));
      }, grenze);
      this.offen.set(id, aufruf);
    });
    try {
      await this.transport.send({ jsonrpc: '2.0', id, method: methode, params });
    } catch (fehler) {
      const aufruf = this.offen.get(id);
      if (aufruf?.timer) clearTimeout(aufruf.timer);
      this.offen.delete(id);
      throw fehler instanceof Error ? fehler : new Error(String(fehler));
    }
    return versprechen;
  }

  /** Verbindung aufbauen (initialize + initialized). */
  async connect(): Promise<void> {
    if (this.bereit) return;
    const antwort = await this.anfrage('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, roots: { listChanged: false } },
      clientInfo: { name: 'jarvis-ai-obsidian', version: '3.0.0' },
    });
    const server = antwort.serverInfo as { name?: string; version?: string } | undefined;
    this.serverInfo = server?.name ? `${server.name}${server.version ? ` ${server.version}` : ''}` : this.config.name;
    // Pflichtmeldung nach dem Handschlag (ohne Antwort)
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => undefined);
    this.bereit = true;
  }

  /** Alle Werkzeuge des Servers (mit Zwischenspeicher). */
  async listTools(force = false): Promise<McpToolInfo[]> {
    if (this.werkzeuge && !force) return this.werkzeuge;
    await this.connect();
    const antwort = await this.anfrage('tools/list', {});
    const roh = (antwort.tools ?? []) as Array<{
      name?: string;
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    this.werkzeuge = roh
      .filter((eintrag) => typeof eintrag.name === 'string' && eintrag.name)
      .map((eintrag) => ({
        name: eintrag.name as string,
        title: eintrag.title ?? (eintrag.name as string),
        description: (eintrag.description ?? '').replace(/\s+/g, ' ').slice(0, 400),
        inputSchema: eintrag.inputSchema ?? { type: 'object', properties: {} },
      }));
    return this.werkzeuge;
  }

  /** Ein Werkzeug aufrufen. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    await this.connect();
    const antwort = await this.anfrage('tools/call', { name, arguments: args });
    const inhalt = (antwort.content ?? []) as Array<{ type?: string; text?: string; resource?: { uri?: string } }>;
    const texte: string[] = [];
    for (const teil of inhalt) {
      if (!teil || typeof teil !== 'object') continue;
      if (typeof teil.text === 'string') texte.push(teil.text);
      else if (teil.resource?.uri) texte.push(`(Ressource: ${teil.resource.uri})`);
    }
    const text = texte.join('\n\n').trim();
    const fehler = antwort.isError === true;
    return {
      ok: !fehler,
      text: text || (fehler ? 'Der MCP-Server meldete einen Fehler ohne Beschreibung.' : '(kein Inhalt)'),
      summary: fehler ? 'Fehler' : `${text.length} Zeichen`,
    };
  }

  close(): void {
    this.transport.close();
  }
}

/** Kurzbeschreibung des Eingabeschemas für die Modell-Anweisung. */
export function describeSchema(schema: Record<string, unknown>): string {
  const eigenschaften = (schema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const pflicht = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  const teile = Object.entries(eigenschaften).map(([name, info]) => {
    const typ = typeof info?.type === 'string' ? info.type : 'wert';
    const beschreibung = (info?.description ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `${name}: ${typ}${pflicht.includes(name) ? '' : '?'}${beschreibung ? ` — ${beschreibung}` : ''}`;
  });
  return teile.join(', ') || 'keine Angaben';
}
