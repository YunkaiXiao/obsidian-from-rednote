# 决策记录（ADR）

## ADR-001 项目与仓库（2026-09-14）

- 仓库名：`obsidian-from-rednote`，公开（Public）
- 本地路径：`E:\zcode_data\.zcode\workspace\default\obsidian-from-rednote`
- 目标：自研"小红书收藏 → Obsidian 同步"插件，功能对标 rednote.2obsidian.com
- 开发方式：对话式逐项确认需求，再进入实现

## ADR-002 合规边界（2026-09-14）

- 参考产品官方仓库（EwingYangs/rednote2obsidian）license 为非标准 "Other"，且为付费商业产品
- 结论：**只参考其公开功能描述实现同类功能，不复制其代码**；本项目将采用标准开源 license（类型待用户确认）
- 小红书无公开官方 API，cookie/签名方式访问属灰色地带：定位个人备份用途，README 声明账号风控风险

## ADR-003 v1 范围与 AI 能力（2026-09-14，用户确认）

- 产品形态：纯 Obsidian 插件；v1 = 手动粘贴 Cookie 登录 + 手动触发同步；后续版本对标参考产品（扫码登录、自动增量同步）
- v1 同步范围：仅"收藏"；点赞、动态、评论抓取列入后续版本
- 新增核心能力（超出参考产品）：调用大模型 API 做视频转写（transcribe）与帖子图片分析，用户自备 API key
- 定位：开源免费

## ADR-004 AI 接入与输出（2026-09-14，用户确认）

- 接入方式：**OpenAI 兼容接口自定义配置**（base_url + api_key + model 名），不内置厂商预设，兼容 GLM/OpenAI/DeepSeek/Ollama 等；用户自备 key
- 输出位置：笔记正文末尾追加「## 🤖 AI 摘要」小节（视频转写稿、图片分析），frontmatter 记录 `ai: true` 与模型名；原文与 AI 内容分区
- AI 功能为可选开关（涉及调用费用），默认关闭

## ADR-005 视频转写形态与格式基线（2026-09-14，用户确认）

- 视频转写：v1 将视频文件直接投喂多模态模型（OpenAI 兼容接口）；超出模型大小/时长限制的跳过并在笔记中标注"转写失败：超限"；ffmpeg 抽音频 + Whisper 转写列为后续可选增强（不引入 v1 依赖）
- 笔记字段基线：标题、正文、图片、作者、标签、原文链接（对齐参考产品）
- frontmatter 基线：`resourceId, author, link, tags, category, timestamp` + 扩展 `ai`/`ai_model`
- 目录基线：`RedNote/Bookmarks/《标题》.md`，图片存 `RedNote/Media/{postId}/`（.webp）
- 格式改进建议（时间戳拆分、tags 命名空间、collection 字段等）讨论中，采纳项记入 ADR-006

## ADR-006 格式改进（2026-09-14，用户确认，七项全采纳）

- 时间戳一拆三：`created_at`（发布）/ `collected_at`（收藏）/ `synced_at`（同步），ISO 8601 格式
- tags 命名空间：**方案 a——默认前缀 `xhs/`**（如 `xhs/咖啡`），设置中可修改前缀或关闭
- 新增 `collection`：记录笔记所在的小红书收藏夹（分组）
- `author` 拆平：`author` / `author_id` / `author_link`
- 新增 `type: video | image`（图文/视频笔记）
- 文件名处理：同题冲突自动追加 note_id 后 4 位；清洗 Windows 非法字符
- AI 字段：`ai_model` + `ai_sections` 列表（transcript / image_analysis），比单一布尔表达力强
- 字段命名：参考产品的 `resourceId` 更名为 `note_id`
- 完整模板见 `docs/note-template.md`

## ADR-007 登录实现与 License（2026-09-14，用户确认）

- 登录：v1 采用**插件内嵌登录页**（隐藏 webview 加载小红书，用户扫码/输密码，会话由 webview 保持），不做粘贴 cookie 注入（httpOnly 注入实现更绕且体验差）；这同时就是参考产品的扫码登录形态
- 取数：API 请求在 webview 内执行，签名（X-s/X-t）由小红书自身前端 JS 自动完成，规避算法更换导致的失效
- License：**MIT**，Copyright (c) 2026 YunkaiXiao
