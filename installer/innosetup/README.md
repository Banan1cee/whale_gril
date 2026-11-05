# Inno Setup 7.1.1（构建工具）

- `compiler/`：Inno Setup 7.1.1 的命令行编译器本体（ISCC.exe + 依赖 DLL + 安装载荷），
  从本机 `C:\Program Files\Inno Setup 7` 原样复制，未做任何修改
- `license.txt`：官方许可（允许二进制形式再分发，保留版权声明）
- 来源：https://jrsoftware.org/isdl.php（7.1.1，2026-10-28）

## 为什么带编译器，而不是安装包

CI 里跑 `innosetup-7.1.1-x64.exe /VERYSILENT` 实测要 **359 秒**（GitHub runner，
且全程没有任何输出），而直接调用 `compiler\ISCC.exe` 编译只要 **10 秒**。
所以仓库里放编译器本体，不跑安装程序。

## 升级步骤

1. 从官网下载新版本安装包，本机安装一次
2. 把安装目录（如 `C:\Program Files\Inno Setup 7`）下这些文件复制到 `compiler/`：
   - `ISCC.exe`、`ISCmplr.dll`、`ISPP.dll`、`ISPPBuiltins.iss`
   - `Setup.e32`、`Setup.e64`、`SetupLdr.e32`、`SetupLdr.e64`
   - `Default.isl`、`isscint-x64.dll`、所有 `is*.dll`
   - **所有 `*.issig`**：Inno 7 会校验自家 DLL 的签名，少一个就拒绝启动
   - 同步更新 `license.txt`
3. 本地验证：`installer\innosetup\compiler\ISCC.exe installer\whale.iss --define=AppVersion=4.0.0`
4. 跑一次 `installer`，确认 CI 还是绿的

## 注意

- Inno 7 的命令行定义是 `--define=Name=Value`，不是 6 时代的 `/D`。
- 不用提交安装包 exe（`innosetup-*.exe`）：跑不到，还多 14MB。
- 只放官方原版文件，不要改内容（改了就过不了它自己的签名校验）。
