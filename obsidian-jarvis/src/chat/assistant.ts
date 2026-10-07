/**
 * Der Ablauf „Frage -> Quellen + Gelerntes -> Modell -> Qualitätsprüfung -> Lernen".
 *
 * Das ist die Stelle, an der sich die lokale KI verbessert:
 *
 *  1. Jarvis sucht passende Notizen UND passendes gelerntes Wissen ([W1], [W2] …).
 *  2. Die lokale KI antwortet zuerst (Datenschutz, Geschwindigkeit, keine Kosten).
 *  3. Die Antwort wird gemessen: Wie viel von dem, was in den Quellen steht, kommt
 *     in der Antwort wirklich vor (Abdeckung)? Ausweich-Floskeln werden erkannt.
 *  4. Ist die lokale Antwort zu schwach und ist ein Cloud-Modell eingerichtet,
 *     übernimmt es (Aufwertung) - und aus dieser besseren Antwort wird gelernt.
 *  5. Gelerntes Wissen wird gespeichert, dauerhaft gehalten und bei späteren Fragen
 *     wieder mitgeschickt. Dadurch wird die lokale Antwort Schritt für Schritt besser
 *     und die Cloud seltener nötig.
 */
import type { ChatMessage, JarvisSettings, RouteMode } from '../types';
import type { Brain, BrainAnswer } from '../brain';
import type { Source, VaultIndex } from '../rag/vault-index';
import { buildMessages, buildSystemPrompt, buildUserMessage, type AnswerMode } from '../rag/prompt';
import type { Lesson, LearningSnapshot } from '../learn/types';
import type { LearningStore } from '../learn/store';
import type { MemoryNotes } from '../learn/notes';
import { compareWithCloud, keyTerms, type ComparisonResult } from '../learn/quality';

export interface AssistantDeps {
  settings: () => JarvisSettings;
  index: VaultIndex;
  brain: Brain;
  vaultName?: () => string;
  /** Lernsystem (optional, damit Tests ohne Lernen möglich bleiben). */
  learning?: {
    store: LearningStore;
    notes?: MemoryNotes;
  };
  /** Wird gerufen, wenn sich Einstellungen durch das Lernen geändert haben. */
  persistSettings?: () => Promise<void>;
}

export type PendingLesson = {
  question: string;
  answer: string;
  provider: string;
  model: string;
  reason: Lesson['reason'];
  sources: Array<{ path: string; heading?: string }>;
};

export interface AskOptions {
  question: string;
  mode: AnswerMode;
  route: RouteMode;
  history: ChatMessage[];
  activeNotePath?: string;
  includeActiveNote?: boolean;
  preferredModel?: string;
  onDelta?: (chunk: string) => void;
  /** Wird gerufen, wenn die lokale Antwort aufgewertet wird (Oberfläche leert dann den Text). */
  onUpgradeStart?: (reason: string) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Manuell „gründlich" erzwingen. */
  deep?: boolean;
}

export interface AskResult {
  answer: BrainAnswer;
  sources: Source[];
  system: string;
  userMessage: string;
  heavy: boolean;
  notice?: string;
  /** Benutztes gelerntes Wissen. */
  lessons: Array<{ id: string; question: string; model: string }>;
  /** Qualitätsmessung der Antwort. */
  quality?: ComparisonResult;
  /** Die lokale Antwort, die durch eine Cloud-Antwort ersetzt wurde. */
  replacedLocalAnswer?: string;
  /** Wenn „nachfragen" eingestellt ist: Vorschlag zum Merken. */
  pendingLesson?: PendingLesson;
  /** Wurde direkt gelernt? */
  learned?: { saved: boolean; id?: string; notePath?: string };
}

const VAULT_MODES: AnswerMode[] = ['vault', 'note', 'summarize', 'tasks', 'plan', 'deep', 'critique'];
const LEARNING_MODES: AnswerMode[] = ['vault', 'note', 'summarize', 'tasks', 'plan', 'deep', 'critique', 'rewrite', 'translate'];
const MIN_LESSON_QUESTION_CHARS = 12;

export class Assistant {
  constructor(private deps: AssistantDeps) {}

  private learningStore(): LearningStore | undefined {
    return this.deps.learning?.store;
  }

  /** Snapshot des Lernstands (für Einstellungen und Statuszeile). */
  learningSnapshot(): LearningSnapshot {
    const store = this.learningStore();
    return store ? store.snapshot() : { lessons: 0, corrections: 0, good: 0, bad: 0, avgLocalQuality: 0, avgCloudQuality: 0, improvement: 0, distills: 0, updatedAt: 0, modelStats: [] };
  }

  private memoryFolder(): string {
    return (this.deps.settings().learning.memoryFolder || 'Jarvis Gedächtnis').replace(/^\/+|\/+$/g, '');
  }

  private isMemoryPath(path: string): boolean {
    const folder = this.memoryFolder();
    return path === folder || path.startsWith(`${folder}/`);
  }

  /** Gelerntes Wissen zur Frage holen. */
  gatherLessons(question: string): Lesson[] {
    const settings = this.deps.settings();
    const store = this.learningStore();
    if (!store || !settings.learning.enabled || settings.learning.injectLessons <= 0) return [];
    return store.search(question, settings.learning.injectLessons);
  }

  /** Quellen sammeln (Vault-Suche + ggf. geöffnete Notiz). */
  async gatherSources(
    options: AskOptions,
    lessonTerms: string[] = [],
  ): Promise<{ sources: Source[]; notice?: string }> {
    const settings = this.deps.settings();
    if (!settings.rag.enabled || !VAULT_MODES.includes(options.mode)) {
      return { sources: [] };
    }
    // Sicherstellen, dass der Index geladen/aktuell ist, bevor wir suchen.
    await this.deps.index.ensureFresh(false);
    const notes: Source[] = [];
    const noticeParts: string[] = [];

    if (options.includeActiveNote && options.activeNotePath && !this.isMemoryPath(options.activeNotePath)) {
      const activeSources = this.deps.index.noteChunks(options.activeNotePath, Math.round(settings.rag.contextChars * 0.5));
      notes.push(...activeSources);
      if (!activeSources.length) {
        noticeParts.push(
          `Die geöffnete Notiz "${options.activeNotePath}" ist nicht im Index (ausgeschlossen, privat oder noch nicht eingelesen).`,
        );
      }
    }

    const searchBudget = Math.max(1500, settings.rag.contextChars - notes.reduce((sum, item) => sum + item.text.length, 0));
    const searchQuery = lessonTerms.length ? `${options.question} ${lessonTerms.slice(0, 12).join(' ')}` : options.question;
    const results = (await this.deps.index.search(searchQuery, {
      topK: settings.rag.topK,
      contextChars: searchBudget,
      signal: options.signal,
    })).filter((source) => !this.isMemoryPath(source.path));

    const existing = new Set(notes.map((source) => `${source.path}|${source.text.slice(0, 80)}`));
    for (const source of results) {
      const key = `${source.path}|${source.text.slice(0, 80)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      notes.push(source);
    }

    const sources = notes.map((source, index) => ({ ...source, id: `Q${index + 1}` }));
    if (!sources.length && (options.mode === 'vault' || options.mode === 'note' || options.mode === 'summarize')) {
      noticeParts.push(
        'Keine passenden Notizen gefunden. Tipp: Namen oder Stichworte aus der Notiz in die Frage schreiben oder den Index neu aufbauen.',
      );
    }
    const stats = this.deps.index.stats();
    if (settings.rag.enabled && stats.chunks === 0) {
      noticeParts.push('Der Wissensindex ist noch leer. Bitte einmal "Index aufbauen" ausführen.');
    }
    return { sources, notice: noticeParts.join(' ') || undefined };
  }

  async ask(options: AskOptions): Promise<AskResult> {
    const settings = this.deps.settings();
    const learning = settings.learning;
    const store = this.learningStore();
    const learningActive = Boolean(store && learning.enabled);

    // 1. Gelerntes Wissen holen (Stichworte helfen auch der Notizsuche)
    const lessons = learningActive ? this.gatherLessons(options.question) : [];
    const lessonTerms = lessons.flatMap((lesson) => lesson.terms);
    if (lessons.length) void store?.markUsed(lessons.map((lesson) => lesson.id));

    // 2. Quellen und Prompt
    const { sources, notice } = await this.gatherSources(options, lessonTerms);
    const effectiveMode: AnswerMode =
      options.deep || (settings.rag.deepMode && options.mode !== 'chat' && options.mode !== 'deep') ? 'deep' : options.mode;

    const lessonText = lessons.length && store ? store.renderForPrompt(lessons, learning.injectChars) : '';
    const system = buildSystemPrompt({
      mode: effectiveMode,
      question: options.question,
      sources,
      customInstructions: settings.customInstructions,
      language: settings.answerLanguage || 'Deutsch',
      vaultName: this.deps.vaultName?.(),
      activeNotePath: options.mode === 'note' ? options.activeNotePath : undefined,
      citationStyle: sources.length > 0,
      lessonCount: lessons.length,
    });
    const userMessage = buildUserMessage(
      options.question,
      sources,
      effectiveMode,
      lessonText ? { text: lessonText, count: lessons.length } : undefined,
    );

    const contextChars = sources.reduce((sum, source) => sum + source.text.length, 0);
    const heavy = this.deps.brain.looksHeavy(options.question, contextChars);
    const terms = sources.length ? keyTerms(sources) : [];

    // 3. Erste Antwort (lokal oder Cloud, je nach Modus)
    let answer = await this.deps.brain.run({
      mode: options.route,
      system,
      messages: buildMessages(system, options.history, userMessage, settings.ui.historyLimit),
      preferredModel: options.preferredModel,
      onDelta: options.onDelta,
      signal: options.signal,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      heavyTask: heavy,
      allowEscalation: options.route === 'auto' ? settings.autoEscalate : false,
    });

    // 4. Qualität messen
    let quality: ComparisonResult | undefined = sources.length
      ? compareWithCloud(answer.text, sources, undefined, learning.qualityThreshold, terms)
      : undefined;

    let replacedLocalAnswer: string | undefined;
    let noticeText = notice;
    const extraNotes: string[] = [];

    // 5. Aufwerten: lokale Antwort zu schwach -> Cloud übernimmt (nur im Auto-Modus)
    const localAnswer = answer.providerId === 'ollama';
    const cloudPossible = settings.autoEscalate || options.route === 'cloud';
    if (
      localAnswer &&
      quality?.local.weak &&
      !options.signal?.aborted &&
      options.route === 'auto' &&
      settings.autoEscalate &&
      cloudPossible &&
      terms.length >= 4
    ) {
      const reason = quality.local.hedged
        ? 'Die lokale Antwort war eine Ausweichantwort.'
        : `Die lokale Antwort ließ ${quality.local.missing.length} Kernbegriffe aus (Abdeckung ${Math.round(quality.local.coverage * 100)} %).`;
      options.onUpgradeStart?.(reason);
      try {
        const upgraded = await this.deps.brain.escalate({
          mode: 'cloud',
          system: `${system}\n\nHinweis: Eine erste, unvollständige Antwort ist bereits verworfen worden. Antworte vollständig und belege jede Aussage mit [Q1], [Q2] …`,
          messages: buildMessages(system, options.history, userMessage, settings.ui.historyLimit),
          onDelta: options.onDelta,
          signal: options.signal,
          maxTokens: options.maxTokens,
          heavyTask: true,
        });
        replacedLocalAnswer = answer.text;
        answer = { ...upgraded, attempts: [...answer.attempts, ...upgraded.attempts], escalated: true };
        quality = compareWithCloud(replacedLocalAnswer, sources, answer.text, learning.qualityThreshold, terms);
        extraNotes.push(`⬆️ Lokale Antwort war zu schwach → von ${answer.providerId}/${answer.model} aufgearbeitet.`);
      } catch (error) {
        extraNotes.push(`Aufwerten nicht möglich: ${(error as Error).message}`);
      }
    } else if (quality && sources.length) {
      quality = compareWithCloud(answer.text, sources, undefined, learning.qualityThreshold, terms);
    }

    // 6. Statistik und Qualitätsverlauf festhalten
    if (store && learningActive) {
      for (const attempt of answer.attempts) {
        await store.recordCall(`${attempt.providerId}/${attempt.model}`, {
          ms: attempt.error ? 0 : answer.durationMs,
          ok: !attempt.error,
        });
      }
      if (!answer.attempts.length) {
        await store.recordCall(`${answer.providerId}/${answer.model}`, { ms: answer.durationMs, ok: true });
      }
      if (quality) {
        await store.recordQuality({
          local: replacedLocalAnswer ? quality.local.coverage : Math.min(1, quality.local.coverage),
          cloud: replacedLocalAnswer ? quality.cloud?.coverage : undefined,
          kind: replacedLocalAnswer ? 'upgrade' : 'answer',
        });
      }
    }

    // 7. Aus der Cloud-Antwort lernen
    let learned: AskResult['learned'];
    let pendingLesson: PendingLesson | undefined;
    if (store && learningActive && this.canLearn(options, answer, learning.learnFrom) && !options.signal?.aborted) {
      const payload: PendingLesson = {
        question: options.question,
        answer: answer.text,
        provider: answer.providerId,
        model: answer.model,
        reason: replacedLocalAnswer ? 'upgrade' : answer.attempts.some((attempt) => attempt.error) ? 'escalation' : 'manual',
        sources: sources.map((source) => ({ path: source.path, heading: source.heading })),
      };
      if (learning.saveMode === 'auto') {
        learned = await this.saveLesson(payload);
        extraNotes.push(`🧠 Aus dieser Antwort gelernt (${store.count()} Lektionen insgesamt).`);
      } else if (learning.saveMode === 'ask') {
        pendingLesson = payload;
      }
    }

    if (lessons.length) {
      extraNotes.push(`📚 ${lessons.length} passende Lektion(en) aus dem gelernten Wissen wurden mitgeschickt.`);
    }

    const combinedNotice = [noticeText, ...extraNotes].filter(Boolean).join('\n');
    return {
      answer,
      sources,
      system,
      userMessage,
      heavy,
      notice: combinedNotice || undefined,
      lessons: lessons.map((lesson) => ({ id: lesson.id, question: lesson.question, model: lesson.model })),
      quality,
      replacedLocalAnswer,
      pendingLesson,
      learned,
    };
  }

  /** Darf aus dieser Antwort gelernt werden? */
  private canLearn(options: AskOptions, answer: BrainAnswer, learnFrom: 'escalations' | 'all'): boolean {
    if (answer.providerId === 'ollama') return false;
    if (options.question.trim().length < MIN_LESSON_QUESTION_CHARS) return false;
    if (answer.text.trim().length < 40) return false;
    if (!LEARNING_MODES.includes(options.mode)) return false;
    const cameFromEscalation = answer.escalated === true || answer.attempts.some((attempt) => attempt.error);
    if (learnFrom === 'escalations') return cameFromEscalation;
    return true;
  }

  /** Eine Lektion speichern (Speicher + Markdown-Notiz). */
  async saveLesson(payload: PendingLesson): Promise<{ saved: boolean; id?: string; notePath?: string }> {
    const store = this.learningStore();
    if (!store) return { saved: false };
    const settings = this.deps.settings();
    const lesson = await store.add({
      question: payload.question,
      answer: payload.answer,
      provider: payload.provider,
      model: payload.model,
      reason: payload.reason,
      sources: payload.sources,
    });
    let notePath: string | undefined;
    if (this.deps.learning?.notes && settings.learning.writeNotes) {
      try {
        notePath = await this.deps.learning.notes.save(lesson);
      } catch {
        notePath = undefined;
      }
    }
    // Markdown-Notizen des Gedächtnisses aus der Vault-Suche heraushalten.
    const folder = this.memoryFolder();
    if (folder && !settings.rag.excludeFolders.includes(folder)) {
      settings.rag.excludeFolders = [...settings.rag.excludeFolders, folder];
      await this.deps.persistSettings?.();
    }
    return { saved: true, id: lesson.id, notePath };
  }

  /** Nutzerbewertung einer gelernten Antwort. */
  async rateLesson(id: string, rating: Lesson['rating']): Promise<void> {
    await this.learningStore()?.rate(id, rating);
  }

  /** Nutzerkorrektur: wird verbindliche Fassung und Regel für das lokale Modell. */
  async correctLesson(id: string, correction: string): Promise<void> {
    const store = this.learningStore();
    if (!store) return;
    await store.setCorrection(id, correction);
    const lesson = store.get(id);
    if (!lesson) return;
    await this.deps.learning?.notes?.save(lesson);
    const settings = this.deps.settings();
    const hint = `Korrektur des Nutzers zu "${lesson.question.slice(0, 80)}": ${correction.trim().slice(0, 300)}`;
    if (!settings.learning.systemHints.includes(hint)) {
      settings.learning.systemHints = [...settings.learning.systemHints, hint].slice(-20);
    }
  }

  /** Auch für automatisch gemerkte Lektionen die Notiz nachziehen. */
  /**
   * Gelerntes aus den Markdown-Notizen im Vault zurückholen. Nötig, wenn der
   * Lernspeicher (cache/learning.json) fehlt — nach einer Neuinstallation, auf einem
   * anderen Rechner oder nach dem Löschen des Zwischenspeichers. Damit sind die Notizen
   * (und über die GitHub-Sicherung auch das Repository) die dauerhafte Quelle.
   */
  async restoreLessonsFromNotes(): Promise<number> {
    const settings = this.deps.settings();
    const store = this.learningStore();
    const notes = this.deps.learning?.notes;
    if (!store || !notes || !settings.learning.enabled || !settings.learning.writeNotes) return 0;
    try {
      const gefunden = await notes.importAll();
      let neu = 0;
      for (const lesson of gefunden) {
        if (await store.adopt(lesson)) neu++;
      }
      if (neu > 0) {
        await store.flush();
        await this.deps.persistSettings?.();
      }
      return neu;
    } catch {
      return 0;
    }
  }

  async syncMemoryNotes(): Promise<{ written: number; existing: number }> {
    const store = this.learningStore();
    const notes = this.deps.learning?.notes;
    if (!store || !notes) return { written: 0, existing: 0 };
    return notes.syncAll(store.list());
  }
}
