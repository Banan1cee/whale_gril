using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace WhaleLauncher;

// 三个文本列表共用像素滚动，保留虚拟化；连续滚轮从当前动画位置续接。
public static class SmoothScroll
{
    static readonly DependencyProperty OffsetProperty = DependencyProperty.RegisterAttached(
        "Offset", typeof(double), typeof(SmoothScroll), new PropertyMetadata(0d,
            (d, e) => ((ScrollViewer)d).ScrollToVerticalOffset((double)e.NewValue)));
    static readonly DependencyProperty TargetProperty = DependencyProperty.RegisterAttached(
        "Target", typeof(double), typeof(SmoothScroll), new PropertyMetadata(double.NaN));

    public static void Attach(ListBox list)
    {
        VirtualizingPanel.SetScrollUnit(list, ScrollUnit.Pixel);
        list.PreviewMouseWheel += Wheel;
        list.Unloaded += (_, _) => {
            var viewer = Find(list);
            if (viewer != null) { viewer.BeginAnimation(OffsetProperty, null); viewer.SetValue(TargetProperty, double.NaN); }
        };
    }
    static ScrollViewer Find(DependencyObject node)
    {
        if (node is ScrollViewer scroll) return scroll;
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(node); i++) {
            var found = Find(VisualTreeHelper.GetChild(node, i));
            if (found != null) return found;
        }
        return null;
    }
    static void Wheel(object sender, MouseWheelEventArgs e)
    {
        var viewer = Find((DependencyObject)sender);
        if (viewer == null || viewer.ScrollableHeight <= 0 || SystemParameters.WheelScrollLines == 0) return;
        var target = (double)viewer.GetValue(TargetProperty);
        if (double.IsNaN(target)) target = viewer.VerticalOffset;
        var step = SystemParameters.WheelScrollLines < 0 ? viewer.ViewportHeight : SystemParameters.WheelScrollLines * 20d;
        Move(viewer, target - e.Delta / 120d * step);
        e.Handled = true;
    }
    public static bool AtEnd(ListBox list)
    {
        var v = Find(list);
        return v == null || v.ScrollableHeight - v.VerticalOffset < 24;
    }
    public static void End(ListBox list)
    {
        list.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() => {
            if (!list.IsLoaded) return;
            var v = Find(list);
            if (v != null) Move(v, v.ScrollableHeight);
        }));
    }
    static void Move(ScrollViewer viewer, double target)
    {
        target = Math.Max(0, Math.Min(viewer.ScrollableHeight, target));
        var start = viewer.VerticalOffset;
        viewer.BeginAnimation(OffsetProperty, null);
        viewer.SetValue(OffsetProperty, start);
        viewer.SetValue(TargetProperty, target);
        if (!SystemParameters.ClientAreaAnimation) {
            viewer.SetValue(OffsetProperty, target);
            viewer.SetValue(TargetProperty, double.NaN);
            return;
        }
        var animation = new DoubleAnimation(start, target, TimeSpan.FromMilliseconds(160)) {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }, FillBehavior = FillBehavior.Stop
        };
        animation.Completed += (_, _) => {
            viewer.SetValue(OffsetProperty, target);
            viewer.SetValue(TargetProperty, double.NaN);
        };
        viewer.BeginAnimation(OffsetProperty, animation);
    }
}
