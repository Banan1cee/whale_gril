# -*- coding: utf-8 -*-
"""群成员加好友：打开群 → 右上角「…」→ 搜索群成员 → 资料卡 → 添加到通讯录 → 发送。

界面走法（微信 4.1.15.53 / 2026-10-20 逐层实测）::

    群聊标题栏右侧「聊天信息」（mmui::XButton, Name='聊天信息'）
      → 右侧浮出 mmui::ChatRoomMemberInfoView（**在主窗树里，不是独立窗口**）
         顶部 XSearchField 的 EditControl(Name='搜索') —— 就是「搜索群成员」
         成员格 QFReuseGridWidget(aid=chat_member_list) 里是 mmui::ChatMemberCell
      → 输入名字后列表换成 StickyHeaderRecyclerListView，结果行 mmui::XTableCell
      → 点结果行 → 独立顶层小窗 mmui::ProfileUniquePop（title='Weixin'）

三条实测结论（写代码前先记住）：

1. **搜索结果可能有多行**（搜「小明」会同时出现妈妈/爸爸）。要取**视觉上第一行**：
   Qt 回收列表的 ``GetChildren()`` 顺序不等于屏幕顺序，按 ``BoundingRectangle.top``
   排序后取最上面那条，不能按树遍历顺序取。
2. 非好友的资料卡底部只有一颗 ``mmui::ProfileBottomButton``，Name='添加到通讯录'
   （aid=``content_v_view.ProfileActionUi.add_friend_button``）；已是好友的是
   「发消息 / 语音聊天 / 视频聊天」三颗，**没有这颗按钮**。所以它同时是好友判据。
3. 点「添加到通讯录」之后弹的是 ``mmui::VerifyFriendWindow``（标题「申请添加朋友」），
   留言框是 Name='发送添加朋友申请'，底部按钮是**「确定 / 取消」**——没有「发送」
   （2026-10-23 真机跑完整流程确认）。老版本叫「发送」，两个都认。
   申请发出后 ``general.db:FMessageTable`` 会多一行 ``is_sender_=1``、``scene_=14``
   的记录，可用它独立回读。找不到按钮就明确失败，绝不盲点。

安全边界：``probe`` 只导航到资料卡并读按钮，不点「添加到通讯录」；``add`` 才点，
``dry_run=True`` 时退化成 probe。
"""

from __future__ import annotations

import time
from typing import Dict, List, Optional, Sequence, Tuple

from wechatauto import rhythm
from wechatauto.labels import (
    LabelOps,
    _press,
    _result,
    _USER32,
    VK_CONTROL,
    VK_V,
)
from wechatauto.logger import wxlog

QT_SHELL_CLS = "Qt51514QWindowIcon"
PANEL_CLS = "mmui::ChatRoomMemberInfoView"
INFO_BTN_NAME = "聊天信息"
SEARCH_BOX_NAME = "搜索"
RESULT_ROW_CLS = "mmui::XTableCell"
PROFILE_POP_CLS = "mmui::ProfileUniquePop"
ADD_BTN_NAME = "添加到通讯录"
ADD_BTN_AID = "add_friend_button"
FRIEND_BTN_NAME = "发消息"
FRIEND_BTN_AID = "foot_button_view.chat_img_button"
SEND_BTN_NAME = "发送"
# 实测（微信 4.1.15.53，2026-10-23 真机）：好友申请框
# mmui::VerifyFriendWindow（标题「申请添加朋友」）底部是「确定/取消」两颗，
# **没有「发送」**；旧版本是「发送」。两处都认，防止改版又断。
SEND_BTN_NAMES = (SEND_BTN_NAME, "确定")
REQUEST_HINT = "发送添加朋友申请"


class GroupAddFriendOps(LabelOps):
    """群成员加好友。脚手架（抬窗/落点归属校验/搜索粘贴）全部复用 :class:`LabelOps`。"""

    # ------------------------------------------------------------------ 找窗
    def main_window(self):
        win = self.uia._win
        if win is None and self.uia.ensure_window():
            win = self.uia._win
        return win

    def _top_windows(self) -> List[Tuple[int, object]]:
        """同进程可见顶层窗 [(hwnd, control)]（资料卡、好友申请框都在这里找）。"""
        if _USER32 is None:
            return []
        try:
            import win32gui, win32process
            from wechatauto.uia_driver import _HAS_WIN32
            if not _HAS_WIN32:
                return []
            pid = self.uia._win.ProcessId
            found: List[int] = []

            def cb(hwnd, _):
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        return True
                    _tid, wpid = win32process.GetWindowThreadProcessId(hwnd)
                    if wpid == pid:
                        found.append(int(hwnd))
                except Exception:
                    pass
                return True

            win32gui.EnumWindows(cb, None)
        except Exception as e:
            wxlog.debug("枚举顶层窗失败：%s", e)
            return []
        out = []
        for hwnd in found:
            try:
                out.append((hwnd, self._control(hwnd)))
            except Exception:
                continue
        return out

    def _find_by_aid(self, root, suffix: str):
        """按 AutomationId 尾部找（改版把 Name 改掉时的兜底）。"""
        from wechatauto.uia_driver import _find_by
        return _find_by(root, lambda c: (c.AutomationId or "").endswith(suffix),
                        max_depth=30)

    def _top_by_class(self, cls: str) -> Optional[Tuple[int, object]]:
        for hwnd, ctrl in self._top_windows():
            try:
                if (ctrl.ClassName or "") == cls:
                    return hwnd, ctrl
            except Exception:
                continue
        return None

    def _wait_top(self, cls: str, timeout: float = 4.0,
                  exclude: Optional[Sequence[int]] = None) -> Optional[Tuple[int, object]]:
        skip = set(exclude or ())
        deadline = time.time() + timeout
        while time.time() < deadline:
            for hwnd, ctrl in self._top_windows():
                if hwnd in skip:
                    continue
                try:
                    if (ctrl.ClassName or "") == cls:
                        return hwnd, ctrl
                except Exception:
                    continue
            rhythm.nap(0.2)
        return None

    def close_card(self) -> None:
        """关掉还开着的资料卡（只按 Esc，不点任何按钮）。"""
        pop = self._top_by_class(PROFILE_POP_CLS)
        if pop is not None:
            try:
                pop[1].SendKeys("{Esc}")
            except Exception:
                pass
            rhythm.nap(0.4)

    # ------------------------------------------------------------------ 导航
    def open_group(self, group: str) -> Dict:
        """打开群聊（已在该群就不动，避免把用户正看的会话切走）。"""
        win = self.main_window()
        if win is None:
            return _result(False, "no-uia：UIA 树不可用（微信未登录/未热激活）")
        cur = self.uia.current_chat() or ""
        if cur == group:
            self._raise(win.NativeWindowHandle)
            return _result(True, "ok", opened=False, chat=cur)
        ok = False
        try:
            ok = bool(self.uia.open_chat(group))
        except Exception as e:
            wxlog.warning("open_chat(%r) 异常：%s", group, e)
        if not ok:
            # 有的版本 open_chat 返回 False 但界面已经切过去了
            ok = (self.uia.current_chat() or "") == group
        if not ok:
            return _result(False, "no-group：打不开群聊 %r（搜索没结果/搜到了别的东西）" % group)
        rhythm.nap(0.6)
        self._raise(win.NativeWindowHandle)
        return _result(True, "ok", opened=True, chat=group)

    def open_panel(self, timeout: Optional[float] = None) -> Dict:
        """打开右侧群成员面板（已开着就复用）。"""
        win = self.main_window()
        if win is None:
            return _result(False, "no-uia：UIA 树不可用")
        panel = self._find(win, (), cls=PANEL_CLS)
        if panel is not None:
            return _result(True, "ok", already=True)
        btn = self._find(win, (INFO_BTN_NAME,), cls="mmui::XButton", contains=False)
        if btn is None:
            return _result(False, "no-button：找不到标题栏「%s」按钮" % INFO_BTN_NAME)
        r = self._click(win.NativeWindowHandle, btn)
        if not r["ok"]:
            return r
        deadline = time.time() + (timeout or self.appear_timeout)
        while time.time() < deadline:
            panel = self._find(win, (), cls=PANEL_CLS)
            if panel is not None:
                return _result(True, "ok", already=False)
            rhythm.nap(0.2)
        return _result(False, "no-panel：点了「%s」但群成员面板没出来" % INFO_BTN_NAME)

    # ------------------------------------------------------------------ 搜索
    def _type_text(self, ctrl, text: str) -> bool:
        """把文字贴进控件（剪贴板 + Ctrl+V）。测试里替换掉，避免真按键。"""
        try:
            ctrl.SendKeys("{Ctrl}a")
            self.uia._clip_set(text)
            _press(VK_CONTROL, VK_V)
            return True
        except Exception as e:
            wxlog.debug("粘贴失败：%s", e)
            return False

    def _panel_box(self, panel):
        return self._find(panel, (SEARCH_BOX_NAME,), cls="XValidatorTextEdit",
                          contains=False)

    def search_member(self, panel, member: str) -> Dict:
        """在群成员搜索框里输入名字，返回按屏幕位置排序后的结果行。

        先点一下输入框再 SetValue：鼠标从面板按钮移到输入框是一次正常的
        人手动作（随机落点 + 曲线轨迹，见 ``LabelOps._click``），比“词凭空
        出现在框里”自然。SetValue 不产生逐字按键，和库里其它搜索框一致。
        """
        box = self._panel_box(panel)
        if box is None:
            return _result(False, "no-search-box：群成员面板里找不到搜索输入框")
        clicked = self._click(self.main_window().NativeWindowHandle, box)
        ok = self.uia._set_text(box, member)
        if not ok:
            if not clicked["ok"]:
                return clicked
            if not self._type_text(box, member):
                return _result(False, "type-failed：搜索词没贴进去")
        deadline = time.time() + 3.0
        rows: List = []
        last_sig = None
        while time.time() < deadline:
            rows = self._result_rows(panel)
            sig = tuple((c.Name or "", c.BoundingRectangle.top) for c in rows)
            # 连续两次读到同一批结果才算稳定：批量加人时上一轮的行会残留在树里
            # 一两百毫秒，拿到就走会选中上一个人。
            if rows and sig == last_sig:
                break
            last_sig = sig
            rhythm.nap(0.25)
        if not rows:
            return _result(False, "no-result：搜索 %r 没有结果" % member)
        return _result(True, "ok", rows=rows, row=rows[0], text=member)

    def _result_rows(self, panel) -> List:
        """结果行按**视觉顺序**（上→下）返回；Qt 列表的子节点顺序不可信。"""
        rows = self._rows(panel, RESULT_ROW_CLS)
        if len(rows) <= 1:
            return rows
        def key(c):
            try:
                r = c.BoundingRectangle
                return (r.top, r.left)
            except Exception:
                return (1 << 30, 1 << 30)
        return sorted(rows, key=key)

    def open_card(self, row) -> Dict:
        """点结果行，等资料卡小窗；只导航，不点任何底部按钮。"""
        win = self.main_window()
        if win is None:
            return _result(False, "no-uia：UIA 树不可用")
        self.close_card()
        r = self._click(win.NativeWindowHandle, row)
        if not r["ok"]:
            return r
        pop = self._wait_top(PROFILE_POP_CLS, timeout=3.0)
        if pop is None:
            return _result(False, "no-card：点了成员行但资料卡没出来")
        return _result(True, "ok", hwnd=pop[0], card=pop[1],
                       row_name=(row.Name or "").strip())

    def card_state(self, card) -> Dict:
        """读资料卡底部按钮。add=可加好友，friend=已是好友，两者都没有=认不出。"""
        add = self._find(card, (ADD_BTN_NAME,), cls="mmui::ProfileBottomButton",
                         contains=False)
        friend = self._find(card, (FRIEND_BTN_NAME,), cls="mmui::ProfileBottomButton",
                            contains=False)
        if add is None:
            add = self._find_by_aid(card, ADD_BTN_AID)
        if friend is None:
            friend = self._find_by_aid(card, FRIEND_BTN_AID)
        names = self._names(card, 120)
        out = {
            "ok": True,
            "add": add is not None,
            "friend": friend is not None,
            "names": names[:20],
        }
        if add is not None:
            out["reason"] = "ok"
            out["add_btn"] = add
        elif friend is not None:
            out["reason"] = "already-friend"
            out["friend_btn"] = friend
        else:
            out["ok"] = False
            out["reason"] = "unknown-card：资料卡上既没有「添加到通讯录」也没有「发消息」"
        return out

    # ------------------------------------------------------------------ 加好友
    def find_request_dialog(self, before: Sequence[int], card_hwnd: int,
                            card, timeout: float = 5.0) -> Tuple[Optional[int], Optional[object], List[str]]:
        """点完「添加到通讯录」后找好友申请框。

        先看点击后**新出现**的顶层窗（按类名不写死：任何新窗都可能），再退一步
        看资料卡本身有没有变成申请框。返回 ``(hwnd, 控件, 新窗类名列表)``。
        """
        skip = set(before)
        deadline = time.time() + timeout
        seen: List[str] = []
        fallback = None
        while time.time() < deadline:
            for hwnd, ctrl in self._top_windows():
                if hwnd in skip or hwnd == card_hwnd:
                    continue
                try:
                    cls = ctrl.ClassName or ""
                except Exception:
                    continue
                if cls not in seen:
                    seen.append(cls)
                if self._find(ctrl, SEND_BTN_NAMES, cls="Button",
                              contains=False) is not None:
                    return hwnd, ctrl, seen
                if fallback is None and self._looks_like_request(ctrl):
                    fallback = (hwnd, ctrl)
            rhythm.nap(0.2)
        if fallback is not None:
            return fallback[0], fallback[1], seen
        # 兜底：申请框可能就是把资料卡那块内容换掉（同一颗窗）
        if card is not None:
            btn = self._find(card, SEND_BTN_NAMES, cls="Button", contains=False)
            if btn is not None:
                return card_hwnd, card, seen
        return None, None, seen

    def _looks_like_request(self, ctrl) -> bool:
        """没有被识别出「发送」时，按类名/标题/留言框名猜是不是好友申请框。"""
        try:
            if (any(k in (ctrl.ClassName or "") for k in
                       ("AddFriend", "FriendRequest", "VerifyFriend"))
                    or any(k in (ctrl.Name or "") for k in ("添加朋友", "好友申请"))):
                return True
        except Exception:
            pass
        return self._find(ctrl, (REQUEST_HINT,), cls="Edit", contains=False) is not None

    def send_request(self, message: Optional[str] = None) -> Dict:
        """找申请框 → （可选）填留言 → 点提交（「确定」，老版本「发送」）。"""
        card_hwnd, card = self._top_by_class(PROFILE_POP_CLS) or (0, None)
        before = [h for h, _ in self._top_windows()]
        # 点「添加到通讯录」
        state = self.card_state(card) if card is not None else {"ok": False}
        if not state.get("add"):
            return _result(False, state.get("reason", "no-card：资料卡不在了"))
        add = state["add_btn"]
        r = self._click(card_hwnd, add, raise_it=False)
        if not r["ok"]:
            return r
        rhythm.nap(0.6)

        hwnd, dlg, seen = self.find_request_dialog(before, card_hwnd, card)
        if dlg is None:
            return _result(False,
                           "no-dialog：点了「添加到通讯录」但没找到好友申请框"
                           "（新窗：%s）" % (", ".join(seen) or "无"),
                           windows=seen)
        if message:
            edit = self._find(dlg, (), cls="Edit", contains=False)
            if edit is None:
                return _result(False, "no-edit：申请框里找不到留言输入框，未发送",
                               windows=seen)
            rr = self._click(hwnd, edit, raise_it=False)
            if not rr["ok"]:
                return rr
            if not self._type_text(edit, message):
                return _result(False, "type-failed：留言没贴进去")
            rhythm.nap(0.3)
        send = self._find(dlg, SEND_BTN_NAMES, cls="Button", contains=False)
        if send is None:
            return _result(False, "no-send：申请框里找不到提交按钮（确定/发送）",
                           windows=seen)
        rhythm.gate("send-friend-request")
        sr = self._click(hwnd, send, raise_it=False)
        if not sr["ok"]:
            return sr
        deadline = time.time() + 4.0
        while time.time() < deadline:
            if not any(h == hwnd for h, _c in self._top_windows()):
                break
            rhythm.nap(0.2)
        return _result(True, "ok", sent=True, windows=seen)

    # ------------------------------------------------------------------ 对外
    def probe(self, group: str, member: str) -> Dict:
        """只走到资料卡并读按钮，**不点「添加到通讯录」**。"""
        for step in ("open_group", "open_panel"):
            r = getattr(self, step)(group) if step == "open_group" else getattr(self, step)()
            if not r["ok"]:
                r["step"] = step
                return r
        panel = self._find(self.main_window(), (), cls=PANEL_CLS)
        s = self.search_member(panel, member)
        if not s["ok"]:
            s["step"] = "search"
            return s
        rows = s["rows"]
        names = [(x.Name or "").strip() for x in rows]
        c = self.open_card(s["row"])
        if not c["ok"]:
            c["step"] = "card"
            return c
        st = self.card_state(c["card"])
        self.close_card()
        st.update({"step": "card", "member": member, "group": group,
                   "results": names, "selected": c["row_name"],
                   "selected_index": 0})
        return st

    def add(self, group: str, member: str, message: Optional[str] = None,
            dry_run: bool = False) -> Dict:
        """把一个群成员加成好友；``dry_run=True`` 时等同于 :meth:`probe`。"""
        if dry_run:
            return self.probe(group, member)
        nav = self.open_group(group)
        if not nav["ok"]:
            nav["step"] = "open_group"
            return nav
        p = self.open_panel()
        if not p["ok"]:
            p["step"] = "open_panel"
            return p
        panel = self._find(self.main_window(), (), cls=PANEL_CLS)
        s = self.search_member(panel, member)
        if not s["ok"]:
            s["step"] = "search"
            return s
        names = [(x.Name or "").strip() for x in s["rows"]]
        c = self.open_card(s["row"])
        if not c["ok"]:
            c["step"] = "card"
            return c
        st = self.card_state(c["card"])
        if not st["ok"]:
            st["step"] = "card"
            return st
        if st["reason"] == "already-friend":
            self.close_card()
            st.update({"step": "card", "group": group, "member": member,
                       "results": names, "selected": c["row_name"],
                       "selected_index": 0, "added": False})
            return st
        sent = self.send_request(message)
        sent.update({"group": group, "member": member,
                     "results": names, "selected": c["row_name"],
                     "selected_index": 0})
        if sent["ok"]:
            sent["added"] = True
        sent["step"] = "send"
        return sent


__all__ = ["GroupAddFriendOps"]
