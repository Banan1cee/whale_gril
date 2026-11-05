"""项目内部使用的异常类型定义。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class WechatautoError(Exception):
    """基础异常类型。

    Args:
        message: 错误信息。若未提供则使用 ``default_message``。
        detail: 附加的上下文信息，可用于在日志中打印更友好的提示。
    """

    default_message: str = ""
    message: Optional[str] = None
    detail: Optional[str] = None

    def __post_init__(self) -> None:
        msg = self.message or self.default_message or self.__class__.__name__
        super().__init__(msg)
        self.message = msg

    def __str__(self) -> str:
        return self.message or ""

    def __repr__(self) -> str:
        detail = f", detail={self.detail!r}" if self.detail else ""
        return f"{self.__class__.__name__}(message={self.message!r}{detail})"


class NetWorkError(WechatautoError):
    """网络请求相关异常。"""

    default_message = "微信无法连接到网络"


class WechatautoUINotFoundError(WechatautoError):
    """当无法定位到指定 UI 控件时抛出。"""

    default_message = "未找到目标 UI 控件"


class WechatautoNoteLoadTimeoutError(WechatautoError):
    """微信笔记加载超时异常。"""

    default_message = "微信笔记加载超时"


class WechatautoNotLoggedInError(WechatautoError):
    """未找到已登录的微信窗口时抛出。"""

    default_message = "未找到已登录的微信主窗口"


__all__ = [
    "WechatautoError",
    "NetWorkError",
    "WechatautoUINotFoundError",
    "WechatautoNoteLoadTimeoutError",
    "WechatautoNotLoggedInError",
]
