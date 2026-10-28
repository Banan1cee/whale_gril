#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信 4.x 零焦点发送通道。

按 `docs/微信消息后台发送.md` 实现，三条腿全部走窗口消息：

    物化  SPI_SETSCREENREADER（让 Qt 把 UIA 树长出来）
    读    UIA FindAll(Descendants)，认 AutomationId=chat_input_field / Name=发送
    写    PostMessage WM_SETFOCUS → GBK 字节逐个 WM_CHAR → PostMessage 点发送

全程不调用 `SetForegroundWindow` / `SetWindowPos` / `SetFocus` / `SendInput` /
`keybd_event`，所以是**结构上不碰前台**，不是「碰完再还原」。
唯一会动的全局状态是 `SPI_SETSCREENREADER`，进程退出时还原（见 `shutdown()`）。

相对文档的三处补充（都是本机实测逼出来的）：

1. **物化兜底**：微信 4.2 上单独设 SPI 只长到 2 个节点，必须再走
   `wechatauto.accessibility.wake()` 的 gate RVA 热激活。这里自动降级。
2. **`open_chat()`**：文档假设「已切到目标会话」，桥接要自己切，所以多点一次
   会话列表行（只点列表，不碰搜索框）。
3. **权限**：`PostMessage` 受 UIPI 约束。微信提权、桥接不提权时全部静默失败，
   这里把 `ERROR_ACCESS_DENIED` 翻译成 `uipi_denied`，让调用方能给出人话提示。

对外只有两个函数：`send()` 和 `probe()`。`send()` 返回 `(ok, reason)`，
`reason` 是稳定的英文枚举，桥接据此决定要不要退回前台通道。
"""

import ctypes
import re
import threading
import time
from ctypes import wintypes

__all__ = [
    "send",
    "probe",
    "read_ui",
    "find_hwnd",
    "shutdown",
    "encode_gbk",
    "norm_chat_name",
    "name_score",
    "WeChatSender",
]

user32 = ctypes.WinDLL("user32", use_last_error=True)

# ---------------------------------------------------------------- 消息常量（文档 §4）
WM_SETFOCUS = 0x0007
WM_KILLFOCUS = 0x0008
WM_CHAR = 0x0102
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202

#: 文档 §4.6：WM_ACTIVATE (0x0006) **千万不要发**。
#: 伪焦点能骗（只改 Qt 内部状态），伪激活不能 —— 发了系统真的会把窗口切到前台。
#: 所以这里连常量都不定义，避免后来人顺手用上。

SPI_GETSCREENREADER = 0x0046
SPI_SETSCREENREADER = 0x0047
SPIF_UPDATEINIFILE = 0x01

ERROR_ACCESS_DENIED = 5

#: 文档 §4.2 控件标识
CHAT_INPUT_AID = "chat_input_field"
SEND_BUTTON_NAME = "发送"
SESSION_LIST_AIDS = ("session_list",)

#: 树「够用」的节点数门限：默认 2 个节点 = 没物化；62~67 = TreeWalker 断在中间；
#: 150+ = FindAll 拿到全部。20 是个宽松下限，能找到输入框就行。
MIN_NODES = 20

#: 会话行至少要这么宽，避免误点标题栏 / 未读小圆点之类的小控件
MIN_ROW_W = 60

#: 显示窗口但**不激活**（文档 §8.5 的「最小化不行」在本机实测里其实是「隐藏了不行」：
#: 微信缩到托盘时主窗 visible=False，控件树直接是 1 个节点）。
#: SW_SHOWNOACTIVATE 只显示、不抢前台，实测前后前台窗口号不变。
SW_SHOWNOACTIVATE = 4


def _dpi_awareness():
    """0=不感知 1=系统级 2=每显示器。

    文档 §4.8 的坑：UIA 的 `BoundingRectangle` 是**物理像素**，而 DPI 不感知的
    进程调 `ScreenToClient` 拿到的是**逻辑像素**坐标。两者差一个缩放比（本机
    150% 实测差 1.5 倍），点击就会落到别的控件上 —— 现象是「点了会话，页面变了，
    但输入框没了」。
    """
    try:
        v = ctypes.c_int(0)
        ctypes.WinDLL("shcore").GetProcessDpiAwareness(None, ctypes.byref(v))
        return int(v.value)
    except Exception:
        return 0


def ensure_dpi_aware():
    """尽量把进程切成 per-monitor DPI aware，让 UIA 坐标和 ScreenToClient 同一套。

    切不动（进程已经建过窗口 / 系统太老）时返回 False，调用方改用
    `PhysicalToLogicalPointForPerMonitorDPI` 手动换算。
    """
    if _dpi_awareness() != 0:
        return True
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):   # PER_MONITOR_AWARE_V2
            return True
    except Exception:
        pass
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)              # PER_MONITOR
        return True
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


DPI_AWARE = ensure_dpi_aware()


# ---------------------------------------------------------------- 原型声明（文档 §5.1）
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.ScreenToClient.restype = wintypes.BOOL
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND
user32.GetForegroundWindow.restype = wintypes.HWND
user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT,
                                         ctypes.c_void_p, wintypes.UINT]
user32.SystemParametersInfoW.restype = wintypes.BOOL
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL


class UipiDenied(RuntimeError):
    """微信完整性级别高于本进程，PostMessage 被 UIPI 拦了（文档 §10.1 ②）。"""


def _noop(*_a, **_kw):
    pass


# ---------------------------------------------------------------- 物化（文档 §4.1）
class _ScreenReader:
    """系统「屏幕阅读器」标志：开一次，进程内保持，退出时还原。

    文档要求「必须还原」。对一个常驻桥接来说，每条消息开一次关一次会让树反复塌缩
    （关掉标志后控件树会缩回去，下一条又要等 1 秒），所以这里按**进程生命周期**
    管理：第一次发送时打开，`atexit` / `shutdown()` 还原。

    注意：看门狗用 `os._exit()` 强杀进程时 atexit 不会跑，标志会留在开着的状态。
    下次启动时 `_restore()` 会把它关掉，所以最多残留到下一次启动。
    """

    _lock = threading.Lock()
    _on = False
    _prev = 0

    @classmethod
    def enable(cls):
        with cls._lock:
            if cls._on:
                return
            prev = ctypes.c_uint(0)
            try:
                user32.SystemParametersInfoW(SPI_GETSCREENREADER, 0,
                                             ctypes.byref(prev), 0)
            except Exception:
                prev = ctypes.c_uint(0)
            cls._prev = int(prev.value)
            try:
                user32.SystemParametersInfoW(
                    SPI_SETSCREENREADER, 0, ctypes.c_void_p(1), SPIF_UPDATEINIFILE
                )
            except Exception:
                pass
            cls._on = True

    @classmethod
    def restore(cls):
        with cls._lock:
            if not cls._on:
                return
            try:
                user32.SystemParametersInfoW(
                    SPI_SETSCREENREADER, 0, ctypes.c_void_p(cls._prev),
                    SPIF_UPDATEINIFILE
                )
            except Exception:
                pass
            cls._on = False

    @classmethod
    def enabled(cls):
        v = ctypes.c_uint(0)
        try:
            user32.SystemParametersInfoW(SPI_GETSCREENREADER, 0,
                                         ctypes.byref(v), 0)
        except Exception:
            return False
        # 文档 §4.1：这个读回值不可信（树起来了它也可能是 0），只作调试参考
        return bool(v.value)


def find_hwnd():
    """按标题找微信主窗。类名会随 Qt 版本变，标题更稳（文档 §5.1）。"""
    for title in ("微信", "Weixin", "WeChat"):
        try:
            h = user32.FindWindowW(None, title)
        except Exception:
            h = 0
        if h:
            return int(h)
    return 0


def _gate_pulse(hwnd):
    """把 wechatauto 的 accessibility gate 字节写成 0→1，强制 Qt 重新评估。

    为什么要自己写、不用 `wechatauto.accessibility.wake()`：

    - `wake(verify=True)` 用「顶层窗口类名是否以 `mmui::` 开头」判断成功。
      微信 4.2 的主窗类名**本来就是** `mmui::MainWindow`，所以它每次都报成功，
      哪怕 `FindAll(Descendants)` 只有 1 个节点（本机实测踩过）。
    - 微信进程跑久了，gate 字节可能停在 1 但控件树是空的。这时再写 1 没用，
      必须先归零再置 1，Qt 才会重新走一遍无障碍初始化。

    成功与否由调用方数节点，不看返回值。
    """
    try:
        from wechatauto.accessibility import AccessibilityGate as G
    except Exception:
        return False

    access = 0x0400 | 0x0010 | 0x0020 | 0x0008   # QI | VM_READ | VM_WRITE | VM_OP
    kernel32 = ctypes.windll.kernel32
    handle = None
    try:
        pid = G._pid_from_hwnd(hwnd)
        if not pid:
            return False
        mod = G._weixin_dll_module(pid)
        if not mod:
            return False
        base, _size, dll = mod
        cands = G._qaccessible_candidate_rvas(dll)[:4]
        if not cands:
            return False
        handle = kernel32.OpenProcess(access, False, pid)
        if not handle:
            return False
        for rva in cands:
            addr = int(base) + int(rva)
            cur = G._read_process_byte(handle, addr)
            if cur is None:
                continue
            if cur == 1:
                G._write_process_byte(handle, addr, 0)
                time.sleep(0.15)
            G._write_process_byte(handle, addr, 1)
        return True
    except Exception:
        return False
    finally:
        try:
            if handle:
                kernel32.CloseHandle(handle)
        except Exception:
            pass


def _tree_ok(info, want_edit=False):
    if len(info["nodes"]) < MIN_NODES:
        return False
    if want_edit and info["edit"] is None:
        return False
    return True


def _ensure_tree(hwnd, log=None, unhide=True, want_edit=False):
    """保证控件树是物化的，返回一次 `read_ui()` 结果。

    顺序（每一步都不碰前台）：
      1. 窗口被隐藏（缩在托盘）→ `SW_SHOWNOACTIVATE` 显示出来；
      2. 开 `SPI_SETSCREENREADER`（Qt 靠它决定要不要暴露控件树）；
      3. 还不行就写 wechatauto 的 accessibility gate 字节（0→1 重新触发）。

    `want_edit=True` 时「树活着但输入框不在」也算不完整（微信停在通讯录/朋友圈
    时就是这样），会继续尝试物化；实在没有就返回现状，由调用方决定点会话还是放弃。
    """
    log = log or _noop

    if unhide:
        try:
            if (not user32.IsWindowVisible(hwnd)) or user32.IsIconic(hwnd):
                fg0 = user32.GetForegroundWindow()
                user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
                time.sleep(0.4)
                fg1 = user32.GetForegroundWindow()
                log("后台通道：窗口原来隐藏/最小化，已用「显示但不激活」拉出来（前台 %s → %s%s）"
                    % (fg0, fg1, "，没抢" if fg0 == fg1 else "，**被抢了**"))
        except Exception as e:
            log("后台通道：显示窗口失败 %r" % (e,))

    info = read_ui(hwnd)
    if _tree_ok(info, want_edit):
        return info
    if want_edit and info["edit"] is None and len(info["nodes"]) >= MIN_NODES:
        # 树是活的，只是没停在聊天页 —— 物化也变不出输入框，交给调用方点会话
        return info

    _ScreenReader.enable()
    time.sleep(1.2)                       # 文档 §4.1：实测 1~1.5 秒
    info = read_ui(hwnd)
    if _tree_ok(info, want_edit):
        log("后台通道：控件树已物化（SPI），%d 个节点" % len(info["nodes"]))
        return info

    if _gate_pulse(hwnd):
        # 写完之后 Qt 需要一点时间重建控件树；最多等 3 秒
        for _ in range(6):
            time.sleep(0.5)
            info = read_ui(hwnd)
            if _tree_ok(info, want_edit):
                log("后台通道：控件树已物化（gate 热激活），%d 个节点" % len(info["nodes"]))
                return info

    log("后台通道：控件树只有 %d 个节点，没物化" % len(info["nodes"]))
    return info


def tree_hint(nodes):
    """把「树没起来」翻译成一句能定位的话。"""
    if nodes >= MIN_NODES:
        return ""
    if nodes <= 1:
        return ("控件树只有 %d 个节点：微信没有把无障碍接口暴露出来。"
                "常见原因：①微信缩在托盘里（窗口隐藏）——先用 --bg-probe 看 visible；"
                "②微信 4.2.x 的 accessibility gate 与 wechatauto 的版本表对不上；"
                "③桥接没提权，读不动微信的控件树。" % nodes)
    return ("控件树只有 %d 个节点（物化了一半）：多半是 TreeWalker 断在中间，"
            "或微信刚启动还没长完，等 2 秒再试。" % nodes)


# ---------------------------------------------------------------- 发送端（文档 §5.1）
class WeChatSender:
    """只做三件事：点、写、收尾。全部不抢前台。"""

    def __init__(self, hwnd):
        self.hwnd = int(hwnd)

    @staticmethod
    def _lparam(x, y):
        return (y << 16) | (x & 0xFFFF)

    def _post(self, msg, wparam, lparam):
        if not user32.PostMessageW(self.hwnd, msg, wparam, lparam):
            err = ctypes.get_last_error()
            if err == ERROR_ACCESS_DENIED:
                raise UipiDenied("PostMessage 被拒绝：微信的完整性级别高于桥接")
            raise ctypes.WinError(err)
        return True

    def click_screen(self, sx, sy, settle=0.07):
        """在屏幕坐标处点击微信窗口。被遮挡也有效。（文档 §4.3 / §4.8 / §4.9）

        - 坐标必须转成**客户区**坐标（`ScreenToClient`）；
        - UIA 给的是物理像素；本进程不 DPI 感知时先换算成逻辑像素（§4.8）；
        - **必须先发 `WM_MOUSEMOVE`**：Qt 用 `WM_MOUSEMOVE` / `WM_MOUSELEAVE`
          维护 `m_mouseInside`，窗口被遮挡时系统不会送这两个消息，省略
          mousemove 时点击会被直接丢弃。
        """
        pt = wintypes.POINT(int(sx), int(sy))
        if not DPI_AWARE:
            # DPI 不感知：把物理坐标压回逻辑坐标，否则 150% 缩放下会点偏 1.5 倍
            try:
                user32.PhysicalToLogicalPointForPerMonitorDPI(
                    self.hwnd, ctypes.byref(pt))
            except Exception:
                pass
        if not user32.ScreenToClient(self.hwnd, ctypes.byref(pt)):
            raise ctypes.WinError(ctypes.get_last_error())
        lp = self._lparam(pt.x, pt.y)
        self._post(WM_MOUSEMOVE, 0, lp)
        self._post(WM_LBUTTONDOWN, 1, lp)          # wParam = MK_LBUTTON
        time.sleep(settle)
        self._post(WM_LBUTTONUP, 0, lp)

    def type_bytes(self, payload, char_gap=0.04):
        """把已经编码好的 GBK 字节逐个投递。（文档 §4.5 / §4.7）

        微信把 `WM_CHAR` 的 wParam 当 **GBK 字节流**、低字节优先解释。
        直接发 UTF-16 码点会乱码（`鲸` U+9CB8 → `笢`），所以调用方必须
        先 `encode("gbk")` 再逐字节发。
        """
        self._post(WM_SETFOCUS, 0, 0)              # 伪焦点（§4.5）
        time.sleep(0.10)
        for b in payload:
            self._post(WM_CHAR, b, 1)
            time.sleep(char_gap)
        return True

    def type_text(self, text, char_gap=0.04, strip_unencodable=True):
        """编码 + 打字。返回 `(ok, skipped_chars)`。"""
        payload, skipped = encode_gbk(text, strip_unencodable)
        if payload is None:
            return False, skipped
        self.type_bytes(payload, char_gap)
        return True, skipped

    def end_input(self):
        """收尾：清掉伪造的焦点状态，避免影响后续界面判断。（文档 §4.10）"""
        try:
            self._post(WM_KILLFOCUS, 0, 0)
        except Exception:
            pass


def encode_gbk(text, strip_unencodable=True):
    """逐字符编码成 GBK 字节流。

    返回 `(payload, skipped)`：
      - `payload` 是 `bytes`；`strip_unencodable=False` 且遇到编不了的字符时返回 `None`；
      - `skipped` 是被丢掉的字符列表（emoji / 生僻字 / 假名的一部分，文档 §8.1）。
    """
    buf = bytearray()
    skipped = []
    for ch in str(text or ""):
        try:
            buf += ch.encode("gbk")
        except UnicodeEncodeError:
            skipped.append(ch)
    if skipped and not strip_unencodable:
        return None, skipped
    return bytes(buf), skipped


# ---------------------------------------------------------------- 读取端（文档 §5.2）
def _uia():
    import uiautomation as auto
    return auto


def _descendants(control):
    """全部后代节点（等价于 FindAll）。

    文档 §4.1 注意事项第 2 条：用 `FindAll` 而不是 `TreeWalker`。逐层走的时候
    中间层没物化就断了，只能拿到 62~67 个节点；`FindAll(Descendants)` 能拿到 160+。
    """
    try:
        from uiautomation.uiautomation import _AutomationClient
        uia = _AutomationClient.instance().IUIAutomation
        arr = control.Element.FindAll(4, uia.CreateTrueCondition())   # 4=Descendants
        if arr is not None and arr.Length:
            auto = _uia()
            out = []
            for i in range(arr.Length):
                c = auto.Control.CreateControlFromElement(arr.GetElement(i))
                if c is not None:
                    out.append(c)
            return out
    except Exception:
        pass
    # 兜底：FindAll 用不了时递归 GetChildren（节点会少，但聊胜于无）
    out, level = [], [control]
    for _ in range(6):
        nxt = []
        for node in level:
            try:
                kids = node.GetChildren() or []
            except Exception:
                kids = []
            for k in kids:
                out.append(k)
                nxt.append(k)
        if not nxt:
            break
        level = nxt
    return out


def _aid_hit(aid, candidates):
    """AutomationId 容错匹配：旧版短名 / 新版点分路径都算命中。"""
    a = (aid or "").strip().lower()
    if not a:
        return False
    segs = a.split(".")
    for c in candidates:
        cl = (c or "").strip().lower()
        if cl and (a == cl or a.endswith("." + cl) or cl in segs):
            return True
    return False


def norm_chat_name(text):
    """会话行名 → 干净名字（切掉「最后一条消息摘要」「(12)」未读后缀、输入框提示语）。"""
    head = str(text or "").split("\n", 1)[0].strip()
    # 输入框的 Name 有时会带上鼠标悬停提示（实测：「文件传输助手长按鼠标 语音输入」），
    # 不切掉的话 open_chat 会以为「已经不在目标会话」，白点一下。
    for tail in ("长按鼠标", "语音输入", "按住说话", "按 Enter", "按回车"):
        if tail in head:
            head = head.split(tail, 1)[0].strip()
    m = re.match(r"^(.*?)\s*[（(]\s*\d+\s*[）)]\s*$", head)
    return m.group(1).strip() if (m and m.group(1).strip()) else head


def read_ui(hwnd):
    """读控件：输入框（含当前会话名）、发送按钮中心点、会话列表行。

    返回 dict：`{"ctrl", "nodes", "edit", "chat", "value", "send_xy", "rows"}`；
    树没物化时 `nodes` 为空、其余为 None / 空列表。
    """
    info = {"ctrl": None, "nodes": [], "edit": None, "chat": None,
            "value": None, "send_xy": None, "rows": []}
    if not hwnd:
        return info
    try:
        auto = _uia()
        info["ctrl"] = auto.ControlFromHandle(hwnd)
    except Exception:
        return info
    if info["ctrl"] is None:
        return info

    nodes = _descendants(info["ctrl"])
    info["nodes"] = nodes

    for c in nodes:
        try:
            if _aid_hit(getattr(c, "AutomationId", ""), (CHAT_INPUT_AID,)):
                info["edit"] = c
                break
        except Exception:
            continue

    if info["edit"] is not None:
        try:
            info["chat"] = norm_chat_name(info["edit"].Name)
        except Exception:
            pass
        try:                                  # 文档 §11 第 2 步：能读出 Value 说明树是对的
            info["value"] = info["edit"].GetValuePattern().Value or ""
        except Exception:
            info["value"] = None

    for c in nodes:                            # 文档 §5.2：发送按钮中心点（屏幕坐标）
        try:
            if (c.Name or "").strip() == SEND_BUTTON_NAME and "Button" in c.ControlTypeName:
                r = c.BoundingRectangle
                info["send_xy"] = (r.left + (r.right - r.left) // 2,
                                   r.top + (r.bottom - r.top) // 2)
                break
        except Exception:
            continue

    lst = None
    for c in nodes:
        try:
            if _aid_hit(getattr(c, "AutomationId", ""), SESSION_LIST_AIDS):
                lst = c
                break
        except Exception:
            continue
    if lst is not None:
        level = [lst]
        for _ in range(4):                     # 行常常隔一层容器，按层找带名字的节点
            nxt, named = [], []
            for node in level:
                try:
                    kids = node.GetChildren()
                except Exception:
                    kids = []
                for k in kids:
                    nxt.append(k)
                    nm = norm_chat_name(getattr(k, "Name", "") or "")
                    if nm:
                        named.append((nm, k))
            if named:
                info["rows"] = named[:40]
                break
            level = nxt
            if not level:
                break
    return info


# ---------------------------------------------------------------- 会话切换
def _tokens(text):
    for ch in ("，", ",", ";", "；", "/"):
        text = text.replace(ch, "、")
    return [t.strip() for t in text.split("、") if t.strip()]


def name_score(alias, name):
    """名字有多像：0 完全相同，1 成员名集合吻合，2 包含，None 不像。

    微信里没命名的群，会话列表显示的是成员名（「成员甲、成员乙『示例群』」），
    跟数据库里的群名对不上，所以多给一档「成员名集合」比较。
    """
    alias = str(alias or "").strip()
    name = str(name or "").strip()
    if not alias or not name:
        return None
    if alias == name:
        return 0
    ntok = _tokens(name)
    if len(ntok) >= 2:
        atok = _tokens(alias)
        if atok and all(t in atok for t in ntok):
            return 1
    if name.startswith(alias) or alias.startswith(name) or alias in name or name in alias:
        return 2
    return None


def open_chat(sender, aliases, timeout=6.0, log=None):
    """在会话列表里点开目标会话。返回是否已切过去。

    只点列表行、不碰搜索框：4.1.15+ 搜索入口是收起的，展开要额外点一次；
    而机器人回消息时，那个会话本来就在列表最上面。

    会话列表只有最近 9~12 个会话，更早的找不到 —— 这时返回 False，
    调用方退回前台通道（那边会自己搜索）。
    """
    log = log or _noop
    if isinstance(aliases, str):
        aliases = [aliases]
    aliases = [norm_chat_name(a) for a in (aliases or []) if str(a or "").strip()]
    if not aliases:
        return False

    info = read_ui(sender.hwnd)
    cur = info["chat"]
    if cur and any(name_score(a, cur) == 0 for a in aliases):
        return True
    if not info["rows"]:
        return False

    scored = []
    for nm, ctrl in info["rows"]:
        best = None
        for a in aliases:
            sc = name_score(a, nm)
            if sc is None:
                continue
            cand = (sc, abs(len(nm) - len(a)), nm, ctrl)
            if best is None or cand[:2] < best[:2]:
                best = cand
        if best is not None:
            scored.append(best)
    if not scored:
        return False
    scored.sort(key=lambda x: (x[0], x[1]))
    _sc, _d, nm, ctrl = scored[0]
    try:
        r = ctrl.BoundingRectangle
        if (r.right - r.left) < MIN_ROW_W:
            return False
        sender.click_screen((r.left + r.right) // 2, (r.top + r.bottom) // 2)
    except Exception as e:
        log("后台通道：点会话行失败 %r" % (e,))
        return False

    deadline = time.time() + max(1.0, float(timeout))
    rematerialized = False
    while time.time() < deadline:
        time.sleep(0.3)
        info = read_ui(sender.hwnd)
        cur = info["chat"]
        if cur and name_score(nm, cur) == 0:
            log("后台通道：已切到会话 %r" % (nm,))
            return True
        # 点完之后控件树可能被微信重建（实测会从 150 掉到 81、输入框暂时消失），
        # 这时再补一次物化，别急着判失败。
        if not rematerialized and len(info["nodes"]) < MIN_NODES:
            rematerialized = True
            _ensure_tree(sender.hwnd, log=log)
    log("后台通道：切会话超时（目标 %r，当前 %r）" % (nm, cur))
    return False


# ---------------------------------------------------------------- 组合：发一条
def send(text, chat=None, hwnd=0, log=None, char_gap=0.04,
         strip_unencodable=True, verify=True, unhide=True):
    """一步发完：物化 → 切会话 → 伪焦点打字 → 点发送 → 回读确认。

    返回 `(ok, reason)`。`reason` 是稳定枚举：

    | reason | ok | 含义 |
    | --- | --- | --- |
    | sent / sent_partial / sent_unverified | ✅ | 发出去了（partial=丢了 emoji 之类） |
    | no_window / minimized | ❌ | 微信没登录 / 最小化（最小化时不能物化，也不去还原） |
    | tree_not_ready / no_input_field | ❌ | 控件树没物化 / 当前不在聊天页 |
    | chat_not_found | ❌ | 会话不在列表里（退回前台通道搜索） |
    | no_send_button / input_not_empty | ❌ | 找不到按钮 / 输入框里还有草稿 |
    | gbk_unsupported | ❌ | 全部字符都编不了 |
    | uipi_denied | ❌ | 微信提权了，桥接没提权 |
    | residue_left | ❌ | 点了发送但输入框没清空 |
    | error:<Type> | ❌ | 其它异常 |
    """
    log = log or _noop
    text = "" if text is None else str(text)
    if not text.strip():
        return False, "empty"

    try:
        hwnd = int(hwnd or 0) or find_hwnd()
    except Exception:
        hwnd = 0
    if not hwnd:
        return False, "no_window"
    try:
        if user32.IsIconic(hwnd) and not unhide:
            # 文档 §8.5：最小化时不物化。unhide=True 时用「显示但不激活」拉出来，
            # 那样仍然不抢前台（实测），所以不必直接放弃。
            return False, "minimized"
    except Exception:
        pass

    sender = WeChatSender(hwnd)
    try:
        info = _ensure_tree(hwnd, log=log, unhide=unhide, want_edit=bool(chat))
        if len(info["nodes"]) < MIN_NODES:
            return False, "tree_not_ready"

        # 先切会话，再看输入框：微信可能停在朋友圈 / 通讯录，
        # 这时 edit 不存在，但会话列表行还在，点一下就能回到聊天页。
        if chat and not open_chat(sender, chat, log=log):
            return False, "chat_not_found"

        info = read_ui(hwnd)                   # 切过会话要重读（按钮位置会变）
        if info["edit"] is None:
            # 点完会话后微信会重建一次控件树（实测 150 → 81 再回来），补一次物化
            info = _ensure_tree(hwnd, log=log, unhide=False)
        if info["edit"] is None:
            return False, "no_input_field"
        if info["send_xy"] is None:
            return False, "no_send_button"
        if info["value"]:
            return False, "input_not_empty"

        ok, skipped = sender.type_text(text, char_gap=char_gap,
                                       strip_unencodable=strip_unencodable)
        if not ok:
            return False, "gbk_unsupported"
        if skipped:
            log("后台通道：GBK 编不了 %d 个字符，已跳过：%s"
                % (len(skipped), "".join(skipped)[:20]))

        time.sleep(0.35)                       # 等按钮变 enabled（文档 §9）
        info = read_ui(hwnd)                   # 再读一次：按钮此刻才 enabled
        xy = info["send_xy"]
        if xy is None:
            sender.end_input()
            return False, "no_send_button"
        sender.click_screen(*xy)
        time.sleep(0.40)
        sender.end_input()

        partial = "sent_partial" if skipped else "sent"
        if not verify:
            return True, partial

        # 发出去了没有：输入框清空 = 走了。读不到（None）按「已发送」处理，
        # 免得退回前台通道再打一遍、聊天里出现两句一样的话。
        deadline = time.time() + 2.0
        while time.time() < deadline:
            v = read_ui(hwnd)["value"]
            if v == "":
                return True, partial
            if v is None:
                log("后台通道：回读不到输入框状态，按已发送处理（避免重复）")
                return True, "sent_unverified"
            time.sleep(0.2)
        return False, "residue_left"

    except UipiDenied as e:
        log("后台通道：%s" % (e,))
        return False, "uipi_denied"
    except Exception as e:                     # noqa: BLE001
        log("后台通道异常：%r" % (e,))
        return False, "error:" + type(e).__name__


# ---------------------------------------------------------------- 自检（文档 §11）
def probe(hwnd=0, log=print, with_send=None, unhide=True):
    """最小可用清单：物化 → 读 → 报数。默认不发消息。

    `with_send` 传字符串时顺便发一条（用于验证写通道），返回结果里带 `sent`。
    """
    log = log or _noop
    result = {"hwnd": 0, "iconic": False, "visible": False, "nodes": 0, "edit": False,
              "chat": None, "value": None, "send_xy": None, "rows": [],
              "fg_before": 0, "fg_after": 0, "stolen": False,
              "screen_reader": False, "sent": None}

    result["fg_before"] = int(user32.GetForegroundWindow() or 0)
    try:
        hwnd = int(hwnd or 0) or find_hwnd()
    except Exception:
        hwnd = 0
    result["hwnd"] = hwnd
    if not hwnd:
        log("没找到微信主窗口：确认微信已登录")
        return result
    result["iconic"] = bool(user32.IsIconic(hwnd))
    result["visible"] = bool(user32.IsWindowVisible(hwnd))
    log("主窗 hwnd = %s | 最小化 = %s | 可见 = %s"
        % (hwnd, result["iconic"], result["visible"]))

    try:
        info = _ensure_tree(hwnd, log=log, unhide=unhide)
        result["screen_reader"] = _ScreenReader.enabled()
        result["nodes"] = len(info["nodes"])
        result["edit"] = info["edit"] is not None
        result["chat"] = info["chat"]
        result["value"] = info["value"]
        result["send_xy"] = info["send_xy"]
        result["rows"] = [n for n, _c in info["rows"]][:8]

        log("① 物化：节点数 = %d（160+ 说明成功；2 说明没物化）" % result["nodes"])
        log("② 读：输入框 = %s | 当前会话 = %r | 输入框内容 = %r"
            % (result["edit"], result["chat"], result["value"]))
        log("   发送按钮中心 = %s" % (result["send_xy"],))
        log("   会话列表 = %s" % (result["rows"],))
        hint = tree_hint(result["nodes"])
        if hint:
            log("   ！" + hint)

        if with_send:
            ok, why = send(with_send, chat=None, hwnd=hwnd, log=log)
            result["sent"] = {"ok": ok, "reason": why}
            log("③ 写：发送 = %s（%s）" % (ok, why))
    finally:
        result["fg_after"] = int(user32.GetForegroundWindow() or 0)
        result["stolen"] = result["fg_before"] != result["fg_after"]
        log("前台 = %s → %s | 被抢 = %s | 现在可见 = %s"
            % (result["fg_before"], result["fg_after"], result["stolen"],
               bool(user32.IsWindowVisible(result["hwnd"]) if result["hwnd"] else 0)))
    return result


def shutdown():
    """进程退出时还原 `SPI_SETSCREENREADER`。"""
    _ScreenReader.restore()


import atexit  # noqa: E402  （放在文件尾部，避免污染上面的常量区）

atexit.register(shutdown)
