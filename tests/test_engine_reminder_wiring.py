"""桥接启动接线的回归测试（不导入 engine：它有启动副作用）。

现场问题：`main()` 里定义了一个无参的同名 `start_reminder_watch`（用闭包里的
bot_url/token/send_text 构造 ReminderRunner），但调用处仍按模块顶部从
`reminder_watch` 导入的那个签名传了 http/base/token/... 六个关键字参数。

拆分后：
- 启动器是 `loop_mixin.LoopMixin.start_reminder_watch(self)`；
- `app.py` 用 `self.start_reminder_watch()` 无参调用并写回 `G.REMINDER_RUNNER`。

这里钉住「调用必须和最近的同名定义签名一致」，防止再被同名遮蔽坑一次。
"""
import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / 'bridge' / 'app.py'
LOOP = ROOT / 'bridge' / 'loop_mixin.py'


def find(node, name):
    for child in ast.walk(node):
        if isinstance(child, ast.FunctionDef) and child.name == name:
            return child
    return None


class ReminderWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ast.parse(APP.read_text(encoding='utf-8'))
        cls.loop = ast.parse(LOOP.read_text(encoding='utf-8'))
        cls.starter = find(cls.loop, 'start_reminder_watch')
        assert cls.starter is not None, 'loop_mixin.py 里找不到 start_reminder_watch()'

    def test_nested_starter_takes_only_self(self):
        self.assertEqual([a.arg for a in self.starter.args.args], ['self'])
        self.assertEqual(len(self.starter.args.kwonlyargs), 0)

    def test_call_matches_nested_signature(self):
        calls = [
            node for node in ast.walk(self.app)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'start_reminder_watch'
        ]
        self.assertTrue(calls, 'app.py 里没有启动提醒调度器')
        for call in calls:
            self.assertEqual(len(call.args), 0, f'调用传了位置参数（第 {call.lineno} 行）')
            self.assertEqual(len(call.keywords), 0,
                             f'调用传了关键字参数（第 {call.lineno} 行）：'
                             + ', '.join(k.arg or '**' for k in call.keywords))

    def test_runner_is_assigned_for_shutdown(self):
        """退出分支要能拿到 REMINDER_RUNNER，所以启动器必须给它赋值。"""
        assigns = [
            node for node in ast.walk(self.starter)
            if isinstance(node, ast.Attribute) and node.attr == 'REMINDER_RUNNER'
            and isinstance(node.ctx, ast.Store)
        ]
        self.assertTrue(assigns, '启动器没有给 REMINDER_RUNNER 赋值')


if __name__ == '__main__':
    unittest.main()
