/**
 * Das Werkzeug-Protokoll — bewusst textbasiert und damit für ALLE Modelle
 * nutzbar (auch kleine lokale Modelle, die kein natives Werkzeug-Aufrufen
 * beherrschen).
 *
 * Das Modell antwortet mit einem Block:
 *
 *   ```jarvis-tool
 *   {"tool": "web_search", "args": {"query": "Wetter Frankfurt"}}
 *   ```
 *
 * Erlaubt sind mehrere Blöcke. Alles außerhalb der Blöcke wird als normaler
 * Text behandelt.
 */
import type { ToolCall, ToolSpec } from './types';

export const TOOL_FENCE = 'jarvis-tool';

/** Anweisung für das Modell, welche Werkzeuge es gibt und wie es sie benutzt. */
export function buildToolPrompt(tools: ToolSpec[]): string {
  if (!tools.length) return '';
  const liste = tools.map((tool) => {
    const params = tool.params
      .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.description}`)
      .join(', ');
    return `- ${tool.name}(${params}) — ${tool.summary}`;
  });
  return [
    'WERKZEUGE',
    'Du kannst Werkzeuge benutzen, um an echte Informationen zu kommen oder etwas zu erledigen.',
    ...liste,
    '',
    'So rufst du ein Werkzeug auf: Antworte in dieser Runde AUSSCHLIESSLICH mit einem Block dieser Form',
    'und schreibe keinen weiteren Text daneben:',
    '```' + TOOL_FENCE,
    '{"tool": "werkzeug_name", "args": {"argument": "wert"}}',
    '```',
    'Du darfst mehrere Blöcke hintereinander senden. Du bekommst dann die Ergebnisse als',
    '"WERKZEUG-ERGEBNIS" zurück und arbeitest damit weiter.',
    'Wenn du keine Werkzeuge brauchst, antworte ganz normal ohne Block.',
    'Erfinde niemals ein Ergebnis eines Werkzeugs. Wenn ein Werkzeug fehlschlägt, sage es offen.',
    'Nach höchstens einer kurzen Werkzeugkette lieferst du die fertige Antwort.',
  ].join('\n');
}

export interface ParsedToolCalls {
  /** Gefundene Aufrufe in Reihenfolge. */
  calls: ToolCall[];
  /** Der Text ohne die Werkzeugblöcke (kann leer sein). */
  text: string;
  /** Blöcke, deren Inhalt kein gültiger Aufruf war (werden dem Modell gemeldet). */
  broken: string[];
}

const FENCE_RE = new RegExp('```(?:' + TOOL_FENCE + '|json|tool_call|tools?)?\\s*\\n([\\s\\S]*?)```', 'gi');

function parseOne(inhalt: string): { call?: ToolCall; broken?: string } {
  const text = inhalt.trim();
  if (!text) return { broken: 'leerer Werkzeugblock' };
  let daten: unknown;
  try {
    daten = JSON.parse(text);
  } catch {
    // Zweiter Versuch: manche Modelle schreiben den Aufruf in eine Zeile mit Text davor
    const treffer = /\{[\s\S]*\}/.exec(text);
    if (!treffer) return { broken: text.slice(0, 200) };
    try {
      daten = JSON.parse(treffer[0]);
    } catch {
      return { broken: text.slice(0, 200) };
    }
  }
  if (typeof daten !== 'object' || daten === null) return { broken: text.slice(0, 200) };
  const obj = daten as Record<string, unknown>;
  const name =
    (typeof obj.tool === 'string' && obj.tool) ||
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.function === 'string' && obj.function) ||
    (typeof obj.function === 'object' && obj.function !== null && typeof (obj.function as Record<string, unknown>).name === 'string'
      ? ((obj.function as Record<string, unknown>).name as string)
      : '');
  if (!name) return { broken: text.slice(0, 200) };
  let argumente: Record<string, unknown> = {};
  const rohe = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
  if (typeof rohe === 'string') {
    try {
      const geparst = JSON.parse(rohe);
      if (geparst && typeof geparst === 'object') argumente = geparst as Record<string, unknown>;
    } catch {
      argumente = {};
    }
  } else if (rohe && typeof rohe === 'object') {
    argumente = rohe as Record<string, unknown>;
  } else {
    // Argumente direkt neben "tool" ins Objekt schreiben
    for (const [schluessel, wert] of Object.entries(obj)) {
      if (['tool', 'name', 'function', 'args', 'arguments', 'parameters', 'input'].includes(schluessel)) continue;
      argumente[schluessel] = wert;
    }
  }
  return { call: { tool: name.trim(), args: argumente, raw: text.slice(0, 400) } };
}

/**
 * Werkzeugblöcke aus einer Modellantwort herausziehen.
 * `nurBekannte` verhindert, dass erfundene Werkzeugnamen ausgeführt werden.
 */
export function parseToolCalls(text: string, bekannte?: Set<string>): ParsedToolCalls {
  const calls: ToolCall[] = [];
  const broken: string[] = [];
  let rest = text;
  for (const treffer of text.matchAll(FENCE_RE)) {
    const { call, broken: kaputt } = parseOne(treffer[1]);
    if (call && (!bekannte || bekannte.has(call.tool))) {
      calls.push(call);
      rest = rest.replace(treffer[0], '');
    } else if (call) {
      broken.push(`${call.tool} (unbekanntes Werkzeug)`);
      rest = rest.replace(treffer[0], '');
    } else if (kaputt) {
      broken.push(kaputt);
      rest = rest.replace(treffer[0], '');
    }
  }
  // Nackte JSON-Zeile ohne Zaun (manche kleinen Modelle lassen die Striche weg)
  if (!calls.length) {
    const nackt = /^\s*\{\s*"(?:tool|name|function)"\s*:[\s\S]*\}\s*$/.exec(text);
    if (nackt) {
      const { call } = parseOne(nackt[0]);
      if (call && (!bekannte || bekannte.has(call.tool))) {
        calls.push(call);
        rest = '';
      } else if (call) {
        broken.push(`${call.tool} (unbekanntes Werkzeug)`);
      }
    }
  }
  return { calls, text: rest.replace(/\n{3,}/g, '\n\n').trim(), broken };
}

/** Ergebnis eines Werkzeugs als Nachricht für das Modell. */
export function renderToolResults(
  ergebnisse: Array<{ call: ToolCall; ok: boolean; text: string; summary?: string }>,
  broken: string[] = [],
): string {
  const bloecke = ergebnisse.map((eintrag) => {
    const kopf = `${eintrag.call.tool}(${JSON.stringify(eintrag.call.args).slice(0, 200)}) → ${eintrag.ok ? 'OK' : 'FEHLER'}`;
    return `${kopf}\n${eintrag.text}`;
  });
  const kaputt = broken.length ? `\n\nNicht ausgeführt: ${broken.join('; ')}` : '';
  return [
    'WERKZEUG-ERGEBNIS',
    'Diese Angaben kommen von echten Werkzeugen. Nutze sie als Faktenquelle und erfinde nichts dazu.',
    '',
    bloecke.join('\n\n---\n\n'),
    kaputt,
  ].join('\n');
}
