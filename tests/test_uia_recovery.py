"""UIA 周期检查不能另启微信实例，也不能抢前台。"""
import os
import sys
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import uia_boot as boot


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        boot._LAST_RESTORE[0] = 0

    def test_repeated_checks_without_main_window_never_launch_wechat(self):
        with patch.object(boot, 'pick_window', return_value=None), \
                patch.object(boot, 'launch_wechat') as launch, \
                patch.object(boot.subprocess, 'Popen') as popen:
            for _ in range(4):
                self.assertEqual(boot.ensure()['reason'], 'no_window')
            launch.assert_not_called()
            popen.assert_not_called()

    def test_hidden_existing_window_restored_without_process_or_foreground(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock(), SetForegroundWindow=Mock())
        win32con = SimpleNamespace(SW_SHOWNOACTIVATE=4)
        win = dict(hwnd=123, pid=456, version='4.2.0.9')
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': win32con}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=False), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(win32gui, 'SetForegroundWindow') as foreground, \
                patch.object(boot, 'pick_window', return_value=win), \
                patch.object(boot, 'tree_state', return_value='ok'), \
                patch.object(boot.subprocess, 'Popen') as popen:
            self.assertTrue(boot.restore_wechat(win))
            show.assert_called_once_with(123, win32con.SW_SHOWNOACTIVATE)
            foreground.assert_not_called()
            popen.assert_not_called()

    def test_visible_window_with_broken_tree_is_not_popped_again(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock())
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': SimpleNamespace(SW_SHOWNOACTIVATE=4)}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=True), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(boot.subprocess, 'Popen') as popen:
            self.assertFalse(boot.restore_wechat(dict(hwnd=123, pid=456)))
            show.assert_not_called()
            popen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
