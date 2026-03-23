@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Usage: %~nx0 zipfile.zip
    exit /b 1
)

set "ZIPFILE=%~f1"
if not exist "%ZIPFILE%" (
    echo Error: File "%ZIPFILE%" not found.
    exit /b 1
)

set "TEMPDIR=%TEMP%\%~n0_%RANDOM%"
mkdir "%TEMPDIR%" 2>nul

echo Extracting "%ZIPFILE%" to "%TEMPDIR%" ...
powershell -Command "Expand-Archive -Path '%ZIPFILE%' -DestinationPath '%TEMPDIR%' -Force" || (
    echo Failed to extract archive.
    rmdir /s /q "%TEMPDIR%" 2>nul
    exit /b 1
)

set "COMMSERVER=%TEMPDIR%\terminal\commserver"
if not exist "%COMMSERVER%" (
    echo Error: Archive does not contain 'terminal\commserver'.
    rmdir /s /q "%TEMPDIR%" 2>nul
    exit /b 1
)

echo Merging files from "%COMMSERVER%" into merged.txt ...
powershell -Command "Get-ChildItem '%COMMSERVER%' -File | Sort-Object Name | Get-Content | Set-Content merged.txt -Encoding UTF8" || (
    echo Failed to merge files.
    rmdir /s /q "%TEMPDIR%" 2>nul
    exit /b 1
)

echo Cleaning up temporary files ...
rmdir /s /q "%TEMPDIR%" 2>nul

echo Done. Output written to merged.txt
