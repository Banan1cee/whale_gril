# -*- coding: utf-8 -*-
"""wechatauto 复刻版 —— 数据库读取示例程序

基于本地数据库解密，读取微信 4.x 的消息与会话，不依赖 UI 自动化。

使用前提：
    1. 微信 4.x 已登录运行（首次运行时需要从进程内存提取密钥）
    2. 已安装依赖：pip install -e .

用法：
    python demo_db.py
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

from wechatauto import WeChatDB


def show_account(db: WeChatDB):
    info = db.get_self_info()
    print("-" * 60)
    print("当前账号信息")
    print("-" * 60)
    print(f"  微信号 : {info['username']}")
    print(f"  昵称   : {info['nick_name']}")
    print(f"  数据目录: {db.account_dir}")


def show_sessions(db: WeChatDB, limit: int = 8):
    print()
    print("-" * 60)
    print("会话列表（前 %d 条）" % limit)
    print("-" * 60)
    for s in db.get_sessions(limit=limit):
        name = db.get_nickname(s["username"])
        if not s["summary"]:
            continue
        t = time.strftime("%m-%d %H:%M", time.localtime(s["last_time"]))
        unread = f" [未读 {s['unread']}]" if s["unread"] else ""
        print(f"  {name:<20} {t}  {s['summary'][:30]}{unread}")


def show_messages(db: WeChatDB, who: str, limit: int = 10, display_name: str = ""):
    print()
    print("-" * 60)
    print(f"最近消息：{display_name or who}")
    print("-" * 60)
    messages = db.get_messages(who, limit=limit)
    if not messages:
        print("  （没有找到消息，请确认微信号/群号是否正确）")
        return
    for m in reversed(messages):
        t = time.strftime("%m-%d %H:%M", time.localtime(m["create_time"]))
        sender = "我" if m["sender_id"] == 2 else "对方"
        content = m["content"].replace("\n", " ")
        print(f"  [{t}] {sender} [{m['type']}] {content[:60]}")


def main():
    print("正在初始化微信数据库读取器 ...")
    t0 = time.time()
    db = WeChatDB()
    print(f"初始化完成（{time.time() - t0:.1f}s，账号目录：{db.account}）")

    show_account(db)
    show_sessions(db)

    who = input("\n输入会话昵称或微信号（直接回车查看示例会话）：").strip()
    if not who:
        who = "文件传输助手"
        hits = db.search_contact(who)
        if hits:
            who = hits[0]["username"]
    else:
        hits = db.search_contact(who)
        if hits and hits[0]["nick_name"] != who:
            who = hits[0]["username"]
            print(f"  已匹配联系人：{hits[0]['nick_name']}（{who}）")

    show_messages(db, who, display_name=db.get_nickname(who))


if __name__ == "__main__":
    main()
