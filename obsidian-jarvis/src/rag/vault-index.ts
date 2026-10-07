/**
 * Wissensindex des Vaults.
 *
 * - liest alle Markdown-Notizen (ohne ausgeschlossene Ordner und private Notizen)
 * - zerlegt sie in Abschnitte ("Chunks")
 * - sucht hybrid: Bedeutungsvektoren (falls ein lokales Embedding-Modell läuft)
 *   plus Stichwortsuche (BM25) - so funktioniert es auch ohne Vektor-Modell
 * - Zwischenspeicher wird bei Änderungen automatisch aktualisiert
 */
import { normalizeForSearch } from '../util/format';
import type { ModelInfo } from '../types';

export interface VaultFileInfo {
  path: string;
  mtime: number;
  size: number;
}

export interface VaultReader {
  list(): Promise<VaultFileInfo[]>;
  read(path: string): Promise<string>;
}

export interface IndexPersist {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface Embedder {
  /** Name des Embedding-Modells oder null, wenn keines verfügbar ist. */
  modelName(): string | null;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null>;
}

export interface Chunk {
  path: string;
  heading: string;
  text: string;
  start: number;
  tokens: string[];
  vec?: Float32Array;
}

export interface Source {
  id: string;
  path: string;
  heading: string;
  text: string;
  score: number;
  viaVector?: boolean;
}

export interface IndexStats {
  files: number;
  chunks: number;
  embedded: number;
  bytes: number;
  updatedAt: number;
  skipped: number;
  embeddingModel: string | null;
}

export interface RagOptions {
  excludeFolders: string[];
  maxNoteBytes: number;
  topK: number;
  contextChars: number;
}

const INDEX_VERSION = 3;
const CHUNK_TARGET = 1100;
const CHUNK_OVERLAP = 150;
const MAX_CHUNK = 1600;

const STOPWORDS = new Set(
  ('der die das den dem des ein eine einer eines einem einen und oder aber ist sind war wird werden wurde ich du er sie es wir ihr ' +
    'mein meine meinen mir mich dein deine sich mit von für fur auf an am im in zu zum zur aus bei nach vor als auch noch bitte kann ' +
    'kannst soll sollen was wie wer wo wann warum welches welche welcher dieses diese dieser habe hat haben über uber mal jetzt heute ' +
    'the and for with that this from are was were will would can could should you your have has had not but all any our their they them')
    .split(' '),
);

export function tokenize(text: string): string[] {
  const normalized = normalizeForSearch(text);
  const matches = normalized.match(/[a-z0-9äöü]{2,}/g) ?? [];
  const out: string[] = [];
  for (const token of matches) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** YAML-Kopfbereich auswerten (nur die Felder, die wir brauchen). */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const result: Record<string, string> = {};
  if (!match) return result;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

export function isPrivateNote(frontmatter: Record<string, string>): boolean {
  const flags = ['ki-privat', 'jarvis-privat', 'ai-private', 'private-ai'];
  return flags.some((flag) => /^(true|ja|1|yes)$/i.test(frontmatter[flag] ?? ''));
}

export function isExcluded(path: string, excludeFolders: string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part.startsWith('.'))) return true;
  return excludeFolders
    .map((folder) => folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

/** Notiz in Abschnitte zerlegen (überschriftenbewusst). */
export function chunkNote(path: string, text: string): Chunk[] {
  const cleaned = text
    .replace(/```query[\s\S]*?```/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/^(---\r?\n[\s\S]*?\r?\n---)/, ' ');
  const chunks: Chunk[] = [];
  const lines = cleaned.split(/\r?\n/);
  let heading = '';
  let buffer = '';
  let offset = 0;
  let chunkStart = 0;

  const flush = () => {
    const body = buffer.trim();
    buffer = '';
    if (!body) return;
    // Zu lange Abschnitte weiter aufteilen
    if (body.length > MAX_CHUNK) {
      let index = 0;
      while (index < body.length) {
        const piece = body.slice(index, index + CHUNK_TARGET);
        chunks.push(makeChunk(path, heading, piece, chunkStart + index));
        if (index + CHUNK_TARGET >= body.length) break;
        index += CHUNK_TARGET - CHUNK_OVERLAP;
      }
    } else {
      chunks.push(makeChunk(path, heading, body, chunkStart));
    }
  };

  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    if (isHeading) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, '').trim();
      chunkStart = offset;
    }
    buffer += `${line}\n`;
    offset += line.length + 1;
    if (buffer.length >= CHUNK_TARGET) {
      flush();
      chunkStart = Math.max(0, offset - CHUNK_OVERLAP);
      buffer = '';
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.tokens.length >= 3);
}

function makeChunk(path: string, heading: string, text: string, start: number): Chunk {
  const tokens = tokenize(`${heading} ${text}`);
  return { path, heading, text, start, tokens };
}

interface PersistedIndex {
  version: number;
  embeddingModel: string | null;
  files: Record<string, { mtime: number; size: number }>;
  chunks: Array<{
    path: string;
    heading: string;
    text: string;
    start: number;
    vec?: string;
  }>;
}

function floatsToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function base64ToFloats(text: string): Float32Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VaultIndex {
  private chunks: Chunk[] = [];
  private files = new Map<string, { mtime: number; size: number }>();
  private docFreq = new Map<string, number>();
  private embeddingModel: string | null = null;
  private updatedAt = 0;
  private loaded = false;
  private building: Promise<IndexStats> | null = null;

  constructor(
    private reader: VaultReader,
    private persist: IndexPersist,
    private options: RagOptions,
    private embedder: Embedder,
  ) {}

  stats(): IndexStats {
    return {
      files: this.files.size,
      chunks: this.chunks.length,
      embedded: this.chunks.filter((chunk) => chunk.vec).length,
      bytes: this.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      updatedAt: this.updatedAt,
      skipped: 0,
      embeddingModel: this.embeddingModel,
    };
  }

  setOptions(options: RagOptions): void {
    this.options = options;
  }

  /** Index laden (aus dem Zwischenspeicher) und bei Bedarf aktualisieren. */
  async ensureFresh(force = false): Promise<IndexStats> {
    if (this.building) return this.building;
    this.building = this.build(force).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(force: boolean): Promise<IndexStats> {
    await this.load();
    const files = (await this.reader.list()).filter(
      (file) => !isExcluded(file.path, this.options.excludeFolders),
    );
    const currentPaths = new Set(files.map((file) => file.path));

    // Gelöschte oder ausgeschlossene Notizen entfernen
    for (const [path] of this.files) {
      if (!currentPaths.has(path)) this.removeFile(path);
    }

    const changed = force
      ? files
      : files.filter((file) => {
          const known = this.files.get(file.path);
          return !known || known.mtime !== file.mtime || known.size !== file.size;
        });

    const pending: Chunk[] = [];
    for (const file of changed) {
      try {
        const text = await this.reader.read(file.path);
        const sliced = text.length > this.options.maxNoteBytes ? text.slice(0, this.options.maxNoteBytes) : text;
        const frontmatter = parseFrontmatter(sliced);
        this.removeFile(file.path);
        if (isPrivateNote(frontmatter)) {
          this.files.set(file.path, { mtime: file.mtime, size: file.size });
          continue;
        }
        const next = chunkNote(file.path, sliced);
        pending.push(...next);
        this.files.set(file.path, { mtime: file.mtime, size: file.size });
      } catch {
        // nicht lesbare Datei überspringen
      }
    }

    if (pending.length) {
      this.chunks.push(...pending);
      await this.embedChunks(pending);
    }

    if (changed.length || force) {
      this.updatedAt = Date.now();
      this.recomputeDocFreq();
      await this.save();
    }

    return this.stats();
  }

  private removeFile(path: string): void {
    this.chunks = this.chunks.filter((chunk) => chunk.path !== path);
    this.files.delete(path);
  }

  private async embedChunks(chunks: Chunk[]): Promise<void> {
    const model = this.embedder.modelName();
    if (!model) return;
    if (this.embeddingModel && this.embeddingModel !== model) {
      // Modell gewechselt -> alle Vektoren verwerfen
      for (const chunk of this.chunks) delete chunk.vec;
    }
    this.embeddingModel = model;
    const batchSize = 24;
    for (let index = 0; index < chunks.length; index += batchSize) {
      const batch = chunks.slice(index, index + batchSize);
      try {
        const vectors = await this.embedder.embed(batch.map((chunk) => `${chunk.heading}\n${chunk.text}`));
        if (!vectors) return;
        vectors.forEach((vector, position) => {
          if (vector?.length) batch[position].vec = Float32Array.from(vector);
        });
      } catch {
        return;
      }
    }
  }

  private recomputeDocFreq(): void {
    this.docFreq.clear();
    for (const chunk of this.chunks) {
      for (const token of new Set(chunk.tokens)) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
    }
  }

  /** Hybride Suche: Vektoren + BM25, mit Vielfalt (max. 2 Abschnitte je Notiz). */
  async search(question: string, options: { topK?: number; contextChars?: number; signal?: AbortSignal } = {}): Promise<Source[]> {
    await this.ensureFresh();
    const topK = options.topK ?? this.options.topK;
    const budget = options.contextChars ?? this.options.contextChars;
    const queryTokens = tokenize(question);
    if (!queryTokens.length || !this.chunks.length) return [];

    const unique = [...new Set(queryTokens)];
    const total = this.chunks.length;
    const avgLength = this.chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / total || 1;

    // BM25
    const k1 = 1.4;
    const b = 0.7;
    const bm25 = new Map<Chunk, number>();
    for (const chunk of this.chunks) {
      const counts = new Map<string, number>();
      for (const token of chunk.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of unique) {
        const exact = counts.get(token) ?? 0;
        let fuzzy = 0;
        if (!exact && token.length >= 5) {
          for (const [candidate, count] of counts) {
            if (candidate.length >= 5 && (candidate.startsWith(token) || token.startsWith(candidate))) {
              fuzzy += count * 0.5;
            }
          }
        }
        const frequency = exact + fuzzy;
        if (!frequency) continue;
        const df = this.docFreq.get(token) ?? 0.5;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = 1 - b + b * (chunk.tokens.length / avgLength);
        score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
      }
      // Überschriften und Notiznamen zählen stärker
      const pathTokens = tokenize(chunk.path).join(' ');
      if (/[a-z]/.test(pathTokens)) {
        for (const token of unique) {
          if (pathTokens.includes(token)) score += 0.6;
          if (chunk.heading && normalizeForSearch(chunk.heading).includes(token)) score += 0.5;
        }
      }
      if (score > 0) bm25.set(chunk, score);
    }

    // Vektoren
    let vectorScores = new Map<Chunk, number>();
    if (this.embedder.modelName() && this.chunks.some((chunk) => chunk.vec)) {
      try {
        const queryVector = (await this.embedder.embed([question], options.signal))?.[0];
        if (queryVector?.length) {
          const floats = Float32Array.from(queryVector);
          for (const chunk of this.chunks) {
            if (!chunk.vec) continue;
            const similarity = cosineSimilarity(floats, chunk.vec);
            if (similarity > 0.15) vectorScores.set(chunk, similarity);
          }
        }
      } catch {
        vectorScores = new Map();
      }
    }

    const maxBm25 = Math.max(1e-6, ...bm25.values());
    const scored: Array<{ chunk: Chunk; score: number; viaVector: boolean }> = [];
    const considered = new Set<Chunk>([...bm25.keys(), ...vectorScores.keys()]);
    for (const chunk of considered) {
      const keyword = (bm25.get(chunk) ?? 0) / maxBm25;
      const vector = vectorScores.get(chunk) ?? 0;
      const hasVectors = vectorScores.size > 0;
      const score = hasVectors ? 0.55 * vector + 0.45 * keyword : keyword;
      if (score <= 0) continue;
      scored.push({ chunk, score, viaVector: vector > 0 });
    }
    scored.sort((a, b2) => b2.score - a.score);

    // Vielfalt: höchstens 2 Abschnitte pro Notiz, Gesamtbudget beachten
    const perFile = new Map<string, number>();
    const picked: Source[] = [];
    let used = 0;
    const usedTexts = new Set<string>();
    for (const item of scored) {
      if (picked.length >= topK) break;
      const count = perFile.get(item.chunk.path) ?? 0;
      if (count >= 2) continue;
      const key = item.chunk.text.slice(0, 120);
      if (usedTexts.has(key)) continue;
      const remaining = budget - used;
      if (remaining < 200) break;
      const text = item.chunk.text.length > remaining ? item.chunk.text.slice(0, remaining) : item.chunk.text;
      used += text.length;
      usedTexts.add(key);
      perFile.set(item.chunk.path, count + 1);
      picked.push({
        id: `Q${picked.length + 1}`,
        path: item.chunk.path,
        heading: item.chunk.heading,
        text,
        score: item.score,
        viaVector: item.viaVector,
      });
    }
    return picked;
  }

  /** Alle Abschnitte einer Notiz (für "diese Notiz als Kontext"). */
  noteChunks(path: string, budget: number): Source[] {
    const chunks = this.chunks.filter((chunk) => chunk.path === path);
    const out: Source[] = [];
    let used = 0;
    for (const chunk of chunks) {
      if (used >= budget) break;
      const text = chunk.text.slice(0, budget - used);
      used += text.length;
      out.push({ id: `Q${out.length + 1}`, path, heading: chunk.heading, text, score: 1 });
    }
    return out;
  }

  async clear(): Promise<void> {
    this.chunks = [];
    this.files.clear();
    this.docFreq.clear();
    this.embeddingModel = null;
    this.updatedAt = 0;
    await this.persist.write('');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.persist.read();
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedIndex;
      if (parsed.version !== INDEX_VERSION) return;
      this.embeddingModel = parsed.embeddingModel;
      for (const [path, meta] of Object.entries(parsed.files ?? {})) this.files.set(path, meta);
      this.chunks = (parsed.chunks ?? []).map((chunk) => ({
        path: chunk.path,
        heading: chunk.heading,
        text: chunk.text,
        start: chunk.start,
        tokens: tokenize(`${chunk.heading} ${chunk.text}`),
        vec: chunk.vec ? base64ToFloats(chunk.vec) : undefined,
      }));
      this.updatedAt = Date.now();
      this.recomputeDocFreq();
    } catch {
      this.chunks = [];
      this.files.clear();
    }
  }

  private async save(): Promise<void> {
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      embeddingModel: this.embeddingModel,
      files: Object.fromEntries(this.files),
      chunks: this.chunks.map((chunk) => ({
        path: chunk.path,
        heading: chunk.heading,
        text: chunk.text,
        start: chunk.start,
        vec: chunk.vec ? floatsToBase64(chunk.vec) : undefined,
      })),
    };
    try {
      await this.persist.write(JSON.stringify(payload));
    } catch {
      // Speichern ist optional
    }
  }

  /** Liste der Notizen im Index (für Diagnose). */
  indexedPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

export function modelsToOptions(models: ModelInfo[]): Array<{ id: string; label: string }> {
  return models.map((model) => ({ id: model.id, label: model.label }));
}
