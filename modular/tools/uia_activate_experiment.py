#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冷启动激活实验：微信重开后，逐个试「什么操作能让控件树长出来」。

顺序（每步之间会留时间观察，失败自动还原）：
  A 把微信窗口拉到前台（SetForegroundWindow + ShowWindow）
  B 写候选 gate 字节（0xB4F7C08），这次给足 6 秒观察
  C SPI_SETSCREENREADER 打开系统"屏幕阅读器"标志

结果写 data/uia_activate_exp.log。跑法：
    runtime\\python\\python.exe -B tools\\uia_activate_experiment.py
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "data", "uia_activate_exp.log")
WECHAT_EXE = r"C:\Program Files\Tencent\Weixin\Weixin.exe"


def say(msg):
    line = "%s  %s" % (time.strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def wechat_pids():
    import psutil
    return [p.pid for p in psutil.process_iter(["name"])
            if (p.info.get("name") or "").lower() == "weixin.exe"]


def main_hwnds():
    import win32gui
    out = []

    def cb(h, _):
        try:
            if win32gui.GetWindowText(h).strip() == "微信":
                out.append(h)
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    return out


def restart_wechat():
    import psutil
    say("关闭微信…")
    for p in psutil.process_iter(["pid", "name"]):
        if (p.info.get("name") or "").lower() == "weixin.exe":
            try:
                p.kill()
            except Exception:
                pass
    for _ in range(15):
        time.sleep(1)
        if not wechat_pids():
            break
    say("已关闭。重新启动…")
    subprocess.Popen([WECHAT_EXE], cwd=os.path.dirname(WECHAT_EXE), close_fds=True)
    for _ in range(40):
        time.sleep(0.5)
        if main_hwnds():
            break
    say("窗口已出现: %s" % main_hwnds())


def wait_shell(uia_boot, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        w = uia_boot.pick_window()
        if w:
            st = uia_boot.tree_state(w["hwnd"], 0.6)
            if st in ("shell", "ok"):
                return w, st
        time.sleep(0.4)
    return None, "none"


def poll_until_ok(uia_boot, hwnd, seconds):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if uia_boot.tree_state(hwnd, 0.5) == "ok":
            return True, time.time() - t0
        time.sleep(0.3)
    return False, seconds


def main():
    try:
        os.remove(OUT)
    except OSError:
        pass
    from bridge import uia_boot
    import win32gui
    import win32con

    restart_wechat()
    win, state = wait_shell(uia_boot)
    if not win:
        say("拿不到微信主窗，实验中止")
        return 2
    say("冷状态: pid=%s 树=%s" % (win["pid"], state))
    if state == "ok":
        say("重启后直接就是 ok（说明这台机器上次的状态被继承了），实验没意义，先停下")
        return 3
    hwnd = win["hwnd"]

    # A 拉到前台
    say("--- A: 把窗口拉到前台 ---")
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        say("  已 SetForegroundWindow")
    except Exception as e:
        say("  拉前台失败: %r" % (e,))
    ok, took = poll_until_ok(uia_boot, hwnd, 8)
    say("  A 结果: %s（%.1fs）" % ("树 ok" if ok else "仍是 shell", took))
    if ok:
        say("结论：拉前台就够了，不需要写内存")
        return 0

    # B 写 gate 字节
    say("--- B: 写候选 gate 字节 0xB4F7C08 ---")
    base = win["base"]
    rva = 0xB4F7C08
    handle, err = uia_boot._open_process(win["pid"])
    if not handle:
        say("  OpenProcess 失败 WinError=%s" % err)
    else:
        addr = base + rva
        old = uia_boot._read_byte(handle, addr)
        say("  原字节=%s" % old)
        if uia_boot._write_byte(handle, addr, 1):
            say("  已写 1，观察 8 秒")
            ok, took = poll_until_ok(uia_boot, hwnd, 8)
            say("  B 结果: %s（%.1fs）" % ("树 ok" if ok else "仍是 shell", took))
            if ok:
                say("结论：写 0xB4F7C08 有效，只是需要超过 1.2 秒")
                return 0
            if old is not None:
                uia_boot._write_byte(handle, addr, old)
                say("  已还原为 %s" % old)
        else:
            say("  写入失败")
        uia_boot._close(handle)

    # C 屏幕阅读器标志
    say("--- C: SPI_SETSCREENREADER ---")
    u = ctypes.windll.user32
    u.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
    u.SystemParametersInfoW.restype = wintypes.BOOL
    before = wintypes.BOOL()
    u.SystemParametersInfoW(0x0046, 0, ctypes.byref(before), 0)
    say("  当前值=%s" % before.value)
    for ui_param, pv, winini, desc in (
            (1, None, 0, "uiParam=TRUE,pv=NULL,fWinIni=0"),
            (1, None, 0x03, "uiParam=TRUE,fWinIni=UPDATE|SENDCHANGE"),
            (1, ctypes.byref(wintypes.BOOL(True)), 0, "uiParam=TRUE,pv=&TRUE"),
    ):
        r = u.SystemParametersInfoW(0x0042, ui_param, pv, winini)
        after = wintypes.BOOL()
        u.SystemParametersInfoW(0x0046, 0, ctypes.byref(after), 0)
        say("  %s -> ret=%s 读回=%s" % (desc, r, after.value))
        if r:
            ok, took = poll_until_ok(uia_boot, hwnd, 6)
            say("    C 结果: %s（%.1fs）" % ("树 ok" if ok else "仍是 shell", took))
            if ok:
                say("结论：屏幕阅读器标志有效")
                return 0
            u.SystemParametersInfoW(0x0042, 0, None, 0)
    say("全部失败：三条路都没让树长出来")
    return 1


if __name__ == "__main__":
    sys.exit(main())
