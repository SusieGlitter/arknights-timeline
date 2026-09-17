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
  /* 波次 preDelay 的等待帧数（客户端 <WaitForPredelay>d__15::MoveNext 0x27e9924 ->
     AsyncUtil::WaitForFixedSeconds，下限 1 帧在 0x2504184）。第 0 波少 1 帧：根协程在装载
     阶段已被步进过一次（SchedulerDriver::DoScheduleMain 0x27f14dc）。 */
  function waveStartDelay(wave, waveIndex) {
    var ticks = Math.max(1, framesOf(wave.preDelay));
    return waveIndex === 0 ? Math.max(0, ticks - 1) : ticks;
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

  function actionEnabled(act, enabled) {
    var group = val(act.hiddenGroup, null);
    if (group === null || group === '' || group === undefined) return true;
    if (!enabled) return false;
    return enabled.indexOf(String(group)) >= 0;
  }

  function buildFragmentQueue(fragment, opts) {
    opts = opts || {};
    var enabled = opts.enabled_hidden_groups || null;
    var fromBranch = !!opts.from_branch;
    var fragPre = milliFrames(fragment.preDelay);
    var items = [], blockCounter = 0, skipped = [];
    entries(fragment.actions).forEach(function (act, ai) {
      if (!act || typeof act !== 'object') return;
      if (!actionEnabled(act, enabled)) {
        skipped.push({ action: ai, reason: 'hidden_group_disabled', hidden_group: val(act.hiddenGroup, null) });
        return;
      }
      var atype = actionTypeName(act.actionType);
      // 行上要带 hiddenGroup，页面才能把「这一条来自哪个隐藏组」标出来（用户口径）。
      var group = val(act.hiddenGroup, null);
      if (group === '') group = null;
      var base = fragPre + milliFrames(act.preDelay);
      var count = Math.max(0, Math.trunc(num(act.count, 0)));
      var interval = milliFrames(act.interval);
      var route = Math.trunc(num(act.routeIndex, 0));
      var key = String(val(act.key, '') || '');
      var block = truthy(act.blockFragment);
      // `Scheduler::_DealAction`（ARM64 0x27e3600 fsub / 0x27e3604 fmax）：SPAWN 条目按
      // `action.key` 查 `m_enemyMap` 的 `Enemy._delayToBorn`，做 t = max(t - v, 0)。
      // 合成的 PREVIEW_CURSOR 动作**不继承 key**（客户端 0x27e375c 那段只写 actionType/
      // count/interval/preDelay/routeIndex），所以它建在已经减过一次的 base 上；
      // 合成的 DISPLAY_ENEMY_INFO 反而继承 key（0x27e37dc），递归时会再减一次。
      var delay = 0;
      if (atype === 'SPAWN') {
        var table = opts.enemy_delay_mt || {};
        delay = Math.max(0, Math.trunc(num(table[key], 0)));
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
          items.push({ time_mt: Math.max(base - delay, 0), action: ai, seq: count + PREVIEW_CURSOR_COUNT,
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
  function drainQueue(items, processStart, consumption) {
    var rows = [], last = processStart - 1, prev = 0, clock = processStart;
    var stepFreeIndex = -1;
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
    var rows = [], completions = [], cursor = 0;
    // 波次门（`<_DealWave>d__121` 的 `WaitWhile(_CheckWaveNotFinish)`）：门是**下界**，
    // 默认值来自离线真值表 `artifacts/client-2.7.71/wave-clear-frames.json`（该波全部敌人
    // 离场帧 + 1），由 build 侧写进 payload 的 wave_gates，页面与对拍都走这里。
    var gates = opts.wave_gates || null;
    entries(level.waves).forEach(function (wave, wi) {
      if (gates && gates[wi] !== undefined && gates[wi] !== null) {
        cursor = Math.max(cursor, Math.trunc(num(gates[wi], cursor)));
      }
      // 波次起点（client 2.7.71 / 190，见 docs/02-knowledge/spawn-schedule.md §9g-8）：
      // 第 0 波的根协程在装载阶段就被 CoroutineSimulator::StartCoroutine 当场步进一次
      // （ARM64 0x252bec4 / 0x252bf74），它的 preDelay 等待因此少占 1 帧：
      //   wave 0         : max(1, round(preDelay*30)) - 1
      //   wave 1, 2, ... : max(1, round(preDelay*30))
      var waveStart = cursor + waveStartDelay(wave, wi);
      cursor = waveStart;
      var maxWait = num(wave.maxTimeWaitingForNextWave, 0);
      var skippedFragments = [];
      entries(wave.fragments).forEach(function (frag, fi) {
        var processStart = cursor;
        var fragStart = processStart + framesOf(frag.preDelay);
        var built = buildFragmentQueue(frag, {
          enabled_hidden_groups: enabled, queue_order: opts.queue_order, enemy_delay_mt: opts.enemy_delay_mt });
        var drained = drainQueue(built.items, processStart, consumption);
        var lastActual = drained.last_actual;
        var completion = built.items.length
          ? (consumption === 'client_accumulated' ? lastActual + FRAGMENT_HANDOFF_FRAMES + UNMODELLED_ENTRY_FRAMES * built.items.length
            : consumption === 'user_pinned' ? lastActual + 1 + USER_PINNED_HANDOFF_PER_ENTRY * built.items.length
              : lastActual + 1)
          : processStart;
        drained.rows.forEach(function (row) {
          rows.push({ track: 'wave', wave: wi, fragment: fi, action: row.item.action, seq: row.item.seq,
            kind: row.item.kind, key: row.item.key, route: row.item.route, synthetic: !!row.item.synthetic,
            hidden_group: row.item.hidden_group || null,
            time_mt: row.item.time_mt, ideal_frame: row.ideal_frame, actual_frame: row.actual_frame });
        });
        if (maxWait > 0 && (completion - waveStart) > framesOf(maxWait)) {
          skippedFragments.push({ fragment: fi, reason: 'maxTimeWaitingForNextWave' });
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
    waveStartDelay: waveStartDelay,
    quickSort: quickSort, orderQueue: orderQueue, buildFragmentQueue: buildFragmentQueue,
    drainQueue: drainQueue, schedule: schedule, scheduleBranches: scheduleBranches,
    prtsLabel: prtsLabel,
    build: function (level, opts) { return schedule(level, opts); }
  };
  global.SpawnCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
