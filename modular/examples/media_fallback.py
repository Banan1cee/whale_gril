# -*- coding: utf-8 -*-
"""微信改过「文件保存位置」后图片识别找不到图 —— 只读兜底补丁。

现象（用户反馈）
    把微信「设置 → 文件管理 → 微信文件默认保存位置」从默认改成别的盘之后，
    聊天照常收发，但**图片怎么都认不出来**；改回默认位置又好了。
    也就是「图片识别只认默认微信文件地址，改了就不行」。

根因
    图片缓存的路径写死在「当前账号目录」下：
        <db_dir>/<account>/msg/attach/<会话md5>/<年-月>/Img/<图片md5>.dat
    微信改保存位置时，数据库会搬到新目录（账号目录名还会换一个新的哈希后缀），
    但 msg/attach 里的图片缓存并不一定跟着搬（几万个文件，微信常常只改新写入的位置）。
    于是：db_storage 在新目录 → 消息正常；msg/attach 还在旧目录 → 图片永远找不到。

做法
    给 MediaDownloader 打一层兜底：当前账号目录找不到时，再按**会话 md5 + 图片 md5**
    去别的地方找同名文件：
      1. 当前数据根下的其它账号目录（改地址后换哈希后缀留下的旧目录）；
      2. 其它盘的 xwechat_files / WeChat Files / xwechat_files_data。
    找到照常解密 —— 图片密钥与账号绑定，同一账号换目录不影响解密。
    另外把「密钥反推」用的探针/模板也接上同样的兜底：新目录里一张图都没有时，
    连 AES 密钥校验都过不去（_probe_ct 拿不到样本），那才是更隐蔽的一层。

安全
    只读：不移动、不删除、不写任何微信目录。解密结果仍然写 data/media-cache（原行为）。
"""

from __future__ import annotations

import glob
import os
import time

DEFAULT_ROOT_NAMES = ("xwechat_files", "WeChat Files", "xwechat_files_data")
DEFAULT_DRIVES = "CDEFGHIJK"
CACHE_TTL = 300.0  # 候选目录 5 分钟重扫一次，够用且不拖慢发送


def _norm(path):
    try:
        return os.path.normcase(os.path.abspath(path))
    except (TypeError, ValueError):
        return ""


def data_roots(db, root_names=DEFAULT_ROOT_NAMES, drives=DEFAULT_DRIVES,
               extra_data_roots=None):
    """列出所有可能装着账号目录的「数据根」（本身含 <账号>/db_storage 的那一层）。"""
    roots = []
    seen = set()

    def add(p):
        if not p or not os.path.isdir(p):
            return
        key = _norm(p)
        if not key or key in seen:
            return
        seen.add(key)
        roots.append(p)

    # 当前数据根永远排第一（正常情况下就用它）
    add(getattr(db, "db_dir", ""))
    for p in (extra_data_roots or []):
        add(p)
    # 各盘根目录下的微信数据根：改保存位置后旧数据可能整个留在别的盘
    # 盘符不再写死 C..K：先按字母扫真实存在的盘，再补 psutil 里的挂载点（网络盘/移动盘）
    letters = (drives or "").upper()
    if letters:
        for letter in letters:
            root = letter + ":\\"
            if not os.path.isdir(root):
                continue
            for name in root_names:
                add(os.path.join(root, name))
    try:
        import psutil
        for part in psutil.disk_partitions(all=False):
            mp = str(part.mountpoint or "")
            if not mp or not os.path.isdir(mp):
                continue
            for name in root_names:
                add(os.path.join(mp, name))
    except Exception:
        pass
    return roots


def attach_dirs(db, root_names=DEFAULT_ROOT_NAMES, drives=DEFAULT_DRIVES,
                extra_data_roots=None):
    """所有 `msg/attach` 目录，当前账号的排第一。"""
    out = []
    seen = set()

    def add(p):
        if not p or not os.path.isdir(p):
            return
        key = _norm(p)
        if not key or key in seen:
            return
        seen.add(key)
        out.append(p)

    add(os.path.join(getattr(db, "account_dir", ""), "msg", "attach"))
    for root in data_roots(db, root_names, drives, extra_data_roots):
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            add(os.path.join(root, name, "msg", "attach"))
    return out


def install_media_fallback(dl, db, log=None, root_names=DEFAULT_ROOT_NAMES,
                           drives=DEFAULT_DRIVES, extra_data_roots=None):
    """给一个 MediaDownloader 实例装上图片目录兜底。返回安装了几处补丁。"""
    _log = log or (lambda *a, **k: None)
    cache = {"dirs": [], "ts": 0.0}

    def dirs():
        now = time.time()
        if cache["dirs"] and (now - cache["ts"]) < CACHE_TTL:
            return cache["dirs"]
        cache["dirs"] = attach_dirs(db, root_names, drives, extra_data_roots)
        cache["ts"] = now
        return cache["dirs"]

    installed = 0
    orig_image_files = getattr(dl, "_image_files", None)
    orig_probe = getattr(dl, "_probe_ct", None)
    orig_templates = getattr(dl, "_collect_templates", None)

    if callable(orig_image_files):
        def image_files(user, md5):
            files = orig_image_files(user, md5)
            if files:
                return files
            want = {md5 + "_h.dat": "original",
                    md5 + ".dat": "mid",
                    md5 + "_t.dat": "thumb"}
            try:
                chat = dl._chat_md5(user)
            except Exception:                       # noqa: BLE001
                return files
            for root in dirs():
                base = os.path.join(root, chat)
                if not os.path.isdir(base):
                    continue
                for dirpath, _dirnames, names in os.walk(base):
                    for f in names:
                        tier = want.get(f)
                        if tier and tier not in files:
                            p = os.path.join(dirpath, f)
                            try:
                                files[tier] = (p, os.path.getsize(p))
                            except OSError:
                                continue
                if files:
                    _log("[!] 图片不在当前微信目录，已从旧位置取到：", base)
                    break
            return files

        dl._image_files = image_files
        installed += 1

    if callable(orig_probe):
        def probe_ct(dat_path=None):
            got = orig_probe(dat_path)
            if got or dat_path:
                return got
            # 当前账号目录里一张 .dat 都没有（典型：刚改过保存位置）→ 去旧目录取样
            for root in dirs():
                hits = glob.glob(os.path.join(root, "*", "*", "Img", "*.dat"))
                if hits:
                    _log("[!] 当前目录没有图片样本，改用旧位置的样本来校验密钥：", root)
                    return orig_probe(hits[0])
            return got

        dl._probe_ct = probe_ct
        installed += 1

    if callable(orig_templates):
        def collect_templates(limit=32, keep=16):
            hits = orig_templates(limit, keep)
            if hits:
                return hits
            out = []
            for root in dirs():
                out.extend(glob.glob(os.path.join(root, "*", "*", "Img", "*_t.dat")))
            out.sort(key=lambda p: (os.path.getmtime(p) if os.path.exists(p) else 0), reverse=True)
            return out[:keep]

        dl._collect_templates = collect_templates
        installed += 1

    return installed


# ----------------------------------------------------------------------
# 自检：不需要微信、不需要真实数据，纯临时目录验证兜底逻辑
# ----------------------------------------------------------------------
def _selftest():
    import hashlib
    import shutil
    import sys
    import tempfile

    def md5(s):
        return hashlib.md5(s.encode()).hexdigest()

    tmp = tempfile.mkdtemp(prefix="whale-media-fallback-")
    try:
        chat = "wxid_someone"
        img_md5 = "0123456789abcdef0123456789abcdef"
        # 新位置：有数据库，但没有图片
        new_root = os.path.join(tmp, "new")
        acct_new = os.path.join(new_root, "wxid_abc_1111")
        os.makedirs(os.path.join(acct_new, "db_storage"))
        os.makedirs(os.path.join(acct_new, "msg", "attach"))
        # 旧位置：图片缓存还在这儿（带旧的哈希后缀）
        old_root = os.path.join(tmp, "old")
        acct_old = os.path.join(old_root, "wxid_abc_2222")
        os.makedirs(os.path.join(acct_old, "db_storage"))
        img_dir = os.path.join(acct_old, "msg", "attach", md5(chat), "2026-10", "Img")
        os.makedirs(img_dir)
        img_path = os.path.join(img_dir, img_md5 + ".dat")
        with open(img_path, "wb") as f:
            f.write(b"\x07\x08V2\x08\x07" + b"\x00" * 64)

        class DB:
            db_dir = new_root
            account_dir = acct_new

        class DL:
            """最小化模仿 MediaDownloader 里被替换的那几个方法。"""
            def _chat_md5(self, user):
                return md5(user)

            def _image_files(self, user, m):
                base = os.path.join(acct_new, "msg", "attach", self._chat_md5(user))
                out = {}
                if os.path.isdir(base):
                    for dirpath, _d, names in os.walk(base):
                        for f in names:
                            if f == m + ".dat":
                                out["mid"] = (os.path.join(dirpath, f), 1)
                return out

            def _probe_ct(self, dat_path=None):
                # 模仿真实实现：给了路径就直接读那个文件；没给才去当前账号目录里找
                if dat_path:
                    return b"SAMPLE"
                hits = glob.glob(os.path.join(acct_new, "msg", "attach", "*", "*", "Img", "*.dat"))
                if not hits:
                    return b""
                return b"SAMPLE"

            def _collect_templates(self, limit=32, keep=16):
                return []

        dl = DL()
        assert dl._image_files(chat, img_md5) == {}, "改造前：新目录应当找不到图"
        assert dl._probe_ct() == b"", "改造前：新目录应当没有密钥样本"

        n = install_media_fallback(dl, DB(), drives="", extra_data_roots=[old_root])
        assert n == 3, "应当装上 3 处补丁，实际 %r" % (n,)

        got = dl._image_files(chat, img_md5)
        assert "mid" in got, "改造后：应当从旧目录找到图片，实际 %r" % (got,)
        assert got["mid"][0] == img_path, "找到的应当就是旧目录那张图：%r" % (got["mid"][0],)

        assert dl._probe_ct() == b"SAMPLE", "改造后：应当能拿旧目录的样本校验密钥"

        # 当前目录本来就有图时，不能改变原行为（也不能多绕一圈）
        os.makedirs(os.path.join(acct_new, "msg", "attach", md5(chat), "2026-10", "Img"))
        with open(os.path.join(acct_new, "msg", "attach", md5(chat), "2026-10", "Img",
                               img_md5 + ".dat"), "wb") as f:
            f.write(b"x")
        again = dl._image_files(chat, img_md5)
        assert "mid" in again and again["mid"][0].startswith(acct_new), \
            "新目录自己有图时，必须用新目录的"

        print("SELFTEST OK · 3 处补丁 · 兜底能找到旧目录的图 · 不影响默认路径")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print("这个文件是桥接用的补丁模块，跑自检请加 --selftest")
