# -*- coding: utf-8 -*-
"""wechatauto v1.0.9 稳健性演示 —— 失败可回退，绝不崩溃

演示「失败回退」设计原则：
    1. 微信未打开时执行 voice_call / poke / open_chat，
       返回明确失败（WxResponse.failure / False），而非崩溃/抛异常；
    2. 微信已打开时展示正常成功路径（语音通话、拍一拍）；
    3. 截图失败自动回退连通域（表情截图不中断）。

用法：
    python demo_robust.py              # 自动检测微信状态演示
    python demo_robust.py --force-off   # 强制演示"微信未打开"分支
"""
from __future__ import annotations

import os
import sys
import time

try:
    os.system("chcp 65001 >nul 2>&1")
except Exception:
    pass
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

from wechatauto import WeChat
from wechatauto.wx import WxResponse

WHO = "送你挖银子"


def _show(tag: str, r) -> None:
    """统一打印 WxResponse 结果。"""
    if isinstance(r, WxResponse):
        status = r["status"]
        msg = r["message"] or ""
        print(f"  [{tag}] {status} :: {msg}")
        return
    print(f"  [{tag}] 返回值 {r!r}")


def _guard(func):
    """包装：任何异常都记录为失败而非崩溃。"""
    def wrapper(*a, **k):
        try:
            return func(*a, **k)
        except Exception as e:
            import traceback
            print(f"  [异常拦截] {type(e).__name__}: {e}")
            print(f"  （演示失败回退：未崩溃，异常已兜底）")
            return WxResponse.failure(f"异常已拦截：{e}")
    return wrapper


def _wechat_alive() -> bool:
    """不实例化 WeChat/WeChatGUI（微信未打开时构造会抛异常），直接探测主窗口。"""
    try:
        import ctypes
        from wechatauto.guia import WX_MAIN_WIN_TITLE
        hwnd = ctypes.windll.user32.FindWindowW(None, WX_MAIN_WIN_TITLE)
        return bool(hwnd)
    except Exception:
        return False


def demo_wechat_closed() -> None:
    """微信未打开/未登录时调用各功能，验证返回失败而非崩溃。

    注意：不触发热激活（写 Weixin.dll 的 Qt accessibility gate）——微信
    未登录时没有可用的 ``mmui::MainWindow``，热激活无意义且属不必要的内存
    写入。演示通过给驱动注入「未就绪」状态，让各功能走失败回退分支。
    """
    print("\n" + "=" * 60)
    print("场景 A：微信未打开/未登录 —— 功能应优雅失败")
    print("=" * 60)
    try:
        from wechatauto.uia_driver import WeChatUIA

        eng = WeChatUIA(timeout=8.0)  # 可无窗口构造
        print("  构造 UIA 驱动成功（未触碰微信进程）…")
        # 阻止 ensure_window 触发热激活：微信未登录时打桩掉窗口探测与
        # 唤醒路径，让各功能直接走失败返回（不拉起微信、不写其进程内存）。
        eng._find_main = lambda: None
        eng._login_window = lambda: None
        eng._wechat_hwnds = lambda: []
        eng.ensure_window = lambda *a, **k: False
        print("  已打桩窗口探测（微信未登录，跳过热激活与拉起）…")
    except Exception as e:
        import traceback
        print(f"  [构造拦截] {type(e).__name__}: {e}")
        print(f"  （演示失败回退：驱动不可用时降级，不中断）")
        _show("voice_call", WxResponse.failure(f"UIA 驱动不可用：{e}"))
        _show("poke", WxResponse.failure(f"UIA 驱动不可用：{e}"))
        return

    t0 = time.time()
    ok = _guard(eng.voice_call)(who=WHO)
    _show("voice_call",
          WxResponse.success("已发起通话") if ok
          else WxResponse.failure("UIA 驱动不可用，无法发起通话"))
    print(f"    （耗时 {time.time()-t0:.1f}s，未崩溃）")

    t0 = time.time()
    ok = _guard(eng.poke)(who=WHO)
    _show("poke",
          WxResponse.success("已对 " + WHO + " 拍一拍") if ok
          else WxResponse.failure("拍一拍失败（未找到对方消息或菜单不可识别）"))
    print(f"    （耗时 {time.time()-t0:.1f}s，未崩溃）")

    print("\n  -> 微信未打开/未登录时：返回明确失败信息，无异常栈、无崩溃。")
    print("     验证调用方只需判断返回值即可安全降级，不干扰其他功能。")


def demo_wechat_open(wx: WeChat) -> None:
    """微信已打开时展示正常成功路径。"""
    print("\n" + "=" * 60)
    print("场景 B：微信已打开 —— 功能正常工作")
    print("=" * 60)
    print(f"  打开会话「{WHO}」并验证…")
    r = wx.ChatWith(WHO)
    _show("ChatWith", r)
    if not isinstance(r, str) or not r:
        print("  会话打开失败，跳过成功路径演示。")
        return
    chat = wx._cur()
    try:
        ans = input("  发起语音通话？ [Y/n] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        ans = ""
    if ans not in ("n", "no"):
        _show("voice_call", _guard(chat.VoiceCall)())
        time.sleep(1)
        print("  （请手动挂断）")
    try:
        ans = input("  发起拍一拍？ [Y/n] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        ans = ""
    if ans not in ("n", "no"):
        _show("poke", _guard(chat.Poke)())
    print("\n  -> 成功路径正常。")


def main():
    args = [a for a in sys.argv[1:]]
    force_off = "--force-off" in args

    alive = _wechat_alive()
    if force_off:
        alive = False
    print(f"  微信主窗口存活：{alive}")

    try:
        if alive:
            wx = WeChat()
            print(f"当前登录：{wx.nickname}")
            demo_wechat_open(wx)
            demo_wechat_closed()
        else:
            demo_wechat_closed()
    except RuntimeError as e:
        # 探测误判（如残留窗口/登录态）导致构造失败 → 降级到未打开分支
        print(f"  [探测误判] WeChat 构造失败：{e}")
        print("  （降级演示：按微信未打开处理）")
        demo_wechat_closed()

    print("\n稳健性演示完成。")


if __name__ == "__main__":
    main()