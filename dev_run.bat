@echo off
rem Developer mode: run DesiCaps from source (needs Python 3.11 + bin\whisper-cli.exe + models\*.bin)
cd /d "%~dp0"
if not exist .venv ( py -3.11 -m venv .venv || python -m venv .venv )
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
python app\desktop.py
