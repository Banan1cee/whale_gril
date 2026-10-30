#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提权后测 SPI_SETSCREENREADER：这很可能就是「需要管理员权限」的真正含义。

Windows 从 Vista 起，普通权限进程调 SPI_SETSCREENREADER 会失败（返回 0、
读回仍是 0）；以管理员调用才生效。Qt 的 Windows 无障碍桥就是靠这个标志判断
「有没有屏幕阅读器」，微信的 mmui 树也照这条走。

跑法（必须提权）：runtime\\python\\python.exe -B tools\\elev_spi_test.py
结果写 data/spi_test.txt
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "data", "spi_test.txt")

SPI_GETSCREENREADER = 0x0046
SPI_SETSCREENREADER = 0x0042


def say(lines, msg):
    line = "%s  %s" % (time.strftime("%H:%M:%S"), msg)
    lines.append(line)
    print(line, flush=True)


def main():
    lines = []
    try:
        os.remove(OUT)
    except OSError:
        pass

    u = ctypes.windll.user32
    u.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
    u.SystemParametersInfoW.restype = wintypes.BOOL

    admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
    say(lines, "管理员=%s" % admin)

    from bridge import uia_boot

    w = uia_boot.pick_window()
    if not w:
        say(lines, "没找到微信主窗")
        _write(lines)
        return 2
    say(lines, "微信 pid=%s 版本=%s 树=%s" % (w["pid"], w["version"], uia_boot.tree_state(w["hwnd"], 0.8)))

    before = wintypes.BOOL()
    u.SystemParametersInfoW(SPI_GETSCREENREADER, 0, ctypes.byref(before), 0)
    say(lines, "设置前 SPI_GETSCREENREADER=%s" % before.value)

    for ui_param, pv, winini, desc in (
            (1, None, 0, "uiParam=TRUE,pv=NULL,fWinIni=0"),
            (1, None, 0x03, "uiParam=TRUE,fWinIni=UPDATE|SENDCHANGE"),
            (1, ctypes.byref(wintypes.BOOL(True)), 0, "uiParam=TRUE,pv=&TRUE,fWinIni=0"),
    ):
        r = u.SystemParametersInfoW(SPI_SETSCREENREADER, ui_param, pv, winini)
        after = wintypes.BOOL()
        u.SystemParametersInfoW(SPI_GETSCREENREADER, 0, ctypes.byref(after), 0)
        say(lines, "%s -> ret=%s 读回=%s" % (desc, r, after.value))
        if r or after.value:
            ok = False
            t0 = time.time()
            while time.time() - t0 < 12:
                if uia_boot.tree_state(w["hwnd"], 0.6) == "ok":
                    ok = True
                    say(lines, "  树在第 %.1f 秒变 ok" % (time.time() - t0))
                    break
                time.sleep(0.5)
            if ok:
                say(lines, "结论：SPI 屏幕阅读器标志有效，这是修法")
                _write(lines)
                return 0
            say(lines, "  12 秒内树仍是 shell")

    say(lines, "结论：提权后 SPI 也没让它物化")
    _write(lines)
    return 1


def _write(lines):
    try:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception as e:
        print("写结果失败", e)


if __name__ == "__main__":
    sys.exit(main())
