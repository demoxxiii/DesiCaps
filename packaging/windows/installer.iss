; Inno Setup script for DesiCaps Studio (per-user install, no admin rights needed)
; Build:  iscc /DAppVersion=1.0.0 packaging\windows\installer.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6C1C8F2E-7D3B-4E0B-9F4A-DE5C4A9B1D01}
AppName=DesiCaps Studio
AppVersion={#AppVersion}
AppPublisher=DesiCaps
AppPublisherURL=https://github.com/
DefaultDirName={localappdata}\Programs\DesiCaps
DefaultGroupName=DesiCaps Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=DesiCaps-Windows-Setup
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\DesiCaps.exe
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
LicenseFile=..\..\LICENSE

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\..\dist\DesiCaps\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\DesiCaps Studio"; Filename: "{app}\DesiCaps.exe"
Name: "{autodesktop}\DesiCaps Studio"; Filename: "{app}\DesiCaps.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DesiCaps.exe"; Description: "Launch DesiCaps Studio"; Flags: nowait postinstall skipifsilent
