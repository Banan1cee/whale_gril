# SignPath 配置对照表

CI 里的两步签名（`.github/workflows/installer.yml`）对应 SignPath 后台里的这些东西。
**这些 XML 不能当文件被 CI 读取** —— SignPath 的 artifact configuration 存在它自己那边，
这里放一份是为了有版本记录、方便复制粘贴进后台。

| 后台里要建的 | slug | 内容 |
| --- | --- | --- |
| Artifact configuration（启动器） | `whale-launcher` | `whale-launcher.xml` 的内容 |
| Artifact configuration（安装包） | `whale-setup` | `whale-setup.xml` 的内容 |
| Signing policy（发版） | `release-signing` | 只在 tag 上签；可以配成需要人工审批 |
| Signing policy（测试） | `test-signing` | 测试分支用，签完只出 Artifact 不发 Release |

CI 里怎么用：

```yaml
signing-policy-slug: ${{ github.ref_type == 'tag' && 'release-signing' || 'test-signing' }}
artifact-configuration-slug: whale-launcher   # 第二轮换成 whale-setup
github-artifact-id: ${{ steps.upload-unsigned-*.outputs.artifact-id }}
skip-decompress: true                          # 配合 upload-artifact 的 archive: false
```

注意：

- artifact configuration 的根元素是 `<pe-file>`（因为 CI 传的是裸 exe）。如果哪天把
  `archive: false` 去掉，artifact 会变成 zip，那时根元素必须改成 `<zip-file>`，并去掉
  `skip-decompress`，否则签名请求会因为根元素对不上直接失败。
- 通配符默认 `max-matches=1`：安装包那条 `whale-girl-*-setup.exe` 必须只匹配到一个文件。
- `pe-file` 只签 PE 本身。安装包里的 `WhaleLauncher.exe` 是**先单独签好**再被 Inno 压进包里的，
  SignPath 不会（也做不到）去改 Inno 里的压缩数据。
- 完整申请与配置步骤见 `docs/打包与签名.md` 第四节。
