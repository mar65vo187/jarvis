$Target = Join-Path $env:LOCALAPPDATA "Jarvis"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $RunKey -Name "JARVIS" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like "*Jarvis.pyw*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "JARVIS.lnk") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\JARVIS.lnk") -ErrorAction SilentlyContinue
Write-Host "Jarvis gestoppt und Benutzer-Autostart entfernt." -ForegroundColor Green
Write-Host "Daten bleiben erhalten in: $Target"
