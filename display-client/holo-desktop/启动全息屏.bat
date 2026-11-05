@echo off
cd /d "%~dp0"
if exist "holo.exe.new" (del /f /q "holo.exe" 2>nul & ren "holo.exe.new" "holo.exe" 2>nul & del /f /q "holo.exe.new.ver" 2>nul)
if not exist "holo.exe" (echo [ERROR] holo.exe not found in this folder. & pause & exit /b)
echo Launching holo.exe ...
holo.exe
echo.
echo ===== holo.exe exited (code %errorlevel%). If you see errors above, screenshot this window. =====
pause
