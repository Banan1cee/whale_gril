# -*- coding: utf-8 -*-
"""reply_msg / at_member 实测脚本（对应 README §7 待实测功能）"""
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

from wechatauto.guia import WeChatGUI
from wechatauto.db import WeChatDB


def db_latest(who, n=5):
    """数据库读回最近 n 条，交叉验证发送结果。"""
    try:
        db = WeChatDB()
        hits = db.search_contact(who)
        if not hits:
            return []
        msgs = db.get_messages(hits[0]["username"], limit=n)
        return [f"[{time.strftime('%H:%M:%S', time.localtime(m['create_time']))}] "
                f"{'我' if m['sender_id'] == 2 else '对方'} {m['content'][:40]}"
                for m in reversed(msgs)]
    except Exception as e:
        return [f"（读回失败：{e}）"]


def main():
    wx = WeChatGUI()

    # ========== 1. reply_msg：回复最近一条消息 ==========
    who = "文件传输助手"
    print("=" * 60)
    print(f"[1] reply_msg 回复最近一条消息（会话：{who}）")
    print("=" * 60)
    print("数据库当前最近 3 条：")
    for line in db_latest(who, 3):
        print("   ", line)

    r = wx.reply_msg("这是自动回复测试 [reply]", who=who, verify=True)
    print(f"\nreply_msg 结果：\n  ok={r.is_success}\n  消息={r['message']}\n  数据={r['data']}")

    print("\n发送后数据库最近 5 条：")
    for line in db_latest(who, 5):
        print("   ", line)

    # ========== 2. at_member：群聊 @ 成员（改你实际的群名和成员） ==========
    group = "STABLE一1一161008"          # ← 改成你的群名
    member = "文件传输助手"              # ← 改成群内的成员名
    print("\n" + "=" * 60)
    print(f"[2] at_member 群聊 @ 成员（群：{group}，成员：{member}）")
    print("=" * 60)

    r2 = wx.at_member(member, "大家看下这条 @ 测试", who=group, verify=True)
    print(f"at_member 结果：\n  ok={r2.is_success}\n  消息={r2['message']}\n  数据={r2['data']}")

    print("\n发送后数据库最近 5 条：")
    for line in db_latest(group, 5):
        print("   ", line)

    print("\n完成。若 ok=False，请把打印的失败信息贴出来。")

if __name__ == "__main__":
    main()
