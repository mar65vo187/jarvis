/**
 * Die Werkzeug-Registry: welche Werkzeuge Jarvis kennt und wie sie aufgerufen werden.
 *
 * Jedes Werkzeug respektiert die Einstellungen: ist es abgeschaltet, wird es dem
 * Modell gar nicht erst angeboten (und ein Aufruf wird abgewiesen).
 */
import type { JarvisSettings } from '../types';
import { describeSchema, McpClient, type McpToolInfo } from './mcp';
import { htmlToText, renderHits, webFetch, webSearch, type WebDeps } from './web';
import { argNumber, argText, safeVaultPath, type ToolCall, type ToolContext, type ToolSpec } from './types';
import { buildServiceTools, type DienstDeps } from './dienste';

export interface RegistryDeps {
  web: WebDeps;
  /** Programme ausführen (nur Desktop). Fehlt auf dem Tablet. */
  runCommand?: (
    command: string,
    options: { cwd?: string; timeoutMs: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Node-Zugriff für stdio-MCP (Desktop). */
  nodeRequire?: (modul: string) => unknown;
  /** HTTP-Anfragen für GitHub, HuggingFace und n8n. */
  http?: DienstDeps['http'];
  /** Zugangsschlüssel lesen (z. B. "github", "huggingface", "n8n"). */
  key?: (id: string) => string;
}

/** Werkzeuge, die der Nutzer freigeschaltet hat. */
export interface ActiveTools {
  specs: ToolSpec[];
  names: Set<string>;
  /** MCP-Werkzeuge: Anzeigename → (Server-Client, Werkzeugname) */
  mcp: Map<string, { client: McpClient; tool: McpToolInfo }>;
}

export async function buildActiveTools(
  settings: JarvisSettings,
  ctx: ToolContext,
  deps: RegistryDeps,
  mcpClients: McpClient[] = [],
): Promise<ActiveTools> {
  const t = settings.tools;
  const specs: ToolSpec[] = [];
  const mcp = new Map<string, { client: McpClient; tool: McpToolInfo }>();

  // ---------------------------------------------------------------- Vault
  specs.push({
    name: 'vault_search',
    summary: 'Durchsucht die Notizen im Vault und gibt die besten Ausschnitte zurück.',
    params: [
      { name: 'query', description: 'Suchbegriffe', required: true },
      { name: 'limit', description: 'Wie viele Ausschnitte (1-10, Standard 5)', required: false },
    ],
    handler: async (args, context) => {
      const query = argText(args, 'query');
      if (!query) return { ok: false, text: 'Es fehlt "query" (die Suchbegriffe).' };
      const limit = argNumber(args, 'limit', 5, 1, 10);
      await context.index.ensureFresh(false);
      const treffer = await context.index.search(query, { topK: limit, contextChars: 6000 });
      if (!treffer.length) return { ok: true, text: `Keine passenden Notizen zu "${query}".`, summary: '0 Treffer' };
      const text = treffer
        .map((source, index) => `[S${index + 1}] ${source.path}${source.heading ? ` › ${source.heading}` : ''}\n${source.text.slice(0, 1500)}`)
        .join('\n\n---\n\n');
      return { ok: true, text, summary: `${treffer.length} Treffer` };
    },
  });

  specs.push({
    name: 'vault_read',
    summary: 'Liest eine Notiz vollständig (oder einen Abschnitt davon).',
    params: [
      { name: 'path', description: 'Pfad der Notiz, z. B. "Projekte/Alpha.md"', required: true },
      { name: 'maxChars', description: 'Höchstzahl Zeichen (Standard 12000)', required: false },
    ],
    handler: async (args, context) => {
      const roh = argText(args, 'path');
      const pfad = safeVaultPath(roh, context.settings().rag.excludeFolders[0] ? '.obsidian' : '.obsidian');
      if (!pfad) return { ok: false, text: `Ungültiger Pfad: ${roh}` };
      const inhalt = await context.vault.read(pfad);
      if (inhalt === null) {
        const alternativen = await findSimilar(context, pfad);
        return {
          ok: false,
          text: `Die Notiz "${pfad}" gibt es nicht.${alternativen.length ? ` Ähnliche Pfade: ${alternativen.join(', ')}` : ''}`,
        };
      }
      const grenze = argNumber(args, 'maxChars', 12_000, 500, 60_000);
      return {
        ok: true,
        text: inhalt.length > grenze ? `${inhalt.slice(0, grenze)}\n\n[… gekürzt]` : inhalt,
        summary: `${inhalt.length} Zeichen`,
      };
    },
  });

  if (t.allowVaultWrite) {
    specs.push({
      name: 'vault_write',
      summary: 'Schreibt eine Notiz im Vault (legt sie an oder ersetzt den Inhalt).',
      params: [
        { name: 'path', description: 'Pfad der Notiz', required: true },
        { name: 'content', description: 'Der neue Inhalt in Markdown', required: true },
      ],
      danger: 'write',
      handler: async (args, context) => {
        const pfad = safeVaultPath(argText(args, 'path'));
        const inhalt = argText(args, 'content');
        if (!pfad) return { ok: false, text: 'Ungültiger Pfad.' };
        if (!inhalt) return { ok: false, text: 'Es fehlt "content" (der Inhalt).' };
        const vorhanden = await context.vault.exists(pfad);
        if (vorhanden) await context.vault.overwrite(pfad, inhalt);
        else await context.vault.create(pfad, inhalt);
        return { ok: true, text: `Notiz "${pfad}" ${vorhanden ? 'aktualisiert' : 'angelegt'} (${inhalt.length} Zeichen).`, summary: pfad };
      },
    });

    specs.push({
      name: 'vault_append',
      summary: 'Hängt Text an eine Notiz an (legt sie an, falls sie fehlt).',
      params: [
        { name: 'path', description: 'Pfad der Notiz', required: true },
        { name: 'content', description: 'Der anzuhängende Text', required: true },
      ],
      danger: 'write',
      handler: async (args, context) => {
        const pfad = safeVaultPath(argText(args, 'path'));
        const inhalt = argText(args, 'content');
        if (!pfad) return { ok: false, text: 'Ungültiger Pfad.' };
        if (!inhalt) return { ok: false, text: 'Es fehlt "content" (der Text).' };
        await context.vault.append(pfad, inhalt);
        return { ok: true, text: `An "${pfad}" angehängt (${inhalt.length} Zeichen).`, summary: pfad };
      },
    });
  }

  specs.push({
    name: 'vault_list',
    summary: 'Listet Notizen im Vault auf (optional gefiltert).',
    params: [
      { name: 'filter', description: 'Text, der im Pfad vorkommen soll', required: false },
      { name: 'limit', description: 'Höchstzahl (Standard 40)', required: false },
    ],
    handler: async (args, context) => {
      const filter = argText(args, 'filter').toLowerCase();
      const grenze = argNumber(args, 'limit', 40, 1, 200);
      const alle = await context.vault.listMarkdown();
      const passend = filter ? alle.filter((pfad) => pfad.toLowerCase().includes(filter)) : alle;
      if (!passend.length) return { ok: true, text: filter ? `Keine Notiz enthält "${filter}".` : 'Der Vault enthält keine Markdown-Notizen.', summary: '0' };
      const gezeigt = passend.slice(0, grenze);
      return {
        ok: true,
        text: `${passend.length} Notiz(en)${filter ? ` mit "${filter}"` : ''}:\n${gezeigt.map((pfad) => `- ${pfad}`).join('\n')}${
          passend.length > gezeigt.length ? `\n… und ${passend.length - gezeigt.length} weitere` : ''
        }`,
        summary: `${passend.length} Notizen`,
      };
    },
  });

  // ---------------------------------------------------------------- Internet
  if (t.allowInternet) {
    specs.push({
      name: 'web_search',
      summary: 'Sucht im Internet (echte, aktuelle Treffer).',
      params: [
        { name: 'query', description: 'Suchbegriffe', required: true },
        { name: 'count', description: 'Wie viele Treffer (1-10)', required: false },
      ],
      handler: async (args, context) => {
        const query = argText(args, 'query');
        if (!query) return { ok: false, text: 'Es fehlt "query" (die Suchbegriffe).' };
        const count = argNumber(args, 'count', 5, 1, 10);
        const settings = context.settings();
        try {
          const treffer = await webSearch(
            query,
            {
              provider: settings.tools.searchProvider,
              apiKey: settings.tools.searchApiKey,
              baseUrl: settings.tools.searchBaseUrl,
              maxResults: count,
              signal: context.signal,
              language: settings.answerLanguage === 'Deutsch' ? 'de' : undefined,
            },
            deps.web,
          );
          return { ok: true, text: renderHits(query, treffer), summary: `${treffer.length} Treffer` };
        } catch (fehler) {
          return { ok: false, text: (fehler as Error).message };
        }
      },
    });

    specs.push({
      name: 'web_read',
      summary: 'Lädt eine Internetseite und gibt ihren Text zurück.',
      params: [
        { name: 'url', description: 'Die Adresse (https://…)', required: true },
        { name: 'maxChars', description: 'Höchstzahl Zeichen (Standard 8000)', required: false },
      ],
      handler: async (args, context) => {
        const url = argText(args, 'url');
        if (!url) return { ok: false, text: 'Es fehlt "url" (die Adresse).' };
        const maxChars = argNumber(args, 'maxChars', 8000, 500, 40_000);
        try {
          const seite = await webFetch(url, { maxChars, signal: context.signal }, deps.web);
          return {
            ok: true,
            text: `TITEL: ${seite.title}\nADRESSE: ${seite.url}\n\n${seite.text}`,
            summary: `${seite.text.length} Zeichen`,
          };
        } catch (fehler) {
          return { ok: false, text: (fehler as Error).message };
        }
      },
    });
  }

  // ------------------------------------------------------ Rechner / Befehle
  if (t.allowShell && deps.runCommand) {
    specs.push({
      name: 'run_command',
      summary: 'Führt einen Befehl auf diesem Rechner aus (nur Desktop, mit Freigabe).',
      params: [
        { name: 'command', description: 'Der Befehl, z. B. "git status"', required: true },
        { name: 'cwd', description: 'Arbeitsordner', required: false },
      ],
      danger: 'shell',
      handler: async (args, context) => {
        const command = argText(args, 'command');
        if (!command) return { ok: false, text: 'Es fehlt "command".' };
        const blockiert = blockiertGrund(command, context.settings().tools.shellBlocklist);
        if (blockiert) return { ok: false, text: `Dieser Befehl ist gesperrt: ${blockiert}` };
        const cwdRoh = argText(args, 'cwd');
        const cwd = cwdRoh ? safeVaultPath(cwdRoh) : '';
        try {
          const ergebnis = await deps.runCommand!(command, {
            cwd: cwd ? `${context.vault.vaultPath()}/${cwd}` : context.vault.vaultPath() || undefined,
            timeoutMs: Math.max(5, Math.min(300, context.settings().tools.commandTimeoutSeconds)) * 1000,
          });
          const ausgabe = [ergebnis.stdout.trim(), ergebnis.stderr.trim()].filter(Boolean).join('\n').slice(0, 12_000);
          return {
            ok: ergebnis.code === 0,
            text: `Befehl: ${command}\nRückgabewert: ${ergebnis.code}\n${ausgabe || '(keine Ausgabe)'}`,
            summary: ergebnis.code === 0 ? 'fertig' : `Code ${ergebnis.code}`,
          };
        } catch (fehler) {
          return { ok: false, text: `Der Befehl konnte nicht ausgeführt werden: ${(fehler as Error).message}` };
        }
      },
    });
  }

  if (t.allowFiles && deps.nodeRequire) {
    specs.push({
      name: 'read_file',
      summary: 'Liest eine Datei außerhalb des Vaults (nur Desktop).',
      params: [
        { name: 'path', description: 'Vollständiger Pfad', required: true },
        { name: 'maxChars', description: 'Höchstzahl Zeichen (Standard 8000)', required: false },
      ],
      handler: async (args) => {
        const pfad = argText(args, 'path');
        if (!pfad) return { ok: false, text: 'Es fehlt "path".' };
        try {
          const fs = deps.nodeRequire!('node:fs/promises') as { readFile(path: string, encoding: string): Promise<string> };
          const inhalt = await fs.readFile(pfad, 'utf8');
          const grenze = argNumber(args, 'maxChars', 8000, 200, 40_000);
          return { ok: true, text: inhalt.length > grenze ? `${inhalt.slice(0, grenze)}\n[… gekürzt]` : inhalt, summary: `${inhalt.length} Zeichen` };
        } catch (fehler) {
          return { ok: false, text: `Datei nicht lesbar: ${(fehler as Error).message}` };
        }
      },
    });

    specs.push({
      name: 'write_file',
      summary: 'Schreibt eine Datei außerhalb des Vaults (nur Desktop, mit Freigabe).',
      params: [
        { name: 'path', description: 'Vollständiger Pfad', required: true },
        { name: 'content', description: 'Inhalt', required: true },
      ],
      danger: 'write',
      handler: async (args) => {
        const pfad = argText(args, 'path');
        const inhalt = argText(args, 'content');
        if (!pfad || !inhalt) return { ok: false, text: 'Es fehlen "path" und/oder "content".' };
        try {
          const fs = deps.nodeRequire!('node:fs/promises') as { writeFile(path: string, data: string): Promise<void> };
          await fs.writeFile(pfad, inhalt);
          return { ok: true, text: `Datei geschrieben: ${pfad} (${inhalt.length} Zeichen).`, summary: pfad };
        } catch (fehler) {
          return { ok: false, text: `Datei nicht schreibbar: ${(fehler as Error).message}` };
        }
      },
    });
  }

  // ------------------------------------------------------------------ Rechnen
  specs.push({
    name: 'calculate',
    summary: 'Rechnet einen Ausdruck sicher aus (Grundrechenarten, Prozent, Klammern).',
    params: [{ name: 'expression', description: 'z. B. "(1250 * 1.19) / 3"', required: true }],
    handler: async (args) => {
      const ausdruck = argText(args, 'expression');
      if (!ausdruck) return { ok: false, text: 'Es fehlt "expression".' };
      try {
        const wert = calculate(ausdruck);
        return { ok: true, text: `${ausdruck} = ${wert}`, summary: String(wert) };
      } catch (fehler) {
        return { ok: false, text: (fehler as Error).message };
      }
    },
  });

  // ------------------------------------------------- Dienste (GitHub, HF, n8n)
  specs.push(...buildServiceTools(settings, { http: deps.http, key: deps.key }));

  // -------------------------------------------------------------------- MCP
  if (t.allowMcp) {
    for (const client of mcpClients) {
      if (!client) continue;
      try {
        const werkzeuge = await client.listTools();
        for (const werkzeug of werkzeuge) {
          const name = mcpToolName(client.name, werkzeug.name);
          specs.push({
            name,
            summary: `[${client.name}] ${werkzeug.description || werkzeug.title}`,
            params: schemaZuParams(werkzeug.inputSchema),
            danger: 'shell',
            handler: async (args) => {
              try {
                return await client.callTool(werkzeug.name, args);
              } catch (fehler) {
                return { ok: false, text: (fehler as Error).message };
              }
            },
          });
          mcp.set(name, { client, tool: werkzeug });
        }
      } catch (fehler) {
        // Ein nicht erreichbarer Server darf die anderen nicht blockieren.
        specs.push({
          name: mcpToolName(client.name, 'status'),
          summary: `[${client.name}] Verbindung prüfen (Server war nicht erreichbar)`,
          params: [],
          handler: async () => ({ ok: false, text: `Der Server "${client.name}" ist nicht erreichbar: ${(fehler as Error).message}` }),
        });
      }
    }
  }

  const aktiv = specs.filter((spec) => {
    if (spec.danger === 'shell' && !t.allowShell && !spec.name.startsWith('mcp_')) return false;
    return true;
  });

  return { specs: aktiv, names: new Set(aktiv.map((spec) => spec.name)), mcp };
}

export function mcpToolName(server: string, tool: string): string {
  const sauber = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return `mcp_${sauber(server) || 'server'}_${sauber(tool) || 'werkzeug'}`;
}

function schemaZuParams(schema: Record<string, unknown>): ToolSpec['params'] {
  const eigenschaften = (schema?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const pflicht = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  return Object.entries(eigenschaften).map(([name, info]) => ({
    name,
    description: (info?.description ?? info?.type ?? 'Wert').replace(/\s+/g, ' ').slice(0, 120),
    required: pflicht.includes(name),
  }));
}

/** Anzeigehilfe: Werkzeug samt Kurzbeschreibung des Eingabeschemas. */
export function describeMcpTools(clients: McpClient[], werkzeugeJeServer: Map<string, McpToolInfo[]>): string[] {
  const zeilen: string[] = [];
  for (const client of clients) {
    const werkzeuge = werkzeugeJeServer.get(client.name) ?? [];
    zeilen.push(`${client.name}: ${werkzeuge.length ? werkzeuge.map((w) => w.name).join(', ') : '(keine Werkzeuge)'}`);
  }
  return zeilen;
}

/** Gefährliche Befehle sperren (Verzeichnis löschen, Formatieren, Herunterfahren …). */
export function blockiertGrund(command: string, blocklist: string[]): string {
  const text = command.toLowerCase();
  const standard = ['rm -rf /', 'mkfs', ':(){', 'shutdown', 'reboot', 'diskpart', 'format c:', 'del /f /s /q c:\\'];
  const liste = [...standard, ...(blocklist ?? [])].map((eintrag) => eintrag.toLowerCase()).filter(Boolean);
  for (const eintrag of liste) {
    if (text.includes(eintrag)) return `enthält "${eintrag}"`;
  }
  return '';
}

/**
 * Kleiner, sicherer Rechner: nur Zahlen, Klammern, die vier Grundrechenarten,
 * Hoch, Prozent und ein paar Funktionen. Kein Code, keine Ausführung.
 */
export function calculate(ausdruck: string): number {
  const text = ausdruck
    .replace(/\s+/g, '')
    .replace(/^=/, '')
    // Deutsche Schreibweise: 1.000,50 -> 1000.50
    .replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2')
    .replace(/,/g, '.');
  if (!text) throw new Error('Der Ausdruck ist leer.');
  if (!/^[0-9+\-*/().%^e]+$/i.test(text)) throw new Error('Der Ausdruck enthält unerlaubte Zeichen.');
  if (/(\d+(?:\.\d+)?)%/.test(text)) text.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  let position = 0;
  const quell = text;

  const zahl = (): number => {
    const rest = quell.slice(position);
    const treffer = /^\d+(?:\.\d+)?/.exec(rest);
    if (!treffer) throw new Error(`An Stelle ${position} wurde eine Zahl erwartet.`);
    position += treffer[0].length;
    return Number.parseFloat(treffer[0]);
  };

  const faktor = (): number => {
    if (quell[position] === '-') {
      position++;
      return -faktor();
    }
    if (quell[position] === '+') {
      position++;
      return faktor();
    }
    if (quell[position] === '(') {
      position++;
      const wert = summe();
      if (quell[position] !== ')') throw new Error('Eine Klammer wurde nicht geschlossen.');
      position++;
      return wert;
    }
    // Prozent: 20% von 50 -> 0.2 * ... (hier als reiner Bruchteil)
    const basis = zahl();
    if (quell[position] === '%') {
      position++;
      return basis / 100;
    }
    return basis;
  };

  const potenz = (): number => {
    const links = faktor();
    if (quell[position] === '^') {
      position++;
      const rechts = potenz();
      return Math.pow(links, rechts);
    }
    return links;
  };

  const produkt = (): number => {
    let wert = potenz();
    for (;;) {
      const zeichen = quell[position];
      if (zeichen === '*') {
        position++;
        wert *= potenz();
      } else if (zeichen === '/') {
        position++;
        const rechts = potenz();
        if (rechts === 0) throw new Error('Teilen durch Null ist nicht möglich.');
        wert /= rechts;
      } else {
        return wert;
      }
    }
  };

  const summe = (): number => {
    let wert = produkt();
    for (;;) {
      const zeichen = quell[position];
      if (zeichen === '+') {
        position++;
        wert += produkt();
      } else if (zeichen === '-') {
        position++;
        wert -= produkt();
      } else {
        return wert;
      }
    }
  };

  const ergebnis = summe();
  if (position !== quell.length) throw new Error(`Der Ausdruck ist unvollständig oder fehlerhaft ab Stelle ${position}.`);
  if (!Number.isFinite(ergebnis)) throw new Error('Das Ergebnis ist keine gültige Zahl.');
  return Math.round(ergebnis * 1e10) / 1e10;
}

/** Ähnliche Pfade vorschlagen, wenn eine Notiz nicht gefunden wurde. */
async function findSimilar(ctx: ToolContext, pfad: string): Promise<string[]> {
  const ziel = pfad.toLowerCase().replace(/\.md$/, '');
  const teile = ziel.split('/').filter(Boolean);
  const name = teile.at(-1) ?? ziel;
  try {
    const alle = await ctx.vault.listMarkdown();
    return alle
      .filter((kandidat) => {
        const klein = kandidat.toLowerCase();
        return klein.includes(name) || name.split(/[\s_-]+/).some((wort) => wort.length > 3 && klein.includes(wort));
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}

/** Textfassung einer Werkzeugliste für Einstellungen und Diagnose. */
export function toolSummary(tools: ActiveTools): string[] {
  return tools.specs.map((spec) => {
    const params = spec.params.map((param) => `${param.name}${param.required ? '' : '?'}`).join(', ');
    return `${spec.name}(${params}) — ${spec.summary}`;
  });
}

/** Ein Werkzeug aufrufen, mit klaren Fehlermeldungen. */
export async function runTool(
  tools: ActiveTools,
  call: ToolCall,
  ctx: ToolContext,
): Promise<{ call: ToolCall; ok: boolean; text: string; summary?: string }> {
  const spec = tools.specs.find((eintrag) => eintrag.name === call.tool);
  if (!spec) {
    const aehnlich = tools.specs
      .map((eintrag) => eintrag.name)
      .filter((name) => name.includes(call.tool) || call.tool.includes(name))
      .slice(0, 3);
    return {
      call,
      ok: false,
      text: `Das Werkzeug "${call.tool}" gibt es nicht.${aehnlich.length ? ` Gemeint war vielleicht: ${aehnlich.join(', ')}.` : ''}`,
    };
  }
  try {
    const ergebnis = await spec.handler(call.args, ctx);
    return { call, ...ergebnis };
  } catch (fehler) {
    return { call, ok: false, text: `Das Werkzeug "${call.tool}" ist fehlgeschlagen: ${(fehler as Error).message}` };
  }
}

/** Beschreibung der MCP-Werkzeuge für die Diagnose. */
export function describeMcpServer(schema: Record<string, unknown>): string {
  return describeSchema(schema);
}

/** Text (HTML) → Text, für Werkzeuge und Tests verfügbar. */
export { htmlToText };
