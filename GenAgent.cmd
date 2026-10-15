@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Для работы GenAgent нужен Node.js ^(версия 22 или новее^).
  echo  Сейчас откроется страница загрузки — установите LTS-версию и запустите GenAgent снова.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

rem Лаунчер работает в фоне без окна консоли: сам откроет окно приложения и остановит сервер, когда его закроют.
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'scripts\launch.mjs' -WorkingDirectory '%~dp0.'"
