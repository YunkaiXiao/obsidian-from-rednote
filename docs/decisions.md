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

## M2 评审记录（2026-09-14）

- local-reviewer 产出 4 条候选发现，Parent 裁决：
  - #1 导航门禁绑定的 will-navigate 非可防御元素事件，门禁可能无效 → **采纳修复**：保留 new-window 拦截 + allowpopups=false，新增 did-navigate / did-navigate-in-page 事后检测非小红书域名则拉回首页
  - #2 中途登录失效时已写盘笔记不进 syncedNoteIds，下次重复拉取覆盖 → **采纳修复**：逐篇成功写盘后增量持久化；lastSyncAt 仍仅整轮成功更新
  - #3 登录 Modal 可重入，两个 Modal 争抢同一常驻 webview → **采纳修复**：loginModalOpen 守卫
  - #4 syncedNoteIds 无界增长 → **延后 M3**（增量索引重做时一并处理）
- 评审门关闭条件：3 项修复落地且 npm run build 与 npm test 均 exit 0

## ADR-008 真机验证第一轮：登录白屏缺陷 + 限速需求 + 改名（2026-09-15，用户反馈）

- 真机结果（Obsidian 1.13.7）：点击「打开登录窗口」后 Modal 弹出但**内部全白、无任何交互内容**（仅 × 关闭按钮），弹窗约 560×130px；同步未测（因未登录）。登记为用户真机复现的缺陷
- 待排查方向（代码级）：登录容器隐藏期样式（position:fixed/left:-99999px）移入 Modal 时未清除；webview src 设置时机（须先挂载 DOM 再设 src）；Modal/webview 缺少显式尺寸
- 新需求①限速：每时间窗口最多同步 N 篇笔记，**N 与窗口时长均可在设置中调整**（默认窗口 10 分钟），防 bot 检测；窗口状态持久化，重启后不重置预算
- 新需求②改名：显示名 RedNote Sync → **Pull Rednote**（与他人插件重名）；插件 id 保持 `obsidian-from-rednote` 不变（保留 data.json 数据连续性），用户可见文案全部更名

### ADR-008 追记：修复轮结论（2026-09-15）

- 白屏根因（代码级确认）：①常驻容器 `display:none` 停靠 → webview 以 0×0 布局创建，移入 Modal 后不重排（主因）；②登录 onOpen `await` 完整页面加载才挂载（首开被 30s 门控卡白）；③高度塌陷（容器 height:100% 对 min-height 不解析 + webview 无显式尺寸）。修复：position:fixed 离屏停靠、onOpen 同步挂载（新增 ensureWebviewElement）、Modal 540×720 / webview 480×640、加载事件打 `[pull-rednote]` 前缀日志、主框架 did-fail-load 提前 settle
- 第二轮评审 1 条采纳并已修：登录 Modal `onClose` 未把容器 reparent 回 `document.body`（框架若卸载 modal DOM 会连带销毁 webview，"关窗后会话保持"失效）→ onClose 先挂回 body 再套离屏样式；其余核查通过（M2 三项修复无回归、限速语义正确、改名完备、partition 串保持不变维持会话）
- 限速实现：纯函数 ratelimit 模块 + 15 单测；设置默认 20 篇 / 10 分钟，状态持久化跨重启
- 证据：npm run build exit 0（main.js 44.6kb）、npm test 72/72 通过
- 状态：待用户真机复测——登录弹窗渲染、关窗后直接同步的会话保持、限速等待与自动续传

## ADR-009 M4 双轨 AI 架构（2026-09-15，用户确认）

- **两条腿走路，都做**：
  - 轨道①（同步时即时处理）：`aiEnabled` 开启且模型已配置时，同步过程中直接用 OpenAI 兼容接口做视频转写/图片分析（沿用既有设置）
  - 轨道②（ZCode 异步补处理）：插件只负责同步与标记（`ai_sections` 留空即"待识别"），由 ZCode 会话按协议文档（`docs/ai-backfill-protocol.md`，待 M4 编写）异步批量识别并写回，输出格式与轨道①完全一致
- **执行器 toggle**：新增设置 `aiExecutor: plugin | zcode`——plugin=轨道①即时+补处理命令；zcode=插件只标记不处理，留给 ZCode 写回
- **AI 补处理命令**：独立命令处理 `ai_sections` 为空的笔记，**批次大小可调**（`aiBatchSize`，默认 10），跑完提示
- **来源追溯**：两种执行器写回时都更新 `ai_model`（ZCode 路径记 `zcode:<模型名>`）
- **硬约束**：增量同步重写笔记时必须保留已有 AI 小节（只更新原文区），否则补处理成果会被清掉——该约束进 M3/M4 实现契约
- **依赖顺序**：M3（媒体本地下载）仍是 M4 前置（视频需先落盘才能投喂模型）
