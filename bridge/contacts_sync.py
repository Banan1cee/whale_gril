"""联系人清单同步（桥接侧）。

wxid 只有微信自己的库里读得到，所以由桥接把「联系人 + 群」的精简清单推给服务端，
启动器再用它做白名单 / 黑名单的选择器。

这里只做两件事：从 DB 取数（容错）、按协议整理成 [{wxid,name,remark,isGroup}]。
推送由 engine 调用服务端的 /api/wechat/contacts/sync 完成。
"""
MAX_CONTACTS = 5000


def _clean(value, limit=120):
    text = str(value if value is not None else "").replace("\x00", " ").strip()
    return text[:limit]


def normalize_item(username, name="", remark="", is_group=False):
    wxid = _clean(username, 120)
    if not wxid:
        return None
    group = bool(is_group) or wxid.endswith("@chatroom")
    nickname = _clean(name, 80) or wxid
    note = _clean(remark, 80)
    return {"wxid": wxid, "name": nickname, "remark": note, "isGroup": group}


def collect(db, limit=MAX_CONTACTS):
    """从 WeChatDB 取私聊联系人 + 群；任何一步失败都只是少一部分，不抛。"""
    items = []
    seen = set()

    def push(item):
        if item and item["wxid"] not in seen and len(items) < limit:
            seen.add(item["wxid"])
            items.append(item)

    # 群先收：群只有几十个，而且黑名单/白名单都要用；先收群不会被几千个联系人挤掉
    try:
        for group in db.get_groups() or []:
            push(normalize_item(group.get("username"), group.get("name"), "", True))
    except Exception:
        pass

    # 私聊联系人：优先直连 contact.db（能拿全量），失败再退回 search_contact 的模糊查询
    rows = []
    try:
        conn = db._contact_conn()          # 私有方法，但这是库内唯一的全量入口
        if conn:
            try:
                rows = conn.execute(
                    "SELECT username, nick_name, remark FROM contact LIMIT ?", (limit,)
                ).fetchall()
            finally:
                conn.close()
    except Exception:
        rows = []
    if not rows:
        try:
            rows = db.search_contact("")   # LIKE '%%'，最多 50 条，聊胜于无
        except Exception:
            rows = []
    for row in rows:
        try:
            push(normalize_item(row["username"], row["nick_name"], row["remark"]))
        except Exception:
            continue

    return items


def payload(db, at_ms, limit=MAX_CONTACTS):
    """给 POST /api/wechat/contacts/sync 的请求体。"""
    account = ""
    try:
        account = _clean(getattr(db, "wxid", "") or "", 120)
    except Exception:
        account = ""
    return {"account": account, "at": int(at_ms), "items": collect(db, limit)}
