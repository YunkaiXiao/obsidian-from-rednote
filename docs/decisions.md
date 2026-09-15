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

## ADR-010 登录白屏真正根因与修复（2026-09-15，Parent 直查）

- **根因（确证）**：Electron `<webview>` 是 attribute 驱动（attributeChangedCallback）的；代码对 `src/partition/useragent/allowpopups` 全部使用 JS 属性赋值（`el.src = …`），在该版本 Electron 不反射为 attribute → **导航从未发起，webview 永远停在 about:blank**（与真机 a11y 树中 `= about:blank` 的元素、零加载日志、零报错完全吻合）。前两轮修复（display:none 停靠、显式尺寸、同步挂载）修的是真实但次要的问题，未触及此根因
- **隐藏后果**：`partition` 同样未生效——会话隔离（`persist:rednote-sync`）此前并未真正启用
- **修复**（Parent 直接实现，依据=用户运行时证据与实现报告矛盾）：四处改为 `setAttribute("partition"/"useragent"/"allowpopups"/"src")`；WebviewEl 类型瘦身；补 `dom-ready` 日志
- **新增可观测性**：登录弹窗顶部一行可见状态（"正在加载小红书页面…" → "页面已加载 ✓" / "⚠ 页面加载失败（code=N）" / 10 秒看门狗提示），今后无需 DevTools 即可诊断
- 证据：npm run build exit 0（main.js 46.7kb）、npm test 72/72
- 部署：构建产物已复制到用户 vault（E:\Workflow）插件目录并已触发 Obsidian 重载（依据=设置窗口内容被重载清空）；最终视觉验证待用户点击（自动化通道 CUA 服务中断，中止）

## ADR-011 崩溃缓解与自适应尺寸（2026-09-15，第二轮真机反馈）

- 真机结果：setAttribute 修复生效——登录页已实际加载（状态行"页面已加载 ✓"、二维码占位与扫码文案出现），但出现新问题：①Obsidian 主进程**崩溃退出两次**（Windows 事件日志：APPCRASH，异常码 0x80000003 断点，01:49:57 / 01:50:59，即重启后复崩）②二维码图片未渲染 ③窗口高度受限（590px）导致页面显示不全
- 崩溃分析：0x80000003=Chromium/Electron 内部 CHECK 断言，最大嫌疑=导航门禁在 did-navigate 回调里**同步调用 loadURL**（重入导航机制）；确证手段（受控复现二分）本轮不可用（CUA 自动化服务中断）
- 修复（缓解性，a79ba14）：①门禁回跳改 250ms 延迟 + 1.5s 限频（消除重入）②移除 `allowpopups="false"` 属性——Electron 布尔属性"存在即开启"，原写法语义反转（缺省=禁弹窗，正确）③webview/弹窗尺寸改自适应 `min(480px,85vw)/min(640px,70vh)` 等，小窗口不再裁掉二维码区④状态行透出 guest 页面 console 报错（诊断二维码不渲染）
- 诚实声明：崩溃根因未 100% 确证（无受控复现）；若修复后仍崩，下一步依次排除：移除整个 did-navigate 门禁 → 移除登录轮询的 executeJavaScript → 移除 useragent 覆盖
- 证据：build exit 0（main.js 47.2kb）、72/72 测试通过、已部署 vault（01:54）

## ADR-012 登录窗口改为常驻浮层（2026-09-15，基于社区证据包）

- 研究证据（public-source-researcher，13 来源）：Electron 修复记录 #38996（close 回调里移除 webview 致崩）/ #38603（close+reparent UAF）与本项目 3 次恒定偏移 0x80000003 APPCRASH 同构——崩溃源即 a58bf2a 引入的 onClose reparent；Surfing（PKM-er/Obsidian-Surfing，社区参考实现）从不把 webview 放 Modal、从不迁移存活节点、导航只用 setAttribute("src") 从不用 loadURL；Obsidian 1.13.7 会按 partition 装 webRequest 钩子改写 UA（useragent 属性不可靠，社区为此有 webview-ua-override 插件）
- 变更：`RedNoteLoginModal`（Obsidian Modal）→ `RedNoteLoginOverlay`（document.body 常驻 div；开/关仅切 visibility；隐藏用 visibility:hidden 保布局）；webview 构建时一次性挂入、此后零节点迁移；仅插件卸载时 dispose；main.ts 卸载顺序 overlay → session
- api.ts：移除 useragent 属性与 CHROME_UA 常量；forceBackHome 仅 setAttribute("src")（保留 250ms 延迟 + 1.5s 限频）；新增 `destroyed` 监听 → 引用失效、下次惰性重建（Surfing 模式）
- 二维码 `Failed to fetch` 判定为网络层问题：系统代理 127.0.0.1:7890（Clash）确认开启，webview 会话走系统代理，小红书接口经境外节点被断；用户侧动作：Clash 为 `*.xiaohongshu.com`、`*.xhscdn.com` 配置直连（或临时关代理验证）
- 证据：build exit 0（main.js 47.9kb）、72/72 测试通过、已部署 vault

## ADR-013 登录页迁入 workspace leaf（2026-09-15，第三次架构修正）

- 第十轮结果：自绘浮层（visibility 切换方案）在点击关闭时再次崩掉 Obsidian——这次**无 WER 主进程记录**（与前三代 0x80000003 不同），疑为渲染进程死亡；结论：自管理容器的每种关闭/隐藏手段（reparent、visibility、display 踢、关闭回调刷新设置页）都在踩 Electron webview 生命周期雷，防不胜防
- 决策：**放弃一切自绘容器**，登录页改为 workspace 标签页（ItemView）——即 Surfing 参考实现的宿主模式：Obsidian 全权管理生命周期，插件零关闭代码；标签页占满编辑区、可弹出独立窗口任意拉大（满足用户"用整个窗口"诉求）
- 关闭标签页销毁 webview 是设计内行为：登录态存于 persist 分区磁盘；session 的 `destroyed` 监听将引用置空，同步时惰性重建 webview（免登录）
- 保留：登录检测（无签名 selfinfo 优先 + lastCheckInfo 透出状态行）、设置页即时刷新（deferred setTimeout）、resize kick + 元素自检
- 流程事故记录：089bae2 提交时 tsc 类型错误被 `| tail` 管道吞掉退出码导致旧产物入库；已改为显式退出码检查（BUILD_EXIT=0 才继续），079c3ea 为首个有效构建

## ADR-014 本地签名算法移植 + 登录页高度修复（2026-09-15，2d61580）

- 背景：真机证实 2026 年小红书页面 window 上不存在签名函数（getSign 页面探测恒空）→ 同步与签名版 selfinfo 全挂；`wl is not defined` 报错系页面自身噪音（状态行转播所致，非插件 bug）
- 决策：移植 **xhshow**（MediaCrawler 现行生产签名库，MIT）的纯本地算法为 `src/rednote/sign.ts`：X-S/X-T/x-s-common 从 a1+b1+uri+data 本地计算；黄金向量与 xhshow Python 源码输出**逐字节一致**（GET/POST/b1/x-s-common），新增 12 单测（共 84/84）
- **b1 结论**：b1 不在 cookie 而在页面 `localStorage.getItem("b1")`；读取失败时本地合成（指纹 JSON → RC4(key=xhswebmplfbt) → 百分号编码重组 → 自定义 base64）
- getSign 新顺序：eval 读 a1(localStorage b1) → 本地签名 → 页面函数回退 → 双失败 SignError；GET 查询编码改 `quote(safe=',')` 配对签名串
- 高度根因：CSS 类 `height:100%!important` 压过内联 px；修复=去 !important + applySize 测 contentEl 写三层内联 px + 清除容器离屏内联样式（必要配套，否则页面整体不可见）
- **已知风险（真机验证焦点）**：xhshow 文档提示 ~2026-03 起部分接口对 XYS_ 格式 X-S 返回 406，需 XYW_（AES-128-CBC）变体——未移植，若同步报 406 再补；localStorage.b1 是否存在未验证

## ADR-015 XYW_ 签名变体与误报修正（2026-09-15，9ad7007）

- 真机证据链闭环：用户已登录（页面探测 true）但同步的 XYS_ 签名请求 collect/page 被拒（success:false→被误报"登录失效"）→ 与 xhshow 文档"2026-03 起部分接口拒 XYS_、需 XYW_"吻合
- 移植：XYW_（AES-128-CBC，key/IV 为 xhshow 硬编码常量，纯 TS FIPS-197 实现保持同步接口）——与 xhshow **真实包**重跑黄金向量 6/6 逐字节一致（非镜像脚本）；XYS_ 保留备用；上轮中断尝试遗留的 AES 明文填充 bug（应 pad base64 文本字节而非解码原文）一并修复
- request() 增加 REQ 级日志（uri/status/code/success 全留痕）；runSync 的 NotLoggedInError 先页面探测再决定是否翻转登录态（杜绝"登录失效"误报）
- 证据：build exit 0、89/89 单测（+5 XYW）、已部署 vault
- 最终未知数（诚实）：服务端是否接受 XYW_ 待真机同步实测，debug.log 的 REQ 行会直接给出答案
