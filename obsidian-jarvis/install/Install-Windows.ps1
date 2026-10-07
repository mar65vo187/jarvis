<#
    Jarvis AI fuer Obsidian - Installationshelfer (Windows)

    Kopiert main.js, manifest.json und styles.css in den Plugin-Ordner eines
    Obsidian-Vaults. Vorhandene Dateien werden vorher gesichert.

    Alle eigenen Funktionen tragen den Praefix "Jarvis", damit es keine
    Namenskonflikte mit PowerShell-Bordmitteln gibt.
#>

[CmdletBinding()]
param(
    [string]$VaultPfad,
    [string]$Quellordner = (Split-Path -Parent $PSScriptRoot),
    [switch]$NurPruefen
)

$ErrorActionPreference = 'Stop'
$PluginId = 'jarvis-ai'
$BackupWurzel = Join-Path $env:LOCALAPPDATA "JarvisAI\Backups"

function Jarvis-Schreibe($Text, $Farbe = 'Gray') {
    Write-Host $Text -ForegroundColor $Farbe
}

function Jarvis-Titel {
    Clear-Host
    Jarvis-Schreibe '====================================================' 'Cyan'
    Jarvis-Schreibe '  Jarvis AI fuer Obsidian - Einrichtung' 'Cyan'
    Jarvis-Schreibe '====================================================' 'Cyan'
    Jarvis-Schreibe ''
}

function Jarvis-LeseObsidianVaults {
    # Obsidian merkt sich alle bekannten Vaults in obsidian.json
    $pfad = Join-Path $env:APPDATA 'obsidian\obsidian.json'
    if (-not (Test-Path $pfad)) { return @() }
    try {
        $json = Get-Content -Path $pfad -Raw -Encoding UTF8 | ConvertFrom-Json
        $liste = @()
        foreach ($eintrag in $json.vaults.PSObject.Properties) {
            $ordner = $eintrag.Value.path
            if ($ordner -and (Test-Path $ordner)) { $liste += $ordner }
        }
        return $liste
    } catch {
        return @()
    }
}

function Jarvis-WaehleVault {
    $bekannt = @(Jarvis-LeseObsidianVaults)
    if ($bekannt.Count -gt 0) {
        Jarvis-Schreibe 'Gefundene Obsidian-Vaults:' 'White'
        for ($i = 0; $i -lt $bekannt.Count; $i++) {
            Jarvis-Schreibe ("  [{0}] {1}" -f ($i + 1), $bekannt[$i])
        }
        Jarvis-Schreibe ('  [{0}] anderen Ordner angeben' -f ($bekannt.Count + 1))
        Jarvis-Schreibe ''
        $auswahl = Read-Host 'Nummer waehlen'
        $nummer = 0
        if ([int]::TryParse($auswahl, [ref]$nummer)) {
            if ($nummer -ge 1 -and $nummer -le $bekannt.Count) { return $bekannt[$nummer - 1] }
        }
    }
    $eingabe = Read-Host 'Pfad zu deinem Vault (Ordner mit .obsidian)'
    return $eingabe.Trim('"').Trim()
}

function Jarvis-PruefeVault($Pfad) {
    if (-not $Pfad) { throw 'Kein Vault-Pfad angegeben.' }
    if (-not (Test-Path $Pfad)) { throw "Ordner existiert nicht: $Pfad" }
    $obsidian = Join-Path $Pfad '.obsidian'
    if (-not (Test-Path $obsidian)) {
        Jarvis-Schreibe ''
        Jarvis-Schreibe "Hinweis: In '$Pfad' liegt noch kein Ordner .obsidian." 'Yellow'
        Jarvis-Schreibe 'Das ist normal, wenn der Vault noch nie geoeffnet wurde.' 'Yellow'
        $antwort = Read-Host 'Trotzdem dort installieren? (j/n)'
        if ($antwort -notmatch '^[jJyY]') { throw 'Abgebrochen.' }
        New-Item -ItemType Directory -Path $obsidian -Force | Out-Null
    }
    return $obsidian
}

function Jarvis-PruefeQuellen($Ordner) {
    $fehlend = @()
    foreach ($datei in @('main.js', 'manifest.json', 'styles.css')) {
        if (-not (Test-Path (Join-Path $Ordner $datei))) { $fehlend += $datei }
    }
    if ($fehlend.Count -gt 0) {
        throw ("Diese Dateien fehlen im Paketordner '{0}': {1}. Bitte die ZIP vollstaendig entpacken." -f $Ordner, ($fehlend -join ', '))
    }
}

function Jarvis-SichereAlteDateien($Ziel) {
    if (-not (Test-Path $Ziel)) { return $null }
    $vorhanden = Get-ChildItem -Path $Ziel -File -ErrorAction SilentlyContinue
    if (-not $vorhanden -or $vorhanden.Count -eq 0) { return $null }
    $stempel = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $backup = Join-Path $BackupWurzel $stempel
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($datei in $vorhanden) {
        Copy-Item -Path $datei.FullName -Destination (Join-Path $backup $datei.Name) -Force
    }
    return $backup
}

function Jarvis-Installiere($Quelle, $Ziel) {
    New-Item -ItemType Directory -Path $Ziel -Force | Out-Null
    foreach ($datei in @('main.js', 'manifest.json', 'styles.css')) {
        Copy-Item -Path (Join-Path $Quelle $datei) -Destination (Join-Path $Ziel $datei) -Force
    }
    # package.json wird bewusst NICHT kopiert.
}

function Jarvis-PruefeOllama {
    $befehl = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $befehl) {
        Jarvis-Schreibe 'Ollama ist nicht installiert.' 'Yellow'
        Jarvis-Schreibe 'Lokale Modelle brauchen Ollama: https://ollama.com/download/windows' 'Yellow'
        return $false
    }
    Jarvis-Schreibe 'Ollama gefunden.' 'Green'
    try {
        $antwort = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 -Method Get
        $namen = @($antwort.models | ForEach-Object { $_.name })
        if ($namen.Count -eq 0) {
            Jarvis-Schreibe 'Ollama laeuft, aber es ist kein Modell installiert.' 'Yellow'
            Jarvis-Schreibe 'Empfehlung:  ollama pull qwen3.6:27b   (stark, ~17 GB)' 'White'
            Jarvis-Schreibe 'Sparsam:     ollama pull qwen3:8b        (~5 GB)' 'White'
        } else {
            Jarvis-Schreibe ("Installierte Modelle: {0}" -f ($namen -join ', ')) 'Green'
            if (-not ($namen | Where-Object { $_ -like 'nomic-embed-text*' })) {
                Jarvis-Schreibe 'Tipp fuer bessere Suche: ollama pull nomic-embed-text' 'White'
            }
        }
        # CORS: Obsidian darf Ollama direkt anfragen
        $bereits = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
        if (-not $bereits) {
            [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'app://obsidian.md,http://localhost,http://127.0.0.1', 'User')
            Jarvis-Schreibe 'OLLAMA_ORIGINS gesetzt (Ollama einmal neu starten).' 'Green'
        }
        return $true
    } catch {
        Jarvis-Schreibe 'Ollama ist installiert, antwortet aber nicht. Bitte die Ollama-App starten.' 'Yellow'
        return $false
    }
}

Jarvis-Titel
Jarvis-Schreibe ("Paketordner: {0}" -f $Quellordner)
Jarvis-PruefeQuellen $Quellordner

if (-not $VaultPfad) { $VaultPfad = Jarvis-WaehleVault }
$obsidianOrdner = Jarvis-PruefeVault $VaultPfad
$ziel = Join-Path $obsidianOrdner "plugins\$PluginId"

Jarvis-Schreibe ''
Jarvis-Schreibe ("Ziel: {0}" -f $ziel) 'White'

if ($NurPruefen) {
    Jarvis-Schreibe 'Nur-Pruefen-Modus: es wurde nichts kopiert.' 'Yellow'
    exit 0
}

$backup = Jarvis-SichereAlteDateien $ziel
if ($backup) { Jarvis-Schreibe ("Alte Dateien gesichert nach: {0}" -f $backup) 'Green' }

Jarvis-Installiere $Quellordner $ziel
Jarvis-Schreibe 'Plugin-Dateien kopiert.' 'Green'

Jarvis-Schreibe ''
Jarvis-PruefeOllama | Out-Null

Jarvis-Schreibe ''
Jarvis-Schreibe 'Fertig. Naechste Schritte in Obsidian:' 'Cyan'
Jarvis-Schreibe '  1. Obsidian neu starten (oder Strg+R).' 'White'
Jarvis-Schreibe '  2. Einstellungen -> Community-Plugins -> "Jarvis AI (lokal + Top-Cloud)" aktivieren.' 'White'
Jarvis-Schreibe '  3. Strg+P -> "Jarvis: Chat oeffnen".' 'White'
Jarvis-Schreibe '  4. In den Jarvis-Einstellungen: Modell waehlen, optional Cloud-Schluessel eintragen.' 'White'
Jarvis-Schreibe ''
Jarvis-Schreibe 'Weitere Hilfe: README.md im Paketordner.' 'Gray'
Read-Host 'Zum Schliessen Enter druecken'
