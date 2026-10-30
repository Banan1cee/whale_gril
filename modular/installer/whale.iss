; 鲸鲸 4.0 — 安装脚本（Inno Setup 7）
;
; 设计要点：
;   1. 装到 %LOCALAPPDATA%\Programs\鲸鲸，**安装过程零 UAC**；
;   2. 启动器（WhaleLauncher.exe）带 requireAdministrator 清单：微信是管理员，
;      桥接必须同级才能改 gate / 读进程；拖拽已用 ChangeWindowMessageFilterEx 放行；
;   3. runtime\wheelhouse 只是构建缓存，不进包（省 117MB）；
;   4. 界面只有启动器，所以 web/、docs/、tools/、scripts/、launcher 源码、安装脚本
;      本身都不进包 —— 装完的目录里只剩运行需要的东西。

#define AppName "鲸鲸"
#define AppVersion "4.0.0-alpha"
#define AppExe "WhaleLauncher.exe"
#define SrcDir ".."

[Setup]
AppId={{7C1E2A54-9B3D-4E88-9A21-5D6F0C4B1A77}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=鲸鲸
DefaultDirName={localappdata}\Programs\鲸鲸
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\build
OutputBaseFilename=whale-girl-{#AppVersion}-setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
SetupLogging=yes

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
Source: "..\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: ".git\*,.gitignore,.github\*,data\*,config.json,tests\*,docs\*,tools\*,scripts\*,installer\*,web\*,launcher\*,wechatauto_db\*,wechatauto_logs\*,runtime\wheelhouse\*,runtime\.temp\*,runtime\.uv-cache\*,runtime\manifest.json,*.log,*.zip,*.patch,*.bat,README*,*.md,requirements.txt"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动{#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录内的 data 属于用户数据：卸载时保留，只清运行时垃圾
Type: filesandordirs; Name: "{app}\data\media-cache"
Type: filesandordirs; Name: "{app}\data\backups"
