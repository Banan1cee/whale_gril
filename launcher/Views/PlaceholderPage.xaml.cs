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
    }
}
