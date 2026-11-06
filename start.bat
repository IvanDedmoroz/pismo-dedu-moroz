@echo off
cd /d "%~dp0"
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Не удалось запустить. Установи и запусти Docker Desktop, затем повтори.
  pause
  exit /b 1
)
start "" http://localhost:3000
