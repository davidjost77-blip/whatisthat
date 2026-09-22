@echo off
rem Doppelklick startet die Finanzen-App und oeffnet das Dashboard
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Finanzen.ps1" %*
