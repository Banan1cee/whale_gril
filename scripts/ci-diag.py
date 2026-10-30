"""临时诊断脚本：桥接表情包发送在 CI 上全部返回 failed，本地不复现。

用法（仓库根目录）：python scripts/ci-diag.py
定位完成后本文件会被删除。
"""
import os
import sys
import tempfile
import traceback

sys.path.insert(0, 'bridge')
sys.path.insert(0, 'tests')

import sticker_transport as transport  # noqa: E402

print('TEMP=', tempfile.gettempdir())
folder = tempfile.mkdtemp()
image = os.path.join(folder, 'test.png')
with open(image, 'wb') as stream:
    stream.write(b'mock-image-decoder-is-injected')
print('root=', folder)
print('real_root=', os.path.realpath(folder))
print('root_same=', os.path.normcase(folder) == os.path.normcase(os.path.realpath(folder)))
print('file_same=', os.path.normcase(image) == os.path.normcase(os.path.realpath(image)))
info = os.lstat(image)
print('attrs=', hex(getattr(info, 'st_file_attributes', 0)), 'ino=', info.st_ino)
try:
    print('validate_path ->', transport.validate_path(image, folder, lambda a, b: None))
except Exception:
    traceback.print_exc()

for name in ('validate_path', 'watermark', 'db_identity', 'resolve_target', '_file_marker',
             'confirm_delivery'):
    target = getattr(transport, name, None)
    if target is None:
        continue

    def make(fn=target, label=name):
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception:
                print('EXC in', label)
                traceback.print_exc()
                raise
        return inner

    setattr(transport, name, make())

import test_sticker_transport as T  # noqa: E402

case = T.TransportTest('test_confirmed_only_after_one_paste_one_enter_and_outgoing_delta')
case.setUp()
print('SEND=', case.send())
case.doCleanups()
