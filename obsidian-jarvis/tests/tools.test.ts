/**
 * Werkzeuge: Protokoll, Rechner, Internet (Suche und Seiten lesen),
 * Vault-Werkzeuge, Sperren, MCP und die Werkzeug-Schleife (Agent).
 *
 * Geprüft wird gegen echte HTTP-Server auf 127.0.0.1 und gegen einen echten
 * Kindprozess (MCP über stdio).
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
import { startServer, json, type TestServer } from './helpers/server';
import { buildToolPrompt, parseToolCalls, renderToolResults, TOOL_FENCE } from '../src/tools/protocol';
import { calculate, blockiertGrund, buildActiveTools, runTool, mcpToolName, type RegistryDeps } from '../src/tools/registry';
import { htmlToText, parseDuckDuckGo, unwrapDuckDuckGoUrl, decodeEntities, webSearch, webFetch, extractTitle, tavilyUrl } from '../src/tools/web';
import { HttpMcpTransport, McpClient, StdioMcpTransport, extractMcpMessages, describeSchema } from '../src/tools/mcp';
import { runAgent, looksLikeToolAnswer, sumUsage } from '../src/tools/agent';
import { safeVaultPath, argNumber, argText, type ToolVault } from '../src/tools/types';
import { mergeSettings } from '../src/settings';
import type { Source } from '../src/rag/vault-index';
import type { BrainAnswer } from '../src/brain';
import type { ChatMessage } from '../src/types';

// ------------------------------------------------------------------ Hilfen

class MemoryVault implements ToolVault {
  files = new Map<string, string>();
  constructor(files: Record<string, string> = {}) {
    for (const [pfad, inhalt] of Object.entries(files)) this.files.set(pfad, inhalt);
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async append(path: string, content: string): Promise<void> {
    this.files.set(path, `${this.files.get(path) ?? ''}${content}`);
  }
  async overwrite(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async listMarkdown(): Promise<string[]> {
    return [...this.files.keys()];
  }
  vaultPath(): string {
    return '/tmp/testvault';
  }
  name(): string {
    return 'Testvault';
  }
}

function ctx(
  vault: MemoryVault,
  settings: ReturnType<typeof mergeSettings>,
  sources: Source[] = [],
  note?: (line: string) => void,
) {
  return {
    settings: () => settings,
    index: {
      ensureFresh: async () => undefined,
      search: async () => sources,
      stats: () => ({ files: sources.length, chunks: sources.length, embedded: 0, embeddingModel: null }),
    } as never,
    vault,
    pluginVersion: '3.0.0',
    note,
  };
}

const QUELLE: Source = {
  id: 'Q1',
  path: 'Projekte/Alpha.md',
  heading: 'Status',
  text: 'Projekt Alpha endet am 15. November. Ansprechpartnerin ist Frau Berger.',
  score: 3,
};

function testDeps(overrides: Partial<RegistryDeps> = {}): RegistryDeps {
  return {
    web: {
      fetchText: async (options) => {
        const antwort = await fetch(options.url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
        });
        return { status: antwort.status, text: await antwort.text() };
      },
      ...(overrides.web ?? {}),
    },
    http: async (options) => {
      const antwort = await fetch(options.url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
      });
      const kopfzeilen: Record<string, string> = {};
      antwort.headers.forEach((wert, name) => {
        kopfzeilen[name.toLowerCase()] = wert;
      });
      return { status: antwort.status, text: await antwort.text(), headers: kopfzeilen };
    },
    key: (id) => (id === 'github' ? 'gh-test' : id === 'huggingface' ? 'hf-test' : id === 'n8n' ? 'n8n-test' : ''),
    ...overrides,
  };
}

// ------------------------------------------------------------------ Protokoll

describe('Werkzeug-Protokoll', () => {
  it('beschreibt die Werkzeuge für das Modell', () => {
    const text = buildToolPrompt([
      { name: 'web_search', summary: 'Sucht im Internet.', params: [{ name: 'query', description: 'Suchbegriffe', required: true }], handler: async () => ({ ok: true, text: '' }) },
      { name: 'calculate', summary: 'Rechnet.', params: [{ name: 'expression', description: 'Ausdruck' }], handler: async () => ({ ok: true, text: '' }) },
    ]);
    expect(text).toContain('web_search(query: Suchbegriffe)');
    expect(text).toContain('calculate(expression?: Ausdruck)');
    expect(text).toContain(TOOL_FENCE);
    expect(text).toContain('Erfinde niemals ein Ergebnis');
  });

  it('erkennt Werkzeugblöcke und trennt sie vom Text', () => {
    const antwort = [
      'Ich schaue nach.',
      '```jarvis-tool',
      '{"tool": "web_search", "args": {"query": "Wetter Frankfurt"}}',
      '```',
      '```json',
      '{"name": "calculate", "arguments": "{\\"expression\\": \\"2+2\\"}"}',
      '```',
    ].join('\n');
    const geparst = parseToolCalls(antwort, new Set(['web_search', 'calculate']));
    expect(geparst.calls).toHaveLength(2);
    expect(geparst.calls[0].tool).toBe('web_search');
    expect(geparst.calls[0].args.query).toBe('Wetter Frankfurt');
    expect(geparst.calls[1].tool).toBe('calculate');
    expect(geparst.calls[1].args.expression).toBe('2+2');
    expect(geparst.text).toBe('Ich schaue nach.');
  });

  it('lässt erfundene Werkzeugnamen nicht durch', () => {
    const geparst = parseToolCalls('```jarvis-tool\n{"tool": "gib_mir_alles", "args": {}}\n```', new Set(['web_search']));
    expect(geparst.calls).toHaveLength(0);
    expect(geparst.broken[0]).toContain('gib_mir_alles');
  });

  it('nimmt auch nacktes JSON ohne Zaun und meldet kaputte Blöcke', () => {
    const nackt = parseToolCalls('{"tool": "calculate", "args": {"expression": "3*3"}}', new Set(['calculate']));
    expect(nackt.calls).toHaveLength(1);
    const kaputt = parseToolCalls('```jarvis-tool\nirgendwas ohne json\n```', new Set(['calculate']));
    expect(kaputt.calls).toHaveLength(0);
    expect(kaputt.broken).toHaveLength(1);
  });

  it('formuliert die Werkzeug-Ergebnisse als Faktenquelle', () => {
    const text = renderToolResults([
      { call: { tool: 'web_search', args: { query: 'x' } }, ok: true, text: 'Treffer: …', summary: '3 Treffer' },
      { call: { tool: 'web_read', args: { url: 'y' } }, ok: false, text: 'HTTP 403' },
    ], ['unbekanntes Werkzeug']);
    expect(text).toContain('web_search({"query":"x"}) → OK');
    expect(text).toContain('web_read({"url":"y"}) → FEHLER');
    expect(text).toContain('als Faktenquelle');
    expect(text).toContain('Nicht ausgeführt: unbekanntes Werkzeug');
  });

  it('erkennt Antworten, die wie ein Werkzeugaufruf beginnen', () => {
    expect(looksLikeToolAnswer('```jarvis-tool')).toBe(true);
    expect(looksLikeToolAnswer('{"tool":')).toBe(true);
    expect(looksLikeToolAnswer('Ich habe recherchiert und')).toBe(false);
  });
});

// ------------------------------------------------------------------ Rechner

describe('Rechner', () => {
  it('rechnet die vier Grundrechenarten mit Klammern und Punkt-vor-Strich', () => {
    expect(calculate('2+3*4')).toBe(14);
    expect(calculate('(1250 * 1.19) / 3')).toBeCloseTo(495.8333333333, 6);
    expect(calculate('2^10')).toBe(1024);
    expect(calculate('-5 + 10')).toBe(5);
    expect(calculate('20% * 250')).toBeCloseTo(50, 6);
    expect(calculate('1.000,50 + 0,50')).toBe(1001);
  });

  it('weist Code und Fehler ab, statt ihn auszuführen', () => {
    expect(() => calculate('process.exit(1)')).toThrow(/unerlaubte Zeichen/);
    expect(() => calculate('require("fs")')).toThrow();
    expect(() => calculate('(1+2')).toThrow(/Klammer/);
    expect(() => calculate('5/0')).toThrow(/Null/);
    expect(() => calculate('1+')).toThrow();
  });

  it('sperrt gefährliche Befehle', () => {
    expect(blockiertGrund('rm -rf /', [])).toContain('rm -rf /');
    expect(blockiertGrund('shutdown -h now', [])).toContain('shutdown');
    expect(blockiertGrund('git status', [])).toBe('');
    expect(blockiertGrund('eigenes-gefaehrliches-ding', ['eigenes-gefaehrliches'])).toContain('eigenes-gefaehrliches');
  });

  it('macht Pfade sicher (kein Ausbruch aus dem Vault)', () => {
    expect(safeVaultPath('Notizen/Idee.md')).toBe('Notizen/Idee.md');
    expect(safeVaultPath('../../etc/passwd')).toBe('etc/passwd');
    expect(safeVaultPath('.obsidian/plugins/evil.js')).toBe('');
    expect(safeVaultPath('/Notizen//A.md')).toBe('Notizen/A.md');
    expect(safeVaultPath('a:b*c?.md')).toBe('a-b-c-.md');
  });

  it('holt Argumente robust aus dem Werkzeugaufruf', () => {
    expect(argText({ a: '  hi ' }, 'a')).toBe('hi');
    expect(argText({ a: 5 }, 'a')).toBe('5');
    expect(argText({}, 'fehlt')).toBe('');
    expect(argNumber({ n: '200' }, 'n', 5, 1, 100)).toBe(100);
    expect(argNumber({}, 'n', 5, 1, 100)).toBe(5);
  });
});

// ------------------------------------------------------------------ Internet

describe('Internet: Seiten lesen', () => {
  it('macht aus HTML lesbaren Text', () => {
    const html = `<html><head><title>Meine Seite</title><style>p{color:red}</style></head>
      <body><nav>Menü weg</nav><h1>Überschrift</h1><p>Ein Absatz mit <b>Fett</b>.</p>
      <ul><li>Punkt eins</li><li>Punkt zwei</li></ul>
      <a href="https://example.com/x">Ein Link</a><script>alert(1)</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('# Überschrift');
    expect(text).toContain('Ein Absatz mit Fett.');
    expect(text).toContain('- Punkt eins');
    expect(text).toContain('[Ein Link](https://example.com/x)');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('Menü weg');
    expect(extractTitle(html)).toBe('Meine Seite');
  });

  it('löst HTML-Zeichen und DuckDuckGo-Weiterleitungen auf', () => {
    expect(decodeEntities('Fragen &amp; Antworten &#8211; Test &uuml;ber')).toContain('Fragen & Antworten – Test über');
    expect(unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x')).toBe('https://example.com/a');
  });

  it('liest DuckDuckGo-Treffer aus dem HTML', () => {
    const html = `<div class="result__body"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fobsidian.md">Obsidian</a>
      <a class="result__snippet">Notizen &amp; mehr</a></div>`;
    const treffer = parseDuckDuckGo(html);
    expect(treffer).toHaveLength(1);
    expect(treffer[0].title).toBe('Obsidian');
    expect(treffer[0].url).toBe('https://obsidian.md');
    expect(treffer[0].snippet).toBe('Notizen & mehr');
  });
});

describe('Internet: live gegen echte Server', () => {
  it('liest eine Seite über HTTP und kürzt sie bei Bedarf', async () => {
    let server: TestServer | null = null;
    try {
      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><head><title>Testseite</title></head><body><h1>Hallo</h1><p>${'x'.repeat(500)}</p></body></html>`);
      });
      const seite = await webFetch(server.url, { maxChars: 120 }, testDeps().web);
      expect(seite.title).toBe('Testseite');
      expect(seite.text).toContain('# Hallo');
      expect(seite.truncated).toBe(true);
      expect(seite.text).toContain('[… gekürzt');
    } finally {
      await server?.close();
    }
  });

  it('ergänzt fehlendes https:// und lehnt andere Protokolle ab', async () => {
    await expect(webFetch('file:///etc/passwd', { maxChars: 100 }, testDeps().web)).rejects.toThrow(/nur http/);
    await expect(webFetch('', { maxChars: 100 }, testDeps().web)).rejects.toThrow(/Adresse/);
  });

  it('meldet verständlich, wenn eine Seite sperrt', async () => {
    let server: TestServer | null = null;
    try {
      server = await startServer((_req, res) => {
        res.writeHead(403);
        res.end('nope');
      });
      await expect(webFetch(server.url, { maxChars: 100 }, testDeps().web)).rejects.toThrow(/HTTP 403/);
    } finally {
      await server?.close();
    }
  });

  it('sucht über Tavily, Brave und SearXNG', async () => {
    const anfragen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let server: TestServer | null = null;
    try {
      server = await startServer((req, res, body) => {
        const pfad = req.url ?? '';
        anfragen.push({ url: pfad, body, headers: (req.headers ?? {}) as Record<string, string> });
        if (pfad.includes('/res/v1/web/search')) {
          json(res, 200, { web: { results: [{ title: 'Brave-Treffer', url: 'https://b.example', description: '<b>Beschreibung</b>' }] } });
          return;
        }
        if (pfad.startsWith('/searx')) {
          json(res, 200, { results: [{ title: 'SearX-Treffer', url: 'https://c.example', content: 'Beschreibung' }] });
          return;
        }
        if (pfad.startsWith('/search')) {
          json(res, 200, { results: [{ title: 'Tavily-Treffer', url: 'https://a.example', content: 'Beschreibung' }] });
          return;
        }
        json(res, 404, {});
      });

      const tavily = await webSearch(
        'Obsidian',
        { provider: 'tavily', apiKey: 'tv-1', baseUrl: server.url, maxResults: 3 },
        testDeps().web,
      );
      expect(tavily[0].title).toBe('Tavily-Treffer');
      expect(anfragen[0].body).toContain('"query":"Obsidian"');
      expect(anfragen[0].body).toContain('tv-1');

      const brave = await webSearch('Obsidian', { provider: 'brave', apiKey: 'br-1', baseUrl: server.url, maxResults: 3 }, testDeps().web);
      expect(brave[0].title).toBe('Brave-Treffer');
      expect(brave[0].snippet).toBe('Beschreibung');
      expect(anfragen[1].headers['x-subscription-token']).toBe('br-1');

      const searx = await webSearch('Obsidian', { provider: 'searxng', apiKey: '', baseUrl: `${server.url}/searx`, maxResults: 3 }, testDeps().web);
      expect(searx[0].title).toBe('SearX-Treffer');
    } finally {
      await server?.close();
    }
  });

  it('ergänzt bei Tavily den Pfad /search automatisch', () => {
    expect(tavilyUrl('')).toBe('https://api.tavily.com/search');
    expect(tavilyUrl('https://api.tavily.com/')).toBe('https://api.tavily.com/search');
    expect(tavilyUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/search');
    expect(tavilyUrl('http://127.0.0.1:8080/mein/tavily')).toBe('http://127.0.0.1:8080/mein/tavily');
  });

  it('erklärt fehlende Schlüssel und nicht erreichbare Dienste', async () => {
    const deps = testDeps().web;
    await expect(webSearch('x', { provider: 'tavily', apiKey: '', baseUrl: '', maxResults: 3 }, deps)).rejects.toThrow(/Tavily/);
    await expect(webSearch('x', { provider: 'brave', apiKey: '', baseUrl: '', maxResults: 3 }, deps)).rejects.toThrow(/Brave/);
    await expect(webSearch('x', { provider: 'searxng', apiKey: '', baseUrl: '', maxResults: 3 }, deps)).rejects.toThrow(/SearXNG/);
    await expect(webSearch('', { provider: 'tavily', apiKey: 'x', baseUrl: '', maxResults: 3 }, deps)).rejects.toThrow(/Suchbegriff/);
  });
});

// ------------------------------------------------------------------ Vault-Werkzeuge

describe('Vault-Werkzeuge', () => {
  it('sucht, liest, listet und schreibt im Vault', async () => {
    const settings = mergeSettings({ tools: { allowVaultWrite: true, allowInternet: false } });
    const vault = new MemoryVault({ 'Projekte/Alpha.md': 'Projekt Alpha endet am 15. November.' });
    const tools = await buildActiveTools(settings, ctx(vault, settings, [QUELLE]), testDeps());
    const namen = tools.specs.map((spec) => spec.name);
    expect(namen).toContain('vault_search');
    expect(namen).toContain('vault_read');
    expect(namen).toContain('vault_write');
    expect(namen).toContain('vault_append');
    expect(namen).toContain('vault_list');
    expect(namen).not.toContain('web_search');
    expect(namen).not.toContain('run_command');

    const suche = await runTool(tools, { tool: 'vault_search', args: { query: 'Alpha' } }, ctx(vault, settings, [QUELLE]));
    expect(suche.ok).toBe(true);
    expect(suche.text).toContain('[S1] Projekte/Alpha.md');

    const lesen = await runTool(tools, { tool: 'vault_read', args: { path: 'Projekte/Alpha.md' } }, ctx(vault, settings, [QUELLE]));
    expect(lesen.text).toContain('15. November');

    const fehlt = await runTool(tools, { tool: 'vault_read', args: { path: 'Projekte/Beta.md' } }, ctx(vault, settings, [QUELLE]));
    expect(fehlt.ok).toBe(false);
    expect(fehlt.text).toContain('gibt es nicht');

    const schreiben = await runTool(
      tools,
      { tool: 'vault_write', args: { path: 'Neu/Idee.md', content: '# Idee\n\nInhalt' } },
      ctx(vault, settings, [QUELLE]),
    );
    expect(schreiben.ok).toBe(true);
    expect(await vault.read('Neu/Idee.md')).toBe('# Idee\n\nInhalt');

    const anhaengen = await runTool(
      tools,
      { tool: 'vault_append', args: { path: 'Neu/Idee.md', content: '\n\nNachtrag' } },
      ctx(vault, settings, [QUELLE]),
    );
    expect(anhaengen.ok).toBe(true);
    expect(await vault.read('Neu/Idee.md')).toContain('Nachtrag');

    const liste = await runTool(tools, { tool: 'vault_list', args: { filter: 'projekte' } }, ctx(vault, settings, [QUELLE]));
    expect(liste.text).toContain('Projekte/Alpha.md');
    expect(liste.text).not.toContain('Neu/Idee.md');
  });

  it('schreibt nichts, wenn das Schreiben abgeschaltet ist', async () => {
    const settings = mergeSettings({ tools: { allowVaultWrite: false, allowInternet: false } });
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    expect(tools.specs.some((spec) => spec.name === 'vault_write')).toBe(false);
    const versuch = await runTool(tools, { tool: 'vault_write', args: { path: 'x.md', content: 'y' } }, ctx(vault, settings));
    expect(versuch.ok).toBe(false);
    expect(versuch.text).toContain('gibt es nicht');
    expect(vault.files.size).toBe(0);
  });

  it('führt Befehle nur mit Freigabe aus und meldet Fehler offen', async () => {
    const ohne = mergeSettings({ tools: { allowShell: false } });
    const ohneTools = await buildActiveTools(ohne, ctx(new MemoryVault(), ohne), testDeps());
    expect(ohneTools.specs.some((spec) => spec.name === 'run_command')).toBe(false);

    const mit = mergeSettings({ tools: { allowShell: true } });
    let aufgerufen = '';
    const deps = testDeps({
      runCommand: async (command) => {
        aufgerufen = command;
        return command.includes('git') ? { code: 0, stdout: 'On branch main', stderr: '' } : { code: 1, stdout: '', stderr: 'nicht gefunden' };
      },
    });
    const tools = await buildActiveTools(mit, ctx(new MemoryVault(), mit), deps);
    const ok = await runTool(tools, { tool: 'run_command', args: { command: 'git status' } }, ctx(new MemoryVault(), mit));
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain('On branch main');
    expect(aufgerufen).toBe('git status');

    const fehler = await runTool(tools, { tool: 'run_command', args: { command: 'gibtsnicht' } }, ctx(new MemoryVault(), mit));
    expect(fehler.ok).toBe(false);
    expect(fehler.text).toContain('nicht gefunden');

    const gesperrt = await runTool(tools, { tool: 'run_command', args: { command: 'rm -rf /' } }, ctx(new MemoryVault(), mit));
    expect(gesperrt.ok).toBe(false);
    expect(gesperrt.text).toContain('gesperrt');
  });

  it('meldet unbekannte Werkzeuge mit Vorschlag', async () => {
    const settings = mergeSettings({ tools: { allowInternet: false } });
    const tools = await buildActiveTools(settings, ctx(new MemoryVault(), settings), testDeps());
    const ergebnis = await runTool(tools, { tool: 'vault_read_datei', args: {} }, ctx(new MemoryVault(), settings));
    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.text).toMatch(/vault_read/);
  });
});

// ------------------------------------------------------------------ MCP

describe('MCP-Server', () => {
  it('liest JSON- und SSE-Antworten', () => {
    expect(extractMcpMessages('{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json')).toHaveLength(1);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    const nachrichten = extractMcpMessages(sse, 'text/event-stream');
    expect(nachrichten).toHaveLength(1);
    expect(nachrichten[0].id).toBe(2);
    expect(extractMcpMessages('', 'application/json')).toEqual([]);
  });

  it('verbindet sich über HTTP, listet Werkzeuge und ruft sie auf', async () => {
    const gesehen: Array<Record<string, unknown>> = [];
    let server: TestServer | null = null;
    try {
      server = await startServer((_req, res, body) => {
        const nachricht = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
        gesehen.push(nachricht);
        const antwort = (result: unknown) =>
          json(res, 200, { jsonrpc: '2.0', id: nachricht.id ?? null, result });
        if (nachricht.method === 'initialize') {
          res.setHeader('mcp-session-id', 'abc-123');
          antwort({ protocolVersion: '2025-06-18', serverInfo: { name: 'Testserver', version: '1.2' }, capabilities: { tools: {} } });
          return;
        }
        if (nachricht.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (nachricht.method === 'tools/list') {
          antwort({
            tools: [
              { name: 'datei_lesen', description: 'Liest eine Datei', inputSchema: { type: 'object', properties: { pfad: { type: 'string', description: 'Pfad' } }, required: ['pfad'] } },
            ],
          });
          return;
        }
        if (nachricht.method === 'tools/call') {
          antwort({ content: [{ type: 'text', text: `Inhalt von ${(nachricht.params?.arguments as { pfad?: string })?.pfad}` }] });
          return;
        }
        json(res, 400, { error: { message: 'unbekannt' } });
      });

      const client = new McpClient(
        {
          name: 'test',
          enabled: true,
          transport: 'http',
          url: server.url,
          command: '',
          args: [],
          headers: {},
          timeoutSeconds: 10,
        },
        {
          fetchJson: async (options) => {
            const antwort = await fetch(options.url, { method: 'POST', headers: options.headers, body: options.body });
            const kopfzeilen: Record<string, string> = {};
            antwort.headers.forEach((wert, name) => {
              kopfzeilen[name.toLowerCase()] = wert;
            });
            return { status: antwort.status, text: await antwort.text(), headers: kopfzeilen };
          },
        },
      );

      const werkzeuge = await client.listTools();
      expect(werkzeuge).toHaveLength(1);
      expect(werkzeuge[0].name).toBe('datei_lesen');
      expect(client.info).toBe('Testserver 1.2');
      const ergebnis = await client.callTool('datei_lesen', { pfad: '/tmp/x.txt' });
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.text).toBe('Inhalt von /tmp/x.txt');
      // Handschlag und Pflichtmeldung wurden gesendet
      expect(gesehen.map((eintrag) => eintrag.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      client.close();
    } finally {
      await server?.close();
    }
  });

  it('läuft als Werkzeug über die Registry mit', async () => {
    let server: TestServer | null = null;
    try {
      server = await startServer((_req, res, body) => {
        const nachricht = JSON.parse(body) as { id?: number; method?: string };
        const antwort = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: nachricht.id ?? null, result });
        if (nachricht.method === 'initialize') {
          antwort({ protocolVersion: '2025-06-18', serverInfo: { name: 'Mini' }, capabilities: {} });
          return;
        }
        if (nachricht.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (nachricht.method === 'tools/list') {
          antwort({ tools: [{ name: 'wetter', description: 'Wetter holen', inputSchema: { type: 'object', properties: { stadt: { type: 'string' } } } }] });
          return;
        }
        antwort({ content: [{ type: 'text', text: '18 Grad, sonnig' }] });
      });

      const client = new McpClient(
        { name: 'wetter-server', enabled: true, transport: 'http', url: server.url, command: '', args: [], headers: {}, timeoutSeconds: 10 },
        {
          fetchJson: async (options) => {
            const antwort = await fetch(options.url, { method: 'POST', headers: options.headers, body: options.body });
            const kopfzeilen: Record<string, string> = {};
            antwort.headers.forEach((wert, name) => {
              kopfzeilen[name.toLowerCase()] = wert;
            });
            return { status: antwort.status, text: await antwort.text(), headers: kopfzeilen };
          },
        },
      );
      const settings = mergeSettings({ tools: { allowMcp: true, allowInternet: false } });
      const tools = await buildActiveTools(settings, ctx(new MemoryVault(), settings), testDeps(), [client]);
      const name = mcpToolName('wetter-server', 'wetter');
      expect(name).toBe('mcp_wetter_server_wetter');
      expect(tools.specs.some((spec) => spec.name === name)).toBe(true);
      const ergebnis = await runTool(tools, { tool: name, args: { stadt: 'Frankfurt' } }, ctx(new MemoryVault(), settings));
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.text).toContain('18 Grad');
      client.close();
    } finally {
      await server?.close();
    }
  });

  it('meldet einen nicht erreichbaren Server verständlich', async () => {
    const client = new McpClient(
      { name: 'kaputt', enabled: true, transport: 'http', url: 'http://127.0.0.1:9/mcp', command: '', args: [], headers: {}, timeoutSeconds: 5 },
      {
        fetchJson: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    );
    await expect(client.listTools()).rejects.toThrow(/ECONNREFUSED/);
    const settings = mergeSettings({ tools: { allowMcp: true } });
    const tools = await buildActiveTools(settings, ctx(new MemoryVault(), settings), testDeps(), [client]);
    const status = tools.specs.find((spec) => spec.name === 'mcp_kaputt_status');
    expect(status).toBeDefined();
    const ergebnis = await status!.handler({}, ctx(new MemoryVault(), settings));
    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.text).toContain('nicht erreichbar');
    client.close();
  });

  it('spricht mit einem echten Programm über stdio', async () => {
    const script = [
      'let puffer="";',
      'process.stdin.on("data",(d)=>{puffer+=d;',
      ' let i; while((i=puffer.indexOf("\\n"))>=0){const zeile=puffer.slice(0,i);puffer=puffer.slice(i+1);',
      '  if(!zeile.trim())continue; const m=JSON.parse(zeile);',
      '  if(m.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",serverInfo:{name:"Stdio-Test"},capabilities:{}}})+"\\n");',
      '  else if(m.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"hallo",description:"Sagt Hallo",inputSchema:{type:"object",properties:{wer:{type:"string"}}}}]}})+"\\n");',
      '  else if(m.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"Hallo "+(m.params.arguments.wer||"Welt")}]}})+"\\n");',
      '  else if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n");',
      ' }});',
    ].join('');
    const client = new McpClient(
      {
        name: 'stdio-test',
        enabled: true,
        transport: 'stdio',
        url: '',
        command: process.execPath,
        args: ['-e', script],
        headers: {},
        timeoutSeconds: 15,
      },
      { fetchJson: async () => ({ status: 500, text: '', headers: {} }), nodeRequire: (modul: string) => nodeRequire(modul) },
    );
    try {
      const werkzeuge = await client.listTools();
      expect(werkzeuge).toHaveLength(1);
      expect(werkzeuge[0].name).toBe('hallo');
      const ergebnis = await client.callTool('hallo', { wer: 'Jarvis' });
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.text).toBe('Hallo Jarvis');
      expect(describeSchema(werkzeuge[0].inputSchema)).toContain('wer: string');
    } finally {
      client.close();
    }
  });

  it('erklärt auf Geräten ohne Node, warum stdio nicht geht', async () => {
    const client = new McpClient(
      { name: 'ohne-node', enabled: true, transport: 'stdio', url: '', command: 'npx', args: ['-y', 'x'], headers: {}, timeoutSeconds: 5 },
      { fetchJson: async () => ({ status: 500, text: '', headers: {} }) },
    );
    await expect(client.listTools()).rejects.toThrow(/Desktop/);
    client.close();
  });

  it('bricht mit klarer Meldung ab, wenn nichts geantwortet hat (Zeitlimit)', async () => {
    const client = new McpClient(
      { name: 'langsam', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp', command: '', args: [], headers: {}, timeoutSeconds: 5 },
      { fetchJson: async () => ({ status: 202, text: '', headers: {} }) },
    );
    const transport = (client as unknown as { transport: (typeof HttpMcpTransport extends new (...args: never[]) => infer T ? T : never) | unknown }).transport;
    void transport;
    const kurzes = new McpClient(
      { name: 'langsam', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp', command: '', args: [], headers: {}, timeoutSeconds: 5 },
      { fetchJson: async () => ({ status: 202, text: '', headers: {} }) },
    );
    // Zeitlimit im Test kurz halten
    (kurzes as unknown as { config: { timeoutSeconds: number } }).config.timeoutSeconds = 0.2;
    await expect(kurzes.listTools()).rejects.toThrow(/nicht innerhalb/);
    kurzes.close();
    client.close();
  });

  it('kennt stdio ohne Node nicht', async () => {
    const transport = new StdioMcpTransport('npx', ['-y', 'x'], { fetchJson: async () => ({ status: 0, text: '', headers: {} }) });
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' })).rejects.toThrow(/Desktop/);
    transport.close();
  });
});

// ------------------------------------------------------------------ Agent-Schleife

function brainAntwort(text: string, model = 'gpt-6-astra'): BrainAnswer {
  return {
    text,
    providerId: 'openai',
    model,
    durationMs: 120,
    attempts: [{ providerId: 'openai', model }],
    escalated: false,
  };
}

describe('Werkzeug-Schleife', () => {
  const settings = mergeSettings({ tools: { allowInternet: true, allowVaultWrite: true, searchProvider: 'tavily' } });

  it('führt Werkzeuge aus und liefert danach die fertige Antwort', async () => {
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    const aufrufe: ChatMessage[][] = [];
    const schritte: string[] = [];

    const lauf = await runAgent({
      brain: {
        run: async (options) => {
          aufrufe.push(options.messages);
          if (aufrufe.length === 1) {
            return brainAntwort('```jarvis-tool\n{"tool": "vault_write", "args": {"path": "Notizen/Neu.md", "content": "# Neu"}}\n```');
          }
          return brainAntwort('Die Notiz "Notizen/Neu.md" wurde angelegt. [Q1]');
        },
      },
      question: 'Lege eine Notiz an',
      mode: 'vault',
      route: 'cloud',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'AUFGABE: Lege eine Notiz an',
      tools,
      toolContext: ctx(vault, settings),
      effort: 'normal',
      maxSteps: 3,
      onTool: (step) => schritte.push(step.tool),
    });

    expect(lauf.usedTools).toBe(true);
    expect(lauf.steps).toHaveLength(1);
    expect(lauf.steps[0].tool).toBe('vault_write');
    expect(lauf.steps[0].ok).toBe(true);
    expect(schritte).toEqual(['vault_write']);
    expect(await vault.read('Notizen/Neu.md')).toBe('# Neu');
    expect(lauf.answer.text).toContain('wurde angelegt');
    // Die Werkzeugliste steht in der Systemanweisung, das Ergebnis im Verlauf
    expect(aufrufe[1].map((m) => m.content).join('\n')).toContain('WERKZEUG-ERGEBNIS');
    expect(aufrufe[1].map((m) => m.content).join('\n')).toContain('Notizen/Neu.md');
  });

  it('prüft bei „maximal" die Antwort noch einmal', async () => {
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    const rollen: string[] = [];
    const lauf = await runAgent({
      brain: {
        run: async (options) => {
          rollen.push(options.messages.at(-1)?.content.slice(0, 40) ?? '');
          if (rollen.length === 1) {
            return brainAntwort('```jarvis-tool\n{"tool": "calculate", "args": {"expression": "2+2"}}\n```');
          }
          if (rollen.length === 2) return brainAntwort('Das Ergebnis ist 5.');
          return brainAntwort('Das Ergebnis ist 4. (Korrigiert nach Prüfung.)');
        },
      },
      question: 'Rechne 2+2',
      mode: 'chat',
      route: 'cloud',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'Rechne 2+2',
      tools,
      toolContext: ctx(vault, settings),
      effort: 'max',
      maxSteps: 3,
    });
    expect(rollen).toHaveLength(3);
    expect(rollen[2]).toContain('PRÜFAUFGABE');
    expect(lauf.answer.text).toContain('Korrigiert nach Prüfung');
  });

  it('nimmt bei einem Werkzeugfehler den Fehler in den Verlauf auf', async () => {
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    const verlauf: string[] = [];
    const lauf = await runAgent({
      brain: {
        run: async (options) => {
          verlauf.push(options.messages.map((m) => m.content).join('\n'));
          return verlauf.length === 1
            ? brainAntwort('```jarvis-tool\n{"tool": "vault_read", "args": {"path": "gibtsnicht.md"}}\n```')
            : brainAntwort('Die Notiz gibt es nicht — bitte Pfad prüfen.');
        },
      },
      question: 'Lies die Notiz',
      mode: 'note',
      route: 'cloud',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'Lies gibtsnicht.md',
      tools,
      toolContext: ctx(vault, settings),
      effort: 'normal',
      maxSteps: 2,
    });
    expect(lauf.steps[0].ok).toBe(false);
    expect(verlauf[1]).toContain('→ FEHLER');
    expect(lauf.answer.text).toContain('gibt es nicht');
  });

  it('stoppt nach der eingestellten Zahl von Runden', async () => {
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    let runden = 0;
    const lauf = await runAgent({
      brain: {
        run: async () => {
          runden++;
          return brainAntwort('```jarvis-tool\n{"tool": "vault_list", "args": {}}\n```');
        },
      },
      question: 'Endlosschleife',
      mode: 'vault',
      route: 'cloud',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'Endlosschleife',
      tools,
      toolContext: ctx(vault, settings),
      effort: 'normal',
      maxSteps: 2,
    });
    // 1 Startrunde + 2 Wiederholungen
    expect(runden).toBe(3);
    expect(lauf.notices.join(' ')).toMatch(/Werkzeugrunden gestoppt/);
  });

  it('warnt bei erfundenen Werkzeugnamen statt sie auszuführen', async () => {
    const vault = new MemoryVault();
    const tools = await buildActiveTools(settings, ctx(vault, settings), testDeps());
    let aufrufe = 0;
    const lauf = await runAgent({
      brain: {
        run: async () => {
          aufrufe++;
          return aufrufe === 1
            ? brainAntwort('```jarvis-tool\n{"tool": "weltformel", "args": {}}\n```')
            : brainAntwort('Diese Formel gibt es nicht in meinen Werkzeugen.');
        },
      },
      question: 'Test',
      mode: 'chat',
      route: 'cloud',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'Test',
      tools,
      toolContext: ctx(vault, settings),
      effort: 'normal',
      maxSteps: 1,
    });
    expect(aufrufe).toBe(2);
    expect(lauf.notices.join(' ')).toContain('weltformel');
    expect(lauf.steps).toHaveLength(0);
    expect(lauf.answer.text).toContain('gibt es nicht');
  });

  it('funktioniert ohne Werkzeuge unverändert (eine Antwort)', async () => {
    let aufrufe = 0;
    const lauf = await runAgent({
      brain: {
        run: async () => {
          aufrufe++;
          return brainAntwort('Klare Antwort.');
        },
      },
      question: 'Frage',
      mode: 'vault',
      route: 'local',
      history: [],
      system: 'Du bist Jarvis.',
      userMessage: 'Frage',
      toolContext: ctx(new MemoryVault(), settings),
      effort: 'normal',
      maxSteps: 4,
    });
    expect(aufrufe).toBe(1);
    expect(lauf.usedTools).toBe(false);
    expect(lauf.answer.text).toBe('Klare Antwort.');
  });

  it('zählt Token über mehrere Runden zusammen', () => {
    expect(sumUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, outputTokens: 2 })).toEqual({
      inputTokens: 13,
      outputTokens: 7,
    });
    expect(sumUsage(undefined, undefined)).toBeUndefined();
  });
});

// ------------------------------------------------- Verbundene Dienste (GitHub, HF, n8n)

describe('Werkzeuge für GitHub, HuggingFace und n8n', () => {
  async function dienstSettings(dienste: TestServer, extra: Record<string, unknown> = {}) {
    return mergeSettings({
      github: { enabled: true, owner: 'mar65vo187', repo: 'jarvis', branch: 'main' },
      tools: {
        enabled: true,
        allowInternet: true,
        githubApiBase: dienste.url,
        hfBaseUrl: dienste.url,
        n8nWebhookUrl: `${dienste.url}/webhook/jarvis`,
        ...extra,
      },
    });
  }

  it('liest eine Datei aus dem verbundenen GitHub-Repository', async () => {
    const anfragen: string[] = [];
    const dienste = await startServer((req, res) => {
      anfragen.push(`${req.method} ${req.url}`);
      if ((req.url ?? '').startsWith('/repos/mar65vo187/jarvis/contents/')) {
        const inhalt = Buffer.from('# Jarvis\n\nLäuft lokal und online.', 'utf8').toString('base64');
        json(res, 200, { path: 'README.md', encoding: 'base64', content: inhalt });
        return;
      }
      json(res, 404, { message: 'Not Found' });
    });
    try {
      const settings = await dienstSettings(dienste);
      const deps = testDeps();
      const tools = await buildActiveTools(settings, ctx(new MemoryVault(), settings) as never, deps);
      expect(tools.names.has('github_file')).toBe(true);
      const ergebnis = await runTool(tools, { tool: 'github_file', args: { path: 'README.md' } }, ctx(new MemoryVault(), settings) as never);
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.text).toContain('Läuft lokal und online.');
      expect(anfragen[0]).toContain('GET /repos/mar65vo187/jarvis/contents/README.md');
    } finally {
      await dienste.close();
    }
  });

  it('sucht im Repository und listet Aufgaben', async () => {
    const dienste = await startServer((req, res) => {
      if ((req.url ?? '').startsWith('/search/code')) {
        json(res, 200, { items: [{ path: 'src/brain.ts', html_url: 'https://github.com/x/y/blob/main/src/brain.ts', repository: { full_name: 'mar65vo187/jarvis' } }] });
        return;
      }
      if ((req.url ?? '').startsWith('/repos/mar65vo187/jarvis/issues')) {
        json(res, 200, [
          { number: 7, title: 'Release 2.1.0', state: 'open', labels: [{ name: 'release' }], html_url: 'https://github.com/x/y/issues/7' },
          { number: 8, title: 'Nur ein Pull Request', state: 'open', pull_request: {}, html_url: 'https://github.com/x/y/pull/8' },
        ]);
        return;
      }
      json(res, 404, {});
    });
    try {
      const settings = await dienstSettings(dienste);
      const deps = testDeps();
      const vault = new MemoryVault();
      const tools = await buildActiveTools(settings, ctx(vault, settings) as never, deps);
      const suche = await runTool(tools, { tool: 'github_search', args: { query: 'deliberate' } }, ctx(vault, settings) as never);
      expect(suche.ok).toBe(true);
      expect(suche.text).toContain('src/brain.ts');
      const aufgaben = await runTool(tools, { tool: 'github_issues', args: { state: 'open' } }, ctx(vault, settings) as never);
      expect(aufgaben.ok).toBe(true);
      expect(aufgaben.text).toContain('#7');
      expect(aufgaben.text).not.toContain('#8');
    } finally {
      await dienste.close();
    }
  });

  it('schreibt nur ins GitHub-Repository, wenn es freigegeben ist', async () => {
    const geschrieben: Array<{ url: string; rumpf: string }> = [];
    const dienste = await startServer((req, res) => {
      if (req.method === 'PUT') {
        geschrieben.push({ url: req.url ?? '', rumpf: (dienste.requests.at(-1)?.body as string) ?? '' });
        json(res, 201, { commit: { sha: 'abcdef1234567890', html_url: 'https://github.com/x/y/commit/abcdef1' } });
        return;
      }
      // Vorhandene Datei: SHA wird für das Update gebraucht
      json(res, 200, { path: 'Notizen/Idee.md', sha: 'a1b2c3', encoding: 'base64', content: Buffer.from('alt').toString('base64') });
    });
    try {
      const deps = testDeps();

      const gesperrt = await dienstSettings(dienste);
      const ohne = await buildActiveTools(gesperrt, ctx(new MemoryVault(), gesperrt) as never, deps);
      expect(ohne.names.has('github_write')).toBe(false);

      const erlaubt = await dienstSettings(dienste, { allowGithubWrite: true });
      const mit = await buildActiveTools(erlaubt, ctx(new MemoryVault(), erlaubt) as never, deps);
      expect(mit.names.has('github_write')).toBe(true);
      const ergebnis = await runTool(
        mit,
        { tool: 'github_write', args: { path: 'Notizen/Idee.md', content: 'Neuer Text', message: 'Idee festgehalten' } },
        ctx(new MemoryVault(), erlaubt) as never,
      );
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.summary).toBe('aktualisiert');
      const rumpf = JSON.parse(geschrieben[0].rumpf) as { sha?: string; message?: string; content?: string; branch?: string };
      expect(rumpf.sha).toBe('a1b2c3');
      expect(rumpf.branch).toBe('main');
      expect(Buffer.from(rumpf.content!, 'base64').toString('utf8')).toBe('Neuer Text');
    } finally {
      await dienste.close();
    }
  });

  it('sucht Modelle bei HuggingFace und holt Einzelheiten', async () => {
    const dienste = await startServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/models?search=')) {
        json(res, 200, [
          { id: 'Qwen/Qwen3-8B', downloads: 123456, likes: 42, pipeline_tag: 'text-generation' },
          { id: 'unsloth/Qwen3-8B-GGUF', downloads: 999, likes: 3, tags: ['gguf'] },
        ]);
        return;
      }
      if ((req.url ?? '').startsWith('/api/models/Qwen/')) {
        json(res, 200, {
          id: 'Qwen/Qwen3-8B',
          downloads: 123456,
          likes: 42,
          pipeline_tag: 'text-generation',
          library_name: 'transformers',
          cardData: { license: 'apache-2.0', language: ['en', 'de'] },
          siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors' }],
        });
        return;
      }
      json(res, 404, {});
    });
    try {
      const settings = await dienstSettings(dienste);
      const deps = testDeps();
      const vault = new MemoryVault();
      const tools = await buildActiveTools(settings, ctx(vault, settings) as never, deps);
      const suche = await runTool(tools, { tool: 'hf_search', args: { query: 'qwen3' } }, ctx(vault, settings) as never);
      expect(suche.ok).toBe(true);
      expect(suche.text).toContain('Qwen/Qwen3-8B');
      expect(suche.text).toContain('Downloads');
      const info = await runTool(tools, { tool: 'hf_info', args: { id: 'Qwen/Qwen3-8B' } }, ctx(vault, settings) as never);
      expect(info.ok).toBe(true);
      expect(info.text).toContain('apache-2.0');
      expect(info.text).toContain('model.safetensors');
    } finally {
      await dienste.close();
    }
  });

  it('löst einen n8n-Workflow aus und gibt die Antwort zurück', async () => {
    const aufrufe: Array<{ rumpf: string; schluessel?: string }> = [];
    const dienste = await startServer((req, res) => {
      if (req.url === '/webhook/jarvis') {
        aufrufe.push({
          rumpf: (dienste.requests.at(-1)?.body as string) ?? '',
          schluessel: req.headers['x-jarvis-key'] as string | undefined,
        });
        json(res, 200, { ok: true, nachricht: 'Workflow lief' });
        return;
      }
      json(res, 404, {});
    });
    try {
      const settings = await dienstSettings(dienste);
      const deps = testDeps();
      const vault = new MemoryVault();
      const tools = await buildActiveTools(settings, ctx(vault, settings) as never, deps);
      expect(tools.names.has('n8n_run')).toBe(true);
      const ergebnis = await runTool(
        tools,
        { tool: 'n8n_run', args: { payload: '{"text": "Bericht bitte"}' } },
        ctx(vault, settings) as never,
      );
      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.text).toContain('Workflow lief');
      expect(JSON.parse(aufrufe[0].rumpf)).toEqual({ text: 'Bericht bitte' });
      expect(aufrufe[0].schluessel).toBe('n8n-test');
    } finally {
      await dienste.close();
    }
  });

  it('meldet fehlende Einrichtung verständlich (kein GitHub eingerichtet)', async () => {
    const dienste = await startServer((_req, res) => json(res, 404, {}));
    try {
      const settings = await dienstSettings(dienste);
      settings.github.enabled = false;
      const deps = testDeps();
      const tools = await buildActiveTools(settings, ctx(new MemoryVault(), settings) as never, deps);
      expect(tools.names.has('github_file')).toBe(false);
      // HuggingFace und n8n bleiben vorhanden, weil sie ohne Konto funktionieren.
      expect(tools.names.has('hf_search')).toBe(true);
    } finally {
      await dienste.close();
    }
  });
});
