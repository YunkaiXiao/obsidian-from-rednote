# 参考产品调研：rednote.2obsidian.com

> 调研日期：2026-09-14 ｜ 状态：ANSWERED（核心问题已有官方来源证据，2 处待验证）
> 调研方式：官方站点、姊妹站（Notion 版）、作者 GitHub、GitHub REST search API（共打开 12 个来源）

## 核心结论

### 1. 产品形态：原生 Obsidian 插件（高置信）

- 不是浏览器扩展/网页服务/桌面客户端，而是装进 vault 的 Obsidian 插件
- 安装：下载 zip（https://static.2notion.com/rednote2notion/rednote2obsidian.zip）→ 解压到 `.obsidian/plugins` → 关闭安全模式 → 启用
- 来源：https://rednote.2obsidian.com

### 2. 登录与数据获取（高置信 + 待验证）

- 登录方式：插件内**扫码登录小红书**（建立用户会话）
- 官方宣称"本地优先 / 无需依赖云端 / 断网可用，数据永远属于你"
- 姊妹 Notion 版提示登录依赖活跃的网页会话（"小红书网页是否已经退出登录"）
- ⚠️ 待验证：确切数据通路（插件内直接带 cookie 调小红书接口 vs 服务器中转）官网未明说，"本地优先"是厂商自述

### 3. 同步内容与方式（高置信）

- 同步范围：**收藏、点赞、动态**（"自动同步 收藏、点赞、动态"）
- 每篇笔记同步：标题、正文、图片、作者、标签、链接
- 视频：**以链接嵌入，不下载文件**
- 评论：官网通篇未提及（既未确认支持，也未否认）
- 同步方式：**自动 + 增量**（"新增收藏会自动同步"），具体增量机制未公开

### 4. Markdown 格式与目录组织（高置信）

- 原生 Markdown + YAML frontmatter，字段：`resourceId, author, link, tags, category, timestamp`
- 目录：`RedNote/Bookmarks`、`RedNote/Posts`、`RedNote/Likes`；图片存 `RedNote/Media/{postId}`（.webp 本地文件）
- 可选"AI 自动分类"功能，需自备模型 key

### 5. 定价与开源情况（有冲突）

- Obsidian 版页面：免费同步 100 篇；**¥129.99 永久**（Stripe 支付）
- ⚠️ 冲突：Notion 版页面显示 ¥79.9/周 + ¥199.9/永久，并称"一个 license 两版通用"，与 Obsidian 页数字对不上，无法从公开来源裁决
- 作者公开仓库：`EwingYangs/rednote2obsidian`（2026-06 创建，约 6 star，license 为非标准 "Other"）→ **按专有/商业软件对待，不能当开源项目抄代码**

### 6. 产品家族

同一作者有 2obsidian/2notion 系列：小宇宙、Twitter、B 站 → Obsidian；小红书 → Notion。作者：GitHub EwingYangs / X @YaseWings。

## 生态：类似开源项目（star 数为 2026-09-14 时点）

| 仓库 | Star | 语言/协议 | 实现思路 |
|---|---|---|---|
| bnchiang96/xiaohongshu-importer | 132 | TS / MIT | Obsidian 插件，**手动**弹窗粘贴分享链接导入（标题/内容/图片/视频/标签），无自动同步 |
| LinkisLethe/REDnote-clipper | 13 | TS | 剪藏帖子为 Markdown，带本地 OCR |
| suonian/vidknot | 15 | Python | 多平台视频笔记提取 → Obsidian |
| ytf606/xhs2obsidian | 4 | TS | Obsidian 桌面插件，**Electron WebView 取 cookie**，收藏/点赞/动态/搜索/关注增量同步，含评论与 AI 标签（与我们目标最接近的开源实现） |
| zhulin025/xiaohongshu-exporter | 11 | JS | 收藏夹导出到飞书/Notion/本地 |
| DoYitNow/xhs-cli-export | 3 | Python | CLI 导出收藏/点赞为 Markdown，增量 |
| Michelin-3-star-tires/xiaohongshu-favorites-exporter | 4 | JS | Chrome 扩展导出收藏为 CSV |

## 待验证（NEEDS_VERIFICATION）

1. 数据通路细节：插件内 cookie 直连小红书接口，还是有服务器中转（可读官方仓库源码核实网络调用）
2. 评论是否同步（官网未提及）
3. `EwingYangs/rednote2obsidian` 的 "Other" LICENSE 实际条款；公开仓库是否包含完整同步逻辑
4. 定价结构（两页数字冲突）
5. blog.notionedu.com 帮助文档与 2obsidian.com 根站（抓取时未渲染成功）

## 对本项目的合规提示

- 参考产品为付费商业软件、非标准 license：**只对标其公开功能描述，不复制其代码**
- 小红书无公开官方 API；cookie/签名方式访问属灰色地带，本项目定位**个人备份用途**，README 需声明账号风控风险
