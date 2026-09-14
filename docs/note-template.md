# 同步笔记模板（ADR-006 定稿）

```markdown
---
note_id: 65f2a8b3000000001234abcd     # 小红书笔记 ID（即参考产品的 resourceId）
type: video                            # video | image（图文笔记）
title: 周末去哪喝咖啡
author: 咖啡日记
author_id: 5f8d21ac0000000001e02b3c
author_link: https://www.xiaohongshu.com/user/profile/5f8d21ac
link: https://www.xiaohongshu.com/explore/65f2a8b3
collection: 咖啡探店                    # 所在小红书收藏夹（分组）
tags:                                  # 原笔记话题标签，默认加 xhs/ 前缀（可在设置中改/关）
  - xhs/咖啡
  - xhs/探店
category: 饮食                         # AI 自动分类（AI 开启才有）
created_at: 2026-09-01T10:30:00+08:00  # 笔记发布时间
collected_at: 2026-09-12T08:00:00+08:00 # 用户收藏时间
synced_at: 2026-09-14T15:20:00+08:00   # 本次同步时间
ai_model: glm-4v-plus                  # AI 处理过才写
ai_sections: [transcript, image_analysis]
---

# 周末去哪喝咖啡

> [!info] 来源
> 作者：[咖啡日记](作者链接) ｜ 发布：2026-09-01 ｜ 收藏于：2026-09-12 ｜ [打开原文](链接)

（笔记正文；图片以 ![](RedNote/Media/{note_id}/1.webp) 形式内嵌）

## 🤖 AI 摘要
### 视频转写
（多模态模型转写的文字稿；超限视频则写"转写失败：超出模型限制"）
### 图片分析
（视觉模型的图片描述 / OCR / 要点）
```

## 文件与附件位置

- 笔记：`RedNote/Bookmarks/《标题》.md`；同题冲突时 `《标题》-{note_id 后 4 位}.md`
- 附件：`RedNote/Media/{note_id}/1.webp、2.webp …`（保持原始格式）
- 文件名清洗 Windows 非法字符：`/ \ : * ? " < > |`

## 设计要点

- `collected_at` 支持还原收藏时间线，配合 Dataview 做"上周收藏回顾"
- `xhs/` 前缀隔离小红书话题与用户个人标签体系
- `ai_sections` 用列表表达"转写/分析各自是否成功"，支持部分完成
