"""Normalize only known portable-runtime regressions in a STAGED release.

Never invokes UIA, reads processes, or touches a logged-in WeChat. The caller
passes the staging app root; patching is byte-level, idempotent and syntax checked.
"""
import ast
from pathlib import Path
import sys


def prepare(root):
    package = Path(root) / 'runtime' / 'python' / 'Lib' / 'site-packages' / 'wechatauto'
    driver = package / 'uia_driver.py'
    access = package / 'accessibility.py'
    if not driver.is_file() or not access.is_file():
        raise RuntimeError('portable wechatauto sources are missing')
    text = driver.read_text(encoding='utf-8')
    # Previous local patch added a second decorator, confusing the wrapper.
    while '    @staticmethod\n    @staticmethod\n' in text:
        text = text.replace('    @staticmethod\n    @staticmethod\n', '    @staticmethod\n')
    text = text.replace('    def _search_button(self, win):', '    def _search_button(win):')
    if '    @staticmethod\n    def _search_button(win):' not in text:
        raise RuntimeError('unknown _search_button layout; do not guess a runtime patch')
    ast.parse(text)
    driver.write_text(text, encoding='utf-8', newline='\n')

    text = access.read_text(encoding='utf-8')
    # Do not select a different process (possibly another account), nor scan/write
    # a vaguely named DLL. A missing exact module is NOT proof of compatibility.
    start = text.find('    @classmethod\n    def _find_main_weixin_pid(')
    if start >= 0:
        end = text.index('    @staticmethod\n    def _process_modules(', start)
        text = text[:start] + text[end:]
    start = text.index('    @classmethod\n    def _weixin_dll_module(')
    end = text.index('    @staticmethod\n    def _pe_sections(', start)
    text = text[:start] + '''    @classmethod
    def _weixin_dll_module(cls, pid: int):
        for base, size, name, path in cls._process_modules(pid) or ():
            if str(name or '').lower() == 'weixin.dll':
                return base, size, path
        return None

''' + text[end:]
    old = '''        if not mod:
            # 窗口属于辅助进程时，换成真正的主进程再试一次（否则永远热激活不了）
            alt = cls._find_main_weixin_pid(exclude=pid)
            if alt:
                pid = alt
                mod = cls._weixin_dll_module(pid)
'''
    text = text.replace(old, '')
    if '_find_main_weixin_pid' in text:
        raise RuntimeError('unknown cross-process fallback remains')
    # Preserve the existing 10-minute warning throttle; it is not a recovery claim.
    ast.parse(text)
    access.write_text(text, encoding='utf-8', newline='\n')
    return [driver, access]


if __name__ == '__main__':
    for file in prepare(sys.argv[1]):
        print('verified runtime source:', file.name)
