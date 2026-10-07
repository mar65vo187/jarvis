/** Datentypen für das Lernsystem (v2). */

/** Ein Eintrag, den Jarvis gelernt hat — meist eine geprüfte Cloud-Antwort. */
export interface Lesson {
  id: string;
  createdAt: number;
  /** Die Frage, auf die sich die Antwort bezieht. */
  question: string;
  /** Die (bessere) Antwort, aus der gelernt wird. */
  answer: string;
  /** Woher die Antwort kam (z. B. "anthropic"). */
  provider: string;
  model: string;
  /** Warum gespeichert: Ausweichen, Aufwertung nach schwacher lokaler Antwort, manuell. */
  reason: 'escalation' | 'upgrade' | 'manual' | 'correction';
  /** Benutzte Notizen (Pfade), damit die Herkunft prüfbar bleibt. */
  sources: Array<{ path: string; heading?: string }>;
  /** Stichworte aus Frage und Antwort (für die Wiederverwendung). */
  terms: string[];
  /** Bewertung durch den Nutzer oder automatisch. */
  rating: 'auto' | 'good' | 'bad';
  /** Wenn der Nutzer die Antwort korrigiert hat: seine Fassung. */
  correction?: string;
  usedCount: number;
  lastUsedAt: number;
  /** Wurde diese Lektion in ein lokales Ollama-Modell geschrieben? */
  distilledVersion?: number;
}

export interface QualitySample {
  at: number;
  /** Abdeckung der Quellen-Schlüsselbegriffe durch die lokale Antwort (0..1). */
  local: number;
  /** Gleiche Messung für die Cloud-Antwort, falls vorhanden. */
  cloud?: number;
  kind: 'answer' | 'upgrade' | 'distill';
}

export interface ModelStat {
  calls: number;
  failures: number;
  totalMs: number;
  /** Summe der Qualitätswerte, geteilt durch `qualityCount`. */
  qualitySum: number;
  qualityCount: number;
  lastAt: number;
}

export interface LearningSettings {
  /** Lernen komplett an/aus. */
  enabled: boolean;
  /** Ordner im Vault, in dem Lektionen als Markdown liegen. */
  memoryFolder: string;
  /** Lektionen als Markdown-Notizen im Vault ablegen? */
  writeNotes: boolean;
  /** Nach einer Cloud-Antwort automatisch merken, nachfragen oder aus. */
  saveMode: 'auto' | 'ask' | 'off';
  /** Nur bei Ausweich/Aufwertung lernen oder bei jeder Cloud-Antwort. */
  learnFrom: 'escalations' | 'all';
  /** Ab dieser Quellenabdeckung gilt eine lokale Antwort als brauchbar. */
  qualityThreshold: number;
  /** Obergrenze gespeicherter Lektionen (schwächste werden zuerst entfernt). */
  maxLessons: number;
  /** Wie viele Lektionen in den Prompt gehen. */
  injectLessons: number;
  /** Höchstzahl Zeichen aus Lektionen im Prompt. */
  injectChars: number;
  /** Nach so vielen neuen Lektionen automatisch destillieren (0 = aus). */
  autoDistillAfter: number;
  /** Höchstzahl Beispiele im destillierten Modell. */
  distillMaxExamples: number;
  /** Regeln aus Korrektionen, die ins destillierte Modell einfließen. */
  systemHints: string[];
  /** Basis, auf der zuletzt destilliert wurde. */
  distillBase: string;
  /** Version des zuletzt erzeugten Modells. */
  distillVersion: number;
  lastDistillAt: string;
  lastDistillModel: string;
  qualityHistory: QualitySample[];
}

export interface LearningSnapshot {
  lessons: number;
  corrections: number;
  good: number;
  bad: number;
  avgLocalQuality: number;
  avgCloudQuality: number;
  /** Qualität nach Destillation gegenüber vorher. */
  improvement: number;
  distills: number;
  updatedAt: number;
  modelStats: Array<{ model: string; calls: number; failures: number; avgQuality: number; avgMs: number }>;
}

export const EMPTY_SNAPSHOT: LearningSnapshot = {
  lessons: 0,
  corrections: 0,
  good: 0,
  bad: 0,
  avgLocalQuality: 0,
  avgCloudQuality: 0,
  improvement: 0,
  distills: 0,
  updatedAt: 0,
  modelStats: [],
};
