# 手算出怪帧：完整口径（客户端 2.7.71 / versionCode 190）

这一页是**唯一**的手算说明书：只用关卡配置里的字段，按下面的顺序算，就能得到这个网页
显示的那些帧号。所有常数都来自客户端出货 `libil2cpp.so`（ARM64）与实机逐帧采集，出处写在
本文末尾的「证据表」里；凡是还只是推断的，都标了 `candidate`。

> 记号：**帧** = 30Hz 的整数逻辑帧（`fixedFrameCnt`），**第一帧 = 0s0f**，`Xs Nf` = `X*30+N` 帧。
> 毫帧 `mt` = 1/1000 帧（客户端用 `0.001` 粒度累加时间，见 `milliFrames()`）。
> 一局开始的 `fixedFrameCnt = 0`，之后每个逻辑帧 +1。

---

## 0. 一句话流程

```
对每一波 wave（按配置顺序）：
    波次门下界        cursor = max(cursor, 该波"上一波离场帧 + 1"的下界)
    波次起点          cursor = cursor + round(wave.preDelay * 30)
    对每个 fragment（按配置顺序）：
        队列起点      processStart = cursor
        建队列        fragment.actions[] 逐条 → SPAWN/PREVIEW_CURSOR 按 count/interval 展开
                      → 合成 autoPreviewRoute / autoDisplayEnemyInfo → 按时间排序
        排空队列      逐条：等到它的时间 → 执行（占 1 帧）→ 时钟前进
        fragment 结束 cursor = 最后一条实际帧 + 2
下一波 wave 的门 = 上一波全部敌人离场帧 + 1（页面里可手填，默认取离线真值表的下界）
```

---

## 1. 用到的字段

| 字段 | 位置 | 含义 |
| :--- | :--- | :--- |
| `wave.preDelay` | `waves[i].preDelay` | 该波开始前等待（秒）。**带它时首 fragment 有 1 帧的尾部重合**，见 §3.3 |
| `fragment.preDelay` | `waves[i].fragments[j].preDelay` | 该 fragment 的第一条条目的基准偏移（秒） |
| `actions[].preDelay` | `waves[i].fragments[j].actions[k].preDelay` | 相对 fragment 起点的偏移（秒） |
| `actions[].actionType` | 同上 | 索引 0=SPAWN、1=PREVIEW_CURSOR、2=STORY…（本文关心 SPAWN / PREVIEW_CURSOR / DISPLAY_ENEMY_INFO） |
| `actions[].count` / `interval` | 同上 | 只有 SPAWN / PREVIEW_CURSOR 是"多条"：第 n 条 = `t0 + round(interval*30*n)` |
| `actions[].key` | 同上 | 敌人 id。**`_delayToBorn` 就按它查** |
| `actions[].routeIndex` | 同上 | 走哪条 `routes[]`（分支波次走 `extraRoutes[]`） |
| `actions[].autoPreviewRoute` | 同上 | true 时客户端**额外**造 2 条 `PREVIEW_CURSOR`（本文的"路径预览"） |
| `actions[].autoDisplayEnemyInfo` | 同上 | true 时额外造 1 条 `DISPLAY_ENEMY_INFO`（开场那个敌人提示） |
| `actions[].hiddenGroup` | 同上 | 隐藏波次组名；没勾选时这条**整条不存在**（后面的条目因此整体前移） |
| `actions[].blockFragment` | 同上 | 阻断计数（`m_blockCounter > 0` 时该 fragment 不结束），影响后续 fragment 的起点 |
| `branches[key].phases[]` | 关卡根 | 分支波次，形状与 `waves[].fragments[]` 相同 |

---

## 2. 每一条队列条目的时间

设 `fragPre = round(fragment.preDelay * 30 * 1000)`（毫帧，下同），`actPre = round(action.preDelay*30*1000)`：

```
base = fragPre + actPre                     # 该 action 的基准时间
SPAWN:              delay = _delayToBorn(key)          # 秒 → 毫帧，见 §3.4
                    base = max(base - delay, 0)
                    第 n 条：time = base + round(interval*30*1000) * n     # n = 0..count-1
PREVIEW_CURSOR:     time = base + round(interval*30*1000) * n
                    注意：客户端对 actionType==1 会**无条件覆写** count=2、interval=0.3s（§3.1）
其它（STORY / DISPLAY_ENEMY_INFO / …）：time = base
```

合成条目（客户端在 `_DealAction` 里现场造的，配置里没有）：

```
autoPreviewRoute == true  →  2 条 PREVIEW_CURSOR，time = base - 3.0s，再 +0.3s
                             （它们**建在已经减过 delayToBorn 的 base 上**，不继承 key）
autoDisplayEnemyInfo == true → 1 条 DISPLAY_ENEMY_INFO，time = max(base - delay, 0)
                             （继承 key，递归时**再减一次** delayToBorn）
```

---

## 3. 队列怎么排空（这一步决定了"谁会推迟谁"）

### 3.1 排序
一个 fragment 的条目先按 **配置数组序** 追加，再对整个 `List` 调 `List<T>.Sort`，比较器**只看时间**
（相等时由 Mono 的 introsort/快排决定，等键也会交换）。本文网页用的就是这套 Mono 排序语义
（`orderQueue(..., 'mono_qsort')`）。同刻条目顺序**不能**按文件序想当然。

### 3.2 每条条目占几帧
队列逐条推进，每条：

```
等待 = (本条时间 - 上一条"已执行"条目的时间 <= 0) ? 0 : max(1, round(等待毫帧 / 1000))
        # 第 0 条的上一条时间取字面量 0.0（不是 processStart）
实际帧 = 时钟 + 等待
时钟   = 实际帧 + 1        # 客户端执行完这条要 yield 一次 ⇒ 每条自己占 1 帧
```

所以「同刻的两个条目」会落在**连续两帧**（CE-5 开局三条盾卫实测 0/1/2）。

### 3.3 两处固定帧数（会被误当成"误差"）

* **fragment 交接 = 2 帧**：一条队列排空后，下一个 fragment 的第一条要等 2 帧
  （`<_DealFragment>` 结束后 `_DealWave` 才恢复）。所以 `cursor = 上一 fragment 最后一条实际帧 + 2`。
* **波次尾部重合 = 1 帧**：`wave.preDelay > 0` 的波次，其**首 fragment 的最后一个合成条目**
  不计自己那一帧（六条实测帧把这一帧的位置钉死，机制解释仍为 `candidate`）。
  `wave.preDelay == 0` 时**没有**这件事。

### 3.4 `_delayToBorn`：敌人自己的"提前量"
客户端对每条 SPAWN 做 `t = max(t - Enemy._delayToBorn, 0)`（ARM64 `0x27e3600 fsub` + `0x27e3604 fmax`），
值来自敌人 prefab 的 `Torappu.Battle.Enemy._delayToBorn`，按 `action.key` 查 `m_enemyMap`。

* 表里 2105 个 prefab 有该字段，**164 个非零**（1.0 / 1.333 / 2.0 / 2.5 / 3.0 秒…）。
* 0-x / 1-x 的敌人全是 0；**1049 / 3876 个关卡**至少引用到一个非零敌人。
* **变体 id 要走 base 回退**：关卡 `action.key` 可能是 `enemy_2133_shdopl_b`，而 prefab 与
  `enemyDbRefs` 落的是 `enemy_2133_shdopl`。查表顺序 = 精确 → 去掉 `_b`/`_2`/`_3` 这类后缀再查。
  不兜底会让 IS6「畸症」首怪晚 30 帧（配置 10s vs 实测 9s01f），预览也晚 30 帧（实测 6s00f）。

### 3.5 波次门（第 2 波起）
每一波开始前，客户端还要等上一波"打完"：门 = **上一波全部敌人离场帧 + 1**（下界）。
网页里这一列可以手填；不填时用的是离线真值表（该波所有敌人 `end`/`leak` 的最大帧 + 1）。
`maxTimeWaitingForNextWave` 存在时，超时的 fragment 会被跳过（页面会标出来）。

### 3.6 隐藏组与分支
* `hiddenGroup` 没勾 → 那些 action 整条不存在，**后面的条目整体前移**（不是把时间空出来）。
* 分支波次从**触发帧**（运行时由技能/脚本给出，网页里手填）开始，各 `phase` 顺序排空，
  路由下标是 `extraRoutes` 的**绝对下标**。触发帧不可静态得知 ⇒ 那些行标 `candidate`。

---

## 4. 四个可对照的手算样例

### 4.1 0-1「坍塌」（`obt/main/level_main_00-01.json`）
`wave0.preDelay=0`；frag0 是一条 STORY；frag1 `preDelay=2.0`，含
`DISPLAY_ENEMY_INFO(pre=3.0)` + `SPAWN(pre=3.0, autoPreviewRoute, count=1)`。

| 队列 | 条目 | 时间(mt) | 实际帧 |
| --- | --- | --- | --- |
| — | frag0 STORY | 0 | 0（frag0 结束 → 游标 0+2=2） |
| q0 | 合成预览 seq1 | 60000 | **62** = 2s02f ✓实测 |
| q1 | 合成预览 seq2 | 69000 | 72 |
| q2 | DISPLAY_ENEMY_INFO | 150000 | **154** = 5s04f ✓实测 |
| q3 | SPAWN 源石虫 | 150000 | **155** = 5s05f ✓实测（用户标注 100% 正确） |

手算 q0：`processStart=2`，第 0 条等待 `round(60000/1000)=60` → `2+60=62`；
q2：`154 = 72 + 1 + 81`（+1 是 q1 自己那帧，81 = `round(81000/1000)`）；
q3 与 q2 同刻 → 不等，只吃 q2 的 +1 帧 → 155。

### 4.2 9-11「拉锯」（`obt/main/level_main_09-09.json`，注意文件名与关卡号差 2）
`wave0.preDelay=3.0`（⇒ 首 fragment 有 1 帧尾部重合）、frag0 `preDelay=3.0`，
两条 SPAWN（`pre=3.0`、`pre=11.0`，都 autoPreviewRoute，count=1）。

| 队列 | 条目 | 时间(mt) | 理想 | 实际帧 |
| --- | --- | --- | --- | --- |
| q0 | 合成预览 seq1 | 90000 | 180 | **180** = 6s00f ✓实测 |
| q1 | 合成预览 seq2 | 99000 | 189 | **190** = 6s10f ✓实测（q1 尾部重合，不吃自己那帧） |
| q2 | SPAWN 深池侦察兵 | 180000 | 270 | **271** = 9s01f ✓实测 |
| q3 | SPAWN 第二只 | 420000 | 510 | **512** = 17s02f ✓实测 |

`wave.preDelay=3.0` ⇒ `waveStart = 90`；`q0 = 90 + 90 = 180`；`q2 = 190 + 81 = 271`。

### 4.3 16-3「道路以目」（`obt/main/level_main_16-02.json`）—— `_delayToBorn` 的实机对照
`wave0.preDelay=0`、frag0 `preDelay=2.0`；`SPAWN(pre=3.0, key=enemy_1109_uabone)`，
该敌人的 `_DelayToBorn = 1.5` 秒 ⇒ `base = 150000 - 45000 = 105000`。

| 队列 | 条目 | 时间(mt) | 实际帧 |
| --- | --- | --- | --- |
| q0/q1 | 合成预览 ×2 | 15000 / 24000 | 15 / 25 |
| q2/q3 | 配置里的 PREVIEW_CURSOR ×2 | 60000 / 69000 | 62 / 72 |
| q4 | SPAWN | 105000 | **109** = 3s19f |

**实机（演习，逐帧内存采集）：首怪 = 110**（模型 109，差 1 帧）。不扣 `_DelayToBorn` 会算成
154（5s04f），差 45 帧 —— 这就是"配置写着 5s、实际 3.6s 就出来"的那类关卡的真正原因。

### 4.4 IS6「畸症」（`obt/roguelike/ro6/level_rogue6_b-6.json`）—— 用户报的那个矛盾
`wave0.preDelay=0`、frag0 `preDelay=7.0`，首条可出的 SPAWN 是
`action1: pre=3.0, key=enemy_2133_shdopl_b`。配置直读是 `7+3 = 10s`，但：

```
enemy_2133_shdopl_b → base 回退 → enemy_2133_shdopl 的 _DelayToBorn = 1.0s
base = 300000 - 30000 = 270000 mt → 首怪 9s0xf，合成预览 = 270000-90000 = 180000 → 6s00f
```

| 队列 | 条目 | 时间(mt) | 实际帧 |
| --- | --- | --- | --- |
| q0 | 合成预览 seq1 | 180000 | **180** = 6s00f（早于 fragment 的 7s 窗口） |
| q1 | 合成预览 seq2 | 189000 | **190** = 6s10f |
| q2 | SPAWN 杀人兔 | 270000 | **272** = 9s02f（用户实测约 9s） |

"路径预览早于 predelay"不是 bug：预览 = SPAWN − 3s，而 SPAWN 自己被 `_DelayToBorn` 提前了 1 秒。

---

## 5. 手算清单（照着做）

1. `waveStart = 前一次游标 + round(wave.preDelay * 30)`（第 0 波前一次游标 = 0）。
2. 逐 fragment：`processStart = 当前游标`。
3. 逐 action 算 `base = round(fragment.preDelay*30*1000) + round(action.preDelay*30*1000)`；
   SPAWN 再 `- _delayToBorn`（**变体 id 先剥后缀**）；
   SPAWN/PREVIEW_CURSOR 按 `count`/`interval` 展开；`autoPreviewRoute` 补 2 条 −3s/+0.3s 的预览；
   `autoDisplayEnemyInfo` 补 1 条同刻的 DISPLAY。
4. 整队按时间排序（等键用 Mono 排序语义）。
5. 逐条排空：`等待 = (t - 上一条已执行 t <= 0) ? 0 : max(1, round(dt))`；`实际帧 = 时钟 + 等待`；
   然后 `时钟 = 实际帧 + 1`。首 fragment 且 `wave.preDelay > 0` 时，最后一条**合成**条目跳过那个 +1。
6. `游标 = 最后一条实际帧 + 2`（fragment 交接）。
7. 下一波开始前先取 `max(游标, 上一波离场帧 + 1)`。

## 6. 最容易算错的地方

| 坑 | 正确做法 |
| :--- | :--- |
| 把 `interval` 当成"每条间隔帧数" | 第 n 条 = `round(interval*30*1000)*n` 毫帧后再取整 |
| 认为同刻条目顺序 = 文件序 | 客户端用的 `List<T>.Sort`（Mono introsort 变体），等键会交换 |
| 忘了每条自己那 1 帧 | 每条 = 等待 + 1 帧（CE-5 0/1/2 是硬证据） |
| 忘了 fragment 交接 2 帧 | 上一 fragment 排空后 +2 帧才是下一条 |
| 直接读 `7s+3s=10s` | 先查 `_delayToBorn`（含变体回退），再减 |
| 预览按配置读 count/interval | actionType==1 时客户端强制 `count=2, interval=0.3s` |
| 隐藏组"留空时间" | 没勾的 action 不存在，后面整体前移 |
| 第 2 波起用配置时间当起点 | 门 = 上一波全部离场 + 1，是下界 |

## 7. 证据表（版本 2.7.71 / 190）

| 结论 | 配置字段 / 资源 | 客户端静态证据 | 脚本 · 产物 | 置信度 |
| :--- | :--- | :--- | :--- | :--- |
| 30Hz 整数帧、`fixedFrameCnt` 每帧 +1 | — | `BattleController::OnTick` ARM64 `0x2515428`（`0x2515580 add w8,w8,#1`） | `tools/collect_exercise_track.py`（`time_basis = client fixedFrameCnt`） | client_static_verified + live_verified |
| 波次起点 = `round(preDelay*30)` | `waves[].preDelay` | `<WaitForPredelay>d__15` `0x27e9950` → `AsyncUtil::WaitForFixedSeconds` `0x24f07ec` | `docs/02-knowledge/spawn-schedule.md` §9g-9 | client_static_verified |
| 每条条目占 1 帧、等待 = `max(1,round(dt))` | — | `<_ExecuteActionQueue>d__17::MoveNext` v7a `0x1796a00`（`0x1796d54 vsub` / `0x1796d60 bl WaitForFixedSeconds` / `0x1796ef8` yield） | `tools/test_spawn_timeline_golden.py`、CE-5 实测 0/1/2 | client_static_verified + live_verified |
| fragment 交接 2 帧 | — | `<_DealFragment>d__122::MoveNext` `0x27eba34`（`0x27ebd30` 的 `WaitWhile(m_blockCounter>0)`） | 0-1 154/155、1-12 1464/1465 实测 | client_static_verified |
| `PREVIEW_CURSOR` = SPAWN − 3s、+0.3s、count 强制 2 | `autoPreviewRoute` | `Scheduler::_DealAction` `0x27e3738`（−3s）与 `0x27e35a4-0x27e35c8`（覆写 count/interval） | `artifacts/client-2.7.71/il2cpp/preview-cursor-executor-evidence.json` | client_static_verified |
| `t = max(t - _delayToBorn, 0)`（SPAWN 专用） | `action.key` → prefab `Enemy._delayToBorn` | `_DealAction` `0x27e3600 fsub` / `0x27e3604 fmax`；`_CreateEnemyItem` v7a `0x1788ecc` | `artifacts/client-2.7.71/enemy-delay-born-global.json`（2105 prefab / 164 非零） | client_static_verified |
| 变体 id 用 base 的该字段 | 同关 `enemyDbRefs` 用 base id | 同一张 `m_enemyMap` 按 `action.key` 查 | 畸症实测 6s/9s；16-3 实测 110 vs 模型 109 | live_verified（2 关）/ candidate（"为什么客户端给变体复用 base"更细的链路） |
| 波次门 = 上一波离场 + 1 | `wave.maxTimeWaitingForNextWave` | `<_DealWave>d__121` `0x27eb13c` / `0x27eb198` | `artifacts/client-2.7.71/wave-clear-frames.json`；网页"波次门"输入框 | client_static_verified + live_verified（0-2 14/14） |
| 分支触发帧 | `branches[key].phases[]` | `Scheduler` 分支记录（运行时） | 网页分支选择 + `tools/test_branch_waves.py` | candidate（触发帧是运行时的） |
