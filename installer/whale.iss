; 鲸鲸 4.0 — 安装脚本（Inno Setup 7）
;
; 设计要点：
;   1. 装到 %LOCALAPPDATA%\Programs\鲸鲸，**安装过程零 UAC**；
;   2. 启动器（WhaleLauncher.exe）带 requireAdministrator 清单：微信是管理员，
;      桥接必须同级才能改 gate / 读进程；拖拽已用 ChangeWindowMessageFilterEx 放行；
;   3. runtime\wheelhouse 只是构建缓存，不进包（省 117MB）；
;   4. 界面只有启动器，所以 web/、docs/、tools/、scripts/、launcher 源码、安装脚本
;      本身都不进包 —— 装完的目录里只剩运行需要的东西；
;   5. 运行环境全在包里：runtime\node.exe、runtime\python\（CPython 3.12 + 依赖）、
;      runtime\dotnet\windowsdesktop-runtime-10-win-x64.exe（缺 .NET 10 时由 [Code] 提权装）。
;
; 本文件由 GitHub Actions（.github/workflows/installer.yml）编译，本机不再出安装包。
; 版本号从命令行传入：ISCC.exe --define=AppVersion=4.0.0 installer\whale.iss
; 签名由 CI 在编译前后调用 scripts/sign-windows.ps1 完成（见 docs/打包与签名.md）。

#define AppName "鲸鲸"
#ifndef AppVersion
  #define AppVersion "4.0.0"
#endif
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
; 版本资源：CI 里 ISCC --define=AppVersion=4.0.0 打进来，安装包右键属性里能看到，
; 签名之后也能和证书信息对上。
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoCompany=鲸鲸
VersionInfoDescription={#AppName} 安装程序
VersionInfoCopyright=Copyright (C) 2026 鲸鲸
OutputDir=..\artifacts\setup
OutputBaseFilename=whale-girl-{#AppVersion}-setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; 安装包自己的图标：编译期读，不进包（所以 launcher 源码不进包也不影响）
SetupIconFile={#SrcDir}\launcher\Assets\app.ico
SetupLogging=yes

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

; 注意：这里绝不能写 *.zip。CPython embeddable 的标准库就是
; runtime\python\python312.zip，排掉它用户装完 python 直接报
; "No module named encodings"（4.0 的 CI 烟测就是这么抓到的）。
[Files]
; 这里必须逐项列目录，不能用 "..\*" + 一大堆 Excludes：
; Inno 的通配符会跨路径分隔符匹配，`tools\*` 会把 site-packages 里
; comtypes\tools、pywin\tools 这类**任意层级**的 tools 目录整片吃掉
; （4.0 的 CI 烟测就是这么发现 comtypes.tools 缺文件的）。
Source: "..\launcher\publish\WhaleLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*,*.pyc"
Source: "..\bridge\*"; DestDir: "{app}\bridge"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*,*.pyc"
Source: "..\personas\*"; DestDir: "{app}\personas"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "persona-v4-fight.json"
Source: "..\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "clapback-fight.txt"
Source: "..\examples\*"; DestDir: "{app}\examples"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*,*.pyc"
; runtime：内置 node.exe + CPython + .NET 运行时安装包；wheelhouse 是构建缓存，不进包
; （它也是 CPython 标准库 python312.zip 所在目录，所以绝不能整体排除 *.zip）
Source: "..\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "wheelhouse\*,.temp\*,.uv-cache\*,.built,__pycache__\*"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动{#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录内的 data 属于用户数据：卸载时保留，只清运行时垃圾
Type: filesandordirs; Name: "{app}\data\media-cache"
; .NET 运行时安装包（约 60MB）在安装目录里留着，用户重装/修复时还能手动再跑；
; 只有卸载时才清掉它。
Type: files; Name: "{app}\runtime\dotnet\*.exe"
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
    { 用 SuppressibleMsgBox 而不是 MsgBox：MsgBox 不认 /SUPPRESSMSGBOXES，
      静默安装（/VERYSILENT）会卡在这个对话框上永远不返回。 }
    SuppressibleMsgBox('安装包里没有找到 .NET 10 运行时安装包，启动器可能打不开。' + #13#10#13#10 +
           '请手动下载安装：' + #13#10 +
           'https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe',
           mbError, MB_OK, IDOK);
    Exit;
  end;

  Params := '/install /quiet /norestart';

  { runas = 单独提权；UAC 被取消时返回 False }
  Log('ShellExec runas: ' + Installer);
  if not ShellExec('runas', Installer, Params, '', SW_SHOW, ewWaitUntilTerminated, ExitCode) then
  begin
    Log('ShellExec 失败（提权被拒或无法启动）');
    SuppressibleMsgBox('没能启动 .NET 运行时安装（可能取消了 UAC）。' + #13#10#13#10 +
           '可以手动运行：' + Installer, mbError, MB_OK, IDOK);
    Exit;
  end;

  Log('ShellExec 完成，ExitCode=' + IntToStr(ExitCode));

  { 0 = 成功；3010 = 成功但需要重启 }
  Result := (ExitCode = 0) or (ExitCode = 3010);
  if not Result then
    SuppressibleMsgBox('运行时安装返回 ' + IntToStr(ExitCode) + '，可能没装成功。' + #13#10 +
           '启动器如果打不开，请手动运行：' + Installer, mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  Log('CurStepChanged 触发，CurStep=' + IntToStr(Ord(CurStep)));
  { 文件复制完之后再装：这时应用目录下的 runtime\dotnet 才真的存在 }
  if CurStep = ssPostInstall then
  begin
    { 空目录残留：Inno 会按源树把 runtime\wheelhouse 建出来（里面的文件已经被
      Files 段的 Excludes 排除，117MB 不会进包）。装完顺手删掉这个空目录，
      别在用户机器上留个看不懂的 wheelhouse。 }
    DelTree(ExpandConstant('{app}\runtime\wheelhouse'), True, True, True);

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
        SuppressibleMsgBox('已经尝试安装 .NET 10 运行时，但系统里仍然检测不到。' + #13#10#13#10 +
               '启动器可能打不开。请手动运行安装包：' + #13#10 +
               ExpandConstant('{app}\runtime\dotnet\' + DotnetInstallerName),
               mbError, MB_OK, IDOK);
      end;
    end;

    { 确认运行时可用后，随包的 57MB 安装包就没用了：删掉，用户的程序目录里不该留着它。
      没装上就保留，用户还能照提示手动跑一次。 }
    if IsDesktopRuntimeInstalled() then
    begin
      if DeleteFile(ExpandConstant('{app}\runtime\dotnet\' + DotnetInstallerName)) then
        Log('已删除随包的 .NET 运行时安装包')
      else
        Log('删除 .NET 运行时安装包失败，已忽略');
      RemoveDir(ExpandConstant('{app}\runtime\dotnet'));
    end;
  end;
end;

{ 卸载：问一句要不要连个人数据一起删。默认「不删」（MB_DEFBUTTON2），
  静默卸载（/VERYSILENT /SUPPRESSMSGBOXES）走默认 = 保留数据，而且不会卡住。

  必须用 SuppressibleMsgBox：MsgBox 不认 /SUPPRESSMSGBOXES，静默卸载会一直
  停在这个对话框上（CI 烟测就是这么发现它卡了 180 秒的），用户用第三方卸载工具
  （都是静默调用）也会永远卡住。 }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if SuppressibleMsgBox('是否同时删除个人数据？' + #13#10#13#10 +
              'data\ 里存着 API Key、聊天记忆、人设和提醒；删掉之后无法恢复。' + #13#10 + #13#10 +
              '选「是」= 个人数据也一起删，应用程序全部移除；选「否」= 保留个人数据，重装后还能接着用。',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
    begin
      Log('用户选择：连个人数据一起删除');
      DelTree(ExpandConstant('{app}\data'), True, True, True);
      DelTree(ExpandConstant('{app}\wechatauto_db'), True, True, True);
      DelTree(ExpandConstant('{app}\wechatauto_logs'), True, True, True);
      DelTree(ExpandConstant('{app}\backup'), True, True, True);
      DeleteFile(ExpandConstant('{app}\config.json'));
    end
    else
      Log('用户选择：保留个人数据');
  end;
end;
