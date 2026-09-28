# ZCode AI 回填协议（ai-backfill-protocol）

> 版本：1.0（2026-09-29，ADR-009/016/018/023/024 的执行规范）
> 适用：ZCode 会话对本 vault 中 Pull Rednote 笔记做 AI 批量回填（深度回填含失效视频链接重取）
> 前提：用户在对话中要求"处理收藏的 AI 待办"（或等价表述）时按本协议执行

## 0. 边界与安全

- **只读写以下范围**：`{notesFolder}/**/*.md`（默认 `01_Inbox/RedNote/Bookmarks/`）与 `{mediaFolder}/{note_id}/`（默认 `01_Inbox/RedNote/Media/`）。笔记目录可在 `.obsidian/plugins/obsidian-from-rednote/data.json` 的 `notesFolder`/`mediaFolder` 读取
- **永不**：修改 frontmatter 中 note_id/type/link 等源数据字段；删除任何笔记或媒体；把视频文件存入 vault（vault 永不存视频本体，视频经系统临时目录处理后删除）
- **幂等**：所有写回以 `ai_sections` 标记为闸，重复执行自动跳过已处理项
- 模型信息从 `data.json` 读取（`aiBaseUrl`/`aiApiKey`/`aiModel`）；若未配置，询问用户或使用 ZCode 自身多模态能力（后者 `ai_model` 记 `zcode:<模型名>`）

## 1. 待处理发现（按优先级扫描）

在 notesFolder 下扫描全部 `.md`，解析 frontmatter（取第一对 `---` 之间）与正文，三类为待处理：

| 类别 | 判定 | 含义 |
|---|---|---|
| A. 缺图片分析 | frontmatter `ai_sections` 不含 `image_analysis` 且正文有本地图片嵌入 `![](/…RedNote/Media/…)` | 常规图片回填 |
| B. 缺视频转写 | `type: video` 且 `ai_sections` 不含 `video_transcript` 且正文有 `[▶ 观看视频](http…)` 或 `[▶ 视频](` | 常规视频回填 |
| C. 链接缺失深度回填 | `type: video` 且转写小节含「未转写：该笔记落盘早于视频链接提取修复」 | 需重调 API 拿新鲜视频 URL（见 §3） |

注：正文嵌入路径为 vault 绝对格式（前导 `/`）；读文件时去掉前导 `/` 即得 adapter 相对路径。

## 2. 常规回填（A/B 类）

### 2.1 图片分析（A 类）
1. 从正文提取全部本地图片路径（`![](/…/RedNote/Media/{note_id}/N.ext)`）
2. 读取图片，按 OpenAI 兼容 `/chat/completions` vision 格式调用（base64 data URI；http:// 本地服务注意显式 Content-Length）
3. 提示词与插件一致（两段式：逐张完整 OCR 文字 → 概述 → 要点）
4. 写回（见 §4）

### 2.2 视频转写（B 类）
1. 从正文提取视频直链（`[▶ 观看视频](URL)`）
2. **优先完整视频 base64 直传**（`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}`）——服务端抽帧式 URL 直传会丢音轨；>40MB 走临时目录 ffmpeg（抽音轨/抽帧）
3. 输出：完整口语转录稿 + 三句话摘要 + 关键时刻 JSON（`[{"t": 秒数字, "why": …}]`，t 必须数字）
4. 关键帧：ffmpeg 流式 seek（`ffmpeg -ss {t} -i {URL} -frames:v 1 -q:v 3 {out}`）输出 `{mediaFolder}/{note_id}/kf-{序号}-{t}s.jpg`；已存在跳过；时长比例制额度（基础 8 + 每多 5 分钟 +4，上限 60）
5. 写回（见 §4）

## 3. 深度回填（C 类——失效链接重取）

插件内无法重取（不调详情 API 是 M4.2 的设计边界），ZCode 会话可以：

1. 从笔记 frontmatter 读 `note_id` 与 `link`（`https://www.xiaohongshu.com/explore/{note_id}`）
2. 视频 URL 不直接猜——重取路径（按可用性选用）：
   a. **经插件**（推荐）：请用户在 Obsidian 里对这些笔记做一次"强制重取"式重同步（把 noteIndex 中该 note_id 的 hash 置空并删除文件触发全重写）——正文将带最新视频链接，再按 §2.2 处理
   b. **直接调 API**（需用户明确授权且在用户登录会话上）：`POST https://edith.xiaohongshu.com/api/sns/web/v1/feed`，body `{"source_note_id": note_id, "image_formats":["jpg","webp","avif"], "extra":{"need_body_topic":1}, "xsec_source":"", "xsec_token":""}`，签名需 `window.mnsv2`（用户 vault 内插件 webview 才有）——通常不可行，默认走路径 a
3. CDN 直链带签名会过期：取到的新 URL 应**当次处理完**，不要写入笔记留待后用（处理完写回的笔记正文由路径 a 的重同步更新）

## 4. 写回格式（与插件轨道完全一致）

追加/替换到笔记末尾的 AI 小节（保留原文与同级子节）：

```markdown
## 🤖 AI 摘要

### 图片分析
（A 类结果：逐张 OCR → 概述 → 要点）

### 视频转写
（B/C 类结果：转录稿 + 摘要）
**关键时刻见「### 关键帧」**

### 关键帧
- ![关键帧{t}s](/{mediaFolder}/{note_id}/kf-{序号}-{t}s.jpg)（{why}）
```

frontmatter 更新（在既有 `---` 块内改/增）：
- `ai_model: zcode:<模型名>`（若已有插件模型值则**保留原值并在其后追加 `, zcode:<模型名>`**）
- `ai_sections` 列表追加本批实际完成的项（`image_analysis` / `video_transcript`）

无对应媒体的类别不写对应子节、但要把标记补全（终态语义，防止插件补处理重扫）。

## 5. 执行节流

- 每篇 API 调用间 ≥2s；每批（默认 10 篇）后 5s；出错单篇跳过继续
- 视频 base64 请求体大（5MB 视频≈7MB 请求体），注意超时（≥120s）与显存波动（CUDA OOM 常为暂时性，隔 30s 可重试一次）

## 6. 完成报告

向用户报告：待处理分布（A/B/C 各多少）→ 实际处理（成功/失败/跳过 + 失败原因）→ 已写回文件数、新增关键帧数 → 剩余欠账（如 C 类未能重取的原因）。
