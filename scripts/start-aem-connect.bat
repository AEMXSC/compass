@echo off
:: AEM Connect Server — local OAuth helper for Compass
:: Run this once per machine. After first-run setup, it no longer needs admin.

cd /d "%~dp0.."

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Try starting without admin first (works after netsh setup)
node scripts/aem-connect-server.mjs 2>&1
if %errorlevel% equ 0 goto :done

:: Port 80 permission not set yet — do one-time netsh setup (requires admin)
echo.
echo  First-time setup: granting port 80 access (requires Administrator)...
echo.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  Not running as Administrator. Right-click this file and choose
    echo  "Run as administrator" for the first-time setup.
    echo.
    pause
    exit /b 1
)

netsh http add urlacl url=http://localhost/ user=Everyone >nul 2>&1
echo  Port 80 access granted. You can now run this without Administrator.
echo.

node scripts/aem-connect-server.mjs

:done
