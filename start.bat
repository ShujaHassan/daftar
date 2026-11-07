@echo off
cd /d "%~dp0"
echo DAFTAR: http://127.0.0.1:4173
start "" http://127.0.0.1:4173
node server.js
pause
