@echo off
cd /d "%~dp0"
netstat -ano | findstr /R /C:":1111 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 1111 is already in use. Close the old server window, then run this file again.
  pause
  exit /b 1
)
start "StoryForge Dev :1111" /D "%~dp0" cmd /k "npm.cmd run dev -- --host localhost"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:1111/storyforge/' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo StoryForge did not start on port 1111. Check the server window.
  pause
  exit /b 1
)
start "" http://localhost:1111/storyforge/
