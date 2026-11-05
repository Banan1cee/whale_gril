from __future__ import annotations
from wechatauto import uia
from wechatauto.param import (
    WxParam,
    WxResponse,
)
from wechatauto.languages import MENU_OPTIONS, get_lang
from wechatauto.ui.component import Menu
from wechatauto.utils.win32 import SetClipboardText
from wechatauto.logger import wxlog
import time
from typing import (
    Union,
    List
)
import re


class SessionBox:
    """会话列表区域"""

    def __init__(self, control, parent):
        self.control: uia.Control = control
        self.root = parent.root
        self.parent = parent
        self.init()

    def init(self):
        self.searchbox = self.control.GroupControl(ClassName="mmui::XSearchField").EditControl()
        self.session_list = self.control.GroupControl(ClassName="mmui::ChatSessionList").\
            ListControl(ClassName="mmui::XTableView", Name="会话")
        self.search_content = self.parent.control.WindowControl(ClassName="mmui::SearchContentPopover")

    def roll_up(self, n: int = 5):
        self.control.MiddleClick()
        self.control.WheelUp(wheelTimes=n)

    def roll_down(self, n: int = 5):
        self.control.MiddleClick()
        self.control.WheelDown(wheelTimes=n)

    def get_session(self) -> List['SessionElement']:
        if self.session_list.Exists(0):
            return [SessionElement(i, self) for i in self.session_list.GetChildren()]
        else:
            return []

    def search(
            self,
            keywords: str,
            force: bool = False,
            force_wait: Union[float, int] = 0.5
        ):
        self.searchbox.RightClick()
        SetClipboardText(keywords)
        menu = Menu(self)
        menu.select('粘贴')
        self.searchbox.MiddleClick()

        search_result = self.search_content.ListControl()

        if force:
            time.sleep(force_wait)

        return [SearchResultElement(i) for i in search_result.GetChildren()]

    def switch_chat(
        self,
        keywords: str,
        exact: bool = True,
        force: bool = False,
        force_wait: Union[float, int] = 0.5
    ):
        wxlog.debug(f"切换聊天窗口: {keywords}, {exact}, {force}, {force_wait}")
        search_box = self.search_content.ListControl()
        search_result = self.search(keywords, force, force_wait)
        t0 = time.time()
        while time.time() - t0 < WxParam.SEARCH_CHAT_TIMEOUT:
            results = []
            search_result_items = search_box.GetChildren()
            for search_result_item in search_result_items:
                text: str = search_result_item.Name
                if exact:
                    if text == keywords:
                        search_result_item.Click()
                        return keywords
                    elif (
                        ' 微信号: ' in text
                        and (split := text.split(' 微信号: '))[-1].lower() == keywords.lower()
                    ):
                        search_result_item.Click()
                        return split[0]
                    elif (
                        ' 昵称: ' in text
                        and (split := text.split(' 昵称: '))[-1].lower() == keywords.lower()
                    ):
                        search_result_item.Click()
                        return split[0]
                else:
                    if keywords in text:
                        search_result_item.Click()
                        return text

        if self.search_content.Exists(0):
            self.control.MiddleClick()

    def open_separate_window(self, name: str):
        wxlog.debug(f"打开独立窗口: {name}")
        realname = self.switch_chat(name)
        if not realname:
            return WxResponse.failure('未找到会话')
        time.sleep(0.3)
        while True:
            session = [i for i in self.get_session() if uia.IsElementInWindow(self.session_list, i.control)][0]
            if session.content.startswith(realname):
                break
        session.double_click()
        return WxResponse.success(data={'nickname': realname})

    def go_top(self):
        wxlog.debug("回到会话列表顶部")
        self.control.MiddleClick()
        self.control.SendKeys('{Home}')

    def go_bottom(self):
        wxlog.debug("回到会话列表底部")
        self.control.MiddleClick()
        self.control.SendKeys('{End}')


class SessionElement:
    """会话列表中的单条会话"""

    def __init__(
            self,
            control: uia.Control,
            parent: SessionBox,
        ):
        self.root = parent.root
        self.parent = parent
        self.control = control
        self.content = control.Name

    @property
    def texts(self) -> List[str]:
        """拆分当前会话控件中的文本行"""

        return [
            line for line in str(self.content).split('\n')
            if line and line.strip()
        ]

    @property
    def name(self) -> str:
        """会话名称"""

        if self.texts:
            return self.texts[0]
        return ''

    @property
    def unread_count(self) -> int:
        """未读消息数量"""

        unread_pattern = re.compile(r'\[(\d+)条\]')
        for text in self.texts:
            if match := unread_pattern.search(text):
                return int(match.group(1))
        return 0

    def _menu_option_text(self, option_key: str) -> str:
        return get_lang(MENU_OPTIONS, option_key)

    def select_menu_option(self, option_key: str, wait=0.3):
        """根据配置语言选择菜单项"""

        option_text = self._menu_option_text(option_key)
        return self.select_option(option_text, wait)

    def __repr__(self):
        content = str(self.content).replace('\n', ' ')
        if len(content) > 5:
            content = content[:5] + '...'
        return f"<wechatauto Session Element({content})>"

    def roll_into_view(self):
        uia.RollIntoView(self.control.GetParentControl(), self.control)

    def _click(self, right: bool = False, double: bool = False):
        self.roll_into_view()
        if right:
            self.control.RightClick()
        elif double:
            self.control.DoubleClick()
        else:
            self.control.Click()

    def click(self):
        self._click()

    def right_click(self):
        self._click(right=True)

    def double_click(self):
        self._click()
        self._click(double=True)

    def select_option(self, option: str, wait=0.3):
        self.roll_into_view()
        self.control.RightClick()
        time.sleep(wait)
        menu = Menu(self.parent)
        return menu.select(option)

    def pin(self):
        """置顶聊天"""

        return self.select_menu_option('置顶')

    def unpin(self):
        """取消置顶聊天"""

        return self.select_menu_option('取消置顶')

    def mark_unread(self):
        """标记为未读"""

        return self.select_menu_option('标为未读')

    def toggle_mute(self):
        """切换消息免打扰状态"""

        return self.select_menu_option('消息免打扰')

    def open_in_separate_window(self):
        """在独立窗口中打开会话"""

        return self.select_menu_option('在独立窗口打开')

    def hide(self):
        """不显示聊天"""

        return self.select_menu_option('不显示聊天')

    def delete(self):
        """删除聊天"""

        return self.select_menu_option('删除聊天')


class SearchResultElement:
    """搜索结果中的单条结果"""

    def __init__(self, control):
        self.control = control
        self.content = control.Name
        self.type = control.ClassName

    def __repr__(self):
        content = str(self.content).replace('\n', ' ')
        if len(content) > 5:
            content = content[:5] + '...'
        return f"<wechatauto Search Element({content})>"

    def get_all_text(self):
        return [
            line for line in str(self.content).split('\n')
            if line and line.strip()
        ]

    def click(self):
        uia.RollIntoView(self.control.GetParentControl(), self.control)
        self.control.Click()

    def close(self):
        self.control.SendKeys('{Esc}')
