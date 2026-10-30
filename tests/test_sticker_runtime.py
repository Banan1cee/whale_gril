"""Pure source-only tests for staging-time runtime repairs. No UI/process imports."""
import ast
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

script = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare-sticker-runtime.py'
spec = importlib.util.spec_from_file_location('runtime_prepare', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

DRIVER = '''class WeChatUIA:
    @staticmethod
    @staticmethod
    def _search_button(win):
        return win
'''
ACCESS = '''class AccessibilityGate:
    @classmethod
    def _find_main_weixin_pid(cls, exclude=None):
        return 123
    @staticmethod
    def _process_modules(pid):
        return []
    @classmethod
    def _weixin_dll_module(cls, pid):
        return 'wrong.dll'
    @staticmethod
    def _pe_sections(data):
        return []
    @classmethod
    def _hot_activate_accessibility(cls, hwnd):
        pid = hwnd
        mod = cls._weixin_dll_module(pid)
        if not mod:
            # 窗口属于辅助进程时，换成真正的主进程再试一次（否则永远热激活不了）
            alt = cls._find_main_weixin_pid(exclude=pid)
            if alt:
                pid = alt
                mod = cls._weixin_dll_module(pid)
        return mod
'''

class RuntimeSourceTest(unittest.TestCase):
    def test_duplicate_staticmethod_removed_and_works_both_call_styles(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / 'runtime/python/Lib/site-packages/wechatauto'
            pkg.mkdir(parents=True)
            driver = pkg / 'uia_driver.py'; access = pkg / 'accessibility.py'
            driver.write_text(DRIVER, encoding='utf-8'); access.write_text(ACCESS, encoding='utf-8')
            mod.prepare(tmp)
            scope = {}
            exec(compile(driver.read_text(encoding='utf-8'), '<mock driver>', 'exec'), scope)
            cls = scope['WeChatUIA']
            self.assertEqual(cls._search_button('window'), 'window')
            self.assertEqual(cls()._search_button('window'), 'window')
            before = (driver.read_bytes(), access.read_bytes())
            mod.prepare(tmp)
            self.assertEqual(before, (driver.read_bytes(), access.read_bytes()))
            tree = ast.parse(access.read_text(encoding='utf-8'))
            self.assertNotIn('_find_main_weixin_pid', access.read_text(encoding='utf-8'))
            scope = {}; exec(compile(tree, '<mock access>', 'exec'), scope)
            gate = scope['AccessibilityGate']
            gate._process_modules = staticmethod(lambda pid: [(1, 2, 'WeChatWin.dll', 'wrong.dll')])
            self.assertIsNone(gate._weixin_dll_module(10))
            gate._process_modules = staticmethod(lambda pid: [(1, 2, 'Weixin.dll', 'right.dll')])
            self.assertEqual(gate._weixin_dll_module(10), (1, 2, 'right.dll'))

    def test_unknown_runtime_layout_is_not_silently_patched(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / 'runtime/python/Lib/site-packages/wechatauto'; pkg.mkdir(parents=True)
            (pkg / 'uia_driver.py').write_text('class Unsupported: pass', encoding='utf-8')
            (pkg / 'accessibility.py').write_text(ACCESS, encoding='utf-8')
            with self.assertRaises(RuntimeError): mod.prepare(tmp)

if __name__ == '__main__':
    unittest.main(verbosity=2)
