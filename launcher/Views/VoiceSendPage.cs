using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using NAudio.CoreAudioApi;

namespace WhaleLauncher.Views;

public sealed class VoiceSendPage : UserControl
{
    readonly CheckBox experimental=new(){Content="启用语音发送（实验性）",IsChecked=false,Margin=new Thickness(0,12,0,10)};
    readonly StackPanel panel=new(){Visibility=Visibility.Collapsed};
    readonly TextBox probability=new(){Text="25"},model=new(),voice=new(),instructions=new(),search=new();
    readonly ComboBox shortcut=new(){IsEditable=true,Text="Ctrl+Alt"},devices=new(),models=new(),voices=new();
    readonly PasswordBox key=new();
    readonly CheckBox groups=new(){Content="群聊",IsChecked=true},privates=new(){Content="私聊",IsChecked=true};
    readonly TextBlock status=new(){TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,14,0,0)};
    readonly TextBlock keyStatus=new(){TextWrapping=TextWrapping.Wrap,Visibility=Visibility.Collapsed},testStatus=new(){TextWrapping=TextWrapping.Wrap,Visibility=Visibility.Collapsed};
    readonly string root,file,keyFile;
    AutoVoiceSettings saved=new();
    CancellationTokenSource requests=new();
    bool loading;
    bool testing;
    sealed record Device(string Id,string Name){public override string ToString()=>Name;}

    public VoiceSendPage(RuntimeSupervisor sup)
    {
        root=sup.BaseDir;file=Path.Combine(root,"data","voice-send.json");keyFile=Path.Combine(root,"data","voice-send-breeze.key");
        SetResourceReference(ForegroundProperty,"Text");
        UseLayoutRounding=true;
        var body=new StackPanel{Margin=new Thickness(28,24,32,24),MaxWidth=760,HorizontalAlignment=HorizontalAlignment.Stretch};
        Content=new ScrollViewer{Content=body,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled};
        var title=new TextBlock{Text="语音发送",Margin=new Thickness(0,0,0,6)};
        title.SetResourceReference(StyleProperty,"H1");body.Children.Add(title);
        experimental.SetResourceReference(StyleProperty,"DarkCheck");
        body.Children.Add(experimental);body.Children.Add(panel);
        panel.Children.Add(Note("将正常回复转成语音，按概率发送，或响应对方的语音请求。关闭实验开关即可停用。"));
        Heading("回复方式");
        Add("随机语音概率（0～100%，0 表示只响应明确要求）",probability);
        probability.Width=140;probability.HorizontalAlignment=HorizontalAlignment.Left;
        var scopes=new WrapPanel{Margin=new Thickness(0,12,0,2)};
        groups.Margin=new Thickness(0,0,24,0);scopes.Children.Add(groups);scopes.Children.Add(privates);panel.Children.Add(scopes);
        shortcut.ItemsSource=new[]{"Ctrl+Alt","Alt+=","Ctrl+Shift+F11","F11"};
        Add("微信录音快捷键（可直接输入自定义组合，须与微信设置一致）",shortcut);
        panel.Children.Add(Note("支持 Ctrl、Alt、Shift 搭配字母、数字、F1～F24 或 =。录音和松开按键由程序完成。"));
        Heading("模型与音色");
        Add("BreezeBlue Key（留空沿用已保存的 Key）",key);
        Button("测试 API Key 连接",async token=>{
            ShowResult(keyStatus,"正在测试 API Key（最多 15 秒）…","Accent");
            var result=await BreezeSpeech.CheckKey(string.IsNullOrWhiteSpace(key.Password)?BreezeSpeech.LoadKey(keyFile):key.Password,token);
            token.ThrowIfCancellationRequested();ShowResult(keyStatus,result.Message,result.Available?"Ok":"Bad");
        },keyStatus);
        panel.Children.Add(keyStatus);
        Add("模型 ID",model);Add("音色 ID",voice);Add("语气指令",instructions);Add("搜索音色",search);
        Button("读取模型和音色（不合成、不发送）",async token=>{
            string secret=string.IsNullOrWhiteSpace(key.Password)?BreezeSpeech.LoadKey(keyFile):key.Password;
            var modelOptions=await BreezeSpeech.Catalog(secret,false,"",token);
            var voiceOptions=await BreezeSpeech.Catalog(secret,true,search.Text.Trim(),token);
            token.ThrowIfCancellationRequested();models.ItemsSource=modelOptions;voices.ItemsSource=voiceOptions;
            status.Text="已读取；音色最多显示100个，可搜索或直接填写 ID";
        });
        Add("可用模型",models);Add("可用音色",voices);
        models.SelectionChanged+=(_,_)=>{if(models.SelectedItem is BreezeSpeech.Choice c)model.Text=c.Id;};
        voices.SelectionChanged+=(_,_)=>{if(voices.SelectedItem is BreezeSpeech.Choice c)voice.Text=c.Id;};
        Heading("声卡与测试");
        Add("虚拟声卡播放端（例如 CABLE Input）",devices);
        Button("刷新声卡",_=>{RefreshDevices();return Task.CompletedTask;});
        panel.Children.Add(Note("微信麦克风选择 CABLE Output。录音期间请保持目标微信会话，切换会话会中止。"));
        Button("保存语音配置",_=>{Save();return Task.CompletedTask;});
        panel.Children.Add(Note("测试会保存当前配置，并给文件传输助手发送：“"+VoiceSendTest.Text+"”。"));
        Button("发送测试语音到文件传输助手",async token=>{
            if(testing){testStatus.Text="测试正在进行，请等待结果";return;}
            testing=true;
            try
            {
                Save();ShowResult(testStatus,"正在给文件传输助手发送测试语音…","Accent");
                string message=await VoiceSendTest.Run(root,token);
                ShowResult(testStatus,message,message.StartsWith("测试发送失败")?"Bad":"Warn");
            }
            finally{testing=false;}
        },testStatus);
        panel.Children.Add(testStatus);
        Heading("虚拟声卡驱动");
        Button("安装 VB-CABLE 官方驱动",_=>{
            string exe=Path.Combine(root,"runtime","vb-cable","VBCABLE_Setup_x64.exe");
            if(!File.Exists(exe))throw new Exception("运行包缺少驱动，请从 https://vb-audio.com/Cable/ 安装");
            Process.Start(new ProcessStartInfo(exe){UseShellExecute=true,Verb="runas"});
            status.Text="完成官方安装并按提示重启后刷新声卡。VB-CABLE 为 VB-Audio Donationware，可向官方捐赠。";
            return Task.CompletedTask;
        });
        panel.Children.Add(Note("VB-CABLE · vb-audio.com/Cable/ · Donationware，可向官方捐赠或购买许可。"));
        panel.Children.Add(status);
        foreach(var result in new[]{keyStatus,testStatus,status})
        {
            result.SetResourceReference(StyleProperty,"Label");
            result.Margin=new Thickness(0,6,0,4);
            result.SetResourceReference(ForegroundProperty,"Muted");
        }
        Load();experimental.Checked+=Toggle;experimental.Unchecked+=Toggle;
        Unloaded+=(_,_)=>requests.Cancel();
        Loaded+=(_,_)=>{if(requests.IsCancellationRequested){requests.Dispose();requests=new();}};

        TextBlock Note(string text)
        {
            var note=new TextBlock{Text=text,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,6,0,6),LineHeight=20};
            note.SetResourceReference(StyleProperty,"Label");return note;
        }
        void Heading(string text)
        {
            var heading=new TextBlock{Text=text,Margin=new Thickness(0,24,0,4)};
            heading.SetResourceReference(StyleProperty,"H2");panel.Children.Add(heading);
        }
        void Add(string label,Control control)
        {
            var caption=new TextBlock{Text=label,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,12,0,6)};
            caption.SetResourceReference(StyleProperty,"Label");panel.Children.Add(caption);
            // Explicitly retain the application's input styles for code-built controls.
            control.SetResourceReference(StyleProperty,control.GetType());
            panel.Children.Add(control);
        }
        void Button(string label,Func<CancellationToken,Task> action,TextBlock feedback=null)
        {
            var button=new Button{Content=label,Margin=new Thickness(0,10,0,2),HorizontalAlignment=HorizontalAlignment.Left,MinHeight=34};
            button.SetResourceReference(StyleProperty,"Ghost");
            button.Click+=async(_,_)=>{
                if(experimental.IsChecked!=true)return;
                button.IsEnabled=false;
                var output=feedback??status;
                try{await action(requests.Token);}catch(OperationCanceledException){ShowResult(output,"实验功能已关闭或页面已离开，操作取消","Muted");}catch(Exception ex){ShowResult(output,ex.Message,"Bad");}
                finally{button.IsEnabled=true;}
            };
            panel.Children.Add(button);
        }
    }

    static void ShowResult(TextBlock target,string text,string tone)
    {
        target.Text=text;target.Visibility=Visibility.Visible;target.SetResourceReference(TextBlock.ForegroundProperty,tone);
    }

    void Toggle(object sender,RoutedEventArgs args)
    {
        if(loading)return;
        bool on=experimental.IsChecked==true;
        try
        {
            var current=File.Exists(file)?AutoVoiceSettings.Load(root):new AutoVoiceSettings();
            current.Enabled=on;Write(current);saved=current;
            if(!on){requests.Cancel();key.Clear();panel.Visibility=Visibility.Collapsed;AutoVoiceSettings.CancelJobs(root);}
            else
            {
                if(requests.IsCancellationRequested){requests.Dispose();requests=new();}
                panel.Visibility=Visibility.Visible;RefreshDevices();
                devices.SelectedItem=devices.Items.Cast<Device>().FirstOrDefault(d=>d.Id==saved.Device);
                status.Text="实验功能已打开。请配置声卡、模型和音色后保存；快捷键要和微信一致。";
            }
        }
        catch(Exception ex)
        {
            loading=true;experimental.IsChecked=saved.Enabled;loading=false;
            panel.Visibility=saved.Enabled?Visibility.Visible:Visibility.Collapsed;
            MessageBox.Show("实验开关未保存："+ex.Message,"语音发送");
        }
    }
    void Write(AutoVoiceSettings settings)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(file+".tmp",JsonSerializer.Serialize(settings));File.Move(file+".tmp",file,true);
    }
    void RefreshDevices()
    {
        if(experimental.IsChecked!=true)return;
        var selected=(devices.SelectedItem as Device)?.Id;
        using var e=new MMDeviceEnumerator();
        devices.ItemsSource=e.EnumerateAudioEndPoints(DataFlow.Render,DeviceState.Active).Select(d=>{var item=new Device(d.ID,d.FriendlyName);d.Dispose();return item;}).ToArray();
        devices.SelectedItem=devices.Items.Cast<Device>().FirstOrDefault(d=>d.Id==selected);
    }
    void Load()
    {
        loading=true;
        try
        {
            saved=File.Exists(file)?AutoVoiceSettings.Load(root):new AutoVoiceSettings();
            experimental.IsChecked=saved.Enabled;panel.Visibility=saved.Enabled?Visibility.Visible:Visibility.Collapsed;
            groups.IsChecked=saved.Groups;privates.IsChecked=saved.Private;probability.Text=saved.Probability.ToString(CultureInfo.InvariantCulture);
            model.Text=saved.Model;voice.Text=saved.Voice;instructions.Text=saved.Instructions;shortcut.Text=saved.RecordingHotkey;
            if(saved.Enabled){RefreshDevices();devices.SelectedItem=devices.Items.Cast<Device>().FirstOrDefault(d=>d.Id==saved.Device);}
        }
        catch{saved=new();experimental.IsChecked=false;panel.Visibility=Visibility.Collapsed;}
        finally{loading=false;}
    }
    void Save()
    {
        if(experimental.IsChecked!=true)throw new Exception("请先打开实验开关");
        if(!double.TryParse(probability.Text,NumberStyles.Float,CultureInfo.InvariantCulture,out var chance)||!double.IsFinite(chance)||chance<0||chance>100)throw new Exception("概率须为 0～100");
        var hotkey=RecordingShortcut.Parse(shortcut.Text);
        if(devices.SelectedItem is not Device d||string.IsNullOrWhiteSpace(voice.Text))throw new Exception("请选择虚拟声卡和音色");
        BreezeSpeech.SaveKey(keyFile,key.Password);if(string.IsNullOrWhiteSpace(BreezeSpeech.LoadKey(keyFile)))throw new Exception("请配置 BreezeBlue Key");
        var value=new AutoVoiceSettings{Enabled=true,Probability=chance,Groups=groups.IsChecked==true,Private=privates.IsChecked==true,Model=model.Text.Trim(),Voice=voice.Text.Trim(),Instructions=instructions.Text.Trim(),Device=d.Id,RecordingHotkey=hotkey.Label};
        Write(value);saved=value;shortcut.Text=hotkey.Label;
        status.Text="已保存，微信录音快捷键："+hotkey.Label+"。关闭实验开关立即停止后续语音任务。";
    }
}
