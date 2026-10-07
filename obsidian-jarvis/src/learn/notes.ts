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

  /** Prüfen, ob ein Pfad im Gedächtnisordner liegt (diese Notizen werden nicht doppelt durchsucht). */
  isMemoryPath(path: string): boolean {
    const folder = this.folder();
    return path === folder || path.startsWith(`${folder}/`);
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
