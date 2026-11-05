# -*- coding: utf-8 -*-
"""表情包截图示例 —— 遇到「动画表情」消息时截取其图片

背景：微信 4.x 表情消息在本地数据库中的 content 为加密数据，无法直接
提取原图。因此采用「打开会话 → 滚动到底 → 对最后一条消息区域截图」的
屏幕截图方案（EmojiMessage.capture()），返回 PNG 路径。

用法：
    python demo_emoji_capture.py                     # 默认会话：文件传输助手
    python demo_emoji_capture.py 某个群              # 指定会话
    python demo_emoji_capture.py --listen 某个群     # 监听模式：收到表情自动截图
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

SAVE_DIR = os.path.join(os.path.expanduser("~"), "emoji_capture")


def capture_emoji(msg) -> str | None:
    """对一条表情消息截图，返回 PNG 路径；失败返回 None。

    截图位置根据消息方向自动判断：
    - msg.attr == 'self'  → 右对齐（自己发的）
    - 否则                → 左对齐（对方发的）
    """
    path = msg.capture(save_dir=SAVE_DIR)
    return path


def capture_latest_emoji(wx: WeChat, who: str) -> None:
    """打开会话，截取最新一条表情消息的气泡图片。

    说明：capture() 截图的是屏幕上「最新一条消息」的位置，因此表情
    必须是该会话的最新一条消息才能截到它；否则请用 --listen 模式，
    收到表情时它即为最新一条，可自动截图。
    """
    wx.ChatWith(who)
    time.sleep(0.5)
    msgs = wx.GetAllMessage()  # 新→旧排列，msgs[0] 是会话最新一条
    if not msgs:
        print(f"会话「{who}」没有消息")
        return
    if getattr(msgs[0], "type", None) != "emotion":
        print(f"会话「{who}」最新一条不是表情（是 {msgs[0].type}）")
        print("提示：capture() 只截取最新一条消息，请用 --listen 模式在收到表情时自动截图")
        return
    msg = msgs[0]
    path = capture_emoji(msg)
    if path:
        print(f"[表情截图] 方向={msg.attr} 路径={path}")
    else:
        print("[表情截图] 截图失败（微信窗口是否可见？会话是否在最前？）")


def listen_emoji(wx: WeChat, who: str) -> None:
    """监听模式：实时收到表情消息时自动截图。"""
    def callback(msg, chat):
        if getattr(msg, "type", None) == "emotion":
            path = capture_emoji(msg)
            if path:
                print(f"[收到表情 {msg.attr}] 截图成功 -> {path}")
            else:
                print("[收到表情] 截图失败")

    wx.AddListenChat(who, callback=callback)
    print(f"监听中，Ctrl+C 退出：{who}")
    wx.KeepRunning()


def main():
    args = [a for a in sys.argv[1:]]
    listen = "--listen" in args
    names = [a for a in args if not a.startswith("--")]
    who = names[0] if names else "送你挖银子"

    wx = WeChat()
    print(f"当前登录：{wx.nickname}")

    if listen:
        listen_emoji(wx, who)
    else:
        capture_latest_emoji(wx, who)


if __name__ == "__main__":
    main()
