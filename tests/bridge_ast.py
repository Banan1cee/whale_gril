# -*- coding: utf-8 -*-
"""测试辅助：从拆分后的 bridge/*.py 里取函数/类，按运行时上下文执行。

桥接已经从单个 engine.py 拆成 app.py + 多个 mixin。测试不应该再假设
某个函数一定长在 engine.py 里，所以这里统一扫描 bridge/ 下的模块：

- `init(env)`：给 mock 环境补上 `self` / `G` 代理，让 mixin 方法能直接执行；
- `load_function(name, env)`：找到函数（含类方法），去掉 self 参数后注入 env；
- `load_class(name, env)`：找到类定义并注入 env；
- `find_assignment(name)`：找模块级赋值（如群消息前缀正则）。
"""

import ast
import copy
import glob
import os
import sys

BRIDGE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'bridge')
if BRIDGE_DIR not in sys.path:
    sys.path.insert(0, BRIDGE_DIR)

import engine as _engine  # noqa: E402

_FILES = sorted(glob.glob(os.path.join(BRIDGE_DIR, '*.py')))
_TREES = []
for _path in _FILES:
    try:
        with open(_path, encoding='utf-8-sig') as _fh:
            _TREES.append((_path, ast.parse(_fh.read())))
    except SyntaxError:
        pass


class _SelfProxy:
    """把 `self.x` 读写映射到测试 env；env 没有的再回落到真实 runtime。"""

    def __init__(self, env):
        object.__setattr__(self, '_env', env)

    def __getattr__(self, name):
        env = object.__getattribute__(self, '_env')
        if name in env:
            return env[name]
        runtime = env.get('__runtime__')
        if runtime is not None:
            return getattr(runtime, name)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        object.__getattribute__(self, '_env')[name] = value


class _GProxy:
    """`G.x`：测试 env 优先，否则读真实 engine 模块。"""

    def __init__(self, env):
        object.__setattr__(self, '_env', env)

    def __getattr__(self, name):
        env = object.__getattribute__(self, '_env')
        if name in env:
            return env[name]
        return getattr(_engine, name)

    def __setattr__(self, name, value):
        env = object.__getattribute__(self, '_env')[name] = value


def init(env):
    env.setdefault('G', _GProxy(env))
    env.setdefault('self', _SelfProxy(env))
    return env


def _functions(name):
    for path, tree in _TREES:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                yield path, node


def load_function(name, env):
    init(env)
    for path, node in _functions(name):
        node = copy.deepcopy(node)
        # 类方法去掉 self；保留原参数表。
        if getattr(node, 'args', None) and node.args.args and node.args.args[0].arg == 'self':
            node.args.args = node.args.args[1:]
        try:
            exec(compile(ast.fix_missing_locations(
                ast.Module(body=[node], type_ignores=[])), path, 'exec'), env)
            return env[name]
        except Exception:
            continue
    raise AssertionError('bridge function not found: %s' % name)


def load_class(name, env):
    init(env)
    for path, tree in _TREES:
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == name:
                exec(compile(ast.fix_missing_locations(
                    ast.Module(body=[copy.deepcopy(node)], type_ignores=[])), path, 'exec'), env)
                return env[name]
    raise AssertionError('bridge class not found: %s' % name)


def find_assignment(name):
    for path, tree in _TREES:
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == name for t in node.targets):
                return path, node.value
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) \
                    and node.target.id == name:
                return path, node.value
    raise AssertionError('bridge assignment not found: %s' % name)
