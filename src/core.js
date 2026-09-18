/* 出怪帧计算核心（客户端 2.7.71 / 190）—— tools/battle_simulator.py 的逐行移植。
 *
 * 为什么可以移植而不必内嵌 Python：这套规则是一小段整数算术——
 *   _DealAction 展开 fragment 的 action 队列 → List<T>.Sort（Mono 经典快排，
 *   等键也交换）→ _ExecuteActionQueue 逐条目消费（每条目至少 1 帧，
 *   fragment 边界固定 2 帧）。
 * 移植的每个函数都带客户端地址/证据出处，且由 tools/test_dist_spawn_timeline.py
 * 与 Python 的 tools/spawn_timeline.build() 逐条对拍（差异必须为 0）。
 */
(function (global) {
  'use strict';
  var HZ = 30, MF = 1000;
  var QUEUE_ENTRY_YIELD_FRAMES = 1;      // <_ExecuteActionQueue>d__17 每条目执行后 yield 一次
  var FRAGMENT_HANDOFF_FRAMES = 2;       // fragment 排空 → 下一 fragment 恢复的固定帧数
  var UNMODELLED_ENTRY_FRAMES = 0;       // ARM64 定案后为 0（旧候选补偿已删）
  var USER_PINNED_HANDOFF_PER_ENTRY = 2; // user_pinned 拟合模型
  /* `_delayToBorn` 查表（毫帧）：先精确查，查不到就把 `_b` / `_2` / `_3` 这类**变体后缀**逐层剥掉。
     依据：关卡 `action.key` 用的是变体 id（例 `enemy_2133_shdopl_b`），而同一关的 `enemyDbRefs`
     与 prefab 落的是 base id（`enemy_2133_shdopl`，`_DelayToBorn = 1.0`）；客户端按 key 查的是同一张
     `m_enemyMap`，所以变体与 base 共用这个字段。不兜底的话 IS6「畸症」首怪会晚 30 帧
     （配置 10s vs 实测 9s01f），路径预览也会晚 30 帧（实测 6s00f）。 */
  function delayToBornMt(table, key) {
    var k = String(key == null ? '' : key);
    for (var i = 0; i < 8 && k; i++) {
      if (table[k] != null) return Math.max(0, Math.trunc(num(table[k], 0)));
      var next = k.replace(/_(?:[a-z]\d*|\d+)$/, '');
      if (!next || next === k) break;
      k = next;
    }
    return 0;
  }

  var PREVIEW_CURSOR_PRE_DELAY = 3.0;    // _DealAction 0x27e3738：SPAWN 前 3s
  var PREVIEW_CURSOR_INTERVAL = 0.3;     // 预瞄游标间隔
  var PREVIEW_CURSOR_COUNT = 2;
  var MULTI = { SPAWN: true, PREVIEW_CURSOR: true };
  var TYPES = ['SPAWN', 'PREVIEW_CURSOR', 'STORY', 'TUTORIAL', 'PLAY_BGM', 'DISPLAY_ENEMY_INFO',
    'ACTIVATE_PREDEFINED', 'PLAY_OPERA', 'TRIGGER_PREDEFINED', 'BATTLE_EVENTS',
    'WITHDRAW_PREDEFINED', 'DIALOG', 'SHOW_ALL_HIDDEN_CARDS', 'EMPTY'];

  function val(x, dflt) {
    if (x && typeof x === 'object' && !Array.isArray(x) && 'm_value' in x) return x.m_value;
    return (x === null || x === undefined) ? dflt : x;
  }
  function entries(v) {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; });
    return [];
  }
  function num(x, dflt) {
    var v = Number(val(x, dflt === undefined ? 0 : dflt));
    return isFinite(v) ? v : 0;
  }
  function milliFrames(sec) { return Math.round(num(sec, 0) * HZ * MF); }
  function mtToFrames(mt) { return Math.max(0, Math.floor((Math.trunc(mt) + MF / 2) / MF)); }
  function framesOf(sec) { return Math.round(num(sec, 0) * HZ); }
  function waitFrames(dt) { return dt <= 0 ? 0 : Math.max(1, mtToFrames(dt)); }
  /* 波次起点 = round(preDelay*30)（客户端 <WaitForPredelay>d__15::MoveNext 0x27e9924 ->
     AsyncUtil::WaitForFixedSeconds 0x24f07ec）。带 preDelay 的波次多一次恢复点，这次恢复与
     「最后一个合成条目」执行落在同一帧 —— 由六条实测帧钉死：0-1 预览 62 / DISPLAY 154 /
     首怪 155，9-11 预览 180 / 190、首怪 271、第二只 512，CE-5 0/1/2。
     见 docs/02-knowledge/spawn-schedule.md §9g-9。 */
  function waveStartDelay(wave, waveIndex) {
    return framesOf(wave.preDelay);
  }
  function tailSyntheticOverlap(wave) {
    return num(wave.preDelay, 0) > 0;
  }
  function truthy(node) { return !!val(node, false); }
  function actionTypeName(v) {
    if (typeof v === 'boolean') return 'EMPTY';
    var idx;
    if (typeof v === 'number' && isFinite(v)) idx = Math.trunc(v);
    else {
      var text = String(v === null || v === undefined ? '' : v).trim();
      if (/^[+-]?\d+$/.test(text)) idx = parseInt(text, 10);
      else if (TYPES.indexOf(text) >= 0) return text;
      else return text || 'EMPTY';
    }
    return (idx >= 0 && idx < TYPES.length) ? TYPES[idx] : 'EMPTY';
  }

  /* Mono ArraySortHelper<T>.QuickSort：等键也交换，所以同刻条目会被固定置换。 */
  function quickSort(items, compare) {
    var keys = items.slice();
    function sort(low, high) {
      while (low < high) {
        var i = low, j = high, pivot = keys[(low + high) >> 1];
        while (true) {
          while (compare(keys[i], pivot) < 0) i++;
          while (compare(pivot, keys[j]) < 0) j--;
          if (i <= j) {
            var t = keys[i]; keys[i] = keys[j]; keys[j] = t;
            i++; j--;
          }
          if (i > j) break;
        }
        if (low < j) sort(low, j);
        low = i;
      }
    }
    if (keys.length > 1) sort(0, keys.length - 1);
    return keys;
  }
  function byTime(a, b) { return a.time_mt < b.time_mt ? -1 : (a.time_mt > b.time_mt ? 1 : 0); }
  function orderQueue(items, model) {
    if (items.length < 2 || model === 'file_order') {
      return items.map(function (it, i) { return [it.time_mt, i, it]; })
        .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; })
        .map(function (r) { return r[2]; });
    }
    return quickSort(items, byTime);
  }

  // ---------------------------------------------------------------------------
  // 随机刷怪组的抽取：`System.Random`（.NET Knuth 减法）+ `UniformWithWeight`
  //
  // 客户端 `RandomGroupSchedulerPreprocessor::DoPreprocess`（ARM64 0x27f8050）把带
  // `randomSpawnGroupKey` 的 action 按 (wave, fragment, key) 分组；`PhaseData::
  // FetchActionsWithRandomSpawn`（0x42005cc）逐组抽一条、把落选的置 `isValid = 0`
  // （0x42006f8），出队侧 `_ExecuteActionQueue::MoveNext`（0x27e9c00）跳过 invalid
  // 条目且**不占帧**。随机源是 `IBattleRandom.UniformWithWeight` + `action.weight`。
  //
  // 这里是 tools/dotnet_random.py 的逐行移植（同一个 seed ⇒ 同一个序列），用于分发版
  // 在没有服务端的情况下复现 `seed` 口径；抽取算术本身仍是 candidate。
  // ---------------------------------------------------------------------------
  var MBIG = 2147483647, MSEED = 161803398;
  function DotNetRandom(seed) {
    this.sa = new Array(56);
    for (var i = 0; i < 56; i++) this.sa[i] = 0;
    this.inext = 0; this.inextp = 21;
    this.setSeed(Math.trunc(num(seed, 0)));
  }
  DotNetRandom.prototype.setSeed = function (seed) {
    if (seed === -2147483648) seed = MBIG;
    else seed = Math.abs(seed);
    var mj = MSEED - seed, mk = 1;
    this.sa[55] = mj;
    for (var i = 1; i < 55; i++) {
      var ii = (21 * i) % 55;
      this.sa[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.sa[ii];
    }
    for (var k = 1; k < 5; k++) {
      for (var j = 1; j < 56; j++) {
        this.sa[j] -= this.sa[1 + (j + 30) % 55];
        if (this.sa[j] < 0) this.sa[j] += MBIG;
      }
    }
    this.inext = 0; this.inextp = 21;
    return this;
  };
  DotNetRandom.prototype.internalSample = function () {
    var inext = this.inext + 1; if (inext >= 56) inext = 1;
    var inextp = this.inextp + 1; if (inextp >= 56) inextp = 1;
    var ret = this.sa[inext] - this.sa[inextp];
    if (ret === MBIG) ret -= 1;
    if (ret < 0) ret += MBIG;
    this.sa[inext] = ret;
    this.inext = inext; this.inextp = inextp;
    return ret;
  };
  DotNetRandom.prototype.sample = function () { return this.internalSample() * (1.0 / MBIG); };

  /** `IBattleRandom.UniformWithWeight<T>`：totalWeight 上的加权均匀（算术 candidate）。 */
  function uniformIndexWithWeight(rng, weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += Number(weights[i]) || 0;
    if (!(total > 0)) return 0;
    var r = rng.sample() * total, acc = 0;
    for (i = 0; i < weights.length; i++) {
      acc += Number(weights[i]) || 0;
      if (r < acc) return i;
    }
    return weights.length - 1;
  }

  /** 一次性把随机刷怪组展开成确定性计划（与 tools/battle_simulator.py:random_spawn_group_plan 同构）。 */
  function randomGroupPlan(level, policy, seed, pins) {
    policy = policy || 'all';
    // `pinned`：页面点备注里的标签轮换候选时用。键与 Python 侧一致，依次探测
    // `"<group>@w<wave>/f<fragment>"` → `"<group>@<wave>/<fragment>"` → `"<group>"`。
    var pinMap = pins || {};
    function pinnedIndex(key, wi, fi) {
      var probes = [key + '@w' + wi + '/f' + fi, key + '@' + wi + '/' + fi, key];
      for (var i = 0; i < probes.length; i++) {
        if (Object.prototype.hasOwnProperty.call(pinMap, probes[i])) {
          return Math.trunc(num(pinMap[probes[i]], 0));
        }
      }
      return 0;
    }
    var usedSeed = Math.trunc(num(seed !== undefined && seed !== null ? seed : num(level.randomSeed, 0), 0));
    var rng = policy === 'seed' ? new DotNetRandom(usedSeed) : null;
    var drop = {}, groups = [], counts = { groups: 0, candidates: 0, dropped: 0, selected: 0 };
    entries(level.waves).forEach(function (wave, wi) {
      entries(wave.fragments).forEach(function (frag, fi) {
        var order = [], buckets = {};
        entries(frag.actions).forEach(function (act, ai) {
          if (!act || typeof act !== 'object') return;
          var key = String(val(act.randomSpawnGroupKey, '') || '');
          if (!key) return;
          if (!buckets[key]) { buckets[key] = []; order.push(key); }
          buckets[key].push({ action: ai, weight: Math.trunc(num(act.weight, 0)) });
        });
        order.forEach(function (key) {
          var cands = buckets[key];
          var weights = cands.map(function (c) { return c.weight; });
          var index = policy === 'seed' ? uniformIndexWithWeight(rng, weights)
            : policy === 'pinned' ? pinnedIndex(key, wi, fi) : 0;
          if (!(index >= 0 && index < cands.length)) index = 0;
          counts.groups++; counts.candidates += cands.length; counts.selected++;
          var dropped = policy === 'all' ? [] : cands.filter(function (c, i) {
            return i !== index;
          }).map(function (c) { return c.action; });
          counts.dropped += dropped.length;
          groups.push({ wave: wi, fragment: fi, group: key, candidates: cands.map(function (c) {
            return { action: c.action, weight: c.weight };
          }), chosen: index, chosen_action: cands[index].action, dropped: dropped,
            chosen_candidate: cands[index] });
          if (dropped.length) drop['w' + wi + '/f' + fi] = (drop['w' + wi + '/f' + fi] || []).concat(dropped);
        });
      });
    });
    return { policy: policy, seed: usedSeed, drop: drop, groups: groups, counts: counts,
      confidence: 'client_static_verified（分组/剔除、isValid 门、weight 字段）+ candidate（UniformWithWeight 算术、randomSeed 注入点）' };
  }

  function actionEnabled(act, enabled) {
    var group = val(act.hiddenGroup, null);
    if (group === null || group === '' || group === undefined) return true;
    if (!enabled) return false;
    return enabled.indexOf(String(group)) >= 0;
  }

  function buildFragmentQueue(fragment, opts) {
    opts = opts || {};
    var enabled = opts.enabled_hidden_groups || null;
    var dropped = opts.dropped_actions || null;
    var fromBranch = !!opts.from_branch;
    var fragPre = milliFrames(fragment.preDelay);
    var items = [], blockCounter = 0, skipped = [];
    entries(fragment.actions).forEach(function (act, ai) {
      if (!act || typeof act !== 'object') return;
      if (!actionEnabled(act, enabled)) {
        skipped.push({ action: ai, reason: 'hidden_group_disabled', hidden_group: val(act.hiddenGroup, null) });
        return;
      }
      if (dropped && dropped.indexOf(ai) >= 0) {
        // 随机刷怪组里没被抽中的候选：客户端置 `isValid = false`，出队侧直接跳过、不占帧。
        skipped.push({ action: ai, reason: 'random_group_not_chosen',
          random_spawn_group_key: val(act.randomSpawnGroupKey, null) });
        return;
      }
      var atype = actionTypeName(act.actionType);
      // 行上要带 hiddenGroup，页面才能把「这一条来自哪个隐藏组」标出来（用户口径）。
      var group = val(act.hiddenGroup, null);
      if (group === '') group = null;
      var base = fragPre + milliFrames(act.preDelay);
      var count = Math.max(0, Math.trunc(num(act.count, 0)));
      var interval = milliFrames(act.interval);
      // `Scheduler::_DealAction`（ARM64 0x27e35a4-0x27e35c8）在 actionType == 1
      // （PREVIEW_CURSOR）时**无条件覆写**这条动作的 count/interval：
      //     cmp w8,#1 / b.ne <其余类型只入队一条>
      //     mov w8,#2  -> [ActionData+0x20] = count
      //     movk w9,#0x3e99,lsl#16 (0.3f) -> [ActionData+0x28] = interval
      // 配置里的这两列只是模板默认值（2-7 w0 f0 a2 写的是 count=1/interval=1.0），
      // 照配置读会少一条队列条目，把该 fragment 后面的事件全部推早 1 帧。
      if (atype === 'PREVIEW_CURSOR') {
        count = PREVIEW_CURSOR_COUNT;
        interval = milliFrames(PREVIEW_CURSOR_INTERVAL);
      }
      var route = Math.trunc(num(act.routeIndex, 0));
      var key = String(val(act.key, '') || '');
      var block = truthy(act.blockFragment);
      // `Scheduler::_DealAction`（ARM64 0x27e3600 fsub / 0x27e3604 fmax）：SPAWN 条目按
      // `action.key` 查 `m_enemyMap` 的 `Enemy._delayToBorn`，做 t = max(t - v, 0)。
      // 这条 fsub 只落在 **SPAWN 分支**（0x27e35a0 cbz w8,#0x27e35cc）；其余 actionType
      // 在 0x27e35a8 b.ne #0x27e36d4 走「单条目」路径，0x27e36e4 str s8,[sp,#0x10]
      // 直接把 s8 当条目时间、**不再减**。合成的 PREVIEW_CURSOR 不继承 key，
      // 合成的 DISPLAY_ENEMY_INFO 递归时 base 参数=0（0x27e37f4 fmov s0,wzr）+
      // preDelay=s8（0x27e3808）⇒ 时间 = s8，和它的 SPAWN 同一时刻（2026-09-18 修正：
      // 曾经在这里又减一次 delayToBorn，HE-EX-4 的 info 因此被算成 1s00f，实机 2s00f）。
      var delay = 0;
      if (atype === 'SPAWN') {
        delay = delayToBornMt(opts.enemy_delay_mt || {}, key);
        if (delay) base = Math.max(base - delay, 0);
      }
      if (MULTI[atype]) {
        for (var seq = 0; seq < count; seq++) {
          items.push({ time_mt: base + interval * seq, action: ai, seq: seq, kind: atype, key: key,
            route: route, synthetic: false, use_extra_route: fromBranch, block_fragment: block, hidden_group: group });
        }
        if (block) blockCounter += count;
      } else {
        items.push({ time_mt: base, action: ai, seq: 0, kind: atype, key: key, route: route,
          synthetic: false, use_extra_route: fromBranch, block_fragment: block, hidden_group: group });
        if (block) blockCounter += 1;
      }
      if (atype === 'SPAWN') {
        if (truthy(act.autoPreviewRoute)) {
          var start = base - milliFrames(PREVIEW_CURSOR_PRE_DELAY);
          var step = milliFrames(PREVIEW_CURSOR_INTERVAL);
          for (var k = 0; k < PREVIEW_CURSOR_COUNT; k++) {
            items.push({ time_mt: start + step * k, action: ai, seq: count + k, kind: 'PREVIEW_CURSOR',
              key: key, route: route, synthetic: true, use_extra_route: fromBranch, block_fragment: false, hidden_group: group });
          }
        }
        if (truthy(act.autoDisplayEnemyInfo)) {
          // 只有一次 delayToBorn 减法：base 已经是 max(配置 − delay, 0)，这里**不能再减**。
          items.push({ time_mt: Math.max(base, 0), action: ai, seq: count + PREVIEW_CURSOR_COUNT,
            kind: 'DISPLAY_ENEMY_INFO', key: key, route: route, synthetic: true,
            use_extra_route: fromBranch, block_fragment: false, hidden_group: group });
        }
      }
    });
    return { items: orderQueue(items, opts.queue_order || 'mono_qsort'), block_counter: blockCounter, skipped: skipped };
  }

  /* <_ExecuteActionQueue>d__17::MoveNext：每条目至少占 1 帧，后面的条目整体顺延。 */
  /* 按客户端顺序排空一条队列（<_ExecuteActionQueue>d__17::MoveNext, v7a 0x1796a00 的移植）：
       等待量 = 本条时间 - 上一条【已执行】条目的时间（WaitForFixedSeconds = max(1, round(dt))），
       再加该条自己那一帧；s16 初值 0.0。
     一条条目占的帧 = WaitForFixedSeconds(本条时间 - 上一条已执行时间)（<= 0 时为 0）
     **加上它自己那一帧**。波次起点的那一帧由 waveStartDelay 处理，这里不再有任何口径开关。 */
  function drainQueue(items, processStart, consumption, tailOverlap) {
    var rows = [], last = processStart - 1, prev = 0, clock = processStart;
    var stepFreeIndex = -1;
    if (tailOverlap) {
      for (var si = items.length - 1; si >= 0; si--) {
        if (items[si].synthetic) { stepFreeIndex = si; break; }
      }
    }
    for (var qi = 0; qi < items.length; qi++) {
      var item = items[qi];
      var ideal = processStart + mtToFrames(item.time_mt);
      var actual;
      if (consumption === 'client_accumulated') {
        var delta = item.time_mt - prev;
        if (qi === 0) clock = processStart + waitFrames(item.time_mt);
        else if (delta > 0) clock += waitFrames(delta);
        actual = clock;
        if (qi !== stepFreeIndex) clock += QUEUE_ENTRY_YIELD_FRAMES;
      } else if (consumption === 'client_cumulative' || consumption === 'user_pinned') {
        actual = qi === 0 ? processStart + waitFrames(item.time_mt)
          : last + 1 + waitFrames(item.time_mt - prev);
      } else {
        actual = Math.max(ideal, last + 1);
      }
      prev = item.time_mt;
      last = actual;
      rows.push({ queue_index: qi, item: item, ideal_frame: ideal, actual_frame: actual,
        shift_frames: actual - ideal });
    }
    return { rows: rows, last_actual: last };
  }

  /* 分支波次轨（tools/spawn_timeline.build(branches=..., branch_trigger_frame=...) 的移植）:
     每个选中的 branch 从触发帧开始，按 phase 顺序各自排空一条队列（动作走 extraRoutes）。
     触发帧是运行时的（技能/脚本），所以这些行标 candidate。用户口径：任意分支子集与任意
     触发帧都要能在页面里现算，不能只给「全开 + 触发帧 0/300」两种预计算组合。 */
  function scheduleBranches(level, opts) {
    opts = opts || {};
    var consumption = opts.consumption || 'client_accumulated';
    var enabled = opts.enabled_hidden_groups || null;
    var trigger = Math.max(0, Math.trunc(num(opts.branch_trigger_frame, 0)));
    var names = (opts.branches || []).map(function (n) { return String(n); });
    var all = (level && level.branches) || {};
    var rows = [];
    names.forEach(function (name) {
      var branch = null;
      if (Array.isArray(all)) {
        for (var bi = 0; bi < all.length; bi++) {
          if (String((all[bi] || {}).name || bi) === name) { branch = all[bi]; break; }
        }
      } else {
        branch = all[name] || null;
      }
      if (!branch || typeof branch !== 'object') return;
      var cursor = trigger;
      entries(branch.phases).forEach(function (phase, pi) {
        var ph = (phase && typeof phase === 'object') ? phase : {};
        var built = buildFragmentQueue(ph, { enabled_hidden_groups: enabled,
          queue_order: opts.queue_order, enemy_delay_mt: opts.enemy_delay_mt, from_branch: true });
        var drained = drainQueue(built.items, cursor, consumption);
        var phasePre = framesOf(ph.preDelay);
        var acts = entries(ph.actions);
        drained.rows.forEach(function (row) {
          var item = row.item;
          var act = (item.action >= 0 && item.action < acts.length) ? acts[item.action] : null;
          if (!act || typeof act !== 'object') act = {};
          // config_frame 与 Python 同式：round(sec*30*seq)，不是 round(sec*30)*seq
          var config = trigger + phasePre + framesOf(act.preDelay)
            + Math.round(num(act.interval, 0) * HZ * num(item.seq, 0));
          rows.push({ track: 'branch', track_rank: 1, branch: name, phase: pi,
            kind: item.kind, key: item.key, route: item.route, route_source: 'extraRoutes',
            action: item.action, seq: item.seq, synthetic: !!item.synthetic,
            hidden_group: item.hidden_group || null,
            config_frame: config, ideal_frame: row.ideal_frame, actual_frame: row.actual_frame,
            shift_frames: row.actual_frame - config,
            confidence: 'candidate (trigger frame is runtime)' });
        });
        if (drained.rows.length) cursor = drained.last_actual + 1;
      });
    });
    return { rows: rows };
  }

  function schedule(level, opts) {
    opts = opts || {};
    var consumption = opts.consumption || 'client_accumulated';
    var enabled = opts.enabled_hidden_groups || null;
    // 随机刷怪组：页面给 `random_groups = {policy, seed}`；`all` 不删候选（默认口径）。
    var rgOpts = opts.random_groups || null;
    var rg = rgOpts ? randomGroupPlan(level, rgOpts.policy, rgOpts.seed) : null;
    var rows = [], completions = [], cursor = 0;
    // 波次门（`<_DealWave>d__121` 的 `WaitWhile(_CheckWaveNotFinish)`）：门是**下界**，
    // 默认值来自离线真值表 `artifacts/client-2.7.71/wave-clear-frames.json`（该波全部敌人
    // 离场帧 + 1），由 build 侧写进 payload 的 wave_gates，页面与对拍都走这里。
    var gates = opts.wave_gates || null;
    entries(level.waves).forEach(function (wave, wi) {
      if (gates && gates[wi] !== undefined && gates[wi] !== null) {
        cursor = Math.max(cursor, Math.trunc(num(gates[wi], cursor)));
      }
      var waveStart = cursor + waveStartDelay(wave, wi);
      cursor = waveStart;
      var maxWait = num(wave.maxTimeWaitingForNextWave, 0);
      var skippedFragments = [];
      // `maxTimeWaitingForNextWave` 触发后，**这一波剩下的 fragment 全部不再派发**
      // （Python `battle_simulator.schedule` 在这里是 `break`）。以前 JS 写成
      // `forEach` 里的 `return`，只跳过了「记录 completion」，后面的 fragment 照样入队 ——
      // HE-EX-4（act26side_ex04）因此多出 w0 f2/f3 的 4 行、生成数 34 vs Python 的 24。
      var waveTruncated = false;
      entries(wave.fragments).forEach(function (frag, fi) {
        if (waveTruncated) return;
        var processStart = cursor;
        var fragStart = processStart + framesOf(frag.preDelay);
        var built = buildFragmentQueue(frag, {
          enabled_hidden_groups: enabled, queue_order: opts.queue_order,
          enemy_delay_mt: opts.enemy_delay_mt,
          dropped_actions: rg ? rg.drop['w' + wi + '/f' + fi] : null });
        var drained = drainQueue(built.items, processStart, consumption,
          fi === 0 && tailSyntheticOverlap(wave));
        var lastActual = drained.last_actual;
        var completion = built.items.length
          ? (consumption === 'client_accumulated' ? lastActual + FRAGMENT_HANDOFF_FRAMES + UNMODELLED_ENTRY_FRAMES * built.items.length
            : consumption === 'user_pinned' ? lastActual + 1 + USER_PINNED_HANDOFF_PER_ENTRY * built.items.length
              : lastActual + 1)
          : processStart;
        // 随机刷怪组：把「这条属于哪个组 / 几选一 / 是不是抽中的那条」写进行上，页面据此标注。
        var rgByAction = {};
        if (rg) {
          rg.groups.forEach(function (g) {
            if (g.wave !== wi || g.fragment !== fi) return;
            var weights = g.candidates.map(function (c) { return c.weight; });
            g.candidates.forEach(function (c, ci) {
              rgByAction[c.action] = { group: g.group, size: g.candidates.length,
                chosen: ci === g.chosen, weights: weights, policy: rg.policy };
            });
          });
        }
        drained.rows.forEach(function (row) {
          var rgi = rgByAction[row.item.action] || null;
          rows.push({ track: 'wave', wave: wi, fragment: fi, action: row.item.action, seq: row.item.seq,
            kind: row.item.kind, key: row.item.key, route: row.item.route, synthetic: !!row.item.synthetic,
            hidden_group: row.item.hidden_group || null,
            random_group: rgi ? rgi.group : null,
            random_group_size: rgi ? rgi.size : null,
            random_group_chosen: rgi ? rgi.chosen : null,
            random_group_weights: rgi ? rgi.weights : null,
            time_mt: row.item.time_mt, ideal_frame: row.ideal_frame, actual_frame: row.actual_frame });
        });
        if (maxWait > 0 && (completion - waveStart) > framesOf(maxWait)) {
          skippedFragments.push({ fragment: fi, reason: 'maxTimeWaitingForNextWave' });
          waveTruncated = true;
          return;
        }
        completions.push({ wave: wi, fragment: fi, start_frame: fragStart,
          completion_frame: completion, queue_entries: built.items.length });
        cursor = completion;
      });
      if (skippedFragments.length) {
        completions.push({ wave: wi, fragment: null, reason: 'maxTimeWaitingForNextWave',
          skipped_fragments: skippedFragments });
      }
      cursor += framesOf(wave.postDelay);
    });
    return { rows: rows, completions: completions };
  }

  /* prts.map 默认坐标：字母 = 逻辑行（A = 最下一行），数字 = 列 + 1。 */
  function prtsLabel(logicalRow, col) {
    if (logicalRow === null || logicalRow === undefined) return null;
    var r = Math.trunc(logicalRow), c = Math.trunc(col);
    if (r < 0 || c < 0) return null;
    var head = '', n = r;
    // letters: A..Z, AA..AZ, BA.. — 与前端 i = flatMap(head => A..Z) 的进位一致
    var headIndex = Math.floor(n / 26);
    while (headIndex > 0) {
      var rem = (headIndex - 1) % 26;
      head = String.fromCharCode(65 + rem) + head;
      headIndex = Math.floor((headIndex - 1) / 26);
    }
    return head + String.fromCharCode(65 + (n % 26)) + (c + 1);
  }

  var api = {
    HZ: HZ, TYPES: TYPES, actionTypeName: actionTypeName, entries: entries, val: val,
    milliFrames: milliFrames, mtToFrames: mtToFrames, framesOf: framesOf, waitFrames: waitFrames,
    waveStartDelay: waveStartDelay, tailSyntheticOverlap: tailSyntheticOverlap,
    quickSort: quickSort, orderQueue: orderQueue, buildFragmentQueue: buildFragmentQueue,
    drainQueue: drainQueue, schedule: schedule, scheduleBranches: scheduleBranches,
    DotNetRandom: DotNetRandom, uniformIndexWithWeight: uniformIndexWithWeight,
    randomGroupPlan: randomGroupPlan,
    prtsLabel: prtsLabel,
    build: function (level, opts) { return schedule(level, opts); }
  };
  global.SpawnCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
