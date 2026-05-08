@echo off
:: Launcher for the SuckLess Factors native messaging host.
:: -NoProfile prevents profile scripts from writing to stdout (which would
:: corrupt the binary length-prefixed protocol).
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1"
