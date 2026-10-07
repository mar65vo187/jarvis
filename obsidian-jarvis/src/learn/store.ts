/**
 * Der Lernspeicher.
 *
 * Bewahrt auf, was Jarvis gelernt hat (Lektionen), wie gut welche Modelle waren
 * (Statistik) und wie sich die Qualität über die Zeit entwickelt hat.
 * Alles landet in einer JSON-Datei im Plugin-Zwischenspeicher und wird bei Bedarf
 * zusätzlich als Markdown im Vault abgelegt, damit die GitHub-Sicherung es mitnimmt.
 */
import type { Lesson, LearningSettings, LearningSnapshot, ModelStat, QualitySample } from './types';
import { tokenize } from '../rag/vault-index';

export interface JsonPersist {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

interface PersistedLearning {
  version: number;
  lessons: Lesson[];
  stats: Record<string, ModelStat>;
  history: QualitySample[];
  pendingDistill: number;
  updatedAt: number;
}

const STORE_VERSION = 1;
const MAX_HISTORY = 300;

export interface AddLessonInput {
  question: string;
  answer: string;
  provider: string;
  model: string;
  reason: Lesson['reason'];
  sources: Array<{ path: string; heading?: string }>;
  rating?: Lesson['rating'];
  correction?: string;
}

export class LearningStore {
  private lessons: Lesson[] = [];
  private stats = new Map<string, ModelStat>();
  private history: QualitySample[] = [];
  private pendingDistill = 0;
  private updatedAt = 0;
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private persist: JsonPersist,
    private settings: () => LearningSettings,
    /** Verzögerung beim Speichern in Millisekunden (0 = sofort; Tests nutzen 0). */
    private saveDelayMs = 250,
  ) {}

  /** Daten laden (einmalig; fehlerhafte Dateien werden verworfen statt zu blockieren). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.persist.read();
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedLearning>;
      if (parsed.version !== STORE_VERSION) return;
      this.lessons = (parsed.lessons ?? []).filter(isValidLesson).map(normalizeLesson);
      for (const [model, stat] of Object.entries(parsed.stats ?? {})) {
        if (stat && typeof stat.calls === 'number') this.stats.set(model, stat);
      }
      this.history = (parsed.history ?? []).filter((sample) => sample && typeof sample.local === 'number');
      this.pendingDistill = typeof parsed.pendingDistill === 'number' ? parsed.pendingDistill : 0;
      this.updatedAt = parsed.updatedAt ?? 0;
    } catch {
      this.lessons = [];
      this.stats.clear();
      this.history = [];
    }
  }

  private async persistNow(): Promise<void> {
    const payload: PersistedLearning = {
      version: STORE_VERSION,
      lessons: this.lessons,
      stats: Object.fromEntries(this.stats),
      history: this.history.slice(-MAX_HISTORY),
      pendingDistill: this.pendingDistill,
      updatedAt: Date.now(),
    };
    this.updatedAt = payload.updatedAt;
    try {
      await this.persist.write(JSON.stringify(payload));
    } catch {
      // Speichern ist wichtig, aber ein Fehler darf die Arbeit nicht stoppen
    }
  }

  /** Speichern (leicht verzögert, damit viele Änderungen nicht viele Schreibvorgänge kosten). */
  private async save(delayMs = 250): Promise<void> {
    const delay = this.saveDelayMs > 0 ? Math.min(delayMs, this.saveDelayMs) : 0;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (delay <= 0) {
      await this.persistNow();
      return;
    }
    await new Promise<void>((resolve) => {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        void this.persistNow().then(resolve);
      }, delay);
    });
  }

  /** Sofort speichern — für Momente, in denen nichts verloren gehen darf. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persistNow();
  }

  // ------------------------------------------------------------- Lektionen

  list(): Lesson[] {
    return [...this.lessons];
  }

  count(): number {
    return this.lessons.length;
  }

  get(id: string): Lesson | undefined {
    return this.lessons.find((lesson) => lesson.id === id);
  }

  /** Neue Lektion aufnehmen (Dubletten werden zusammengeführt). */
  async add(input: AddLessonInput): Promise<Lesson> {
    const settings = this.settings();
    const question = input.question.trim();
    const answer = input.answer.trim();
    const correction = input.correction?.trim();
    const dedupeKey = makeDedupeKey(question, answer);
    const existing = this.lessons.find((lesson) => makeDedupeKey(lesson.question, lesson.answer) === dedupeKey);
    if (existing) {
      existing.rating = input.rating ?? existing.rating;
      if (correction) existing.correction = correction;
      await this.save();
      return existing;
    }

    const lesson: Lesson = {
      id: `w${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      createdAt: Date.now(),
      question,
      answer,
      provider: input.provider,
      model: input.model,
      reason: input.reason,
      sources: dedupeSources(input.sources),
      terms: dedupeTerms([...tokenize(question), ...tokenize(answer.slice(0, 1500))]),
      rating: input.rating ?? 'auto',
      correction,
      usedCount: 0,
      lastUsedAt: 0,
    };
    this.lessons.push(lesson);
    if (lesson.reason !== 'correction') this.pendingDistill++;
    await this.trim(settings.maxLessons);
    await this.save();
    return lesson;
  }

  /**
   * Eine Lektion mit ihrer ursprünglichen Kennung und Zeit übernehmen — für den
   * Weg zurück aus den Markdown-Notizen (nach Neuinstallation oder Rechnerwechsel).
   * Gibt `true` zurück, wenn sie wirklich neu aufgenommen wurde.
   */
  async adopt(lesson: Lesson): Promise<boolean> {
    if (this.get(lesson.id)) return false;
    const key = makeDedupeKey(lesson.question, lesson.answer);
    if (this.lessons.some((vorhanden) => makeDedupeKey(vorhanden.question, vorhanden.answer) === key)) return false;
    if (!lesson.question.trim() || !lesson.answer.trim()) return false;
    this.lessons.push({
      ...lesson,
      terms: lesson.terms?.length ? dedupeTerms(lesson.terms) : dedupeTerms([...tokenize(lesson.question), ...tokenize(lesson.answer.slice(0, 1500))]),
      sources: dedupeSources(lesson.sources ?? []),
      rating: lesson.rating ?? 'auto',
      usedCount: lesson.usedCount ?? 0,
      lastUsedAt: lesson.lastUsedAt ?? 0,
    });
    this.lessons.sort((a, b) => a.createdAt - b.createdAt);
    await this.trim(this.settings().maxLessons);
    await this.save();
    return true;
  }

  async rate(id: string, rating: Lesson['rating']): Promise<void> {
    const lesson = this.get(id);
    if (!lesson) return;
    lesson.rating = rating;
    await this.save();
  }

  async setCorrection(id: string, correction: string): Promise<void> {
    const lesson = this.get(id);
    if (!lesson) return;
    lesson.correction = correction.trim();
    lesson.rating = 'good';
    lesson.reason = 'correction';
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const before = this.lessons.length;
    this.lessons = this.lessons.filter((lesson) => lesson.id !== id);
    if (this.lessons.length !== before) await this.save();
  }

  /** Schlechteste zuerst entfernen, wenn die Obergrenze erreicht ist. */
  private async trim(maxLessons: number): Promise<void> {
    const limit = Math.max(20, maxLessons);
    if (this.lessons.length <= limit) return;
    const kept = [...this.lessons].sort((a, b) => scoreKeep(b) - scoreKeep(a)).slice(0, limit);
    this.lessons = kept.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Passende Lektionen zu einer Frage finden.
   * Bewertet nach Stichwortübereinstimmung und Nutzwert (gute Bewertung, Korrektur, Alter).
   */
  search(query: string, limit = 3): Lesson[] {
    const queryTerms = new Set(tokenize(query));
    if (!queryTerms.size || !this.lessons.length) return [];
    const scored = this.lessons.map((lesson) => {
      const lessonTerms = new Set(lesson.terms);
      let overlap = 0;
      for (const term of queryTerms) {
        if (lessonTerms.has(term)) {
          overlap += 1;
          continue;
        }
        if (term.length >= 5) {
          for (const candidate of lessonTerms) {
            if (candidate.length >= 5 && (candidate.startsWith(term) || term.startsWith(candidate))) {
              overlap += 0.5;
              break;
            }
          }
        }
      }
      // Ohne echte inhaltliche Übereinstimmung darf eine Lektion nie verwendet werden.
      if (overlap <= 0) return { lesson, score: 0 };
      const base = overlap / Math.sqrt(queryTerms.size);
      const value = lessonValue(lesson);
      const recency = Math.max(0, 1 - (Date.now() - lesson.createdAt) / (1000 * 60 * 60 * 24 * 365));
      return { lesson, score: base * (0.6 + value) + recency * 0.15 * Math.min(1, overlap) };
    });
    return scored
      .filter((item) => item.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((item) => item.lesson);
  }

  async markUsed(ids: string[]): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      const lesson = this.get(id);
      if (!lesson) continue;
      lesson.usedCount++;
      lesson.lastUsedAt = now;
    }
    await this.save(1500);
  }

  /** Lektionen in Textform für den Prompt (mit Quellenangabe). */
  renderForPrompt(lessons: Lesson[], maxChars: number): string {
    const blocks: string[] = [];
    let used = 0;
    for (const [index, lesson] of lessons.entries()) {
      const correction = lesson.correction ? `\nVom Nutzer korrigiert: ${lesson.correction}` : '';
      const origin = lesson.sources.length
        ? `\nHerkunft: ${lesson.sources.map((source) => source.path).join(', ')}`
        : '';
      const block = `[W${index + 1}] Frage: ${truncateText(lesson.question, 400)}\nAntwort: ${truncateText(lesson.answer, 2200)}${correction}${origin}`;
      if (used + block.length > maxChars) break;
      used += block.length;
      blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  // ------------------------------------------------------------- Statistik

  async recordCall(model: string, options: { ms: number; ok: boolean; quality?: number }): Promise<void> {
    const stat = this.stats.get(model) ?? { calls: 0, failures: 0, totalMs: 0, qualitySum: 0, qualityCount: 0, lastAt: 0 };
    stat.calls++;
    stat.totalMs += options.ms;
    stat.lastAt = Date.now();
    if (!options.ok) stat.failures++;
    if (typeof options.quality === 'number') {
      stat.qualitySum += options.quality;
      stat.qualityCount++;
    }
    this.stats.set(model, stat);
    await this.save(1500);
  }

  async recordQuality(sample: Omit<QualitySample, 'at'>): Promise<void> {
    this.history.push({ ...sample, at: Date.now() });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    await this.save(1500);
  }

  async recordDistill(): Promise<void> {
    this.pendingDistill = 0;
    this.history.push({ at: Date.now(), local: this.snapshot().avgLocalQuality, kind: 'distill' });
    await this.flush();
  }

  /** Wie viele Lektionen sind seit der letzten Destillation dazugekommen? */
  pendingForDistill(): number {
    return this.pendingDistill;
  }

  snapshot(): LearningSnapshot {
    const samples = this.history.filter((sample) => sample.kind !== 'distill');
    const localSamples = samples.map((sample) => sample.local);
    const cloudSamples = samples.filter((sample) => typeof sample.cloud === 'number').map((sample) => sample.cloud as number);
    const avg = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

    // Verbesserung: Durchschnitt nach dem letzten Destillieren gegen den davor.
    const distillIndex = this.history.map((sample) => sample.kind).lastIndexOf('distill');
    const before = distillIndex > 0 ? this.history.slice(0, distillIndex).filter((s) => s.kind !== 'distill').map((s) => s.local) : [];
    const after = distillIndex >= 0 ? this.history.slice(distillIndex + 1).filter((s) => s.kind !== 'distill').map((s) => s.local) : [];
    const improvement = before.length >= 2 && after.length >= 2 ? avg(after) - avg(before) : 0;

    return {
      lessons: this.lessons.length,
      corrections: this.lessons.filter((lesson) => lesson.correction).length,
      good: this.lessons.filter((lesson) => lesson.rating === 'good').length,
      bad: this.lessons.filter((lesson) => lesson.rating === 'bad').length,
      avgLocalQuality: round2(avg(localSamples)),
      avgCloudQuality: round2(avg(cloudSamples)),
      improvement: round2(improvement),
      distills: distillIndex >= 0 ? this.history.filter((sample) => sample.kind === 'distill').length : 0,
      updatedAt: this.updatedAt,
      modelStats: [...this.stats.entries()]
        .map(([model, stat]) => ({
          model,
          calls: stat.calls,
          failures: stat.failures,
          avgQuality: stat.qualityCount ? round2(stat.qualitySum / stat.qualityCount) : 0,
          avgMs: stat.calls ? Math.round(stat.totalMs / stat.calls) : 0,
        }))
        .sort((a, b) => b.calls - a.calls),
    };
  }

  /** Messwerte des Qualitätsverlaufs (für Berichte und Auswertungen). */
  qualityTrend(limit = 50): QualitySample[] {
    return this.history.slice(-limit).map((sample) => ({ ...sample }));
  }

  /** Verlauf als Text (für den Bericht in den Einstellungen). */
  historyText(limit = 20): string[] {
    const values = this.history.slice(-limit);
    if (!values.length) return ['Noch keine Messwerte.'];
    return values.map((sample) => {
      const time = new Date(sample.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      const kind = sample.kind === 'distill' ? '🧪 destilliert' : sample.kind === 'upgrade' ? '⬆️ aufgewertet' : '📝 Antwort';
      const cloud = typeof sample.cloud === 'number' ? ` · Cloud ${Math.round(sample.cloud * 100)} %` : '';
      return `${time}  ${kind}  lokal ${Math.round(sample.local * 100)} %${cloud}`;
    });
  }

  /** Alles Gelernte verwerfen. */
  async wipe(keepStats = true): Promise<void> {
    this.lessons = [];
    this.history = [];
    this.pendingDistill = 0;
    if (!keepStats) this.stats.clear();
    await this.flush();
  }
}

function isValidLesson(value: unknown): boolean {
  const lesson = value as Lesson;
  return Boolean(
    lesson &&
      typeof lesson.id === 'string' &&
      typeof lesson.question === 'string' &&
      typeof lesson.answer === 'string' &&
      lesson.answer.length > 0,
  );
}

function normalizeLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    sources: Array.isArray(lesson.sources) ? lesson.sources : [],
    terms: Array.isArray(lesson.terms) && lesson.terms.length ? lesson.terms : tokenize(`${lesson.question} ${lesson.answer.slice(0, 1500)}`),
    usedCount: lesson.usedCount ?? 0,
    lastUsedAt: lesson.lastUsedAt ?? 0,
    rating: lesson.rating ?? 'auto',
    reason: lesson.reason ?? 'manual',
    provider: lesson.provider ?? 'unbekannt',
    model: lesson.model ?? 'unbekannt',
  };
}

function makeDedupeKey(question: string, answer: string): string {
  return `${question.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}|${answer
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)}`;
}

function dedupeSources(sources: Array<{ path: string; heading?: string }>): Array<{ path: string; heading?: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; heading?: string }> = [];
  for (const source of sources) {
    if (!source?.path) continue;
    const key = `${source.path}|${source.heading ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: source.path, heading: source.heading });
    if (out.length >= 8) break;
  }
  return out;
}

function dedupeTerms(terms: string[]): string[] {
  return [...new Set(terms)].slice(0, 400);
}

/** Wie wertvoll ist eine Lektion (für Suche und Aufräumen)? */
function lessonValue(lesson: Lesson): number {
  let value = 0;
  if (lesson.rating === 'good') value += 1.2;
  if (lesson.rating === 'bad') value -= 1.5;
  if (lesson.correction) value += 1.6;
  value += Math.min(1, lesson.usedCount / 10) * 0.6;
  if (lesson.reason === 'escalation' || lesson.reason === 'upgrade') value += 0.4;
  return value;
}

function scoreKeep(lesson: Lesson): number {
  const used = Math.min(1, lesson.usedCount / 5);
  return lessonValue(lesson) * 2 + used + lesson.createdAt / 1e13;
}

function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
