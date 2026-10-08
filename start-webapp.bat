@echo off
rem GPX-Tourenverwaltung - lokalen Server starten und im Browser oeffnen (Windows).
rem Doppelklick im Explorer. Fenster offen lassen; Beenden mit Strg+C.
cd /d "%~dp0"

rem --- ersten freien Port aus einer Liste nehmen (wie start-webapp.command / serve.ps1) ---
set "PORT="
for %%P in (8000 8010 8020 8080 4173) do (
  if not defined PORT (
    netstat -ano | findstr /c:":%%P " | findstr /c:"LISTENING" >nul
    if errorlevel 1 set "PORT=%%P"
  )
)
if not defined PORT set "PORT=8000"

rem --- Python-Starter suchen (py / python / python3) ---
set "PY="
for %%C in (py python python3) do (
  if not defined PY (
    %%C --version >nul 2>nul && set "PY=%%C"
  )
)

if defined PY (
  echo GPX-Tourenverwaltung
  echo Server: http://localhost:%PORT%
  echo Dieses Fenster offen lassen. Beenden mit Strg+C.
  echo.
  call :openbrowser "http://localhost:%PORT%"
  "%PY%" -m http.server %PORT%
  goto :eof
)

rem --- kein Python: PowerShell-Server (in Windows enthalten, keine Installation) ---
where powershell >nul 2>nul
if not errorlevel 1 (
  echo Python nicht gefunden - nutze den mitgelieferten PowerShell-Server.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%
  goto :eof
)

echo Weder Python noch PowerShell gefunden.
echo Bitte Python installieren: https://www.python.org/downloads/
echo   (im Installer "Add python.exe to PATH" anhaken)
pause
goto :eof

:openbrowser
rem Edge / Chrome bevorzugt (fuer den dauerhaften Ordnerzugriff noetig)
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" ( start "" "%EDGE%" %~1 & goto :eof )
set "CHR1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHR1%" ( start "" "%CHR1%" %~1 & goto :eof )
set "CHR2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHR2%" ( start "" "%CHR2%" %~1 & goto :eof )
set "CHR3=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHR3%" ( start "" "%CHR3%" %~1 & goto :eof )
rem sonst Standardbrowser (Hinweis in der App, falls kein Chromium)
start "" %~1
goto :eof
