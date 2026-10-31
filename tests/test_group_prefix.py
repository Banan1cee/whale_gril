"""群消息前缀剥离的回归测试（不导入 engine：它有启动副作用）。

现场问题：微信 4.2 的群消息正文长这样
    wxid_e9fnvd2qhp6z22:\\n这个黄团子吃个酸奶
私聊没有这层前缀，所以只有群聊里「怪怪的」——模型收到的是一串 wxid，
@ 判定和重复检查也跟着错。这里直接读 engine.py 里的那条正则来验。

跑法：python -B tests/test_group_prefix.py
"""
import ast
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'bridge' / 'engine.py'


def load_pattern():
    """从 engine.py 的模块级赋值里把 _GROUP_SENDER_PREFIX_RE 取出来编译。"""
    tree = ast.parse(ENGINE.read_text(encoding='utf-8'))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        target = node.targets[0]
        if getattr(target, 'id', '') != '_GROUP_SENDER_PREFIX_RE':
            continue
        expression = ast.Expression(body=node.value)
        return eval(compile(expression, str(ENGINE), 'eval'), {'re': re})  # noqa: S307
    raise AssertionError('engine.py 里找不到 _GROUP_SENDER_PREFIX_RE')


class GroupPrefixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pattern = load_pattern()

    def strip(self, text):
        return self.pattern.sub('', text, count=1)

    def test_wxid_prefix_is_removed(self):
        self.assertEqual(
            self.strip('wxid_e9fnvd2qhp6z22:\n这个黄团子吃个酸奶'),
            '这个黄团子吃个酸奶')
        self.assertEqual(self.strip('wxid_abc:你好'), '你好')

    def test_plain_text_is_untouched(self):
        for text in ['今天好累啊', '啊？', '你们上课也在偷吃吗']:
            self.assertEqual(self.strip(text), text, text)

    def test_url_is_not_mistaken_for_prefix(self):
        # (?!/) 这条负向断言就是为它加的：正文直接是链接时不能被吃掉协议头
        self.assertEqual(self.strip('https://a.com'), 'https://a.com')

    def test_short_prefix_is_left_alone(self):
        # 三个字母不像 wxid，宁可不动，避免把「abc: 内容」这种正文切坏
        self.assertEqual(self.strip('abc: 测试'), 'abc: 测试')

    def test_only_first_prefix_is_stripped(self):
        text = 'wxid_aaa:wxid_bbb:正文'
        self.assertEqual(self.strip(text), 'wxid_bbb:正文')


if __name__ == '__main__':
    unittest.main()
