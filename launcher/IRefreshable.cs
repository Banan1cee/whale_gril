using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>页面在切到前台、或主窗每 2 秒刷新时被调用。实现者自己决定要不要真去拉数据。</summary>
    public interface IRefreshable
    {
        Task RefreshAsync();
    }
}
