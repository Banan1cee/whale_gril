# -*- coding: utf-8 -*-
"""wechatauto.remark —— 改联系人备注（界面路径与「标签」同族）。

实测（微信 4.1.15.13 / 2026-10-16 逐层探过）这条路是：

1. 主窗导航栏点「通讯录」→ 左栏一行一个联系人，类名
   ``mmui::ContactsCellItemView``，``Name`` 就是界面上显示的那个名字
   （备注优先于昵称）。
2. 点开某一行 → 右侧 ``mmui::ProfileView`` 资料页。入口是昵称右边那颗
   ``mmui::XButton``（``Name='更多'``）——**必须限定在 ProfileView 子树里找**：
   主窗导航栏底部也有一颗「更多」（``MainTabBarSettingView``），先撞上它就会
   点到别的地方去。
3. 点「更多」弹出的菜单挂在**主窗**树里（``mmui::XMenu``），但屏幕归属是另一颗
   顶层小窗：照主窗句柄点会被 :meth:`LabelOps._click` 的落点校验拒掉
   （实测 ``occluded：落点被窗口 15603462 盖着``）。所以先记下点击前的小窗集合，
   再从新出现的那颗里按文案找菜单项，用**它的**句柄点。
4. 菜单第一项「设置备注和标签」→ 打开一颗标题就是这五个字的独立顶层窗
   （类名 ``Qt51514QWindowToolSaveBits``）。备注输入框是 ``mmui::XLineEdit``
   （``Name='修改备注名'``），它父亲 ``mmui::XLineField`` 的 ``Name`` 是**当前**
   备注值（用来判「改没改」）。底部两颗 ``mmui::XOutlineButton``：完成 / 取消。
5. 输入走「拿焦点 + 剪贴板 Ctrl+V」：坐标点击那条路会把微信前台打掉，粘贴整个
   落空（和发送输入框同一个坑），所以贴完必须回读输入框比对。

只读与安全：探测（``probe``）不写任何东西；``set_remark`` 只在最后点一次
「完成」，失败一律显式返回原因，绝不盲点。
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from typing import Dict, List, Optional

from wechatauto.labels import (LabelOps, VK_CONTROL, VK_V,
                               _press, _result, _USER32)
from wechatauto.logger import wxlog

MAIN_TITLE = "微信"
CONTACT_ITEM_CLS = "mmui::ContactsCellItemView"
# 通讯录页左栏只渲染可见的十几行（虚拟化），要找的人多半不在里面——所以滚动枚举，
# 不用搜索框：实测搜出来点结果是「打开会话」而不是资料页，还会改掉用户当前会话。
CONTACT_LIST_CLS = "mmui::StickyHeaderRecyclerListView"   # aid=primary_table_.contact_list
PROFILE_CLS = "mmui::ProfileView"
MORE_BTN_NAME = "更多"
MENU_CLS = "mmui::XMenu"
MENU_ITEM_CLS = "mmui::XMenuView"
MENU_SET_REMARK = "设置备注和标签"
EDIT_TITLE = "设置备注和标签"
REMARK_EDIT_CLS = "mmui::XLineEdit"
REMARK_EDIT_NAME = "修改备注名"
REMARK_FIELD_CLS = "mmui::XLineField"
BTN_DONE = "完成"
BTN_CANCEL = "取消"

VK_A, VK_DELETE = 0x41, 0x2E
WM_CLOSE = 0x0010


def _windows_by_title(title: str) -> List[int]:
    """按标题找可见顶层窗（编辑窗的标题就是「设置备注和标签」）。"""
    if _USER32 is None:
        return []
    user32 = ctypes.windll.user32
    user32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
    user32.IsWindowVisible.restype = wintypes.BOOL
    found: List[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value.strip() == title:
            found.append(int(hwnd))
        return True

    user32.EnumWindows(cb, 0)
    return found


class RemarkOps(LabelOps):
    """改备注。脚手架（抬窗/落点归属校验/小窗枚举）全部复用 :class:`LabelOps`。"""

    # ---------------------------------------------------------------- 只读探测
    def _click_owned(self, ctrl, hwnd: int = 0, right: bool = False) -> Dict:
        """点控件时按**落点实际归属的窗口**做校验。

        搜索结果行（``mmui::SearchContentCellView``）挂在主窗的 UIA 树里，屏幕上却
        归属一颗独立浮层（实测 ``Qt51514QWindowToolSaveBits`` / title='Weixin'）——
        照主窗句柄点会被 :meth:`LabelOps._click` 的落点校验拒掉
        （``occluded：落点被窗口 …盖着``）。这里先算中点归属，再交给校验。
        """
        owner = 0
        try:
            r = ctrl.BoundingRectangle
            owner = self._owner_at((r.left + r.right) // 2, (r.top + r.bottom) // 2)
        except Exception:
            owner = 0
        return self._click(owner or hwnd, ctrl, right=right, raise_it=False)

    def _row_named(self, win, who: str):
        """只接受精确显示名；屏内相似项不能抢先于屏外的真正目标。"""
        rows = self._rows(win, CONTACT_ITEM_CLS)
        who = (who or "").strip()
        if not who:
            return None
        for row in rows:
            try:
                if (row.Name or "").strip() == who:
                    return row
            except Exception:
                continue
        return None

    def _contact_list_box(self, win):
        lst = self._find(win, (), cls=CONTACT_LIST_CLS)
        if lst is None:
            return None
        try:
            r = lst.BoundingRectangle
        except Exception:
            return None
        return r if r.width() > 0 and r.height() > 0 else None

    def _scroll_contacts(self, win, notches: int = 3, direction: str = "down") -> bool:
        """在左栏联系人列表里滚一小段（游标停在列表中心，一小格一小格滚）。

        和标签成员列表同一套实测口径：一格 120 平均 1~2 行，一整把 -600 常常不动。
        """
        box = self._contact_list_box(win)
        if box is None:
            return False
        x = (box.left + box.right) // 2
        y = (box.top + box.bottom) // 2
        step = 120 if direction == "up" else -120
        for _ in range(max(1, int(notches))):
            self.uia._wheel_at(x, y, step)
        return True

    def _rewind_contacts(self, win) -> None:
        """左栏倒回顶部：看得见的这一屏不再变就是到顶了（轮数封顶）。"""
        prev = None
        for _ in range(15):
            page = [(c.Name or "").strip() for c in self._rows(win, CONTACT_ITEM_CLS)]
            if prev is not None and page == prev:
                return
            prev = page
            if not self._scroll_contacts(win, notches=20, direction="up"):
                return

    def find_contact_row(self, win, who: str, max_screens: int = 40,
                         notches: int = 8):
        """通讯录左栏精确找 ``who``：当前屏没有就回顶继续查找，不做包含匹配。

        一格滚轮实测只走 1~2 行（``-600`` 那种大把经常一点不动），所以每轮滚
        ``notches`` 格、轮数给足：174 个联系人 ≈ 150 行，40 轮 × 8 格留够余量。
        整屏名字没变就是到底了，提前收工。
        """
        row = self._row_named(win, who)
        if row is not None:
            return row
        self._rewind_contacts(win)
        prev = None
        for _ in range(max(1, int(max_screens))):
            _h, win = self._root(MAIN_TITLE)
            if win is None:
                return None
            row = self._row_named(win, who)
            if row is not None:
                return row
            page = [(c.Name or "").strip() for c in self._rows(win, CONTACT_ITEM_CLS)]
            if prev is not None and page == prev:
                break                          # 到底了还是没见着
            prev = page
            if not self._scroll_contacts(win, notches=notches, direction="down"):
                break
        return None

    def contact_names(self, win, limit: int = 12) -> List[str]:
        out = []
        for row in self._rows(win, CONTACT_ITEM_CLS)[:limit]:
            try:
                out.append((row.Name or "").strip())
            except Exception:
                pass
        return out

    def _leave_profile(self, win) -> bool:
        """资料页里点「返回」退出去。

        通信录 tab 会记住上次停在谁的资料页上：点「通讯录」出来的**就是资料页**
        （实测 names 里是「返回/发消息/视频聊天/…」），左栏联系人列表根本不渲染。
        所以见到资料页要先退出来，才谈得上找联系人。
        """
        profile = self._find(win, (), cls=PROFILE_CLS)
        if profile is None:
            return False
        # 「返回」是 profile_view 那层容器的直接子，不在 ProfileView 子树里，
        # 所以按整窗找、精确匹配（别用包含匹配，主窗里还有别的带「返回」字样的东西）。
        back = self._find(win, ("返回",), contains=False)
        if back is None:
            return False
        r = self._click_owned(back, self._root(MAIN_TITLE)[0])
        time.sleep(0.8)
        return bool(r.get("ok"))

    def open_profile(self, who: str) -> Dict:
        """通讯录页 → 点开联系人 → 停在资料页。

        左栏是虚拟化的（一屏只渲染十几行），目标通常不在首屏，所以要滚动去找。
        **不用搜索框那条路**：实测搜出来点结果是「打开会话」而不是资料页
        （点完 chat_message_list 里出现历史消息），白点一下还改了用户当前会话。
        """
        for attempt in (1, 2, 3):
            self.back_to_chat()                 # 先离开上次的页面
            time.sleep(0.5)
            self.open_contacts_tab()
            _h, win0 = self._root(MAIN_TITLE)
            if win0 is None:
                return _result(False, "no-main-win：主窗没了")
            if self._wait_class(CONTACT_LIST_CLS, root=win0, timeout=2.5) is not None:
                break
            self._leave_profile(win0)           # 可能停在上次的资料页上
            _h, win0 = self._root(MAIN_TITLE)
            if win0 is not None and self._wait_class(CONTACT_LIST_CLS, root=win0,
                                                     timeout=2.5) is not None:
                break
            if attempt == 3:
                return _result(False, "no-page：通信录页左侧联系人列表一直没出来",
                               names=self._names(win0)[:16] if win0 else [])
        hwnd, win = self._root(MAIN_TITLE)
        if win is None:
            return _result(False, "no-main-win：主窗没了")
        row = self.find_contact_row(win, who)
        if row is None:
            return _result(False, "no-contact：通讯录里翻遍了也没找到「%s」" % who,
                           names=self.contact_names(win))
        r = self._click_owned(row, hwnd)
        if not r["ok"]:
            return r
        profile = self._wait_class(PROFILE_CLS, root=win, timeout=4.0)
        if profile is None:
            return _result(False, "no-profile：点了联系人但资料页没出来",
                           names=self._names(win)[:20])
        return _result(True, "ok", win=self._root(MAIN_TITLE)[1], profile=profile)

    def probe(self, who: Optional[str] = None) -> Dict:
        """只走「资料页 → 更多 → 设置备注和标签」这条路，打开编辑窗后**立刻取消**。

        界面文案/控件类名随版本漂移时，用它定位断在哪一步。
        """
        steps = []
        hwnd, win = self._root(MAIN_TITLE)
        if win is None:
            return _result(False, "no-main-win：主窗没拿到（先确认微信已登录）")

        names = self.contact_names(win)
        who = (who or (names[0] if names else "")).strip()
        if not who:
            return _result(False, "no-contact：通讯录左栏一个联系人都没有")

        op = self.open_profile(who)
        steps.append(("open_profile", op))
        if not op["ok"]:
            return _result(False, op["reason"], steps=steps)

        menu_item = self._open_remark_menu(op["profile"])
        steps.append(("open_menu", menu_item))
        if not menu_item["ok"]:
            return _result(False, menu_item["reason"], steps=steps)

        r = self._click(menu_item["menu_hwnd"], menu_item["item"], raise_it=False)
        steps.append(("click_menu_item", r))
        if not r["ok"]:
            return _result(False, r["reason"], steps=steps)

        edit_hwnd, edit_win = self._wait_edit_window()
        steps.append(("edit_window", _result(bool(edit_win), "ok" if edit_win else
                                             "no-edit-window：编辑窗没出现")))
        if not edit_win:
            return _result(False, "no-edit-window：点了「%s」但编辑窗没出现" % MENU_SET_REMARK,
                           steps=steps, names=self._names(win)[:20])

        fields = self._read_edit_window(edit_win)
        steps.append(("fields", _result(True, "ok", fields=fields)))
        # 不留痕：直接关掉（不点完成），搜索框也清掉
        self._close_edit_windows()
        return _result(True, "ok", who=who, fields=fields, steps=steps)

    # ---------------------------------------------------------------- 写
    def set_remark(self, who: str, new_remark: str, verify: bool = True,
                   allow_empty: bool = False) -> Dict:
        """把 ``who`` 的备注改成 ``new_remark``。

        ``new_remark`` 为空表示**清空备注**，必须显式 ``allow_empty=True``
        （否则空串多半是调用方漏了参数，不该悄悄把人家的备注抹掉）。
        写入前必须能唯一解析精确显示名；``verify=True`` 再回读数据库确认结果。
        """
        who = (who or "").strip()
        new_remark = (new_remark or "").strip()
        if not who or (not new_remark and not allow_empty):
            return _result(False, "bad-args：联系人和新备注都要给"
                                  "（要清空备注请显式 allow_empty=True）")

        # 先在操作**之前**把 username 定下来：改完备注后显示名会变成新备注，
        # 那时再想反查就难了（清空那次更是无迹可寻）。
        uname = self._username_of(who)
        if not uname:
            return _result(False, "no-exact-contact：无法唯一确认完整显示名对应的联系人，未修改备注")
        op = self.open_profile(who)
        if not op["ok"]:
            return op
        profile = op["profile"]

        menu_item = self._open_remark_menu(profile)
        if not menu_item["ok"]:
            return menu_item
        r = self._click(menu_item["menu_hwnd"], menu_item["item"], raise_it=False)
        if not r["ok"]:
            return r

        edit_hwnd, edit_win = self._wait_edit_window()
        if not edit_win:
            return _result(False, "no-edit-window：点了「%s」但编辑窗没出现" % MENU_SET_REMARK)
        try:
            before = self._current_remark(edit_win)
            # 导航途中资料页可能变化；编辑窗显示的旧备注必须仍是所选显示名。
            if before != who:
                return _result(False, "target-mismatch：编辑窗不是指定联系人，未修改备注",
                               who=who, before=before)
            typed = self._type_remark(edit_win, new_remark)
            if not typed["ok"]:
                self._close_edit_windows()
                return typed
            done = self._find(edit_win, (BTN_DONE,), cls=None, contains=False)
            if done is None:
                self._close_edit_windows()
                return _result(False, "no-done：编辑窗里找不到「%s」按钮" % BTN_DONE,
                               names=self._names(edit_win)[:20])
            click = self._click(self._window_hwnd(edit_win), done, raise_it=False)
            if not click["ok"]:
                self._close_edit_windows()
                return click
        finally:
            time.sleep(0.4)
            self._close_edit_windows()          # 没关成的补一刀（不改内容）
        self.back_to_chat()

        out = {"who": who, "remark": new_remark, "before": before}
        if verify:
            ok = self._remark_landed(uname, new_remark)
            out["verified"] = ok
            if not ok:
                return _result(False, "not-verified：界面上点完了，但库里读不到新备注"
                                      "（微信可能还在写库；稍后再查一次 contact.db）",
                               **out)
        return _result(True, "ok", **out)

    # ---------------------------------------------------------------- 内部步骤
    def _open_remark_menu(self, profile) -> Dict:
        """在资料页点「更多」，从新出现的小窗里取「设置备注和标签」那一项。"""
        if profile is None:
            return _result(False, "no-profile：没有资料页可点")
        more = None
        for btn in self._rows(profile, "mmui::XButton"):
            try:
                if MORE_BTN_NAME in (btn.Name or ""):
                    more = btn
                    break
            except Exception:
                continue
        if more is None:
            return _result(False, "no-more：资料页里没有「%s」按钮" % MORE_BTN_NAME,
                           names=self._names(profile)[:20])
        hwnd, _win = self._root(MAIN_TITLE)
        before = {h for h, _ in self._popup_windows()}
        r = self._click(hwnd, more, raise_it=False)
        if not r["ok"]:
            return r
        deadline = time.time() + 4.0
        while time.time() < deadline:
            for h, w in self._popup_windows():
                if h in before or w is None:
                    continue
                item = self._find(w, (MENU_SET_REMARK,), cls=MENU_ITEM_CLS, contains=False)
                if item is not None:
                    return _result(True, "ok", item=item, menu_hwnd=h)
            time.sleep(0.25)
        return _result(False, "no-menu-item：点了「更多」但菜单里没有「%s」"
                              "（菜单可能挂主窗树里而点在别处）" % MENU_SET_REMARK)

    def _wait_edit_window(self, timeout: float = 6.0):
        """等编辑窗出现，**并且**等它的输入框渲染出来。

        窗口先画出来、内容几百毫秒后才进树（和「管理窗出现≠左栏渲染」同一个坑），
        只等窗口会读到一棵空树，随后就报「找不到输入框」。
        """
        deadline = time.time() + timeout
        seen = False
        while time.time() < deadline:
            for h in _windows_by_title(EDIT_TITLE):
                seen = True
                try:
                    win = self._control(h)
                except Exception:
                    continue
                if self._find(win, (), cls=REMARK_EDIT_CLS) is not None:
                    return h, win
            time.sleep(0.3)
        if seen:
            wxlog.debug("编辑窗出现了但 %s 还没进树（等了 %.1fs）",
                        REMARK_EDIT_CLS, timeout)
        return 0, None

    def _window_hwnd(self, ctrl) -> int:
        try:
            return int(ctrl.NativeWindowHandle or 0)
        except Exception:
            return 0

    def _read_edit_window(self, edit_win) -> Dict:
        """把编辑窗里认得出来的几样东西报出来（只读，给 probe 用）。"""
        edit = self._find(edit_win, (), cls=REMARK_EDIT_CLS)
        field = self._find(edit_win, (), cls=REMARK_FIELD_CLS)
        return {
            "remark_edit": bool(edit),
            "remark_edit_name": (getattr(edit, "Name", "") or "") if edit else "",
            "current": (getattr(field, "Name", "") or "") if field else "",
            "buttons": [n for n in self._names(edit_win) if n in (BTN_DONE, BTN_CANCEL)],
        }

    def _current_remark(self, edit_win) -> str:
        field = self._find(edit_win, (), cls=REMARK_FIELD_CLS)
        try:
            return (field.Name or "").strip() if field is not None else ""
        except Exception:
            return ""

    def _type_remark(self, edit_win, text: str) -> Dict:
        """把备注写进输入框，并回读确认（粘贴整个落空时必须报错，不能当成功）。"""
        from wechatauto.uia_driver import WeChatUIA
        edit = self._find(edit_win, (), cls=REMARK_EDIT_CLS)
        if edit is None:
            return _result(False, "no-edit-box：编辑窗里没有 %s" % REMARK_EDIT_CLS,
                           names=self._names(edit_win)[:20])
        # 拿焦点靠 UIA，不靠坐标点击：坐标那条路会把微信前台打掉（实测粘贴落空）
        try:
            edit.SetFocus()
        except Exception as e:
            wxlog.debug("备注输入框 SetFocus 失败（继续试粘贴）：%s", e)
        time.sleep(0.3)
        _press(VK_CONTROL, VK_A)               # Ctrl+A 选中旧内容
        time.sleep(0.15)
        _press(VK_DELETE)                      # 清空
        time.sleep(0.2)
        if not text:                           # 清空备注：删完就回读确认
            got = WeChatUIA._read_edit_value(edit)
            if got is None:
                got = self._current_remark(edit_win)
            if (got or "").strip():
                return _result(False, "clear-failed：备注框里还剩「%s」" % got.strip()[:20])
            return _result(True, "ok")
        WeChatUIA._clip_set(text)
        _press(VK_CONTROL, VK_V)
        time.sleep(0.7)
        got = WeChatUIA._read_edit_value(edit)
        if got is None:
            # 读不到值不等于没贴上：进编辑窗的 XLineField.Name 才是权威读法
            cur = self._current_remark(edit_win)
            if cur.strip() != text:
                return _result(False, "paste-unconfirmed：备注框回读不到，"
                                      "当前显示「%s」" % cur.strip()[:20])
        elif got.strip() != text:
            return _result(False, "paste-mismatch：贴进去的是「%s」，要的是「%s」"
                           % (got.strip()[:20], text[:20]))
        return _result(True, "ok")

    def _close_edit_windows(self) -> None:
        """把编辑窗关掉（WM_CLOSE，不触发保存）。"""
        if _USER32 is None:
            return
        user32 = ctypes.windll.user32
        for h in _windows_by_title(EDIT_TITLE):
            user32.PostMessageW(h, WM_CLOSE, 0, 0)

    def _username_of(self, who: str) -> Optional[str]:
        """按通讯录实际显示名唯一解析；有备注时不能拿被遮盖的昵称认人。"""
        try:
            hits = self.db.search_contact(who) or []
        except Exception as e:
            wxlog.debug("联系人解析失败：%s", e)
            return None
        usernames = {h.get("username") for h in hits
                     if (h.get("remark") or h.get("nick_name") or "").strip() == who
                     and h.get("username")}
        return next(iter(usernames)) if len(usernames) == 1 else None

    def _remark_landed(self, uname: str, new_remark: str, timeout: float = 6.0) -> bool:
        """按 **username** 回读 contact.db 的 remark（空串 = 已清空）。

        不能拿新备注当搜索键：清空那次新值就是空串，永远搜不到（实测踩过——
        界面上明明清掉了，报告却写「库里读不到」）。username 是稳定的，
        ``search_contact`` 的 LIKE 也覆盖 username 字段。
        """
        if not uname:
            return False
        deadline = time.time() + max(0.5, timeout)
        while True:
            try:
                for h in self.db.search_contact(uname) or []:
                    if (h.get("username") or "") == uname:
                        return (h.get("remark") or "").strip() == new_remark
            except Exception as e:
                wxlog.debug("备注回读失败：%s", e)
                return False
            if time.time() >= deadline:
                return False
            time.sleep(0.5)
