# -*- coding: utf-8 -*-
"""热激活微信的控件树（Qt accessibility gate）——从 `uia_driver` 里拎出来的独立模块。

微信 4.x 是 Qt 画的界面：`QAccessible` 在响应 `WM_GETOBJECT` 之前会先看一个运行
时的 active byte。冷启动、没启用系统读屏标志时它是 0，整棵 `mmui` 子树**根本不会
物化**，UIA 那边只能看到 Qt 外壳——表现是「昨天能用今天不能」「控件树被屏蔽」。
把这个 byte 热写成 1，当前进程立刻开始返回 `mmui` provider，**不用重启微信**。

所以本模块干三件事：

1. 设系统「屏幕阅读器」标志（`SPI_SETSCREENREADER`）——只在字节那条路走不通时才设，
   给「扫不到 active byte、只能靠微信自己启动时建桥」的版本留后路。2026-10-10 真机
   六臂对照（`读屏标志` × `gate 字节`，每个臂都换新进程查一次）：**树只跟 gate 字节走**
   （byte=1 ⇒ 根节点 `mmui::MainWindow`，byte=0 ⇒ 掉回 `Qt51514QWindowIcon`，一秒内
   跟着翻），标志开不开都不影响。所以它不在常规路径上——那是全系统级的开关，
   会连带让别的程序也去建无障碍树。
2. 在 `Weixin.dll` 里**扫出**那个 byte 的 RVA：按字节码模式找引用
   `qt.accessibility.core` 的 `cmp byte ptr [...], 0`，再用 PE 段表把
   文件偏移换算回 RVA，并拿 RIP 相对寻址反查引用点；扫不出来才退回版本表；
3. 往运行中的微信进程 `WriteProcessMemory` 写 1，写完**自己回读校验**
   （`_mmui_present`：树里到底出现 `mmui::` 节点没有），失败就还原字节再试下一个
   候选。校验是真判据，不看「写完没报错」。

安全性：只在微信自己进程里改 1 个字节的运行时标志位，不注入代码、不设钩子、
不挂 DLL；写完即恢复原字节（只有校验通过的那个才留 1）。
成本：`Weixin.dll` 198MB，扫一次实测 ~8 秒，慢机上像卡死。所以 RVA 按
「Weixin.dll 身份 = 版本目录 + 文件大小 + mtime」缓存到
`~/.wechatauto/gate_cache.json`，命中就零扫描；换版本会自动失效重扫。

`uia_driver.WeChatUIA` 只留同名转发（`_wake_accessibility` 的编排在它那边不变，
它要用 `self._wechat_hwnds()` 挑窗口），所以老调用方、离线自检、各 demo 都不用改。
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import struct
import time
from functools import lru_cache
from ctypes import wintypes
from typing import Dict, List, Optional, Tuple

import numpy as np

import uiautomation as auto

from wechatauto.logger import wxlog

# 有 pywin32 就用它拿 pid（走 win32process），没有就退回纯 ctypes。
# 这份探测必须**在本模块里**做：搬过来之后还去引用 uia_driver 的 _HAS_WIN32，
# 就是一个 NameError，而它被调用方整片 try/except 吞掉，表现成「控件树拿不到」。
try:
    import win32process
    _HAS_WIN32 = True
except Exception:                                   # pragma: no cover
    win32process = None
    _HAS_WIN32 = False

# 「扫不到可用窗口」这类失败每种原因一个进程只警告一次（长驻进程每轮都扫）
_GATE_BLOCK_WARNED = set()


# ---------------------------------------------------------------------------
# 无障碍“屏幕阅读器”系统标志 / Qt accessibility gate
# ---------------------------------------------------------------------------
SPI_GETSCREENREADER = 0x1046
SPI_SETSCREENREADER = 0x1047
SPIF_SENDCHANGE = 0x02

# 微信内置 Qt accessibility gate：QAccessible 查询前会检查一个运行时 active
# byte。冷启动未启用读屏时该 byte 为 0，WM_GETOBJECT 只能拿到 Qt 外壳；
# 热写为 1 后当前进程立即返回 mmui provider，无需重启微信。优先从 Weixin.dll
# 自动扫描该 byte 的 RVA，下面的版本表仅作扫描失败时的兜底。
QACCESSIBLE_ACTIVE_RVA_BY_VERSION = {
    "4.1.11.22": 0x0A1E7DB8,
    "4.1.13.65": 0x0AE2B0C8,   # 2026-09-12 实测：热写后 mmui 树立即物化
    "4.1.15.13": 0x0B135C38,   # 2026-09-23 实测：扫描得出，热写后校验通过
    "4.1.15.53": 0x0B3959D8,   # 2026-10-17 实测：扫描得出，热写后校验通过
}
QACCESSIBLE_CORE_STRING = b"qt.accessibility.core"
QACCESSIBLE_GATE_PATTERN = re.compile(
    rb"\x48\x85\xc9\x0f\x84....\x80\x3d(?P<disp>.{4})"
    rb"\x00\x0f\x84",
    re.DOTALL,
)

# 已验证的 gate RVA：按 Weixin.dll 身份（版本目录+大小+mtime）缓存。
# 好处：换版本后优先使用上次真正生效过的地址；命中时无需重扫 198MB DLL。
# 这份表同时落盘（见下），否则每个新进程都要重付扫描成本。
_VERIFIED_GATE_RVA: Dict[str, int] = {}


def _dll_identity(dll_path: str) -> str:
    """Weixin.dll 身份串：版本目录 + 文件大小 + mtime（升级/热更新可区分）。"""
    try:
        st = os.stat(dll_path)
        ver = os.path.basename(os.path.dirname(dll_path))
        return "%s|%d|%d" % (ver, st.st_size, int(st.st_mtime))
    except OSError:
        return dll_path


# gate 扫描结果按 DLL 身份落盘。必须落盘而不是只留 lru_cache：本库的典型用法
# 是一个脚本一个新 Python 进程，进程内缓存在这种用法下等于没有——每次启动都
# 重扫一遍 198MB 的 Weixin.dll（实测 8 秒，慢机上更像卡死）。
GATE_CACHE_FILE = os.path.join(os.path.expanduser('~'), '.wechatauto',
                               'gate_cache.json')
_GATE_CACHE: Optional[Dict[str, dict]] = None


def _gate_cache() -> Dict[str, dict]:
    """读落盘的 gate 缓存（损坏/不存在都按空表处理，不抛）。"""
    global _GATE_CACHE
    if _GATE_CACHE is None:
        data: Dict[str, dict] = {}
        try:
            with open(GATE_CACHE_FILE, encoding='utf-8') as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                data = {k: v for k, v in raw.items() if isinstance(v, dict)}
        except (OSError, ValueError):
            pass
        _GATE_CACHE = data
    return _GATE_CACHE


def _gate_cache_put(identity: str, **fields) -> None:
    """合并写回一条 gate 缓存。写失败只留 debug：缓存丢了不过是重扫一次。"""
    entry = _gate_cache().setdefault(identity, {})
    entry.update(fields)
    try:
        os.makedirs(os.path.dirname(GATE_CACHE_FILE), exist_ok=True)
        tmp = GATE_CACHE_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(_gate_cache(), f, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, GATE_CACHE_FILE)
    except OSError as e:
        wxlog.debug(f'gate 缓存写盘失败（不影响功能）：{e}')


IMAGE_SCN_MEM_EXECUTE = 0x20000000
IMAGE_SCN_MEM_WRITE = 0x80000000
PROCESS_VM_OPERATION = 0x0008
PROCESS_VM_READ = 0x0010
PROCESS_VM_WRITE = 0x0020
PROCESS_QUERY_INFORMATION = 0x0400
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_MODULE_NAME32 = 255
MAX_PATH = 260


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("th32ModuleID", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("GlblcntUsage", ctypes.c_ulong),
        ("ProccntUsage", ctypes.c_ulong),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_ubyte)),
        ("modBaseSize", ctypes.c_ulong),
        ("hModule", ctypes.c_void_p),
        ("szModule", ctypes.c_wchar * (MAX_MODULE_NAME32 + 1)),
        ("szExePath", ctypes.c_wchar * MAX_PATH),
    ]




def _spi_screen_reader(enable=None, spi=None) -> bool:
    """读写系统「正在使用读屏软件」标志；``enable=None`` 时只读。

    值必须放在第三个参数（pvParam），第二个参数（uiParam）传 0。摆成
    ``(SET, 1, 0)`` 时 API 直接返回 FALSE + err=87 而标志一动不动——真机实测：
    标志没开时把 gate 字节写成 1 也不会建出 mmui 树，所以这一步不是可选的。
    """
    spi = spi or ctypes.windll.user32.SystemParametersInfoW
    if enable is None:
        v = wintypes.BOOL()
        spi(SPI_GETSCREENREADER, 0, ctypes.byref(v), 0)
        return bool(v.value)
    spi(SPI_SETSCREENREADER, 0, ctypes.c_void_p(1 if enable else 0), SPIF_SENDCHANGE)
    return _spi_screen_reader(spi=spi) == bool(enable)


class AccessibilityGate:
    """一个无状态的门面：所有方法都是 static/classmethod，可以直接类名调用。"""

    # ------------------------------------------------------------------ 热激活
    @staticmethod
    def _set_screen_reader_flag(enable: bool) -> bool:
        """开/关读屏标志，返回**读回**的实际状态（没开上就警告，别静默）。"""
        try:
            ok = _spi_screen_reader(enable)
        except Exception as e:
            wxlog.warning("系统读屏标志操作异常：%s", e)
            return False
        if enable and not ok:
            wxlog.warning("系统读屏标志没能设上（可能被组策略锁定），"
                          "微信的 mmui 控件树这次不会物化。")
        return ok

    @staticmethod
    def _pid_from_hwnd(hwnd: int) -> Optional[int]:
        if _HAS_WIN32:
            try:
                return win32process.GetWindowThreadProcessId(hwnd)[1]
            except Exception:
                return None
        pid = wintypes.DWORD()
        try:
            ctypes.windll.user32.GetWindowThreadProcessId(
                wintypes.HWND(hwnd), ctypes.byref(pid))
            return int(pid.value) or None
        except Exception:
            return None

    @staticmethod
    def _process_modules(pid: int):
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Module32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
        kernel32.Module32FirstW.restype = wintypes.BOOL
        kernel32.Module32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
        kernel32.Module32NextW.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        snapshot = kernel32.CreateToolhelp32Snapshot(
            TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if snapshot == INVALID_HANDLE_VALUE:
            return
        try:
            entry = MODULEENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            if not kernel32.Module32FirstW(snapshot, ctypes.byref(entry)):
                return
            while True:
                base = ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value or 0
                yield base, int(entry.modBaseSize), entry.szModule, entry.szExePath
                if not kernel32.Module32NextW(snapshot, ctypes.byref(entry)):
                    break
        finally:
            kernel32.CloseHandle(snapshot)

    @classmethod
    def _weixin_dll_module(cls, pid: int):
        for base, size, name, path in cls._process_modules(pid) or ():
            if name.lower() == "weixin.dll":
                return base, size, path
        return None

    @staticmethod
    def _pe_sections(data: bytes):
        try:
            pe_off = struct.unpack_from("<I", data, 0x3C)[0]
            if data[pe_off:pe_off + 4] != b"PE\0\0":
                return []
            coff = pe_off + 4
            count = struct.unpack_from("<H", data, coff + 2)[0]
            opt_size = struct.unpack_from("<H", data, coff + 16)[0]
            sec_off = coff + 20 + opt_size
            sections = []
            for i in range(count):
                off = sec_off + i * 40
                name = data[off:off + 8].split(b"\0", 1)[0].decode("ascii", "ignore")
                virtual_size, virtual_address, raw_size, raw_ptr = struct.unpack_from(
                    "<IIII", data, off + 8)
                characteristics = struct.unpack_from("<I", data, off + 36)[0]
                sections.append({
                    "name": name,
                    "rva": virtual_address,
                    "vsize": virtual_size,
                    "raw_size": raw_size,
                    "raw_ptr": raw_ptr,
                    "chars": characteristics,
                })
            return sections
        except Exception:
            return []

    @staticmethod
    def _section_for_rva(sections, rva: int):
        for sec in sections:
            size = max(sec["vsize"], sec["raw_size"])
            if sec["rva"] <= rva < sec["rva"] + size:
                return sec
        return None

    @staticmethod
    def _offset_to_rva(sections, offset: int) -> Optional[int]:
        for sec in sections:
            if sec["raw_ptr"] <= offset < sec["raw_ptr"] + sec["raw_size"]:
                return sec["rva"] + offset - sec["raw_ptr"]
        return None

    @staticmethod
    def _rip_xrefs_to_rva(data: bytes, sections, target_rva: int) -> List[int]:
        """可执行段里以 RIP 相对寻址引用 ``target_rva`` 的 LEA 指令 RVA。

        匹配的是 ``[REX] 8D <modrm>``，modrm 满足 ``(b & 0xC7) == 0x05``
        （mod=00、r/m=101 → RIP 相对），disp32 紧跟其后。

        用 numpy 向量化而不是逐字节 Python 循环：Weixin.dll 有 198MB，老实现
        扫一次 8 秒，在用户端看起来就是卡死（真有人在这一步按了停止）。两种
        形态的判定式化简后是同一个 ``file_off + disp == 常数``，因为带 REX 时
        指令起点前移一字节、长度却多一字节。
        """
        try:
            import numpy as np
        except ImportError:
            # numpy 随 opencv-python 一起来，正常装包不会走到这里；真缺了也
            # 只是退回慢二十多倍的老实现，不能让 UIA 整条路因此消失。
            return AccessibilityGate._rip_xrefs_to_rva_ref(data, sections, target_rva)

        a = np.frombuffer(data, dtype=np.uint8)
        n = a.size
        if n < 16:
            return []
        # 全局边界 p8d <= n-7：无 REX 形态最晚只能到 end-8，带 REX 的起点是
        # p8d-1，最晚到 end-8 时 p8d == end-7；disp32 落在 p8d+2..p8d+5。
        p8d = np.flatnonzero(a == 0x8D)
        p8d = p8d[(p8d >= 1) & (p8d <= n - 7)]
        if p8d.size == 0:
            return []
        modrm = np.zeros(256, dtype=bool)
        modrm[[0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D]] = True
        p8d = p8d[modrm[a[p8d + 1]]]
        if p8d.size == 0:
            return []
        rex = (a[p8d - 1] >= 0x40) & (a[p8d - 1] <= 0x4F)
        b = a[p8d[:, None] + np.arange(2, 6)].astype(np.int64)
        disp = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16) | (b[:, 3] << 24)
        disp -= (disp >= 0x80000000) << 32          # 无符号 32 位 → 有符号
        total = p8d + disp

        xrefs: List[int] = []
        for sec in sections:
            if not (sec["chars"] & IMAGE_SCN_MEM_EXECUTE):
                continue
            start = sec["raw_ptr"]
            end = min(n, start + sec["raw_size"])
            if end - start < 8:
                continue
            k = target_rva - sec["rva"] + start - 6
            hit = total == k
            plain = hit & (p8d >= start) & (p8d <= end - 8)
            xrefs += (sec["rva"] + p8d[plain] - start).tolist()
            with_rex = hit & rex & (p8d >= start + 1) & (p8d <= end - 7)
            xrefs += (sec["rva"] + p8d[with_rex] - start - 1).tolist()
        return xrefs

    @staticmethod
    def _rip_xrefs_to_rva_ref(data: bytes, sections, target_rva: int) -> List[int]:
        """逐字节的慢实现（与 1.2.2.6 及更早版本同逻辑）：既是缺 numpy 时的
        回退路径，也是自检里给向量化版对拍的参照。"""
        xrefs: List[int] = []
        for sec in sections:
            if not (sec["chars"] & IMAGE_SCN_MEM_EXECUTE):
                continue
            start = sec["raw_ptr"]
            end = min(len(data), start + sec["raw_size"])
            raw = data[start:end]
            for i in range(0, max(0, len(raw) - 7)):
                if 0x40 <= raw[i] <= 0x4F and raw[i + 1] == 0x8D and (raw[i + 2] & 0xC7) == 0x05:
                    disp = struct.unpack_from("<i", raw, i + 3)[0]
                    insn_rva = sec["rva"] + i
                    if insn_rva + 7 + disp == target_rva:
                        xrefs.append(insn_rva)
                if raw[i] == 0x8D and (raw[i + 1] & 0xC7) == 0x05:
                    disp = struct.unpack_from("<i", raw, i + 2)[0]
                    insn_rva = sec["rva"] + i
                    if insn_rva + 6 + disp == target_rva:
                        xrefs.append(insn_rva)
        return xrefs

    @staticmethod
    @lru_cache(maxsize=8)
    def _scan_qaccessible_candidates(dll_path: str) -> Tuple[int, ...]:
        """按可信度返回全部 gate RVA 候选（越靠前越可能是真 gate）。

        单一候选在版本升级后会漂移，因此返回候选序列：调用方逐个热写并用
        「mmui 树是否真的物化」判定，成功者记入 _VERIFIED_GATE_RVA。

        结果按 DLL 身份落盘（含「扫过了，没有候选」这个负结果——不支持的版本
        每次都重扫最浪费）。读不到文件/不是 PE 都返回空序列而不是 None：调用
        方是直接迭代的。
        """
        identity = _dll_identity(dll_path)
        cached = _gate_cache().get(identity, {}).get("candidates")
        if isinstance(cached, list):
            return tuple(int(c) for c in cached)

        try:
            with open(dll_path, "rb") as f:
                data = f.read()
        except OSError:
            return ()

        sections = AccessibilityGate._pe_sections(data)
        if not sections:
            return ()

        core_off = data.find(QACCESSIBLE_CORE_STRING)
        core_rva = AccessibilityGate._offset_to_rva(sections, core_off) if core_off >= 0 else None
        core_xrefs = (AccessibilityGate._rip_xrefs_to_rva(data, sections, core_rva)
                      if core_rva is not None else [])

        candidates: List[Tuple[int, int]] = []
        for match in QACCESSIBLE_GATE_PATTERN.finditer(data):
            match_rva = AccessibilityGate._offset_to_rva(sections, match.start())
            disp_rva = AccessibilityGate._offset_to_rva(sections, match.start("disp"))
            if match_rva is None or disp_rva is None:
                continue
            match_sec = AccessibilityGate._section_for_rva(sections, match_rva)
            if not match_sec or not (match_sec["chars"] & IMAGE_SCN_MEM_EXECUTE):
                continue

            cmp_rva = disp_rva - 2              # 80 3d <disp32> 00
            disp = struct.unpack("<i", match.group("disp"))[0]
            target_rva = cmp_rva + 7 + disp
            target_sec = AccessibilityGate._section_for_rva(sections, target_rva)
            if not target_sec or not (target_sec["chars"] & IMAGE_SCN_MEM_WRITE):
                continue

            if core_xrefs:
                distance = min(abs(match_rva - xref) for xref in core_xrefs)
            else:
                distance = 0x7FFFFFFF
            candidates.append((distance, target_rva))

        if not candidates:
            _gate_cache_put(identity, candidates=[])
            return ()
        candidates.sort(key=lambda item: item[0])
        # 优先取与 qt.accessibility.core 同一代码岛（≤0x20000）的候选；
        # 一个都没有时退化为全部候选，交给热写校验兜底
        near = [rva for dist, rva in candidates if dist <= 0x20000]
        ordered = near or [rva for _dist, rva in candidates]
        result = tuple(dict.fromkeys(ordered))
        _gate_cache_put(identity, candidates=list(result))
        return result

    @staticmethod
    def _scan_qaccessible_active_rva(dll_path: str) -> Optional[int]:
        """兼容旧接口：返回最优候选（不含校验）。"""
        cands = AccessibilityGate._scan_qaccessible_candidates(dll_path)
        return cands[0] if cands else None

    @staticmethod
    def _qaccessible_candidate_rvas(dll_path: str) -> List[int]:
        """gate RVA 候选序列：已验证缓存 > 特征扫描 > 版本兜底表。"""
        out: List[int] = []
        identity = _dll_identity(dll_path)
        verified = _VERIFIED_GATE_RVA.get(identity)
        if verified is None:
            disk = _gate_cache().get(identity, {}).get("verified")
            if isinstance(disk, int):
                _VERIFIED_GATE_RVA[identity] = verified = disk
        if verified is not None:
            out.append(int(verified))
        for rva in AccessibilityGate._scan_qaccessible_candidates(dll_path):
            if int(rva) not in out:
                out.append(int(rva))
        version = os.path.basename(os.path.dirname(dll_path))
        fallback = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(version)
        if fallback is not None and int(fallback) not in out:
            out.append(int(fallback))
        return out

    @staticmethod
    def _qaccessible_active_rva(dll_path: str) -> Optional[int]:
        cands = AccessibilityGate._qaccessible_candidate_rvas(dll_path)
        return cands[0] if cands else None

    @staticmethod
    def _read_process_byte(handle, address: int) -> Optional[int]:
        ctypes.windll.kernel32.ReadProcessMemory.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        ctypes.windll.kernel32.ReadProcessMemory.restype = wintypes.BOOL
        buf = (ctypes.c_ubyte * 1)()
        read = ctypes.c_size_t(0)
        ok = ctypes.windll.kernel32.ReadProcessMemory(
            handle, ctypes.c_void_p(address), buf, 1, ctypes.byref(read))
        return int(buf[0]) if ok and read.value == 1 else None

    @staticmethod
    def _write_process_byte(handle, address: int, value: int) -> bool:
        ctypes.windll.kernel32.WriteProcessMemory.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        ctypes.windll.kernel32.WriteProcessMemory.restype = wintypes.BOOL
        buf = (ctypes.c_ubyte * 1)(value & 0xFF)
        written = ctypes.c_size_t(0)
        ok = ctypes.windll.kernel32.WriteProcessMemory(
            handle, ctypes.c_void_p(address), buf, 1, ctypes.byref(written))
        return bool(ok and written.value == 1)

    @staticmethod
    def _mmui_present(hwnd: int, timeout: float = 1.0) -> bool:
        """校验窗口是否已物化出 mmui 控件（仍是 Qt 空壳时为 False）。"""
        deadline = time.time() + max(0.1, timeout)
        while True:
            try:
                c = auto.ControlFromHandle(hwnd)
            except Exception:
                c = None
            if c is not None:
                if (c.ClassName or "").startswith("mmui::"):
                    return True
                try:
                    kids = c.GetChildren()
                except Exception:
                    kids = []
                for k in kids:
                    if (k.ClassName or "").startswith("mmui::"):
                        return True
            if time.time() >= deadline:
                return False
            time.sleep(0.2)

    @classmethod
    def _hot_activate_accessibility(cls, hwnd: int, verify: bool = True,
                                    max_candidates: int = 4) -> bool:
        """运行中热激活 Qt accessibility gate，不重启微信进程。

        verify=True（默认）时对每个候选 RVA 写入后用「mmui 控件是否真的出现」
        校验：版本升级后 gate RVA 会漂移，校验失败即回滚该字节并尝试下一个
        候选；成功则按 DLL 身份记入 _VERIFIED_GATE_RVA（下次优先使用）。
        """
        pid = cls._pid_from_hwnd(hwnd)
        if not pid:
            return False
        mod = cls._weixin_dll_module(pid)
        if not mod:
            wxlog.warning("热激活 UIA 失败：PID %s 未找到 Weixin.dll。", pid)
            return False
        base, _size, dll_path = mod
        candidates = cls._qaccessible_candidate_rvas(dll_path)[:max_candidates]
        if not candidates:
            wxlog.warning("热激活 UIA 失败：不支持的 Weixin.dll 版本路径 %s。", dll_path)
            return False

        access = (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ |
                  PROCESS_VM_WRITE | PROCESS_VM_OPERATION)
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(access, False, pid)
        if not handle:
            wxlog.warning("热激活 UIA 失败：无法打开 Weixin.exe PID %s。", pid)
            return False
        try:
            for rva in candidates:
                address = int(base) + int(rva)
                current = cls._read_process_byte(handle, address)
                if current is None:
                    continue
                wrote = False
                original = current
                if current != 1:
                    if not cls._write_process_byte(handle, address, 1):
                        continue
                    wrote = True
                    wxlog.info("热激活 UIA：PID=%s Weixin.dll+0x%x: %s -> 1",
                               pid, rva, current)
                if not verify:
                    return True
                if cls._mmui_present(hwnd):
                    identity = _dll_identity(dll_path)
                    _VERIFIED_GATE_RVA[identity] = int(rva)
                    _gate_cache_put(identity, verified=int(rva))
                    wxlog.info("UIA 树已物化，已记录 gate RVA：Weixin.dll+0x%x", rva)
                    return True
                # 候选不对：恢复原值，继续试下一个
                if wrote:
                    cls._write_process_byte(handle, address, original)
            wxlog.warning("热激活 UIA 失败：%d 个候选均未使 mmui 树物化（%s）。",
                          len(candidates), os.path.basename(dll_path))
            return False
        finally:
            kernel32.CloseHandle(handle)

    @staticmethod
    def gate_block_hint(diag: dict, bits: Optional[int] = None) -> str:
        """把「扫不到可用窗口」翻译成一句能定位的话（纯函数，便于离线自检）。"""
        if bits is None:
            bits = ctypes.sizeof(ctypes.c_void_p) * 8
        matched = (diag or {}).get('matched', 0)
        kept = (diag or {}).get('kept', 0)
        if (diag or {}).get('win32', True) is False:
            return ("pywin32 不可用，UIA 驱动整条路都用不了（安装：pip install pywin32）")
        if matched == 0:
            return ("没扫到可见的微信主窗口：微信未启动/未登录/最小化到托盘，"
                    "或窗口标题不再包含「微信/Weixin」。UIA 这条路不会自己出现控件树。")
        if kept == 0:
            return ("扫到 %d 个微信窗口，但每个都定位不到 Weixin.dll 模块，热激活无从下手。"
                    "当前解释器是 %d 位。%s"
                    % (matched, bits,
                       ("32 位 Python 无法枚举 64 位进程的模块（ERROR_PARTIAL_COPY），"
                        "请改用 64 位 Python。" if bits == 32 else
                        "64 位下还拿不到模块，通常是权限/完整性级别不一致"
                        "（别用「以管理员身份运行」，让脚本与微信同级）"
                        "或安全软件拦了模块枚举/进程读取——把 python 加入白名单再试。")))
        return ""

    @classmethod
    def _warn_gate_blocked(cls, diag: dict) -> None:
        """同一种原因一个进程只说一次：长驻进程每次轮询都扫，刷屏比不说更糟。"""
        hint = cls.gate_block_hint(diag)
        if not hint:
            return
        key = hint.split('。')[0][:40]
        if key in _GATE_BLOCK_WARNED:
            return
        _GATE_BLOCK_WARNED.add(key)
        wxlog.warning("控件树拿不到（本轮不会热激活 gate）：%s", hint)


def wake(hwnds, set_flag: bool = True, verify: bool = True,
         max_candidates: int = 4) -> bool:
    """对给定的微信窗口逐个热写 gate，只要有一个让 `mmui` 树物化就算成。

    编排留在调用方（`WeChatUIA._wake_accessibility`）：它还得挑窗口、并在成功后
    丢掉旧根控件句柄。这里兜住异常——PE 扫描/热写任何一步炸了，都只该让「UIA 这
    条路这次不可用」，调用方自己回落 OCR/坐标；不兜的话一个扫描异常会一路冒出
    `ensure_window`，把 `quick_send` 整个打断（用户实测崩在 198MB DLL 的扫描循环里）。
    """
    ok = False
    for hwnd in hwnds or []:
        try:
            ok = AccessibilityGate._hot_activate_accessibility(
                hwnd, verify=verify, max_candidates=max_candidates) or ok
        except Exception as e:
            wxlog.warning("热激活 UIA 异常，本轮跳过（改用 OCR/坐标定位）：%s", e)
    if not ok and set_flag:
        AccessibilityGate._set_screen_reader_flag(True)
    return ok


def gate_block_hint(diag: dict, bits: Optional[int] = None) -> str:
    return AccessibilityGate.gate_block_hint(diag, bits)


def warn_gate_blocked(diag: dict) -> None:
    AccessibilityGate._warn_gate_blocked(diag)
