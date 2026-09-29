@echo off
REM Supervisor simples Windows: reinicia o bot se cair
setlocal
cd /d "%~dp0"

:loop
echo [%date% %time%] Iniciando hanork-beta...
node index.js
echo [%date% %time%] Processo encerrou com codigo %ERRORLEVEL%. Reiniciando em 5s...
timeout /t 5 /nobreak >nul
goto loop
