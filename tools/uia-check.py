"""UIA 诊断一键入口：双击「一键诊断UIA.bat」时跑这个。

目的：把「UIA 用不了 → 发送掉进很慢的 OCR」这个常见问题，变成一句人话结论
＋下一步该干什么，而不是让用户对着一屏英文/警告发懵。
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "runtime", "python", "python.exe")
DIAG = os.path.join(ROOT, "tools", "uia-diag.py")


def main():
    if not os.path.isfile(PY):
        print("[错误] 找不到 runtime\\python\\python.exe，请从鲸鱼娘文件夹根目录运行。")
        return 2
    if not os.path.isfile(DIAG):
        print("[错误] 找不到 tools\\uia-diag.py。")
        return 2
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env.pop(key, None)
    env["NO_PROXY"] = "*"
    print("正在检查微信的 UIA 控件树（大约 3~15 秒）…\n")
    code = subprocess.call([PY, DIAG, "--probe"], cwd=ROOT, env=env)
    print("\n" + "=" * 60)
    if code == 0:
        print("结论：UIA 正常，可以发送。")
        print("如果发送仍然失败，问题不在 UIA，请看「微信桥接」窗口里的报错。")
    else:
        print("结论：UIA 这次没起来。按顺序试：")
        print("  1) 完全退出微信（托盘图标右键 → 退出），重新登录")
        print("  2) 用管理员身份运行「启动鲸鱼娘.bat」和「启动微信桥接.bat」")
        print("  3) 微信不要最小化到托盘，保持窗口在桌面上")
        print("  4) 再跑一次本诊断")
        print("注：UIA 不可用时会自动改用键盘通道发送，比 UIA 慢但通常还能用；")
        print("    只有键盘通道也失败时，才会掉进很慢的 OCR。")
    print("=" * 60)
    return 0 if code == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
