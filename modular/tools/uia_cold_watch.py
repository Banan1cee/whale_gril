#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冷启动监听：等微信重开，第一时间抓控件树状态并试写 gate。

用法（在被测机器上，微信先开着）：
    runtime\\python\\python.exe -B tools\\uia_cold_watch.py [超时秒数]

它只做三件事：
  1. 记下当前微信主窗的 pid；
  2. 等这个 pid 消失、再等一个全新的微信主窗出现（每 100ms 看一次，抢在桥接重试之前）；
  3. 一出现就立刻记 tree_state，然后 ensure() 试写并逐步记录。
输出同时打到屏幕和 data/uia_cold.log，换电脑排查直接贴这个文件。
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "data", "uia_cold.log")

_buf = []


def say(msg):
    line = "%s  %s" % (time.strftime("%H:%M:%S"), msg)
    _buf.append(line)
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def main(timeout=600):
    try:
        os.remove(OUT)
    except OSError:
        pass

    from bridge import uia_boot

    first = uia_boot.pick_window()
    if not first:
        say("开始前就没找到微信主窗，先打开微信再说")
        return 2
    old_pid = first["pid"]
    say("基线：hwnd=%s pid=%s 版本=%s 树=%s" % (
        first["hwnd"], old_pid, first.get("version"), uia_boot.tree_state(first["hwnd"], 0.8)))

    say("等微信重启（最多 %d 秒）…" % timeout)
    deadline = time.time() + timeout
    seen_new = None
    while time.time() < deadline:
        w = uia_boot.pick_window()
        if w and w["pid"] != old_pid:
            seen_new = w
            break
        time.sleep(0.1)

    if not seen_new:
        say("超时：没等到新的微信进程")
        return 3

    say("新的微信进程出现了：hwnd=%s pid=%s 版本=%s（基线 pid=%s）" % (
        seen_new["hwnd"], seen_new["pid"], seen_new.get("version"), old_pid))

    # 冷状态：立刻连抓几次，抢在桥接重试之前
    for i in range(6):
        say("  冷状态第 %d 次（+%.1fs）：树=%s" % (
            i + 1, i * 0.3, uia_boot.tree_state(seen_new["hwnd"], 0.6)))
        time.sleep(0.3)

    say("--- 开始试写（会自动还原失败的字节）---")
    res = uia_boot.ensure(prefer_hwnd=seen_new["hwnd"], log=lambda m: say("    " + m))
    say("结果：%s" % {k: v for k, v in res.items() if k != "base"})
    say("人话：%s" % uia_boot.describe(res))

    # 收尾：记一下桥接日志最新的 UIA 行，方便对照「谁先激活的」
    try:
        p = os.path.join(ROOT, "data", "bridge.log")
        with open(p, encoding="utf-8", errors="replace") as f:
            rows = f.readlines()[-200:]
        for r in rows:
            if any(k in r for k in ("UIA", "物化", "预热", "Weixin")):
                say("  [bridge] " + r.strip()[:160])
    except OSError:
        pass
    return 0 if res.get("ok") else 4


if __name__ == "__main__":
    try:
        code = main(int(sys.argv[1]) if len(sys.argv) > 1 else 600)
    except Exception as e:  # noqa: BLE001
        say("异常：%r" % (e,))
        code = 5
    sys.exit(code)
