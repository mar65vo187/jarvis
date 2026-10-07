/**
 * Die Ablauflogik "Frage -> Quellen -> Prompt -> Modell -> Antwort".
 * Bewusst ohne Obsidian-Abhängigkeit, damit sie testbar bleibt.
 */
import type { ChatMessage, JarvisSettings, RouteMode } from '../types';
import type { Brain, BrainAnswer } from '../brain';
import type { Source, VaultIndex } from '../rag/vault-index';
import { buildMessages, buildSystemPrompt, buildUserMessage, type AnswerMode } from '../rag/prompt';

export interface AssistantDeps {
  settings: () => JarvisSettings;
  index: VaultIndex;
  brain: Brain;
  vaultName?: () => string;
}

export interface AskOptions {
  question: string;
  mode: AnswerMode;
  route: RouteMode;
  history: ChatMessage[];
  activeNotePath?: string;
  includeActiveNote?: boolean;
  preferredModel?: string;
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Manuell "gründlich" erzwingen. */
  deep?: boolean;
}

export interface AskResult {
  answer: BrainAnswer;
  sources: Source[];
  system: string;
  userMessage: string;
  heavy: boolean;
  notice?: string;
}

const VAULT_MODES: AnswerMode[] = ['vault', 'note', 'summarize', 'tasks', 'plan', 'deep', 'critique'];

export class Assistant {
  constructor(private deps: AssistantDeps) {}

  /** Quellen sammeln (Vault-Suche + ggf. geöffnete Notiz). */
  async gatherSources(options: AskOptions): Promise<{ sources: Source[]; notice?: string }> {
    const settings = this.deps.settings();
    if (!settings.rag.enabled || !VAULT_MODES.includes(options.mode)) {
      return { sources: [] };
    }
    // Sicherstellen, dass der Index geladen/aktuell ist, bevor wir suchen.
    await this.deps.index.ensureFresh(false);
    const notes: Source[] = [];
    const noticeParts: string[] = [];

    if (options.includeActiveNote && options.activeNotePath) {
      const activeSources = this.deps.index.noteChunks(options.activeNotePath, Math.round(settings.rag.contextChars * 0.5));
      notes.push(...activeSources);
      if (!activeSources.length) {
        noticeParts.push(
          `Die geöffnete Notiz "${options.activeNotePath}" ist nicht im Index (ausgeschlossen, privat oder noch nicht eingelesen).`,
        );
      }
    }

    const searchBudget = Math.max(1500, settings.rag.contextChars - notes.reduce((sum, item) => sum + item.text.length, 0));
    const results = await this.deps.index.search(options.question, {
      topK: settings.rag.topK,
      contextChars: searchBudget,
      signal: options.signal,
    });
    // Doppelte vermeiden
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
    const { sources, notice } = await this.gatherSources(options);
    const effectiveMode: AnswerMode = settings.rag.deepMode && !options.deep && options.mode !== 'chat' ? options.mode : options.mode;

    const system = buildSystemPrompt({
      mode: options.deep ? 'deep' : effectiveMode,
      question: options.question,
      sources,
      customInstructions: settings.customInstructions,
      language: settings.answerLanguage || 'Deutsch',
      vaultName: this.deps.vaultName?.(),
      activeNotePath: options.mode === 'note' ? options.activeNotePath : undefined,
      citationStyle: sources.length > 0,
    });
    const userMessage = buildUserMessage(options.question, sources, effectiveMode);

    const contextChars = sources.reduce((sum, source) => sum + source.text.length, 0);
    const heavy = this.deps.brain.looksHeavy(options.question, contextChars);

    const answer = await this.deps.brain.run({
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

    return { answer, sources, system, userMessage, heavy, notice };
  }
}
