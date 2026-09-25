@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title DesiCaps - publish to GitHub
echo.
echo  ===  Publish DesiCaps to GitHub (builds the Windows + Mac apps for you)  ===
echo.

rem ---- tools: git + GitHub CLI --------------------------------------------------
set "GIT=git"
where git >nul 2>nul || (
  if not exist "%ProgramFiles%\Git\cmd\git.exe" (
    echo Installing Git...
    winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements
  )
  set "GIT=%ProgramFiles%\Git\cmd\git.exe"
)
set "GH=gh"
where gh >nul 2>nul || (
  if not exist "%ProgramFiles%\GitHub CLI\gh.exe" (
    echo Installing GitHub CLI...
    winget install -e --id GitHub.cli --silent --accept-source-agreements --accept-package-agreements
  )
  set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
)

rem ---- sign in: copy the 8-character code shown below into the GitHub page -------
"%GH%" auth status >nul 2>nul || (
  echo.
  echo  ************************************************************************
  echo   SIGN IN: a GitHub page opens. Enter the ONE-TIME CODE printed below,
  echo   then click Authorize. This window continues automatically.
  echo  ************************************************************************
  echo.
  start "" "https://github.com/login/device"
  echo.| "%GH%" auth login --web --git-protocol https --hostname github.com --scopes workflow || (echo Sign-in failed. & pause & exit /b 1)
)
"%GH%" auth status 2>&1 | findstr /i "workflow" >nul || (echo.| "%GH%" auth refresh -h github.com -s workflow)
for /f "delims=" %%i in ('call "%GH%" api user -q .login') do set "LOGIN=%%i"
echo  Signed in as: %LOGIN%
"%GH%" auth setup-git >nul 2>nul

rem ---- build workflow (kept in packaging\github; copied into place here) ---------
if not exist ".github\workflows" mkdir ".github\workflows"
copy /y "packaging\github\build.yml" ".github\workflows\build.yml" >nul

if not exist ".git" (
  rem ======== first publish ========
  set "REPO=DesiCaps"
  "%GH%" repo view "%LOGIN%/DesiCaps" >nul 2>nul && set "REPO=DesiCaps-Studio"
  set "VERSION=v1.0.0"
  powershell -NoProfile -Command "(Get-Content -Raw 'website\index.html') -replace 'YOUR-GITHUB-USERNAME/DesiCaps', '%LOGIN%/!REPO!' | Set-Content -Encoding UTF8 'website\index.html'"
  "%GIT%" init -b main
  "%GIT%" add -A
  "%GIT%" -c user.name="%LOGIN%" -c user.email="%LOGIN%@users.noreply.github.com" commit -q -m "DesiCaps Studio !VERSION!"
  "%GH%" repo create "!REPO!" --public --source . --remote origin --push --description "Free offline Hinglish caption studio for Reels and Shorts (Windows + Mac)" || (echo Could not create the repository. & pause & exit /b 1)
) else (
  rem ======== new version: bump the last tag, e.g. v1.0.0 -> v1.0.1 ========
  for /f "delims=" %%r in ('call "%GH%" repo view --json name -q .name') do set "REPO=%%r"
  set "LAST=v1.0.0"
  for /f "delims=" %%t in ('call "%GIT%" describe --tags --abbrev^=0 2^>nul') do set "LAST=%%t"
  for /f "delims=" %%v in ('powershell -NoProfile -Command "$p='!LAST!'.TrimStart('v').Split('.'); 'v{0}.{1}.{2}' -f $p[0],$p[1],([int]$p[2]+1)"') do set "VERSION=%%v"
  echo  Publishing new version !VERSION! ^(previous: !LAST!^)
  "%GIT%" add -A
  "%GIT%" -c user.name="%LOGIN%" -c user.email="%LOGIN%@users.noreply.github.com" commit -q -m "Release !VERSION!"
  "%GIT%" push -q origin HEAD
)

"%GIT%" tag !VERSION!
"%GIT%" push -q origin !VERSION! || (echo Tag push failed. & pause & exit /b 1)

echo.
echo  DONE!  GitHub is now building DesiCaps !VERSION! for Windows and Mac (about 30-60 minutes).
echo    Progress :  https://github.com/%LOGIN%/!REPO!/actions
echo    Downloads:  https://github.com/%LOGIN%/!REPO!/releases/latest
echo.
echo  website\index.html now points at your downloads - upload it (with icon.png) to your site.
echo %LOGIN%/!REPO!> published_repo.txt
start "" "https://github.com/%LOGIN%/!REPO!/actions"
timeout /t 30
