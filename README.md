# StoryForge CE · 故事熔炉

> AI 辅助小说创作工作台。纯前端、本地优先、提示词全透明，让作者掌控从灵感、设定、大纲到正文、审校、导出的一整条创作链路。

本仓库是 StoryForge CE 的源码分发版，面向**本地部署**：只包含可运行的源码，不包含开发文档、自动化测试与桌面版外壳。

CE 分支只做长篇小说的 AI 辅助创作，重点在四件事：**生成前把要求谈清楚**、**让主 Agent 能真正操作项目**、**把参考地图变成可复用的事实**、**在正文里就地记录**。逐项说明见[本分支的主要改进](#本分支的主要改进)。

本版本基于 StoryForge 3.9.1 分支开发，不含原项目的跑团等游玩功能。与原项目的关系、边界与出处见[版本说明](#版本说明与原项目关系)。

---

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Zustand](https://img.shields.io/badge/Zustand-5-brown)
![Dexie](https://img.shields.io/badge/Dexie.js-IndexedDB-orange)
![TipTap](https://img.shields.io/badge/TipTap-Editor-purple)
![PWA](https://img.shields.io/badge/PWA-Offline-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## English TL;DR

**StoryForge CE** is a local-first, browser-based AI writing studio for long-form fiction.

- **Local-first by default**: manuscript data lives in the browser's IndexedDB. AI calls, cloud backup, or custom proxy/base URLs send only the relevant content to the third-party service configured by the user.
- **Bring your own AI**: supports many OpenAI-compatible providers, Anthropic Claude, Gemini, local models, and custom endpoints.
- **No black box**: prompts are visible, editable, cloneable, parameterized, and reusable.
- **Built for long stories**: multiworld settings, story arcs, foreshadowing, state cards, item ledger, temporal facts, retrieval memory, chapter review, style learning, and export/backup workflows.
- **What this branch focuses on**: negotiating requirements before generation, a master agent that operates the project after your confirmation, map facts derived from your own reference images, sticky notes inside the editor, and one unified runtime log. See [本分支的主要改进](#本分支的主要改进).

```bash
npm install
npm run dev      # http://localhost:1111/storyforge/
npm run ci       # schema / architecture / source / dependency / lint / typecheck / build / bundle budget
```

本仓库只分发源码，`npm run ci` 不包含自动化测试步骤。

---

## 目录

- [项目定位](#项目定位)
- [本分支的主要改进](#本分支的主要改进)
- [核心能力](#核心能力)
- [功能全景](#功能全景)
- [AI 与提示词系统](#ai-与提示词系统)
- [数据与安全边界](#数据与安全边界)
- [技术架构](#技术架构)
- [快速启动](#快速启动)
- [构建与验证](#构建与验证)
- [适合谁](#适合谁)
- [仓库结构](#仓库结构)
- [版本说明与原项目关系](#版本说明与原项目关系)
- [License](#license)

---

## 项目定位

StoryForge 不是“一键生成完本小说”的黑箱工具，而是给作者使用的 AI 创作工坊：

| 目标 | StoryForge 的做法 |
|---|---|
| 作者掌控创作 | 所有 AI 输出都经过预览、编辑、采纳；AI 是助手，不直接替作者定稿 |
| 提示词可见可改 | 每个 AI 功能背后的 System Prompt、User Template、参数和示例都能查看与克隆 |
| 长篇设定不散 | 世界观、角色、大纲、伏笔、状态、物品、事实、故事线都进入结构化本地数据库 |
| 资料能反哺写作 | 项目参考、历史资料、文风学习、场景考证可进入后续 AI 上下文 |
| 数据本地优先 | 默认无 StoryForge 后端；项目数据存在用户浏览器 IndexedDB |

---

## 本分支的主要改进

下面这些能力是 CE 分支在原项目 3.9.1 基础上持续打磨的部分，也是本版本与上游最直观的差异。

### 生成前协商：先谈清楚，再动笔

正文生成不再是「点一下、等结果」的单向管道，而是四步协商：

1. 先产出**可编辑的本章写作摘要**，作者可以直接改；
2. 可选一轮 **AI 提问**（最多 4 个问题、每题最多 6 个候选），模型只问真正拿不准的走向——这场戏放哪、谁在场、要不要新增道具，作者点选或自写答案，也可以整轮跳过；
3. AI **申报所需资料与写作计划**，未登记、不可用或被截断的项会如实列出；
4. 作者确认后，最终提示词由**代码确定性装配**，发送前仍可预览并逐字修改。

协商只会**追加**默认源清单，不会悄悄删掉本该读的上下文；中间产物都是界面状态，不写库、切章即丢弃。大纲展开与正文生成都保留发送前的提示词预览，正文在此之上多一层协商，作者始终清楚「这次到底给了模型什么」。

### 主 Agent 可以真正操作项目

主 Agent 从「只会回答」扩展到「能读写项目」：按注册表读取设定、大纲、章节与地图事实，提出创建或修改候选，**经作者确认后才采纳**。

- 两种执行模式：**现有路由优先**（沿用既定功能路由，稳定可预期）与**主 Agent 优先**（由主 Agent 自行规划步骤与工具调用），可随时切换。
- 主 Agent 的**步数与工具调用上限**可调，长任务不会失控，成本也不会悄悄涨。
- 长任务有**断点快照**：任务中断或取消后可以接着跑，不必从第一步重来；任务状态区分「等待确认 / 已采纳 / 已驳回」，不会把半成品当成已完成。快照随当前会话保存，刷新页面即重新开始。

### 正文写作体验

- **按章排队的自动保存**：每章各自持有一份待写正文，切章时先落盘上一章，因此在新章继续输入不会覆盖上一章；单章写入失败只重排该章，不牵连其他章。
- **排版偏好全局生效**：字体、字号、行距、段距一次设置、跨章保持、刷新不丢。
- 续写、润色、扩写、去 AI 味、审校都保留发送前预览与逐段采纳。

### 便签系统

正文上可以直接贴便签，不必另开一个笔记页：

- 便签可拖动、缩放、置顶、缩小、删除，位置以正文纸张为原点，可以拖到两侧空白；随正文滚动，始终对着你正在写的那一段。
- **每章便签**只在所属章出现，**通用便签**每章都在；删章时章节便签自动转为通用便签并保留内容，不会跟着章节一起消失。
- 输入先同步显示再落库，中文输入法组词过程中不会被旧写入覆盖。
- 主 Agent 可以通过采纳流程创建和修改便签，但尺寸是作者专属字段，不开放给 AI。

### 地图系统

地图从「生成一张示意图」变成「原图 + 标注 + 已确认事实」：

- 上传参考原图后，可在原图上标注地点、区域、路线与关系，标注支持保存、撤销、删除和审核状态。
- AI 可以按整图或**手动框选的区域**提出「疑似遗漏」「位置或文字冲突」「布局优化」候选，每条都能定位到原图局部；**AI 结果只是候选，不覆盖作者标注，也不会自动写进世界观**。
- 作者确认后的地图事实**独立于原图存在**：原图丢失或换版本，已确认的数据仍可编辑、导出、参与地图问答与重新生成。
- 附带本地 OCR（可商用开源的 Tesseract.js）作为核对线索，识别出的文字不会被当成事实。

### 统一运行日志

原来的三套并行日志和散落各处的裸 `console` 调用，收口成**一个事件形状、一个落盘管道**：

- 按天写 txt、定期 flush、有界保留；网页版写到用户绑定文件夹下的 `log/` 子目录，桌面版写应用目录。
- **隐私收口**：日志只记 ID、字段名、坐标与规模，不把原始错误字符串、章节标题写进日志内容。
- 「数据管理」里有日志状态卡：开关、落盘位置、下载本次会话日志，排查问题不必开控制台。
- 新增功能必须接入同一套日志标签，避免再长出第二套。

### 更自由的设置

- **任务级模型路由**：不同 AI 任务可以各自指定模型与参数，不必全站共用一个配置。
- **上下文预算可调**：预算策略与预设都能改，能直观看到每次生成实际用了多少上下文。
- **主 Agent 可调**：执行模式、步数上限、工具调用上限都在设置里。
- 主题与正文排版偏好全局持久，换章不重置。

---

## 核心能力

### 从灵感到项目

- 首页管理所有小说项目，支持新建、删除、从本地文件夹恢复。
- 项目概况维护名称、简介、流派、目标字数、写作状态与多世界开关。
- 灵感反推支持把短梗、片段、想法反推为故事核心、世界观、角色、大纲等可采纳结构。
- 项目参考支持故事参考、风格参考、历史资料，以及上传后的多维分析。

### 设定库

- 多世界总览：管理世界组、世界关系、主世界和跨世界结构。
- 真实与幻想：按维度声明哪些内容取自真实、哪些允许架空改造，给历史考证和架空创作共同使用。
- 世界观：世界起源、自然环境、人文环境、历史年表、世界地图。
- 故事设计：一句话故事、故事概念、主题、核心冲突、故事模式、主线、复线。
- 角色设计：角色生成、主要角色、次要角色、NPC、路人、关系网。

### 创作区

- 创作规则：写作风格、叙事视角、基调、禁忌、一致性规则和参考作品注入。
- 大纲：卷/章树、AI 生成卷纲、章节展开、章节预览。
- 角色驱动：根据人物动机、关系和弧光反推剧情推进。
- 故事线：主线/支线、阶段卡、进度和 AI 生成。
- 章节：章节列表、TipTap 正文编辑、自动保存、续写、润色、扩写、去 AI 味、审校、便签。
- 伏笔：伏笔类型、埋设/呼应/回收状态、紧急度、看板和 AI 建议。
- 文风学习：从已写章节与作者确认的改前/改后短样本提取画像，并通过互动校准持续反哺后续生成。
- 重要地点：地点树、标签、层级关系和地点资料。
- 状态表：角色、地点、物品、势力等状态卡和事件时间线。
- 物品栏：追踪物品获得、持有、转移、消耗等账本。
- 事实库：章节正文中抽取的时序事实候选，支持确认/否决后用于长期一致性。
- 故事年表：按章节和剧情时间记录全局事件。
- 场景考证：结合世界观、历史年表和规则检查具体场景细节。

### 提示词库与工作流

- 模板管理：系统模板、用户模板、参数、示例/反例、实时预览。
- 题材包：历史、仙侠、言情、现实主义、悬疑推理等风格可热切换。
- PromptRunPanel：运行时调参、临时改 prompt、流式输出、采纳、标记好/坏示例。
- 工作流：把多个 AI 步骤串起来，支持从故事核心到世界观、角色、大纲、章节的自动编排和写回。

### 导入、导出与备份

- 文档解析：上传或粘贴文本，分块解析为当前项目设定或项目参考。
- 大文档流水线：Blob 持久化、断点续跑、暂停/取消、日志追踪、角色去重合并。
- 数据管理：JSON 完整备份、Markdown/TXT/HTML 导出、本地文件夹自动备份、GitHub Gist 云备份。
- 版本历史：自动快照与手动快照，恢复时创建新项目，避免覆盖当前稿件。
- 消耗统计：按项目或全局查看 AI 调用次数、token 和估算费用。

---

## 功能全景

当前侧边栏由 5 个一级模块组成：

| 一级模块 | 二级入口 |
|---|---|
| 著作信息 | 项目概况、灵感反推、项目参考 |
| 设定库 | 世界总览、真实与幻想、世界起源、自然环境、人文环境、历史年表、世界地图、故事设计、角色生成、主要角色、次要角色、NPC、路人、关系网 |
| 创作区 | 创作规则、大纲、角色驱动、故事线、章节、伏笔、文风学习、重要地点、状态表、物品栏、事实库、故事年表、场景考证 |
| 提示词库 | 模板、题材包、参数、示例/反例、工作流 |
| 设置区 | 版本历史、文档解析、数据管理、消耗统计、设置 |

---

## AI 与提示词系统

StoryForge 的 AI 能力分成三层：

1. **上下文装配**：根据当前任务读取项目概况、世界观、角色、大纲、伏笔、状态、事实、参考资料等内容。
2. **提示词渲染**：用模板变量、条件块、参数开关和 few-shot 示例生成最终 prompt。
3. **结构化采纳**：AI 输出不会直接变成事实，用户确认后才写入字段、集合或章节正文。

### 支持的 AI Provider

设置页内置的 provider 包括：

| 类型 | Provider |
|---|---|
| 国际/聚合 | OpenAI、Anthropic Claude、Google Gemini、Poe、NVIDIA NIM |
| 国内云服务 | DeepSeek、通义千问、豆包、智谱 GLM、文心一言、Kimi、MiniMax、ModelScope、Agnes AI、LongCat、OpenCode Go |
| 本地/自定义 | Ollama、LM Studio 等 OpenAI-compatible 本地服务、自定义 Base URL |

国内或浏览器 CORS 受限的服务可通过本地 Vite 代理转发；自定义接口只要兼容 OpenAI `chat/completions` 即可接入。

### 提示词模板能力

```ts
renderPrompt(template, context, {
  parameterValues,
  overrides,
})
```

| 能力 | 说明 |
|---|---|
| `{{var}}` | 模板变量替换 |
| `{{#if var}}...{{/if}}` | 条件块 |
| 参数控件 | select、slider、number、text、boolean |
| 示例/反例 | 好示例和坏示例自动拼入 prompt |
| 克隆编辑 | 系统模板可克隆为用户模板后自由修改 |
| 工作流写回 | 多步生成结果可自动写回故事、角色、大纲、伏笔等目标 |

---

## 数据与安全边界

StoryForge 是纯前端项目，没有自建应用后端。

| 数据/动作 | 去向 |
|---|---|
| 项目数据 | 默认保存在浏览器 IndexedDB |
| AI API Key | 默认 sessionStorage；用户显式“记住本机”才写 localStorage |
| GitHub PAT | 默认 sessionStorage；用户显式“记住本机”才写 localStorage |
| AI 生成 | 会把相关上下文发送到用户配置的 AI 服务 |
| Gist 云备份 | 会把完整项目 JSON 上传到用户自己的 GitHub 私密 Gist |
| 本地文件夹备份 | 通过浏览器 File System Access API 写入用户授权的本地目录 |
| 运行日志 | 写入应用目录或用户绑定文件夹下的 `log/` 子目录，按天 txt；只记 ID、字段名、坐标与规模，不写正文和章节标题 |

生产环境检测到 IndexedDB schema 缺表时不会自动删库；开发环境才允许自动 reset。启动期会申请浏览器持久化存储，降低 IndexedDB 被浏览器清理的风险。

---

## 技术架构

### 从存储到用户价值的六层架构

StoryForge 按“底层能力向上支撑用户价值”的方向分为六层。UI 只表达用户意图和确认；AI 读、AI 写与表生命周期分别收口到三个注册表，不允许面板各自形成平行管线。

代码中同时体现 `PROJECT_TABLES` 的映射、统一 AI 读写主路径和全部受治理表的领域分布。对应实现见 [`src/lib/registry`](./src/lib/registry)、[`src/lib/db/schema.ts`](./src/lib/db/schema.ts) 与 [`scripts/check-architecture.mjs`](./scripts/check-architecture.mjs)。

### 三个注册表

项目扩展必须收口到三个单一事实源：

| 注册表 | 负责 |
|---|---|
| `CONTEXT_SOURCES` | AI 读什么，上下文如何装配 |
| `FIELD_REGISTRY` + `ADOPTION_SCHEMAS` | AI 写什么，采纳时如何校验与去重 |
| `PROJECT_TABLES` | 表生命周期，导出/导入/删除/迁移如何覆盖 |

三张注册表分别是 `src/lib/registry/context-sources.ts`、`src/lib/registry/field-registry.ts` 与 `src/lib/registry/adoption-schema.ts`、`src/lib/registry/project-tables.ts`。扩展数据表或 AI 可写字段时必须同时更新对应注册表，否则 `npm run check:architecture` 与 `npm run check:required-tables` 会失败。

---

## 快速启动

### macOS / Linux / Windows 通用

```bash
git clone https://github.com/boksheep/storyforgeCE.git
cd storyforgeCE
npm install
npm run dev
```

打开：

```text
http://localhost:1111/storyforge/
```

### Windows 零基础用户

1. 在本仓库页面下载 `Source code (zip)`。
2. 解压后进入包含 `package.json` 的目录。
3. 安装 Node.js LTS：https://nodejs.org/
4. 双击 `启动.bat`（会自动检查 1111 端口、执行 `npm run dev` 并打开浏览器）。

也可以手动在项目目录打开 PowerShell，执行 `npm install` 和 `npm run dev`，再访问 `http://localhost:1111/storyforge/`。

> 请始终使用 `localhost:1111` 这一个地址。浏览器按 origin（协议 + 域名 + 端口）隔离存储，换成 `127.0.0.1` 或换端口会被当作另一个站点，看起来就像手稿丢了。

详细图文步骤见 [使用npm指令启动项目.md](./使用npm指令启动项目.md)。

### 部署到网页云端（纯静态）

需要一个能直接上传到 Vercel / Netlify / Cloudflare Pages / 自建 nginx 的独立版本时：

```bash
npm run package:web
```

得到 `release/storyforge-web-<版本>/`（站点 + 各平台部署配置 + 部署说明）与同名 `.zip`。
这个版本构建在**域名根路径** `/` 下，与默认构建（`/storyforge/`，服务既有线上部署与桌面版）
互不覆盖。想先在本机看效果：`npm run preview:web`。

⚠️ 用户手稿存在各自浏览器的 IndexedDB 里，**换域名等于换数据源**，
迁移请用应用内的「导出 / 导入项目 JSON」。

---

## 构建与验证

常用命令：

```bash
npm run dev            # 开发服务器 http://localhost:1111/storyforge/
npm run build          # 生产构建，输出 dist/
npm run preview        # 预览生产构建
npm run build:web      # 根路径 / 的静态站点，输出 dist-web/
npm run package:web    # 打包成可上传的站点压缩包，输出 release/
npm run preview:web    # 本地预览网页云端版
```

质量闸门（也是 CI 跑的那一套）：

```bash
npm run check:required-tables      # 表注册完整性
npm run check:architecture         # 三注册表反模式守卫
npm run check:source-reachability  # 孤儿源码文件
npm run check:dependencies         # 生产依赖漏洞
npm run lint                       # ESLint 零 warning
npm run ci                         # 以上 + tsc + build + 体积预算
```

改动涉及数据表、AI 读写、导出导入、删除或迁移时，必须让 `npm run ci` 全绿后再提交。

---

## 适合谁

| 适合 | 不适合 |
|---|---|
| 想掌控提示词和 AI 输出的小说作者 | 只想一键生成完整小说的人 |
| 长篇、系列文、多世界、群像创作者 | 不愿维护设定和大纲的人 |
| 想沉淀个人题材包、风格模板、工作流的人 | 需要多人实时协作和云端团队权限的人 |
| 想把资料、考证、参考作品纳入写作流程的人 | 希望所有数据都托管在官方后端的人 |
| 希望本地优先、可换模型、可自定义接口的人 | 不想配置任何 AI Key 或本地模型的人 |

---

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/` | 应用源码（React + TypeScript） |
| `public/` | 静态资源，含本地 OCR 运行时与语言数据 |
| `scripts/` | 构建与质量闸门脚本 |
| `index.html` | 应用入口 |
| `vite.config.ts` | 构建、PWA 与开发代理配置 |
| `启动.bat` | Windows 一键启动 |
| `使用npm指令启动项目.md` | 零基础启动图文说明 |
| `LICENSE`、`THIRD-PARTY-NOTICES.md`、`third-party-licenses/` | 许可与第三方版权声明 |
| `SECURITY.md` | 漏洞报告与响应流程 |

本仓库**不包含**开发文档、自动化测试、桌面版（Electron）外壳与构建产物。

---

## 版本说明与原项目关系

本版本是**基于 StoryForge 3.9.1 衍生的分支开发版本**，与原项目已经是两条独立的演进路线：目标不同，功能范围也不同，不能当作同一项目的不同版本看待。

- **专注范围**：只优化长篇小说 AI 辅助创作的体验——设定库、大纲、章节写作、一致性审校、导入导出与备份这条链路。
- **不包含**：原项目中的跑团等额外游玩功能；也不支持脱离作者判断的纯 AI 批量成稿。
- **边界承诺**：原项目后续更新中与小说创作无关的内容，本分支不会引入，这条边界不会改变。

两个项目可以各自独立安装使用，但手稿数据互不相通——浏览器按 origin（协议 + 域名 + 端口）隔离存储，迁移只能通过应用内的「导出 / 导入项目 JSON」。

原项目与作者：

- 作者 GitHub：https://github.com/yuanbw2025
- 原仓库：https://github.com/yuanbw2025/storyforge

---

## License

本项目沿用上游 StoryForge 的 [MIT License](./LICENSE)：可以自由使用、复制、修改、分发和商用，包括闭源商用。

按 MIT 的要求，分发时需保留版权与许可声明。本仓库的 `LICENSE` 同时列明两段版权：

- `Copyright (c) 2026 yuanbw2025` —— 上游 StoryForge 原作者；
- `Copyright (c) 2026 boksheep` —— StoryForge CE 分支的修改部分。

如果你分发的是构建产物（网页包），除 `LICENSE` 外还要一并保留 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) 与 [`third-party-licenses/`](./third-party-licenses)：地图识字功能随包分发了 Tesseract.js、tessdata_fast 等 Apache-2.0 组件，那份声明不能删。构建时 `scripts/prepare-map-ocr.mjs` 会自动把这两份文件复制到站点根目录。
