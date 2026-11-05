# -*- coding: utf-8 -*-
"""wechatauto 复刻版使用示例

使用前请确认：
1. 已登录微信 4.x 客户端
2. 微信窗口在任务栏（未被完全最小化/隐藏）
3. 已安装依赖：pip install -e .
"""

from wechatauto import WeChat, WxParam, WxResponse


def demo_basic():
    # 初始化，连接到已登录的微信主窗口
    wx = WeChat(debug=True)

    # 当前登录昵称
    print(f"当前登录：{wx.nickname}")

    # 获取会话列表
    sessions = wx.GetSession()
    for session in sessions[:5]:
        print(f"会话：{session.name}，未读：{session.unread_count}")

    # 打开与好友的聊天窗口
    who = "文件传输助手"
    wx.ChatWith(who)

    # 发送文本消息
    result = wx.SendMsg("你好，世界！", who)
    print(f"发送结果：{result}")

    # 发送文件
    # wx.SendFiles(r"C:\path\to\file.txt", who)

    # 获取当前聊天窗口的所有消息
    messages = wx.GetAllMessage()
    for msg in messages:
        print(f"[{msg.attr}] {msg.content}")

    # 获取聊天窗口信息（群聊成员数、聊天类型等）
    info = wx.ChatInfo()
    print(f"聊天信息：{info}")


def demo_listener():
    """消息监听示例：收到新消息后自动回复"""
    wx = WeChat()

    def callback(msg, chat):
        print(f"收到消息：{chat.who} - {msg.content}")
        # 简单自动回复
        if msg.is_friend:
            chat.SendMsg(f"收到你的消息：{msg.content}")

    # 添加监听聊天（会将聊天窗口独立出去）
    wx.AddListenChat("文件传输助手", callback=callback)

    print("开始监听，按 Ctrl+C 退出")
    wx.KeepRunning()


def demo_moments():
    """朋友圈示例（只读，发布功能已舍弃）"""
    wx = WeChat()

    # 获取朋友圈动态
    moments = wx.Moment.GetMoments()
    for item in moments[:3]:
        print(f"{item.publisher}: {item.text}")


if __name__ == "__main__":
    demo_basic()
    # demo_listener()
    # demo_moments()
