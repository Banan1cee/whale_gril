using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    /// <summary>还没填内容的页：只保证导航、标题、占位说明是对的。</summary>
    public partial class PlaceholderPage : UserControl
    {
        public PlaceholderPage(string title, string hint)
        {
            InitializeComponent();
            TitleText.Text = title;
            HintText.Text = hint;
        }

        public static string HintFor(string key) => key switch
        {
            "人设" => "这里放：身份（名字 / 别名 / 她怎么叫你 / 主人名单）、说话方式（字数 / 气泡数 / 颜文字档位，滑块旁实时示例）、群聊（必须@ / 自由聊天几率 / 冷却 / 每小时上限）、情绪时间、主动（总开关 + 只找主人 / 允许进群 / 找非主人 + 时间窗 / 间隔 / 每日上限）、预设导入导出、11 项实验开关。字段失焦即存，右下角浮出「已保存」。",
            "记忆" => "这里放：会话 / 消息 / 笔记三个数字、左会话列表右详情、单条笔记删除（5 秒可撤销）、立即备份 / 从备份恢复（先列出将覆盖哪些会话）、导出 zip、自动快照开关与占用、以及清空某会话 / 清空全部的危险区。",
            "表情包" => "这里放：总开关（默认关）、傲娇 / 炸毛 / 其他三个分类、虚拟化图片网格、拖拽上传（提权后要放行 WM_DROPFILES）、单图预览 / 删除 / 设为首选、发送测试的三种结果、以及底部待发送队列。",
            "诊断" => "这里放：7 项自检（node / python / 依赖 / 权限同级 / UIA / Key / 端口）、内核日志（和桥接控制台分开放）、日志级别与搜索、一键诊断包、路径与占用、运行时版本与 manifest 校验、最近 10 次发送的通道统计。",
            "设置" => "这里放：模型（供应商 / Key / 模型 / 测试连通）、视觉 GLM-4V、语音、联网、网关 webhook 与 token、分享、高级（日志级别 / 开机自启走计划任务 / 打开网页控制台逃生入口）、关于与卸载。",
            _ => "这一页的内容还没填。"
        };
    }
}
