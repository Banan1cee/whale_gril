# -*- coding: utf-8 -*-
"""微信 4.x 数据目录与多账号解析。

只处理「文件系统 + 配置里写的目录/账号」这一层，不启动微信、不发消息、
不依赖 engine.py 的运行时闭包。engine.py 保留同名薄封装，旧调用点不用改。
"""

import json
import os
import re

DB_ROOT_NAMES = ("xwechat_files", "WeChat Files", "xwechat_files_data")


def looks_like_db_root(p):
    """这个目录像不像微信 4.x 的数据根（下面有 <账号>/db_storage）。

    兼容四种布局：
      E:\\xwechat_files\\<账号>\\db_storage
      E:\\xwechat_files\\db_storage            （账号目录层级被拍平）
      直接把 <账号> 目录填进来（p\\db_storage）
      直接把 db_storage 目录填进来
    """
    if not p or not os.path.isdir(p):
        return False
    # 直填账号目录 / 直填 db_storage
    if os.path.isdir(os.path.join(p, "db_storage")):
        return True
    if os.path.basename(os.path.normpath(p)).lower() == "db_storage":
        return True
    bases = [p]
    for name in DB_ROOT_NAMES:
        bases.append(os.path.join(p, name))
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if os.path.isdir(os.path.join(base, name, "db_storage")):
                return True
    return False


def normalize_db_root(p):
    """把用户填的目录归一到「直接包含 <账号>\\db_storage」的那一层。

    为什么需要：`looks_like_db_root` 认四种写法（填高一层 / 填账号目录 /
    直接填 db_storage 都算），但 wechatauto 开库要的是 `db_dir/<账号>/db_storage`
    这一种。少了这一步，用户填 `E:\\WeChat Files`（真实库在
    `E:\\WeChat Files\\xwechat_files\\<wxid>\\db_storage`）时会出现：
    looks 说「这是数据根」、find_account_dirs 却是空的 →「找不到账号（一个都没有）」。

    往上：填的是账号目录或 db_storage 本身 → 数据根在上一层。
    往下：数据根里还嵌着一层 xwechat_files / WeChat Files → 钻进去。
    往下有两条护栏，缺一条就会来回跳：
      - 候选自己就有 db_storage（说明它是账号目录）→ 留在当前层，
        当前层的子目录正好就是它，find_account_dirs 能列出来；
      - 候选等于起点 → 拍平布局往上走一层后又会认回原地，禁掉。
    """
    if not p or not os.path.isdir(p):
        return p
    start = os.path.normpath(p)
    cur = start
    for _ in range(4):
        base = os.path.basename(os.path.normpath(cur))
        if base.lower() == "db_storage" or os.path.isdir(os.path.join(cur, "db_storage")):
            parent = os.path.dirname(os.path.normpath(cur))
            if not parent or parent == os.path.normpath(cur):
                break
            cur = parent
            continue
        break
    for _ in range(3):
        if os.path.isdir(os.path.join(cur, "db_storage")):
            break
        nxt = ""
        for name in DB_ROOT_NAMES:
            cand = os.path.join(cur, name)
            if os.path.normpath(cand) == start:
                continue
            if not os.path.isdir(cand) or os.path.isdir(os.path.join(cand, "db_storage")):
                continue
            if _has_account_dirs(cand):
                nxt = cand
                break
        if not nxt:
            break
        cur = nxt
    return cur


def _has_account_dirs(base):
    """base 下面有没有「<子目录>\\db_storage」——只看一层，够判断该不该下钻。"""
    try:
        entries = os.listdir(base)
    except OSError:
        return False
    for name in entries:
        if os.path.isdir(os.path.join(base, name, "db_storage")):
            return True
    return False


def iter_drive_roots():
    """列出真实的磁盘根（含 L:、网络映射盘、UNC），不再写死 C..K。"""
    roots = []
    try:
        import string
        for letter in string.ascii_uppercase:
            root = letter + ":\\"
            if os.path.isdir(root):
                roots.append(root)
    except Exception:
        pass
    try:
        import psutil
        for part in psutil.disk_partitions(all=False):
            mp = str(part.mountpoint or "")
            if mp and mp not in roots and os.path.isdir(mp):
                roots.append(mp)
    except Exception:
        pass
    return roots


def resolve_db_dir(config_path=None, drives="CDEFGHIJK", default_config_path=""):
    """找微信 4.x 的数据库目录，比 wechatauto 自带的 auto_detect 更狠。

    顺序：config.json 的 wechat.dbDir → 正在运行的微信进程打开的文件 → 各盘根目录。
    `default_config_path` 由 engine.py 传入（ROOT/config.json），模块本身不猜路径。
    """
    # 1) 配置里手填的
    manual = ""
    try:
        with open(config_path or default_config_path, "r", encoding="utf-8-sig") as f:
            manual = str(((json.load(f).get("wechat") or {}).get("dbDir") or "")).strip()
    except Exception:
        manual = ""
    if manual and looks_like_db_root(manual):
        return normalize_db_root(manual)

    # 2) 正在运行的微信进程打开着数据库文件 —— 直接反射出来，最准
    try:
        import psutil
        for proc in psutil.process_iter(["name"]):
            name = str(proc.info.get("name") or "").lower()
            if not any(k in name for k in ("weixin", "wechat")):
                continue
            try:
                open_files = proc.open_files()
            except Exception:
                continue
            for item in open_files:
                # 取**最右**那次命中：路径 E:\\WeChat Files\\xwechat_files\\<账号>\\db_storage
                # 里两个名字都匹配，取最左会把根截断在 WeChat Files（高一层），
                # 于是 looks 通过、账号却一个都列不出来。
                hits = list(re.finditer(r"([\\/])(" + "|".join(DB_ROOT_NAMES) + r")([\\/]|$)",
                                        item.path or "", re.I))
                if not hits:
                    continue
                m = hits[-1]
                # 取「名字之前的那一段」作为盘符/目录，再拼回 xwechat_files
                root = (item.path or "")[: m.start() + 1] + m.group(2)
                if looks_like_db_root(root):
                    return normalize_db_root(root)
    except Exception:
        pass

    # 3) 所有真实磁盘根（以前写死 C..K，L: 盘和网络盘永远找不到）
    for root in iter_drive_roots():
        for name in DB_ROOT_NAMES:
            cand = os.path.join(root, name)
            if looks_like_db_root(cand):
                return normalize_db_root(cand)
    return ""


def find_account_dirs(db_dir):
    """列出 <db_dir> 下所有含 db_storage 的账号目录名。

    不能按 wxid_ 前缀判断：设了自定义微信号的账号目录名不一定以 wxid_ 开头。

    口径必须和 looks_like_db_root 一致 —— 它认四种布局，这里也得四种都数得到，
    否则就会出现「looks 说这是数据根、这里却一个账号都没有」，
    用户看到的是「找不到账号（一个都没有）」，而配置其实没填错。
    """
    if not db_dir:
        return []
    out = set()
    # 1) 直接子目录 <账号>/db_storage
    # 2) 嵌套一层 <db_dir>/xwechat_files/<账号>/db_storage（数据根填高了一层）
    bases = [db_dir] + [os.path.join(db_dir, name) for name in DB_ROOT_NAMES]
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if os.path.isdir(os.path.join(base, name, "db_storage")):
                out.add(name)
    # 3) db_dir 自己就是账号目录，或者就是 db_storage（拍平 / 直填）
    norm = os.path.normpath(db_dir)
    if os.path.isdir(os.path.join(db_dir, "db_storage")):
        bn = os.path.basename(norm)
        if bn:
            out.add(bn)
    elif os.path.basename(norm).lower() == "db_storage":
        bn = os.path.basename(os.path.dirname(norm))
        if bn:
            out.add(bn)
    return sorted(out)


def account_wxid(account):
    """账号目录名去掉末尾 4 位哈希 = wxid（和 wechatauto 的 WeChatDB.wxid 同一套规则）。"""
    return re.sub(r"_\w{4}$", "", str(account or ""))


def resolve_account_dir(db_dir, wanted):
    """把配置/网页里的账号写法解析成真实账号目录名。

    依次尝试：完整目录名（wxid_xxx_cedb）→ 去掉 4 位哈希的 wxid（wxid_xxx）
    → 唯一前缀 → 昵称（要开库读 contact.db，慢，所以放最后）。
    返回目录名；匹配不到返回 ""。
    """
    wanted = str(wanted or "").strip()
    if not wanted or not db_dir:
        return ""
    # 调用方可能给的是「填高一层 / 直填账号目录」的写法，先归一再按目录名匹配，
    # 否则按错的层级去开库，昵称匹配永远对不上。
    db_dir = normalize_db_root(db_dir)
    names = find_account_dirs(db_dir)
    if not names:
        return ""
    if wanted in names:
        return wanted
    for n in names:
        if account_wxid(n) == wanted:
            return n
    hit = [n for n in names if n.lower().startswith(wanted.lower())]
    if len(hit) == 1:
        return hit[0]
    # 昵称匹配：只有前面都没命中才做（每个账号要开一次库，约 1 秒）
    try:
        from wechatauto import WeChatDB
    except Exception:
        return ""
    for n in names:
        try:
            probe = WeChatDB(db_dir=db_dir, account=n)
            if probe.account != n:
                continue                     # 库自己换号了，别用它的昵称
            info = probe.get_self_info() or {}
            nick = str(info.get("nick_name") or info.get("remark") or "").strip()
        except Exception:
            continue
        if nick and nick == wanted:
            return n
    return ""
