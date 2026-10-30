#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零焦点发送通道的命令行入口（兼容文档里的命令）。

真正的实现已经迁到 `bridge/bg_sender.py`，这里只负责补 sys.path 后转交。

    python examples/wechat_bg.py --probe
    python examples/wechat_bg.py --send "测试" --to 文件传输助手

也可以直接用桥接的入口（效果一样，参数更全）：

    python -m bridge --bg-probe
    python -m bridge --bg-send "测试" --to 文件传输助手
"""

import os
import sys

_EXAMPLES = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_EXAMPLES)
for _p in (os.path.join(_ROOT, "bridge"), _EXAMPLES):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bg_sender  # noqa: E402


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)

    def log(*args):
        print(*args, flush=True)

    if "--send" in argv or "--bg-send" in argv:
        flag = "--send" if "--send" in argv else "--bg-send"
        i = argv.index(flag)
        text = argv[i + 1] if len(argv) > i + 1 else ""
        to = None
        if "--to" in argv:
            j = argv.index("--to")
            to = argv[j + 1] if len(argv) > j + 1 else None
        ok, why = bg_sender.send(text, chat=to, log=log)
        log("发送 = %s（%s）" % (ok, why))
        return 0 if ok else 1

    if "--probe" in argv:
        res = bg_sender.probe(log=log)
        return 0 if res.get("edit") else 1

    print(__doc__.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
