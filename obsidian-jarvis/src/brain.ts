/**
 * Das "Gehirn": entscheidet, welches Modell antwortet.
 *
 * - `local`  : nur der eigene Rechner (Ollama). Läuft ohne Internet.
 * - `cloud`  : die stärksten Cloud-Modelle (Claude / GPT / Gemini / OpenRouter).
 * - `auto`   : lokal antworten und nur bei Bedarf automatisch auf ein
 *              Top-Cloud-Modell ausweichen (z. B. lokal fehlt, Frage zu groß,
 *              lokale Antwort unbrauchbar).
 */
import type {
  ChatMessage,
  ChatResult,
  CloudProviderId,
  JarvisSettings,
  ModelInfo,
  ProviderId,
  RouteMode,
} from './types';
import type { Provider } from './providers/types';
import { OllamaProvider } from './providers/ollama';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAiCompatProvider } from './providers/openai-compat';
import { estimateTokens } from './util/format';

/** Kuratierte Top-Modelle (Stand Oktober 2026). Die Liste ist nur ein Vorschlag -
 *  die echten, verfügbaren Modelle holt das Plugin direkt beim Anbieter ab. */
export const PRESET_MODELS: Record<ProviderId, ModelInfo[]> = {
  ollama: [
    { id: 'qwen3.6:27b', label: 'Qwen 3.6 27B', providerId: 'ollama', local: true, note: 'lokal · stärkstes Allround-Profil (~17 GB)' },
    { id: 'qwen3:30b', label: 'Qwen 3 30B (MoE)', providerId: 'ollama', local: true, note: 'lokal · schnell für 30B (~19 GB)' },
    { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', providerId: 'ollama', local: true, note: 'lokal · Code & lange Dokumente' },
    { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', providerId: 'ollama', local: true, note: 'lokal · stark auf 16 GB (~13 GB)' },
    { id: 'gemma4:e4b', label: 'Gemma 4 E4B', providerId: 'ollama', local: true, note: 'lokal · klein, schnell, Bildverständnis' },
    { id: 'qwen3:8b', label: 'Qwen 3 8B', providerId: 'ollama', local: true, note: 'lokal · sparsam (~5 GB)' },
    { id: 'qwen3:4b', label: 'Qwen 3 4B', providerId: 'ollama', local: true, note: 'lokal · sehr leicht (~2,6 GB)' },
    { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B', providerId: 'ollama', local: true, note: 'lokal · Schlussfolgern (~9 GB)' },
  ],
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', providerId: 'anthropic', local: false, note: 'Top-Leistung' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', providerId: 'anthropic', local: false, note: 'stark & schnell' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', providerId: 'anthropic', local: false, note: 'Maximum für lange Aufgaben' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', providerId: 'anthropic', local: false, note: 'günstig & sehr schnell' },
  ],
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', providerId: 'openai', local: false, note: 'Top-Leistung' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', providerId: 'openai', local: false, note: 'stark & günstiger' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', providerId: 'openai', local: false, note: 'günstig & schnell' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', providerId: 'gemini', local: false, note: 'Top-Leistung, sehr schnell' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', providerId: 'gemini', local: false, note: 'stark im Schlussfolgern' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', providerId: 'gemini', local: false, note: 'ausgewogen' },
  ],
  openrouter: [
    { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5 (via OpenRouter)', providerId: 'openrouter', local: false, note: 'Top-Leistung' },
    { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra (via OpenRouter)', providerId: 'openrouter', local: false, note: 'Top-Leistung' },
    { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash (via OpenRouter)', providerId: 'openrouter', local: false, note: 'schnell' },
    { id: 'x-ai/grok-4.5', label: 'Grok 4.5 (via OpenRouter)', providerId: 'openrouter', local: false, note: 'stark & günstig' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro (via OpenRouter)', providerId: 'openrouter', local: false, note: 'sehr günstig' },
  ],
  custom: [],
};

export const CLOUD_ORDER_LABELS: Record<CloudProviderId, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT (OpenAI)',
  gemini: 'Gemini (Google)',
  openrouter: 'OpenRouter (alle Modelle)',
  custom: 'Eigener OpenAI-kompatibler Dienst',
};

export interface BrainRunOptions {
  mode: RouteMode;
  system: string;
  messages: ChatMessage[];
  preferredModel?: string;
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** Cloud-Ausweichen auch im Auto-Modus erlauben. */
  allowEscalation?: boolean;
  /** Grobe Fragen werden im Auto-Modus direkt an ein Cloud-Modell gegeben. */
  heavyTask?: boolean;
}

export interface BrainAnswer extends ChatResult {
  /** Log der Versuche, z. B. ["Ollama qwen3:8b", "Claude claude-opus-5-5"]. */
  attempts: { providerId: ProviderId; model: string; error?: string }[];
  escalated: boolean;
}

export interface ProviderStatus {
  providerId: ProviderId;
  label: string;
  local: boolean;
  configured: boolean;
  models: ModelInfo[];
  error?: string;
}

const REFUSAL_MARKERS = [
  'als ki-modell kann ich',
  'ich kann ihnen nicht helfen',
  'i cannot assist',
  'as an ai language model',
  'ich habe keinen zugriff auf',
];

export class Brain {
  private providers = new Map<ProviderId, Provider>();
  private modelCache = new Map<ProviderId, { at: number; models: ModelInfo[] }>();

  constructor(private settings: () => JarvisSettings, pluginVersion: string) {
    void pluginVersion;
  }

  /** Anbieter neu aufbauen (nach Änderungen an den Einstellungen). */
  refresh(): void {
    this.providers.clear();
  }

  provider(id: ProviderId): Provider {
    const existing = this.providers.get(id);
    if (existing) return existing;
    const settings = this.settings();
    let provider: Provider;
    if (id === 'ollama') {
      provider = new OllamaProvider(
        () => this.settings().local.baseUrl,
        () => ({
          numCtx: this.settings().local.numCtx,
          temperature: this.settings().local.temperature,
          keepAlive: this.settings().local.keepAlive,
          preferred: this.settings().local.preferred,
        }),
      );
    } else if (id === 'anthropic') {
      provider = new AnthropicProvider(
        () => this.settings().cloud.anthropic.baseUrl,
        () => this.cloudKey('anthropic'),
      );
    } else if (id === 'gemini') {
      provider = new GeminiProvider(
        () => this.settings().cloud.gemini.baseUrl,
        () => this.cloudKey('gemini'),
      );
    } else if (id === 'openai') {
      provider = new OpenAiCompatProvider({
        id: 'openai',
        label: 'GPT (OpenAI)',
        baseUrl: () => this.settings().cloud.openai.baseUrl,
        apiKey: () => this.cloudKey('openai'),
        sendUsageOption: true,
        useMaxCompletionTokens: true,
      });
    } else {
      provider = new OpenAiCompatProvider({
        id: id === 'openrouter' ? 'openrouter' : 'custom',
        label: id === 'openrouter' ? 'OpenRouter' : 'Eigener Dienst',
        baseUrl: () => this.settings().cloud[id].baseUrl,
        apiKey: () => this.cloudKey(id),
        sendUsageOption: id === 'openrouter',
        extraHeaders:
          id === 'openrouter'
            ? () => ({ 'http-referer': 'https://github.com/mar65vo187/jarvis', 'x-title': 'Jarvis AI fuer Obsidian' })
            : undefined,
      });
    }
    this.providers.set(id, provider);
    void settings;
    return provider;
  }

  /** API-Schlüssel werden vom Plugin außerhalb der Einstellungen verwaltet. */
  private keyReader: (id: CloudProviderId) => string = () => '';

  setKeyReader(reader: (id: CloudProviderId) => string): void {
    this.keyReader = reader;
    this.refresh();
  }

  private cloudKey(id: CloudProviderId): string {
    return this.keyReader(id);
  }

  /** Alle Modelle eines Anbieters (mit kurzem Zwischenspeicher). */
  async models(id: ProviderId, force = false): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(id);
    if (!force && cached && Date.now() - cached.at < 120_000) return cached.models;
    const provider = this.provider(id);
    const models = await provider.listModels();
    this.modelCache.set(id, { at: Date.now(), models });
    return models;
  }

  invalidateModelCache(id?: ProviderId): void {
    if (id) this.modelCache.delete(id);
    else this.modelCache.clear();
  }

  /** Statusübersicht für Einstellungen und Diagnose. */
  async status(opts: { includeCloud?: boolean } = {}): Promise<ProviderStatus[]> {
    const settings = this.settings();
    const ids: ProviderId[] = ['ollama', ...(opts.includeCloud === false ? [] : (Object.keys(settings.cloud) as CloudProviderId[]))];
    const out: ProviderStatus[] = [];
    for (const id of ids) {
      const provider = this.provider(id);
      const cloud = settings.cloud[id as CloudProviderId];
      const configured =
        id === 'ollama' ? Boolean(settings.local.baseUrl) : Boolean(cloud?.enabled && this.cloudKey(id as CloudProviderId).trim());
      let models: ModelInfo[] = [];
      let error: string | undefined;
      if (configured) {
        try {
          models = await this.models(id, true);
        } catch (err) {
          error = (err as Error).message;
        }
      }
      out.push({ providerId: id, label: provider.label, local: provider.local, configured, models, error });
    }
    return out;
  }

  /** Bestes installiertes lokales Modell bestimmen. */
  async pickLocalModel(installed: ModelInfo[]): Promise<string | undefined> {
    const settings = this.settings();
    const names = installed.map((model) => model.id);
    for (const want of settings.local.preferred) {
      const match = names.find((name) => name === want || name.startsWith(`${want}:`));
      if (match) return match;
    }
    const configured = settings.local.defaultModel;
    if (configured && names.includes(configured)) return configured;
    if (configured) {
      const match = names.find((name) => name.startsWith(`${configured}:`));
      if (match) return match;
    }
    // Nach größter Parameterzahl sortieren (bessere Qualität) - außer Embedding-Modelle.
    const scored = installed
      .filter((model) => !/\b(bge|nomic-embed|mxbai|embed)/i.test(model.id))
      .map((model) => ({ model, score: paramScore(model.id) }))
      .sort((a, b) => b.score - a.score);
    return scored[0]?.model.id ?? names[0];
  }

  private cloudCandidates(mode: RouteMode): CloudProviderId[] {
    const settings = this.settings();
    const order = settings.autoOrder?.length
      ? settings.autoOrder
      : (['anthropic', 'openai', 'gemini', 'openrouter', 'custom'] as CloudProviderId[]);
    return order.filter((id) => {
      const cloud = settings.cloud[id];
      if (!cloud?.enabled) return false;
      if (!this.cloudKey(id).trim()) return false;
      if (mode === 'cloud' && !cloud.defaultModel) {
        return PRESET_MODELS[id].length > 0;
      }
      return true;
    });
  }

  private modelFor(providerId: ProviderId, preferredModel?: string): string {
    const settings = this.settings();
    if (providerId === 'ollama') {
      return preferredModel ?? settings.local.defaultModel ?? PRESET_MODELS.ollama[0].id;
    }
    const id = providerId as CloudProviderId;
    const cloud = settings.cloud[id];
    if (preferredModel && preferredModel.length) return preferredModel;
    if (cloud?.defaultModel) return cloud.defaultModel;
    if (cloud?.models?.length) return cloud.models[0];
    return PRESET_MODELS[id]?.[0]?.id ?? '';
  }

  /** Ist die Frage groß genug, um direkt ein Cloud-Modell zu nehmen? */
  looksHeavy(question: string, contextChars: number): boolean {
    const words = question.split(/\s+/).filter(Boolean).length;
    const heavyWords =
      /(analysiere|vergleiche|bewerte|recherchiere|entwickle|konzipiere|architektur|strategie|code review|programmiere|erklär mir ausführlich|schreibe einen (auf)?satz|gutachten|zusammenfassende analyse)/i;
    return words > 220 || contextChars > 24_000 || heavyWords.test(question);
  }

  /** Eine Anfrage durchführen - je nach Modus lokal, in der Cloud oder automatisch. */
  async run(options: BrainRunOptions): Promise<BrainAnswer> {
    const settings = this.settings();
    const attempts: BrainAnswer['attempts'] = [];
    const wantsCloud = options.mode === 'cloud';
    const allowEscalation =
      options.allowEscalation ?? (settings.autoEscalate && options.mode === 'auto');

    interface Candidate {
      providerId: ProviderId;
      model: string;
      reason: string;
    }

    const candidates: Candidate[] = [];

    if (options.mode === 'local' || options.mode === 'auto') {
      if (settings.local.baseUrl) {
        candidates.push({
          providerId: 'ollama',
          model: this.modelFor('ollama', belongsTo(options.preferredModel, 'ollama') ? options.preferredModel : undefined),
          reason: 'lokal',
        });
      }
    }

    const cloudList = this.cloudCandidates(wantsCloud ? 'cloud' : 'auto');
    if (wantsCloud || allowEscalation || options.mode === 'auto') {
      for (const id of cloudList) {
        const preferred = belongsTo(options.preferredModel, id) ? options.preferredModel : undefined;
        const model = this.modelFor(id, preferred);
        if (!model) continue;
        candidates.push({ providerId: id, model, reason: 'Cloud' });
      }
    }

    if (!candidates.length) {
      throw new Error(
        wantsCloud
          ? 'Kein Cloud-Anbieter ist einsatzbereit. Bitte in den Jarvis-Einstellungen einen Schlüssel hinterlegen und "aktiv" setzen.'
          : 'Weder Ollama noch ein Cloud-Anbieter ist eingerichtet. Bitte in den Jarvis-Einstellungen prüfen.',
      );
    }

    // Im Cloud-Modus: nur die Cloud-Kandidaten verwenden.
    const list = wantsCloud ? candidates.filter((c) => c.providerId !== 'ollama') : candidates;
    const ordered = wantsCloud
      ? list
      : options.mode === 'auto' && options.heavyTask
        ? [...list].sort((a, b) => (a.providerId === 'ollama' ? 1 : 0) - (b.providerId === 'ollama' ? 1 : 0))
        : list;

    let lastError: unknown = null;
    let escalationHappened = false;

    for (let index = 0; index < ordered.length; index++) {
      const candidate = ordered[index];
      const provider = this.provider(candidate.providerId);
      const temperature =
        candidate.providerId === 'ollama'
          ? options.temperature ?? settings.local.temperature
          : settings.cloud[candidate.providerId as CloudProviderId]?.temperature;
      const maxTokens =
        candidate.providerId === 'ollama'
          ? options.maxTokens
          : options.maxTokens ?? settings.cloud[candidate.providerId as CloudProviderId]?.maxTokens;

      try {
        const result = await provider.chat({
          model: candidate.model,
          system: options.system,
          messages: options.messages,
          temperature,
          maxTokens: maxTokens && maxTokens > 0 ? maxTokens : undefined,
          onDelta: options.onDelta,
          signal: options.signal,
          allowStream: this.settings().ui.stream,
        });
        attempts.push({ providerId: candidate.providerId, model: candidate.model });

        // Unbrauchbare lokale Antwort? -> in der Cloud erneut versuchen.
        const looksLikeRefusal = REFUSAL_MARKERS.some((marker) => result.text.toLowerCase().includes(marker));
        const tooShort = result.text.trim().length < 40 && estimateTokens(options.messages.map((m) => m.content).join(' ')) > 60;
        const hasCloudLeft = ordered.slice(index + 1).some((c) => c.providerId !== 'ollama');
        if (
          candidate.providerId === 'ollama' &&
          allowEscalation &&
          hasCloudLeft &&
          !options.signal?.aborted &&
          (looksLikeRefusal || tooShort)
        ) {
          attempts[attempts.length - 1].error = looksLikeRefusal
            ? 'lokale Antwort war unbrauchbar (Ausweichen auf Cloud)'
            : 'lokale Antwort war zu kurz (Ausweichen auf Cloud)';
          escalationHappened = true;
          continue;
        }

        return { ...result, attempts, escalated: escalationHappened };
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        const message = (error as Error).message ?? String(error);
        attempts.push({ providerId: candidate.providerId, model: candidate.model, error: message });
        lastError = error;
        if (candidate.providerId === 'ollama' && index + 1 < ordered.length) {
          escalationHappened = true;
        }
        continue;
      }
    }

    const detail = attempts
      .filter((attempt) => attempt.error)
      .map((attempt) => `${attempt.providerId} (${attempt.model}): ${attempt.error}`)
      .join('\n');
    const error = new Error(
      `Kein Modell konnte antworten.\n${detail || (lastError as Error)?.message || 'Unbekannter Fehler'}`,
    );
    (error as Error & { attempts?: unknown }).attempts = attempts;
    throw error;
  }

  /** Eine Antwort in ein anderes Modell weitergeben (z. B. "besser machen"). */
  async escalate(options: BrainRunOptions): Promise<BrainAnswer> {
    return this.run({ ...options, mode: 'cloud' });
  }

  /** Verbindungstest für alle Anbieter. */
  async testAll(): Promise<string[]> {
    const settings = this.settings();
    const lines: string[] = [];
    const ollama = await this.provider('ollama').test();
    lines.push(`${ollama.ok ? '✅' : '⚠️'} ${ollama.message}`);
    for (const id of Object.keys(settings.cloud) as CloudProviderId[]) {
      const cloud = settings.cloud[id];
      if (!cloud?.enabled) continue;
      const result = await this.provider(id).test();
      lines.push(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
    }
    return lines;
  }
}

function belongsTo(model: string | undefined, providerId: ProviderId): boolean {
  if (!model) return false;
  if (providerId === 'openrouter') return model.includes('/');
  if (providerId === 'ollama') return !model.includes('/');
  if (providerId === 'anthropic') return model.startsWith('claude');
  if (providerId === 'openai') return model.startsWith('gpt') || model.startsWith('o');
  if (providerId === 'gemini') return model.startsWith('gemini');
  return false;
}

/** Grobe Parameterzahl aus dem Modellnamen schätzen (für die Auswahl des besten lokalen Modells). */
export function paramScore(modelId: string): number {
  const name = modelId.toLowerCase();
  const explicit = name.match(/(\d+(?:\.\d+)?)\s*b\b/);
  let score = 0;
  if (explicit) score = parseFloat(explicit[1]);
  else {
    const bare = name.match(/:(\d+(?:\.\d+)?)/);
    if (bare) score = parseFloat(bare[1]);
    else if (/\b(max|large|70b|72b)\b/.test(name)) score = 70;
    else score = 7;
  }
  if (/coder|code/.test(name)) score += 0.5;
  return score;
}
