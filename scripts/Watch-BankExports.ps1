<#
.SYNOPSIS
    Überwacht einen Ordner (z. B. Downloads) auf neue Bank-Exporte und schickt sie an die Finanzen-App.

.DESCRIPTION
    Sobald deine Banking-App einen CSV-Export ablegt, wird die Datei an
    http://localhost:8765/api/import gesendet. Doppelte Buchungen erkennt die App selbst,
    überlappende Exporte sind also kein Problem.

    Ist die App gerade nicht erreichbar, wird die Datei stattdessen in den Inbox-Ordner
    der App kopiert – beim nächsten Start wird sie automatisch importiert.

    Das Skript fragt den Ordner in einem Intervall ab (robuster als reine Dateisystem-Events,
    funktioniert auch mit OneDrive- und Netzlaufwerken) und merkt sich bereits verarbeitete
    Dateien in einer kleinen Statusdatei.

.PARAMETER Folder
    Zu überwachender Ordner. Standard: dein Downloads-Ordner.

.PARAMETER Pattern
    Regulärer Ausdruck für Dateinamen, die als Bank-Export gelten.
    Standard passt auf typische Namen wie "Umsatzliste_*.csv" (DKB), "Umsatzanzeige_*.csv" (ING),
    "*-umsatz.CSV" (Sparkasse), "*Kontoauszug*.csv",
    "n26-csv-transactions*.csv", "account-statement_*.csv" – anpassen, falls deine Bank anders benennt.
    Mit -Pattern '\.csv$' wird jede CSV-Datei importiert.

.PARAMETER AfterImport
    Was mit der Datei nach erfolgreichem Import passiert: Keep (liegen lassen), Move (in Unterordner
    "importiert" verschieben) oder Delete. Standard: Move.

.PARAMETER Once
    Nur einmal prüfen und dann beenden (z. B. für die Aufgabenplanung).

.EXAMPLE
    .\scripts\Watch-BankExports.ps1
.EXAMPLE
    .\scripts\Watch-BankExports.ps1 -Folder "D:\Bank" -Pattern '\.csv$' -AfterImport Keep
#>
[CmdletBinding()]
param(
    [string]$Folder = (Join-Path $HOME 'Downloads'),
    [string]$Pattern = '(?i)(umsatz|umsa(e|ä)tze|kontoauszug|transactions|account-statement|dkb|sparkasse|comdirect|n26|revolut|girokonto|konto).*\.(csv|txt)$',
    [string]$Url = 'http://localhost:8765',
    [ValidateSet('Keep', 'Move', 'Delete')]
    [string]$AfterImport = 'Move',
    [int]$IntervalSeconds = 15,
    [string]$Inbox = (Join-Path (Split-Path $PSScriptRoot -Parent) 'inbox'),
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $env:LOCALAPPDATA 'Finanzen\watch-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path $stateFile) | Out-Null

function Write-Log([string]$Message, [string]$Color = 'Gray') {
    Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message) -ForegroundColor $Color
}

function Get-State {
    if (Test-Path $stateFile) {
        try { return (Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop) } catch { }
        # Windows PowerShell 5.1 kennt -AsHashtable nicht
        $h = @{}
        try { (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value } } catch { }
        return $h
    }
    return @{}
}

function Save-State($state) {
    $state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
}

function Test-FileReady([IO.FileInfo]$File) {
    # Datei noch im Download? Dann ist sie gesperrt oder wächst noch.
    try {
        $size = $File.Length
        Start-Sleep -Milliseconds 700
        $File.Refresh()
        if ($File.Length -ne $size -or $File.Length -eq 0) { return $false }
        $stream = [IO.File]::Open($File.FullName, 'Open', 'Read', 'None')
        $stream.Close()
        return $true
    } catch { return $false }
}

function Send-Export([IO.FileInfo]$File) {
    $headers = @{
        'X-Finanzen' = '1'
        'X-Filename' = [uri]::EscapeDataString($File.Name)
    }
    try {
        $r = Invoke-RestMethod -Uri "$Url/api/import" -Method Post -InFile $File.FullName `
            -ContentType 'text/csv' -Headers $headers -TimeoutSec 60
        Write-Log ("{0}: {1} neue Buchungen, {2} bereits vorhanden ({3} – {4})" -f `
                $File.Name, $r.rows_new, $r.rows_duplicate, $r.date_from, $r.date_to) 'Green'
        return 'ok'
    } catch {
        $response = $_.Exception.Response
        if ($null -ne $response -and [int]$response.StatusCode -eq 400) {
            # Datei ist kein erkennbarer Kontoauszug -> nicht erneut versuchen
            $detail = $_.ErrorDetails.Message
            try { $detail = ($detail | ConvertFrom-Json).error } catch { }
            Write-Log ("{0}: nicht importierbar – {1}" -f $File.Name, $detail) 'Yellow'
            return 'rejected'
        }
        # Server nicht erreichbar -> in die Inbox legen, die App holt sie sich beim Start
        New-Item -ItemType Directory -Force -Path $Inbox | Out-Null
        Copy-Item $File.FullName (Join-Path $Inbox $File.Name) -Force
        Write-Log ("{0}: App nicht erreichbar, Datei in Inbox kopiert ({1})" -f $File.Name, $Inbox) 'Yellow'
        return 'queued'
    }
}

function Invoke-Scan {
    $state = Get-State
    $changed = $false
    $files = Get-ChildItem -Path $Folder -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Pattern }
    foreach ($file in $files) {
        $key = "{0}|{1}|{2}" -f $file.FullName, $file.Length, $file.LastWriteTimeUtc.Ticks
        if ($state.Contains($key)) { continue }
        if (-not (Test-FileReady $file)) { continue }
        $result = Send-Export $file
        $state[$key] = "{0:s} {1}" -f (Get-Date), $result
        $changed = $true
        if ($result -eq 'ok' -or $result -eq 'queued') {
            switch ($AfterImport) {
                'Move' {
                    $target = Join-Path $Folder 'importiert'
                    New-Item -ItemType Directory -Force -Path $target | Out-Null
                    Move-Item $file.FullName (Join-Path $target ("{0:yyyyMMdd-HHmmss}_{1}" -f (Get-Date), $file.Name)) -Force
                }
                'Delete' { Remove-Item $file.FullName -Force }
            }
        }
    }
    if ($changed) { Save-State $state }
}

Write-Log "Überwache '$Folder' (Muster: $Pattern) -> $Url" 'Cyan'
if ($Once) { Invoke-Scan; return }
while ($true) {
    try { Invoke-Scan } catch { Write-Log "Fehler: $($_.Exception.Message)" 'Red' }
    Start-Sleep -Seconds $IntervalSeconds
}
