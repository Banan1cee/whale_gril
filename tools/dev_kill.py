"""开发期小工具：只杀鲸鲸自己的进程（不碰别的 node/python）。"""
import os
import sys

import psutil

MARKERS = ("wechatauto_bridge.py", "server.js", "WhaleLauncher.exe")


def wanted(p):
    try:
        cmd = " ".join(p.cmdline())
    except Exception:
        return False
    if "WhaleLauncher.exe" in (p.name() or ""):
        return True
    for m in MARKERS:
        if m in cmd and "whale_gril" in cmd.replace("\\", "/").lower():
            return True
    return False


def main():
    me = os.getpid()
    killed = []
    for p in psutil.process_iter(["pid", "name"]):
        if p.pid == me:
            continue
        try:
            if wanted(p):
                p.kill()
                killed.append((p.pid, p.name()))
        except Exception:
            pass
    print("killed:", killed or "none")


if __name__ == "__main__":
    main()
