@echo off
:: Connect AEM Content MCP for Compass
:: This script authenticates you with AEM Content MCP so Compass can edit JCR pages.
:: Must run as Administrator (right-click → Run as administrator)

cd /d "%~dp0.."
echo.
echo  Compass — AEM Content Connect
echo  ================================
echo  This will open a browser window for Adobe authentication.
echo  After signing in, Compass will open automatically with write access enabled.
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

node scripts/get-mcp-token.mjs
if %errorlevel% neq 0 (
    echo.
    echo  Failed. Make sure you right-clicked and chose "Run as administrator".
    pause
    exit /b 1
)

echo.
pause
