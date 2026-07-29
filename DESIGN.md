---
name: 排期工具
description: 本地优先的甘特图排期桌面工具，飞书/Notion 式克制界面
colors:
  accent: "#3370ff"
  accent-deep: "#2860e0"
  ink: "#1d2129"
  ink-secondary: "#4e5969"
  ink-tertiary: "#86909c"
  canvas: "#f7f8fa"
  surface: "#ffffff"
  surface-raised: "#fafbfc"
  border: "#e8eaef"
  border-strong: "#dcdfe6"
  grid: "#f1f2f5"
  weekend: "#f9fafb"
  today: "#ff7d00"
  today-tint: "#fff7e8"
  danger: "#f53f3f"
  success: "#00b42a"
  warn: "#ff7d00"
  role-plan: "#2f6fe8"
  role-art: "#ec4899"
  role-coder: "#0ea5e9"
  role-tech-plan: "#a855f7"
  role-tech-art: "#575ae8"
  role-anim: "#f59e0b"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 700
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "11px"
    fontWeight: 600
  data:
    fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
  chip-role:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "0 10px"
---

# Design System: 排期工具

## 1. Overview

**Creative North Star: "安静的日历" (The Quiet Calendar)**

这是一个单人使用的排期工具，界面哲学是**工具隐形**：一切视觉决定都为"看清时间、拖动任务"服务。中性色承载 95% 的界面——近白的画布、极浅的分隔线、三级灰阶文字；唯一允许发声的颜色是信息本身：八个职能色标记工作归属，橙色标记"今天"与冲突，红色标记关键路径。参照 Things / Linear 的克制：层级靠间距与字重建立，不靠边框堆叠；没有渐变、没有玻璃拟态、没有装饰性动效（这些是 PRODUCT.md 点名的反面参照）。

密度取"中"：40px 行高的任务列表可一屏承载 15+ 任务，同时留足点击目标。所有动效为状态反馈服务，150–250ms，指数缓出，并尊重 `prefers-reduced-motion`。

**Key Characteristics:**
- 中性画布 + 信息色：颜色只表达职能归属与时间状态
- 层级靠间距/字重，边框只用 1px 极浅线
- 直接操纵优先：拖动、双击、右键；弹窗是最后手段
- 阴影极轻，仅表达"浮起"状态（悬停、弹窗、菜单）

## 2. Colors

中性灰阶为体，职能八色与状态三色为声。

### Primary
- **操作蓝 Accent** (#3370ff)：主按钮、选中态描边、依赖拖线预览、聚焦环。只用于"可交互/已选中"，永不装饰。深一档 (#2860e0) 为悬停态。

### Secondary（任务职能六色，用户可在设置页面增删改）
- **策划 蓝** (#2f6fe8)、**美术 粉** (#ec4899)、**程序 天蓝** (#0ea5e9)、**技术策划 紫** (#a855f7)、**技术美术 靛** (#575ae8)、**动画 橙** (#f59e0b)。职能色只出现在任务条、节点、图例色点、依赖标签色点——即"这条工作属于谁"的场合。用户自定义色以数据中保存值为准。
- **条内文字自动选色**：任务条上的名字按背景亮度在白 (#fff) 与近黑 (#10131a) 之间取对比度更高者——浅色条（橙/绿/青/粉/紫）自动换深字，深色条（GD蓝/TA靛/灰）保持白字。

### Tertiary（状态色）
- **今天橙** (#ff7d00)：今日竖线、日历今日徽标、冲突警告 ⚠、未保存提示。
- **危险红** (#f53f3f)：关键路径描边与连线、删除操作、里程碑默认色。
- **成功绿** (#00b42a)：Toast 成功图标，仅此一处。

### Neutral
- **墨 Ink** (#1d2129)：正文与标题。
- **次级灰** (#4e5969)：辅助文字、按钮文字。
- **三级灰** (#86909c)：占位、时间轴刻度、依赖连线默认色。
- **画布** (#f7f8fa) / **表面** (#ffffff) / **浮起表面** (#fafbfc)：页面底、卡面、表头。
- **边线** (#e8eaef) / **强边线** (#dcdfe6) / **网格线** (#f1f2f5) / **周末底** (#f9fafb)。

### 交互 Tint 色阶（合法的派生色，不算游离色值）
- **蓝系交互底**：#f2f6ff（依赖标签底）→ #f0f4ff（悬停）→ #e8f0ff（选中底）→ #e4ecff（按压）→ #dbe7ff（选中行/标签边）。
- **红系警示底**：#fef0f0（危险悬停底）→ #fde8e8（移除钮悬停）→ #fcc（危险边）。
- **橙系冲突底**：#fff9f0 / #fef3e6（冲突行）。
- **文字级深色变体**：危险文字 #d92b2b、今日徽标底 #c25400（分别保证白底/白字 ≥4.5:1；描边与填充仍用 --danger / --today 原色）。
- **微圆角谱系**：2/3/4/5/7/9/14/20px 用于色点、任务条、菜单、胶囊等小构件，属于刻度内的细分档，不视为脱离 6/8/12 主刻度。

### Named Rules
**The Color-Is-Data Rule.** 任何色相的出现必须回答"它编码了什么信息"（职能归属 / 时间状态 / 交互态）。回答不出来的颜色一律退回中性灰。
**The Legible-Small-Gray Rule.** 三级灰 (#86909c) 只允许出现在 ≥12px 的纯装饰性文字上；任何承载信息的小字（刻度、计数、表头、日期）必须用次级灰 (#4e5969) 起步。

## 3. Typography

**Body Font:** system-ui 栈（SF Pro Text / PingFang SC / Microsoft YaHei）
**Data Font:** SF Mono / Cascadia Code / Consolas（表格数字用 `tabular-nums`）

**Character:** 单一系统字族多字重承载全部层级，工具感、零加载成本；中文环境下苹方/雅黑保证跨设备一致。

### Hierarchy
- **Title** (700, 14px)：工具栏标题、弹窗标题。
- **Body** (400–500, 12.5–13px)：任务名、表单、菜单项。
- **Label** (600–700, 11px)：列表表头（大写+字距）、图例、统计栏、依赖标签。
- **Data** (400, 10.5–11px, tabular-nums)：日历刻度、日期列。

### Named Rules
**The One-Family Rule.** 不引入第二字族。层级用字重（400/500/600/700）与两级字号差表达。

## 4. Elevation

系统默认全平面：静止元素之间用 1px 浅边线和表面色差（#fff vs #fafbfc）分层，不用阴影。阴影只表达"浮起"这一状态变化，共三档。

### Shadow Vocabulary
- **xs** (`0 1px 2px rgba(0,0,0,.04)`)：任务条静止态的最低限度实体感。
- **sm** (`0 2px 8px rgba(0,0,0,.06)`)：悬停反馈。
- **md** (`0 6px 20px rgba(0,0,0,.10)`)：弹窗、右键菜单、Toast、拖拽中的任务条——真正浮在页面之上的东西。

### Named Rules
**The Flat-At-Rest Rule.** 表面静止时是平的。阴影是对状态（悬停/拖拽/浮层）的响应，不是装饰。

## 5. Components

### Buttons
- **Shape:** 轻圆角（6px），高 32px。
- **Default:** 白底 + 1px 强边线 + 次级灰文字；悬停浅灰底并上浮 1px。
- **Primary:** 操作蓝底白字，悬停加深并带蓝晕；一屏至多一个。
- **Danger:** 红字白底，悬停红晕底。
- **Focus:** 3px 蓝色聚焦环（`--ring`），键盘可见。

### Segmented Control（日/周/月）
- 浅灰槽 + 白色活动片，活动片带 1px 投影与加粗蓝字。

### Chips
- **职能图例 chip:** 胶囊形（20px），色点 9px + 职能名 + 计数；选中态蓝框浅蓝底。
- **依赖标签 chip:** 胶囊形（14px），浅蓝底 + 职能色点 + × 移除钮。

### Inputs / Fields
- **Style:** 1px 强边线、6px 圆角、高 32–36px、白底。
- **Focus:** 边线变蓝 + 2px 蓝晕（`rgba(51,112,255,.12)`）。
- **Disabled:** 浅灰底、三级灰字、`not-allowed`。

### Dialogs / Menus
- 12px 圆角、md 阴影、遮罩 35% 黑 + 2px 背景模糊；入场 180–220ms 缩放淡入。

### Gantt Bar（签名组件）
- 任务条：22px 高、5px 圆角、职能色填充，白色 35% 叠层表达进度；两端 8px 隐形拖柄悬停显形。
- 父任务汇总条：10px 灰条 + 两端下垂三角，名称 700 字重居中悬于条上方。
- 里程碑：18px 旋转 45° 圆角方块，职能色。
- 依赖线：1.4px 灰虚线贝塞尔曲线 + 实心箭头；关键路径升级为 2.2px 红。

## 6. Do's and Don'ts

### Do:
- **Do** 让颜色只编码信息：职能归属、时间状态、交互态（The Color-Is-Data Rule）。
- **Do** 用间距和字重建立层级；边框永远是 1px 且 ≤ #dcdfe6 深度。
- **Do** 保持正文对比度 ≥4.5:1（#1d2129 on #ffffff = 14.9:1；#4e5969 on #ffffff = 7.6:1）。
- **Do** 为每个动效提供 `prefers-reduced-motion` 降级（已全局实现）。
- **Do** 让新交互先考虑"能否在图上直接拖/点"，弹窗是最后手段。

### Don't:
- **Don't** 引入渐变、玻璃拟态、装饰性动效——PRODUCT.md 反面参照「营销页语言」。
- **Don't** 堆叠工具栏按钮或增加配置项——反面参照「重型项目管理软件」。功能进入右键菜单或快捷键，而不是常驻按钮。
- **Don't** 用 border-left 色条作为强调手段；选中态用 inset box-shadow 蓝条（现有实现）是唯一例外且已封顶。
- **Don't** 给静止元素加阴影（The Flat-At-Rest Rule）。
- **Don't** 引入第二字族或在 UI 标签中使用展示字体（The One-Family Rule）。
