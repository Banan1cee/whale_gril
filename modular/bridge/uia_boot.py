#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UIA 自检与自动物化（微信 4.x，含 4.2.0.9）。

为什么要有这个文件，而不是直接用 wechatauto 的 `_hot_activate_accessibility`：

1. **窗口句柄会过期。** 微信更新/重启后窗口重开，桥接手里攥着旧 hwnd 时，
   第三方库会照着那个 hwnd 去取 PID，然后对着一个不相干的进程报
   「热激活 UIA 失败：PID xxx 未找到 Weixin.dll」，而且每 4 秒重试一次，
   整场退回 OCR。实测日志：连续 7 次同一个不存在的 PID。
2. **它的成功判据太弱。** `_mmui_present()` 只看根窗口类名是不是 `mmui::`，
   可 4.2 的根窗口类名本来就叫 `mmui::MainWindow`（空壳也是），于是写错字节
   也会判成功，字节留在 1，后面再也不重试。
3. **版本表没有 4.2.0.9。** 只能靠特征扫描，扫出来的第一个候选不一定是真的
   那个 gate；至少要"写进去→看会话列表有没有出来→不对就还原"地挨个试。

所以这里做三件事：挑对窗口（PID 里真有 Weixin.dll）、用真判据校验（树里真有
`mmui::ChatSessionList`）、挨个试候选 RVA 并把成功的那个写进库缓存。
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import time
from ctypes import wintypes
from typing import Dict, List, Optional, Tuple

# 树里出现这些类名，才算「会话列表真的物化了」。只看根窗口类名不算。
TREE_MARKERS = (
    "mmui::ChatSessionList",
    "mmui::XTableView",
    "mmui::ChatSessionCell",
)

# 已知「扫描扫不出来、但实测可用」的兜底 RVA。键是 Weixin.dll 的版本目录名。
# 4.2.0.9 目前靠库缓存的 verified 值（0xB4F7C08）工作；表里留空是为了不写死，
# 真命中了再补。
KNOWN_GATE_RVA: Dict[str, int] = {}

_BAD_CLASS = (
    "trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd",
    "default ime", "notifyicon",
)


# ── 挑窗口 ─────────────────────────────────────────────────────────
def _iter_windows() -> List[dict]:
    """所有候选主窗（不过滤 PID 有没有 Weixin.dll）。"""
    try:
        import win32gui
        import win32process
        import psutil
    except Exception:
        return []

    out: List[dict] = []
    BAD = _BAD_CLASS

    def cb(h, _):
        try:
            title = (win32gui.GetWindowText(h) or "").strip()
            cls = win32gui.GetClassName(h) or ""
            low = cls.lower()
            if any(b in low for b in BAD):
                return True
            _, pid = win32process.GetWindowThreadProcessId(h)
            if pid <= 0:
                return True
            try:
                name = psutil.Process(pid).name().lower()
            except Exception:
                return True
            if not name.startswith("weixin"):
                return True
            rect = win32gui.GetWindowRect(h)
            area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
            out.append({
                "hwnd": int(h),
                "pid": int(pid),
                "title": title,
                "cls": cls,
                "area": area,
                "foreground": bool(win32gui.GetForegroundWindow() == h),
                "minimized": bool(win32gui.IsIconic(h)),
            })
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(cb, None)
    except Exception:
        return []
    return out


def pick_window(prefer_hwnd: int = 0) -> Optional[dict]:
    """挑一个「PID 里真的加载了 Weixin.dll」的微信主窗。

    优先级：调用方钉住的窗口 → 标题正好是「微信」→ 前台 → 面积大。
    任何一个候选只要 PID 里没有 Weixin.dll（渲染子进程/辅助进程/已被回收的
    句柄），直接排除 —— 这正是旧日志里「未找到 Weixin.dll」的来源。
    """
    try:
        from wechatauto.accessibility import AccessibilityGate as G
    except Exception:
        return None

    wins = _iter_windows()
    if not wins:
        return None

    scored = []
    for w in wins:
        mod = G._weixin_dll_module(w["pid"])
        if not mod:
            continue
        base, _size, dll = mod
        try:
            import os
            version = os.path.basename(os.path.dirname(dll))
        except Exception:
            version = ""
        w = dict(w)
        w["base"] = int(base)
        w["dll"] = dll
        w["version"] = version
        score = 0
        if prefer_hwnd and w["hwnd"] == int(prefer_hwnd):
            score += 10 ** 9
        if w["title"] == "微信":
            score += 10 ** 6
        if w["foreground"]:
            score += 10 ** 4
        if "QWindowIcon" in w["cls"] or w["cls"].startswith("mmui::"):
            score += 10 ** 3
        score += min(w["area"], 10 ** 6)
        scored.append((score, w))

    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]



# 每个线程都要先 CoInitialize 才能用 UIA；不然会刷
# "Can not load UIAutomationCore.dll" 并且永远拿不到控件。
_UIA_THREADS = set()


def _ensure_com() -> bool:
    try:
        import uiautomation as auto
    except Exception:
        return False
    import threading
    tid = threading.get_ident()
    if tid in _UIA_THREADS:
        return True
    try:
        auto.InitializeUIAutomationInCurrentThread()
    except Exception:
        try:
            import comtypes
            comtypes.CoInitializeEx()
        except Exception:
            return False
    _UIA_THREADS.add(tid)
    return True

# ── 判据 ───────────────────────────────────────────────────────────
def tree_state(hwnd: int, timeout: float = 1.0, max_nodes: int = 1200) -> str:
    """看控件树到底物化了没有：'ok' / 'shell' / 'unreachable'。

    'shell' = 只有 Qt 空壳（根窗口类名是 mmui:: 但里面没有会话列表）。
    """
    try:
        import uiautomation as auto
    except Exception:
        return "unreachable"
    if not _ensure_com():
        return "unreachable"
    deadline = time.time() + max(0.2, timeout)
    while True:
        try:
            root = auto.ControlFromHandle(hwnd)
        except Exception:
            root = None
        if root is not None:
            break
        if time.time() >= deadline:
            return "unreachable"
        time.sleep(0.15)

    seen = 0
    stack = [(root, 0)]
    while stack and seen < max_nodes:
        node, depth = stack.pop()
        try:
            kids = node.GetChildren()
        except Exception:
            kids = []
        seen += len(kids)
        for k in kids:
            try:
                cn = getattr(k, "ClassName", "") or ""
            except Exception:
                cn = ""
            if any(cn == m for m in TREE_MARKERS):
                return "ok"
            if depth < 12:
                stack.append((k, depth + 1))
    return "shell"



# ── 让微信把窗口"正常打开" ──────────────────────────────────────────
_LAST_RESTORE = [0.0]


def restore_wechat(win: dict, log=None, wait: float = 15.0, hide_after: bool = False) -> bool:
    """微信缩在托盘时，主窗被隐藏、UI 子树被销毁，UIA 必然拿不到。

    单纯 ShowWindow / SetForegroundWindow / 点任务栏按钮都试过，都不重建子树；
    但**再拉起一次 Weixin.exe** 会走单实例转发，效果等同于用户点托盘图标：
    窗口恢复、Qt 重新建树。实测 4.2.0.9：1 秒内树就从 shell 变 ok。

    hide_after=False（默认）：把窗口**留在屏幕上**，UIA 才有稳定的控件树，
    用户也能直接看到微信。hide_after=True 才会建完树再收回去（树不会塌）。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    if not win:
        return False

    hwnd = win["hwnd"]
    # 15 秒内只唤起一次：两次 ensure 并发时重复拉起会被微信忽略，反而拖慢
    now = time.time()
    if now - _LAST_RESTORE[0] < 15:
        deadline = now + 2.0
        while time.time() < deadline:
            if tree_state(hwnd, timeout=0.5) == "ok":
                return True
            time.sleep(0.3)
        return False
    _LAST_RESTORE[0] = now

    try:
        import psutil
        exe = None
        try:
            exe = psutil.Process(int(win["pid"])).exe()
        except Exception:
            exe = None
        if not exe or not os.path.exists(exe):
            say("UIA 自检：找不到 Weixin.exe 路径，没法自动打开微信窗口")
            return False

        say("UIA 自检：微信窗口是隐藏的（托盘态），自动唤起一次让它重建控件树…")
        subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    except Exception as e:                      # noqa: BLE001
        say("UIA 自检：唤起微信失败：%r" % (e,))
        return False

    # 记下原来的可见状态和位置：唤起来之后要尽量恢复原样，别把用户的屏幕占掉
    was_visible, rect = True, None
    try:
        import win32gui
        was_visible = bool(win32gui.IsWindowVisible(hwnd))
        rect = win32gui.GetWindowRect(hwnd)
    except Exception:
        pass

    deadline = time.time() + max(1.0, wait)
    ok = False
    while time.time() < deadline:
        # 唤起之后微信可能换了新窗口（旧句柄留着但没树），所以每轮重新挑一次
        w2 = pick_window()
        if w2 and tree_state(w2["hwnd"], timeout=0.5) == "ok":
            win.update(w2)
            hwnd = w2["hwnd"]
            ok = True
            break
        time.sleep(0.4)
    if not ok:
        if callable(log):
            log("UIA 自检：唤起了微信，但 %.0f 秒内控件树没出来" % wait)
        return False

    if not hide_after:
        # 需求：微信在托盘时要让它显示出来，并且建完树之后**不能再缩回托盘**
        _keep_visible(win, log)
        return True

    # hide_after=True：建完树再收回托盘。
    # 实测 4.2：隐藏之后控件树仍然在（不会塌），所以后续发送照样能用 UIA。
    if not was_visible:
        try:
            import win32gui
            import win32con
            hwnd = win.get("hwnd") or hwnd
            if rect:
                win32gui.SetWindowPos(hwnd, 0, rect[0], rect[1], 0, 0,
                                      win32con.SWP_NOACTIVATE | win32con.SWP_NOZORDER |
                                      win32con.SWP_NOSIZE)
            win32gui.ShowWindow(hwnd, win32con.SW_HIDE)
            time.sleep(0.3)
            if tree_state(hwnd, timeout=0.6) != "ok":
                # 万一这个版本隐藏就塌，退而求其次：摆到屏幕外，别挡人
                win32gui.SetWindowPos(hwnd, 0, -3000, -3000,
                                      max(1, rect[2] - rect[0]) if rect else 800,
                                      max(1, rect[3] - rect[1]) if rect else 600,
                                      win32con.SWP_SHOWWINDOW | win32con.SWP_NOACTIVATE)
                if callable(log):
                    log("UIA 自检：这个微信版本隐藏后控件树会塌，已把窗口放到屏幕外")
        except Exception:
            pass
    return True


def _weixin_exe() -> str:
    """从正在运行的 Weixin.exe 里取安装路径（窗口消失时 pick_window 拿不到 pid）。"""
    try:
        import psutil
    except Exception:
        return ""
    for p in psutil.process_iter(["name", "exe"]):
        try:
            if (p.info.get("name") or "").lower() == "weixin.exe":
                exe = p.info.get("exe") or ""
                if exe and os.path.exists(exe):
                    return exe
        except Exception:
            continue
    # 兜底：常见安装路径
    for cand in (r"C:\Program Files\Tencent\Weixin\Weixin.exe",
                 r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe"):
        if os.path.exists(cand):
            return cand
    return ""


def launch_wechat(log=None, wait: float = 15.0):
    """微信没有主窗（彻底缩在托盘/窗口被销毁）时，把它拉起来。

    返回 (win, already_ok)。win 是拉起后 pick_window() 的结果，可能为 None。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    exe = _weixin_exe()
    if not exe:
        say("UIA 自检：找不到 Weixin.exe，无法打开微信窗口")
        return None, False
    say("UIA 自检：微信没有主窗（缩在托盘），自动打开一次…")
    try:
        subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    except Exception as e:                      # noqa: BLE001
        say("UIA 自检：打开微信失败：%r" % (e,))
        return None, False

    deadline = time.time() + max(2.0, wait)
    win = None
    while time.time() < deadline:
        win = pick_window()
        if win and tree_state(win["hwnd"], timeout=0.6) == "ok":
            close_stray_login_windows(win["hwnd"])
            return win, True
        time.sleep(0.4)
    return win, False

# ── 物化 ───────────────────────────────────────────────────────────
def _open_process(pid: int):
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                      ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.WriteProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    # PROCESS_QUERY_INFORMATION | VM_OPERATION | VM_READ | VM_WRITE
    handle = k32.OpenProcess(0x0400 | 0x0008 | 0x0010 | 0x0020, False, pid)
    return (handle or 0), ctypes.get_last_error()


def _read_byte(h, addr: int) -> Optional[int]:
    k32 = ctypes.windll.kernel32
    buf = (ctypes.c_ubyte * 1)()
    n = ctypes.c_size_t()
    ok = k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, 1, ctypes.byref(n))
    return int(buf[0]) if ok else None


def _write_byte(h, addr: int, value: int) -> bool:
    k32 = ctypes.windll.kernel32
    buf = (ctypes.c_ubyte * 1)(value)
    n = ctypes.c_size_t()
    return bool(k32.WriteProcessMemory(h, ctypes.c_void_p(addr), buf, 1, ctypes.byref(n)))


def _close(h) -> None:
    try:
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(h))
    except Exception:
        pass


def candidate_rvas(dll: str, version: str) -> List[int]:
    """候选 gate RVA：版本表 → 已知兜底 → 库的扫描结果（去重保序）。"""
    out: List[int] = []
    try:
        from wechatauto.accessibility import (
            AccessibilityGate as G,
            QACCESSIBLE_ACTIVE_RVA_BY_VERSION,
        )
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(version)
        if known is not None:
            out.append(int(known))
        if version in KNOWN_GATE_RVA:
            out.append(int(KNOWN_GATE_RVA[version]))
        try:
            out.extend(int(x) for x in (G._qaccessible_candidate_rvas(dll) or ()))
        except Exception:
            pass
    except Exception:
        return []
    seen = set()
    uniq = []
    for rva in out:
        if rva in seen or rva <= 0:
            continue
        seen.add(rva)
        uniq.append(rva)
    return uniq




def close_stray_login_windows(keep_hwnd: int) -> None:
    """关掉「多拉起来的那一个」登录小窗。

    拉起 Weixin.exe 偶尔会另开一个实例（主实例正在退出/重建时会这样），
    留下一个 300x400 的登录窗。判据三条同时满足才关，避免误杀第二个真账号：
    标题是「微信」、控件树是空壳、窗口尺寸小于 480x520。
    """
    try:
        import win32gui
        import os
        for w in _iter_windows():
            if int(w["hwnd"]) == int(keep_hwnd) or w["title"] != "微信":
                continue
            rect = win32gui.GetWindowRect(w["hwnd"])
            bw, bh = rect[2] - rect[0], rect[3] - rect[1]
            if bw >= 480 and bh >= 520:
                continue          # 像正经主窗，不碰
            if tree_state(w["hwnd"], 0.4) == "ok":
                continue          # 已经有树，是正在用的号
            try:
                win32gui.PostMessage(w["hwnd"], 0x0010, 0, 0)   # WM_CLOSE
            except Exception:
                pass
    except Exception:
        pass


def _keep_visible(win: dict, log=None) -> None:
    """把窗口摆回可见位置并显示出来（测试期间可能被挪到屏幕外）。"""
    try:
        import win32gui
        import win32con
        hwnd = int(win["hwnd"])
        rect = win32gui.GetWindowRect(hwnd)
        x, y = rect[0], rect[1]
        # 只改位置和可见性，**绝不改尺寸**：实测改尺寸会让微信重建窗口、
        # 控件树直接塌回空壳（这一条把发送测试坑了一整轮）。
        if x < -200 or y < -200 or rect[2] <= rect[0]:
            x, y = 120, 80
            win32gui.SetWindowPos(hwnd, 0, x, y, 0, 0,
                                  win32con.SWP_NOZORDER | win32con.SWP_NOSIZE |
                                  win32con.SWP_SHOWWINDOW)
        else:
            win32gui.SetWindowPos(hwnd, 0, x, y, 0, 0,
                                  win32con.SWP_NOZORDER | win32con.SWP_NOSIZE |
                                  win32con.SWP_SHOWWINDOW)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if callable(log):
            log("UIA 自检：微信窗口已显示并留在屏幕上")
    except Exception:
        pass


def ensure(prefer_hwnd: int = 0, log=None, max_candidates: int = 6,
           settle: float = 1.2) -> dict:
    """确保 UIA 树可用。返回 {ok, reason, hwnd, pid, version, rva, tree}。

    reason 取值：
      already          本来就好
      activated        本次写 gate 成功，树出来了
      no_window        没找到「PID 里带 Weixin.dll」的微信主窗
      denied           OpenProcess 被拒（微信是管理员，桥接不是）
      no_candidates    这个版本没有可用的候选 RVA
      not_materialized 候选都写了，树还是空壳
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    win = pick_window(prefer_hwnd)
    if not win:
        # 微信彻底缩进托盘时主窗会被销毁，pick_window 什么都拿不到 —— 直接拉起来
        win, ok = launch_wechat(log=log)
        if ok:
            say(f"UIA 自检：微信 {win.get('version')} 已打开，控件树就绪")
            _keep_visible(win, log)
            return {"ok": True, "reason": "restored", "hwnd": win["hwnd"], "pid": win["pid"],
                    "version": win.get("version"), "tree": "ok"}
        if not win:
            say("UIA 自检：没找到微信主窗（PID 里没有 Weixin.dll 的窗口一个都没有）")
            return {"ok": False, "reason": "no_window"}

    hwnd, pid, version = win["hwnd"], win["pid"], win.get("version") or ""
    state = tree_state(hwnd, timeout=0.8)
    if state == "ok":
        return {"ok": True, "reason": "already", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}

    # 4.2 上最常见的情形：窗口缩在托盘里，UI 子树被销毁 → 先让它正常打开一次
    if restore_wechat(win, log=log):
        say(f"UIA 自检：微信 {version} 窗口已唤起，控件树重建成功")
        return {"ok": True, "reason": "restored", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": "ok"}

    handle, err = _open_process(pid)
    if not handle:
        say(f"UIA 自检：打不开 Weixin.exe PID {pid}（WinError {err}）"
            + ("——桥接需要和微信同级，请用管理员权限启动桥接" if err == 5 else ""))
        return {"ok": False, "reason": "denied", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state, "winerror": err}

    rvas = candidate_rvas(win["dll"], version)
    if not rvas:
        _close(handle)
        say(f"UIA 自检：微信 {version} 没有可用候选 RVA（库版本表 + 特征扫描都空）")
        return {"ok": False, "reason": "no_candidates", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}

    base = win["base"]
    try:
        for rva in rvas[:max_candidates]:
            addr = base + rva
            current = _read_byte(handle, addr)
            if current is None:
                continue
            wrote = False
            if current != 1:
                if not _write_byte(handle, addr, 1):
                    continue
                wrote = True
            # 等树长出来（有的机器要 0.5~1 秒）
            deadline = time.time() + settle
            ok = False
            while time.time() < deadline:
                if tree_state(hwnd, timeout=0.5) == "ok":
                    ok = True
                    break
                time.sleep(0.2)
            if ok:
                _remember(win["dll"], rva)
                say(f"UIA 自检：微信 {version} 物化成功（Weixin.dll+0x{rva:x}），"
                    f"gate 字节 {current} -> 1")
                return {"ok": True, "reason": "activated", "hwnd": hwnd, "pid": pid,
                        "version": version, "rva": rva, "tree": "ok"}
            if wrote:
                _write_byte(handle, addr, current)   # 不对就还原，别留副作用
        # 唤起/写字节都可能慢一拍：最后再挑一次窗口确认一遍，别急着判死
        w2 = pick_window()
        if w2 and tree_state(w2["hwnd"], timeout=1.0) == "ok":
            win.update(w2)
            say(f"UIA 自检：延迟生效，微信 {version} 控件树已就绪")
            return {"ok": True, "reason": "restored", "hwnd": w2["hwnd"], "pid": w2["pid"],
                    "version": version, "tree": "ok"}
        say(f"UIA 自检：微信 {version} 试了 {len(rvas[:max_candidates])} 个候选 RVA，"
            f"树仍是空壳（候选：{[hex(x) for x in rvas[:max_candidates]]}）")
        return {"ok": False, "reason": "not_materialized", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}
    finally:
        _close(handle)


def _remember(dll: str, rva: int) -> None:
    """把验证成功的 RVA 写进 wechatauto 的 gate 缓存，下次启动零扫描直接命中。"""
    try:
        from wechatauto.accessibility import _dll_identity, _gate_cache_put
        _gate_cache_put(_dll_identity(dll), verified=int(rva))
    except Exception:
        pass


def describe(res: dict) -> str:
    """把 ensure() 的结果翻成一句人话，给桥接日志用。"""
    if not res:
        return "UIA 自检：没有结果"
    if res.get("ok"):
        if res.get("reason") == "already":
            return "UIA 可用（树本来就在）"
        if res.get("reason") == "restored":
            return f"UIA 可用（微信窗口原本在托盘里，已自动唤起并重建控件树，{res.get('version')}）"
        return f"UIA 可用（已物化，微信 {res.get('version')}，RVA {hex(res.get('rva') or 0)}）"
    reason = res.get("reason")
    if reason == "no_window":
        return "UIA 不可用：没找到微信主窗（微信没开？或用的是别的账号窗口）"
    if reason == "denied":
        return "UIA 不可用：没有权限改微信进程标志位（桥接要以管理员运行）"
    if reason == "no_candidates":
        return f"UIA 不可用：微信 {res.get('version')} 这个版本库还不支持（等库更新）"
    if reason == "not_materialized":
        return f"UIA 不可用：候选 RVA 都没让控件树出来（微信 {res.get('version')}）"
    return "UIA 不可用：" + str(reason)
