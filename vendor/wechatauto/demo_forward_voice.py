# -*- coding: utf-8 -*-
"""wechatauto v1.0.9 转发语音演示 —— 从本地媒体库提取 SILK 并作为文件发送

微信不支持右键直接转发语音消息（无转发入口），本项目实现为：
    「本地媒体库提取 SILK 音频文件 → 以文件消息发送给目标联系人」。

链路：
    1. 打开会话，定位最近一条语音消息（mmui::ChatVoiceItemView / DB 语音）；
    2. MediaDownloader.download_voice 从 media_0.db 提取 voice_data 落盘 .silk；
    3. WeChatGUI.send_file 以文件消息发送给目标。

用法：
    python demo_forward_voice.py                      # 文件传输助手→文件传输助手（安全演示）
    python demo_forward_voice.py --target 豆芽        # 指定转发目标
    python demo_forward_voice.py --who 群名 --target 某人
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

SRC_DEFAULT = "文件传输助手"
TGT_DEFAULT = "文件传输助手"


def main():
    args = [a for a in sys.argv[1:]]
    who = SRC_DEFAULT
    target = TGT_DEFAULT
    if "--who" in args:
        i = args.index("--who")
        who = args[i + 1]
        args = args[:i] + args[i + 2:]
    if "--target" in args:
        i = args.index("--target")
        target = args[i + 1]
        args = args[:i] + args[i + 2:]
    names = [a for a in args if not a.startswith("--")]
    if names:
        who = names[0]

    wx = WeChat()
    print(f"当前登录：{wx.nickname}")
    print(f"语音来源会话：{who}")
    print(f"转发目标：{target}")

    if who != wx._cur().who:
        r = wx.ChatWith(who)
        if not (isinstance(r, str) and r):
            print(f"  打开会话「{who}」失败：{r}")
            sys.exit(1)

    chat = wx._cur()
    msgs = chat.GetAllMessage()
    voice = None
    for m in msgs:
        if getattr(m, "type", None) == "voice":
            voice = m
            break
    if voice is None:
        print(f"  会话「{who}」最近 50 条中没有语音消息，无法演示。")
        sys.exit(1)
    print(f"  找到语音消息：local_id={voice.local_id} 方向={voice.attr}")

    t0 = time.time()
    r = voice.forward_to(target)
    print(f"  转发 => {r['status']} :: {r['message']} ({time.time()-t0:.1f}s)")
    data = r.get("data") or {}
    path = data.get("path")
    if path:
        print(f"  本地语音文件：{path}")

    print("\n转发完成。")


if __name__ == "__main__":
    main()