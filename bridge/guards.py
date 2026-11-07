# -*- coding: utf-8 -*-
"""消息入口的三道闸：系统通知、重复消息、每分钟限流。

以前这三个函数和它们的全局表都长在 engine.py 的模块级。拆出来后：

- 状态只在本模块内，engine 不再直接碰 `_recent_dup` / `_reply_stamps`；
- 系统号名单由 engine 在启动和 config 热更新时调用 `set_system_senders()` 同步；
- 时间窗口和上限保持原来的 45 秒 / 8 条，行为不变。
"""

import re
import threading
import time

DUP_REPLY_WINDOW = 45
MAX_REPLIES_PER_MIN = 8

_SYSTEM_TEXT_RE = re.compile(r"<a\s+href=|weixin://|&lt;a\s+href=", re.I)
SYSTEM_SENDER_NAMES = set()

_recent_dup = {}
_reply_stamps = {}
_guard_lock = threading.Lock()


def set_system_senders(names):
    """启动时和 config.json 热更新后同步「系统号 / 永不回复」名单。"""
    global SYSTEM_SENDER_NAMES
    SYSTEM_SENDER_NAMES = set(names or ())


def is_system_notice(username, nickname, content):
    """系统号 / 通知类消息：带 weixin:// 链接、HTML 链接、或已知系统号名字。"""
    if _SYSTEM_TEXT_RE.search(str(content or "")):
        return True
    name = str(nickname or "").strip()
    if name in SYSTEM_SENDER_NAMES:
        return True
    uid = str(username or "")
    if uid.startswith("gh_"):
        return True
    return False


def duplicate_guard(chat_username, sender, content):
    """同一人 45 秒内重复同一句 → 不再回（微信重投/通知刷屏）。"""
    now = time.time()
    key = (str(chat_username or ""), str(sender or ""), str(content or "").strip())
    with _guard_lock:
        last = _recent_dup.get(key, 0)
        _recent_dup[key] = now
        if len(_recent_dup) > 500:
            for k, v in list(_recent_dup.items()):
                if now - v > 600:
                    _recent_dup.pop(k, None)
        return now - last < DUP_REPLY_WINDOW


def rate_guard(chat_username):
    """同一会话一分钟内已经回了 MAX_REPLIES_PER_MIN 条 → 先停下，避免越聊越乱。"""
    now = time.time()
    key = str(chat_username or "")
    with _guard_lock:
        stamps = [t for t in _reply_stamps.get(key, []) if now - t < 60]
        if len(stamps) >= MAX_REPLIES_PER_MIN:
            _reply_stamps[key] = stamps
            return False
        stamps.append(now)
        _reply_stamps[key] = stamps
    return True
