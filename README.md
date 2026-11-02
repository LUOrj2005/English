# 词镜 WordLens · 英语学习工作台

一个本地运行的英语学习工具：AI 词典、文档中英对照、生词本。数据保存在本地 SQLite 数据库，查词时先查数据库，命中就直接返回，未命中才调用 AI 并写入数据库。

## 功能

- **AI 词典**：音标、释义、词根构词、派生词（同根词）、近义词、反义词、例句、常见搭配，支持朗读。
- **派生词链式查询**：点击派生词 chip 直接查询该词，可顺着词根一路展开。
- **数据库优先**：查过的词存入 SQLite，下次查询直接读库，不重复消耗 AI 额度。
- **自定义词典**：支持上传 CSV / TSV / TXT / JSON 词典到本地数据库，查词时优先命中自定义词典，未命中再走 AI；可随时清空。
- **间隔重复复习**：闪卡按 SM-2 变体调度（忘记 / 模糊 / 记得 / 简单），到期词自动进入今日队列，间隔达到 21 天自动标记「已掌握」。
- **单词测验**：英中互选、中英互选、拼写三种题型，答题结果自动回写复习进度。
- **听写模式**：系统朗读单词，凭听力拼写并在答完后核对音标与释义。
- **文档中英对照**：上传 `.txt` / `.md` / `.docx` 或直接粘贴英文 / 中文，按句或按段生成左右对照，支持批量并发翻译与进度显示。
- **中译英对照**：中文材料可输出「全文英译」，或选择「实词英译」——只把名词、动词、形容词、副词替换成英文，其余保留中文。
- **文档生词高亮**：文中已收录到生词本的单词自动标绿，点词弹层可一键加入生词本。
- **点词解释**：对照页每个英文单词都可点击，弹出词卡（带上当前句子语境）。
- **生词本**：加入/删除、新词 / 学习中 / 已掌握三档状态、筛选搜索、导出 CSV。
- **Anki 导出**：一键生成 `.apkg` 牌组（含音标、释义与例句），可导入 Anki 手机端离线复习。
- **手机端 + PWA**：响应式布局，可添加到手机桌面；界面离线可打开，查词与翻译仍需联网。
- **设置页**：在网页里配置 DeepSeek API Key、接口地址、模型名称，可测试连接、清除词卡缓存。

## 技术架构

- 后端：Node.js 原生 `http` 模块（无 Web 框架），`node:sqlite` 内置数据库，`mammoth` 解析 `.docx`，`anki-apkg-export` 生成 `.apkg`。
- 前端：纯 HTML / CSS / JS，无构建步骤；PWA 使用 manifest + Service Worker（网络优先、离线回退缓存）。
- AI：OpenAI 兼容协议，默认 DeepSeek（`https://api.deepseek.com`，模型 `deepseek-chat`）。
- API Key 只保存在服务端 `config.json`，不会下发到浏览器。

## 目录结构

```
D:\traecn
├── server.js            # HTTP 服务、AI 代理、SQLite 读写、复习调度、Anki 导出
├── config.json          # API Key / Base URL / 模型 / 端口
├── package.json
├── README.md
├── public/
│   ├── index.html       # 页面结构
│   ├── reader.html      # 对照阅读页（中文在上、英文在下）
│   ├── reader.js        # 阅读页逻辑（加载记录 / 点词查词 / 加入生词本）
│   ├── style.css        # 样式与移动端适配
│   ├── app.js           # 前端逻辑（词典 / 对照 / 复习 / 测验 / 听写）
│   ├── manifest.webmanifest  # PWA 清单
│   ├── sw.js            # Service Worker（离线缓存）
│   └── icons/           # PWA 图标 192 / 512
└── data/
    ├── wordlens.db      # SQLite 数据库（首次启动自动创建）
    └── vocab.json.bak   # 旧版 JSON 生词本备份（迁移后才会出现）
```

## 快速开始

### 环境要求

- Node.js **>= 22.5**（使用内置 `node:sqlite`；启动时的 ExperimentalWarning 可忽略）
- 可访问 DeepSeek 接口的网络

### 安装与启动

```powershell
cd D:\traecn
npm install
npm start
```

浏览器打开 <http://127.0.0.1:3000>。

若 3000 端口被占用，服务会自动尝试 3001、3002……，以控制台输出的地址为准。

### 配置 API Key

方式一：网页「设置」页填写，保存后立即生效。
方式二：直接编辑 `config.json`：

```json
{
  "apiKey": "sk-你的Key",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "port": 3000,
  "host": "127.0.0.1"
}
```

方式三：设置环境变量 `DEEPSEEK_API_KEY`（优先生效，不会写入文件）。

`baseUrl` 填任意 OpenAI 兼容地址即可切换服务商；换服务商时记得同时修改 `model`。

## 使用说明

### 词典

1. 输入单词或短语后回车（快捷键：`/` 聚焦输入框，`Enter` 查询）。
2. 首次查询调用 AI 生成词卡并写入数据库；之后同一单词直接读库。
3. 点击派生词、近义词、反义词 chip 可继续查询。
4. 「加入生词本」会保存音标与释义到数据库。

### 文档对照

1. 拖拽/选择文件，或粘贴文本（文件内容会填入文本框，可直接编辑）。
2. 选择翻译方向：`英 → 中`（默认）或 `中 → 英`；按句、按段对照任意组合。
3. 选择 `中 → 英` 时可选方式：
   - **全文英译**：整句译为自然英文。
   - **实词英译**：只把名词、动词、形容词、副词替换为英文单词，其余文字保留中文，适合逐词学习。
4. 点击「生成中英对照」，翻译按批并发执行（最多 3 批），页面显示进度与耗时。
5. 翻译完成后自动保存到数据库（documents 表）并跳转到「对照阅读页」：每句中文在上、英文在下，按段落分块；点击英文单词弹出解释，「加入生词本」后文中对应词立即高亮；已收录生词自动标绿。
6. 「文档对照」页下方的「历史记录」列出每次保存的对照（标题、方向、条数、时间），支持按标题搜索、打开阅读页、删除记录；记录长期保存在数据库中，随时可查。
7. 保存失败时（如数据库不可用）会回退为页面内左右分栏展示，不会丢失翻译结果。

支持格式：`.txt`、`.md`、`.docx`。暂不支持 PDF 与扫描件。

### 自定义词典

1. 到「设置」页的「自定义词典」面板，点击「上传词典文件」。
2. 支持格式：
   - 文本（.csv / .tsv / .txt）：每行 `单词,音标,释义`，逗号、Tab 或 `|` 分隔；只有两列时按「单词,释义」解析；多个释义用 `;` 分隔；词性可写成 `n. 放弃`。
   - JSON：`[{"word":"abandon","phonetic":"/əˈbændən/","senses":[{"pos":"v.","meaning":"放弃"}]}]`，也接受 `{"abandon":"放弃"}` 这类键值对象、单个词条对象、JSON Lines（每行一个对象），以及 `translation` / `meaning` / `def` / `senses` 等常见字段名。
3. 导入后查词顺序为：自定义词典 → AI 词卡缓存 → AI 实时生成。
4. 重复单词会覆盖释义；「清空自定义词典」只删除词典条目，不影响生词本与 AI 词卡缓存。

### 复习（闪卡）

1. 切换到「复习」页，看到期队列；首页 tab 上的数字是今日待复习数量。
2. 看单词 → 点「显示答案」→ 按掌握程度选择「忘记 / 模糊 / 记得 / 简单」。
3. 调度规则：忘记 10 分钟后再来；模糊 1.2 倍间隔；记得按 ease 倍数增长；简单增长更快。
4. 间隔达到 21 天自动标记「已掌握」并移出复习队列。

### 单词测验

- 至少需要 4 个带释义的生词；随机抽最多 10 题，题型为英中互选、中英互选、拼写。
- 每题作答后立即显示对错，并自动把结果写回间隔重复进度。

### 听写

- 随机抽最多 10 个生词，自动播放发音，可点扬声器重复播放。
- 输入答案后回车或点「提交」，核对音标与释义；答完可「再来一轮」。

### 生词本

- 状态改为「学习中」「已掌握」会自动保存到数据库。
- 支持按单词筛选、按状态过滤、导出带 BOM 的 CSV（Excel 直接打开不乱码）。
- 「导出 Anki 牌组」生成 `.apkg`：Anki 桌面端「文件 → 导入」即可，含音标、释义与最多两条例句。

### 手机端与 PWA

- 手机浏览器打开同一地址（需与电脑同一局域网时，把 `config.json` 的 `host` 改为 `0.0.0.0` 后用手机访问 `http://电脑IP:3000`）。
- 浏览器菜单选择「添加到主屏幕」，即可像 App 一样打开。
- 界面与已缓存资源离线可打开；查词、翻译、复习评分需要服务端运行并联网。

### 设置

- 「测试连接」发送一条极短请求验证 Key / 地址 / 模型是否可用。
- 「清除词卡缓存（数据库）」只清空 `word_cards` 表，生词本数据保留。

## 数据库设计

数据库文件：`data/wordlens.db`（SQLite，WAL 模式，会自动生成 `wordlens.db-wal`、`wordlens.db-shm`）。

### 表 `vocab`（生词本）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `word` | TEXT PRIMARY KEY COLLATE NOCASE | 单词，大小写不敏感唯一 |
| `phonetic` | TEXT | 音标 |
| `senses` | TEXT | 释义数组的 JSON 字符串 |
| `status` | TEXT | `new` / `learning` / `mastered` |
| `added_at` | TEXT | 加入时间（ISO 8601） |
| `last_lookup_at` | TEXT | 最近一次加入/查询时间 |
| `lookup_count` | INTEGER | 加入次数 |
| `due_at` | TEXT | 下次复习到期时间（ISO 8601），新词为加入时间 |
| `interval_days` | REAL | 当前复习间隔（天） |
| `ease` | REAL | 难度系数，初始 2.5，范围 1.3 ~ 3.2 |
| `review_count` | INTEGER | 累计复习次数 |
| `last_review_at` | TEXT | 最近一次复习时间 |

> 后五个字段由启动时自动检测并 `ALTER TABLE` 补齐，旧库无需手动迁移。

### 表 `word_cards`（词卡缓存）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `word` | TEXT PRIMARY KEY COLLATE NOCASE | 查询词 |
| `payload` | TEXT | AI 生成的完整词卡 JSON |
| `model` | TEXT | 生成时使用的模型 |
| `created_at` | TEXT | 生成时间 |

### 表 `dict_entries`（自定义词典）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `word` | TEXT PRIMARY KEY COLLATE NOCASE | 单词，大小写不敏感唯一 |
| `phonetic` | TEXT | 音标 |
| `senses` | TEXT | 释义数组的 JSON 字符串（`[{pos, meaning}]`） |
| `source` | TEXT | 导入时的文件名 |
| `created_at` | TEXT | 导入时间 |

### 表 `documents`（文档对照记录）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 记录编号，阅读页地址 `reader.html?id=N` |
| `title` | TEXT | 标题（默认取文件名或首句前 40 字） |
| `direction` | TEXT | `en2zh` / `zh2en` |
| `zh_mode` | TEXT | 中译英方式：`full` / `keywords` |
| `align` | TEXT | `sentence` / `paragraph` |
| `segments` | TEXT | 对照数组的 JSON 字符串（`[{src, out, para}]`，src 为原文、out 为译文） |
| `seg_count` | INTEGER | 对照条数 |
| `created_at` | TEXT | 保存时间 |

### 查词流程

1. `POST /api/dict` 收到 `word` → 先查 `dict_entries`（自定义词典）。
2. 自定义词典命中：直接返回 `{ source: "dict" }`。
3. 未命中 → 查 `word_cards`；命中返回 `{ source: "db" }`。
4. 仍未命中：调用 AI → 解析 JSON → 写入 `word_cards` → 返回 `{ source: "ai" }`。
5. AI 调用失败时不写库，前端显示错误，可稍后重试。

### 复习调度

采用 SM-2 变体，字段为 `due_at` / `interval_days` / `ease` / `review_count`。

| 评分 | 间隔变化 | ease 变化 | 下次到期 |
| --- | --- | --- | --- |
| `forgot`（忘记） | 归零 | -0.2 | 10 分钟后 |
| `hard`（模糊） | 上一次间隔 × 1.2（首次 1 天） | -0.15 | 按新间隔 |
| `good`（记得） | 上一次间隔 × ease（首次 2 天） | 不变 | 按新间隔 |
| `easy`（简单） | 上一次间隔 × ease × 1.3（首次 3 天） | +0.15 | 按新间隔 |

- `ease` 限制在 1.3 ~ 3.2，间隔最小 1 天。
- 间隔达到 21 天时 `status` 自动变为 `mastered`，不再进入复习队列。
- 队列条件：`status <> 'mastered'` 且 `due_at` 为空或已到期；新加入的词 `due_at` 等于加入时间，因此会立即出现在今日队列。

### 备份与重置

- 备份：停止服务后复制 `data/wordlens.db` 即可（连同 `-wal` 文件更稳妥）。
- 重置生词本：删除 `data/wordlens.db`，重启服务后自动重建空库。
- 旧版 `data/vocab.json`：首次启动会自动迁移到数据库，并重命名为 `vocab.json.bak`。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 配置状态、词卡数量、生词数量、自定义词典数量、今日待复习数量、数据库路径 |
| POST | `/api/config` | 保存 API Key / Base URL / 模型 |
| POST | `/api/dict` | 查词（自定义词典 → 词卡缓存 → AI），返回 `{ source, card }` |
| POST | `/api/ai` | 通用 AI 代理（文档翻译、连接测试使用） |
| POST | `/api/docx` | 上传 `.docx` 二进制，返回纯文本 |
| GET | `/api/vocab` | 生词本列表（含复习调度字段） |
| POST | `/api/vocab` | 加入生词本（词卡存在时自动补全音标与释义，并置为到期） |
| PATCH | `/api/vocab/:word` | 更新掌握状态 |
| DELETE | `/api/vocab/:word` | 删除生词 |
| GET | `/api/review/queue` | 到期复习队列，返回 `{ items, dueCount, total }`，可带 `?limit=` |
| POST | `/api/review/:word` | 提交评分，body `{ grade: forgot \| hard \| good \| easy }`，返回更新后的词条 |
| GET | `/api/export/anki` | 导出 `.apkg` 牌组（含音标、释义、例句） |
| POST | `/api/dictionary/import` | 上传词典文本（body 为原始文本），可带 `?name=`，返回导入/跳过/总数 |
| GET | `/api/dictionary` | 自定义词典概览：`{ count, sample }` |
| DELETE | `/api/dictionary` | 清空自定义词典，返回删除数量 |
| GET | `/api/documents` | 对照记录列表（不含正文），可带 `?q=` 按标题搜索 |
| POST | `/api/documents` | 保存对照记录，body `{ title, direction, zhMode, align, segments }`，返回 `{ id }` |
| GET | `/api/documents/:id` | 读取单条记录（含 segments 正文），阅读页使用 |
| PATCH | `/api/documents/:id` | 重命名标题 |
| DELETE | `/api/documents/:id` | 删除记录 |
| DELETE | `/api/word-cards` | 清空词卡缓存，返回删除数量 |

## 常见问题

**启动时报 SQLite ExperimentalWarning？**
Node 22 的 `node:sqlite` 仍标记为实验特性，功能正常，警告可忽略。

**提示「尚未配置 API Key」？**
到「设置」页填写后保存；或检查环境变量是否为空字符串。

**翻译很慢或费用高？**
文档翻译不走词卡缓存，按句/按段批量调用 AI。长文建议选「按段对照」，并控制上传长度。

**端口被占用？**
服务会自动顺延端口，查看控制台输出；也可修改 `config.json` 的 `port`。

**能离线使用吗？**
查词和翻译依赖 AI 接口，必须联网；已入库的词卡可离线查看（生词本与词卡都在本地数据库）。PWA 安装后界面与已缓存的静态资源可离线打开，但查词、翻译、复习评分仍需服务端运行并联网。

**Anki 牌组怎么导入？**
在生词本点「导出 Anki 牌组」得到 `.apkg`，Anki 桌面端「文件 → 导入」选择该文件；手机端可用 AnkiDroid / AnkiMobile 同步或直接导入。牌组名为「词镜」，标签为「词镜」+ 掌握状态。

**手机上怎么用？**
把 `config.json` 的 `host` 改为 `0.0.0.0` 并重启，手机与电脑连同一局域网后访问 `http://电脑IP:3000`；浏览器菜单「添加到主屏幕」即可作为 App 打开。

**导入词典失败怎么看原因？**
页面会显示失败原因（解析位置、被跳过的词条数及示例）；服务端同时把详细信息写入 `data/import.log`，控制台也会输出。常见原因是 JSON 字段名不匹配或文件不是合法 JSON（如尾逗号、JSON Lines 混用）。

**复习队列里的数字不减少？**
「忘记」的词 10 分钟后会再次到期；若显示今日队列已清空，说明所有词都已顺延到未来日期。

## 已知限制

- 句子切分基于标点规则，个别缩写（如 `Mr.`）可能被误切。
- `.docx` 仅提取纯文本，不保留图片、表格排版。
- 不支持 PDF、扫描图片文字识别。
- AI 返回偶发格式异常时，该批次会标记失败，重新生成即可。
- 复习调度按日历天计算（忘记为 10 分钟），未做逐小时精细调度。
- 「实词英译」由 AI 判断词性并替换，个别虚词或词性判断可能有偏差。
- 自定义词典只保存单词、音标、释义三类信息，不含派生词、例句与搭配。
- PWA 仅离线缓存界面与静态资源；查词、翻译、评分、Anki 导出都需要服务端在线。
- Anki 导出为一次性全量导出，导出后新加入的词需要重新导出。
