using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhaleLauncher
{
    /// <summary>
    /// 启动器自己的外观设置：深浅色 + 背景图。
    /// 只写到 data/launcher-ui.json，不碰 config.json，也不影响内核和桥接。
    /// </summary>
    public static class Appearance
    {
        private static readonly string SettingsPath =
            Path.Combine(AppContext.BaseDirectory, "data", "launcher-ui.json");

        public static string Theme { get; private set; } = "dark";
        public static string Backdrop { get; private set; } = "";
        public static bool IsDark => !string.Equals(Theme, "light", StringComparison.OrdinalIgnoreCase);

        public static event Action Changed;

        private static readonly Dictionary<string, string> Light = new Dictionary<string, string>
        {
            ["Bg"] = "#FFF4F6F9",
            ["BgDeep"] = "#FFEEF1F6",
            ["BgNav"] = "#E6F4F6F9",
            ["BgTop"] = "#F2FFFFFF",
            ["CardBg"] = "#FFFFFFFF",
            ["CardBorder"] = "#FFE5E9F0",
            ["Line"] = "#FFEEF1F5",
            ["LineSoft"] = "#FFF1F4F8",
            ["Text"] = "#FF121722",
            ["Text2"] = "#FF465164",
            ["Muted"] = "#FF5E6A7C",
            ["Dim"] = "#FF6F7B8D",
            ["Accent"] = "#FF3B6EF6",
            ["AccentDim"] = "#FFEDF2FF",
            ["AccentSoft"] = "#FFEDF2FF",
            ["Ok"] = "#FF12B76A",
            ["Warn"] = "#FFF79009",
            ["Bad"] = "#FFF04438",
            ["Idle"] = "#FFB3BCCB",
            ["PrimaryBg"] = "#FF111827",
            ["PrimaryFg"] = "#FFFFFFFF",
            ["PrimaryHover"] = "#FF1F2937",
            ["GhostBg"] = "#FFFFFFFF",
            ["GhostHover"] = "#FFF1F4F8",
            ["Hover"] = "#FFF1F4F8",
            ["FieldBg"] = "#FFF7F9FC",
            ["FieldBorder"] = "#FFD5DCE6",
            ["PopupBg"] = "#FFFFFFFF",
            ["ChipBg"] = "#FFFFFFFF",
            ["Surface3"] = "#FFF1F4F8",
            ["TopBtnHover"] = "#FFF1F4F8",
            ["ScrollThumb"] = "#FFCBD3DF",
            ["BackdropTint"] = "#F0F4F6F9",
        };

        private static readonly Dictionary<string, string> Dark = new Dictionary<string, string>
        {
            ["Bg"] = "#FF080C12",
            ["BgDeep"] = "#FF05080D",
            ["BgNav"] = "#E6080C12",
            ["BgTop"] = "#F20C121A",
            ["CardBg"] = "#FF0F151E",
            ["CardBorder"] = "#FF243140",
            ["Line"] = "#FF202B38",
            ["LineSoft"] = "#FF1A2430",
            ["Text"] = "#FFF4F7FA",
            ["Text2"] = "#FFC3CDDA",
            ["Muted"] = "#FF98A6B8",
            ["Dim"] = "#FF7E8CA0",
            ["Accent"] = "#FF86ADFF",
            ["AccentDim"] = "#FF1A2A47",
            ["AccentSoft"] = "#FF1A2A47",
            ["Ok"] = "#FF48E3A1",
            ["Warn"] = "#FFFFC266",
            ["Bad"] = "#FFFF7B7B",
            ["Idle"] = "#FF5E6C80",
            ["PrimaryBg"] = "#FFF2F5F9",
            ["PrimaryFg"] = "#FF0A0F16",
            ["PrimaryHover"] = "#FFFFFFFF",
            ["GhostBg"] = "#FF131B26",
            ["GhostHover"] = "#FF1B2634",
            ["Hover"] = "#FF1A2431",
            ["FieldBg"] = "#FF141C27",
            ["FieldBorder"] = "#FF2A3748",
            ["PopupBg"] = "#FF131B26",
            ["ChipBg"] = "#FF121A24",
            ["Surface3"] = "#FF1A2431",
            ["TopBtnHover"] = "#FF1A2431",
            ["ScrollThumb"] = "#FF35465A",
            ["BackdropTint"] = "#AD080C12",
        };

        public static void Load()
        {
            try
            {
                if (!File.Exists(SettingsPath)) return;
                using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
                var root = doc.RootElement;
                if (root.TryGetProperty("theme", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    var v = (t.GetString() ?? "").Trim().ToLowerInvariant();
                    if (v == "light" || v == "dark") Theme = v;
                }
                if (root.TryGetProperty("backdrop", out var b) && b.ValueKind == JsonValueKind.String)
                    Backdrop = b.GetString() ?? "";
            }
            catch
            {
                // 设置文件坏了就用默认深色，不要让启动器起不来
            }
        }

        public static void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath) ?? AppContext.BaseDirectory);
                var json = JsonSerializer.Serialize(new { theme = Theme, backdrop = Backdrop },
                    new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(SettingsPath, json);
            }
            catch { }
        }

        public static bool SetTheme(string theme)
        {
            var next = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase) ? "light" : "dark";
            if (next == Theme) return false;
            Theme = next;
            ApplyTheme();
            Save();
            Changed?.Invoke();
            return true;
        }

        /// <summary>把当前主题写进 App.xaml 里的画刷。画刷是共享实例，改 Color 就能让所有引用一起变。</summary>
        public static void ApplyTheme()
        {
            if (Application.Current == null) return;
            var map = IsDark ? Dark : Light;
            foreach (var kv in map)
            {
                var color = (Color)ColorConverter.ConvertFromString(kv.Value);
                // 不能原地改：WPF 会把 Application.Resources 里的画刷冻结。
                // 直接换新实例，所有 DynamicResource 引用会跟着刷新。
                Application.Current.Resources[kv.Key] = new SolidColorBrush(color);
            }
        }

        public static bool TrySetBackdrop(string path, out string error)
        {
            error = "";
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                error = "找不到这张图片。";
                return false;
            }
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(path, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
            }
            catch (Exception ex)
            {
                error = "这张图片读不了：" + ex.Message;
                return false;
            }

            Backdrop = path;
            Save();
            Changed?.Invoke();
            return true;
        }

        public static void ClearBackdrop()
        {
            if (string.IsNullOrEmpty(Backdrop)) return;
            Backdrop = "";
            Save();
            Changed?.Invoke();
        }

        public static BitmapImage LoadBackdrop()
        {
            if (string.IsNullOrWhiteSpace(Backdrop) || !File.Exists(Backdrop)) return null;
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(Backdrop, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
                return bmp;
            }
            catch
            {
                return null;
            }
        }
    }
}
