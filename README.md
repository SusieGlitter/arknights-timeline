# 出怪帧时间线

客户端 **2.7.71 / 190** · 30Hz 整数逻辑帧 · 离线网页，含全部 **3876** 关。仓库：<https://github.com/SusieGlitter/arknights-timeline>

## 怎么用

1. 双击 `index.html`（Chrome / Edge 80+）。三个文件要放在同一目录，不需要装任何东西、也不联网：

   | 文件 | 作用 |
   | --- | --- |
   | `index.html` | 页面 |
   | `spawn-data.js` | 全部关卡的出怪数据 |
   | `spawn-waves.js` | 各关原始波次（勾选隐藏组 / 分支时现算用） |

2. 左栏搜索**游戏内编号或名称**（`0-1`、`坍塌`、`CE-5`、`离域检查`…），可切换范围与「只看带隐藏组 / 分支的关卡」。
   同一关的多个版本（肉鸽 DLC 等）各占一行，用文件名区分。
3. 选关卡后右栏给出逐条时间线：时间写作 `Xs NNf`（第一帧 = `0s 00f`），事件列是配置里的原始字段名（`SPAWN` 等）。
   时间线按**波次盒 → fragment 盒 → 事件行**嵌套。
4. **点任意一行**会把该敌人的出生点画到右侧地图上，数字 = 全局第几个出生；`Ctrl` 单行切换，`Shift` 整段多选。
5. 隐藏组 / 分支勾选框、分支触发帧、波次门（「上一波结束帧」）都可改，改完即时重算。
6. 左侧「加载关卡 JSON」可以加载你自己的关卡配置文件。
7. 右上角 GitHub 图标是仓库地址；推送到 `main` 后由 GitHub Actions 自动发布（线上 <https://susieglitter.github.io/arknights-timeline/>）。

## 说明

- 敌人 prefab 的 `_delayToBorn`（客户端 `Scheduler::_DealAction` 的 `max(t - v, 0)`）也算在内：2105 个 prefab 里 164 个非零，**1049 个关卡**的生成帧因此比不带该修正时早若干帧；0-x/1-x 全 0 不受影响。
- 帧数由客户端配置 + 复原出来的调度算术算出（`preDelay` 累加、同刻 Mono 快排、每条目至少 1 帧、fragment 边界 2 帧）。
- 波次门默认取「上一波全部敌人离场 + 1 帧」（离线模拟真值表；多波关因此比「末怪 + 1」更晚），页面上也可以手改；分支触发帧仍属运行期候选值，行上有标注。
- 想复核数字：`python tools/test_dist_all_levels.py`、`python tools/test_dist_spawn_timeline.py`、`python tools/test_dist_core.py`。
