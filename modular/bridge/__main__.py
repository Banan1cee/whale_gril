# -*- coding: utf-8 -*-
"""`python -m bridge` 入口。

把 bridge/ 和 examples/ 都放进 sys.path：
  - bridge/    -> engine 本体
  - examples/  -> media_fallback 等薄模块
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (os.path.join(_ROOT, "bridge"), os.path.join(_ROOT, "examples")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from engine import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main() or 0)
