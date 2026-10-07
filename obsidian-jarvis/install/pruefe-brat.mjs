#!/usr/bin/env node
/**
 * Prüft, ob BRAT dieses Plug-in wirklich installieren kann — mit echten Anfragen an
 * GitHub, in der Reihenfolge, die BRAT selbst verwendet:
 *
 *   1. Release bestimmen                /repos/{repo}/releases        (BRAT nutzt die
 *      bzw. /releases/tags/{tag}        neueste Version, sortiert nach Tag-Nummer)
 *   2. Release-Dateien prüfen           main.js, manifest.json, styles.css
 *   3. Tag-Version <-> manifest.json    (BRAT lehnt bei Abweichung ab)
 *   4. main.js inhaltlich prüfen        (echtes Bündel, keine Attrappe)
 *   5. optional: mit dem hier liegenden main.js vergleichen (SHA-256)
 *
 * Aufruf:
 *   node install/pruefe-brat.mjs [besitzer/repo] [tag-erwartet] [--streng]
 *
 * Beispiele:
 *   node install/pruefe-brat.mjs mar65vo187/jarvis
 *   node install/pruefe-brat.mjs mar65vo187/jarvis obsidian-jarvis-2.0.0 --streng
 *
 * Umgebungsvariablen:
 *   GITHUB_TOKEN  optional, hebt die Anfragegrenze auf (für private Repos nötig)
 *
 * Rückgabewerte: 0 = alles in Ordnung · 1 = Fehler gefunden · 3 = Inhalte nicht ladbar
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argumente = process.argv.slice(2).filter((wert) => wert !== '--streng');
const streng = process.argv.includes('--streng');
const repo = argumente[0] ?? 'mar65vo187/jarvis';
const erwartetesTag = argumente[1] ?? '';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

const HIER = dirname(fileURLToPath(import.meta.url));
const LOKALES_MAIN = join(HIER, '..', 'main.js');

const fehler = [];
const hinweise = [];
const ok = (text) => console.log(`✓ ${text}`);
const warnung = (text) => {
  hinweise.push(text);
  console.log(`! ${text}`);
};
const schlecht = (text) => {
  fehler.push(text);
  console.log(`✗ ${text}`);
};

const kopfzeilen = {
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'jarvis-ai-installationspruefung',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

/** Anfrage mit Wiederholungen (Netzwerkschwankungen abfangen). */
async function hole(url, versuche = 4) {
  let letzterFehler = '';
  for (let i = 1; i <= versuche; i++) {
    try {
      const antwort = await fetch(url, { headers: kopfzeilen });
      if (antwort.status === 403 || antwort.status === 429) {
        letzterFehler = `HTTP ${antwort.status} (Anfragegrenze? GITHUB_TOKEN setzen)`;
      } else if (antwort.ok) {
        return { ok: true, status: antwort.status, text: async () => antwort.text() };
      } else {
        letzterFehler = `HTTP ${antwort.status}`;
      }
    } catch (problem) {
      letzterFehler = problem.message;
    }
    if (i < versuche) await new Promise((weiter) => setTimeout(weiter, 1000 * i));
  }
  return { ok: false, status: 0, grund: letzterFehler };
}

/** Dateiinhalt: erst wie BRAT über die Release-Datei, sonst über die GitHub-Schnittstelle. */
async function holeDatei(release, name, tag) {
  const asset = release.assets?.find((eintrag) => eintrag.name === name);
  if (asset) {
    const antwort = await hole(asset.browser_download_url, 3);
    if (antwort.ok) return { text: await antwort.text(), quelle: 'Release-Datei (wie BRAT)' };
    warnung(`Die Release-Datei ${name} war aus dieser Umgebung nicht ladbar (${antwort.grund}) — Inhalt wird über die GitHub-Schnittstelle geprüft.`);
  } else {
    fehler.push(`Die Release-Datei "${name}" fehlt — BRAT würde damit scheitern.`);
    return null;
  }
  // Datei kann im Wurzelverzeichnis des Repositorys liegen oder in einem Unterordner
  for (const pfad of [name, `obsidian-jarvis/${name}`]) {
    const ueberApi = await hole(
      `https://api.github.com/repos/${repo}/contents/${pfad}?ref=${encodeURIComponent(tag)}`,
      2,
    );
    if (!ueberApi.ok) continue;
    const daten = JSON.parse(await ueberApi.text());
    if (!daten.content) continue;
    return {
      text: Buffer.from(daten.content, 'base64').toString('utf8'),
      quelle: `GitHub-Schnittstelle (${pfad})`,
    };
  }
  warnung(`Inhalt von ${name} nicht ladbar.`);
  return null;
}

/**
 * Lädt das Bündel so, wie Obsidian es lädt: mit einer Attrappe für das
 * obsidian-Paket. Damit ist bewiesen, dass die veröffentlichte main.js
 * wirklich ausführbar ist und eine Plugin-Klasse mit onload/onunload liefert
 * — unabhängig davon, wie der Bündler die Namen verkürzt hat.
 */
function pruefeLaedt(mainJs) {
  const ordner = mkdtempSync(join(tmpdir(), 'jarvis-pruefung-'));
  const datei = join(ordner, 'main.cjs');
  writeFileSync(datei, mainJs);
  class PluginAttrappe {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
  }
  const gemerkt = new Map();
  const attrappe = new Proxy(function () {}, {
    get: (_ziel, name) => {
      if (typeof name === 'symbol') return undefined;
      if (name === 'Plugin') return PluginAttrappe;
      if (!gemerkt.has(name)) {
        const klasse = class {
          constructor(...werte) {
            this.__werte = werte;
          }
        };
        Object.defineProperty(klasse, 'name', { value: `Attrappe_${String(name)}` });
        gemerkt.set(name, klasse);
      }
      return gemerkt.get(name);
    },
  });
  const originaleAnfrage = Module.prototype.require;
  Module.prototype.require = function (id, ...rest) {
    if (id === 'obsidian') return attrappe;
    return originaleAnfrage.call(this, id, ...rest);
  };
  try {
    const laden = createRequire(import.meta.url);
    delete laden.cache?.[laden.resolve(datei)];
    const geladen = laden(datei);
    const klasse = geladen?.default ?? geladen;
    if (typeof klasse !== 'function') return { ok: false, grund: 'kein Export einer Klasse gefunden' };
    if (typeof klasse.prototype?.onload !== 'function') return { ok: false, grund: 'die Klasse hat keine onload-Methode' };
    if (typeof klasse.prototype?.onunload !== 'function') return { ok: false, grund: 'die Klasse hat keine onunload-Methode' };
    if (!(klasse.prototype instanceof PluginAttrappe)) {
      return { ok: false, grund: 'die Klasse erbt nicht von Plugin' };
    }
    return { ok: true, name: klasse.name, methoden: Object.getOwnPropertyNames(klasse.prototype).length };
  } catch (problem) {
    return { ok: false, grund: `Laden wirft einen Fehler: ${problem.message}` };
  } finally {
    Module.prototype.require = originaleAnfrage;
    rmSync(ordner, { recursive: true, force: true });
  }
}

/** Wie BRAT: Tag in eine Versionsnummer übersetzen (auch "obsidian-jarvis-2.0.0"). */
function coerce(text) {
  const treffer = String(text).match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!treffer) return null;
  return { major: +treffer[1], minor: +treffer[2], patch: +treffer[3], pre: treffer[4] ?? '' };
}
function vergleiche(a, b) {
  for (const teil of ['major', 'minor', 'patch']) if (a[teil] !== b[teil]) return a[teil] - b[teil];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

console.log(`Prüfe BRAT-Installation von ${repo}${erwartetesTag ? ` (Tag ${erwartetesTag})` : ''}\n`);

// 1. Release bestimmen
let release;
if (erwartetesTag) {
  const antwort = await hole(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(erwartetesTag)}`);
  if (!antwort.ok) {
    schlecht(`Release ${erwartetesTag} nicht abrufbar (${antwort.grund ?? `HTTP ${antwort.status}`})`);
    process.exit(1);
  }
  release = JSON.parse(await antwort.text());
  ok(`Release ${release.tag_name} gefunden`);
} else {
  const antwort = await hole(`https://api.github.com/repos/${repo}/releases`);
  if (!antwort.ok) {
    schlecht(`Releases nicht abrufbar (${antwort.grund ?? `HTTP ${antwort.status}`})`);
    process.exit(1);
  }
  const releases = JSON.parse(await antwort.text());
  if (!Array.isArray(releases) || releases.length === 0) {
    schlecht('Keine Releases vorhanden — BRAT kann nichts installieren');
    process.exit(1);
  }
  release = [...releases]
    .filter((eintrag) => coerce(eintrag.tag_name))
    .sort((a, b) => vergleiche(coerce(b.tag_name), coerce(a.tag_name)))[0];
  ok(`${releases.length} Release(s) gefunden, neueste Version: ${release.tag_name}`);
  if (release.draft) schlecht('Das neueste Release ist ein Entwurf (BRAT sieht nur veröffentlichte Versionen)');
  if (release.prerelease) warnung('Das neueste Release ist als Vorabversion markiert — BRAT nimmt es nur mit ausdrücklicher Freigabe an.');
}

// 2. Release-Dateien (genau die, die BRAT in den Plugin-Ordner kopiert)
for (const name of ['main.js', 'manifest.json']) {
  const asset = release.assets?.find((eintrag) => eintrag.name === name);
  if (!asset) schlecht(`Release-Datei "${name}" fehlt`);
  else if (asset.size < 100) schlecht(`Release-Datei "${name}" ist verdächtig klein (${asset.size} Bytes)`);
  else ok(`Release-Datei "${name}" vorhanden (${(asset.size / 1024).toFixed(1)} KB)`);
}
const styles = release.assets?.find((eintrag) => eintrag.name === 'styles.css');
if (!styles) warnung('styles.css fehlt — BRAT installiert trotzdem, es fehlt nur das Aussehen');
else ok(`Release-Datei "styles.css" vorhanden (${(styles.size / 1024).toFixed(1)} KB)`);

// 3. manifest.json prüfen
const manifestDatei = await holeDatei(release, 'manifest.json', release.tag_name);
let manifest = null;
if (!manifestDatei) {
  schlecht('manifest.json nicht prüfbar');
} else {
  try {
    manifest = JSON.parse(manifestDatei.text);
  } catch (problem) {
    schlecht(`manifest.json ist kein gültiges JSON: ${problem.message}`);
  }
  if (manifest) {
    ok(`manifest.json geladen (${manifestDatei.quelle}): ${manifest.id} ${manifest.version}`);
    for (const feld of ['id', 'name', 'version', 'minAppVersion']) {
      if (!manifest[feld]) schlecht(`manifest.json fehlt das Pflichtfeld "${feld}"`);
    }
    if (manifest.isDesktopOnly === true) {
      warnung('manifest.json meldet isDesktopOnly — auf dem Tablet/Handy verweigert BRAT die Installation (hier ist es nicht gesetzt).');
    }
    const tagVersion = coerce(release.tag_name);
    const manifestVersion = coerce(manifest.version);
    if (erwartetesTag && release.tag_name !== erwartetesTag) {
      schlecht(`Erwartet war ${erwartetesTag}, gefunden ${release.tag_name}`);
    }
    if (!tagVersion || !manifestVersion) {
      schlecht(`Version nicht lesbar (Tag "${release.tag_name}", Manifest "${manifest.version}")`);
    } else if (vergleiche(tagVersion, manifestVersion) !== 0) {
      schlecht(`Tag ${release.tag_name} passt nicht zu manifest.json ${manifest.version} — BRAT lehnt ab`);
    } else {
      ok(`Tag-Version ${release.tag_name} passt zu manifest.json ${manifest.version}`);
    }
  }
}

// 4. main.js prüfen
const mainDatei = await holeDatei(release, 'main.js', release.tag_name);
if (!mainDatei) {
  schlecht('main.js nicht prüfbar');
} else {
  const mainJs = mainDatei.text;
  ok(`main.js geladen (${mainDatei.quelle}, ${(mainJs.length / 1024).toFixed(1)} KB)`);
  if (mainJs.length < 20_000) schlecht('main.js ist zu klein für das echte Bündel');
  if (!/require\(["']obsidian["']\)/.test(mainJs)) {
    warnung('Im Bündel steht kein require("obsidian") — bei esbuild-Bündeln mit externem obsidian normal.');
  }
  // Der wichtigste Test: das veröffentlichte Bündel wirklich laden (wie Obsidian es tut)
  const ladepruefung = pruefeLaedt(mainJs);
  if (ladepruefung.ok) {
    ok(`main.js lässt sich laden und exportiert eine Plugin-Klasse (${ladepruefung.methoden} Methoden, Name "${ladepruefung.name}")`);
  } else {
    schlecht(`main.js ist nicht lauffähig: ${ladepruefung.grund}`);
  }
  for (const merkmal of ['GELERNTES WISSEN', 'jarvis-brain-']) {
    if (mainJs.includes(merkmal)) ok(`main.js enthält das Merkmal "${merkmal}"`);
    else warnung(`Merkmal "${merkmal}" nicht gefunden — passt nicht zur erwarteten Version 2.0.0.`);
  }
  try {
    const lokal = readFileSync(LOKALES_MAIN);
    const gleich = createHash('sha256').update(lokal).digest('hex') === createHash('sha256').update(mainJs).digest('hex');
    if (gleich) ok('Die veröffentlichte main.js ist byte-identisch mit dem hier gebauten Bündel (SHA-256)');
    else warnung('Die veröffentlichte main.js unterscheidet sich von der hier liegenden — wurde nach dem Tag neu gebaut?');
  } catch {
    /* kein lokales main.js vorhanden — kein Fehler */
  }
}

// 5. Ergebnis
console.log('');
if (fehler.length === 0) {
  console.log(`Ergebnis: BRAT kann "${repo}" installieren (Version ${release.tag_name}).`);
  if (hinweise.length > 0) console.log(`(${hinweise.length} Hinweis(e) oben)`);
  process.exit(0);
}
console.log(`Ergebnis: ${fehler.length} Fehler:`);
for (const text of fehler) console.log(` - ${text}`);
if (streng) process.exit(1);
const nurNetzwerk = fehler.every((text) => text.includes('ladbar') || text.includes('nicht prüfbar'));
process.exit(nurNetzwerk ? 3 : 1);
