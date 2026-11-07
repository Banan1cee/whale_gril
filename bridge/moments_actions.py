"""朋友圈手动交互适配：复用库 API，限制搜索范围，不重试发送。"""


def perform(moment, action, query):
    if action not in ('like', 'unlike', 'comment', 'reply'):
        raise ValueError('unsupported action')
    publisher, keyword = query.get('publisher'), query.get('keyword')
    if not publisher or not keyword or moment is None:
        return False
    if action in ('comment', 'reply') and not query.get('content'):
        return False
    if action == 'reply' and not query.get('replyTo'):
        return False
    item = moment.find_moment(publisher=publisher, keyword=keyword, max_screens=5)
    if item is None:
        return False
    item._ensure_parsed()
    # 库的搜索允许模糊匹配，写操作必须再核对发布者和正文，避免命中相似昵称。
    if item.nickname.strip() != publisher.strip() or keyword not in item.content:
        return False
    if action in ('like', 'unlike'):
        return bool(moment.Like(item, cancel=action == 'unlike', max_retry=1))
    if action == 'comment':
        return bool(moment.Comment(item, query['content'], max_retry=1))
    return bool(moment.ReplyComment(item, reply_to=query['replyTo'], content=query['content']))
