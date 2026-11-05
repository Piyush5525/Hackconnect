@echo off
title HackConnect server
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install
)
node scripts/start.mjs
pause
