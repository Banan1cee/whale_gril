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
DefaultDirName={localappdata}\Programs\WhaleGirl
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
Source: "..\launcher\publish\WhaleLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "WhaleLauncher.exe,.tools\*,artifacts\*,.git\*,.gitignore,.github\*,data\*,config.json,tests\*,docs\*,tools\*,scripts\*,installer\*,web\*,launcher\*,wechatauto_db\*,wechatauto_logs\*,runtime\wheelhouse\*,runtime\.temp\*,runtime\.uv-cache\*,runtime\manifest.json,*.log,*.zip,*.patch,*.bat,README*,*.md,requirements.txt"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动{#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录内的 data 属于用户数据：卸载时保留，只清运行时垃圾
Type: filesandordirs; Name: "{app}\data\media-cache"
; 用户备份默认保留，重装时仍可恢复。

[Code]
{ ── .NET 10 桌面运行时：随包安装 ──────────────────────────────────
  启动器是框架依赖的 .NET 10 WPF 程序。用户机器没有这个运行时，
  双击只会看到 Windows 的英文报错，所以安装时必须一起装上。

  设计：应用本身仍然 PrivilegesRequired=lowest（零 UAC 安装）；
  只有「检测到缺运行时」时，才用 ShellExec runas 单独提权跑随包的
  安装包 —— 已装运行时的用户完全无感，缺的机器只多弹一次 UAC。
}

const
  DotnetMajor = '10';
  DotnetInstallerName = 'windowsdesktop-runtime-10-win-x64.exe';

{ 目录名必须是纯版本号（10.0.14）。10.0.14.bak 这类改名残留不算。 }
function IsRuntimeVersionName(const Name: String): Boolean;
var
  I, Dots: Integer;
begin
  Result := False;
  if Length(Name) <= Length(DotnetMajor) + 1 then Exit;
  if Copy(Name, 1, Length(DotnetMajor) + 1) <> DotnetMajor + '.' then Exit;
  Dots := 0;
  for I := Length(DotnetMajor) + 2 to Length(Name) do
  begin
    if Name[I] = '.' then
      Inc(Dots)
    else if (Name[I] < '0') or (Name[I] > '9') then
      Exit;
  end;
  { 10.0.14：major 之后还剩 "0.14"，恰好一个点 }
  Result := (Dots = 1);
end;

function HasRuntimeUnder(const Root: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if not FindFirst(Root + '\' + DotnetMajor + '.*', FindRec) then Exit;
  try
    repeat
      if IsRuntimeVersionName(FindRec.Name) then
      begin
        Result := True;
        Exit;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

function IsDesktopRuntimeInstalled(): Boolean;
begin
  { 只认 x64 位置：启动器是 x64 程序，Program Files (x86) 下那份 32 位运行时
    用不上，算进去会导致“检测通过但启动器还是打不开”。 }
  Result := HasRuntimeUnder(ExpandConstant('{commonpf}\dotnet\shared\Microsoft.WindowsDesktop.App'));
end;

function InstallDotnetRuntime(): Boolean;
var
  Installer, Params: String;
  ExitCode: Integer;
begin
  Result := False;
  Installer := ExpandConstant('{app}\runtime\dotnet\' + DotnetInstallerName);

  if not FileExists(Installer) then
  begin
    MsgBox('安装包里没有找到 .NET 10 运行时安装包，启动器可能打不开。' + #13#10#13#10 +
           '请手动下载安装：' + #13#10 +
           'https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe',
           mbError, MB_OK);
    Exit;
  end;

  Params := '/install /quiet /norestart';

  { runas = 单独提权；UAC 被取消时返回 False }
  Log('ShellExec runas: ' + Installer);
  if not ShellExec('runas', Installer, Params, '', SW_SHOW, ewWaitUntilTerminated, ExitCode) then
  begin
    Log('ShellExec 失败（提权被拒或无法启动）');
    MsgBox('没能启动 .NET 运行时安装（可能取消了 UAC）。' + #13#10#13#10 +
           '可以手动运行：' + Installer, mbError, MB_OK);
    Exit;
  end;

  Log('ShellExec 完成，ExitCode=' + IntToStr(ExitCode));

  { 0 = 成功；3010 = 成功但需要重启 }
  Result := (ExitCode = 0) or (ExitCode = 3010);
  if not Result then
    MsgBox('运行时安装返回 ' + IntToStr(ExitCode) + '，可能没装成功。' + #13#10 +
           '启动器如果打不开，请手动运行：' + Installer, mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  Log('CurStepChanged 触发，CurStep=' + IntToStr(Ord(CurStep)));
  { 文件复制完之后再装：这时应用目录下的 runtime\dotnet 才真的存在 }
  if CurStep = ssPostInstall then
  begin
    if IsDesktopRuntimeInstalled() then
      Log('.NET 10 桌面运行时已存在，跳过')
    else
    begin
      Log('.NET 10 桌面运行时缺失，开始安装');
      InstallDotnetRuntime();
      { 安装程序自己会根据注册表判断“已装”，可能直接返回 0 而什么都没做。
        所以装完必须再查一次目录——不一致时明确告诉用户，别静默放过去。 }
      if not IsDesktopRuntimeInstalled() then
      begin
        Log('安装后复检：仍然检测不到 .NET 10 桌面运行时');
        MsgBox('已经尝试安装 .NET 10 运行时，但系统里仍然检测不到。' + #13#10#13#10 +
               '启动器可能打不开。请手动运行安装包：' + #13#10 +
               ExpandConstant('{app}\runtime\dotnet\' + DotnetInstallerName),
               mbError, MB_OK);
      end;
    end;
  end;
end;
