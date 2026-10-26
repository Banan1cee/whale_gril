"""UIA 热激活诊断（只读，默认不改微信内存）。

「热激活 UIA」= 在内存里给 Weixin.dll 写一个字节，打开微信的 Qt 无障碍开关，
让 UIA 能看到控件（否则 ensure_window() 会超时/失败，之后发送全部失败）。

失败其实分三种，光看一句「热激活 UIA 失败」分不出来：
  A. 找不到 Weixin.dll   → 枚举到了别的微信子进程 / 模块枚举被挡 / 位数不一致
  B. 不支持这个版本      → 特征扫描没命中、版本兜底表里也没有：升级库或换微信版本
  C. 补丁写了但校验失败  → mmui 控件没出现：版本对不上，或微信自我保护

用法：
  python tools/uia-diag.py           # 只报告，不改内存
  python tools/uia-diag.py --probe   # 真的做一次热激活并测量耗时
  python tools/uia-diag.py --all     # 把所有微信进程的模块情况都列出来
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "examples"))


def hr(title):
    print("\n== %s ==" % title)


def find_ffmpeg():
    """和桥接里的 ensure_ffmpeg_env 同一套逻辑：PATH 没有就找常见安装位置。"""
    import shutil
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for d in (r"C:\ffmpeg\bin", r"D:\ffmpeg\bin", r"E:\ffmpeg\bin", r"F:\ffmpeg\bin",
              os.path.join(ROOT, "runtime", "ffmpeg", "bin"),
              os.path.join(ROOT, "tools", "ffmpeg", "bin"),
              os.path.expandvars(r"%LOCALAPPDATA%\Programs\ffmpeg\bin")):
        p = os.path.join(d, "ffmpeg.exe")
        if os.path.isfile(p):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return p
    return ""


def main():
    probe = "--probe" in sys.argv
    show_all = "--all" in sys.argv

    hr("运行环境")
    print("程序目录:", ROOT)
    print("路径含非 ASCII 字符(中文):", "是 ← 这一条会让热激活必然失败" if any(ord(c) > 127 for c in ROOT) else "否")
    print("python:", sys.version.split()[0], "| 64 位:", sys.maxsize > 2 ** 32)
    print("ffmpeg:", find_ffmpeg() or "没找到（看图会失败）")

    hr("微信主窗")
    import win32gui
    import win32process
    hwnd = 0

    def cb(h, _):
        nonlocal hwnd
        try:
            cls = (win32gui.GetClassName(h) or "").lower()
            if ("qwindowicon" in cls or "mmui::mainwindow" in cls) and win32gui.GetWindowText(h) == "微信":
                hwnd = h
        except Exception:
            pass

    win32gui.EnumWindows(cb, None)
    if not hwnd:
        print("!! 找不到标题为「微信」的主窗。先把微信窗口点出来（别只留托盘）再跑。")
        return 2
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    print("hwnd=%d  pid=%d  class=%s" % (hwnd, pid, win32gui.GetClassName(hwnd)))

    hr("Weixin.dll 与版本")
    from wechatauto.accessibility import AccessibilityGate, QACCESSIBLE_ACTIVE_RVA_BY_VERSION

    if show_all:
        try:
            import psutil
            for p in psutil.process_iter(["pid", "name"]):
                if (p.info.get("name") or "").lower().startswith("weixin"):
                    try:
                        mods = list(AccessibilityGate._process_modules(p.info["pid"]) or [])
                        has = any((m[2] or "").lower() == "weixin.dll" for m in mods)
                        print("  pid=%-6s 模块=%-4d 含 Weixin.dll=%s" % (p.info["pid"], len(mods), has))
                    except Exception as e:
                        print("  pid=%-6s 枚举失败: %r" % (p.info["pid"], e))
        except Exception:
            pass

    try:
        mods = list(AccessibilityGate._process_modules(pid) or [])
    except Exception as e:
        print("!! 枚举模块失败:", repr(e), "→ 原因 A")
        return 1
    print("该进程模块数:", len(mods))
    dll_path = None
    for base, size, name, path in mods:
        if (name or "").lower() == "weixin.dll":
            dll_path = path
            print("Weixin.dll:", path)
            print("  基址=0x%X  大小=%.1f MB" % (base, size / 1024 / 1024))
            break
    if not dll_path:
        print("!! 主窗所在进程里没有 Weixin.dll（原因 A）")
        print("   → 说明拿到的是子进程/权限不足；关掉微信重新登录后立刻再试")
        print("   → 想看清各进程情况：python tools/uia-diag.py --all")
        return 1

    version = os.path.basename(os.path.dirname(dll_path))
    known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(version)
    print("微信版本目录:", version)
    print("库内置版本表:", ("命中 RVA=0x%X" % known) if known is not None else "未命中（需要特征扫描）")

    hr("候选 gate RVA")
    try:
        cands = AccessibilityGate._qaccessible_candidate_rvas(dll_path)
    except Exception as e:
        print("取候选失败:", repr(e))
        return 1
    if not cands:
        print("!! 一个候选都没有（原因 B）")
        print("   → 这个微信版本库还不支持：升级 wechatauto-replica，或换回 4.1.13.65 / 4.1.15.53")
        return 1
    print("候选数量:", len(cands))
    for rva in cands[:5]:
        print("  0x%X%s" % (rva, "（版本表）" if rva == known else "（特征扫描）"))

    hr("当前 UIA 状态")
    if probe:
        t = time.time()
        ok = AccessibilityGate._hot_activate_accessibility(hwnd)
        print("热激活结果:", "成功" if ok else "失败", "耗时 %.1fs" % (time.time() - t))
        if not ok:
            print("候选有但全失败 → 原因 C：版本对不上或被微信保护。重启微信后立刻再跑一次。")
            return 1
    else:
        try:
            import uiautomation as auto
            c = auto.ControlFromHandle(hwnd)
            cls = (c.ClassName if c else "") or ""
            print("UIA 可见类名:", cls or "(空)")
            print("结论:", "已激活过" if cls.startswith("mmui::") else "还没激活（桥接启动时会自动做）")
        except Exception as e:
            print("读控件失败:", repr(e))

    print("\n结论：条件齐全，可以正常用 UIA。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
