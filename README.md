# 日志与项目管理（LPM）

**一个轻量的本地「项目计划 + 甘特图」工具**：像 Microsoft Project 那样排计划、拖甘特图、跟进度、算积分，
但**不用安装、不用配置、双击打开浏览器就能用**；另外顺带带了一个**日志**功能（周历写工作日志 + 待办清单）。

> 一句话差别：Project 功能很全但重，**这个只做你真正会用到的那部分**，而且把「日志 → 待办 → 计划 → 进度 → 积分」
> 串成了一条线 —— 记下来的事能直接变成计划里的任务，不用在两个软件之间搬数据。

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933)
![SQLite](https://img.shields.io/badge/SQLite-single%20file-003B57)
![Frontend](https://img.shields.io/badge/React-18-61DAFB)
![Backend](https://img.shields.io/badge/Fastify-5-000000)

---

## 拿到手就能用（不用装任何东西）

**把这个仓库下载 / clone 下来，双击 `启动.bat` 就能用。** 仓库里已经自带全部运行要件：

| 自带的东西 | 作用 |
|---|---|
| `node/` | 便携 Node 运行时（Windows 用 `node\node.exe`）→ **目标电脑不用装 Node** |
| `backend/node_modules/` | 依赖库 → **不用联网 `npm install`** |
| `backend/dist/`、`frontend/dist/` | 已经编译好的程序 → **不用自己编译** |
| `data/app.db` | 一份**演示库**（张三 / 李四 / 王五）→ 打开就有东西看，随时可换成自己的数据 |

```text
1) 点 GitHub 右上角 Code → Download ZIP（或者 git clone）
2) 解压整个文件夹 → 双击「启动.bat」
3) 等几秒，浏览器自动打开 http://localhost:5174
4) 用完关掉网页即可（90 秒后自动保存退出）；想立刻停就双击「停止.bat」
```

> - 只想**看代码 / 自己改**：源码在 `backend/src`、`frontend/src`，改完按下面「方式二」重新编译。
> - 仓库一次性下载约 120 MB（大头是便携 Node 运行时和依赖库），**下完整个文件夹拷到任意位置都能用**，不用再联网。

## 它是什么

说到排项目计划，多数人的第一反应是 **Microsoft Project**：确实全，但**装起来重、界面陡、授权还贵**；
而很多时候你要的只是把「谁、什么时候、做什么、做到多少」排清楚，再能一眼看出整体进度。

这个工具就是奔着这个场景做的：**把 Project 里最常用的那一小块抽出来，做成一个打开浏览器就能用的轻量本机程序。**

它跟一般项目管理工具不一样的地方在于 —— **它本来就是管工作日志的**，顺手把日志里的待办变成了项目计划：

```text
   日志页                     待办栏                    项目页                     人员页
┌──────────────┐        ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ 本周干了什么  │  ───►  │ 要做 / 谁负责 │  ───►  │ 排时间、甘特图│  ───►  │ 工作量 + 积分│
│ （周日历）    │        │ 值多少积分    │        │ 调进度        │        │ 流水 / 柱状图│
└──────────────┘        └──────────────┘        └──────────────┘        └──────────────┘
                        「→计划」一键转成任务      进度自动折算积分          按人 / 按项目汇总
```

**一件事从「记下来」到「排进计划」再到「算进绩效」，在这一套里是连贯的**，不用换软件、不用重录。

它**不追求联网协作**，设计取向正好相反：

| 取向 | 说明 |
|---|---|
| 轻量、单机、离线 | 数据在本机一个 SQLite 文件里；不需要服务器、不需要账号、不联网也能跑 |
| 免安装运行时 | 离线包自带便携 Node，目标电脑**连 Node.js 都不用装** |
| 拷走就能用 | 整个文件夹（含 `data/`）复制到别的电脑，双击即可继续用 |
| 不污染系统 | 不写注册表、不建计划任务、不开机自启；关掉网页 90 秒后服务自己退出 |

---

## 功能一览

打开是一个「工作台」，底部是一排**工作表**（可随时新建、拖动排序、右键改名/复制/删除）——
**想分几块就开几张表**，互不干扰。三块核心能力：

| 工作表 | 能干什么 |
|---|---|
| **项目（主力）** | 任务列表（13 列，列宽可拖）+ **甘特图**（计划条 / 实际条 / 进度百分比，左右分栏可拖）；任务可拖动排序、可折叠子任务、可「推迟」改计划时间；**「进展」滑块拖到 0% / 100% 会弹窗二次确认**，并联动「实际开始 / 实际结束时间」 |
| **日志（顺带带的）** | 周日历式写工作日志（每周高度可拖拽调节，双击复位）；右侧**待办栏**：负责人 / 积分 / 完成时间 / 建立时间，未办 ☐ 已办 ☑，可拖动排序，**一键转成项目计划任务** |
| **人员** | 人员管理 + 工作量柱状图（每件事一种颜色，按项目分组，可切 14/30/90 天）+ 积分流水 |

通用能力：

- **整库 Excel 导入导出**：每个表一个 sheet，导出后用 Excel 就能看；导入支持「合并（按 id 覆盖）」与「清空后导入」，导入前自动备份
- **回收站**：删除都是软删除，可**恢复**或**彻底删除**（含连带子项与悬空引用清理）
- **操作历史**：每次改动的 before/after 都留痕（默认保留最近 500 条）
- **自动保存**：输入后 0.5 秒落盘，切窗口/切工作表光标离开也会 flush；顶部有保存状态指示
- **自动备份**：点「备份」把数据库整份复制到 `data/backups/`，自动保留最近 20 份
- **关页自动退出**：页面每 10 秒发一次心跳，后端连续 90 秒收不到心跳就**先落盘再退出**（`PRAGMA wal_checkpoint` + 断开连接）

积分规则（`backend/src/lib/points.ts`）：

- 待办完成 → 拿该待办设定的积分
- 项目任务 → **总积分 × 完成百分比**，可选「阶梯计分」（只有满 10% 的整数倍才计分）
- 所有变动都写 `points_ledger` 流水，任务删除后**已得积分保留**

---

## 界面结构

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 导出Excel 导入Excel 备份 历史      保存状态 ● 已保存                  │  顶部工具栏
├───────────────────────────────────────────────┬──────────────────────┤
│                                               │                      │
│   当前工作表内容                               │   待办栏（日志表才有）│
│   · 日志 = 周日历 + 待办                       │   未办 ☐ / 已办 ☑    │
│   · 项目 = 任务列表 ∥ 甘特图（中间竖条可拖）    │   负责人 / 积分      │
│   · 人员 = 人员卡片 + 工作量柱状图 + 流水       │   完成时间           │
│                                               │   →计划（转项目任务）│
├───────────────────────────────────────────────┴──────────────────────┤
│ 日志 │ 项目计划 │ 人员 │ ＋        底部工作表栏（可拖动排序）        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 方式一：直接双击（推荐，目标电脑什么都不用装）

```
1) 把整个文件夹拷到目标电脑（U 盘 / 共享都行），或者从 GitHub 下载 ZIP
2) 双击「启动.bat」
3) 等几秒，浏览器自动打开 http://localhost:5174
4) 用完直接关掉网页即可（90 秒后服务自动保存退出）；想立刻停就双击「停止.bat」
```

仓库/离线包比纯源码多三样东西：`node/`（便携 Node 运行时）、`backend/node_modules/`（依赖库）、
以及构建好的 `dist/`。自己打包看 `package_win.py`。

### 方式二：从源码运行

需要 **Node.js 18+**（前后端都用同一个）。

```bash
# ── 后端 ──
cd backend
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm run db:push             # 建表：prisma db push + prisma generate
npm run build               # tsc → dist/

# ── 前端 ──
cd ../frontend
npm install
npm run build               # vite → dist/

# ── 启动（回到仓库根目录）──
node "_lpm_start.js"        # 或双击「启动.bat」（Windows）
# 浏览器打开 http://localhost:5174
```

### 开发模式（改代码即时生效）

```bash
# 终端 1：后端热跑（tsx）
cd backend && npm run dev            # http://localhost:3000

# 终端 2：前端 vite dev server（已配好 /api 代理到 3000）
cd frontend && npm run dev           # http://localhost:5174
```

### 常用脚本

| 位置 | 命令 | 作用 |
|---|---|---|
| `backend` | `npm run dev` | tsx 直跑 TS 源码（开发用） |
| `backend` | `npm run build` | `tsc` 编译到 `dist/` |
| `backend` | `npm run db:push` | 把 Prisma schema 推到 SQLite 并生成 client |
| `frontend` | `npm run dev` | Vite 开发服务器 |
| `frontend` | `npm run build` | 打包到 `frontend/dist/` |
| `frontend` | `npm run serve` | 用 `serve.js` 单独起静态服务 + `/api` 反代 |

---

## 启动脚本说明

| 文件 | 平台 | 作用 |
|---|---|---|
| `启动.bat` | Windows | 找 Node（先找便携运行时 `node\node.exe`，找不到用系统装的）→ 交给 `_lpm_start.js` → 起服务并自动开浏览器 → 校验 5174 是否真的在监听，没起来就提示看日志。**这个文件是纯 ASCII + CRLF：中文 Windows 的 cmd 按 GBK 读批处理，文件里只要有 UTF-8 中文就会整份解析失败**（报一串 "'xxx' 不是内部或外部命令"）|
| `停止.bat` | Windows | 只结束占用 `3000` / `5174` 端口的进程，**不动你机器上其它 node 程序** |
| `_lpm_start.js` | 跨平台 | 用 `detached` 起后端 ⇒ **没有黑窗口**；已在运行则不重复启动、只开页面；关网页 90 秒后自动退出 |

> `_lpm_start.js` 也直接用 `node "_lpm_start.js"` 跑（Linux/macOS 用这条）。
> 脚本里的提示文字是 ASCII 英文，是为了避免 `cmd.exe` 读 UTF-8 中文 batch 出现乱码 —— 中文文档看这份 README。

---

## 数据存在哪（备份 / 搬迁 / Excel）

```
data/app.db            ← 所有数据就这一个 SQLite 文件
data/backups/          ← 点「备份」生成的副本，自动保留最近 20 份
```

- **换电脑 / 搬家**：把整个文件夹（含 `data/`）拷过去即可；只想搬数据就带上 `data/`
- **换数据库位置**：新建工程时程序会问你选哪个位置；`backend/.env` 里的 `DATABASE_URL` 是默认值
- **导入导出**：程序内「导出 Excel」把整库导成一个 xlsx（每表一个 sheet），「导入 Excel」选回来即可复原（导入前自动备份）

数据库表结构在 `backend/prisma/schema.prisma`：
`TableMeta`（工作表）、`LogEntry`（日志）、`Todo`（待办）、`Project` / `ProjectTask`（项目与任务）、
`Person`（人员）、`PointsLedger`（积分流水）、`ChangeHistory`（操作历史）、`ImportExportJob`（导入导出作业）。

---

## 目录结构

```text
lpm/
├── 启动.bat / 停止.bat        # Windows 一键启动 / 停止
├── _lpm_start.js             # 无窗口启动器（跨平台）
├── node/node.exe              # 便携 Node 运行时（目标电脑不用装 Node）
├── data/app.db                # 数据库（自带一份演示库）
├── backend/
│   ├── prisma/schema.prisma   # 数据模型
│   ├── src/
│   │   ├── app.ts             # Fastify 装配
│   │   ├── lib/               # prisma / 静态托管 / 备份 / 积分 / 历史 / 日期
│   │   └── routes/            # tables logs todos people projects recycle data workspace heartbeat
│   └── package.json
└── frontend/
    ├── index.html             # 含老浏览器 polyfill 引用
    ├── serve.js               # 零依赖静态服务 + /api 反代（备用）
    └── src/
        ├── App.tsx            # 外壳（工作表栏 / 工具栏 / 保存状态）
        ├── components/        # Workbench / SheetTabs / SaveStatus
        ├── pages/             # LogCalendar ProjectPlan PeopleStats RankChart RecycleBin ...
        └── utils/             # autosave / confirm（自建确认框）/ dragSort
```

---

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript 5（前后端同一套） |
| 后端 | Fastify 5 + Prisma 6 + Zod 3 + xlsx |
| 前端 | React 18 + Ant Design 5 + `@dnd-kit`（拖拽排序）+ SVAR React Gantt（甘特图） |
| 构建 | Vite 5 + tsc |
| 数据库 | SQLite 单文件（`data/app.db`），无需数据库服务 |
| 端口 | 后端 `3000`；单进程模式用 `5174`（`LPM_PORT`）同时托管页面与接口 |

---

## 跨平台说明

- **后端 / 前端源码是跨平台的**：没有写死的 `C:\` 路径，全部走 `path.join`；数据库是 SQLite 文件
- **`启动.bat` / `停止.bat` 是 Windows 专用的**（`taskkill` / `netstat`）；Linux/macOS 直接用 `node "_lpm_start.js"` 启动、`kill` 对应端口停止
- **`node_modules` 不能跨系统复制**：Prisma 的查询引擎按平台下载（schema 里声明了 `binaryTargets = ["native", "windows"]`），换系统后重新 `npm install` 即可，源码不用改
- 便携 Node 运行时（`node/`）也是分平台的：Windows 是 `node.exe`，其它系统放 `node/node`

---

## 老浏览器兼容（Edge 84 / Chromium 84）

这个工具**刻意支持很老的 Chromium（已在 Edge 84.0.522.52 上实测）**，因为有些内网机器就是老浏览器。
踩过的坑都写成代码注释留在仓库里，主要有：

1. `intl` / 现代语法 → `frontend/public/polyfills.js` 打底，Vite 目标降到 `es2019`
2. Ant Design 5 的 `:where()` 需要 Chromium 88+、`inset` 简写需要 87+ → 样式里全部有兜底
3. **`Modal.confirm` 在老浏览器上离场动画不触发** → 弹窗永不卸载、留一层全屏遮罩吃掉所有点击
   → 改成自建 `utils/confirm.tsx`（零动画、关闭即真正卸载）
4. 甘特图左侧列表与右侧时间轴**行高必须严格一致**，否则逐行错位（详见注释里的实测数值）

---

## 已知限制

- 单机单人设计：没有登录、没有多用户并发控制（`users` 表未启用）
- 表头固定依赖 `position: sticky`，部分很老的 Chromium 内核下不生效
- 「进展」滑块只在**鼠标松开 / 触屏抬起**时提交；用键盘方向键改值不会落库
- 老浏览器上首次打开需要 Ctrl+F5 强刷才能拿到新构建（`index.html` 已设 `no-store`，正常刷新即可）

---

## 许可

[MIT](LICENSE) —— 随便用、随便改、可商用，保留版权声明即可。
