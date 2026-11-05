import os
import time
import struct
import shutil
import traceback
import ctypes
from typing import List, Optional, Sequence, Tuple, Union

import win32ui
import win32gui
import win32api
import win32con
import win32process
import win32clipboard
import pyperclip
import psutil
from PIL import Image


def GetAllWindows(name=None, classname=None) -> List[Tuple[int, str, str]]:
    """获取所有顶层窗口的信息，返回 (窗口句柄, 类名, 窗口标题) 列表"""
    windows = []

    def enum_windows_proc(hwnd, extra):
        class_name = win32gui.GetClassName(hwnd)
        window_title = win32gui.GetWindowText(hwnd)
        windows.append((hwnd, class_name, window_title))

    win32gui.EnumWindows(enum_windows_proc, None)
    if name:
        windows = [i for i in windows if i[-1] == name]
    if classname:
        windows = [i for i in windows if i[1] == classname]
    return windows


def GetCursorWindow():
    x, y = win32api.GetCursorPos()
    hwnd = win32gui.WindowFromPoint((x, y))
    window_title = win32gui.GetWindowText(hwnd)
    class_name = win32gui.GetClassName(hwnd)
    return hwnd, window_title, class_name


def set_cursor_pos(x, y):
    win32api.SetCursorPos((x, y))


def Click(rect):
    x = (rect.left + rect.right) // 2
    y = (rect.top + rect.bottom) // 2
    set_cursor_pos(x, y)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, x, y, 0, 0)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, x, y, 0, 0)


def GetPathByHwnd(hwnd) -> Optional[str]:
    try:
        thread_id, process_id = win32process.GetWindowThreadProcessId(hwnd)
        process = psutil.Process(process_id)
        return process.exe()
    except Exception:
        return None


def GetVersionByPath(file_path) -> Optional[str]:
    try:
        info = win32api.GetFileVersionInfo(file_path, '\\')
        version = "{}.{}.{}.{}".format(win32api.HIWORD(info['FileVersionMS']),
                                        win32api.LOWORD(info['FileVersionMS']),
                                        win32api.HIWORD(info['FileVersionLS']),
                                        win32api.LOWORD(info['FileVersionLS']))
    except Exception:
        version = None
    return version


def capture(hwnd, bbox) -> Image.Image:
    """截取指定窗口的指定区域，返回 PIL 图像"""
    window_rect = win32gui.GetWindowRect(hwnd)
    win_left, win_top, win_right, win_bottom = window_rect
    win_width = win_right - win_left
    win_height = win_bottom - win_top

    # 获取窗口的设备上下文
    hwndDC = win32gui.GetWindowDC(hwnd)
    mfcDC = win32ui.CreateDCFromHandle(hwndDC)
    saveDC = mfcDC.CreateCompatibleDC()

    # 创建位图对象保存整个窗口截图
    saveBitMap = win32ui.CreateBitmap()
    saveBitMap.CreateCompatibleBitmap(mfcDC, win_width, win_height)
    saveDC.SelectObject(saveBitMap)

    # 使用PrintWindow捕获整个窗口（包括被遮挡或最小化的窗口）
    result = ctypes.windll.user32.PrintWindow(hwnd, saveDC.GetSafeHdc(), 3)

    # 转换为PIL图像
    bmpinfo = saveBitMap.GetInfo()
    bmpstr = saveBitMap.GetBitmapBits(True)
    im = Image.frombuffer(
        'RGB',
        (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
        bmpstr, 'raw', 'BGRX', 0, 1)

    # 释放资源
    win32gui.DeleteObject(saveBitMap.GetHandle())
    saveDC.DeleteDC()
    mfcDC.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwndDC)

    # 计算bbox相对于窗口左上角的坐标
    bbox_left, bbox_top, bbox_right, bbox_bottom = bbox
    crop_left = bbox_left - win_left
    crop_top = bbox_top - win_top
    crop_right = bbox_right - win_left
    crop_bottom = bbox_bottom - win_top

    # 裁剪目标区域
    cropped_im = im.crop((crop_left, crop_top, crop_right, crop_bottom))
    return cropped_im


def GetText(HWND) -> str:
    length = win32gui.SendMessage(HWND, win32con.WM_GETTEXTLENGTH) * 2
    buffer = win32gui.PyMakeBuffer(length)
    win32api.SendMessage(HWND, win32con.WM_GETTEXT, length, buffer)
    address, length_ = win32gui.PyGetBufferAddressAndLen(buffer[:-1])
    text = win32gui.PyGetString(address, length_)[:int(length / 2)]
    buffer.release()
    return text


def GetAllWindowExs(HWND) -> Optional[List[list]]:
    if not HWND:
        return None
    handles = []
    win32gui.EnumChildWindows(
        HWND, lambda hwnd, param: param.append([hwnd, win32gui.GetClassName(hwnd), GetText(hwnd)]), handles)
    return handles


def FindWindow(classname=None, name=None, timeout=0) -> int:
    t0 = time.time()
    while True:
        HWND = win32gui.FindWindow(classname, name)
        if HWND:
            break
        if time.time() - t0 > timeout:
            break
        time.sleep(0.01)
    return HWND


def FindWinEx(HWND, classname=None, name=None) -> list:
    hwnds_classname = []
    hwnds_name = []

    def find_classname(hwnd, classname):
        classname_ = win32gui.GetClassName(hwnd)
        if classname_ == classname:
            if hwnd not in hwnds_classname:
                hwnds_classname.append(hwnd)

    def find_name(hwnd, name):
        name_ = GetText(hwnd)
        if name in name_:
            if hwnd not in hwnds_name:
                hwnds_name.append(hwnd)

    if classname:
        win32gui.EnumChildWindows(HWND, find_classname, classname)
    if name:
        win32gui.EnumChildWindows(HWND, find_name, name)
    if classname and name:
        hwnds = [hwnd for hwnd in hwnds_classname if hwnd in hwnds_name]
    else:
        hwnds = hwnds_classname + hwnds_name
    return hwnds


def ClipboardFormats(unit=0, *units) -> List[int]:
    units = list(units)
    retry_count = 5
    while retry_count > 0:
        try:
            win32clipboard.OpenClipboard()
            try:
                u = win32clipboard.EnumClipboardFormats(unit)
            finally:
                win32clipboard.CloseClipboard()
            break
        except Exception:
            retry_count -= 1
    units.append(u)
    if u:
        units = ClipboardFormats(u, *units)
    return units


def ReadClipboardData() -> dict:
    Dict = {}
    formats = ClipboardFormats()

    for i in formats:
        if i == 0:
            continue

        retry_count = 5
        while retry_count > 0:
            try:
                win32clipboard.OpenClipboard()
                try:
                    data = win32clipboard.GetClipboardData(i)
                    Dict[str(i)] = data
                finally:
                    win32clipboard.CloseClipboard()
                break
            except Exception:
                retry_count -= 1
    return Dict


def SetClipboardData(data_dict: dict) -> None:
    try:
        # 打开剪贴板
        win32clipboard.OpenClipboard()

        # 清空剪贴板
        win32clipboard.EmptyClipboard()

        # 遍历数据字典，设置各种格式的数据
        for format_id, data in data_dict.items():
            # 将字符串格式ID转换为整数
            format_num = int(format_id)

            if isinstance(data, str):
                # 如果是字符串，使用Unicode格式
                win32clipboard.SetClipboardData(format_num, data)
            elif isinstance(data, bytes):
                # 如果是字节数据，直接设置
                win32clipboard.SetClipboardData(format_num, data)
    except Exception as e:
        print(f"设置剪贴板数据时出错: {e}")

    finally:
        # 关闭剪贴板
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            pass


def SetClipboardText(text: str) -> None:
    pyperclip.copy(text)


class DROPFILES(ctypes.Structure):
    _fields_ = [
        ("pFiles", ctypes.c_uint),
        ("x", ctypes.c_long),
        ("y", ctypes.c_long),
        ("fNC", ctypes.c_int),
        ("fWide", ctypes.c_bool),
    ]


def set_files_to_clipboard(file_paths: Union[str, Sequence[str]]) -> bool:
    """将文件路径列表设置到剪贴板的 CF_HDROP 格式"""
    # 如果传入的是单个字符串，转换为列表
    if isinstance(file_paths, str):
        file_paths = [file_paths]

    # 验证文件路径是否存在
    valid_paths = []
    for path in file_paths:
        if os.path.exists(path):
            # 转换为绝对路径
            abs_path = os.path.abspath(path)
            valid_paths.append(abs_path)
        else:
            raise ValueError(f"文件路径不存在: {path}")

    if not valid_paths:
        return False

    try:
        # 打开剪贴板
        win32clipboard.OpenClipboard()

        # 清空剪贴板
        win32clipboard.EmptyClipboard()

        # 计算偏移量（DROPFILES结构大小为20字节）
        offset = 20

        # 构建DROPFILES头部
        dropfiles_header = struct.pack('<LLLLL',
                                       offset,  # pFiles偏移量
                                       0,       # pt.x
                                       0,       # pt.y
                                       0,       # fNC
                                       1)       # fWide (使用Unicode)

        # 构建文件路径字符串（Unicode，以双null结尾）
        file_list = []
        for path in valid_paths:
            # 转换为Unicode字节
            file_list.append(path.encode('utf-16le'))
            file_list.append(b'\x00\x00')  # Unicode null终止符

        # 添加额外的双null作为列表结束标记
        file_list.append(b'\x00\x00')

        # 合并所有数据
        file_data = b''.join(file_list)
        hdrop_data = dropfiles_header + file_data

        # 设置到剪贴板
        win32clipboard.SetClipboardData(win32con.CF_HDROP, hdrop_data)

        return True

    except Exception:
        traceback.print_exc()
        return False

    finally:
        # 关闭剪贴板
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            pass


def SetClipboardFiles(paths) -> bool:
    return set_files_to_clipboard(paths)


def PasteFile(folder) -> bool:
    folder = os.path.realpath(folder)
    if not os.path.exists(folder):
        os.makedirs(folder)

    t0 = time.time()
    while True:
        if time.time() - t0 > 10:
            raise TimeoutError(f"读取剪贴板文件超时！")
        try:
            win32clipboard.OpenClipboard()
            if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_HDROP):
                files = win32clipboard.GetClipboardData(win32clipboard.CF_HDROP)
                for file in files:
                    filename = os.path.basename(file)
                    dest_file = os.path.join(folder, filename)
                    shutil.copy2(file, dest_file)
                    return True
            else:
                print("剪贴板中没有文件")
                return False
        except Exception:
            pass
        finally:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass


def enum_windows_by_pid(pid: int) -> List[int]:
    window_list = []

    def enum_callback(hwnd, lParam):
        # 获取窗口的进程ID
        _, process_id = win32process.GetWindowThreadProcessId(hwnd)

        # 如果是目标进程，检查窗口是否可见
        if process_id == pid:
            if is_window_visible(hwnd):
                window_list.append(hwnd)
        return True

    win32gui.EnumWindows(enum_callback, None)
    return window_list


def is_window_visible(hwnd) -> bool:
    # 检查窗口是否可见
    style = win32gui.GetWindowLong(hwnd, win32con.GWL_STYLE)
    # 检查窗口是否有 WS_VISIBLE 标志，且不是最小化的
    if style & win32con.WS_VISIBLE and not win32gui.IsIconic(hwnd):
        return True
    return False


def get_windows_by_pid(pid: int) -> List[int]:
    while True:
        try:
            windows = enum_windows_by_pid(pid)
            return windows
        except Exception:
            time.sleep(0.1)
