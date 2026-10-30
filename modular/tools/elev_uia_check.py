#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提权自检：以管理员身份点一次「⏻ 启动」，确认桥接在管理员下也能把 UIA 弄起来。

由非管理员进程用 ShellExecuteW('runas') 拉起，用户点一次 UAC 即可。
结果写到 data/uia_check.txt，调用方读这个文件，不依赖控制台。
"""
import ctypes
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "uia_check.txt")


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def main():
    lines = []
    lines.append("elevated=%s" % is_admin())

    import uiautomation as auto
    auto.SetGlobalSearchTimeout(8)

    w = auto.WindowControl(searchDepth=1, Name="鲸鲸")
    if not w.Exists(5):
        lines.append("window=missing")
        _write(lines)
        return
    lines.append("window=ok")

    started = False
    for name in ("⏻ 启动", "⏻启动"):
        btn = w.ButtonControl(Name=name)
        if btn.Exists(3):
            btn.Click()
            started = True
            lines.append("clicked=%s" % name)
            break
    if not started:
        # 已经在跑就点停止再启动，确保走一遍完整启动
        lines.append("button=not_found")

    time.sleep(22)

    for p in (os.path.join(ROOT, "data", "launcher.log"),
              os.path.join(ROOT, "data", "bridge.log")):
        lines.append("---- " + os.path.basename(p) + " ----")
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                tail = f.readlines()[-400:]
        except OSError as e:
            lines.append("(读不到: %s)" % e)
            continue
        for row in tail:
            if any(k in row for k in ("UIA", "预热", "物化", "Weixin", "主窗", "kernel", "内核", "桥接")):
                lines.append(row.rstrip())
    _write(lines)


def _write(lines):
    try:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception as e:
        print("写结果失败", e)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _write(["exception=%r" % (e,)])
