@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title DesiCaps - Android test build
echo.
echo  ===  Send the latest changes to GitHub and build an Android TEST version  ===
echo       (no new release - the APK appears under "Android test build" on GitHub)
echo.
set "GIT=git"
where git >nul 2>nul || set "GIT=%ProgramFiles%\Git\cmd\git.exe"
set "GH=gh"
where gh >nul 2>nul || set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
"%GH%" auth status >nul 2>nul || (echo Please run publish_to_github.bat once first to sign in. & pause & exit /b 1)
for /f "delims=" %%i in ('call "%GH%" api user -q .login') do set "LOGIN=%%i"
for /f "delims=" %%r in ('call "%GH%" repo view --json name -q .name') do set "REPO=%%r"
if not exist ".github\workflows" mkdir ".github\workflows"
copy /y "packaging\github\*.yml" ".github\workflows\" >nul
call :android_secrets "%LOGIN%/!REPO!"
"%GIT%" add -A
"%GIT%" -c user.name="%LOGIN%" -c user.email="%LOGIN%@users.noreply.github.com" commit -q -m "Android test build"
set "OK="
for /l %%n in (1,1,4) do if not defined OK ( "%GIT%" push -q origin HEAD && set "OK=1" || (echo  Network hiccup - retrying in 5 seconds... & timeout /t 5 >nul) )
if not defined OK (echo Push failed - check your internet and run this again. & pause & exit /b 1)
echo.
echo  DONE - GitHub is building the Android test app (about 15-25 minutes).
echo    Progress : https://github.com/%LOGIN%/!REPO!/actions
echo    Download : https://github.com/%LOGIN%/!REPO!/releases/tag/android-test
start "" "https://github.com/%LOGIN%/!REPO!/actions"
timeout /t 20
exit /b 0

:android_secrets
if not exist "android-signing\keystore.b64" exit /b 0
"%GH%" secret list --repo %~1 2>nul | findstr /b "ANDROID_KEYSTORE_B64" >nul && exit /b 0
echo  Uploading the Android signing key to GitHub secrets (one time)...
"%GH%" secret set ANDROID_KEYSTORE_B64 --repo %~1 < "android-signing\keystore.b64"
for /f "usebackq tokens=1,* delims==" %%a in ("android-signing\signing.properties") do "%GH%" secret set %%a --repo %~1 --body "%%b"
exit /b 0
