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
