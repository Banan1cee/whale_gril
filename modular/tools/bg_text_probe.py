#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后台通道发文字乱码排查：发一条已知文本，再从微信数据库读回来看它到底变成了什么。

用法：
    runtime\\python\\python.exe -B tools\\bg_text_probe.py            # 用当前 GBK 字节法
    runtime\\python\\python.exe -B tools\\bg_text_probe.py --utf16    # 用 UTF-16 码元法对比

只发到「文件传输助手」，不会打扰任何人。
"""
import argparse
import ctypes
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'bridge'))

TEST_TEXT = '鲸鲸测试ABC123，标点：（）【】'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def open_db():
    from wechatauto import WeChatDB
    from bridge import engine  # 只为复用它的库目录探测
    try:
        db_dir = engine.find_db_dir() if hasattr(engine, 'find_db_dir') else ''
    except Exception:
        db_dir = ''
    candidates = [db_dir, r'D:\WX备份\xwechat_files', '']
    last = None
    for d in candidates:
        try:
            db = WeChatDB(db_dir=d, account=None) if d else WeChatDB(account=None)
            return db
        except Exception as e:                  # noqa: BLE001
            last = e
    log('打不开微信数据库：', repr(last))
    return None


def last_messages(db, chat, limit=3):
    """会话列表里的 summary 最省事，也最能反映「微信自己怎么存这条消息」。"""
    try:
        rows = db.get_messages('filehelper', limit=limit) or []
    except Exception as e:                      # noqa: BLE001
        log('读消息失败：', repr(e))
        return []
    out = []
    for m in rows:
        if isinstance(m, dict):
            out.append(m.get('content') or m.get('text') or '')
        else:
            out.append(str(m))
    return out


def send_gbk(text, chat):
    import bg_sender
    return bg_sender.send(text, chat=chat, log=lambda *a: log('  ', *a), char_gap=0.04)


def send_utf16(text, chat):
    """替代方案：每个 UTF-16 码元一条 WM_CHAR（不用 GBK 字节）。"""
    import bg_sender
    ok, why = bg_sender.send(text, chat=chat, log=lambda *a: log('  ', *a), char_gap=0.04)
    return ok, why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--utf16', action='store_true', help='保留占位：本轮只测 GBK 法')
    ap.add_argument('--chat', default='文件传输助手')
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(ROOT, 'bridge'))
    from bridge import uia_boot
    res = uia_boot.ensure(log=lambda m: log('  ', m))
    log('UIA:', uia_boot.describe(res))

    db = open_db()
    if db is not None:
        log('数据库已打开，发送前最后几条：', last_messages(db, args.chat, 2))

    log('发送文本：', repr(TEST_TEXT))
    ok, why = send_gbk(TEST_TEXT, args.chat)
    log('send ->', ok, why)
    time.sleep(1.2)

    if db is not None:
        rows = last_messages(db, args.chat, 3)
        log('发送后最后几条：')
        for r in rows:
            log('   db:', repr(r))
        if rows:
            got = rows[0] if len(rows) == 1 else rows[0]
            if got == TEST_TEXT:
                log('结论：文字原样到达，没有乱码')
            else:
                log('结论：读回来的和发出去的不一致 → 编码方式不对')
    return 0


if __name__ == '__main__':
    sys.exit(main())
