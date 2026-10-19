# PaperLink 0.5.2

Zotero 插件（Zotero 7 / 8 / 9 / 10，Windows · macOS · Linux 通用）。

用 Zotero Connector 保存论文时自动完成：

```
Connector 收录
  → 在 Downloads（或你指定的文件夹）里找同一篇论文
      有 → 链接已有 PDF（你的高亮/批注都在这个文件里），然后询问是否彻底删除 Zotero 下载的副本
      无 → 把 Zotero 下载的 PDF 保存到指定文件夹（默认 Downloads）并链接
  → 检查文库里是否已有这篇论文 → 询问：合并 / 保留两条 / 查看重复条目
```

## 安装

1. 从 [Releases](https://github.com/zhuzihan728/zotero-paperlink/releases/latest) 下载最新的 `paperlink-x.y.z.xpi`。
   （Firefox 会把 `.xpi` 当作浏览器扩展去安装，请右键链接“另存为”。）
2. Zotero → 工具 → 插件 → 右上角齿轮 → Install Plugin From File… → 选择该 `.xpi`。之后 Zotero 会自动检查更新。
3. Zotero → 设置 → PaperLink：确认要搜索的文件夹（默认是系统下载文件夹）。

已经选中的旧条目也可以手动处理：右键 → **PaperLink：查找本地 PDF 并检查重复**。

## 如何判断“是同一篇论文”

按可靠程度从高到低：

| 依据 | 说明 | 自动链接 |
|---|---|---|
| 文件内容完全相同 | 与 Zotero 刚下载的 PDF 的 MD5 一致 | 是 |
| DOI | PDF 元数据（XMP / Info 字典）中的 DOI，或文件名中的 DOI（如 `s41586-020-2649-2.pdf`） | 是 |
| arXiv 编号 | 如 `1706.03762v7.pdf` | 是 |
| PDF 元数据中的标题 | 与条目标题一致 | 是（可设置为先询问） |
| 文件名中的标题 | 如 `Harris 等 - 2020 - Array programming with NumPy.pdf`，支持中文标题与截断的长标题 | 是（可设置为先询问） |

否决规则：PDF 元数据声明了**另一个** DOI，或文件名中是**另一个** arXiv 编号时，不会匹配。
多个文件得分接近且内容不同时，会弹窗让你选择，不会自己猜。

## 安全规则

- Zotero 存储以外的文件（你的 Downloads、论文文件夹）从不删除、重命名或覆盖。
- 本地已有论文时，Zotero 下载的副本只有在你点“删除”后才会**彻底删除**（附件和存储中的文件都删除，不进回收站，无法恢复）。默认按钮是“保留”，关闭对话框也算保留。若副本中有标注，对话框会额外警告。
- 设为“不询问直接删除”时，含标注的副本会自动保留。
- 保存新 PDF 时，如果目标文件夹已有同名文件：内容相同就直接链接它，内容不同则另存为 `名称 (2).pdf`，绝不覆盖。
- 合并重复条目时，新条目进入 Zotero 回收站（可恢复）。
- 条目类型不同也能合并（如 arXiv 预印本 + 会议论文）：合并后采用正式发表版本的类型；新类型没有的字段（如 arXiv 编号）以 `archiveID: arXiv:xxxx` 的形式保存在“其他”(Extra) 字段中，不会丢失。
- 合并后自动去重：内容相同的笔记（如 arXiv 的 `Comment:` 笔记）、指向同一文件的链接、相同网址的链接，较新的一份移入 Zotero 回收站；带标注的永远保留。
- PDF 有保障：Connector 最多等 45 秒；合并之后才到的 PDF 会自动挂到合并后的条目上；如果条目仍然没有可用的 PDF（Connector 没传、或你删掉了链接的文件），自动用 Zotero 的“查找可用 PDF”重新下载并保存到文件夹。缺 PDF 时先尝试 Zotero 文件同步（在另一台电脑添加、文件尚未下到本机的附件），拿不到才在线查找。已有可用 PDF 后：指向本机管理文件夹中已删除文件的链接移入 Zotero 回收站；来源不明的不可用附件（可能在另一台电脑上仍可用）手动运行时询问，自动运行时保留。可用 `findMissingPDF` 关闭。
- 自动模式只处理刚刚添加（10 分钟内）的条目；同步下来的条目、一次性导入超过 10 条的情况都会跳过。
- 群组文库不支持链接文件，只做重复条目检查。

## 设置项

均在 Zotero → 设置 → PaperLink 中，也可在“高级 → 配置编辑器”中搜索 `extensions.paperlink.`：

| 偏好 | 默认 | 含义 |
|---|---|---|
| `folders` | 空（系统下载文件夹） | 搜索的文件夹，多个用 `;` 分隔 |
| `scanDepth` | 2 | 搜索子文件夹层数 |
| `downloadedCopyAction` | `ask` | 找到本地文件后，Zotero 的副本：`ask` 询问后彻底删除或保留 / `delete` 直接彻底删除 / `keep` 保留 |
| `noMatchAction` | `move` | 没找到时：`move` 保存到 `moveTarget` 并链接 / `keep` 留在 Zotero 存储中 |
| `moveTarget` | 空（第一个搜索文件夹） | 新 PDF 的保存位置 |
| `confirmProbable` | false | 仅凭标题匹配时是否先询问 |
| `duplicateAction` | `ask` | 重复条目：`ask` / `merge` / `ignore` |

## 与 ZotMoov、Zoplicate 一起用

- **ZotMoov**：PaperLink 默认已经会把新 PDF 存到指定文件夹并链接，相当于取代了 ZotMoov 的自动移动。请关闭 ZotMoov 的自动移动，否则两者会同时处理同一个文件。若想继续用 ZotMoov，把 `noMatchAction` 设为 `keep`。
- **Zoplicate**：两者都会提示重复条目。保留 Zoplicate 时，建议把 `duplicateAction` 设为 `ignore`。

## 注意

- 链接的文件留在原位置。如果你会定期清理 Downloads，请把论文放到一个固定文件夹，并把它设为搜索文件夹。
- 链接文件不参与 Zotero 文件同步，需要用 iCloud / OneDrive / Dropbox 等同步该文件夹。
- 只读取 PDF 开头 256 KB 和结尾 128 KB 中未压缩的元数据。很多 PDF 会压缩元数据，这时只能依靠文件名和内容哈希。
- 读取到的元数据缓存在 Zotero 数据目录的 `paperlink-cache.json`，可随时删除。

## 开发

```
python3 build.py                         # 打包到 dist/，并更新 updates.json
node test/match.test.js                  # 匹配逻辑单元测试
# macOS 无 node 时：
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test/match.test.js
```

### 发布新版本

1. 修改 `src/manifest.json` 中的 `version`。
2. 运行 `python3 build.py`（会同步更新 `updates.json`）。
3. 提交并推送到 `main`，然后打标签：`git tag v<版本号> && git push origin v<版本号>`。

GitHub Actions（`.github/workflows/release.yml`）会运行测试、打包 `.xpi` 并创建 Release。已安装的插件通过 `update_url`（本仓库 `main` 分支上的 `updates.json`）发现新版本。
