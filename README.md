# 出怪帧时间线（分发版）

客户端基线 **2.7.71 / versionCode 190** · 30Hz 整数逻辑帧 · 单文件离线网页

## 怎么用（人类用户）

1. **双击 `index.html`**（用 Chrome / Edge 80+ 打开；只要浏览器支持 `DecompressionStream`）。
   不需要装 node、python 或任何依赖，也不联网。
   同目录的 `spawn-data.js` 是内置解包配置（**配置数据单独一个文件**，约 7 MB），
   两个文件要放在一起；`src/` 只是混淆前的可读源码，删掉也不影响使用。
2. 左栏搜索框按**游戏内编号或名称**搜索：`0-1`、`坍塌`、`CE-5`、`离域检查`、`11-01` …
   （编号/名称来自 `excel/stage_table.json` 与 `excel/roguelike_topic_table.json`）
3. 点关卡 → 右栏显示：关卡名/编号、隐藏组与分支控件、以及逐条时间线。
4. 表格列：**事件 / 实际时间 / 出生点(prts.map) / 敌人 / 来源 / 路线 / 标记**。
   - 时间写成 `Xs NNf`（第一帧 = `0s 00f`），例如 0-1 第一只源石虫是 `5s 05f`（= 第 155 帧）。
   - 事件列用**原始字段名**（`SPAWN` / `PREVIEW_CURSOR` / `DISPLAY_ENEMY_INFO` …），与配置里的
     `actionType` 一一对应。
   - **鼠标悬停出生点单元格**会弹出一个小地图：只画地图 + 红门/蓝门 + 该敌人的出生点（粉框），不画路径。
5. 时间口径（消费模型 / 同刻排序）固定用模拟器默认值，页面不提供选择；
   头部也不再显示这两项。
6. 隐藏组 / 分支勾选框 = 关卡配置里的可选项，改动即时重算：
   - 取消某个隐藏组 ⇒ 该组动作**整条从队列里去掉**，后面的条目整体**提前**；
   - 分支波次用 `extraRoutes`，触发帧是运行时的（技能/脚本），所以控件只能给一个候选帧。
7. **加载其它关卡配置文件**：左侧「加载关卡 JSON」选择一个关卡 JSON
   （例如 `.gamedata-review/zh_CN/gamedata/levels/obt/main/level_main_00-03.json`），
   页面会用内置的 JS 调度核心现算帧与出生点。

## 已实现

| 能力 | 说明 |
|---|---|
| 配置 → 出怪帧 | wave → fragment → action 展开、`preDelay`/`interval` 累加、PREVIEW_CURSOR/DISPLAY_ENEMY_INFO 合成条目、fragment 边界 2 帧、每条目至少 1 帧 |
| 同刻排序 | 客户端 `List<T>.Sort` = Mono 经典快排（等键也交换），CE-5 开场三条 = 下→中→上 |
| 时间口径 | 固定用客户端复原值：`client_accumulated` 消费模型 + `List<T>.Sort`(mono_qsort) 同刻排序（对齐实机 5s 05f），页面不提供切换 |
| 出生点坐标 | prts.map 口径：字母 = 行（A = 最下一行），数字 = 列 + 1；0-1 红门 = `C9` |
| 悬停小地图 | 悬停任意一行（含“实际时间”）弹小地图：地图格子 + 红门/蓝门 + 出生点粉框，不画路径、不解释坐标系 |
| 隐藏组 / 分支 | 关卡配置里实际存在的组与分支自动生成控件 |
| 任意关卡 JSON | 内置 JS 调度核心现算（与 Python 实现逐条对拍，见下） |

## 未实现 / candidate

- **波次门（下一波等这一波怪全部离场）**：这是**运行期**行为（依赖谁什么时候死/漏），
  本页只给「配置时间轴」，不模拟战斗。要看真实推进需要联网版 `/spawn-timeline` + 模拟器。
- **分支触发帧**：`predefines.tokenInsts[].overrideSkillBlackboard` 只给出 `branch_id`，
  绝对帧由技能/脚本决定 ⇒ 控件里是候选值，所有分支行标 `candidate (trigger frame is runtime)`。
- **`dontBlockWave` / `forceBlockWaveInBranch`**：只显示，不据其改推进规则（语义未复原）。
- **节点上限**：内置 1289 关（0-x/1-x 全量 + 其它主线 + 带隐藏组/分支的关卡，按体积截断，
  截断清单见打包输出）；其余关卡请用「加载关卡 JSON」。
- **自定义文件不含分支轨**：内置核心是 Python 波次轨的移植，分支轨只在预计算的关卡里有。

## 怎么复现测试

```powershell
python tools/export_spawn_timeline_dist.py     # 重新打包（需要构建期 node + terser，见下）
python tools/test_dist_spawn_timeline.py       # 自包含 / 0-1 = 5s 05f / 出生点 C9 / 无头渲染 / 核心对拍
python tools/test_dist_core.py                 # JS 核心 vs Python build()：26 关 1295 条队列条目 0 差异
```

打包器用 terser 做 mangle+compress（**只在构建机需要**，产物不依赖）：

```powershell
cd artifacts/tmp; mkdir obf; cd obf; npm install terser@5    # 一次性
python tools/export_spawn_timeline_dist.py
```

数据以 gzip + base64 内联在 `<script id="spawn-data">` 里，页面用 `DecompressionStream` 解压；
如果没装 terser，加 `--no-obfuscate` 也能出包（只是代码不混淆）。

## 证据与出处

- 调度算术：`docs/02-knowledge/spawn-schedule.md` §8g/§8h（客户端 `_ExecuteActionQueue` / `_DealFragment` /
  `_DealWave` 的 ARM64 指令锚点）与 `tools/battle_simulator.py`
- 同刻排序：`docs/02-knowledge/spawn-schedule.md` §8f + `artifacts/queue-order-live-anchors.json`（4 组实机观测）
- prts.map 坐标口径：`tools/verify_prts_tile_labels.py` + `artifacts/prts-map-tile-labels.json`
  （前端 bundle 反混淆 + 无头 Chrome DOM 逐格对拍）
- 本页时间轴与网页版一致：`tools/test_spawn_timeline_golden.py`（101 份冻结载荷）
