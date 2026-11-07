(() => {
  let theme;
  try { theme = localStorage.getItem('whale-theme'); } catch (_) { /* 隐私模式下仍使用系统主题。 */ }
  document.documentElement.dataset.theme = theme === 'light' || theme === 'dark'
    ? theme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
})();
