using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;

namespace WhaleLauncher
{
    internal static class ConfigurationControls
    {
        // 未启动时只读展示，避免用户以为尚未发送到内核的修改已经保存。
        public static void SetReadOnly(DependencyObject root, bool readOnly)
        {
            if (root is TextBox text) { text.IsReadOnly = readOnly; return; }
            if (root is ComboBox || root is ToggleButton || root is Slider || root is PasswordBox)
            {
                ((UIElement)root).IsEnabled = !readOnly;
                return;
            }
            foreach (var child in LogicalTreeHelper.GetChildren(root))
                if (child is DependencyObject dependency) SetReadOnly(dependency, readOnly);
        }
    }
}
