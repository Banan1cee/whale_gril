"""桥接启动接线的回归测试（不导入 engine：它有启动副作用）。

现场问题：`main()` 里定义了一个无参的同名 `start_reminder_watch`（用闭包里的
bot_url/token/send_text 构造 ReminderRunner），但调用处仍按模块顶部从
`reminder_watch` 导入的那个签名传了 http/base/token/... 六个关键字参数。
结果桥接每次启动都在 `main()` 末尾抛：

    TypeError: main.<locals>.start_reminder_watch() got an unexpected keyword argument 'http'

进程 code=1 退出，启动器不会自动拉起。这里用 AST 钉住「调用必须和最近的同名
定义签名一致」，防止再被同名遮蔽坑一次。

跑法：python -B -m unittest tests/test_engine_reminder_wiring.py
"""
import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'bridge' / 'engine.py'


def parse_engine():
    return ast.parse(ENGINE.read_text(encoding='utf-8'))


def find(node, name):
    for child in ast.walk(node):
        if isinstance(child, ast.FunctionDef) and child.name == name:
            return child
    return None


class ReminderWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = parse_engine()
        cls.main = find(cls.tree, 'main')
        assert cls.main is not None, 'engine.py 里找不到 main()'

    def test_nested_starter_takes_no_arguments(self):
        starter = find(self.main, 'start_reminder_watch')
        self.assertIsNotNone(starter, 'main() 里的 start_reminder_watch 不见了')
        self.assertEqual(len(starter.args.args), 0, '闭包版启动器不应要求位置参数')
        self.assertEqual(len(starter.args.kwonlyargs), 0, '闭包版启动器不应要求关键字参数')

    def test_call_matches_nested_signature(self):
        calls = [
            node for node in ast.walk(self.main)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == 'start_reminder_watch'
        ]
        self.assertTrue(calls, 'main() 里没有启动提醒调度器')
        for call in calls:
            self.assertEqual(len(call.args), 0, f'调用传了位置参数（第 {call.lineno} 行）')
            self.assertEqual(len(call.keywords), 0,
                             f'调用传了关键字参数（第 {call.lineno} 行）：'
                             + ', '.join(k.arg or '**' for k in call.keywords))

    def test_runner_is_assigned_for_shutdown(self):
        """退出分支要能拿到 REMINDER_RUNNER，所以闭包版必须给它赋值。"""
        starter = find(self.main, 'start_reminder_watch')
        assigns = [
            node for node in ast.walk(starter)
            if isinstance(node, ast.Name) and node.id == 'REMINDER_RUNNER'
            and isinstance(node.ctx, ast.Store)
        ]
        self.assertTrue(assigns, '闭包版启动器没有给 REMINDER_RUNNER 赋值')


if __name__ == '__main__':
    unittest.main()
