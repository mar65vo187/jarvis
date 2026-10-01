# J.A.R.V.I.S. LOCAL - Installation im Benutzerkonto (keine Administratorrechte noetig).
# Installiert/aktualisiert: Python (Benutzer), Ollama (Benutzer), lokales KI-Modell, Jarvis, Autostart, Icons.
# Mehrfach ausfuehrbar (= Update). Daten und Einstellungen bleiben erhalten.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Src    = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $env:LOCALAPPDATA "Jarvis"
$Tmp    = Join-Path $env:TEMP "jarvis-setup"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
function Say($t)  { Write-Host "  > $t" -ForegroundColor Cyan }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
}

Write-Host ""
Write-Host "   J . A . R . V . I . S .   LOCAL  -  Installation" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------ laufenden Jarvis stoppen (Update)
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*Jarvis.pyw*" -or $_.CommandLine -like "*Jarvis-Watchdog.pyw*" } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
# Alte Admin-Version (geplanter Task) entfernen, falls vorhanden - ohne Fehler, wenn es ihn nicht gibt.
try { schtasks.exe /Query /TN "JARVIS" 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { schtasks.exe /Delete /TN "JARVIS" /F 2>$null | Out-Null } } catch {}

# ------------------------------------------------------------------ Python
function Find-Python {
    $candidates = @(@("py", "-3.12"), @("py", "-3.13"), @("py", "-3.11"), @("py", "-3"), @("python"))
    foreach ($c in $candidates) {
        try {
            $pyArgs = @()
            if ($c.Count -gt 1) { $pyArgs += $c[1..($c.Count - 1)] }
            $pyArgs += @("-c", "import sys; print(sys.executable if (3,10) <= sys.version_info[:2] <= (3,13) else '')")
            $exe = & $c[0] @pyArgs 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        } catch {}
    }
    foreach ($v in @("312", "313", "311")) {
        $p = Join-Path $env:LOCALAPPDATA "Programs\Python\Python$v\python.exe"
        if (Test-Path $p) { return $p }
    }
    return $null
}

$Py = Find-Python
if (-not $Py) {
    Say "Installiere Python 3.12 fuer deinen Benutzer ..."
    $done = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
            winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host
            $done = $true
        } catch { Warn "winget fehlgeschlagen, lade Python direkt ..." }
    }
    Refresh-Path
    $Py = Find-Python
    if (-not $Py) {
        $inst = Join-Path $Tmp "python-3.12.10-amd64.exe"
        Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" -OutFile $inst
        Start-Process -FilePath $inst -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=0 Include_test=0" -Wait
        Refresh-Path
        $Py = Find-Python
    }
    if (-not $Py) { throw "Python konnte nicht installiert werden. Bitte Python 3.12 von python.org installieren und erneut starten." }
}
Say "Python: $Py"

# ------------------------------------------------------------------ Dateien kopieren
Say "Kopiere Jarvis nach $Target ..."
New-Item -ItemType Directory -Force -Path $Target | Out-Null
if ([IO.Path]::GetFullPath($Src) -ne [IO.Path]::GetFullPath($Target)) {
robocopy $Src $Target /E /XD data .venv __pycache__ .git .pytest_cache /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Kopieren mit robocopy fehlgeschlagen (Code $LASTEXITCODE)." }
}
New-Item -ItemType Directory -Force -Path (Join-Path $Target "data") | Out-Null

# ------------------------------------------------------------------ Python-Umgebung
$Venv = Join-Path $Target ".venv"
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
    Say "Erstelle Python-Umgebung ..."
    & $Py -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw "venv konnte nicht erstellt werden." }
}
$VPy = "$Venv\Scripts\python.exe"
Say "Installiere Python-Pakete (1-3 Minuten) ..."
& $VPy -m pip install --upgrade pip --quiet --disable-pip-version-check
& $VPy -m pip install -r "$Target\requirements-windows.txt" --quiet --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "Paketinstallation fehlgeschlagen (Internet pruefen und erneut starten)." }
$extras = Read-Host "  Optionale Pakete fuer lokale Spracheingabe, Excel und Word installieren? [j/N]"
if ($extras -match '^[jJyY]') {
    Say "Installiere Zusatzpakete (Sprache, Excel, Word) ..."
    & $VPy -m pip install -r "$Target\requirements-optional.txt" --quiet --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Warn "Zusatzpakete nicht vollstaendig installiert - Jarvis laeuft trotzdem." }
}
$Pyw = "$Venv\Scripts\pythonw.exe"

# ------------------------------------------------------------------ Betriebsart
$EnvFile = Join-Path $Target ".env"
$Existing = @{}
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $Existing[$Matches[1]] = $Matches[2].Trim().Trim('"') }
    }
}
$Provider = $Existing["JARVIS_PROVIDER"]
if (-not $Provider) {
    Write-Host ""
    $choice = Read-Host "  KI waehlen: xKiro Multi-Modell, Claude direkt oder lokale KI/Ollama? [X/c/l]"
    if ($choice -match '^[lL]') { $Provider = "ollama" }
    elseif ($choice -match '^[cC]') { $Provider = "claude" }
    else { $Provider = "xkiro" }
}
$CloudEnabled = if ($Existing.ContainsKey("JARVIS_CLOUD_ENABLED")) { $Existing["JARVIS_CLOUD_ENABLED"] -ne "0" } else { $true }
$HasXKiroKey = $Existing["XKIRO_API_KEY"] -or $env:XKIRO_API_KEY
$HasClaudeKey = $Existing["ANTHROPIC_API_KEY"] -or $env:ANTHROPIC_API_KEY -or $env:CLAUDE_API_KEY
$UseLocal = (-not $CloudEnabled) -or ($Provider -eq "ollama") -or ($Provider -eq "auto" -and -not $HasXKiroKey -and -not $HasClaudeKey)
$Model = if ($Existing["JARVIS_MODEL"] -and $Existing["JARVIS_MODEL"] -notmatch '^claude') { $Existing["JARVIS_MODEL"] } else { "qwen3:8b" }
$VisionSet = $Existing["JARVIS_VISION_MODEL"]
$Tune = [ordered]@{}
$RamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($UseLocal) {
# ------------------------------------------------------------------ Ollama
function Find-Ollama {
    $c = Get-Command ollama -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @((Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"), (Join-Path $env:ProgramFiles "Ollama\ollama.exe"))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}
$OllamaExe = Find-Ollama
if (-not $OllamaExe) {
    Say "Installiere Ollama (lokale KI-Engine) fuer deinen Benutzer ..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try { winget install -e --id Ollama.Ollama --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host } catch {}
    }
    Refresh-Path
    $OllamaExe = Find-Ollama
    if (-not $OllamaExe) {
        $inst = Join-Path $Tmp "OllamaSetup.exe"
        Invoke-WebRequest -UseBasicParsing -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $inst
        Start-Process -FilePath $inst -ArgumentList "/VERYSILENT /NORESTART /SUPPRESSMSGBOXES" -Wait
        Refresh-Path
        $OllamaExe = Find-Ollama
    }
}
if (-not $OllamaExe) { throw "Ollama wurde nicht gefunden. Bitte OllamaSetup.exe von ollama.com installieren und erneut starten." }
Say "Ollama: $OllamaExe"

# Ollama sparsam einstellen (wichtig bei wenig RAM): nur lokal erreichbar, 1 Modell, 1 Anfrage parallel,
# komprimierter Kontextspeicher. Gilt dauerhaft fuer deinen Benutzer.
$OllamaEnv = [ordered]@{
    "OLLAMA_HOST" = "127.0.0.1:11434"; "OLLAMA_FLASH_ATTENTION" = "1"; "OLLAMA_KV_CACHE_TYPE" = "q8_0";
    "OLLAMA_NUM_PARALLEL" = "1"; "OLLAMA_MAX_LOADED_MODELS" = "1"
}
$changed = $false
foreach ($k in $OllamaEnv.Keys) {
    if ([Environment]::GetEnvironmentVariable($k, "User") -ne $OllamaEnv[$k]) { $changed = $true }
    [Environment]::SetEnvironmentVariable($k, $OllamaEnv[$k], "User")
    Set-Item -Path "Env:$k" -Value $OllamaEnv[$k]
}
function Test-Ollama { try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null; return $true } catch { return $false } }
if ($changed -and (Test-Ollama)) {
    Say "Starte Ollama mit Spar-Einstellungen neu ..."
    foreach ($n in @("ollama app", "ollama")) {
        Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | Stop-Process -Force -ErrorAction Stop } catch {} }
    }
    Start-Sleep -Seconds 2
}
if (-not (Test-Ollama)) {
    Say "Starte Ollama ..."
    Start-Process -FilePath $OllamaExe -ArgumentList "serve" -WindowStyle Hidden
    for ($i = 0; $i -lt 30 -and -not (Test-Ollama); $i++) { Start-Sleep -Seconds 1 }
}
if (-not (Test-Ollama)) { throw "Ollama startet nicht. Bitte PC neu starten und Installation wiederholen." }

# ------------------------------------------------------------------ Modell nach Arbeitsspeicher waehlen
$RamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$Small = "qwen3:4b-instruct-2507-q4_K_M"
if ($RamGB -ge 15) {
    $Model = "qwen3:8b"; $Vision = "qwen3-vl:4b"; $OfferVision = $true
    $Tune = [ordered]@{ JARVIS_NUM_CTX = "16384"; JARVIS_MAX_TOKENS = "4096"; JARVIS_KEEP_ALIVE = "30m"; HISTORY_TURNS = "16"; JARVIS_TOOL_RESULT_MAX = "12000"; WHISPER_MODEL = "small" }
    if ($RamGB -ge 31) { $Vision = "qwen3-vl:8b" }
} elseif ($RamGB -ge 10) {
    $Model = $Small; $Vision = "qwen3-vl:4b"; $OfferVision = $true
    $Tune = [ordered]@{ JARVIS_NUM_CTX = "12288"; JARVIS_MAX_TOKENS = "2048"; JARVIS_KEEP_ALIVE = "15m"; HISTORY_TURNS = "10"; JARVIS_TOOL_RESULT_MAX = "8000"; WHISPER_MODEL = "small" }
} elseif ($RamGB -ge 5) {
    $Model = $Small; $Vision = ""; $OfferVision = $false
    $Tune = [ordered]@{ JARVIS_NUM_CTX = "10240"; JARVIS_MAX_TOKENS = "1500"; JARVIS_KEEP_ALIVE = "5m"; HISTORY_TURNS = "6"; JARVIS_TOOL_RESULT_MAX = "4000"; WHISPER_MODEL = "base" }
} else {
    $Model = "qwen3:1.7b"; $Vision = ""; $OfferVision = $false
    $Tune = [ordered]@{ JARVIS_NUM_CTX = "6144"; JARVIS_MAX_TOKENS = "1000"; JARVIS_KEEP_ALIVE = "5m"; HISTORY_TURNS = "4"; JARVIS_TOOL_RESULT_MAX = "3000"; WHISPER_MODEL = "base" }
}
Say "Arbeitsspeicher: $RamGB GB -> Hauptmodell $Model"
$Drive = (Get-Item $env:USERPROFILE).PSDrive.Name
$FreeGB = [math]::Round((Get-PSDrive -Name $Drive).Free / 1GB)
Say "Freier Speicherplatz auf ${Drive}: $FreeGB GB"
if ($FreeGB -lt 5) { throw "Zu wenig Speicherplatz auf ${Drive}: ($FreeGB GB frei, mindestens 5 GB noetig). Bitte Platz schaffen und erneut starten." }
if ($FreeGB -lt 10) { Warn "Wenig Speicherplatz ($FreeGB GB). Das Seh-Modell wird uebersprungen."; $OfferVision = $false }
if ($RamGB -lt 10) {
    Warn "Wenig Arbeitsspeicher: Jarvis laeuft im Sparmodus (kleines Modell, kein Bildschirm-Sehen)."
    Warn "Tipp: Beim Arbeiten mit Jarvis grosse Programme (viele Browser-Tabs, Spiele) schliessen."
}

# Bestehende Einstellung respektieren (ausser alte Cloud-Modelle aus frueheren Versionen)
$EnvFile = Join-Path $Target ".env"
$Existing = @{}
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $Existing[$Matches[1]] = $Matches[2].Trim().Trim('"') }
    }
    $old = $Existing["JARVIS_MODEL"]
    # Eigenes Wunschmodell behalten; unsere alten Standardmodelle und Cloud-Modelle durch das passende ersetzen
    $ours = @("qwen3:4b", "qwen3:8b", "qwen3:1.7b", $Small)
    if ($old -and ($ours -notcontains $old) -and ($old -notmatch '^(claude|gpt|o\d|anthropic|openai)')) { $Model = $old }
}

Say "Lade KI-Modell $Model (einmalig, mehrere GB - bitte warten) ..."
& $OllamaExe pull $Model
if ($LASTEXITCODE -ne 0) { throw "Modell $Model konnte nicht geladen werden (Internet/Speicherplatz pruefen)." }

$VisionSet = ""
if ($Existing.ContainsKey("JARVIS_VISION_MODEL")) { $VisionSet = $Existing["JARVIS_VISION_MODEL"] }
if (-not $OfferVision) { $VisionSet = "" }
if ((-not $VisionSet) -and $OfferVision) {
    Write-Host ""
    $ans = Read-Host "  Soll Jarvis deinen Bildschirm SEHEN koennen? Laedt zusaetzlich $Vision (ca. 3-6 GB). [J/n]"
    if ($ans -notmatch '^[nN]') {
        Say "Lade Seh-Modell $Vision ..."
        & $OllamaExe pull $Vision
        if ($LASTEXITCODE -eq 0) { $VisionSet = $Vision } else { Warn "Seh-Modell nicht geladen (evtl. Ollama aktualisieren). Jarvis laeuft ohne Sehen." }
    }
}


} else {
    Say "Cloud-KI-Modus: kein Ollama und kein lokaler Modelldownload erforderlich."
    if ($Provider -eq "xkiro") {
        Say "xKiro-API-Schluessel und Modell werden im Jarvis-Fenster eingerichtet."
    } elseif ($Provider -eq "claude") {
        Say "Anthropic-API-Schluessel wird im Jarvis-Fenster eingerichtet."
    } else {
        Say "xKiro/Claude-Zugang wird im Jarvis-Fenster eingerichtet."
    }
}

# ------------------------------------------------------------------ .env schreiben/ergaenzen
function Set-EnvValue([string]$Key, [string]$Value) {
    $lines = @()
    if (Test-Path $EnvFile) { $lines = @(Get-Content $EnvFile -Encoding UTF8) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$Key\s*=") { $lines[$i] = "$Key=$Value"; $found = $true }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    [IO.File]::WriteAllLines($EnvFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $Target ".env.example") $EnvFile }
Set-EnvValue "JARVIS_PROVIDER" $Provider
Set-EnvValue "JARVIS_CLOUD_ENABLED" $(if ($CloudEnabled) { "1" } else { "0" })
Set-EnvValue "JARVIS_MODEL" $Model
Set-EnvValue "JARVIS_VISION_MODEL" $VisionSet
Set-EnvValue "OLLAMA_BASE_URL" "http://127.0.0.1:11434"
foreach ($k in $Tune.Keys) {
    # Bei wenig RAM immer die sicheren Werte setzen, sonst nur fehlende ergaenzen
    if ($RamGB -lt 15 -or -not $Existing.ContainsKey($k) -or -not $Existing[$k]) { Set-EnvValue $k $Tune[$k] }
}

# ------------------------------------------------------------------ Autostart + Icons
Say "Richte Autostart (nur dein Benutzer) ein ..."
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
# Achtung: New-Item -Force auf einen bestehenden Schluessel wuerde ALLE anderen Autostart-Eintraege loeschen.
if (-not (Test-Path $RunKey)) { New-Item -Path $RunKey | Out-Null }
$RunValue = '"' + $Pyw + '" "' + (Join-Path $Target "Jarvis-Watchdog.pyw") + '"'
New-ItemProperty -Path $RunKey -Name "JARVIS" -Value $RunValue -PropertyType String -Force | Out-Null

Say "Erstelle Desktop- und Startmenue-Icon ..."
$Shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))) {
    $lnk = $Shell.CreateShortcut((Join-Path $dir "JARVIS.lnk"))
    $lnk.TargetPath = $Pyw
    $lnk.Arguments = '"' + (Join-Path $Target "Jarvis-Oeffnen.pyw") + '"'
    $lnk.WorkingDirectory = $Target
    $lnk.IconLocation = "$Target\windows\jarvis.ico"
    $lnk.Description = "J.A.R.V.I.S. LOCAL"
    $lnk.Save()
}

# ------------------------------------------------------------------ Selbsttest + Start
Say "Selbsttest ..."
Push-Location $Target
& $VPy -c "import jarvis.main, jarvis.web, jarvis.telegram_bot, jarvis.skills; print('OK')"
$ok = $LASTEXITCODE
Pop-Location
if ($ok -ne 0) { throw "Selbsttest fehlgeschlagen - Log oben pruefen." }

Say "Starte Jarvis ..."
Start-Process -FilePath $Pyw -ArgumentList ('"' + (Join-Path $Target "Jarvis-Oeffnen.pyw") + '"') -WorkingDirectory $Target

Write-Host ""
Write-Host "  FERTIG. Jarvis ($Provider) ist gestartet und startet ab jetzt mit Windows." -ForegroundColor Green
Write-Host "  Im Fenster: KI-Zugang speichern -> KI-VERBINDUNG TESTEN. Telegram ist optional."
Write-Host "  Oeffnen: Desktop-Icon JARVIS oder Strg+Alt+J."
Write-Host ""
