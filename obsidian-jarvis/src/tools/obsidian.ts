/**
 * Obsidian-Werkzeuge: das, was nur ein Plug-in *in* Obsidian kann.
 *
 * Die geöffnete Notiz, die Auswahl im Editor, Tagesnotiz, Verweise (Backlinks),
 * Tags und das Öffnen von Notizen. Lesende Werkzeuge sind immer erlaubt,
 * Schreibende nur mit Freigabe (wie bei den Vault-Werkzeugen).
 */
import type { JarvisSettings } from '../types';
import { argNumber, argText, safeVaultPath, type ToolSpec } from './types';

/** Zugriff auf die laufende Obsidian-Oberfläche (wird von der Bridge gefüllt). */
export interface ObsidianKontrolle {
  /** Pfad der gerade geöffneten Notiz (leer, wenn keine offen ist). */
  aktuelleNotiz(): string;
  /** Inhalt der gerade geöffneten Notiz (null, wenn keine offen ist). */
  leseAktuelle(): Promise<string | null>;
  /** Markierter Text im Editor (leer, wenn nichts markiert ist). */
  auswahl(): string;
  /** Pfad der Notiz, in der die Auswahl steht. */
  auswahlNotiz(): string;
  /** Ersetzt die Auswahl (oder fügt am Ende ein). Liefert eine Beschreibung. */
  ersetzeAuswahl(text: string): Promise<{ ok: boolean; text: string }>;
  /** Öffnet eine Notiz in einem neuen oder vorhandenen Tab. */
  oeffne(pfad: string): Promise<boolean>;
  /** Bearbeitet den Vault-Metadaten-Cache für Verweise und Tags. */
  verweise(pfad: string): { ausgehend: string[]; eingehend: string[] };
  /** Alle Tags im Vault mit Anzahl. */
  tags(): Array<{ tag: string; count: number }>;
  /** Pfad der Tagesnotiz für heute (leer, wenn nicht ermittelbar). */
  tagesnotizPfad(): string;
  /** Beliebige Notiz lesen (null, wenn es sie nicht gibt). */
  lesePfad(pfad: string): Promise<string | null>;
  /** Text an eine Notiz anhängen (legt sie an). */
  schreibe(pfad: string, text: string): Promise<{ ok: boolean; text: string; summary?: string }>;
}

function kuerzen(text: string, grenze: number): string {
  if (text.length <= grenze) return text;
  return `${text.slice(0, grenze)}\n\n[… gekürzt: ${text.length - grenze} Zeichen]`;
}

/** Die Obsidian-Werkzeuge, die laut Einstellungen erlaubt sind. */
export function buildObsidianTools(
  settings: JarvisSettings,
  kontrolle: ObsidianKontrolle | undefined,
): ToolSpec[] {
  if (!kontrolle) return [];
  const t = settings.tools;
  const specs: ToolSpec[] = [];

  specs.push({
    name: 'note_current',
    summary: 'Zeigt die Notiz, die gerade in Obsidian geöffnet ist (Pfad und Inhalt).',
    params: [{ name: 'maxChars', description: 'Höchstzahl Zeichen (Standard 8000)', required: false }],
    handler: async (args) => {
      const pfad = kontrolle.aktuelleNotiz();
      if (!pfad) return { ok: false, text: 'Es ist gerade keine Notiz geöffnet.' };
      const inhalt = await kontrolle.leseAktuelle();
      if (inhalt === null) return { ok: false, text: `Die Notiz "${pfad}" konnte nicht gelesen werden.` };
      const grenze = argNumber(args, 'maxChars', 8000, 500, 60_000);
      const markierung = kontrolle.auswahl();
      const auswahlHinweis = markierung
        ? `\n\nMARKIERTER TEXT IN DIESER NOTIZ:\n${kuerzen(markierung, 3000)}`
        : '';
      return {
        ok: true,
        text: `GEÖFFNETE NOTIZ: ${pfad}\n\n${kuerzen(inhalt, grenze)}${auswahlHinweis}`,
        summary: pfad,
      };
    },
  });

  specs.push({
    name: 'note_links',
    summary: 'Zeigt die Verweise einer Notiz: was sie verlinkt und was auf sie verweist (Backlinks).',
    params: [{ name: 'path', description: 'Pfad der Notiz (leer = die geöffnete Notiz)', required: false }],
    handler: async (args) => {
      const pfad = safeVaultPath(argText(args, 'path')) || kontrolle.aktuelleNotiz();
      if (!pfad) return { ok: false, text: 'Es ist keine Notiz geöffnet und es wurde kein Pfad genannt.' };
      const { ausgehend, eingehend } = kontrolle.verweise(pfad);
      if (!ausgehend.length && !eingehend.length) {
        return { ok: true, text: `"${pfad}" hat keine Verweise.`, summary: '0 Verweise' };
      }
      const text = [
        `NOTIZ: ${pfad}`,
        '',
        `VERWEIST AUF (${ausgehend.length}):`,
        ausgehend.length ? ausgehend.slice(0, 40).map((ziel) => `→ ${ziel}`).join('\n') : '— keine —',
        '',
        `WIRD VERWIESEN VON (${eingehend.length}):`,
        eingehend.length ? eingehend.slice(0, 40).map((quelle) => `← ${quelle}`).join('\n') : '— keine —',
      ].join('\n');
      return { ok: true, text, summary: `${ausgehend.length} aus, ${eingehend.length} ein` };
    },
  });

  specs.push({
    name: 'vault_tags',
    summary: 'Listet die Tags im Vault, die am häufigsten zuerst.',
    params: [{ name: 'filter', description: 'Nur Tags, die diesen Text enthalten', required: false }],
    handler: async (args) => {
      const filter = argText(args, 'filter').replace(/^#/, '').toLowerCase();
      const alle = kontrolle.tags();
      const passt = filter ? alle.filter((eintrag) => eintrag.tag.toLowerCase().includes(filter)) : alle;
      if (!passt.length) {
        return { ok: true, text: filter ? `Kein Tag enthält "${filter}".` : 'Der Vault hat keine Tags.', summary: '0 Tags' };
      }
      const text = passt.slice(0, 50).map((eintrag) => `#${eintrag.tag} (${eintrag.count})`).join('\n');
      return { ok: true, text, summary: `${passt.length} Tags` };
    },
  });

  specs.push({
    name: 'note_open',
    summary: 'Öffnet eine Notiz in Obsidian, damit du sie siehst (nützlich nach dem Anlegen).',
    params: [{ name: 'path', description: 'Pfad der Notiz', required: true }],
    handler: async (args) => {
      const pfad = safeVaultPath(argText(args, 'path'));
      if (!pfad) return { ok: false, text: 'Es fehlt "path" (der Pfad der Notiz).' };
      const geoeffnet = await kontrolle.oeffne(pfad);
      return geoeffnet
        ? { ok: true, text: `"${pfad}" ist jetzt in Obsidian geöffnet.`, summary: 'geöffnet' }
        : { ok: false, text: `"${pfad}" gibt es nicht (oder der Pfad ist ungültig).` };
    },
  });

  specs.push({
    name: 'daily_note',
    summary: 'Zeigt die Tagesnotiz von heute (und ob es sie schon gibt).',
    params: [{ name: 'maxChars', description: 'Höchstzahl Zeichen (Standard 6000)', required: false }],
    handler: async (args) => {
      const pfad = kontrolle.tagesnotizPfad();
      if (!pfad) return { ok: false, text: 'Der Pfad der Tagesnotiz ist nicht bekannt (Einstellungen → Werkzeuge).' };
      const inhalt = await kontrolle.lesePfad(pfad);
      if (inhalt === null) {
        return { ok: true, text: `Für heute gibt es noch keine Tagesnotiz. Sie wäre: ${pfad}`, summary: 'noch nicht vorhanden' };
      }
      const grenze = argNumber(args, 'maxChars', 6000, 500, 30_000);
      return { ok: true, text: `TAGESNOTIZ: ${pfad}\n\n${kuerzen(inhalt, grenze)}`, summary: pfad };
    },
  });

  if (t.allowVaultWrite) {
    specs.push({
      name: 'daily_append',
      summary: 'Hängt einen Eintrag an die Tagesnotiz von heute an (legt sie an, falls nötig).',
      danger: 'write',
      params: [{ name: 'content', description: 'Der Text, z. B. "- 14:00 Besprechung mit Team"', required: true }],
      handler: async (args) => {
        const pfad = kontrolle.tagesnotizPfad();
        if (!pfad) return { ok: false, text: 'Der Pfad der Tagesnotiz ist nicht bekannt (Einstellungen → Werkzeuge).' };
        const text = typeof args.content === 'string' ? args.content : argText(args, 'content');
        if (!text.trim()) return { ok: false, text: 'Es fehlt "content" (der Text für die Tagesnotiz).' };
        const ergebnis = await kontrolle.schreibe(pfad, text.trim());
        return ergebnis;
      },
    });

    specs.push({
      name: 'editor_replace',
      summary: 'Ersetzt den markierten Text in der geöffneten Notiz durch deinen Text.',
      danger: 'write',
      params: [
        { name: 'content', description: 'Der neue Text', required: true },
        { name: 'mode', description: '"replace" (Standard) oder "insert" (unter der Auswahl einfügen)', required: false },
      ],
      handler: async (args) => {
        const text = typeof args.content === 'string' ? args.content : argText(args, 'content');
        if (!text.trim()) return { ok: false, text: 'Es fehlt "content" (der neue Text).' };
        if (!kontrolle.aktuelleNotiz()) return { ok: false, text: 'Es ist gerade keine Notiz geöffnet.' };
        const modus = argText(args, 'mode') === 'insert' ? 'insert' : 'replace';
        const text2 = modus === 'insert' ? `\n${text}` : text;
        const ergebnis = await kontrolle.ersetzeAuswahl(text2);
        return ergebnis;
      },
    });
  }

  return specs;
}
