"""发送前回读校验（``WxParam.SEND_CONTENT_RATIO``）的演示与实测脚本。

四档，按破坏性从低到高。**read 档不点击、不打键盘**（但默认会像 demo_send 那样
在树未物化时热激活 gate，要完全被动就加 ``--no-wake``）：

    python -m wechatauto.demo_send_verify --level read     # 只读：树状态 + 输入框暴不暴露值
    python -m wechatauto.demo_send_verify --level land     # 粘贴但不回车：看读回值与相似度
    python -m wechatauto.demo_send_verify --level negate   # 复现「Ctrl+V 送给空气」：应当不回车
    python -m wechatauto.demo_send_verify --level full     # 真发到文件传输助手并回读确认

land / negate / full 会动你的微信界面，先确认没有别的机器人在跑同一个窗口。
"""
from __future__ import annotations

import argparse
import ctypes
import time

from wechatauto.param import WxParam
from wechatauto.uia_driver import WeChatUIA

SAMPLE = "回读校验演示 13:37\n第二行，带表情码[微笑]"
WHO = "文件传输助手"


def header(title: str):
    print("\n" + "=" * 68)
    print(title)
    print("=" * 68)


def read_only(uia: WeChatUIA):
    header("档 read：不点击、不打键、不抢前台")
    u = ctypes.windll.user32
    hwnd = getattr(getattr(uia, "_win", None), "NativeWindowHandle", 0) if uia._win else 0
    print("微信主窗口 hwnd      :", hwnd or "(未取到)")
    print("当前前台 hwnd       :", u.GetForegroundWindow(),
          "（== 微信 → 已激活）" if u.GetForegroundWindow() == hwnd else "（≠ 微信 → 未激活）")
    print("UIA 树是否已物化     :", uia.is_materialized())
    print("阈值 SEND_CONTENT_RATIO:", WxParam.SEND_CONTENT_RATIO)

    box = uia._chat_input()
    if box is None:
        print("输入框控件          : 没找到（当前界面可能不在聊天页）")
        return None
    print("输入框控件 ClassName :", getattr(box, "ClassName", "?"))
    got = uia._read_edit_value(box)
    print("输入框读回值         :", repr(got))
    if got is None:
        print("  → 该控件不暴露 ValuePattern/LegacyIAccessible，回读校验会退化成放行。")
        print("    这条要记下来：校验在这种情况下拦不住任何东西。")
    else:
        print("  → 能读回内容，回车前的比对是真比对。")
    return box


def paste_without_enter(uia: WeChatUIA, box):
    header("档 land：粘进输入框但不回车，打印读回与相似度")
    uia._paste_into(box, SAMPLE, clear=True)
    time.sleep(0.3)
    ok, got, score = uia._paste_landed(box, SAMPLE)
    print("传入        :", repr(SAMPLE))
    print("读回        :", repr(got))
    print("相似度      : %.3f（阈值 %.2f）→ %s"
          % (score, WxParam.SEND_CONTENT_RATIO, "达标" if ok else "不达标"))
    print("是否回车      : 否（这一档只看不发）")
    try:
        box.SendKeys("{Ctrl}a{Delete}", waitTime=0.05)
        print("已清空输入框  : 是")
    except Exception as e:
        print("清空输入框失败:", e)
    if "￼" in (got or ""):
        print("读回值里的 ￼(U+FFFC) = 微信把表情码渲染成图片后的占位符；"
              "比对前已按它折算，所以相似度不会因此掉下去。")
    elif "[微笑]" in (got or ""):
        print("读回值里 [微笑] 是原样文本 —— 该客户端没把它转成占位符，折算两侧一致，同样能对上。")


def negate(uia: WeChatUIA):
    """判据级复现「送给空气」：真点击、真按 Ctrl+V，但剪贴板是空的。

    这里**故意不走 send_text**：万一判据失灵，send_text 会真的按回车把消息发出去。
    用同一套 `_paste_into` + `_paste_landed`，物理上碰不到回车，结论等价
    （send_text 里回车与否就取决于这一个 bool，那段控制流已由离线用例覆盖）。
    """
    header("档 negate：模拟粘贴落空（不投递回车，发不出去）")
    box = uia._chat_input()
    if box is None:
        print("没有输入框控件，终止")
        return
    text = "这条不应该发出去"
    uia._clip_set("")                        # 先把剪贴板真的清空
    uia._clip_set = lambda t: None           # 再让后续写入变成空操作
    try:
        uia._paste_into(box, text, clear=True)   # 真点击 + 真 Ctrl+V
        time.sleep(0.3)
        ok, got, score = uia._paste_landed(box, text)
        box.SendKeys("{Ctrl}a{Delete}", waitTime=0.05)   # 拦下时 send_text 会做的收尾
    finally:
        del uia._clip_set                    # 恢复类上的静态方法
    print("传入      :", repr(text))
    print("读回      :", repr(got))
    print("相似度    : %.3f（阈值 %.2f）" % (score, WxParam.SEND_CONTENT_RATIO))
    print("send_text 在此情形会 : %s"
          % ("照常回车发送（闸失效）" if ok else "拦下：不回车 + 清空输入框"))
    print("输入框已清空，全程没投递 {Enter}")


def full(uia: WeChatUIA):
    header("档 full：真发到 %s" % WHO)
    if not uia.open_chat(WHO):
        print("打不开会话，终止")
        return
    now = uia.current_chat()
    print("当前会话      :", now)
    if now != WHO:
        print("终止：当前会话不是「%s」，不做任何发送" % WHO)
        return
    t0 = time.time()
    r = uia.send_text(SAMPLE)
    print("send_text   :", r, "(%.1fs)" % (time.time() - t0))
    if r:
        time.sleep(1.5)
        print("DB 回读确认   : 用 wechatauto.db.WeChatDB().get_messages('%s', limit=1)" % WHO)


def main():
    ap = argparse.ArgumentParser(description="发送前回读校验演示")
    ap.add_argument("--level", default="read", choices=["read", "land", "negate", "full"])
    ap.add_argument("--ratio", type=float, default=None,
                    help="临时覆盖 WxParam.SEND_CONTENT_RATIO（<=0 关闭校验）")
    ap.add_argument("--no-wake", action="store_true",
                    help="冷态（树未物化）时不去热激活 gate，直接退出")
    args = ap.parse_args()
    if args.ratio is not None:
        WxParam.SEND_CONTENT_RATIO = args.ratio

    uia = WeChatUIA()
    if args.level == "read":
        # 冷态要先热激活 gate（写那个 byte 不需要前台），但 read 档不抢前台。
        w = uia._find_main()
        if w is None and not args.no_wake:
            print("UIA 树未物化，先热激活 gate（不碰前台）…")
            if uia.ensure_materialized(timeout=6.0):
                w = uia._find_main()
        if w is None:
            print("拿不到 mmui 树。微信没登录？还是你加了 --no-wake 而它正好是冷态？")
            print("  去掉 --no-wake 即可像 demo_send 那样自动热激活。")
            raise SystemExit(2)
        uia._win = w
        read_only(uia)
        return

    # 动作档：要焦点，走正常路径（ensure_window 内部会 _activate 抢前台）
    if not uia.ensure_window(wake=True):
        print("拿不到微信主窗口或热激活失败（微信没登录？）")
        raise SystemExit(2)
    # 只允许动文件传输助手：先把它打开，避免误在别的会话里粘贴/发送
    if not uia.open_chat(WHO):
        print("打不开「%s」，终止（不动当前别的会话）" % WHO)
        raise SystemExit(2)
    print("当前会话:", uia.current_chat(), "（应为 %s）" % WHO)

    if args.level == "land":
        box = read_only(uia) or uia._chat_input()
        if box is None:
            print("没有输入框控件，终止")
            raise SystemExit(2)
        paste_without_enter(uia, box)
    elif args.level == "negate":
        read_only(uia)
        negate(uia)
    else:
        read_only(uia)
        full(uia)


if __name__ == "__main__":
    main()
