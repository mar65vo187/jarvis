/**
 * Die Werkzeug-Schleife (Agent): Frage → Werkzeug benutzen → Ergebnis lesen →
 * weiterarbeiten → fertige Antwort.
 *
 * Das Ergebnis wird nicht einfach geglaubt: Bei „gründlich"/„maximal" prüft
 * Jarvis seine eigene Antwort noch einmal gegen die Werkzeug-Ergebnisse und
 * korrigiert sich. Fehler eines Werkzeugs werden offen benannt, statt sie zu
 * erfinden.
 */
import type { BrainAnswer } from '../brain';
import type { ChatMessage, ChatUsage, RouteMode } from '../types';
import { buildToolPrompt, parseToolCalls, renderToolResults } from './protocol';
import { runTool, type ActiveTools } from './registry';
import type { ToolCall, ToolContext } from './types';
import type { AnswerMode } from '../rag/prompt';

export type EffortLevel = 'normal' | 'max';

export interface ToolStep {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary?: string;
  /** Kurztext für die Anzeige. */
  label: string;
}

/** Das Gehirn, wie die Schleife es benutzt (so bleibt sie leicht testbar). */
export interface AgentBrain {
  run(options: {
    mode: RouteMode;
    system: string;
    messages: ChatMessage[];
    preferredModel?: string;
    onDelta?: (chunk: string) => void;
    onRoundReset?: () => void;
    signal?: AbortSignal;
    heavyTask?: boolean;
  }): Promise<BrainAnswer>;
}

export interface AgentRunOptions {
  brain: AgentBrain;
  question: string;
  mode: AnswerMode;
  route: RouteMode;
  history: ChatMessage[];
  system: string;
  userMessage: string;
  preferredModel?: string;
  /** Werkzeuge (leer oder nicht gesetzt = keine Werkzeugschleife). */
  tools?: ActiveTools;
  toolContext: ToolContext;
  effort: EffortLevel;
  maxSteps: number;
  onDelta?: (chunk: string) => void;
  /** Wird gerufen, wenn schon sichtbarer Text durch eine Werkzeugrunde ungültig wird. */
  onRoundReset?: () => void;
  onTool?: (step: ToolStep) => void;
  signal?: AbortSignal;
  heavyTask?: boolean;
}

export interface AgentRunResult {
  answer: BrainAnswer;
  steps: ToolStep[];
  notices: string[];
  usedTools: boolean;
}

const MAX_RESULT_CHARS = 9000;

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const notices: string[] = [];
  const steps: ToolStep[] = [];
  const tools = options.tools && options.tools.specs.length > 0 ? options.tools : undefined;
  const maxRounds = Math.max(0, options.maxSteps);

  // Ohne Werkzeuge: genau eine Antwort (unverändertes Verhalten).
  if (!tools) {
    const answer = await options.brain.run({
      mode: options.route,
      system: options.system,
      messages: [...options.history, { role: 'user', content: options.userMessage }],
      preferredModel: options.preferredModel,
      onDelta: options.onDelta,
      signal: options.signal,
      heavyTask: options.heavyTask,
    });
    return { answer, steps, notices, usedTools: false };
  }

  const system = `${options.system}\n\n${buildToolPrompt(tools.specs)}`;
  // Der Verlauf wächst: Werkzeugaufrufe und -Ergebnisse bleiben erhalten.
  const verlauf: ChatMessage[] = [];
  let letzteAntwort: BrainAnswer | null = null;
  let toolRunden = 0;

  for (let runde = 0; runde <= maxRounds; runde++) {
    const userInhalt = runde === 0 ? options.userMessage : weiterText(runde, steps, options.question);
    const messages: ChatMessage[] = [
      ...options.history,
      { role: 'user', content: userInhalt },
      ...verlauf,
    ];

    // Zwischenrunden werden gepuffert: erst wenn feststeht, dass keine
    // Werkzeugabfrage kommt, geht der Text live in die Oberfläche.
    let gepuffert = '';
    let gestreamt = false;
    const onDelta = (chunk: string) => {
      if (!options.onDelta) return;
      gepuffert += chunk;
      if (looksLikeToolAnswer(gepuffert)) {
        if (gestreamt) {
          gestreamt = false;
          options.onRoundReset?.();
        }
        return;
      }
      gestreamt = true;
      options.onDelta(chunk);
    };

    const antwort = await options.brain.run({
      mode: options.route,
      system,
      messages,
      preferredModel: options.preferredModel,
      onDelta,
      signal: options.signal,
      heavyTask: options.heavyTask || options.effort === 'max',
    });
    letzteAntwort = antwort;

    const geparst = parseToolCalls(antwort.text, tools.names);
    if (!geparst.calls.length) {
      // Kaputte oder erfundene Werkzeuganfragen: dem Modell sagen, damit es sich korrigiert.
      if (geparst.broken.length && runde < maxRounds && !options.signal?.aborted) {
        notices.push(`Ungültige Werkzeuganfrage korrigiert: ${geparst.broken.join('; ')}`);
        verlauf.push({ role: 'assistant', content: antwort.text });
        verlauf.push({
          role: 'user',
          content: [
            'HINWEIS ZU DEINER WERKZEUGANFRAGE',
            `Diese Anfrage konnte nicht ausgeführt werden: ${geparst.broken.join('; ')}.`,
            `Erlaubte Werkzeuge sind genau: ${[...tools.names].join(', ')}.`,
            'Antworte jetzt entweder mit einem korrekten Werkzeugblock oder mit der fertigen Antwort ohne Werkzeugblock.',
          ].join('\n'),
        });
        continue;
      }
      if (geparst.broken.length) notices.push(`Ungültige Werkzeuganfrage ignoriert: ${geparst.broken.join('; ')}`);
      if (options.effort === 'max' && toolRunden > 0 && !options.signal?.aborted) {
        const geprueft = await selbstpruefung(options, antwort, messages, steps, system, tools);
        if (geprueft) return { answer: geprueft, steps, notices, usedTools: true };
      }
      return { answer: antwort, steps, notices, usedTools: toolRunden > 0 };
    }

    verlauf.push({ role: 'assistant', content: antwort.text });
    const ergebnisse: Array<{ call: ToolCall; ok: boolean; text: string; summary?: string }> = [];
    for (const call of geparst.calls) {
      if (options.signal?.aborted) break;
      const ergebnis = await runTool(tools, call, options.toolContext);
      const gekuerzt =
        ergebnis.text.length > MAX_RESULT_CHARS ? `${ergebnis.text.slice(0, MAX_RESULT_CHARS)}\n[… gekürzt]` : ergebnis.text;
      ergebnisse.push({ ...ergebnis, text: gekuerzt });
      const step: ToolStep = {
        round: runde + 1,
        tool: call.tool,
        args: call.args,
        ok: ergebnis.ok,
        summary: ergebnis.summary,
        label: `${call.tool}: ${describeArgs(tools, call)}`,
      };
      steps.push(step);
      options.onTool?.(step);
    }
    toolRunden++;
    if (geparst.broken.length) notices.push(`Unbekannte Werkzeugnamen: ${geparst.broken.join('; ')}`);
    verlauf.push({ role: 'user', content: renderToolResults(ergebnisse, geparst.broken) });
    if (options.signal?.aborted) break;
  }

  notices.push(
    `Nach ${maxRounds} Werkzeugrunden gestoppt, damit nichts endlos läuft. Erhöhe „maximale Schritte" in den Einstellungen oder stelle die Frage enger.`,
  );
  const antwort =
    letzteAntwort ??
    (await options.brain.run({
      mode: options.route,
      system: options.system,
      messages: [...options.history, { role: 'user', content: options.userMessage }],
      signal: options.signal,
    }));
  return { answer: antwort, steps, notices, usedTools: true };
}

/** Antwort nach der Werkzeugrunde noch einmal prüfen (Genauigkeit erhöhen). */
async function selbstpruefung(
  options: AgentRunOptions,
  antwort: BrainAnswer,
  messages: ChatMessage[],
  steps: ToolStep[],
  system: string,
  tools: ActiveTools,
): Promise<BrainAnswer | null> {
  const ergebnisse = steps
    .filter((step) => step.ok)
    .map((step) => `- ${step.label}${step.summary ? ` (${step.summary})` : ''}`)
    .join('\n');
  const pruefText = [
    'PRÜFAUFGABE',
    'Prüfe den folgenden Antwortentwurf streng: erfundene Angaben, Widersprüche zu den Werkzeug-Ergebnissen,',
    'vergessene Quellen, unklare Stellen. Nutze bei Bedarf weitere Werkzeuge.',
    'Antworte am Ende mit der korrigierten, vollständigen Endfassung für den Nutzer — ohne die Prüfung zu beschreiben.',
    '',
    `Benutzte Werkzeuge:\n${ergebnisse || '(keine)'}`,
    '',
    'ENTWURF:',
    antwort.text,
  ].join('\n');
  try {
    const lauf = await options.brain.run({
      mode: options.route,
      system,
      messages: [...messages, { role: 'user', content: pruefText }],
      preferredModel: options.preferredModel,
      signal: options.signal,
      heavyTask: true,
    });
    const geparst = parseToolCalls(lauf.text, tools.names);
    // Enthält die Prüfung selbst nur Werkzeugwünsche, bleibt der Entwurf gültig.
    if (geparst.calls.length || lauf.text.trim().length < 40) return null;
    return lauf;
  } catch {
    return null;
  }
}

function weiterText(runde: number, steps: ToolStep[], frage: string): string {
  return [
    `Weiter mit der Aufgabe (Runde ${runde + 1}).`,
    `Ursprüngliche Aufgabe: ${frage}`,
    `Bisher benutzte Werkzeuge: ${steps.map((step) => step.tool).join(', ') || '(keine)'}`,
    'Wenn du jetzt alle nötigen Angaben hast, liefere die fertige Antwort ohne Werkzeugblock.',
  ].join('\n');
}

function describeArgs(tools: ActiveTools, call: ToolCall): string {
  const spec = tools.specs.find((eintrag) => eintrag.name === call.tool);
  const erster = spec?.params[0]?.name;
  if (erster && call.args[erster] !== undefined) {
    const wert = String(call.args[erster]);
    return wert.length > 60 ? `${wert.slice(0, 60)}…` : wert;
  }
  const text = JSON.stringify(call.args);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Beginnt die Antwort wie ein Werkzeugaufruf? Dann nicht streamen. */
export function looksLikeToolAnswer(text: string): boolean {
  const anfang = text.trimStart();
  if (!anfang) return false;
  if (anfang.startsWith('```')) return true;
  if (anfang.startsWith('{') || anfang.startsWith('[')) return true;
  return /^\s*jarvis-tool/i.test(anfang);
}

/** Nutzung zweier Antworten zusammenzählen. */
export function sumUsage(a: ChatUsage | undefined, b: ChatUsage | undefined): ChatUsage | undefined {
  if (!a && !b) return undefined;
  const inputTokens = (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0);
  const outputTokens = (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0);
  return { inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined };
}
