/**
 * Destillation: aus dem Gelernten wird ein lokales Ollama-Modellprofil.
 *
 * Wichtig und ehrlich: hier werden KEINE Modellgewichte neu trainiert (das geht
 * auf einem normalen Rechner nicht). Was passiert:
 *   1. Die gesammelten Regeln und Korrekturen werden zur Systemanweisung.
 *   2. Die besten gelernten Frage/Antwort-Paare werden als Beispiele in das
 *      Modellprofil geschrieben (Ollama unterstützt MESSAGE-Paare).
 *   3. Ollama erzeugt daraus ein neues, dauerhaftes Profil (z. B. jarvis-brain-v3).
 * Das Basismodell bleibt dasselbe, aber es antwortet danach messbar näher an dem,
 * was gelernt wurde - ohne Cloud und ohne dass etwas neu heruntergeladen wird.
 */
import type { Lesson, LearningSettings } from './types';
import type { LocalSettings } from '../types';

export interface DistillPlan {
  /** Name des neuen Ollama-Profils, z. B. jarvis-brain-v3 */
  model: string;
  /** Basismodell, auf dem aufgebaut wird. */
  base: string;
  version: number;
  system: string;
  examples: Lesson[];
  rules: string[];
  modelfile: string;
  /** Lektionen, die nicht berücksichtigt wurden (mit Grund). */
  skipped: string[];
  bytes: number;
}

export interface OllamaModelPort {
  createModel(model: string, modelfile: string): Promise<void>;
  deleteModel(model: string): Promise<void>;
  listModels(): Promise<Array<{ id: string }>>;
}

const MAX_MODELFILE_BYTES = 28_000;
const MAX_EXAMPLE_CHARS = 1200;

/** Basis-Systemtext des destillierten Modells. */
const BASE_SYSTEM = [
  'Du bist Jarvis, der persönliche Assistent für einen Obsidian-Vault.',
  'Antworte auf Deutsch, sachlich und knapp, in sauberem Markdown. Keine Einleitungsfloskeln, wiederhole die Frage nicht.',
  'Wenn dir Notiz-Ausschnitte mitgegeben werden: nutze sie als einzige Faktenquelle und belege Aussagen mit [Q1], [Q2] …',
  'Wenn etwas nicht in den Quellen steht, sage das offen und deutlich. Erfinde keine Fakten, Zahlen, Termine, Quellen oder Aktionen.',
  'Unterscheide klar zwischen dem, was in den Notizen steht, und deinem eigenen Wissen.',
  'Du kannst den Vault nicht verändern und nichts versenden.',
].join('\n');

export function modelNameForVersion(version: number): string {
  return `jarvis-brain-v${Math.max(1, Math.round(version))}`;
}

export function escapeTripleQuote(text: string): string {
  return text.replace(/"""/g, "'''").trim();
}

/** Modelfile für Ollama bauen. */
export function buildModelfile(input: {
  base: string;
  system: string;
  examples: Array<{ question: string; answer: string }>;
  rules: string[];
  temperature?: number;
  numCtx?: number;
}): string {
  const lines: string[] = [];
  lines.push('# Automatisch von Jarvis AI erzeugt. Nicht von Hand bearbeiten.');
  lines.push(`# Erzeugt: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`FROM ${input.base}`);
  lines.push('');
  if (typeof input.temperature === 'number') lines.push(`PARAMETER temperature ${input.temperature}`);
  if (typeof input.numCtx === 'number' && input.numCtx > 0) lines.push(`PARAMETER num_ctx ${Math.round(input.numCtx)}`);
  lines.push('');

  const systemParts = [BASE_SYSTEM, input.system.trim()].filter(Boolean);
  if (input.rules.length) {
    systemParts.push(`Gelernte Regeln aus früheren Korrekturen:\n${input.rules.map((rule) => `- ${rule}`).join('\n')}`);
  }
  lines.push(`SYSTEM """${escapeTripleQuote(systemParts.join('\n\n'))}"""`);
  lines.push('');

  for (const example of input.examples) {
    const question = escapeTripleQuote(example.question);
    const answer = escapeTripleQuote(example.answer);
    if (!question || !answer) continue;
    lines.push(`MESSAGE user """${truncate(question, 700)}"""`);
    lines.push(`MESSAGE assistant """${truncate(answer, MAX_EXAMPLE_CHARS)}"""`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface DistillerDeps {
  ollama: OllamaModelPort;
  learning: () => LearningSettings;
  local: () => LocalSettings;
  lessons: () => Lesson[];
}

export class Distiller {
  constructor(private deps: DistillerDeps) {}

  /** Was würde ein Lauf tun? (ohne etwas zu verändern) */
  plan(): DistillPlan {
    const learning = this.deps.learning();
    const local = this.deps.local();
    const version = Math.max(1, (learning.distillVersion ?? 0) + 1);
    const model = modelNameForVersion(version);
    const base = (local.defaultModel || '').trim() || 'qwen3:8b';
    const skipped: string[] = [];

    // Geeignete Beispiele: gute Bewertungen und Korrekturen zuerst.
    const candidates = [...this.deps.lessons()]
      .filter((lesson) => lesson.rating !== 'bad')
      .map((lesson) => ({
        lesson,
        value:
          (lesson.correction ? 3 : 0) +
          (lesson.rating === 'good' ? 2 : 0.5) +
          Math.min(1, lesson.usedCount / 5) +
          (lesson.reason === 'upgrade' ? 1.2 : 0) +
          (lesson.reason === 'escalation' ? 0.8 : 0),
      }))
      .sort((a, b) => b.value - a.value);

    const examples: Lesson[] = [];
    for (const candidate of candidates) {
      if (examples.length >= Math.max(1, learning.distillMaxExamples)) {
        skipped.push(`${candidate.lesson.question.slice(0, 40)}… (Obergrenze erreicht)`);
        continue;
      }
      if (candidate.lesson.answer.trim().length < 40) {
        skipped.push(`${candidate.lesson.question.slice(0, 40)}… (Antwort zu kurz)`);
        continue;
      }
      examples.push(candidate.lesson);
    }

    const rules = (learning.systemHints ?? []).map((rule) => rule.trim()).filter(Boolean).slice(0, 12);
    const modelfile = buildModelfile({
      base,
      system: '',
      examples: examples.map((lesson) => ({
        question: lesson.question,
        answer: lesson.correction ? `${lesson.answer}\n\nKorrigierte Fassung (verbindlich): ${lesson.correction}` : lesson.answer,
      })),
      rules,
      temperature: local.temperature,
      numCtx: local.numCtx,
    });

    return {
      model,
      base,
      version,
      system: rules.length ? rules.join('\n') : '',
      examples,
      rules,
      modelfile,
      skipped,
      bytes: modelfile.length,
    };
  }

  /** Prüfen, ob ein Plan überhaupt etwas enthält. */
  validate(plan: DistillPlan): string | null {
    if (this.deps.lessons().length === 0) {
      return 'Es ist noch nichts gelernt. Stelle zuerst Fragen (am besten im Modus „Auto", damit die Cloud-Antworten gespeichert werden).';
    }
    if (!plan.examples.length) {
      return 'Es gibt noch keine geeigneten Beispiele (Antworten zu kurz oder als schlecht bewertet).';
    }
    if (plan.bytes > MAX_MODELFILE_BYTES) {
      return `Das Modellprofil wäre zu groß (${Math.round(plan.bytes / 1024)} KB). Bitte die Zahl der Beispiele verringern.`;
    }
    return null;
  }

  /** Destillation ausführen. Gibt den erzeugten Modellnamen zurück. */
  async run(plan: DistillPlan): Promise<{ model: string; message: string }> {
    const problem = this.validate(plan);
    if (problem) throw new Error(problem);
    await this.deps.ollama.createModel(plan.model, plan.modelfile);

    // Prüfen, ob Ollama das Profil wirklich führt.
    const models = await this.deps.ollama.listModels();
    if (!models.some((model) => model.id === plan.model || model.id.startsWith(`${plan.model}:`))) {
      throw new Error(
        `Ollama hat "${plan.model}" nicht angelegt. Bitte Ollama aktualisieren (ollama --version) und erneut versuchen.`,
      );
    }
    return {
      model: plan.model,
      message: `${plan.model} aus ${plan.examples.length} Beispiel(en) und ${plan.rules.length} Regel(n) erstellt (Basis: ${plan.base}).`,
    };
  }

  /** Alte Jarvis-Profile aufräumen (behält die angegebene Version). */
  async cleanup(keepVersion: number): Promise<string[]> {
    const models = await this.deps.ollama.listModels();
    const keep = modelNameForVersion(keepVersion);
    const removed: string[] = [];
    for (const model of models) {
      const name = model.id.split(':')[0];
      if (!/^jarvis-brain-v\d+$/.test(name)) continue;
      if (name === keep) continue;
      try {
        await this.deps.ollama.deleteModel(model.id);
        removed.push(model.id);
      } catch {
        // nicht löschbar -> behalten
      }
    }
    return removed;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
