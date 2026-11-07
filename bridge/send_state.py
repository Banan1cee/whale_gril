# -*- coding: utf-8 -*-
"""发送临界区状态与会话身份错误。

`SEND_STATE` 是发送看门狗的唯一状态源：进发送区置位、出区清零。
`ChatIdentityError` 表示「当前会话不是目标会话」，只能整条放弃，不能换通道重试；
`DraftDirtyError` 表示输入框可能残留草稿，同样禁止换通道继续发。
"""

import re
import time

SEND_STATE = {"active": False, "start": 0.0, "budget": 40.0}

_CHAT_NAME_SPLIT_RE = re.compile(r"[、,，\s]+")


class ChatIdentityError(RuntimeError):
    """当前开着的会话不是目标会话：宁可这条不发，也不能把正文打进别的群。

    发送 = 先切会话、再往「当前输入框」里打字。只要切会话没成功（名字只是相似、
    或者中途窗口被切走），正文就落到别的会话里 —— 表现就是「两个群同时回的时候
    把消息搞混」。这种错不能靠换通道兜底：换哪条通道都是往「当前那个会话」打字，
    所以整条放弃。
    """


class DraftDirtyError(RuntimeError):
    """输入框可能残留本次草稿，禁止换通道继续发送。"""


def _chat_identity_level(current, aliases):
    """当前会话名和目标候选名有多像：0 完全相同、1 成员名集合吻合，其它一律不收。

    以前用「包含」也算命中（`name in alias`），于是「群A」和「群A2」互认：
    点开 A2 也判定成「已经在 A 了」，正文就发到另一个群。这里只认两种确定情形，
    未命名的群在会话列表里显示成「成员甲、成员乙」，所以保留成员名集合这一档。
    """
    cur = str(current or "").strip()
    if not cur:
        return None
    keys = [str(a or "").strip() for a in (aliases or []) if str(a or "").strip()]
    if not keys:
        return None
    if cur in keys:
        return 0
    parts = [p for p in _CHAT_NAME_SPLIT_RE.split(cur) if p]
    if len(parts) >= 2:
        for k in keys:
            if all(p in k for p in parts):
                return 1
    return None


class _SendStateScope:
    """发送临界区的看门狗心跳（M7/H3）：进区置位、出区清零，单一 owner 写 SEND_STATE。

    预算按文本长度动态放宽：bg 通道逐字投递，长文本单打字就要一两分钟，
    旧的「固定 40 秒一刀切」会把这种合法慢发送当卡死杀掉（H3）。
    """

    def __init__(self, text_len=0):
        # 编码热切换时最多输入两次（一次 GBK、一次 UTF-16），并留出回读/清理时间。
        self.budget = max(40.0, float(text_len or 0) * 0.16 + 8.0)

    def __enter__(self):
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        SEND_STATE["budget"] = self.budget
        return self

    def __exit__(self, *exc):
        SEND_STATE["active"] = False
        return False
