#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冷启动实验：微信重开后，控件树到底是「自己会好」还是「需要外部触发」。

两段式，避免把「我们自己的探测」当成触发条件：
  A 段（默认 60 秒）：一次都不碰 UIA，纯等。结束后只查一次。
     → 如果这时已经 ok，说明控件树是时间到了自己长出来的，跟写字节无关。
  B 段（60 秒）：每 0.8 秒查一次（相当于持续有 UIA 客户端挂着）。
     → 如果这时才 ok，说明需要「有客户端在问」才会长。

跑法：runtime\\python\\python.exe -B tools\\uia_cold_experiment.py [A秒] [B秒]
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "data", "uia_cold_experiment.log")


def say(msg):
    line = "%s  %s" % (time.strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def main(a_sec=60, b_sec=60):
    try:
        os.remove(OUT)
    except OSError:
        pass

    from bridge import uia_boot

    base = uia_boot.pick_window()
    if not base:
        say("现在就没有微信主窗，先把微信开着再跑")
        return 2
    old_pid = base["pid"]
    say("基线 pid=%s 版本=%s" % (old_pid, base.get("version")))

    say("等微信重启（最多 10 分钟）…")
    deadline = time.time() + 600
    win = None
    while time.time() < deadline:
        w = uia_boot.pick_window()
        if w and w["pid"] != old_pid:
            win = w
            break
        time.sleep(0.1)
    if not win:
        say("超时")
        return 3

    say("新进程 pid=%s（旧 %s）" % (win["pid"], old_pid))
    hwnd = win["hwnd"]

    say("A 段：%d 秒内不碰 UIA，纯等…" % a_sec)
    t0 = time.time()
    while time.time() - t0 < a_sec:
        # 只确认窗口还在，不做任何 UIA 调用
        time.sleep(1.0)
        w = uia_boot.pick_window(prefer_hwnd=hwnd)
        if not w:
            say("  窗口没了，实验中止")
            return 4
        hwnd = w["hwnd"]
    a_state = uia_boot.tree_state(hwnd, 1.0)
    say("A 段结束（+%ds）：树=%s" % (a_sec, a_state))
    if a_state == "ok":
        say("结论：控件树是**自己**长出来的（%d 秒内），不需要写 gate 字节。" % a_sec)
        return 0

    say("B 段：每 0.8 秒查一次，最多 %d 秒…" % b_sec)
    t0 = time.time()
    while time.time() - t0 < b_sec:
        st = uia_boot.tree_state(hwnd, 0.5)
        if st == "ok":
            say("B 段 +%.1fs：树变 ok（说明「有客户端在问」会触发）" % (time.time() - t0))
            say("结论：需要持续挂一个 UIA 客户端，等 %.1f 秒左右才会物化。" % (time.time() - t0))
            return 0
        time.sleep(0.8)
    say("B 段结束：仍然是 shell")
    say("结论：既不会自己好，也不是「有人问就行」——确实需要正确的 gate 字节（或别的激活手段）")
    return 1


if __name__ == "__main__":
    a = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    b = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    sys.exit(main(a, b))
