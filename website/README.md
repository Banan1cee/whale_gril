# Whale Girl 主题官网

独立静态宣传网站。无需安装依赖或构建，可直接打开 `website/index.html`。

## 本地预览

在仓库根目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory website
```

浏览器访问 http://127.0.0.1:4173 。

## 发布

将 `website/` 中的文件部署到任何静态托管服务的站点根目录（例如 GitHub Pages、Cloudflare Pages 或 Nginx）。无构建命令，输出目录为 `website`。支持托管在子路径下。

## 内容维护

- `index.html`：宣传内容、更新报告弹窗、最近发行版本、作者寄语、下载链接与 SEO 描述。
- `style.css`：响应式布局、明暗主题 token、动效；支持系统减少动态效果设置。
- `theme.js`：首屏主题初始化；优先本地选择，否则跟随系统。
- `app.js`：主题切换、移动导航、报告弹窗、进入视口动效。
- `whale.svg`：首页原创矢量鲸鱼视觉。
- `images/launcher-icon.png`：与启动器 `launcher/Assets/app.png` 字节一致的品牌图标，同时用于页头、页脚和 favicon。图标原创角色作者为上善无形，本项目图标为二创作品；署名与使用边界见根目录 `NOTICE.md`。
- `fonts/`：本地 Noto Sans SC（思源黑体体系）400 / 500 / 600 字重及 OFL 许可，统一中英文字形。字体按当前页面文案和 ASCII 字符子集化；新增中文文案时需重新生成子集，否则新增字会使用系统后备字体。字体来自 Google Fonts，总大小约 387 KiB，访客无需访问外部字体服务。

发版后根据真实 Releases 更新报告与版本列表，不要展示未单独发行的仓库中间版本。当前只列真实发行过的三个 4.x 版本：4.0.6、4.0.5、4.0.1；4.0.2–4.0.4 未单独发版，内容已并入 4.0.5，页面脚注也说明这一点。站点不再提供独立更新日志栏目，完整历史仍以仓库 `CHANGELOG.md` 与 Releases 为准。下载按钮打开官方最新 Release，让用户选择实际存在的安装资产。作者寄语为明确标注的待确认草稿，正式上线前由作者确认或替换。

网站不收集访客数据；仅在浏览器 localStorage 保存主题偏好。所有对话展示均为示意文案。

## 视觉与动效

白底配色参考 [Colorhero 的 Warm Neutral Light](https://colorhero.io/blog/modern-ui-color-schemes-users-love) 和 [Recolor 的 Sea glass 系列](https://recolor.page/palettes/teals/)，按鲸鱼主题调整为：白色 `#FFFFFF`、墨青 `#183332`、深青按钮 `#175C56`、海盐表面 `#F3F7F6`，辅以浅绿 `#EEF5F1` 与暖白 `#F6F4EF`。网页文字与按钮对比需按实际 token 检查，参考网站的结论不代替本项目验证。

首屏分层入场、鲸鱼浮游、流动光轨、卡片滚动入场和桌面指针倾斜使用 CSS 与原生 JS。首屏底部可暂停动画；系统开启减少动态效果时自动使用静态模式。手机使用单列内容与折叠菜单，桌面使用双列布局，指针动效仅启用于精细指针设备。

连续滚动叙事参考 [Apple AirPods Pro 官网](https://www.apple.com/airpods-pro/) 和 [Awwwards 对 Apple 团队的设计访谈](https://www.awwwards.com/airpods-pro-wins-site-of-the-month-january.html)：使用驻留视觉、按滚动进度推进的三段故事、可逆过渡与共享背景来连接章节。`motion.js` 按位置求值，前后滚动都可重放；各章节也保留持续的微动效。短屏与横屏自动切回自然排版。未使用苹果图片、视频或源代码。

01 / 02 / 03 角色场景使用项目现有鲸鱼娘素材：`assets/stickers/开心/whale-02078503148a8b78.png`、`assets/stickers/傲娇/whale-05e27f4bea539577.png`、`assets/stickers/傲娇/whale-fc820657b91d8fa7.png`。在 `website/images/` 保存 WebP 网页副本（共约 197 KiB），原图未修改。角色表情、对话气泡、记忆节点按阶段切换；网络线条、光轨和微浮动保持持续运动。首页与角色段落共用 `.journey` 背景，`entrance` 进度控制前景交接。
