from wechatauto.utils.tools import (
    detect_message_direction
)
from wechatauto import uia
from .mattr import (
    SystemMessage,
    FriendMessage,
    SelfMessage
)
from .mtype import *
from . import self as selfmsg
from . import friend as friendmsg
from typing import (
    TYPE_CHECKING,
    Literal,
    Dict,
    Any
)
import os
import re

if TYPE_CHECKING:
    from wechatauto.ui.chatbox import ChatBox


def parse_msg_attr(
    control: uia.Control,
    parent: 'ChatBox'
):
    msg_direction_hash = {
        'left': 'friend',
        'right': 'self'
    }
    if control.AutomationId:
        msg_screenshot = control.ScreenShot()
        msg_direction, msg_direction_distence = detect_message_direction(msg_screenshot)
        msg_attr = msg_direction_hash.get(msg_direction)
        os.remove(msg_screenshot)

        additonal_attr = {
            'direction': msg_direction,
            'direction_distence': msg_direction_distence
        }

    else:
        msg_attr = 'system'

    if msg_attr == 'system':
        return SystemMessage(control, parent)
    elif msg_attr == 'friend':
        return parse_msg_type(control, parent, 'Friend', additonal_attr)
    elif msg_attr == 'self':
        return parse_msg_type(control, parent, 'Self', additonal_attr)


def parse_msg_type(
        control: uia.Control,
        parent,
        attr: Literal['Self', 'Friend'],
        additonal_attr: Dict[str, Any]
    ):
    """
    多层次消息类型识别算法
    基于ClassName、Name等多重验证确保识别准确性
    """
    if attr == 'Friend':
        msgtype = friendmsg
    else:
        msgtype = selfmsg

    msg_text = control.Name
    msg_classname = control.ClassName
    msg_automation_id = control.AutomationId

    # 第一层：ClassName强特征识别（最可靠）
    classname_result = _classify_by_classname(msg_classname)
    if classname_result:
        return getattr(msgtype, f'{attr}{classname_result}')(control, parent, additonal_attr)

    # 第二层：基于ClassName分类后的详细识别
    if msg_classname == "mmui::ChatBubbleItemView":
        # Name前缀特征识别
        prefix_result = _classify_by_name_prefix(msg_text)
        if prefix_result:
            return getattr(msgtype, f'{attr}{prefix_result}')(control, parent, additonal_attr)

        # 图片消息处理
        if msg_text == '图片':
            return getattr(msgtype, f'{attr}ImageMessage')(control, parent, additonal_attr)

        # 如果都不匹配，归类为其他消息
        return getattr(msgtype, f'{attr}OtherMessage')(control, parent, additonal_attr)

    elif msg_classname == "mmui::ChatTextItemView":
        # 第三层：引用消息处理
        if _is_quote_message(msg_text):
            return getattr(msgtype, f'{attr}QuoteMessage')(control, parent, additonal_attr)
        else:
            return getattr(msgtype, f'{attr}TextMessage')(control, parent, additonal_attr)

    return getattr(msgtype, f'{attr}OtherMessage')(control, parent, additonal_attr)


def _classify_by_classname(classname: str) -> str:
    classname_mapping = {
        "mmui::ChatVoiceItemView": "VoiceMessage",
        "mmui::ChatPersonalCardItemView": "PersonalCardMessage",
    }
    return classname_mapping.get(classname, "")


def _classify_by_name_prefix(name: str) -> str:
    if name.startswith("[动画表情]") or name.startswith("[动画表情"):
        return "EmojiMessage"

    if name.startswith("[链接]"):
        return "LinkMessage"

    elif name.startswith("位置"):
        return "LocationMessage"

    elif name.startswith("文件\n"):
        return "FileMessage"

    elif name.startswith("视频"):
        return "VideoMessage"

    return ""


def _is_quote_message(name: str) -> bool:
    quote_pattern = r'^(.*?)\s*\n引用\s+(.+?)\s+的消息\s*:\s*(.*)$'
    return bool(re.search(quote_pattern, name, re.DOTALL))


def parse_msg(
    control: uia.Control,
    parent
):
    return parse_msg_attr(control, parent)
