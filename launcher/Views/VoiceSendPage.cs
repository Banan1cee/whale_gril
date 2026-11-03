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
    readonly CheckBox experimental=new(){Content="启用语音发送（实验性）",IsChecked=false};
    readonly StackPanel panel=new(){Visibility=Visibility.Collapsed};
    readonly TextBox probability=new(){Text="25"},model=new(),voice=new(),instructions=new(),search=new();
    readonly TextBox synthTimeout=new(){Text="20",Width=140,HorizontalAlignment=HorizontalAlignment.Left};
    readonly ComboBox shortcut=new(){IsEditable=true,Text="Ctrl+Alt"},devices=new(),models=new(),voices=new();
    readonly PasswordBox key=new();
    readonly CheckBox groups=new(){Content="群聊",IsChecked=true},privates=new(){Content="私聊",IsChecked=true};
    readonly TextBlock status=new(){TextWrapping=TextWrapping.Wrap};
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

        // 和其它页同一套骨架：固定页头（H1 + 右侧按钮）+ 整页一个滚动条
        var page=new Grid{Margin=new Thickness(28,24,32,20)};
        page.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});
        page.RowDefinitions.Add(new RowDefinition{Height=new GridLength(1,GridUnitType.Star)});

        var header=new DockPanel{LastChildFill=false,Margin=new Thickness(0,0,0,10)};
        var title=new TextBlock{Text="语音发送",VerticalAlignment=VerticalAlignment.Center};
        title.SetResourceReference(StyleProperty,"H1");
        DockPanel.SetDock(title,Dock.Left);header.Children.Add(title);
        var actions=new StackPanel{Orientation=Orientation.Horizontal};
        DockPanel.SetDock(actions,Dock.Right);header.Children.Add(actions);
        var reload=new Button{Content="⟳ 刷新"};
        reload.SetResourceReference(StyleProperty,"Ghost");
        reload.Click+=(_,_)=>{Load();status.Text="已重新读取本机配置。";};
        actions.Children.Add(reload);
        Grid.SetRow(header,0);page.Children.Add(header);

        var scroll=new ScrollViewer{VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled,FocusVisualStyle=null};
        Grid.SetRow(scroll,1);page.Children.Add(scroll);
        var body=new StackPanel{Margin=new Thickness(0,0,8,0)};
        scroll.Content=body;
        Content=page;

        Panel current=panel;
        Button driverButton=null;

        // 页头下面先开关：和「表情包」「主动与提醒」一致。body 结构固定为 [开关卡, 设置区]，测试按这个找。
        var gate=new Border{Padding=new Thickness(16,12,16,12),Margin=new Thickness(0,0,0,12)};
        gate.SetResourceReference(StyleProperty,"Card");
        var gateBody=new StackPanel();gate.Child=gateBody;
        experimental.SetResourceReference(StyleProperty,"DarkCheck");
        gateBody.Children.Add(experimental);
        gateBody.Children.Add(Note("把正常回复转成语音：按概率自动发，或者响应对方明确要的语音。关掉开关会立刻停止新的语音任务，已经发出去的消息不会撤回。"));
        body.Children.Add(gate);
        body.Children.Add(panel);

        panel.Children.Add(VoiceSendGuide.Create(()=>driverButton?.BringIntoView()));
        Card("回复方式","每条完整回复抽一次，不是「每四条必发一次」；0% 不随机发，只响应明确的语音要求。");
        var pair=new Grid{Margin=new Thickness(0,8,0,0)};
        pair.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(150)});
        pair.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        probability.Width=100;probability.HorizontalAlignment=HorizontalAlignment.Left;
        var chance=Field("随机概率（0～100%）",probability);pair.Children.Add(chance);
        shortcut.ItemsSource=new[]{"Ctrl+Tab","Ctrl+Alt","Alt+=","Ctrl+Shift+F11","F11"};
        shortcut.Width=220;shortcut.HorizontalAlignment=HorizontalAlignment.Left;
        var hotkey=Field("微信录音快捷键",shortcut);Grid.SetColumn(hotkey,1);hotkey.Margin=new Thickness(12,8,0,0);pair.Children.Add(hotkey);
        current.Children.Add(pair);
        Add("语音合成最长等待（5～90 秒，推荐 20 秒）",synthTimeout);
        current.Children.Add(Note("合成超时会取消本次请求并改发原始文字；连续两次接口异常后暂停语音 5 分钟，再自动尝试。合成期间其他会话仍可发文字。已经开始录音的消息不会重复补发文字。"));
        var scopes=new WrapPanel{Margin=new Thickness(0,4,0,0)};
        groups.Margin=new Thickness(0,0,24,0);scopes.Children.Add(groups);scopes.Children.Add(privates);current.Children.Add(scopes);
        current.Children.Add(Note("快捷键须和微信「发语音」完全一致，教程用的是 Ctrl+Tab；录音和松手由程序完成。"));

        Card("模型与音色","已预选中英双语版和大肥鱼（机灵版）。填好 Key 就能测试连接、保存，不必先读取列表或手选音色。");
        Add("BreezeBlue Key（留空沿用已保存的 Key）",key);
        var keyRow=new WrapPanel{Margin=new Thickness(0,10,0,0)};
        keyRow.Children.Add(Button("测试 API Key 连接",async token=>{
            ShowResult(keyStatus,"正在测试 API Key（最多 15 秒）…","Accent");
            var result=await BreezeSpeech.CheckKey(string.IsNullOrWhiteSpace(key.Password)?BreezeSpeech.LoadKey(keyFile):key.Password,token);
            token.ThrowIfCancellationRequested();ShowResult(keyStatus,result.Message,result.Available?"Ok":"Bad");
        },keyStatus,flat:true));
        current.Children.Add(keyRow);
        current.Children.Add(keyStatus);
        var voicesGrid=new Grid{Margin=new Thickness(0,8,0,0)};
        voicesGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        voicesGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        var modelBox=Field("语音模型",models);modelBox.Margin=new Thickness(0,0,12,0);voicesGrid.Children.Add(modelBox);
        var voiceBox=Field("回复音色",voices);Grid.SetColumn(voiceBox,1);voicesGrid.Children.Add(voiceBox);
        current.Children.Add(voicesGrid);
        Add("语气指令（可选）",instructions);
        var searchRow=new Grid{Margin=new Thickness(0,8,0,0)};
        searchRow.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        searchRow.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
        var searchBox=Field("搜索其他音色（可选）",search);searchBox.Margin=new Thickness(0,0,12,0);searchRow.Children.Add(searchBox);
        var read=Button("读取模型和音色",async token=>{
            string secret=string.IsNullOrWhiteSpace(key.Password)?BreezeSpeech.LoadKey(keyFile):key.Password;
            var modelOptions=await BreezeSpeech.Catalog(secret,false,"",token);
            var voiceOptions=await BreezeSpeech.Catalog(secret,true,search.Text.Trim(),token);
            token.ThrowIfCancellationRequested();BindChoices(models,modelOptions,model,false);BindChoices(voices,voiceOptions,voice,true);
            status.Text="已读取，保留当前选择。音色一次最多返回100个，可搜索其他音色。";
        },null,flat:true);
        read.VerticalAlignment=VerticalAlignment.Bottom;Grid.SetColumn(read,1);searchRow.Children.Add(read);
        current.Children.Add(searchRow);
        models.SelectionChanged+=(_,_)=>{if(models.SelectedItem is BreezeSpeech.Choice c)model.Text=c.Id;};
        voices.SelectionChanged+=(_,_)=>{if(voices.SelectedItem is BreezeSpeech.Choice c)voice.Text=c.Id;};
        model.LostKeyboardFocus+=(_,_)=>BindChoices(models,models.Items.Cast<BreezeSpeech.Choice>().ToArray(),model,false);
        voice.LostKeyboardFocus+=(_,_)=>BindChoices(voices,voices.Items.Cast<BreezeSpeech.Choice>().ToArray(),voice,true);
        var advanced=new StackPanel{Visibility=Visibility.Collapsed,Margin=new Thickness(0,4,0,0)};
        current.Children.Add(advanced);
        current.Children.Add(Button("高级：手动填写模型 / 音色 ID",_=>{advanced.Visibility=advanced.Visibility==Visibility.Visible?Visibility.Collapsed:Visibility.Visible;return Task.CompletedTask;},null,flat:true));
        AddTo(advanced,"模型 ID",model);AddTo(advanced,"音色 ID",voice);

        Card("声卡与测试","微信麦克风选 CABLE Output，本页播放端选 CABLE Input。录音期间请保持目标微信会话，切换会话会中止。");
        var deviceRow=new Grid{Margin=new Thickness(0,8,0,0)};
        deviceRow.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        deviceRow.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
        var deviceBox=Field("虚拟声卡播放端（例如 CABLE Input）",devices);deviceBox.Margin=new Thickness(0,0,12,0);deviceRow.Children.Add(deviceBox);
        var refresh=Button("刷新声卡",_=>{RefreshDevices();return Task.CompletedTask;},null,flat:true);
        refresh.VerticalAlignment=VerticalAlignment.Bottom;Grid.SetColumn(refresh,1);deviceRow.Children.Add(refresh);
        current.Children.Add(deviceRow);
        var saveRow=new WrapPanel{Margin=new Thickness(0,10,0,0)};
        var save=Button("保存语音配置",_=>{Save();return Task.CompletedTask;},null,flat:true,"Primary");
        save.Margin=new Thickness(0,0,8,0);saveRow.Children.Add(save);
        saveRow.Children.Add(Button("发送测试语音到文件传输助手",async token=>{
            if(testing){testStatus.Text="测试正在进行，请等待结果";return;}
            testing=true;
            try
            {
                Save();ShowResult(testStatus,"正在给文件传输助手发送测试语音…","Accent");
                string message=await VoiceSendTest.Run(root,token);
                ShowResult(testStatus,message,message.StartsWith("测试发送失败")?"Bad":"Warn");
            }
            finally{testing=false;}
        },testStatus,flat:true));
        current.Children.Add(saveRow);
        current.Children.Add(Note("测试会先保存当前配置，再给文件传输助手发送「"+VoiceSendTest.Text+"」；排队不代表送达，结果未确认时别重复发。"));
        current.Children.Add(testStatus);

        Card("虚拟声卡驱动","运行包只附带官方安装文件；解压、打开启动器和打开实验开关都不会替你安装 Windows 驱动。");
        driverButton=Button("安装 VB-CABLE 官方驱动",_=>{
            string exe=Path.Combine(root,"runtime","vb-cable","VBCABLE_Setup_x64.exe");
            if(!File.Exists(exe))throw new Exception("运行包缺少驱动，请从 https://vb-audio.com/Cable/ 安装");
            Process.Start(new ProcessStartInfo(exe){UseShellExecute=true,Verb="runas"});
            status.Text="完成官方安装并按提示重启后刷新声卡。VB-CABLE 为 VB-Audio Donationware，可向官方捐赠。";
            return Task.CompletedTask;
        });
        current.Children.Add(Note("VB-CABLE · vb-audio.com/Cable/ · Donationware，可向官方捐赠或购买许可。"));
        current.Children.Add(status);
        foreach(var result in new[]{keyStatus,testStatus,status})
        {
            result.SetResourceReference(StyleProperty,"Label");
            result.Margin=new Thickness(0,6,0,0);
            result.SetResourceReference(ForegroundProperty,"Muted");
        }
        Load();experimental.Checked+=Toggle;experimental.Unchecked+=Toggle;
        key.PasswordChanged+=(_,_)=>{
            if(loading||experimental.IsChecked!=true||string.IsNullOrWhiteSpace(key.Password))return;
            BindChoices(models,models.Items.Cast<BreezeSpeech.Choice>().ToArray(),model,false);
            BindChoices(voices,voices.Items.Cast<BreezeSpeech.Choice>().ToArray(),voice,true);
            ShowResult(keyStatus,"Key 已填写，模型和音色已就绪。请点击「测试 API Key 连接」确认可用后保存。","Muted");
        };
        Unloaded+=(_,_)=>requests.Cancel();
        Loaded+=(_,_)=>{if(requests.IsCancellationRequested){requests.Dispose();requests=new();}};

        TextBlock Note(string text)
        {
            var note=new TextBlock{Text=text,TextWrapping=TextWrapping.Wrap,LineHeight=19,Margin=new Thickness(0,6,0,2)};
            note.SetResourceReference(StyleProperty,"Small");return note;
        }
        // 一张卡 = H2 小标题 + 说明 + 一组字段，间距和其它页的卡片一致
        void Card(string heading,string hint=null)
        {
            var card=new Border{Padding=new Thickness(16,12,16,12),Margin=new Thickness(0,0,0,12)};
            card.SetResourceReference(StyleProperty,"Card");
            var inner=new StackPanel();card.Child=inner;
            var title=new TextBlock{Text=heading,Margin=new Thickness(0,0,0,2)};
            title.SetResourceReference(StyleProperty,"H2");inner.Children.Add(title);
            if(hint!=null)inner.Children.Add(Note(hint));
            panel.Children.Add(card);current=inner;
        }
        StackPanel Field(string label,Control control)
        {
            var box=new StackPanel{Margin=new Thickness(0,8,0,0)};
            var caption=new TextBlock{Text=label,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,4)};
            caption.SetResourceReference(StyleProperty,"Small");box.Children.Add(caption);
            // Explicitly retain the application's input styles for code-built controls.
            control.SetResourceReference(StyleProperty,control.GetType());
            box.Children.Add(control);
            return box;
        }
        void Add(string label,Control control)=>current.Children.Add(Field(label,control));
        void AddTo(Panel target,string label,Control control)
        {
            var field=Field(label,control);if(target is StackPanel)target.Children.Add(field);
        }
        Button Button(string label,Func<CancellationToken,Task> action,TextBlock feedback=null,bool flat=false,string style="Ghost")
        {
            var button=new Button{Content=label,MinHeight=34,HorizontalAlignment=HorizontalAlignment.Left};
            button.Margin=new Thickness(0,flat?0:10,0,0);
            button.SetResourceReference(StyleProperty,style);
            button.Click+=async(_,_)=>{
                if(experimental.IsChecked!=true)return;
                button.IsEnabled=false;
                var output=feedback??status;
                try{await action(requests.Token);}catch(OperationCanceledException){ShowResult(output,"实验功能已关闭或页面已离开，操作取消","Muted");}catch(Exception ex){ShowResult(output,ex.Message,"Bad");}
                finally{button.IsEnabled=true;}
            };
            if(!flat)current.Children.Add(button);
            return button;
        }
    }

    static void ShowResult(TextBlock target,string text,string tone)
    {
        target.Text=text;target.Visibility=Visibility.Visible;target.SetResourceReference(TextBlock.ForegroundProperty,tone);
    }

    static void BindChoices(ComboBox combo,BreezeSpeech.Choice[] options,TextBox field,bool isVoice)
    {
        string id=BreezeSpeech.SelectionId(field.Text,isVoice);
        var choices=BreezeSpeech.Choices(options,id,isVoice);
        combo.ItemsSource=choices;combo.SelectedItem=choices.First(c=>c.Id==id);field.Text=id;
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
            synthTimeout.Text=saved.SynthTimeoutSec.ToString(CultureInfo.InvariantCulture);
            model.Text=saved.Model;voice.Text=saved.Voice;instructions.Text=saved.Instructions;shortcut.Text=saved.RecordingHotkey;
            BindChoices(models,null,model,false);BindChoices(voices,null,voice,true);
            if(saved.Enabled){RefreshDevices();devices.SelectedItem=devices.Items.Cast<Device>().FirstOrDefault(d=>d.Id==saved.Device);}
        }
        catch{saved=new();experimental.IsChecked=false;panel.Visibility=Visibility.Collapsed;}
        finally{loading=false;}
    }
    void Save()
    {
        if(experimental.IsChecked!=true)throw new Exception("请先打开实验开关");
        if(!double.TryParse(probability.Text,NumberStyles.Float,CultureInfo.InvariantCulture,out var chance)||!double.IsFinite(chance)||chance<0||chance>100)throw new Exception("概率须为 0～100");
        if(!double.TryParse(synthTimeout.Text,NumberStyles.Float,CultureInfo.InvariantCulture,out var seconds)||!double.IsFinite(seconds)||seconds<5||seconds>90)throw new Exception("语音合成最长等待须为 5～90 秒");
        var hotkey=RecordingShortcut.Parse(shortcut.Text);
        if(devices.SelectedItem is not Device d||string.IsNullOrWhiteSpace(voice.Text))throw new Exception("请选择虚拟声卡和音色");
        BreezeSpeech.SaveKey(keyFile,key.Password);if(string.IsNullOrWhiteSpace(BreezeSpeech.LoadKey(keyFile)))throw new Exception("请配置 BreezeBlue Key");
        var value=new AutoVoiceSettings{Enabled=true,Probability=chance,Groups=groups.IsChecked==true,Private=privates.IsChecked==true,Model=model.Text.Trim(),Voice=voice.Text.Trim(),Instructions=instructions.Text.Trim(),Device=d.Id,RecordingHotkey=hotkey.Label};
        value.SynthTimeoutSec=seconds;
        Write(value);saved=value;shortcut.Text=hotkey.Label;
        status.Text="已保存，微信录音快捷键："+hotkey.Label+"。关闭实验开关立即停止后续语音任务。";
    }
}
