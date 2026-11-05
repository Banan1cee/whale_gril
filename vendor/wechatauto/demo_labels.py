# -*- coding: utf-8 -*-
"""通讯录「标签」的演示与实测脚本。

五档，按破坏性从低到高::

    python -m wechatauto.demo_labels                              # 只读库：有哪些标签
    python -m wechatauto.demo_labels --level probe                # 只导航：报哪一步断
    python -m wechatauto.demo_labels --level create --label 演示标签
    python -m wechatauto.demo_labels --level add --label 演示标签 --who 送你挖银子
    python -m wechatauto.demo_labels --level remove --label 演示标签 --who 送你挖银子
    python -m wechatauto.demo_labels --level delete --label 演示标签

``read`` 档不碰窗口（读 contact.db 的 contact_label）。其余档**真的会动你的微信
界面**：走「通讯录 → 通讯录管理」那个**独立窗口**，全程过
:mod:`wechatauto.rhythm` 的拟人节流，每次点击前还校验落点归属（被别的窗口盖住就
直接报 ``occluded``，不会把点击投到你的浏览器上）。先确认没有别的机器人在跑同一个窗口。

``--level probe`` 会往 ``--dump`` 目录里写每一步的控件树，界面文案随版本漂移时
那是定位锚点的原始证据。
"""
from __future__ import annotations

import argparse
import os
import sys

from wechatauto.db import WeChatDB


def header(title):
    print("\n" + "=" * 68)
    print(title)
    print("=" * 68)


def read_labels(db):
    header("档 read：只读 contact.db:contact_label（不碰窗口）")
    rows = db.list_labels()
    if not rows:
        print("一个标签都没有（或这个微信版本没有这张表）")
        return
    for r in rows:
        print("  #%-3s %-16s sort=%s" % (r["label_id"], r["name"], r["sort_order"]))
    print("共 %d 个标签" % len(rows))


def main():
    ap = argparse.ArgumentParser(description="通讯录标签演示/实测")
    ap.add_argument("--level", default="read",
                    choices=["read", "probe", "create", "add", "remove", "delete"])
    ap.add_argument("--label", default="演示标签", help="标签名")
    ap.add_argument("--who", action="append", default=[],
                    help="好友显示名或 wxid，可重复给多个")
    ap.add_argument("--dump", default=os.path.join(os.getcwd(), "label_probe"),
                    help="probe 档写控件树快照的目录")
    args = ap.parse_args()

    db = WeChatDB()
    if args.level == "read":
        read_labels(db)
        return 0

    from wechatauto.wx import WeChat          # 要动界面才 import
    wx = WeChat()

    if args.level == "probe":
        header("档 probe：走「通讯录 → 通讯录管理」，只导航不写")
        r = wx.ProbeLabels(dump_dir=args.dump)
    elif args.level == "create":
        header("档 create：新建标签「%s」" % args.label)
        r = wx.CreateLabel(args.label)
    elif args.level == "delete":
        header("档 delete：删除标签「%s」（只去标签，不删好友）" % args.label)
        r = wx.DeleteLabel(args.label)
    else:
        if not args.who:
            print("add/remove 要 --who（可重复）")
            return 2
        header("档 %s：标签「%s」%s 成员 %s" % (
            args.level, args.label, "添加" if args.level == "add" else "移出",
            "、".join(args.who)))
        r = (wx.AddLabelMembers(args.label, args.who)
             if args.level == "add" else
             wx.RemoveLabelMembers(args.label, args.who))

    print("[%s] %s" % (r["status"], r.get("message")))
    data = r.get("data") or {}
    for s in data.get("steps") or []:
        print("  %-18s %s  %s" % (s.get("step"),
                                  "OK" if s.get("ok") else "断", s.get("reason")))
    if args.level == "probe":
        print("控件树快照：%s" % os.path.abspath(args.dump))
    if args.level in ("create", "add", "remove", "delete"):
        print("回读 contact_label：", "、".join(db.label_names()) or "（空）")
        print("（注意：contact_label 滞后于界面，删除后这里可能仍看得到——"
              "以界面上那行为准）")
    return 0 if r["status"] == "成功" else 1


if __name__ == "__main__":
    sys.exit(main())
