from wechatauto import uia
from wechatauto.ui.component import (
    Menu,
    SelectContactWnd
)
from wechatauto.utils import uilock
from wechatauto.param import WxParam, WxResponse, PROJECT_NAME
from abc import ABC, abstractmethod
from typing import (
    Dict,
    List,
    Union,
    Any,
    TYPE_CHECKING,
    Iterator,
    Tuple
)
from hashlib import md5

if TYPE_CHECKING:
    from wechatauto.ui.chatbox import ChatBox


def truncate_string(s: str, n: int = 8) -> str:
    s = s.replace('\n', '').strip()
    return s if len(s) <= n else s[:n] + '...'


class Message:
    """消息对象基类

    该类不会直接实例化，而是作为所有消息类型的基类提供
    常用的工具方法。实际的属性均由子类在 ``__init__`` 中
    动态注入。
    """

    _EXCLUDE_FIELDS = {"control", "parent", "root"}

    # region --- 迭代/映射相关 -------------------------------------------------
    def _iter_public_items(self) -> Iterator[Tuple[str, Any]]:
        """遍历当前消息可公开的字段"""

        if not hasattr(self, "__dict__"):
            return

        seen = set()
        for key, value in self.__dict__.items():
            if key.startswith("_") or key in self._EXCLUDE_FIELDS:
                continue
            if key == "hash" and not WxParam.MESSAGE_HASH:
                continue
            seen.add(key)
            yield key, value

        # 补充类级字段（如 type/attr），保证 to_dict/match 可用
        for key in ('type', 'attr'):
            if key in seen:
                continue
            if any(key in cls.__dict__ for cls in type(self).__mro__):
                yield key, getattr(self, key)

    def __iter__(self) -> Iterator[str]:
        for key, _ in self._iter_public_items():
            yield key

    def __len__(self) -> int:
        return sum(1 for _ in self._iter_public_items())

    def __getitem__(self, item: str) -> Any:
        for key, value in self._iter_public_items():
            if key == item:
                return value
        raise KeyError(item)

    def __contains__(self, key: object) -> bool:
        if not isinstance(key, str):
            return False
        return any(field == key for field, _ in self._iter_public_items())

    # endregion ----------------------------------------------------------------

    # region --- 字段访问 -------------------------------------------------------
    def keys(self) -> Tuple[str, ...]:
        return tuple(key for key, _ in self._iter_public_items())

    def values(self) -> Tuple[Any, ...]:
        return tuple(value for _, value in self._iter_public_items())

    def items(self) -> Tuple[Tuple[str, Any], ...]:
        return tuple(self._iter_public_items())

    def get(self, key: str, default: Any = None) -> Any:
        for field, value in self._iter_public_items():
            if field == key:
                return value
        return default

    def to_dict(self) -> Dict[str, Any]:
        return dict(self._iter_public_items())

    def copy(self) -> Dict[str, Any]:
        return self.to_dict().copy()

    # endregion ----------------------------------------------------------------

    # region --- 状态判断 -------------------------------------------------------
    def match(self, **conditions: Any) -> bool:
        """判断当前消息是否同时满足给定的字段条件"""

        data = self.to_dict()
        return all(data.get(key) == value for key, value in conditions.items())

    @property
    def is_self(self) -> bool:
        return getattr(self, "attr", None) == "self"

    @property
    def is_friend(self) -> bool:
        return getattr(self, "attr", None) == "friend"

    @property
    def is_system(self) -> bool:
        return getattr(self, "attr", None) == "system"

    # endregion ----------------------------------------------------------------

    # region --- 魔术方法 -------------------------------------------------------
    def __str__(self) -> str:
        content = getattr(self, "content", None)
        if content is None:
            return super().__str__()
        return str(content)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Message):
            return NotImplemented

        self_id = getattr(self, "id", None)
        other_id = getattr(other, "id", None)
        if self_id is not None and other_id is not None:
            return self_id == other_id

        if WxParam.MESSAGE_HASH:
            return getattr(self, "hash", None) == getattr(other, "hash", None)

        return self is other

    def __hash__(self) -> int:
        msg_id = getattr(self, "id", None)
        if msg_id is not None:
            return hash(msg_id)

        if WxParam.MESSAGE_HASH:
            return hash(getattr(self, "hash", None))

        return super().__hash__()

    # endregion ----------------------------------------------------------------

class BaseMessage(Message, ABC):
    type: str = 'base'
    attr: str = 'base'
    control: uia.Control

    def __init__(
            self,
            control: uia.Control,
            parent: "ChatBox",
            additonal_attr: Dict[str, Any] = {}
        ):
        self.parent = parent
        self.control = control
        self.direction = additonal_attr.get('direction', None)
        self.distince = additonal_attr.get('direction_distence', None)
        self.root = parent.root
        self.id = self.control.runtimeid
        self.content = self.control.Name
        rect = self.control.BoundingRectangle
        self.hash_text = f'({rect.height()},{rect.width()}){self.content}'
        self.hash = md5(self.hash_text.encode()).hexdigest()

    def __repr__(self):
        cls_name = self.__class__.__name__
        content = truncate_string(self.content)
        return f"<{PROJECT_NAME} - {cls_name}({content}) at {hex(id(self))}>"

    def roll_into_view(self):
        if not self.exists():
            return WxResponse.failure('消息目标控件不存在，无法滚动至显示窗口')
        if uia.RollIntoView(
            self.parent.msgbox,
            self.control
        ) == 'not exist':
            return WxResponse.failure('消息目标控件不存在，无法滚动至显示窗口')
        return WxResponse.success('成功')

    def exists(self):
        if self.control.Exists(0) and self.control.BoundingRectangle.height() > 0:
            return True
        return False


class HumanMessage(BaseMessage, ABC):
    attr = 'human'

    def __init__(
            self,
            control: uia.Control,
            parent: "ChatBox",
            additonal_attr: Dict[str, Any] = {}
        ):
        super().__init__(control, parent, additonal_attr)

    @abstractmethod
    def _click(self, x, y, right=False): ...

    @abstractmethod
    def _bias(self): ...

    def click(self):
        self._click(right=False, x=self._bias * 2, y=WxParam.DEFAULT_MESSAGE_YBIAS)

    def right_click(self):
        self._click(right=True, x=self._bias, y=WxParam.DEFAULT_MESSAGE_YBIAS)

    @uilock
    def select_option(self, option: str, timeout=2) -> WxResponse:
        if not self.exists():
            return WxResponse.failure('消息对象已失效')
        self._click(right=True, x=self._bias * 2, y=WxParam.DEFAULT_MESSAGE_YBIAS)
        if menu := Menu(self, timeout):
            return menu.select(option)
        else:
            return WxResponse.failure('操作失败')

    @uilock
    def forward(
        self,
        targets: Union[List[str], str],
        timeout: int = 3,
        interval: float = 0.1
    ) -> WxResponse:
        """转发消息

        Args:
            targets (Union[List[str], str]): 目标用户列表
            timeout (int, optional): 超时时间，单位为秒，若为None则不启用超时设置
            interval (float): 选择联系人时间间隔

        Returns:
            WxResponse: 调用结果
        """
        if not self.exists():
            return WxResponse.failure('消息对象已失效')
        if not self.select_option('转发...', timeout=timeout):
            return WxResponse.failure('当前消息无法转发')

        select_wnd = SelectContactWnd(self)
        return select_wnd.send(targets, interval=interval)

    @uilock
    def quote(
            self, text: str,
            at: Union[List[str], str] = None,
            timeout: int = 3
        ) -> WxResponse:
        """引用消息

        Args:
            text (str): 引用内容
            at (List[str], optional): @用户列表
            timeout (int, optional): 超时时间，单位为秒，若为None则不启用超时设置

        Returns:
            WxResponse: 调用结果
        """
        if not self.exists():
            return WxResponse.failure('消息对象已失效')
        if not self.select_option('引用', timeout=timeout):
            return WxResponse.failure('当前消息无法引用')

        if at:
            self.parent.input_at(at)

        return self.parent.send_text(text)
