from typing import Literal
import os

PROJECT_NAME = 'wechatauto'

class WxParam:
    # 语言设置
    LANGUAGE: Literal['cn', 'cn_t', 'en'] = 'cn'

    # 是否启用日志文件
    ENABLE_FILE_LOGGER: bool = True

    # 下载文件/图片默认保存路径
    DEFAULT_SAVE_PATH: str = os.path.join(os.getcwd(), 'wechatauto文件下载')

    # 是否启用消息哈希值用于辅助判断消息，开启后会稍微影响性能
    MESSAGE_HASH: bool = False

    # 头像到消息X偏移量，用于消息定位，点击消息等操作
    DEFAULT_MESSAGE_XBIAS = 51
    DEFAULT_MESSAGE_YBIAS = 30

    # 是否强制重新自动获取X偏移量，如果设置为True，则每次启动都会重新获取
    FORCE_MESSAGE_XBIAS: bool = False

    # 监听消息时间间隔，单位秒
    LISTEN_INTERVAL: int = 1

    # 发送后回读数据库确认「这条真落库了」的轮询间隔与等待上限，单位秒。
    # 微信写库是异步的（还要 checkpoint/WAL 合并），一次读不到不等于没发出去，
    # 所以这里本来就是「先读一次，没有就隔 DB_VERIFY_INTERVAL 再读，最多读到
    # DB_VERIFY_TIMEOUT」。默认值就是这套逻辑一开始写死的 1 秒 / 8 秒。
    # 调大的场景：机器慢、群多、库里消息多，解密+查询本身要几百毫秒到几秒；
    # 调小的场景：批量发送想要快反馈（注意每读一次都是一次真解密，别调到 0 附近）。
    # 上限到 0 表示「只读一次就判」，与老的 verify=False 之外的最省行为一致。
    DB_VERIFY_INTERVAL: float = 1.0
    DB_VERIFY_TIMEOUT: float = 8.0

    # 监听执行器线程池大小
    LISTENER_EXCUTOR_WORKERS: int = 4

    # 搜索聊天对象超时时间，单位秒
    SEARCH_CHAT_TIMEOUT: int = 2

    # 微信笔记加载超时时间，单位秒
    NOTE_LOAD_TIMEOUT: int = 30

    # 发送文件超时时间，单位秒
    SEND_FILE_TIMEOUT: int = 10

    # 粘贴后回读输入框内容，相似度达到该值才按回车；<=0 表示关闭本校验。
    # 需要它是因为 Ctrl+V 有可能整个落空（微信不在前台、焦点没落到输入框上），
    # 这时按键照样打下去，发出去的是空消息或上一轮的残留内容。
    # 阈值取 0.6 而不是更高：读回空时相似度是 0.0、残留内容实测 0.11，都拦得住；
    # 而中文短消息只差一个字就只有 0.875（「今天下午三点开会」vs「今天下午三点开雾」），
    # 阈值定 0.9 会把这类正常消息连同表情码消息一起拦死。行内表情码 [微笑] 在比对前
    # 会折算成输入框里实际的 U+FFFC 占位符，折算后是 1.0。
    SEND_CONTENT_RATIO: float = 0.6

    # 是否允许使用 OCR（Windows 自带 WinRT 识别）作为定位/判据手段。
    # 默认开。关掉后所有 OCR 调用一律返回空结果，相关功能改走 UIA 控件树；
    # 没有 UIA 等价物的地方会**明确失败而不是盲猜坐标**，例如：
    #   侧栏会话查找 / 搜索下拉点选 / 「发送」按钮兜底 / 朋友圈元素 / 转发菜单。
    # 影响面：发送主路径（UIA）不受影响；像素探针类判断（输入框定位、
    # 面板非空白、高亮行检测）不依赖 OCR，仍然可用。
    ENABLE_OCR: bool = True

class WxResponse(dict):
    def __init__(self, status: str, message: str, data: dict = None):
        super().__init__(status=status, message=message, data=data)

    def __str__(self):
        return str(self.to_dict())

    def __repr__(self):
        return str(self.to_dict())

    def to_dict(self):
        return {
            'status': self['status'],
            'message': self['message'],
            'data': self['data']
        }

    def __bool__(self):
        return self.is_success

    @property
    def is_success(self):
        return self['status'] == '成功'

    @classmethod
    def success(cls, message=None, data: dict = None):
        return cls(status="成功", message=message, data=data)

    @classmethod
    def failure(cls, message: str, data: dict = None):
        return cls(status="失败", message=message, data=data)

    @classmethod
    def error(cls, message: str, data: dict = None):
        return cls(status="错误", message=message, data=data)
