"""消息攒批 + 「过期」判断位置的回归测试（不导入 engine：它有启动副作用）。

复现的 bug：同一会话连发两条，第一条要跑 10~30 秒（等模型 + 模拟点击发送），
第二条一直在队里等；旧实现到「出队执行时」才判 `create_time > STALE_AFTER`，
于是第二条一出队就已经是「过期消息」，被静默丢掉 —— 用户看到的就是
「连发几条，她只回一条」。
"""
import ast
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

from msg_pipeline import MessageBatches, split_runs, mergeable  # noqa: E402

ENGINE = ROOT / 'bridge' / 'engine.py'


def _module_regex(name):
    """把 engine.py 里的模块级正则（如群消息前缀）原样取出来。"""
    tree = ast.parse(ENGINE.read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return eval(compile(ast.Expression(body=node.value), str(ENGINE), 'eval'), {'re': re})  # noqa: S307
    raise AssertionError('engine.py 里找不到 %s' % name)


def _bridge_function(name, environment):
    """把 engine.py 里的嵌套函数单独拿出来跑（和 test_sticker_transport 一个路子）。"""
    tree = ast.parse(ENGINE.read_text(encoding='utf-8'))
    definitions = [node for node in ast.walk(tree)
                   if isinstance(node, ast.FunctionDef) and node.name == name]
    if not definitions:
        raise AssertionError('bridge function not found: %s' % name)
    exec(compile(ast.fix_missing_locations(
        ast.Module(body=definitions, type_ignores=[])), '<mock-only bridge function>', 'exec'), environment)
    return environment[name]



def _names_in_function(path, func_name):
    """engine.py 里某个（可能是嵌套的）函数引用到的所有名字。"""
    tree = ast.parse(path.read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
    raise AssertionError('%s 里找不到函数 %s' % (path, func_name))


class BatchTest(unittest.TestCase):
    def test_burst_is_not_dropped(self):
        """连发两条：第一条排 flush，第二条搭同一趟，一条都不能丢。"""
        b = MessageBatches(limit=8)
        self.assertTrue(b.push('chat', 'm1'))
        self.assertFalse(b.push('chat', 'm2'))
        self.assertEqual(b.take('chat'), ['m1', 'm2'])
        self.assertEqual(b.status()['dropped'], 0)

    def test_flag_cleared_when_processing_starts(self):
        """处理期间新来的消息必须能再排一次 flush，否则会一直躺着没人管。"""
        b = MessageBatches()
        b.push('chat', 'm1')
        b.take('chat')                             # 开始处理
        self.assertTrue(b.push('chat', 'm2'))
        self.assertEqual(b.take('chat'), ['m2'])

    def test_submit_failure_can_be_released(self):
        """投递失败要能放开标记重投，不能把消息永久卡在待处理里。"""
        b = MessageBatches()
        self.assertTrue(b.push('chat', 'm1'))
        b.release('chat')
        self.assertTrue(b.push('chat', 'm2'))
        self.assertEqual(b.take('chat'), ['m1', 'm2'])

    def test_overflow_keeps_newest_and_counts(self):
        """极端刷屏只留最新的几条，但要记账（以前是静默丢）。"""
        b = MessageBatches(limit=3)
        for i in range(5):
            b.push('chat', i)
        self.assertEqual(b.take('chat'), [2, 3, 4])
        self.assertEqual(b.status()['dropped'], 2)

    def test_only_same_sender_adjacent_merge(self):
        """群里张三说完李四说，不能并成一条（否则回复会张冠李戴）。"""
        msgs = [
            {'sender_username': 'a'},
            {'sender_username': 'a'},
            {'sender_username': 'b'},
            {'sender_username': 'a'},
        ]
        self.assertEqual([len(r) for r in split_runs(msgs)], [2, 1, 1])
        self.assertTrue(mergeable([{'type': '文本'}, {'type': '文本'}]))
        self.assertFalse(mergeable([{'type': '文本'}, {'type': '图片'}]))

    def test_stale_check_moved_out_of_the_worker(self):
        """过期必须在「收到时」判，不能放到 worker 里 —— 那就是这个 bug 的根因。"""
        inner = _names_in_function(ENGINE, 'on_message_inner')
        intake = _names_in_function(ENGINE, 'on_message')
        self.assertNotIn('STALE_AFTER', inner)
        self.assertIn('STALE_AFTER', intake)


class MergeTextBatchTest(unittest.TestCase):
    """engine.merge_text_batch 真的把连发合并对了（含群消息前缀剥离）。"""

    def setUp(self):
        self.log = []
        env = {
            'log': lambda *a: self.log.append(' '.join(str(x) for x in a)),
            '_GROUP_SENDER_PREFIX_RE': _module_regex('_GROUP_SENDER_PREFIX_RE'),
        }
        self.merge = _bridge_function('merge_text_batch', env)

    def _m(self, content, sender='wxid_me', lid=1):
        return {'username': 'room@chatroom', 'sender_username': sender,
                'type': '文本', 'content': content, 'local_id': lid, 'shard': 's'}

    def test_private_chat_joins_texts_and_ids(self):
        merged = self.merge([self._m('在吗', lid=1), self._m('问你个事', lid=2)], 'wxid_peer')
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['content'], '在吗\n问你个事')
        self.assertEqual(merged[0]['local_id'], '1|2')

    def test_group_prefix_stripped_per_line(self):
        """群里每条正文都带 "wxid_xxx:" 前缀，合并时必须逐条剥掉。"""
        run = [self._m('wxid_abc123:\n在吗', lid=1), self._m('wxid_abc123:\n在吗在吗', lid=2)]
        merged = self.merge(run, '123@chatroom')
        self.assertEqual(merged[0]['content'], '在吗\n在吗在吗')

    def test_empty_run_keeps_original(self):
        only = self._m('   ', lid=9)
        self.assertEqual(self.merge([only], 'room@chatroom'), [only])


if __name__ == '__main__':
    unittest.main()
