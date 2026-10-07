import { describe, expect, it } from 'vitest';
import { assessAnswer, compareWithCloud, keyTerms } from '../src/learn/quality';
import { LearningStore, type JsonPersist } from '../src/learn/store';
import { Distiller, buildModelfile, modelNameForVersion, escapeTripleQuote } from '../src/learn/distill';
import { MemoryNotes, type MemoryNoteFs } from '../src/learn/notes';
import { mergeSettings } from '../src/settings';
import type { LearningSettings } from '../src/learn/types';
import type { Source } from '../src/rag/vault-index';

const SOURCE: Source = {
  id: 'Q1',
  path: 'Projekt Alpha.md',
  heading: 'Status',
  text: 'Das Projekt Alpha endet am 15. November. Ansprechpartnerin ist Frau Berger. Der Lieferant hat noch keine Zusage gegeben.',
  score: 2,
};

class MemoryJson implements JsonPersist {
  constructor(public data: string | null = null) {}
  async read(): Promise<string | null> {
    return this.data;
  }
  async write(text: string): Promise<void> {
    this.data = text;
  }
}

class MemoryNoteStore implements MemoryNoteFs {
  files = new Map<string, string>();
  folders = new Set<string>();

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }
  async ensureFolder(folder: string): Promise<void> {
    this.folders.add(folder);
  }
}

function settingsFactory(overrides: Partial<LearningSettings> = {}): () => LearningSettings {
  const merged = mergeSettings({ learning: overrides });
  return () => merged.learning;
}

describe('Qualitätsmessung', () => {
  it('zieht Schlüsselbegriffe (Namen und Zahlen zuerst)', () => {
    const terms = keyTerms([SOURCE]);
    expect(terms).toContain('projekt');
    expect(terms).toContain('november');
    expect(terms.some((term) => term.includes('berger'))).toBe(true);
    expect(terms.some((term) => term === '15')).toBe(true);
    expect(terms.length).toBeLessThanOrEqual(24);
    expect(terms).not.toContain('der');
  });

  it('misst die Abdeckung und erkennt schwache Antworten', () => {
    const weak = assessAnswer('Ich habe dazu eine Notiz gefunden.', [SOURCE], 0.55);
    expect(weak.weak).toBe(true);
    expect(weak.coverage).toBeLessThan(0.3);
    expect(weak.missing.length).toBeGreaterThan(3);

    const good = assessAnswer(
      'Laut [Q1] endet Projekt Alpha am 15. November. Ansprechpartnerin ist Frau Berger; der Lieferant hat noch keine Zusage gegeben.',
      [SOURCE],
      0.55,
    );
    expect(good.weak).toBe(false);
    expect(good.coverage).toBeGreaterThan(0.6);
  });

  it('erkennt Ausweichantworten, aber nicht ehrliche Hinweise', () => {
    const refuse = assessAnswer('Als KI-Modell kann ich diese Frage nicht beantworten.', [SOURCE], 0.55);
    expect(refuse.hedged).toBe(true);
    expect(refuse.weak).toBe(true);

    const honest = assessAnswer(
      'In den Quellen findet sich dazu nichts. Laut [Q1] ist nur der 15. November bekannt.',
      [SOURCE],
      0.55,
    );
    expect(honest.hedged).toBe(false);
  });

  it('vergleicht lokale und Cloud-Antwort und nennt die Verbesserung', () => {
    const comparison = compareWithCloud(
      'Dazu steht nichts in den Notizen.',
      [SOURCE],
      'Projekt Alpha endet am 15. November, Ansprechpartnerin ist Frau Berger, die Zusage des Lieferanten fehlt.',
      0.55,
    );
    expect(comparison.gain).toBeGreaterThan(0.3);
    expect(comparison.summary).toContain('lokal');
    expect(comparison.summary).toContain('Cloud');
  });
});

describe('Lernspeicher', () => {
  it('speichert, findet und führt Dubletten zusammen', async () => {
    const json = new MemoryJson();
    const store = new LearningStore(json, settingsFactory(), 0);
    await store.load();

    const lesson = await store.add({
      question: 'Wann endet Projekt Alpha?',
      answer: 'Am 15. November.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'upgrade',
      sources: [{ path: 'Projekt Alpha.md', heading: 'Status' }],
    });
    expect(store.count()).toBe(1);
    expect(lesson.terms).toContain('projekt');

    // Dieselbe Antwort noch einmal -> keine zweite Lektion
    await store.add({
      question: 'Wann endet Projekt Alpha?',
      answer: 'Am 15. November.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'upgrade',
      sources: [{ path: 'Projekt Alpha.md' }],
    });
    expect(store.count()).toBe(1);

    const found = store.search('Wann ist der Endtermin von Projekt Alpha?');
    expect(found[0]?.id).toBe(lesson.id);
    expect(store.search('Rezept für Kuchen')).toHaveLength(0);
  });

  it('überlebt einen Neustart vollständig', async () => {
    const json = new MemoryJson();
    const first = new LearningStore(json, settingsFactory(), 0);
    await first.load();
    await first.add({
      question: 'Was kostet das Angebot?',
      answer: 'Das Angebot liegt bei 4.250 Euro.',
      provider: 'openai',
      model: 'gpt-6-astra',
      reason: 'escalation',
      sources: [{ path: 'Angebot.md' }],
    });
    await first.recordQuality({ local: 0.4, cloud: 0.9, kind: 'upgrade' });
    await first.recordCall('openai/gpt-6-astra', { ms: 1200, ok: true, quality: 0.9 });
    await first.flush();

    const second = new LearningStore(json, settingsFactory(), 0);
    await second.load();
    expect(second.count()).toBe(1);
    const snapshot = second.snapshot();
    expect(snapshot.lessons).toBe(1);
    expect(snapshot.avgCloudQuality).toBeCloseTo(0.9, 2);
    expect(snapshot.modelStats[0]).toMatchObject({ model: 'openai/gpt-6-astra', calls: 1 });
    expect(second.search('Angebot Kosten')[0]?.answer).toContain('4.250');
  });

  it('verkraftet eine beschädigte Datei ohne Absturz', async () => {
    const json = new MemoryJson('{kaputt');
    const store = new LearningStore(json, settingsFactory(), 0);
    await store.load();
    expect(store.count()).toBe(0);
    const lesson = await store.add({
      question: 'Neue Frage zur Sicherheit',
      answer: 'Neue Antwort',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      reason: 'manual',
      sources: [],
    });
    expect(lesson.id).toBeTruthy();
    expect(json.data).toContain('Neue Antwort');
  });

  it('bewertet, korrigiert und bevorzugt Gutes', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory());
    await store.load();
    const good = await store.add({
      question: 'Wie lautet die Rechnungsnummer von Alpha?',
      answer: 'RE-2026-114.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'escalation',
      sources: [],
    });
    const bad = await store.add({
      question: 'Wie lautet die Rechnungsnummer von Alpha?',
      answer: 'Dazu habe ich keine Angabe.',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      reason: 'escalation',
      sources: [],
    });
    await store.rate(good.id, 'good');
    await store.rate(bad.id, 'bad');
    await store.setCorrection(good.id, 'Die Rechnungsnummer lautet RE-2026-114 (mit Bindestrichen).');

    expect(store.snapshot().corrections).toBe(1);
    expect(store.snapshot().good).toBe(1);
    expect(store.snapshot().bad).toBe(1);
    expect(store.search('Rechnungsnummer Alpha')[0].id).toBe(good.id);
    expect(store.renderForPrompt([store.get(good.id)!], 4000)).toContain('Vom Nutzer korrigiert');
  });

  it('hält die Obergrenze ein und wirft Schlechtes zuerst weg', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory({ maxLessons: 20 }), 0);
    await store.load();
    for (let index = 0; index < 26; index++) {
      const lesson = await store.add({
        question: `Frage Nummer ${index} zum Thema Bericht`,
        answer: `Antwort ${index} mit ausreichender Länge für die Aufnahme in den Speicher.`,
        provider: 'openai',
        model: 'gpt-6-luna',
        reason: 'manual',
        sources: [],
        rating: index % 5 === 0 ? 'good' : 'auto',
      });
      if (index % 5 === 3) await store.rate(lesson.id, 'bad');
    }
    expect(store.count()).toBeLessThanOrEqual(20);
    // Die als schlecht bewertete Lektion darf nicht überlebt haben
    expect(store.list().every((lesson) => lesson.rating !== 'bad' || lesson.usedCount > 0)).toBe(true);
  });

  it('gibt den Verlauf und den Bericht aus', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory());
    await store.load();
    await store.recordQuality({ local: 0.3, cloud: 0.8, kind: 'upgrade' });
    await store.recordQuality({ local: 0.5, kind: 'answer' });
    await store.recordDistill();
    const snapshot = store.snapshot();
    expect(snapshot.distills).toBe(1);
    expect(snapshot.avgLocalQuality).toBeGreaterThan(0);
    const text = store.historyText(5).join('\n');
    expect(text).toContain('destilliert');
    expect(text).toContain('Cloud 80 %');
  });

  it('zählt neue Lektionen für das automatische Verbessern', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory());
    await store.load();
    const base = {
      question: 'Was ist der Status im Projekt Bericht?',
      answer: 'Der Bericht ist fertig und wartet auf Freigabe durch die Leitung.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'escalation' as const,
      sources: [],
    };
    await store.add({ ...base, question: 'Frage eins zum Status des Projekts' });
    await store.add({ ...base, question: 'Frage zwei zum Status des Projekts' });
    expect(store.pendingForDistill()).toBe(2);
    await store.recordDistill();
    expect(store.pendingForDistill()).toBe(0);
  });
});

describe('Destillation (lokales Modell verbessern)', () => {
  function lessons(): Array<Parameters<LearningStore['add']>[0]> {
    return [
      {
        question: 'Wann endet Projekt Alpha?',
        answer: 'Projekt Alpha endet am 15. November; Ansprechpartnerin ist Frau Berger.',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        reason: 'upgrade',
        sources: [{ path: 'Projekt Alpha.md' }],
      },
      {
        question: 'Wer ist Ansprechpartnerin?',
        answer: 'Frau Berger ist die Ansprechpartnerin für Projekt Alpha.',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        reason: 'escalation',
        sources: [{ path: 'Projekt Alpha.md' }],
      },
      {
        question: 'Kurz?',
        answer: 'Ja.',
        provider: 'openai',
        model: 'gpt-6-luna',
        reason: 'manual',
        sources: [],
      },
    ];
  }

  it('baut ein Modelfile mit Basis, Regeln und Beispielen', () => {
    const modelfile = buildModelfile({
      base: 'qwen3:8b',
      system: 'Regel: Antworte sehr knapp.',
      examples: [
        { question: 'Wann endet Projekt Alpha?', answer: 'Am 15. November.' },
        { question: 'Mit """Anführungszeichen"""', answer: 'Beispielantwort' },
      ],
      rules: ['Immer das Datum nennen.'],
      temperature: 0.3,
      numCtx: 8192,
    });
    expect(modelfile).toContain('FROM qwen3:8b');
    expect(modelfile).toContain('PARAMETER temperature 0.3');
    expect(modelfile).toContain('PARAMETER num_ctx 8192');
    expect(modelfile).toContain('SYSTEM """');
    expect(modelfile).toContain('Regeln aus früheren Korrekturen');
    expect(modelfile).toContain('MESSAGE user """Wann endet Projekt Alpha?"""');
    expect(modelfile).toContain('MESSAGE assistant """Am 15. November."""');
    // Dreifache Anführungszeichen im Inhalt dürfen das Modelfile nicht zerstören
    expect(modelfile).not.toContain('""""""');
    expect(escapeTripleQuote('a"""b')).toBe("a'''b");
    expect(modelfile.match(/MESSAGE user/g)).toHaveLength(2);
  });

  it('plant Beispiele, überspringt Ungeeignetes und vergibt Versionen', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory({ distillMaxExamples: 5 }), 0);
    await store.load();
    for (const input of lessons()) await store.add(input);

    const learning = mergeSettings({ learning: { distillMaxExamples: 5 } });
    const distiller = new Distiller({
      ollama: { createModel: async () => undefined, deleteModel: async () => undefined, listModels: async () => [] },
      learning: () => learning.learning,
      local: () => learning.local,
      lessons: () => store.list(),
    });
    const plan = distiller.plan();
    expect(plan.model).toBe('jarvis-brain-v1');
    expect(plan.base).toBe('qwen3:8b');
    expect(plan.examples).toHaveLength(2);
    expect(plan.skipped.join(' ')).toContain('zu kurz');
    expect(plan.modelfile).toContain('MESSAGE user');

    learning.learning.distillVersion = 4;
    expect(distiller.plan().model).toBe('jarvis-brain-v5');
    expect(modelNameForVersion(3)).toBe('jarvis-brain-v3');
  });

  it('prüft Voraussetzungen, legt das Modell an und räumt alte auf', async () => {
    const created: Array<{ model: string; modelfile: string }> = [];
    const deleted: string[] = [];
    const installed = ['qwen3:8b', 'jarvis-brain-v1', 'jarvis-brain-v2'];
    const learning = mergeSettings({ learning: {} });

    const emptyStore = new LearningStore(new MemoryJson(), settingsFactory({}), 0);
    await emptyStore.load();
    const emptyDistiller = new Distiller({
      ollama: { createModel: async () => undefined, deleteModel: async () => undefined, listModels: async () => [] },
      learning: () => learning.learning,
      local: () => learning.local,
      lessons: () => emptyStore.list(),
    });
    expect(emptyDistiller.validate(emptyDistiller.plan())).toContain('noch nichts gelernt');

    const store = new LearningStore(new MemoryJson(), settingsFactory({}), 0);
    await store.load();
    for (const input of lessons()) await store.add(input);

    const distiller = new Distiller({
      ollama: {
        createModel: async (model, modelfile) => {
          created.push({ model, modelfile });
          installed.push(model);
        },
        deleteModel: async (model) => {
          deleted.push(model);
        },
        listModels: async () => installed.map((id) => ({ id })),
      },
      learning: () => learning.learning,
      local: () => learning.local,
      lessons: () => store.list(),
    });

    const plan = distiller.plan();
    expect(distiller.validate(plan)).toBeNull();
    const result = await distiller.run(plan);
    expect(created[0].model).toBe('jarvis-brain-v1');
    expect(created[0].modelfile).toContain('MESSAGE assistant');
    expect(result.message).toContain('2 Beispiel');

    const removed = await distiller.cleanup(1);
    expect(removed.sort()).toEqual(['jarvis-brain-v2']);
    expect(deleted).not.toContain('jarvis-brain-v1');
    expect(deleted).not.toContain('qwen3:8b');
  });

  it('meldet klar, wenn Ollama das Profil nicht anlegt', async () => {
    const store = new LearningStore(new MemoryJson(), settingsFactory({}), 0);
    await store.load();
    for (const input of lessons()) await store.add(input);
    const learning = mergeSettings({ learning: {} });
    const distiller = new Distiller({
      ollama: { createModel: async () => undefined, deleteModel: async () => undefined, listModels: async () => [{ id: 'qwen3:8b' }] },
      learning: () => learning.learning,
      local: () => learning.local,
      lessons: () => store.list(),
    });
    await expect(distiller.run(distiller.plan())).rejects.toThrow(/nicht angelegt/);
  });
});

describe('Gelerntes als Markdown-Notizen', () => {
  it('schreibt Notizen mit Kopfbereich und Quellen', async () => {
    const fs = new MemoryNoteStore();
    const learning = mergeSettings({ learning: {} });
    const store = new LearningStore(new MemoryJson(), settingsFactory({}), 0);
    await store.load();
    const lesson = await store.add({
      question: 'Wann endet Projekt Alpha?',
      answer: 'Am 15. November.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'upgrade',
      sources: [{ path: 'Projekt Alpha.md', heading: 'Status' }],
    });

    const notes = new MemoryNotes(fs, () => learning.learning);
    const path = await notes.save(lesson);
    expect(path).toContain('Jarvis Gedächtnis/Lektion');
    const content = fs.files.get(path)!;
    expect(content).toContain('jarvis-gelernt: true');
    expect(content).toContain(`jarvis-id: ${lesson.id}`);
    expect(content).toContain('## Gelernte Antwort');
    expect(content).toContain('[[Projekt Alpha.md]]');
    expect(notes.isMemoryPath(path)).toBe(true);
    expect(notes.isMemoryPath('Notizen/Etwas.md')).toBe(false);
  });

  it('legt nur fehlende Notizen an und entfernt auf Wunsch', async () => {
    const fs = new MemoryNoteStore();
    const learning = mergeSettings({ learning: {} });
    const store = new LearningStore(new MemoryJson(), settingsFactory({}), 0);
    await store.load();
    const first = await store.add({
      question: 'Erste Frage zum Angebot',
      answer: 'Erste Antwort mit Inhalt.',
      provider: 'openai',
      model: 'gpt-6-astra',
      reason: 'manual',
      sources: [],
    });
    const second = await store.add({
      question: 'Zweite Frage zum Angebot',
      answer: 'Zweite Antwort mit Inhalt.',
      provider: 'openai',
      model: 'gpt-6-astra',
      reason: 'manual',
      sources: [],
    });

    const notes = new MemoryNotes(fs, () => learning.learning);
    const wrote = await notes.syncAll([first, second]);
    expect(wrote.written).toBe(2);

    const again = await notes.syncAll([first, second]);
    expect(again.written).toBe(0);
    expect(again.existing).toBe(2);

    await notes.remove(second);
    expect(fs.files.size).toBe(1);
  });

  it('schreibt nichts, wenn Notizen abgeschaltet sind', async () => {
    const fs = new MemoryNoteStore();
    const learning = mergeSettings({ learning: { writeNotes: false } });
    const notes = new MemoryNotes(fs, () => learning.learning);
    const path = await notes.save({
      id: 'w1',
      createdAt: Date.now(),
      question: 'Frage',
      answer: 'Antwort',
      provider: 'openai',
      model: 'gpt-6-luna',
      reason: 'manual',
      sources: [],
      terms: [],
      rating: 'auto',
      usedCount: 0,
      lastUsedAt: 0,
    });
    expect(path).toBe('');
    expect(fs.files.size).toBe(0);
  });
});

describe('Wiederherstellung aus den Notizen (nach Neuinstallation oder Rechnerwechsel)', () => {
  it('liest eine Notiz wieder als Lektion ein (Hin- und Rückweg)', async () => {
    const settings = settingsFactory();
    const fs = new MemoryNoteStore();
    const notes = new MemoryNotes(fs, settings);
    const store = new LearningStore(new MemoryJson(), settings, 0);
    const lektion = await store.add({
      question: 'Wann endet Projekt Alpha?',
      answer: 'Am 15. November. Ansprechpartnerin ist Frau Berger.',
      provider: 'openai',
      model: 'gpt-6-astra',
      reason: 'upgrade',
      sources: [{ path: 'Projekt Alpha.md', heading: 'Status' }],
      rating: 'good',
      correction: 'Abgabe ist der 20. November.',
    });
    const path = await notes.save(lektion);
    const inhalt = (await fs.read(path))!;

    // Neuer, leerer Speicher — wie nach einer Neuinstallation
    const frisch = new LearningStore(new MemoryJson(), settings, 0);
    expect(frisch.count()).toBe(0);

    const gelesen = notes.parse(path, inhalt)!;
    expect(gelesen.id).toBe(lektion.id);
    expect(gelesen.question).toBe('Wann endet Projekt Alpha?');
    expect(gelesen.answer).toContain('15. November');
    expect(gelesen.provider).toBe('openai');
    expect(gelesen.model).toBe('gpt-6-astra');
    expect(gelesen.reason).toBe('upgrade');
    expect(gelesen.rating).toBe('good');
    expect(gelesen.correction).toContain('20. November');
    expect(gelesen.sources).toEqual([{ path: 'Projekt Alpha.md', heading: 'Status' }]);

    expect(await frisch.adopt(gelesen)).toBe(true);
    expect(frisch.count()).toBe(1);
    expect(frisch.get(lektion.id)?.question).toBe(lektion.question);
    // Der Suchindex funktioniert danach wieder
    expect(frisch.search('Wann endet Projekt Alpha?').length).toBe(1);
    // Zweimal übernehmen ergibt keine Dublette
    expect(await frisch.adopt(gelesen)).toBe(false);
    expect(frisch.count()).toBe(1);
  });

  it('nimmt Änderungen von Hand mit und ignoriert fremde Notizen', async () => {
    const settings = settingsFactory();
    const fs = new MemoryNoteStore();
    const notes = new MemoryNotes(fs, settings);
    const store = new LearningStore(new MemoryJson(), settings, 0);
    const lektion = await store.add({
      question: 'Wer ist Ansprechpartnerin?',
      answer: 'Frau Berger.',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reason: 'escalation',
      sources: [{ path: 'Projekt Alpha.md' }],
    });
    const path = await notes.save(lektion);
    // Nutzer ändert die Antwort in der Notiz
    const geaendert = (await fs.read(path))!.replace('Frau Berger.', 'Frau Berger (Tel. 069-1234).');
    await fs.write(path, geaendert);

    const liste = await notes.importAll();
    expect(liste).toHaveLength(1);
    expect(liste[0].answer).toContain('069-1234');
    expect(liste[0].provider).toBe('anthropic');
    expect(liste[0].model).toBe('claude-opus-5-5');

    // Eine normale Notiz ohne Merkmal wird nicht eingelesen
    await fs.write('Jarvis Gedächtnis/Normale Notiz.md', '# Einkaufsliste\n\n- Milch\n- Brot\n');
    const danach = await notes.importAll();
    expect(danach).toHaveLength(1);
  });

  it('kommt mit einer von Hand gekürzten Notiz zurecht', async () => {
    const settings = settingsFactory();
    const fs = new MemoryNoteStore();
    const notes = new MemoryNotes(fs, settings);
    await fs.write(
      'Jarvis Gedächtnis/Lektion kaputt.md',
      ['---', 'jarvis-gelernt: true', '---', '# Gelernt: Was ist mit Rechnung RE-2026-114?', '', 'Sie ist offen.', ''].join('\n'),
    );
    const liste = await notes.importAll();
    expect(liste).toHaveLength(1);
    expect(liste[0].question).toContain('RE-2026-114');
    expect(liste[0].answer).toBe('Sie ist offen.');
    // Ohne jarvis-id bleibt die Kennung über mehrere Läufe stabil
    const zweiterLauf = await notes.importAll();
    expect(zweiterLauf[0].id).toBe(liste[0].id);
  });
});
