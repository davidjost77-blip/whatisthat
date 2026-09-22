<#
.SYNOPSIS
    Startet die Finanzen-App und öffnet das Dashboard im Browser.

.PARAMETER Port
    Port des lokalen Servers (Standard 8765).

.PARAMETER NoBrowser
    Browser nicht öffnen (z. B. beim Autostart im Hintergrund).
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Find-Python {
    foreach ($candidate in @('py', 'python', 'python3')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -eq $cmd) { continue }
        # Der Windows-Store-Platzhalter "python.exe" startet kein echtes Python
        $versionArgs = if ($candidate -eq 'py') { @('-3', '--version') } else { @('--version') }
        try {
            $version = & $cmd.Source @versionArgs 2>&1
            if ($LASTEXITCODE -eq 0 -and "$version" -match 'Python 3\.(\d+)' -and [int]$Matches[1] -ge 9) {
                return @{ Exe = $cmd.Source; Prefix = $(if ($candidate -eq 'py') { @('-3') } else { @() }) }
            }
        } catch { }
    }
    throw 'Python 3.9 oder neuer wurde nicht gefunden. Installation: winget install Python.Python.3.12'
}

$py = Find-Python
$arguments = $py.Prefix + @('-m', 'finanzen', '--port', $Port)
if (-not $NoBrowser) { $arguments += '--open' }

Write-Host "Starte Finanzen auf http://localhost:$Port/ (Beenden mit Strg+C)" -ForegroundColor Cyan
Push-Location $root
try {
    & $py.Exe @arguments
} finally {
    Pop-Location
}
