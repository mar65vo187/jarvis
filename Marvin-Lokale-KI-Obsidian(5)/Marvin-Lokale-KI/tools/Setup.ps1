param([ValidateSet('Install','Lite','Online','Diagnose')][string]$Mode='Install')
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$env:OLLAMA_HOST='127.0.0.1:11434'
$OllamaCommand=Get-Command ollama -ErrorAction SilentlyContinue
if(-not $OllamaCommand){
    $Candidate=Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if(Test-Path -LiteralPath $Candidate){$Ollama=$Candidate}
    else {Write-Host 'Ollama fehlt. Installiere es von https://ollama.com/download/windows und starte diese Datei erneut.';exit 1}
} else {$Ollama=$OllamaCommand.Source}
$StateDir=Join-Path $env:LOCALAPPDATA 'MarvinBrain'
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$Report=Join-Path $StateDir 'letzte-diagnose.txt'
$script:Lines=New-Object 'System.Collections.Generic.List[string]'
function Write-MarvinStatus([string]$Text){Write-Host $Text;$script:Lines.Add($Text);$script:Lines | Set-Content -LiteralPath $Report -Encoding UTF8}
function Invoke-MarvinOllamaApi([string]$Path,$Body=$null,[int]$Timeout=20){
    $Params=@{Uri=('http://127.0.0.1:11434'+$Path);TimeoutSec=$Timeout;MaximumRedirection=0}
    if($null -ne $Body){$Params.Method='Post';$Params.ContentType='application/json';$Params.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 12 -Compress))}
    Invoke-RestMethod @Params
}
function Invoke-MarvinOllamaCommand([string[]]$Arguments){
    & $Ollama @Arguments
    if($LASTEXITCODE -ne 0){throw ('Ollama meldet einen Fehler bei: '+$Arguments[0]+'. Details stehen direkt darueber.')}
}
function Start-MarvinOllamaServer {
    try {$null=Invoke-MarvinOllamaApi '/api/tags';return} catch {}
    Write-MarvinStatus 'Ollama ist nicht erreichbar. Ich starte den lokalen Ollama-Dienst.'
    Start-Process -FilePath $Ollama -ArgumentList 'serve' -WindowStyle Minimized | Out-Null
    for($i=0;$i -lt 30;$i++){
        Start-Sleep -Seconds 1
        try {$null=Invoke-MarvinOllamaApi '/api/tags';return} catch {}
    }
    throw 'Ollama antwortet nicht. Ollama aus dem Startmenue oeffnen und erneut versuchen. Kein Port wird nach aussen freigegeben.'
}
function Get-MarvinLocalModelInfo([string]$Name){
    $Info=Invoke-MarvinOllamaApi '/api/show' @{model=$Name}
    if($Info.remote_model -or $Info.remote_host -or -not $Info.model_info){throw ('Kein bestaetigtes lokales Modell: '+$Name)}
    return $Info
}
function Show-MarvinHardware {
    try {
        $System=Get-CimInstance Win32_ComputerSystem
        $Cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
        $Gpu=Get-CimInstance Win32_VideoController
        $OS=Get-CimInstance Win32_OperatingSystem
        Write-MarvinStatus ('CPU: '+$Cpu.Name)
        Write-MarvinStatus ('RAM gesamt: '+[math]::Round($System.TotalPhysicalMemory/1GB,1)+' GB; frei: '+[math]::Round($OS.FreePhysicalMemory/1MB,1)+' GB')
        Write-MarvinStatus ('Grafik: '+(($Gpu|ForEach-Object {$_.Name}) -join ', '))
        if($System.TotalPhysicalMemory -lt 10GB){Write-MarvinStatus 'Bei etwa 8 GB RAM: andere grosse Programme schliessen; bei Speicherproblemen das Lite-Profil vergleichen.'}
    } catch {Write-MarvinStatus 'Show-MarvinHardware konnte nicht vollstaendig ausgelesen werden. Einrichtung ist trotzdem moeglich.'}
}
try {
    Write-MarvinStatus ('Marvin Brain 2.0.1 - '+$Mode+' - '+(Get-Date -Format s))
    Show-MarvinHardware
    if($Mode -eq 'Online'){
        Write-MarvinStatus 'OPTIONAL: Cloud-Anmeldung. Lokal funktioniert auch ohne diesen Schritt.'
        Write-MarvinStatus 'Nur ein kostenloses Konto ohne bezahltes Guthaben/Abo verwenden, wenn keine Kosten entstehen sollen.'
        Write-MarvinStatus 'Gratis-Modell und Restkontingent vorher unter https://ollama.com/settings und https://ollama.com/pricing pruefen.'
        Write-MarvinStatus 'Der Helfer kann deinen Tarif nicht pruefen. Er kauft nichts und sendet keine Obsidian-Notizen.'
        if((Read-Host 'Online-Anmeldung vorbereiten? J/N') -notmatch '^[Jj]$'){exit 0}
        $UserFlag=[Environment]::GetEnvironmentVariable('OLLAMA_NO_CLOUD','User')
        $MachineFlag=[Environment]::GetEnvironmentVariable('OLLAMA_NO_CLOUD','Machine')
        if($MachineFlag -eq '1'){throw 'Ollama Cloud ist systemweit deaktiviert. Mit dem Verantwortlichen klaeren; der Helfer aendert keine Systemrichtlinien.'}
        if($UserFlag -eq '1'){
            if((Read-Host 'Deine Benutzer-Einstellung OLLAMA_NO_CLOUD=1 entfernen? Betrifft auch andere Ollama-Apps. J/N') -notmatch '^[Jj]$'){exit 0}
            [Environment]::SetEnvironmentVariable('OLLAMA_NO_CLOUD',$null,'User')
            Remove-Item Env:OLLAMA_NO_CLOUD -ErrorAction SilentlyContinue
            Write-MarvinStatus 'Ollama jetzt in der Taskleiste vollstaendig beenden und neu starten. Falls ein serve-Fenster offen ist, dieses beenden.'
            $null=Read-Host 'Nach dem Neustart Enter druecken'
        }
        Start-MarvinOllamaServer
        Invoke-MarvinOllamaCommand -Arguments @('signin')
        $Tag=(Read-Host 'Exakten CLI-Modellnamen eines fuer DEIN Gratis-Konto verfuegbaren Cloud-Modells eingeben (muss auf :cloud enden)').Trim()
        if($Tag -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9._:-]*cloud$'){throw 'Kein gueltiger Cloud-Modellname. Keine Registrierung durchgefuehrt.'}
        Invoke-MarvinOllamaCommand -Arguments @('pull',$Tag)
        $Info=Invoke-MarvinOllamaApi '/api/show' @{model=$Tag}
        if(-not $Info.remote_model -or $Info.remote_host -notmatch '^https://ollama\.com/?$'){throw 'Ollama-Cloud-Zuordnung konnte nicht bestaetigt werden. Modell nicht im Plugin verwenden.'}
        Write-MarvinStatus 'Cloud-Modell registriert. Noch keine Modellantwort oder Wissensfrage gesendet.'
        Write-MarvinStatus 'In Obsidian Online waehlen, Ollama pruefen, Modell waehlen. Jede Frage hat eine Inhaltsvorschau.'
        exit 0
    }
    Start-MarvinOllamaServer
    if($Mode -eq 'Diagnose'){
        $Models=Invoke-MarvinOllamaApi '/api/tags'
        Write-MarvinStatus ('Vorhandene Modelle: '+(($Models.models|ForEach-Object {$_.name}) -join ', '))
        $Running=Invoke-MarvinOllamaApi '/api/ps'
        foreach($M in $Running.models){Write-MarvinStatus ('Geladen: '+$M.name+'; Speicher '+[math]::Round($M.size/1GB,2)+' GiB; GPU-Anteil '+[math]::Round($M.size_vram/1GB,2)+' GiB')}
        Write-MarvinStatus ('Diagnose gespeichert: '+$Report)
        exit 0
    }
    $Vault=$null
    if($Mode -eq 'Install'){
        if(Get-Process Obsidian -ErrorAction SilentlyContinue){throw 'Bitte Obsidian zuerst schliessen, dann 01-EINRICHTEN.cmd erneut starten.'}
        Add-Type -AssemblyName System.Windows.Forms
        $Dialog=New-Object System.Windows.Forms.FolderBrowserDialog
        $Dialog.Description='Deinen NOTIZORDNER waehlen, nicht den heruntergeladenen Marvin-Lokale-KI-Ordner. Dort liegen deine bisherigen Notizen.'
        $KnownVaults=@()
        try {
            $ConfigFile=Join-Path $env:APPDATA 'obsidian\obsidian.json'
            if(Test-Path -LiteralPath $ConfigFile){
                $Config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
                $KnownVaults=@($Config.vaults.PSObject.Properties | ForEach-Object {$_.Value.path} | Where-Object {$_ -and (Test-Path -LiteralPath (Join-Path $_ '.obsidian') -PathType Container)})
            }
        } catch {Write-MarvinStatus 'Gespeicherte Vault-Liste nicht lesbar. Bitte Notizordner selbst auswaehlen.'}
        $PackageParent=Split-Path -Parent $Root
        $KnownVaults=@($KnownVaults | Where-Object {([IO.Path]::GetFullPath($_).TrimEnd('\') -ne [IO.Path]::GetFullPath($Root).TrimEnd('\')) -and ([IO.Path]::GetFullPath($_).TrimEnd('\') -ne [IO.Path]::GetFullPath($PackageParent).TrimEnd('\'))} | Select-Object -Unique)
        if($KnownVaults.Count -gt 0){
            Write-MarvinStatus 'In Obsidian registrierte Notizordner:'
            foreach($KnownVault in $KnownVaults){Write-MarvinStatus ('  '+$KnownVault)}
            $Dialog.SelectedPath=$KnownVaults[0]
        }
        $Dialog.ShowNewFolderButton=$false
        if($Dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){Write-MarvinStatus 'Abgebrochen. Keine Plugin-Dateien geaendert.';exit 0}
        $Vault=$Dialog.SelectedPath
        $Dialog.Dispose()
        $SelectedPath=[IO.Path]::GetFullPath($Vault).TrimEnd('\')
        if(($SelectedPath -eq [IO.Path]::GetFullPath($Root).TrimEnd('\')) -or ($SelectedPath -eq [IO.Path]::GetFullPath($PackageParent).TrimEnd('\'))){throw 'Das ist der entpackte Einrichtungsordner. Waehle den Vault mit deinen bisherigen Notizen. In Obsidian: Rechtsklick auf eine bekannte Notiz > Im System-Explorer anzeigen. Anleitung siehe ZUERST-LESEN.txt.'}
        if(-not(Test-Path -LiteralPath (Join-Path $Vault '.obsidian') -PathType Container)){throw 'Hier fehlt .obsidian. Bitte den bestehenden Vault waehlen. Bei eigenem Konfigurationsordner manuell installieren, siehe Anleitung.'}
        Write-MarvinStatus ('Gewaehlter Vault: '+$Vault)
    }
    if($Mode -eq 'Lite'){$Base='qwen3:1.7b';$Name='marvin-brain:lite-v2';$ModelFile='Modelfile-lite'}
    else {$Base='qwen3:4b-instruct';$Name='marvin-brain:4b-v2';$ModelFile='Modelfile'}
    $Models=Invoke-MarvinOllamaApi '/api/tags'
    if(-not($Models.models|Where-Object {$_.name -eq $Base})){
        Write-MarvinStatus ('Lade Basismodell '+$Base+'. Der Download benoetigt Internet und freien Speicher.')
        Invoke-MarvinOllamaCommand -Arguments @('pull',$Base)
    } else {Write-MarvinStatus ('Vorhandenes Basismodell wird verwendet: '+$Base)}
    $null=Get-MarvinLocalModelInfo $Base
    if($Models.models|Where-Object {$_.name -eq $Name}){
        $null=Get-MarvinLocalModelInfo $Name
        Write-MarvinStatus ('Profil '+$Name+' existiert bereits und bleibt unveraendert.')
    } else {
        Write-MarvinStatus ('Erstelle dein Ollama-Profil '+$Name+'. Kein Neutraining.')
        Invoke-MarvinOllamaCommand -Arguments @('create',$Name,'-f',(Join-Path $Root ('Modelle\'+$ModelFile)))
        $null=Get-MarvinLocalModelInfo $Name
    }
    if($Mode -eq 'Install'){
        if(Get-Process Obsidian -ErrorAction SilentlyContinue){throw 'Obsidian wurde wieder geoeffnet. Bitte schliessen und Einrichtung erneut starten; Modellprofil ist bereits angelegt.'}
        $Target=Join-Path $Vault '.obsidian\plugins\marvin-local-brain'
        $Source=Join-Path $Root 'IN-DEINEN-VAULT-KOPIEREN\.obsidian\plugins\marvin-local-brain'
        $Backup=Join-Path $StateDir ('Backups\'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $Backup -Force | Out-Null
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        $Files=@('main.js','manifest.json','styles.css')
        foreach($F in $Files){
            if(-not(Test-Path -LiteralPath (Join-Path $Source $F))){throw ('Paket unvollstaendig: '+$F+'. ZIP komplett entpacken.')}
            if(Test-Path -LiteralPath (Join-Path $Target $F)){Copy-Item -LiteralPath (Join-Path $Target $F) -Destination (Join-Path $Backup $F)}
        }
        try {
            foreach($F in $Files){
                Copy-Item -LiteralPath (Join-Path $Source $F) -Destination (Join-Path $Target $F) -Force
                if((Get-FileHash -LiteralPath (Join-Path $Source $F)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Target $F)).Hash){throw ('Dateipruefung fehlgeschlagen: '+$F)}
            }
        } catch {
            foreach($F in $Files){if(Test-Path -LiteralPath (Join-Path $Backup $F)){Copy-Item -LiteralPath (Join-Path $Backup $F) -Destination (Join-Path $Target $F) -Force}}
            throw
        }
        Write-MarvinStatus 'Plugin-Dateien installiert und verglichen. Notizen und vorhandene data.json bleiben erhalten.'
        Write-MarvinStatus ('Sicherung vorheriger Plugin-Dateien: '+$Backup)
    }
    Write-MarvinStatus 'Pruefe jetzt eine kurze echte Modellantwort. Das erste Laden kann mehrere Minuten dauern.'
    try {
        $Result=Invoke-MarvinOllamaApi '/api/chat' @{model=$Name;messages=@(@{role='user';content='Antworte mit genau einem kurzen deutschen Begruessungssatz.'});stream=$false;think=$false;keep_alive='10m';options=@{num_ctx=4096;num_predict=80;temperature=0.2}} 300
        if(-not $Result.done -or [string]::IsNullOrWhiteSpace($Result.message.content)){throw 'Keine vollstaendige Textantwort erhalten.'}
        Write-MarvinStatus ('Modellantwort: '+$Result.message.content)
        Write-MarvinStatus ('Ladezeit: '+[math]::Round($Result.load_duration/1e9,2)+' s; Ausgabezeit: '+[math]::Round($Result.eval_duration/1e9,2)+' s')
        if($Result.eval_duration -gt 0){Write-MarvinStatus ('Ausgaberate: '+[math]::Round($Result.eval_count*1e9/$Result.eval_duration,1)+' Token/s')}
    } catch {
        Write-MarvinStatus ('Modellprofil angelegt, aber Antworttest NICHT erfolgreich: '+$_.Exception.Message)
        Write-MarvinStatus 'Andere grosse Apps schliessen. Optional 03-LITE-MODELL.cmd verwenden und in Obsidian marvin-brain:lite-v2 waehlen.'
        exit 2
    }
    Write-MarvinStatus ('BEREIT FUER DEN OBSIDIAN-TEST: '+$Name)
    Write-MarvinStatus 'Obsidian starten > Einstellungen > Externe Erweiterungen > Marvin Local Brain aktivieren.'
    Write-MarvinStatus ('Strg+P > Marvins KI oeffnen > Ollama pruefen > '+$Name+' auswaehlen.')
    Write-MarvinStatus ('Diagnose: '+$Report)
} catch {Write-MarvinStatus ('FEHLER: '+$_.Exception.Message);Write-MarvinStatus 'Keine vollstaendig erfolgreiche Einrichtung bestaetigt. Details siehe Anleitung.';exit 1}
