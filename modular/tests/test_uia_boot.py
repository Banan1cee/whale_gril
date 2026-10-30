#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""uia_boot 的离线单测：不碰真微信，只验挑窗口/去重/人话。

跑法：python -B tests/test_uia_boot.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from bridge import uia_boot


def test_pick_window_skips_pid_without_dll():
    windows = [
        {"hwnd": 1, "pid": 100, "title": "微信", "cls": "Qt51514QWindowIcon", "area": 900, "foreground": True, "minimized": False},
        {"hwnd": 2, "pid": 200, "title": "微信", "cls": "Qt51514QWindowIcon", "area": 100, "foreground": False, "minimized": False},
    ]
    dlls = {100: None, 200: (0x140000000, 1, r"C:\Program Files\Tencent\Weixin\4.2.0.9\Weixin.dll")}

    orig_iter = uia_boot._iter_windows
    uia_boot._iter_windows = lambda: windows
    try:
        from wechatauto.accessibility import AccessibilityGate as G
        orig_mod = G._weixin_dll_module
        G._weixin_dll_module = staticmethod(lambda pid: dlls.get(pid))
        try:
            win = uia_boot.pick_window()
            assert win is not None, "应该挑到 pid=200 的窗口"
            assert win["hwnd"] == 2, win
            assert win["version"] == "4.2.0.9", win

            # prefer_hwnd 指向没有 DLL 的那个：不能被它带偏
            win2 = uia_boot.pick_window(prefer_hwnd=1)
            assert win2["hwnd"] == 2, win2

            # 只钉住一个也没关系
            win3 = uia_boot.pick_window(prefer_hwnd=2)
            assert win3["hwnd"] == 2

            # 全都没有 DLL：必须返回 None，而不是瞎挑一个
            dlls[200] = None
            assert uia_boot.pick_window() is None
        finally:
            G._weixin_dll_module = orig_mod
    finally:
        uia_boot._iter_windows = orig_iter


def test_candidate_rvas_dedupe_and_order():
    from wechatauto.accessibility import AccessibilityGate as G
    orig = G._qaccessible_candidate_rvas
    G._qaccessible_candidate_rvas = staticmethod(lambda dll: [0xB4F4B08, 0xB4F7C08, 0xB4F4B08])
    orig_known = dict(uia_boot.KNOWN_GATE_RVA)
    uia_boot.KNOWN_GATE_RVA.clear()
    try:
        rvas = uia_boot.candidate_rvas(r"C:\x\4.2.0.9\Weixin.dll", "4.2.0.9")
        assert rvas == [0xB4F4B08, 0xB4F7C08], [hex(x) for x in rvas]

        uia_boot.KNOWN_GATE_RVA["4.2.0.9"] = 0xB4F7C08
        rvas = uia_boot.candidate_rvas(r"C:\x\4.2.0.9\Weixin.dll", "4.2.0.9")
        assert rvas[0] == 0xB4F7C08, [hex(x) for x in rvas]
        assert len(rvas) == 2, [hex(x) for x in rvas]
    finally:
        G._qaccessible_candidate_rvas = orig
        uia_boot.KNOWN_GATE_RVA.clear()
        uia_boot.KNOWN_GATE_RVA.update(orig_known)


def test_describe_is_human():
    assert "UIA 可用" in uia_boot.describe({"ok": True, "reason": "already"})
    assert "已物化" in uia_boot.describe({"ok": True, "reason": "activated", "version": "4.2.0.9", "rva": 0xB4F7C08})
    assert "没找到微信主窗" in uia_boot.describe({"ok": False, "reason": "no_window"})
    assert "管理员" in uia_boot.describe({"ok": False, "reason": "denied"})
    assert "4.2.0.9" in uia_boot.describe({"ok": False, "reason": "no_candidates", "version": "4.2.0.9"})
    assert "空壳" not in uia_boot.describe({"ok": False, "reason": "not_materialized", "version": "4.2.0.9"})
    assert "微信 4.2.0.9" in uia_boot.describe({"ok": False, "reason": "not_materialized", "version": "4.2.0.9"})


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print("全部通过：%d 项" % len(tests))


if __name__ == "__main__":
    main()
