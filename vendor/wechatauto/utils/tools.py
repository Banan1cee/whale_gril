from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import math
import re
import shutil
import time

from PIL import Image

from wechatauto.uia import ControlFromHandle, GetUiClassNameWithTimeout, QT_INTERNAL_WIN_CLASS_PREFIX
from wechatauto.utils.win32 import GetAllWindows


def get_file_dir(dir_path=None) -> Path:
    if dir_path is None:
        dir_path = Path('.').absolute()
    elif isinstance(dir_path, str):
        dir_path = Path(dir_path)
    dir_path.mkdir(parents=True, exist_ok=True)
    return dir_path


def find_window_from_root(classname=None, name=None, pid: int = None, uiaclsname: str = None, timeout=1):
    t0 = time.time()
    while True:
        wins = find_all_windows_from_root(classname, name, pid, uiaclsname)
        if len(wins) > 0:
            return wins[0]
        if time.time() - t0 > timeout:
            return None


def find_all_windows_from_root(classname: str = None, name: str = None, pid: int = None, uiaclsname: str = None):
    """从全部顶层窗口中找到满足条件的 UIA 控件。

    Args:
        classname: win32 窗口类名
        name: win32 窗口标题
        pid: 进程ID
        uiaclsname: UIA 类名（如 mmui::MainWindow），优先于 win32 类名使用
    """
    windows = GetAllWindows()
    targets = []
    for window in windows:
        # 跳过 Qt 内部消息泵等隐藏窗口，其 UIA 服务可能阻塞调用
        if window[1].startswith(QT_INTERNAL_WIN_CLASS_PREFIX):
            continue
        if (
            (all((classname, name)) and classname == window[1] and name == window[2])
            or (all((classname, not name)) and classname == window[1])
            or (all((not classname, name)) and name == window[2])
            or (all((not classname, not name)))
        ):
            try:
                if uiaclsname is not None:
                    if GetUiClassNameWithTimeout(window[0]) != uiaclsname:
                        continue
                targets.append(ControlFromHandle(window[0]))
            except Exception:
                continue
    if pid:
        targets = [w for w in targets if w and w.ProcessId == pid]
    if uiaclsname:
        targets = [w for w in targets if w and w.ClassName == uiaclsname]
    return targets


def now_time(fmt='%Y%m%d%H%M%S%f') -> str:
    return datetime.now().strftime(fmt)


def parse_wechat_time(time_str: str) -> str:
    """微信消息时间格式转换函数

    Args:
        time_str: 输入的时间字符串

    Returns:
        转换后的时间字符串
    """
    time_str = time_str.replace('星期天', '星期日')
    match = re.match(r'^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$', time_str)
    if match:
        month, day, hour, minute, second = match.groups()
        current_year = datetime.now().year
        return datetime(current_year, int(month), int(day), int(hour), int(minute), int(second)).strftime('%Y-%m-%d %H:%M:%S')

    match = re.match(r'^(\d{1,2}):(\d{1,2})$', time_str)
    if match:
        hour, minute = match.groups()
        return datetime.now().strftime('%Y-%m-%d') + f' {hour}:{minute}:00'

    match = re.match(r'^昨天 (\d{1,2}):(\d{1,2})$', time_str)
    if match:
        hour, minute = match.groups()
        yesterday = datetime.now() - timedelta(days=1)
        return yesterday.strftime('%Y-%m-%d') + f' {hour}:{minute}:00'

    match = re.match(r'^星期([一二三四五六日]) (\d{1,2}):(\d{1,2})$', time_str)
    if match:
        weekday, hour, minute = match.groups()
        weekday_num = ['一', '二', '三', '四', '五', '六', '日'].index(weekday)
        today_weekday = datetime.now().weekday()
        delta_days = (today_weekday - weekday_num) % 7
        target_day = datetime.now() - timedelta(days=delta_days)
        return target_day.strftime('%Y-%m-%d') + f' {hour}:{minute}:00'

    match = re.match(r'^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{1,2})$', time_str)
    if match:
        year, month, day, hour, minute = match.groups()
        return datetime(*[int(i) for i in [year, month, day, hour, minute]]).strftime('%Y-%m-%d %H:%M:%S')

    match = re.match(r'^(\d{2})-(\d{2}) (上午|下午) (\d{1,2}):(\d{2})$', time_str)
    if match:
        month, day, period, hour, minute = match.groups()
        current_year = datetime.now().year
        hour = int(hour)
        if period == '下午' and hour != 12:
            hour += 12
        elif period == '上午' and hour == 12:
            hour = 0
        return datetime(current_year, int(month), int(day), hour, int(minute)).strftime('%Y-%m-%d %H:%M:%S')

    return time_str


def is_valid_image(file_path) -> bool:
    path = Path(file_path)

    if not path.exists() or not path.is_file():
        return False

    try:
        with Image.open(path) as img:
            img.verify()  # 只验证图像，不会完全解码
        return True
    except Exception:
        return False


def delete_update_files():
    """清理微信更新缓存，避免更新弹窗干扰自动化操作"""
    home = Path.home()
    update_dir = home / 'AppData' / 'Roaming' / 'Tencent' / 'xwechat' / 'update'
    if update_dir.exists():
        for file in update_dir.iterdir():
            try:
                shutil.rmtree(file) if file.is_dir() else file.unlink()
            except Exception:
                pass


# ============================================================================================================================================
#                                                           消息解析方法
# ============================================================================================================================================

def detect_message_direction(
    image_path: str,
    avatar_height_ratio: float = 0.8,
    tolerance: int = 0,
) -> tuple[str, float]:
    """通过截图判断消息气泡的方向。

    Args:
        image_path: 消息截图路径。
        avatar_height_ratio: 头像在截图中占据的高度比例。
        tolerance: 像素颜色比较的容忍度。

    Returns:
        Tuple[str, float]: ``("left", distance)`` 或 ``("right", distance)``，
        ``distance`` 表示从对应方向开始出现气泡的列索引，便于后续定位。
    """

    img = Image.open(image_path)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    w, h = img.size

    # 仅取中间 band 区域
    band_h = int(h * avatar_height_ratio)
    y0 = (h - band_h) // 2
    y1 = y0 + band_h

    pixels = img.load()  # 获取像素访问对象

    def is_uniform_column(x: int) -> bool:
        base = pixels[x, y0]  # 以 band 顶部像素作为参考
        for y in range(y0, y1):
            r, g, b = pixels[x, y]
            if (abs(r - base[0]) > tolerance or
                abs(g - base[1]) > tolerance or
                abs(b - base[2]) > tolerance):
                return False
        return True

    # 从左边扫描
    left_idx = math.inf
    for x in range(w):
        if not is_uniform_column(x):
            left_idx = x
            break

    # 从右边扫描
    right_idx = math.inf
    for offset, x in enumerate(range(w - 1, -1, -1)):
        if not is_uniform_column(x):
            right_idx = offset  # 距右边界的列数
            break

    if left_idx == math.inf and right_idx == math.inf:
        # 都没找到变化列，兜底
        return 'right', math.inf
    if left_idx <= right_idx:
        return 'left', float(left_idx)
    return 'right', float(right_idx)


def calculate_pixel_variance(region) -> float:
    """计算图像区域的像素变化程度"""
    if region.size[0] == 0 or region.size[1] == 0:
        return 0

    # 获取所有像素值
    pixels = list(region.getdata())

    if not pixels:
        return 0

    # 分别计算R、G、B通道的方差
    r_values = [p[0] for p in pixels]
    g_values = [p[1] for p in pixels]
    b_values = [p[2] for p in pixels]

    r_variance = calculate_variance(r_values)
    g_variance = calculate_variance(g_values)
    b_variance = calculate_variance(b_values)

    return r_variance + g_variance + b_variance


def calculate_variance(values) -> float:
    """计算数值列表的方差"""
    if not values:
        return 0

    # 计算平均值
    mean = sum(values) / len(values)

    # 计算方差
    variance = sum((x - mean) ** 2 for x in values) / len(values)

    return variance


def calculate_color_diversity(region) -> float:
    """计算区域颜色多样性（备用方法）"""
    pixels = list(region.getdata())

    if not pixels:
        return 0

    # 统计不同颜色的数量
    color_set = set(pixels)
    unique_colors = len(color_set)

    # 计算颜色多样性比例
    diversity_ratio = unique_colors / len(pixels)

    return diversity_ratio


def detect_message_direction_enhanced(
    image_path: str,
    avatar_width_ratio: float = 0.15,
    avatar_height_ratio: float = 0.8,
) -> tuple[str, float]:
    """增强版检测，结合方差和颜色多样性"""

    img = Image.open(image_path).convert('RGB')
    width, height = img.size

    avatar_width = int(width * avatar_width_ratio)
    avatar_height = int(height * avatar_height_ratio)
    avatar_start_y = (height - avatar_height) // 2
    avatar_end_y = avatar_start_y + avatar_height

    # 截取左右头像区域
    left_box = (0, avatar_start_y, avatar_width, avatar_end_y)
    right_box = (width - avatar_width, avatar_start_y, width, avatar_end_y)

    left_region = img.crop(left_box)
    right_region = img.crop(right_box)

    # 计算方差和颜色多样性
    left_variance = calculate_pixel_variance(left_region)
    right_variance = calculate_pixel_variance(right_region)

    left_diversity = calculate_color_diversity(left_region)
    right_diversity = calculate_color_diversity(right_region)

    # 综合评分（方差权重0.7，多样性权重0.3）
    left_score = left_variance * 0.7 + left_diversity * 1000 * 0.3
    right_score = right_variance * 0.7 + right_diversity * 1000 * 0.3

    if left_score > right_score:
        return 'left', float(left_score)
    return 'right', float(right_score)


def batch_detect_messages(image_paths, method='basic', **kwargs):
    """批量检测多条消息的方向"""
    results = []

    detect_func = detect_message_direction if method == 'basic' else detect_message_direction_enhanced

    for path in image_paths:
        try:
            result = detect_func(path, **kwargs)
            if isinstance(result, tuple):
                direction, distance = result
            else:
                direction, distance = result, None
            sender = '对方' if direction == 'left' else '自己'
            results.append({
                'path': path,
                'direction': direction,
                'sender': sender,
                'distance': distance,
            })
        except Exception as e:
            results.append({
                'path': path,
                'direction': 'unknown',
                'sender': '未知',
                'error': str(e)
            })

    return results
