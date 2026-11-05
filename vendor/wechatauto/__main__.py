"""``python -m wechatauto`` —— 一条命令的入口。

真正的实现都在 :mod:`wechatauto.cli`；这里只留一层薄分发，顺便保住老行为：
``python -m wechatauto --version`` / ``-v`` 以前就直接打印版本号，现在仍然如此。
"""
import sys

from wechatauto.cli import main

if __name__ == "__main__":
    sys.exit(main())
