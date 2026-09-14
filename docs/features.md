# 功能清单（对照参考产品 rednote.2obsidian.com）

> 与用户逐项确认中。状态：⏳ 待确认 ｜ ✅ 已确认 ｜ 🔜 后续版本 ｜ ❌ 不做

| # | 功能点 | 参考产品的做法 | 我们的方案 | 状态 |
|---|---|---|---|---|
| 1 | 产品形态 | 原生 Obsidian 插件，本地运行 | 纯 Obsidian 插件 | ✅ 2026-09-14 |
| 2 | 登录小红书 | 插件内扫码登录 | v1：手动粘贴 Cookie；后续版本升级扫码登录 | ✅（v1=Cookie） |
| 3 | 同步范围 | 收藏、点赞、动态 | v1 只做**收藏**；点赞/动态/评论列入后续版本 | ✅（v1=收藏） |
| 4 | 笔记字段 | 标题、正文、图片、作者、标签、链接 | 对齐参考产品；格式改进建议讨论中 | ✅ |
| 5 | 视频处理 | 以链接嵌入，不下载文件 | v1 下载视频直接投喂多模态模型转写；超限跳过并标注；ffmpeg 抽音频为后续增强 | ✅ |
| 6 | 评论抓取 | 官网未提及 | 后续版本 | 🔜 |
| 7 | 同步方式 | 自动 + 增量 | v1 手动触发 + 增量去重；自动同步列入后续版本 | ✅（v1=手动+增量） |
| 8 | Markdown 格式 | frontmatter：resourceId、author、link、tags、category、timestamp | 基线 + 七项改进（时间戳拆三、xhs/ 标签前缀、collection、author 拆平、type、文件名去重清洗、ai_model+ai_sections），见 docs/note-template.md | ✅ |
| 9 | 目录组织 | RedNote/Bookmarks、Posts、Likes；Media/{postId}（.webp） | v1：RedNote/Bookmarks/《标题》.md + RedNote/Media/{postId}/ | ✅ |
| 10 | AI 自动分类 | 可选，需自备模型 key | OpenAI 兼容接口自定义（base_url+key+模型名），自备 key，默认关闭 | ✅ |
| 11 | 定价 | 免费 100 篇 + ¥129.99 永久 | 开源免费 | ✅ |
| 12 | AI 视频转写 | 无 | v1 视频直接投喂多模态模型，输出写正文「🤖 AI 摘要」小节；超限跳过并标注 | ✅ |
| 13 | AI 图片分析 | 无 | 视觉模型分析图片（描述/OCR/要点）；输出写正文「🤖 AI 摘要」小节 | ✅ |
