"""UIA 兼容适配层。

基于 PyPI ``uiautomation`` 封装，并补充 wechatauto 依赖的扩展能力：

- :attr:`Control.runtimeid` —— 控件 RuntimeId 的字符串形式，用于消息去重/定位
- :meth:`Control.ScreenShot` —— 截取控件区域保存为图片文件
- :func:`RollIntoView` —— 将目标元素滚动到窗口可见区域内
- :func:`CheckElementPosition` / :func:`IsElementInWindow` —— 元素与窗口位置关系判断

Windows 微信 4.x 客户端为 Qt 应用（UIA 类名前缀 ``mmui::``），
仅暴露 UIA 标准接口，因此本层不依赖具体微信版本。
"""

from __future__ import annotations

import os
import queue
import tempfile
import threading
import time
from typing import Any

from PIL import Image as _PILImage

# uiautomation 和 comtypes 初始化（COM + UIA）可能在部分系统上阻塞
# （如微信或其他 Qt 应用占用 COM），改为延迟导入：仅在首次访问本包属性时
# 才加载，避免 ``import wechatauto`` 时卡死。
_uia_loaded = False
_UiaControl = None
_control_from_handle = None
_CoInitializeEx = None


def _ensure_uia():
    """延迟加载 uiautomation 并完成 monkey-patch，只执行一次。"""
    global _uia_loaded, _UiaControl, _control_from_handle, _CoInitializeEx
    if _uia_loaded:
        return
    _uia_loaded = True

    from comtypes import CoInitializeEx as _ci
    from uiautomation import Control as _uc, ControlFromHandle as _cfh

    _CoInitializeEx = _ci
    _UiaControl = _uc
    _control_from_handle = _cfh

    _uc.runtimeid = property(_get_runtimeid)
    _uc.ScreenShot = _screen_shot

    # 把 __all__ 中的名称绑定到模块全局，让 from uiautomation import * 的
    # 等效访问能直接命中，不再触发 __getattr__ 回退查找
    import uiautomation as _mod
    for _n in __all__:
        if _n not in globals():
            _v = getattr(_mod, _n, None)
            if _v is not None:
                globals()[_n] = _v


def __getattr__(name: str) -> Any:
    """延迟导入：首次访问时加载 uiautomation。"""
    _ensure_uia()
    try:
        return globals()[name]
    except KeyError:
        # 从 uiautomation 星号导入的名称，首次访问时从实际模块取回
        import uiautomation as _mod
        val = getattr(_mod, name, _SENTINEL)
        if val is _SENTINEL:
            raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
        globals()[name] = val
        return val


_SENTINEL = object()

__all__ = [
    'ControlFromHandle',
    'GetUiClassNameWithTimeout',
    'WalkControl',
    'RollIntoView',
    'CheckElementPosition',
    'IsElementInWindow',
    'GetElementPositionDescription',
]

# UIA 类名以 Qt 内部消息泵开头的隐藏窗口（如 WPS 等 Qt 应用），
# 其 UIA 服务可能长时间无响应导致调用阻塞，扫描时应直接跳过
QT_INTERNAL_WIN_CLASS_PREFIX = 'QEventDispatcherWin32_Internal_'


def GetUiClassNameWithTimeout(hwnd, timeout: float = 3.0) -> 'str | None':
    """带超时保护地获取窗口的 UIA 类名。

    部分 Qt 应用的隐藏窗口（如 ``QEventDispatcherWin32_Internal_*``）UIA 服务异常，
    直接调用会无限阻塞。本函数在守护线程中调用底层接口，超时后放弃该窗口。

    Args:
        hwnd: 窗口句柄
        timeout: 超时时间，单位秒

    Returns:
        str: 窗口的 UIA 类名；超时/失败时返回 None
    """
    result_queue = queue.Queue()
    _ensure_uia()

    def _probe():
        try:
            _CoInitializeEx()
            control = _control_from_handle(hwnd)
            result_queue.put(control.ClassName if control is not None else None)
        except Exception as e:  # noqa: BLE001
            result_queue.put(e)

    worker = threading.Thread(target=_probe, daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        # 底层 UIA 调用被异常进程阻塞，放弃等待（守护线程随进程退出）
        return None
    try:
        result = result_queue.get_nowait()
    except queue.Empty:
        return None
    if isinstance(result, Exception):
        return None
    return result

# ----------------------------------------------------------------------------
# Control 扩展：runtimeid
# ----------------------------------------------------------------------------

def _get_runtimeid(self) -> str:
    """返回控件 RuntimeId 的字符串形式，用于唯一标识控件。"""
    return ''.join(str(i) for i in self.GetRuntimeId())

# ----------------------------------------------------------------------------
# Control 扩展：ScreenShot
# ----------------------------------------------------------------------------

def _screen_shot(self, savePath: str = None, crop: tuple = (0, 0, 0, 0),
                 crop_percentage: bool = False, return_img=False):
    """截取控件区域并保存/返回图片。

    Args:
        savePath: 保存路径，不指定则使用临时文件
        crop: 裁剪量 (left, top, right, bottom)
        crop_percentage: crop 值是否为百分比
        return_img: 为 True 时直接返回 PIL Image 对象

    Returns:
        str: 图片保存路径；return_img=True 时返回 PIL Image
    """
    rect = self.BoundingRectangle
    w, h = rect.width(), rect.height()

    if crop_percentage:
        crop = (
            int(w * crop[0] / 100),
            int(h * crop[1] / 100),
            int(w * crop[2] / 100),
            int(h * crop[3] / 100),
        )

    cw = max(w - crop[0] - crop[2], 1)
    ch = max(h - crop[1] - crop[3], 1)

    if savePath is None:
        fd, savePath = tempfile.mkstemp(prefix='wechatauto_image_', suffix='.png')
        os.close(fd)
        os.remove(savePath)

    ok = self.CaptureToImage(savePath, x=crop[0], y=crop[1], width=cw, height=ch)
    if not ok:
        raise RuntimeError(f'截图失败: {self}')

    if return_img:
        img = _PILImage.open(savePath)
        try:
            os.remove(savePath)
        except Exception:
            pass
        return img
    return savePath

# ----------------------------------------------------------------------------
# 模块级工具函数
# ----------------------------------------------------------------------------

def RollIntoView(win, ele, equal=True, bias=0):
    """将目标元素滚动到主窗口内可见区域。

    Args:
        win: 主窗口元素 (Control对象)
        ele: 目标元素 (Control对象)
        bias: 偏移量，元素边缘需要超过这个量才算完全在窗口内 (默认为0)
    """
    # 获取窗口和元素的边界矩形
    win_rect = win.BoundingRectangle
    ele_rect = ele.BoundingRectangle

    # 计算窗口的有效显示区域（考虑bias偏移）
    win_top = win_rect.top + bias
    win_bottom = win_rect.bottom - bias
    win_height = win_bottom - win_top

    # 获取元素的位置信息
    ele_top = ele_rect.top
    ele_bottom = ele_rect.bottom
    ele_height = ele_rect.height()
    ele_ycenter = ele_rect.ycenter()

    # 如果元素高度超过窗口高度，只需要确保元素中心在窗口内
    if ele_height > win_height:
        # 元素太高，只需要中心点在窗口内即可
        target_top = ele_ycenter
        target_bottom = ele_ycenter
    else:
        # 元素高度适中，需要整个元素都在窗口内
        target_top = ele_top
        target_bottom = ele_bottom

    # 执行滚动操作
    max_attempts = 100  # 防止无限循环
    attempt = 0

    while attempt < max_attempts:
        # 重新获取当前位置（滚动后位置会变化）
        current_ele_rect = ele.BoundingRectangle

        if ele_height > win_height:
            # 元素太高的情况，检查中心点
            current_ycenter = current_ele_rect.ycenter()
            if win_top <= current_ycenter <= win_bottom:
                break  # 中心点已在窗口内，停止滚动

            if current_ycenter < win_top:
                # 中心点在窗口上方，需要向下滚动
                win.WheelUp()
                time.sleep(0.1)
            elif current_ycenter > win_bottom:
                # 中心点在窗口下方，需要向上滚动
                win.WheelDown()
                time.sleep(0.1)
        else:
            # 元素高度适中的情况，检查整个元素
            current_top = current_ele_rect.top
            current_bottom = current_ele_rect.bottom

            # 检查是否已经完全在窗口内
            if win_top <= current_top and current_bottom <= win_bottom:
                break  # 元素已完全在窗口内，停止滚动

            if current_top < win_top:
                # 元素顶部在窗口上方，需要向下滚动
                win.WheelUp()
                time.sleep(0.1)
            elif current_bottom > win_bottom:
                # 元素底部在窗口下方，需要向上滚动
                win.WheelDown()
                time.sleep(0.1)
            else:
                # 理论上不应该到达这里
                break

        attempt += 1

    if attempt >= max_attempts:
        print(f"Warning: 滚动操作达到最大尝试次数({max_attempts})，可能元素无法完全滚动到视图内")


def CheckElementPosition(win, ele, bias=0) -> dict:
    """判断目标元素相对于主窗口的位置关系。

    Returns:
        dict: 包含各种位置关系判断结果的字典
    """
    win_rect = win.BoundingRectangle
    ele_rect = ele.BoundingRectangle

    win_top = win_rect.top + bias
    win_bottom = win_rect.bottom - bias
    win_left = win_rect.left + bias
    win_right = win_rect.right - bias

    ele_top = ele_rect.top
    ele_bottom = ele_rect.bottom
    ele_left = ele_rect.left
    ele_right = ele_rect.right

    result = {
        'ele_top_above_win_top': ele_top < win_top,
        'ele_bottom_below_win_bottom': ele_bottom > win_bottom,
        'ele_completely_above_win': ele_bottom <= win_top,
        'ele_completely_below_win': ele_top >= win_bottom,
        'ele_vertically_inside_win': win_top <= ele_top and ele_bottom <= win_bottom,
        'win_vertically_inside_ele': ele_top <= win_top and win_bottom <= ele_bottom,

        'ele_left_before_win_left': ele_left < win_left,
        'ele_right_after_win_right': ele_right > win_right,
        'ele_completely_left_of_win': ele_right <= win_left,
        'ele_completely_right_of_win': ele_left >= win_right,
        'ele_horizontally_inside_win': win_left <= ele_left and ele_right <= win_right,
        'win_horizontally_inside_ele': ele_left <= win_left and win_right <= ele_right,

        'ele_completely_inside_win': False,
        'win_completely_inside_ele': False,
        'ele_and_win_overlap': False,
        'ele_and_win_separate': False,
    }

    result['ele_completely_inside_win'] = (
        result['ele_vertically_inside_win'] and result['ele_horizontally_inside_win'])
    result['win_completely_inside_ele'] = (
        result['win_vertically_inside_ele'] and result['win_horizontally_inside_ele'])

    vertical_overlap = not (result['ele_completely_above_win'] or result['ele_completely_below_win'])
    horizontal_overlap = not (result['ele_completely_left_of_win'] or result['ele_completely_right_of_win'])
    result['ele_and_win_overlap'] = vertical_overlap and horizontal_overlap
    result['ele_and_win_separate'] = not result['ele_and_win_overlap']

    return result


def IsElementInWindow(win, ele, bias=0) -> bool:
    """简化版本：判断元素是否在窗口内（仅垂直方向）"""
    position_info = CheckElementPosition(win, ele, bias)
    return position_info['ele_vertically_inside_win']


def GetElementPositionDescription(win, ele, bias=0) -> str:
    """获取元素位置的文字描述"""
    result = CheckElementPosition(win, ele, bias)

    if result['ele_completely_inside_win']:
        return "元素完全在窗口内部"
    elif result['win_completely_inside_ele']:
        return "窗口完全在元素内部"
    elif result['ele_completely_above_win']:
        return "元素完全在窗口上方"
    elif result['ele_completely_below_win']:
        return "元素完全在窗口下方"
    elif result['ele_completely_left_of_win']:
        return "元素完全在窗口左侧"
    elif result['ele_completely_right_of_win']:
        return "元素完全在窗口右侧"
    elif result['ele_vertically_inside_win']:
        return "元素在窗口内，但水平方向超出范围"
    elif result['ele_horizontally_inside_win']:
        return "元素在窗口内，但垂直方向超出范围"
    elif result['ele_and_win_overlap']:
        return "元素与窗口部分重叠"
    else:
        return "元素与窗口完全分离"
