/**
 * Gelerntes Wissen als normale Markdown-Notizen im Vault.
 *
 * Vorteile: du kannst es lesen, ändern und löschen, es ist durchsuchbar, und die
 * GitHub-Sicherung nimmt es automatisch mit. Damit überlebt das Gelernte jeden
 * Neustart, jedes Update und jeden Rechnerwechsel.
 */
import type { Lesson, LearningSettings } from './types';

export interface MemoryNoteFs {
  /** Pfad einer Datei anlegen (Ordner inklusive) und Inhalt schreiben. */
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
  /** Alle Dateien im Gedächtnisordner auflisten. */
  list(prefix: string): Promise<string[]>;
  ensureFolder(folder: string): Promise<void>;
}

export const MEMORY_FRONTMATTER_FLAG = 'jarvis-gelernt';

export class MemoryNotes {
  constructor(
    private fs: MemoryNoteFs,
    private settings: () => LearningSettings,
  ) {}

  private folder(): string {
    return (this.settings().memoryFolder || 'Jarvis Gedächtnis').replace(/^\/+|\/+$/g, '');
  }

  /** Dateiname aus Datum und Frage bilden (stabil und lesbar). */
  lessonPath(lesson: Lesson): string {
    const date = new Date(lesson.createdAt);
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(
      date.getMinutes(),
    )}`;
    const title = lesson.question
      .replace(/[\\/:*?"<>|#\[\]^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return `${this.folder()}/Lektion ${stamp} ${title || 'ohne Titel'}.md`;
  }

  render(lesson: Lesson): string {
    const sourceLines = lesson.sources.length
      ? lesson.sources.map((source) => `- [[${source.path}]]${source.heading ? ` › ${source.heading}` : ''}`).join('\n')
      : '- (keine Notizquellen)';
    const header = [
      '---',
      `${MEMORY_FRONTMATTER_FLAG}: true`,
      `jarvis-id: ${lesson.id}`,
      `jarvis-modell: ${lesson.provider}/${lesson.model}`,
      `jarvis-grund: ${lesson.reason}`,
      `jarvis-bewertung: ${lesson.rating}`,
      `erstellt: ${new Date(lesson.createdAt).toISOString()}`,
      '---',
      '',
    ].join('\n');
    const body = [
      `# Gelernt: ${lesson.question}`,
      '',
      '> Diese Notiz ist von Jarvis AI gelerntes Wissen. Du kannst sie ändern oder löschen —',
      '> sie wird dann genau so verwendet (bzw. nicht mehr).',
      '',
      '## Frage',
      '',
      lesson.question,
      '',
      '## Gelernte Antwort',
      '',
      lesson.answer,
      '',
    ];
    if (lesson.correction) {
      body.push('## Deine Korrektur (verbindlich)', '', lesson.correction, '');
    }
    body.push('## Notizquellen', '', sourceLines, '');
    return `${header}${body.join('\n')}`;
  }

  /** Eine Lektion als Notiz ablegen (überschreibt dieselbe Datei, falls vorhanden). */
  async save(lesson: Lesson): Promise<string> {
    if (!this.settings().writeNotes) return '';
    const path = this.lessonPath(lesson);
    await this.fs.ensureFolder(this.folder());
    await this.fs.write(path, this.render(lesson));
    return path;
  }

  async remove(lesson: Lesson): Promise<void> {
    try {
      await this.fs.remove(this.lessonPath(lesson));
    } catch {
      // Datei existiert nicht
    }
  }

  /** Alle Lektionen als Notizen anlegen, die noch keine haben. */
  async syncAll(lessons: Lesson[]): Promise<{ written: number; existing: number }> {
    if (!this.settings().writeNotes) return { written: 0, existing: 0 };
    const folder = this.folder();
    await this.fs.ensureFolder(folder);
    const existing = await this.fs.list(folder);
    const known = new Set<string>();
    for (const path of existing) {
      const content = await this.fs.read(path);
      if (!content) continue;
      const match = /jarvis-id:\s*(\S+)/.exec(content);
      if (match) known.add(match[1]);
    }
    let written = 0;
    for (const lesson of lessons) {
      if (known.has(lesson.id)) continue;
      await this.save(lesson);
      written++;
    }
    return { written, existing: known.size };
  }

  /**
   * Eine Notiz zurück in eine Lektion übersetzen. Damit ist der Vault (und über die
   * GitHub-Sicherung auch das Repository) die dauerhafte Quelle des Gelernten: Auch
   * nach einer Neuinstallation oder auf einem anderen Rechner ist das Wissen wieder da.
   *
   * Verträgt Änderungen von Hand: fehlende Bereiche werden aus dem Text erschlossen.
   */
  parse(path: string, content: string): Lesson | null {
    if (!content.includes(`${MEMORY_FRONTMATTER_FLAG}: true`)) return null;
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? '';
    const feld = (name: string): string => {
      const treffer = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(frontmatter);
      return treffer ? treffer[1].trim() : '';
    };

    // In Abschnitte zerlegen (## Überschrift) — stabiler als Muster mit Zeilenenden.
    const abschnitte = new Map<string, string>();
    let laufenderTitel: string | null = null;
    let puffer: string[] = [];
    const uebernehmen = () => {
      if (laufenderTitel) abschnitte.set(laufenderTitel.toLowerCase(), puffer.join('\n').trim());
    };
    for (const zeile of content.split('\n')) {
      const treffer = /^##\s+(.*)$/.exec(zeile);
      if (treffer) {
        uebernehmen();
        laufenderTitel = treffer[1].trim();
        puffer = [];
        continue;
      }
      if (laufenderTitel) puffer.push(zeile);
    }
    uebernehmen();
    const abschnitt = (titel: string): string => {
      const gesucht = titel.toLowerCase();
      const genau = abschnitte.get(gesucht);
      if (genau) return genau;
      for (const [name, inhalt] of abschnitte) if (name.startsWith(gesucht) && inhalt) return inhalt;
      return '';
    };

    const ueberschrift = /^#\s*Gelernt:\s*(.*)$/m.exec(content)?.[1]?.trim() ?? '';
    const frage = abschnitt('Frage') || ueberschrift;
    let antwort = abschnitt('Gelernte Antwort');
    if (!antwort) {
      // Von Hand gekürzte Notiz: alles unterhalb der Überschrift ist die Antwort.
      const ohneKopf = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
      antwort = abschnitt('Frage') || abschnitt('Deine Korrektur')
        ? ''
        : ohneKopf
            .split('\n')
            .filter((zeile) => !/^#\s*Gelernt:/.test(zeile) && !/^>\s/.test(zeile) && !/^---\s*$/.test(zeile))
            .join('\n')
            .trim();
    }
    if (!antwort) return null;

    const korrektur = abschnitt('Deine Korrektur (verbindlich)') || undefined;
    const quellenText = abschnitt('Notizquellen');
    const sources: Lesson['sources'] = [];
    for (const zeile of quellenText.split('\n')) {
      const treffer = /^\s*-\s*\[\[([^\]]+)\]\](?:\s*›\s*(.*))?/.exec(zeile);
      if (!treffer) continue;
      const pfad = treffer[1].split('|')[0].trim();
      if (!pfad) continue;
      const heading = treffer[2]?.trim();
      sources.push(heading ? { path: pfad, heading } : { path: pfad });
    }

    const modell = feld('jarvis-modell');
    const [provider, ...rest] = modell.split('/');
    const grund = feld('jarvis-grund');
    const bewertung = feld('jarvis-bewertung');
    const erstellt = Date.parse(feld('erstellt'));
    const gruende = ['escalation', 'upgrade', 'manual', 'correction'] as const;
    const bewertungen = ['auto', 'good', 'bad'] as const;
    return {
      id: feld('jarvis-id') || `n${kurzeKennung(path)}`,
      createdAt: Number.isFinite(erstellt) ? erstellt : Date.now(),
      question: frage || '(Frage nicht mehr lesbar)',
      answer: antwort,
      provider: provider || 'unbekannt',
      model: rest.join('/') || 'unbekannt',
      reason: gruende.includes(grund as (typeof gruende)[number]) ? (grund as Lesson['reason']) : 'manual',
      sources,
      terms: [],
      rating: bewertungen.includes(bewertung as (typeof bewertungen)[number])
        ? (bewertung as Lesson['rating'])
        : 'auto',
      correction: korrektur,
      usedCount: 0,
      lastUsedAt: 0,
    };
  }

  /** Alle Notizen im Gedächtnisordner einlesen und in Lektionen übersetzen. */
  async importAll(): Promise<Lesson[]> {
    const folder = this.folder();
    const dateien = await this.fs.list(folder);
    const lektionen: Lesson[] = [];
    for (const path of dateien) {
      if (!/\.md$/i.test(path)) continue;
      try {
        const content = await this.fs.read(path);
        if (!content) continue;
        const lesson = this.parse(path, content);
        if (lesson) lektionen.push(lesson);
      } catch {
        // Eine unlesbare Notiz darf die Wiederherstellung nicht stoppen.
      }
    }
    return lektionen.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Prüfen, ob ein Pfad im Gedächtnisordner liegt (diese Notizen werden nicht doppelt durchsucht). */
  isMemoryPath(path: string): boolean {
    const folder = this.folder();
    return path === folder || path.startsWith(`${folder}/`);
  }
}

/** Kleine, stabile Kennung aus einem Pfad (falls eine Notiz kein jarvis-id hat). */
function kurzeKennung(text: string): string {
  let wert = 7;
  for (let i = 0; i < text.length; i++) wert = (wert * 31 + text.charCodeAt(i)) % 0xffffffff;
  return wert.toString(36);
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
