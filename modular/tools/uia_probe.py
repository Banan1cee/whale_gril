#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UIA 体检：一条命令把「现在能不能用、为什么不能用」全部打出来。

换台电脑排查时只跑这一个，把输出贴回来就够定位：
  runtime\\python\\python.exe -B tools\\uia_probe.py

它只读，不改微信进程（唯一的写发生在 --fix 时）。
"""
import argparse
import ctypes
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="允许写 gate 字节并验证（默认只读）")
    args = ap.parse_args()

    from bridge import uia_boot

    print("=" * 58)
    print("UIA 体检")
    print("=" * 58)
    print("本进程管理员:", is_admin())
    print("Python 位数:", 64 if sys.maxsize > 2 ** 32 else 32)
    print()

    wins = uia_boot._iter_windows()
    print("候选微信主窗: %d 个" % len(wins))
    for w in wins:
        print("  hwnd=%-10s pid=%-7s 标题=%-6r 类名=%-22s 前台=%-5s 最小化=%s" % (
            w["hwnd"], w["pid"], w["title"], w["cls"], w["foreground"], w["minimized"]))
    print()

    win = uia_boot.pick_window()
    if not win:
        print("挑窗口: 失败（没有任何窗口的 PID 里加载了 Weixin.dll）")
        return 2
    print("挑窗口: hwnd=%s pid=%s 版本=%s" % (win["hwnd"], win["pid"], win["version"]))
    print("DLL: %s" % win["dll"])
    print()

    state = uia_boot.tree_state(win["hwnd"], timeout=1.0)
    print("控件树状态:", state, "(ok=有会话列表, shell=只有空壳)")
    if state == "ok":
        print("结论: UIA 现在可用，不需要修。")
        if not args.fix:
            return 0

    from wechatauto.accessibility import (
        AccessibilityGate as G,
        QACCESSIBLE_ACTIVE_RVA_BY_VERSION,
        _dll_identity,
    )
    print("库版本表有 %s 吗:" % win["version"],
          QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(win["version"]))
    identity = _dll_identity(win["dll"])
    print("DLL 身份:", identity)

    rvas = uia_boot.candidate_rvas(win["dll"], win["version"])
    print("候选 RVA:", [hex(x) for x in rvas] or "（空）")
    print()

    handle, err = uia_boot._open_process(win["pid"])
    print("OpenProcess ->", handle, "WinError", err)
    if not handle:
        print("结论: 没权限（微信可能是管理员，用管理员跑本工具）")
        return 3
    try:
        for rva in rvas:
            b = uia_boot._read_byte(handle, win["base"] + rva)
            print("  候选 %s 处的字节 = %s" % (hex(rva), b))
    finally:
        uia_boot._close(handle)
    print()

    if not args.fix:
        print("只读模式结束。要试写并验证，加 --fix（会自动还原写错的字节）")
        return 1 if state != "ok" else 0

    print("--- 开始物化 ---")
    res = uia_boot.ensure(prefer_hwnd=win["hwnd"], log=lambda m: print("  " + m))
    print()
    print("结果:", {k: v for k, v in res.items() if k != "base"})
    print("结论:", uia_boot.describe(res))
    return 0 if res.get("ok") else 4


if __name__ == "__main__":
    sys.exit(main())
