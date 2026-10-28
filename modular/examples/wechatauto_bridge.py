#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""兼容入口：原来的 `python examples/wechatauto_bridge.py` 继续可用。

实现已经迁到 `bridge/engine.py`；这里只负责补齐 sys.path 再转交。
"""

import os
import sys

_EXAMPLES = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_EXAMPLES)
for _p in (os.path.join(_ROOT, "bridge"), _EXAMPLES):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from engine import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main() or 0)
