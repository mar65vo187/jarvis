/**
 * Qualitätsmessung.
 *
 * Wie misst man "die lokale Antwort war schlechter", ohne einen Menschen zu fragen?
 * Hier wird gemessen, wie viel von dem, was in den Quellen steht, in der Antwort
 * tatsächlich vorkommt (Abdeckung der Schlüsselbegriffe). Zusätzlich werden
 * Ausweich-Floskeln erkannt. Das ist keine Wahrheit, aber ein belastbares Signal -
 * und es macht Verbesserung über die Zeit sichtbar.
 */
import type { Source } from '../rag/vault-index';
import { normalizeForSearch } from '../util/format';

export interface QualityResult {
  /** 0 = nichts aus den Quellen verwendet, 1 = alles Wesentliche enthalten. */
  coverage: number;
  /** Anzahl der Schlüsselbegriffe, auf denen die Messung beruht. */
  terms: number;
  /** Gefundene Begriffe. */
  matched: string[];
  /** Fehlende Begriffe (für Hinweise und für den Prompt). */
  missing: string[];
  /** Antwort wirkt wie eine Ausweich- oder Standardfloskel. */
  hedged: boolean;
  /** Gesamturteil. */
  weak: boolean;
}

const HEDGE_PATTERNS = [
  /als (ki|sprach)[- ]?modell/i,
  /als (ki|künstliche[r]? intelligenz)[- ]?assistent/i,
  /ich kann (diese|die|ihre)? ?(frage|aufgabe) nicht/i,
  /ich (kann|darf) (diese|die) (frage|aufgabe|anfrage) nicht beantworten/i,
  /ich habe keinen zugriff auf/i,
  /dazu (habe|liegen) ich keine (informationen|angaben)/i,
  /ich kann (ihnen|dir) nicht helfen/i,
  /as an ai language model/i,
  /i (can|could) ?not (help|answer)/i,
  /leider (kann|weiß) ich/i,
  /keine informationen (dazu|darüber)/i,
];

/** Sätze wie "Ich habe dazu keine Notiz gefunden" sind ehrlich und nicht automatisch schlecht. */
const HONEST_PATTERNS = [
  /fasse ich zusammen/i,
  /zusammengefasst/i,
  /nicht in (den|meinen) notizen/i,
  /in den quellen (steht|findet sich)/i,
  /laut \[q\d\]/i,
];

const NUMBER_LIKE = /^[0-9]+([.,][0-9]+)?$/;

/** Schlüsselbegriffe aus den Quellen ziehen, die in einer guten Antwort vorkommen sollten. */
export function keyTerms(sources: Source[], max = 24): string[] {
  const frequency = new Map<string, number>();
  const counts: number[] = [];
  for (const source of sources) {
    const words = normalizeForSearch(`${source.heading ?? ''} ${source.text}`).match(/[a-z0-9äöü]{3,}/g) ?? [];
    const numbers = source.text.match(/\b\d{1,4}(?:[.,]\d+)?\b/g) ?? [];
    for (const word of [...words, ...numbers]) {
      if (word.length < 4 && !NUMBER_LIKE.test(word)) continue;
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
    counts.push(words.length || 1);
  }
  const total = counts.reduce((sum, value) => sum + value, 0) || 1;

  // Eigennamen (großgeschriebene Wörter im Original) und Zahlen sind besonders aussagekräftig.
  const properNouns = new Set<string>();
  for (const source of sources) {
    const matches = `${source.heading ?? ''} ${source.text}`.match(/\b[A-ZÄÖÜ][a-zäöüß]{3,}\b/g) ?? [];
    for (const match of matches) properNouns.add(normalizeForSearch(match));
  }

  const scored = [...frequency.entries()]
    .map(([term, count]) => {
      let score = count / total;
      if (properNouns.has(term)) score += 0.6;
      if (NUMBER_LIKE.test(term)) score += 0.4;
      if (term.length > 9) score += 0.1;
      return { term, score };
    })
    .sort((a, b) => b.score - a.score);

  const out: string[] = [];
  for (const item of scored) {
    out.push(item.term);
    if (out.length >= max) break;
  }
  return out;
}

function containsTerm(answer: string, term: string): boolean {
  if (answer.includes(term)) return true;
  // Deutsche Wortformen: gemeinsamer Wortstamm ab 5 Zeichen genügt.
  if (term.length >= 5) {
    const stem = term.slice(0, Math.max(5, term.length - 3));
    return answer.includes(stem);
  }
  return false;
}

export function assessAnswer(answer: string, sources: Source[], threshold = 0.55, keyTermsOverride?: string[]): QualityResult {
  const terms = keyTermsOverride ?? keyTerms(sources);
  const normalized = normalizeForSearch(answer);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of terms) {
    if (containsTerm(normalized, term)) matched.push(term);
    else missing.push(term);
  }
  const coverage = terms.length ? matched.length / terms.length : 0;
  const hedgeHits = HEDGE_PATTERNS.filter((pattern) => pattern.test(answer)).length;
  const honest = HONEST_PATTERNS.some((pattern) => pattern.test(answer));
  const hedged = hedgeHits > 0 && !honest;
  const tooShort = answer.trim().length < 60 && terms.length >= 4;
  const weak = hedged || tooShort || (terms.length >= 4 && coverage < threshold);
  return { coverage, terms: terms.length, matched, missing, hedged, weak };
}

export interface ComparisonResult {
  local: QualityResult;
  cloud?: QualityResult;
  /** Verbesserung: Cloud-Abdeckung minus lokale Abdeckung. */
  gain: number;
  /** Kurze Begründung für die Oberfläche. */
  summary: string;
}

export function compareWithCloud(
  localAnswer: string,
  localSources: Source[],
  cloudAnswer: string | undefined,
  threshold: number,
  keyTermsOverride?: string[],
): ComparisonResult {
  const terms = keyTermsOverride ?? keyTerms(localSources);
  const local = assessAnswer(localAnswer, localSources, threshold, terms);
  if (!cloudAnswer) {
    return {
      local,
      gain: 0,
      summary: `Quellenabdeckung ${formatPercent(local.coverage)}${local.missing.length ? ` · fehlt z. B. ${local.missing.slice(0, 3).join(', ')}` : ''}`,
    };
  }
  const cloud = assessAnswer(cloudAnswer, localSources, threshold, terms);
  const gain = cloud.coverage - local.coverage;
  const parts = [
    `lokal ${formatPercent(local.coverage)}`,
    `Cloud ${formatPercent(cloud.coverage)}`,
    gain > 0.02 ? `Verbesserung +${formatPercent(gain, false)}` : gain < -0.02 ? `Rückgang ${formatPercent(gain, false)}` : 'gleichwertig',
  ];
  if (local.missing.length) parts.push(`lokal fehlte: ${local.missing.slice(0, 4).join(', ')}`);
  return { local, cloud, gain, summary: parts.join(' · ') };
}

export function formatPercent(value: number, withSign = true): string {
  const percent = Math.round(value * 100);
  const sign = withSign && percent > 0 ? '' : '';
  return `${sign}${percent} %`;
}

/** Durchschnittliche Qualität aus Proben. */
export function averageQuality(samples: Array<{ local: number }>): number {
  if (!samples.length) return 0;
  return samples.reduce((sum, sample) => sum + sample.local, 0) / samples.length;
}
