using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views;

public static class VoiceSendGuide
{
    public const string KeyUrl="https://breezeblue.ai/zh/app/developer/api-keys";
    public static Border Create(Action goToDriver)
    {
        var card=new Border{Padding=new Thickness(18),Margin=new Thickness(0,12,0,4)};
        card.SetResourceReference(FrameworkElement.StyleProperty,"Card");
        var layout=new StackPanel();card.Child=layout;
        var toggle=new Button{Content="首次使用 · 展开完整教程 ▾",HorizontalAlignment=HorizontalAlignment.Left};
        toggle.SetResourceReference(FrameworkElement.StyleProperty,"Ghost");layout.Children.Add(toggle);
        layout.Children.Add(Text("包内已附 VB-CABLE 安装程序，但打开软件不会自动安装。首次使用请按教程逐步设置。"));
        var body=new StackPanel{Visibility=Visibility.Collapsed};layout.Children.Add(body);
        toggle.Click+=(_,_)=>{
            bool open=body.Visibility!=Visibility.Visible;body.Visibility=open?Visibility.Visible:Visibility.Collapsed;
            toggle.Content=open?"首次使用 · 收起完整教程 ▴":"首次使用 · 展开完整教程 ▾";
        };

        Step("1. 安装 VB-CABLE 虚拟声卡",
            "先打开本页第一行的实验开关。运行包只附带驱动安装文件；解压、打开启动器和打开实验开关都不会替你安装 Windows 驱动。\n"+
            "点击本页底部「安装 VB-CABLE 官方驱动」，在 Windows 权限提示里允许操作，再按官方窗口中的 Install Driver 完成安装，按提示重启电脑。不要选择 Remove Driver。\n"+
            "如果 Windows 声音设备里已经有 CABLE Input 和 CABLE Output，可跳过安装。安装后看不到设备时，先重启，再点本页「刷新声卡」。\n"+
            "如果提示运行包缺少驱动，使用教程末尾的 VB-CABLE 官网链接下载并完整解压官方驱动包，再运行其中的 VBCABLE_Setup_x64.exe；不要只取出一个 exe，安装需要同目录的其他驱动文件。");
        ActionButton("前往本页的驱动安装按钮",goToDriver);

        Step("2. 在微信设置 Ctrl+Tab 发语音快捷键",
            "打开并登录电脑微信，在微信菜单中打开「设置」→「快捷键／快捷按键」，找到「发语音」，同时按下 Ctrl 和 Tab，保存为 Ctrl+Tab。不同微信版本的入口名称可能略有区别。\n"+
            "要改的是发送语音消息的快捷键，不是把说话识别成文字的「语音输入」。如果微信没有「发语音」或不接受该组合，先检查微信是否支持电脑端发语音；遇到按键冲突可另选组合。\n"+
            "回到本页，把「微信录音快捷键」也选成 Ctrl+Tab。两边必须完全一致；后续录音由程序自动按住和松开，无需你手动按键。");

        Step("3. 到 BreezeBlue 官网获取自己的 API Key",
            "点击下方官网入口，注册或登录 BreezeBlue；进入开发者控制台的 API Keys 页面，创建并复制自己的密钥。把它粘贴到本页「BreezeBlue Key」里，不要填到「语音（识别）」或普通聊天模型的 Key 栏。\n"+
            "填好 Key 后，页面已预选「中英双语版（默认，中文性能更好）」和「大肥鱼（机灵版）」，无需先读取列表。点击「测试 API Key 连接」确认连接与鉴权；15 秒没有完成会显示连接超时。失败时检查网络、密钥是否复制完整以及官网账户状态。合成语音还需要账户具备相应额度和权限。\n"+
            "Key 会在点击保存时加密保存在本机；已经保存后留空可沿用。不要把自己的密钥发到群里。");
        Link("打开 BreezeBlue 官方 API Keys 页面",KeyUrl);

        Step("4. 直接使用默认模型和音色",
            "新配置的「语音模型」默认是 Breeze TTS 2 中英双语版，旁边标注「默认，中文性能更好」；「回复音色」默认是大肥鱼（机灵版）。按这套默认配置继续即可，不需要下载本地语音模型，也不需要手动选择音色或填写 ID。\n"+
            "如果要生成其他语言，可在「语音模型」中改为多语言版。要换其他声音，再填写「搜索其他音色」，点击「读取模型和音色（不合成、不发送）」，从「回复音色」下拉框选择。刷新列表会保留当前选择，音色一次最多返回 100 个。\n"+
            "已有配置会保留你之前选择的模型与音色。只有需要手动填写官网提供的 ID 时，才展开「高级：手动填写模型 / 音色 ID」。\n"+
            "语气指令可以留空，也可填写例如「自然、轻松地说」。聊天模型负责生成回复正文，语音模型负责把同一段正文读出来。");

        Step("5. 把虚拟声卡接到微信麦克风",
            "在本页点击「刷新声卡」，把播放端选为 CABLE Input（VB-Audio Virtual Cable）。在微信能选择麦克风的音视频／设备设置中，把输入设备选为 CABLE Output。\n"+
            "如果微信只使用系统默认麦克风，请到 Windows「设置」→「系统」→「声音」→「输入」中选择 CABLE Output，然后退出并重新打开微信。更改系统默认输入也会影响其他使用默认麦克风的软件，用完可改回。\n"+
            "声音路线：本程序 → CABLE Input → 虚拟声卡 → CABLE Output → 微信麦克风。Input 和 Output 名字看似相反，按上面的两端分别选择即可。不要勾选「侦听此设备」来代替连接。");

        Step("6. 保存设置，启动内核和桥接",
            "先确认普通文字聊天能正常回复。填好 Key 并测试连接，保持预选的中英双语模型和大肥鱼（机灵版），核对两边快捷键一致、虚拟声卡已选好后，点击「保存语音配置」。\n"+
            "在启动器中启动内核与微信桥接，确认桥接绑定的是用于测试的微信账号。刚更新程序后，请退出重开启动器并重启桥接。Windows 若提示麦克风权限，请允许微信访问。\n"+
            "首次调试建议把随机概率设为 0%，先做文件传输助手测试，确认成功后再设置日常概率。");

        Step("7. 给文件传输助手发送测试语音",
            "点击「发送测试语音到文件传输助手」。按钮会先保存当前配置，使用所选模型和音色合成“哈喽哈喽，可以听见我说话么”，再通过桥接打开文件传输助手，自动录音并松开发送。\n"+
            "测试需要调用语音合成服务，会使用你的账户额度；不受随机概率或群聊／私聊勾选限制，但实验开关必须打开。测试进行中请留在本页等待，不要切换微信会话或连续重试。\n"+
            "到文件传输助手实际播放并确认声音。界面提示录音和发送操作完成，不代表已确认微信送达；如果提示结果未确认，先检查会话，避免重复发送。");

        Step("8. 设置日常自动语音回复",
            "勾选希望使用语音的「群聊」「私聊」，设置概率后保存。25% 表示每条完整回复抽一次，不是每四条必发一次；0% 不随机发，只响应明确的语音请求；100% 会尽量走语音，仍受范围与发送条件限制。\n"+
            "在允许的会话里说“发一条语音听听”，下一条正常回复会优先转成语音。程序自动完成文本转语音和微信发送，不需要一直停留在本页。\n"+
            "要停用时关闭第一行实验开关即可；会停止新的语音任务并请求取消未完成的任务，已发出的消息不会因此撤回。");

        Step("接口慢时的保护",
            "语音合成最长等待默认 20 秒，可在本页调为 5～90 秒。超时且尚未录音时会取消本次请求，改发原始文字。合成期间其他会话可以继续发文字，同一会话保持原有顺序。\n"+
            "连续两次接口失败或超时后暂停语音 5 分钟，期间要求语音也回退文字，随后自动再试；不会自动重试同一条付费请求。取消本地请求不代表服务端一定取消计费。\n"+
            "虚拟声卡需要播完整段音频，例如 15 秒语音还需约 15 秒录音。已经开始录音且发送结果不明时，不会补发文字，以免重复。");

        Step("常见问题 · 按顺序检查",
            "• 没有 CABLE 设备：确认驱动安装完成并重启电脑，再刷新声卡。\n"+
            "• Key 不可用／超时：检查网络和官方 Key 页面；连接测试不合成语音，也不能保证账户余额足够。\n"+
            "• 提示快捷键不一致：核对微信「发语音」与本页是否都为 Ctrl+Tab，保存后再试。\n"+
            "• 提示桥接未接收测试：先启动桥接；刚覆盖新版文件后重启桥接。\n"+
            "• 微信收到空白语音：先检查程序选 CABLE Input、微信选 CABLE Output，再检查输入音量、静音和麦克风权限。\n"+
            "• 结果未确认：先查看文件传输助手，不要自动重复点发送；保留界面提示，反馈时附微信版本和操作步骤。\n"+
            "• 只在部分会话不发：检查群聊／私聊范围、概率、实验开关和桥接绑定账号；先用固定的文件传输助手测试排除配置问题。");
        var sources=Text("官方资料：BreezeBlue · breezeblue.ai；VB-CABLE · vb-audio.com/Cable/。驱动为 VB-Audio Donationware，可向官方捐赠或购买许可。");
        body.Children.Add(sources);
        Link("打开 VB-CABLE 官方下载与安装说明","https://vb-audio.com/Cable/");
        return card;

        TextBlock Text(string value)
        {
            var text=new TextBlock{Text=value,TextWrapping=TextWrapping.Wrap,LineHeight=22,Margin=new Thickness(0,8,0,0)};
            text.SetResourceReference(FrameworkElement.StyleProperty,"Label");return text;
        }
        void Step(string title,string value)
        {
            var heading=new TextBlock{Text=title,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,20,0,0)};
            heading.SetResourceReference(FrameworkElement.StyleProperty,"H2");body.Children.Add(heading);body.Children.Add(Text(value));
        }
        void ActionButton(string label,Action action)
        {
            var button=new Button{Content=label,HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(0,10,0,0)};
            button.SetResourceReference(FrameworkElement.StyleProperty,"Ghost");
            var error=Text("");error.Visibility=Visibility.Collapsed;error.SetResourceReference(TextBlock.ForegroundProperty,"Bad");
            button.Click+=(_,_)=>{try{action();}catch(Exception){error.Text="无法打开入口，请按教程中的地址或步骤手动操作。";error.Visibility=Visibility.Visible;}};
            body.Children.Add(button);body.Children.Add(error);
        }
        void Link(string label,string url)=>ActionButton(label,()=>Process.Start(new ProcessStartInfo(url){UseShellExecute=true}));
    }
}
