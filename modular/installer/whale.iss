; 鲸鲸 4.0 — 安装脚本（Inno Setup 7）
;
; 设计要点：
;   1. 装到 %LOCALAPPDATA%\Programs\鲸鲸，**安装过程零 UAC**；
;   2. 启动器（WhaleLauncher.exe）不带管理员清单，界面不提权 ——
;      这样从资源管理器拖表情包进窗口不会被 UIPI 拦掉；
;   3. 真正需要管理员的是桥接（微信恒为管理员），由启动器按需拉起；
;   4. runtime\wheelhouse 只是构建缓存，不进包（省 117MB）。

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
    Excludes: ".git\*,.gitignore,data\*,config.json,tests\*,launcher\bin\*,launcher\obj\*,runtime\wheelhouse\*,runtime\.temp\*,runtime\.uv-cache\*,runtime\manifest.json,*.log,*.zip,*.patch"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动{#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录内的 data 属于用户数据：卸载时保留，只清运行时垃圾
Type: filesandordirs; Name: "{app}\data\media-cache"
Type: filesandordirs; Name: "{app}\data\backups"
