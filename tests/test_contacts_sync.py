"""联系人同步（桥接侧）：只验取数与整理，不连微信、不联网。"""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))
spec = importlib.util.spec_from_file_location('contacts_sync', ROOT / 'bridge/contacts_sync.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


class FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def execute(self, sql, params=()):
        self.rows_out = self.rows
        return self

    def fetchall(self):
        return self.rows_out

    def close(self):
        self.closed = True


class FakeDB:
    def __init__(self, contacts=None, groups=None, wxid='wxid_self', broken=False):
        self.contacts = contacts or []
        self.groups = groups or []
        self.wxid = wxid
        self.broken = broken
        self.conn = FakeConn(self.contacts)

    def _contact_conn(self):
        if self.broken:
            raise RuntimeError('需要微信登录才能读库')
        return self.conn

    def search_contact(self, keyword):
        return []

    def get_groups(self):
        return self.groups


class CollectTests(unittest.TestCase):
    def test_normalizes_users_and_groups(self):
        db = FakeDB(
            contacts=[{'username': 'wxid_a', 'nick_name': '阿螈', 'remark': '小螈'},
                      {'username': 'wxid_b', 'nick_name': '小海', 'remark': ''}],
            groups=[{'username': '1@chatroom', 'name': '鱼塘'}],
        )
        items = cs.collect(db)
        # 群先收（只有几十个，黑/白名单都要用），联系人随后
        self.assertEqual([i['wxid'] for i in items], ['1@chatroom', 'wxid_a', 'wxid_b'])
        users = [i for i in items if not i['isGroup']]
        self.assertEqual(users[0]['name'], '阿螈')
        self.assertEqual(users[0]['remark'], '小螈')
        self.assertTrue(items[0]['isGroup'], '群必须标成 isGroup')

    def test_group_flag_also_comes_from_wxid_suffix(self):
        db = FakeDB(contacts=[{'username': '2@chatroom', 'nick_name': '群', 'remark': ''}])
        self.assertTrue(cs.collect(db)[0]['isGroup'])

    def test_dedupes_same_wxid(self):
        db = FakeDB(contacts=[{'username': 'wxid_a', 'nick_name': 'A', 'remark': ''},
                              {'username': 'wxid_a', 'nick_name': 'A2', 'remark': ''}])
        self.assertEqual(len(cs.collect(db)), 1)

    def test_skips_rows_without_username(self):
        db = FakeDB(contacts=[{'username': '', 'nick_name': '空', 'remark': ''},
                              {'username': 'wxid_ok', 'nick_name': '好', 'remark': ''}])
        self.assertEqual([i['wxid'] for i in cs.collect(db)], ['wxid_ok'])

    def test_broken_db_returns_empty_instead_of_raising(self):
        db = FakeDB(broken=True)
        self.assertEqual(cs.collect(db), [])

    def test_groups_survive_when_contact_read_fails(self):
        class HalfBroken(FakeDB):
            def _contact_conn(self):
                raise RuntimeError('no key')
        db = HalfBroken(groups=[{'username': '9@chatroom', 'name': '群九'}])
        items = cs.collect(db)
        self.assertEqual([i['wxid'] for i in items], ['9@chatroom'], '联系人读不到时群仍要同步')

    def test_payload_carries_account_and_timestamp(self):
        db = FakeDB(contacts=[{'username': 'wxid_a', 'nick_name': 'A', 'remark': ''}])
        body = cs.payload(db, 1234)
        self.assertEqual(body['account'], 'wxid_self')
        self.assertEqual(body['at'], 1234)
        self.assertEqual(len(body['items']), 1)


if __name__ == '__main__':
    unittest.main()
