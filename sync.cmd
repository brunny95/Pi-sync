@echo off
rem Launch sync.sh with Git for Windows bash (works from cmd, PowerShell or double-click).
"%ProgramFiles%\Git\bin\bash.exe" "%~dp0sync.sh" %*
if errorlevel 1 pause
