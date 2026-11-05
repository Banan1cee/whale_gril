from .base import (
    BaseMessage,
    HumanMessage
)
from wechatauto import uia
from wechatauto.param import (
    WxParam,
    WxResponse,
    PROJECT_NAME
)

from typing import (
    Dict,
    List,
    Any,
    TYPE_CHECKING
)
if TYPE_CHECKING:
    from wechatauto.ui.chatbox import ChatBox


class SystemMessage(BaseMessage):
    attr = 'system'

    def __init__(
            self,
            control: uia.Control,
            parent: "ChatBox",
            additonal_attr: Dict[str, Any] = {}
        ):
        super().__init__(control, parent, additonal_attr)
        self.sender = 'system'
        self.sender_remark = 'system'


class FriendMessage(HumanMessage):
    attr = 'friend'

    def __init__(
            self,
            control: uia.Control,
            parent: "ChatBox",
            additonal_attr: Dict[str, Any] = {}
        ):
        super().__init__(control, parent, additonal_attr)

    def _click(self, x, y, right=False):
        self.roll_into_view()
        if right:
            self.control.RightClick(x=x, y=y, ratioX=0, ratioY=0)
        else:
            self.control.Click(ratioX=0, ratioY=0)

    @property
    def _bias(self):
        return WxParam.DEFAULT_MESSAGE_XBIAS


class SelfMessage(HumanMessage):
    attr = 'self'

    def __init__(
            self,
            control: uia.Control,
            parent: "ChatBox",
            additonal_attr: Dict[str, Any] = {}
        ):
        super().__init__(control, parent, additonal_attr)

    def _click(self, x, y, right=False):
        self.roll_into_view()
        if right:
            self.control.RightClick(x=x, y=y, ratioX=1, ratioY=0)
        else:
            self.control.Click(x=x, y=y, ratioX=1, ratioY=0)

    @property
    def _bias(self):
        return -WxParam.DEFAULT_MESSAGE_XBIAS
