<#
.SYNOPSIS
    Richtet den Autostart ein: App-Server und Export-Watcher laufen nach jeder Anmeldung unsichtbar im Hintergrund.

.DESCRIPTION
    Legt in der Windows-Aufgabenplanung zwei Aufgaben für den aktuellen Benutzer an
    (keine Administratorrechte nötig):
      * "Finanzen – Server"   startet die App (http://localhost:8765/)
      * "Finanzen – Watcher"  überwacht den Download-Ordner auf neue Bank-Exporte

.PARAMETER Folder
    Ordner, in den deine Banking-App exportiert (Standard: Downloads).

.PARAMETER Pattern
    Optionaler Dateinamen-Filter für den Watcher (regulärer Ausdruck), siehe Watch-BankExports.ps1.

.PARAMETER Uninstall
    Entfernt beide Aufgaben wieder.

.EXAMPLE
    .\scripts\Install-AutoStart.ps1
.EXAMPLE
    .\scripts\Install-AutoStart.ps1 -Folder "$HOME\OneDrive\Bank"
.EXAMPLE
    .\scripts\Install-AutoStart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Folder = (Join-Path $HOME 'Downloads'),
    [string]$Pattern,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$serverTask = 'Finanzen - Server'
$watchTask = 'Finanzen - Watcher'

if ($Uninstall) {
    foreach ($name in @($serverTask, $watchTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "Aufgabe '$name' entfernt." -ForegroundColor Green
        }
    }
    return
}

# pythonw.exe läuft ohne Konsolenfenster
$pythonw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pythonw) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($python) { $pythonw = Join-Path (Split-Path $python) 'pythonw.exe' }
}
if (-not $pythonw -or -not (Test-Path $pythonw)) {
    throw 'pythonw.exe nicht gefunden. Bitte Python 3 installieren (winget install Python.Python.3.12).'
}
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell).Source }

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$serverAction = New-ScheduledTaskAction -Execute $pythonw -Argument '-m finanzen' -WorkingDirectory $root
Register-ScheduledTask -TaskName $serverTask -Action $serverAction -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Finanz-Dashboard auf http://localhost:8765/' -Force | Out-Null

$watchArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\Watch-BankExports.ps1`" -Folder `"$Folder`""
if ($Pattern) { $watchArgs += " -Pattern `"$Pattern`"" }
$watchAction = New-ScheduledTaskAction -Execute $shell -Argument $watchArgs -WorkingDirectory $root
Register-ScheduledTask -TaskName $watchTask -Action $watchAction -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Importiert neue Bank-Exporte aus $Folder" -Force | Out-Null

Start-ScheduledTask -TaskName $serverTask
Start-ScheduledTask -TaskName $watchTask
Write-Host "Autostart eingerichtet und gestartet." -ForegroundColor Green
Write-Host "  Dashboard:  http://localhost:8765/"
Write-Host "  Überwacht:  $Folder"
Write-Host "  Entfernen:  .\scripts\Install-AutoStart.ps1 -Uninstall"
