/* 分发版「出怪帧时间线」UI：数据全部内联（window.__SPAWN_DATA__），
 * 不联网、不依赖任何运行时。任意关卡配置文件走 window.SpawnCore（JS 移植核心，
 * 见 tools/test_dist_core.py 与 Python 实现逐条对拍）。 */
(function () {
  'use strict';
  // 数据可能晚于本文件到位（分发版是 gzip+base64，页内 bootstrap 解压完才调 boot），
  // 所以这里不能把 window.__SPAWN_DATA__ 一次拷进常量，必须 boot() 时再取。
  var D = { levels: [], payloads: {}, version: '' };
  function refreshData() {
    if (window.__SPAWN_DATA__) D = window.__SPAWN_DATA__;
    S.levels = D.levels || [];
    KEY_NAME = {};
    (D.keys || []).forEach(function (k, i) { KEY_NAME[k] = (D.names || [])[i]; });
    return D;
  }
  /* 本地重算要的是关卡的原始波次：自定义文件直接用文件内容；分发版关卡来自
     spawn-waves.js（只带 waves，全部关卡 gzip 后 ~1.1 MB，见
     tools/export_spawn_timeline_dist.py）。 */
  function rawLevelFor(level) {
    if (level.level && level.level.waves) return level.level;
    var table = window.__SPAWN_WAVES__ || {};
    if (!Object.prototype.hasOwnProperty.call(table, level.id)) return null;
    var entry = table[level.id];
    // 新格式 {"w": waves, "b": branches}；旧数据文件是裸 waves 数组，仍然兼容。
    if (entry && !Array.isArray(entry)) return { waves: entry.w || [], branches: entry.b || null };
    return { waves: entry || [], branches: null };
  }
  function wavesReady() { return !!(window.__SPAWN_WAVES__ && Object.keys(window.__SPAWN_WAVES__).length); }
  var C = window.SpawnCore;
  var S = { levels: D.levels, query: '', selected: null, data: null, groups: [], branches: [],
            rgPolicy: 'pinned', rgPins: {}, rgCursor: 0,
            branchTrigger: 0, custom: null, gates: {}, sel: new Set(), selAnchor: null,
            rows: [], spawnNo: {},
            //: 分发版内置**全部** 3876 关，默认范围用 all（否则按肉鸽/活动关卡名搜会搜不到）
            scope: 'all', onlyOptions: false, spawnOnly: false };
  //: 关卡 id -> 该关默认载荷里的 {map, spawn_points}。地图和出生点与隐藏组无关，
  //: 本地重算（隐藏组子集）时直接复用，不必把原始 mapData/routes 也塞进分发包。
  var MAP_CACHE = {};
  //: 敌人 key -> 显示名。D.names 是按 key 序号索引的数组（紧凑线格式用），本地重算的行走这里。
  var KEY_NAME = {};
  function $(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t === null || t === undefined ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sf(f) {
    if (f === null || f === undefined) return '-';
    var v = Number(f);
    return isFinite(v) ? Math.floor(v / 30) + 's ' + String(v % 30).padStart(2, '0') + 'f' : '-';
  }
  function matchLevel(l, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [l.code, l.name, l.id].map(function (x) { return String(x || '').toLowerCase(); });
    var compact = q.replace(/[^0-9a-z]/g, '');
    return hay.some(function (h) { return h.indexOf(q) >= 0; })
      || (!!compact && hay.some(function (h) { return h.replace(/[^0-9a-z]/g, '').indexOf(compact) >= 0; }));
  }
  function scoreOf(l, q) {
    q = String(q || '').trim();
    if (!q) return 9;
    if (String(l.code) === q) return 0;
    if (String(l.id) === q) return 1;
    if (String(l.name) === q) return 2;
    return 3;
  }
  // 章节号不总是裸数字（第 8 章是 R8-1 / M8-6 / JT8-3），排序时也要按章节归拢。
  function chapterOf(l) {
    var m = /^[A-Za-z]{0,3}(\d+)-/.exec(String(l.code || ''));
    return m ? Number(m[1]) : 999;
  }
  var PREFIX_RANK = { '': 0, R: 1, M: 2, JT: 3, EG: 4, END: 5 };
  function codeParts(l) {
    var m = /^([A-Za-z]{0,3})(\d+)-(\d+)/.exec(String(l.code || ''));
    if (!m) return { rank: 9, num: Infinity, sub: Infinity };
    var prefix = m[1].toUpperCase();
    return { rank: (prefix in PREFIX_RANK) ? PREFIX_RANK[prefix] : 6,
             num: Number(m[2]), sub: Number(m[3]) };
  }
  function compareLevels(a, b) {
    /* 自然序：0-1 < 0-2 < … < 0-10 < 0-11（字符串序会把 0-10 排到 0-2 前面）。 */
    var ca = chapterOf(a), cb = chapterOf(b);
    if (ca !== cb) return ca - cb;
    var pa = codeParts(a), pb = codeParts(b);
    if (pa.rank !== pb.rank) return pa.rank - pb.rank;
    if (pa.num !== pb.num) return pa.num - pb.num;
    if (pa.sub !== pb.sub) return pa.sub - pb.sub;
    return String(a.code || a.id).localeCompare(String(b.code || b.id), 'zh')
      || String(a.id).localeCompare(String(b.id));
  }
  function inScope(l, scope) {
    var g = String((l || {}).group || 'main');
    if (!scope || scope === 'all') return true;
    if (scope === 'main') return g === 'main';
    if (scope === 'obt') return g === 'main' || g.indexOf('obt') === 0;
    return true;
  }
  function visibleLevels() {
    // 用户口径（2026-09-18）：**不要**「主线 / 活动 / 其他」范围下拉，每次搜索都在全部
    // 三千多关里找。`inScope` 保留但不再参与过滤（旧链接里可能还带 scope，不影响结果）。
    var rows = S.levels.filter(function (l) {
      return matchLevel(l, S.query)
        && (!S.onlyOptions || (l.hidden_groups || []).length || (l.branches || []).length);
    });
    rows.sort(function (a, b) {
      return scoreOf(a, S.query) - scoreOf(b, S.query) || compareLevels(a, b);
    });
    return rows;
  }
  function variantLabel(v) {
    var text = String(v || '').trim();
    return text ? text.toUpperCase() : '原版';
  }
  function levelRowHtml(l) {
    var badges = '';
    if ((l.hidden_groups || []).length) {
      badges += '<span class=badge>隐藏组 ' + l.hidden_groups.length + '</span>';
    }
    if ((l.branches || []).length) {
      badges += '<span class=badge>分支 ' + l.branches.length + '</span>';
    }
    return '<div class="row' + (l.id === S.selected ? ' on' : '') + '" data-level="' + esc(l.id) + '">'
      + '<span class=code>' + esc(l.code || l.id) + '</span><span class=name>' + esc(l.name || '') + '</span>'
      + badges + '<span class=id>' + esc(l.id) + '</span></div>';
  }
  /* 同一关的多个版本（肉鸽 DLC / 轮换替换文件）显示成一行，版本用 chip 切换。 */
  function variantRowHtml(group) {
    var head = group[0], base = head.base || head.id;
    var hasSelected = group.some(function (l) { return l.id === S.selected; });
    var chips = group.map(function (l) {
      return '<span class="chip' + (l.id === S.selected ? ' on' : '') + '" data-level="' + esc(l.id)
        + '" title="' + esc(l.id) + '">' + esc(variantLabel(l.variant)) + '</span>';
    }).join('');
    return '<div class="row row-variants' + (hasSelected ? ' on' : '') + '">'
      + '<span class=code>' + esc(head.code) + '</span><span class=name>' + esc(head.name) + '</span>'
      + '<span class=variants>' + chips + '</span>'
      + '<span class=id>' + esc(base) + ' · 同关 ' + group.length + ' 版</span></div>';
  }
  function renderLevels() {
    var box = $('list');
    var rows = visibleLevels();
    var html = '', index = 0, chapter = null;
    while (index < rows.length) {
      var base = rows[index].base || rows[index].id;
      var group = [];
      while (index < rows.length && ((rows[index].base || rows[index].id) === base)) {
        group.push(rows[index]);
        index += 1;
      }
      var ch = chapterOf(group[0]);
      if (ch !== chapter) {
        chapter = ch;
        html += '<div class=chapter>' + (ch === 999 ? '其它' : '第 ' + ch + ' 章') + '</div>';
      }
      // 用户口径：同一关的多个版本（肉鸽 DLC / 轮换）各占一行，靠文件名（id）区分，不做 chip。
      for (var k = 0; k < group.length; k++) html += levelRowHtml(group[k]);
    }
    box.innerHTML = html || '<div class=empty>没有匹配的关卡</div>';
    $('count').textContent = rows.length + ' / ' + S.levels.length + ' 关（全部解包关卡）';
    Array.prototype.forEach.call(box.querySelectorAll('[data-level]'), function (n) {
      n.onclick = function () { select(n.dataset.level); };
    });
  }
  function optionControls(level) {
    var opts = (level && level.options) || {};
    var groups = opts.hidden_groups || [], branches = opts.branches || [];
    // 用户口径：地图在左，隐藏组 / 分支波次 / 随机刷怪组在右，右侧智能换行。
    var html = '<div class=opt-cols><div class=opt-map>'
      + '<div class=grp id=map-grp><div id=map-body></div></div></div>'
      + '<div class=opt-groups>';
    html += '<div class=grp><h4>隐藏组 hiddenGroup</h4>';
    html += groups.length ? groups.map(function (g) {
      return '<label class=chk><input type=checkbox data-g="' + esc(g.name) + '"'
        + (S.groups.indexOf(g.name) >= 0 ? ' checked' : '') + '> <code>' + esc(g.name)
        + '</code> <span class=muted>' + g.actions + ' 条 / ' + g.spawns + ' 个敌人</span></label>';
    }).join('') : '<div class=none>本关没有隐藏组</div>';
    html += '</div><div class=grp><h4>分支波次 branches</h4>';
    html += branches.length ? branches.map(function (b) {
      return '<label class=chk><input type=checkbox data-b="' + esc(b.name) + '"'
        + (S.branches.indexOf(b.name) >= 0 ? ' checked' : '') + '> <code>' + esc(b.name)
        + '</code> <span class=muted>' + b.phases + ' 段 / ' + b.spawns + ' 个敌人</span></label>';
    }).join('') + '<label class=chk>触发帧 <input type=number id=trigger min=0 value="' + S.branchTrigger + '"></label>'
      : '<div class=none>本关没有分支波次</div>';
    html += '</div>';
    html += randomGroupControls(level);
    html += '</div></div>';   // .opt-groups / .opt-cols
    return html;
  }
  /* 随机刷怪组（用户口径：分发版也要有本地版的一切）：
     `all` = 列出全部候选并在行上标「候选」；`seed` = 按关卡 `randomSeed` 用 JS 复刻的
     `System.Random` + `UniformWithWeight` 抽一条、其余候选不排进队列（客户端把它们置
     `isValid = false`，出队侧跳过且不占帧）。抽取算术仍是 candidate。 */
  function levelRandomSeed(level) {
    var id = (level && level.id) || S.selected;
    var entry = (window.__SPAWN_WAVES__ || {})[id];
    if (!entry || Array.isArray(entry)) return null;
    return (entry.rs === undefined) ? null : entry.rs;
  }
  function randomGroupStats(level) {
    // 注意：`optionControls()` 拿到的是**打包后的关卡条目**（只有 options/hidden_groups），
    // 没有 `waves`；随机组的候选要从 `spawn-waves.js` 的原始波次里数，所以这里必须先解析出
    // 带 waves 的关卡对象（曾经直接传打包条目 ⇒ 统计恒为 0 组 ⇒ 选择器根本不渲染）。
    // `optionControls()` 传进来的是**解码后的载荷**（有 level.id，但没有 waves）；
    // 也可能传打包条目（有 id 没有 waves）。两种都要能解析回 spawn-waves.js 里的原始波次。
    var lv = (level && level.waves) ? level : null;
    if (!lv) {
      var id = (level && (level.id || (level.level && level.level.id))) || S.selected;
      var entryObj = levelById(id);
      lv = rawLevelFor(entryObj || id);
    }
    var index = randomGroupIndex(lv || {});
    // 索引是「每个候选 action 一条」：key = "wi.fi.ai"，value = {group, size}。
    // 所以组数 = 不同 group 的个数，候选数 = 条目数（不是条目里的 .actions）。
    var keys = Object.keys(index || {});
    var groups = {};
    // 组名会在不同 fragment 复用（rogue_1-1 的 w0/f0 与 w0/f4 都叫 g1），
    // 所以「几组」必须按 (wave.fragment, group) 去重，而不是只按组名。
    keys.forEach(function (k) {
      groups[k.split('.').slice(0, 2).join('.') + '|' + index[k].group] = 1;
    });
    return { groups: Object.keys(groups).length, candidates: keys.length };
  }
  function randomGroupControls(level) {
    var stats = randomGroupStats(level);
    if (!stats.groups) return '<div class=grp><h4>随机刷怪组 randomSpawnGroupKey</h4><div class=none>本关没有随机刷怪组</div></div>';
    var seed = levelRandomSeed(level);
    var seedText = (seed === null || seed === undefined || Number(seed) < 0)
      ? '（本关 randomSeed 为 -1：实机由服务端随机）'
      : 'randomSeed = ' + Number(seed);
    var html = '<div class=grp><h4>随机刷怪组 randomSpawnGroupKey</h4>'
      + '<label class=chk>口径 <select id=rg-policy>'
      + '<option value=pinned' + (S.rgPolicy === 'pinned' ? ' selected' : '') + '>抽中的那一条（默认，与实机一致）</option>'
      + '<option value=all' + (S.rgPolicy === 'all' ? ' selected' : '') + '>全部候选（对比用，会多排几条）</option>'
      + '<option value=seed' + (S.rgPolicy === 'seed' ? ' selected' : '') + '>按 randomSeed 抽一条（candidate）</option>'
      + '</select> <span class=muted>' + stats.groups + ' 组 / ' + stats.candidates + ' 条候选</span></label>'
      + '<div class=zero>' + esc(seedText) + '；机制与随机源已 static 确认，抽取算术仍是 candidate'
      + '（详见 docs/02-knowledge/spawn-schedule.md §16）</div></div>';
    return html;
  }
  function spawnPointOf(row) {
    var table = (S.data.spawn_points || {})[row.route_source || 'routes'] || {};
    var sp = table[String(row.route)] || null;
    return (sp && !sp.placeholder) ? sp : null;
  }
  /* 随机刷怪组（`actions[].randomSpawnGroupKey`）：同组只出**抽中的那一条** ——
     客户端 `PhaseData::FetchActionsWithRandomSpawn`（0x42005cc）把落选的置 `isValid = 0`，
     出队侧 `_ExecuteActionQueue::MoveNext`（0x27e9c00）跳过它、不占帧。本页列出全部候选并逐行
     标注「N 选 1（候选）」；抽取算术（`UniformWithWeight` + `randomSeed`）仍是 candidate，
     详见 spawn-schedule.md §16。 */
  var RG_INDEX_CACHE = {};
  function randomGroupIndex(level) {
    // 只有**带 waves 的原始关卡**才有候选可数。曾经用「解码后的载荷/打包条目」调用过这里，
    // 它没有 waves ⇒ 得到空索引，却把空索引按 level.id 缓存下来（缓存投毒），
    // 之后每次统计都是 0 组，页面上「随机刷怪组」选择器永远不出现。
    if (!level || !level.waves) return {};
    // 只有带 id 的关卡才进缓存：曾经没有 id 时统一用 '__' 当键，于是**第一关**（默认 0-1，
    // 没有随机组）算出的空索引被所有后续关卡共用，导致别的关卡永远显示「本关没有随机刷怪组」。
    var key = level.id || null;
    if (key && RG_INDEX_CACHE[key]) return RG_INDEX_CACHE[key];
    var index = {};
    var waves = level.waves || [];
    for (var wi = 0; wi < waves.length; wi++) {
      var frags = waves[wi].fragments || [];
      for (var fi = 0; fi < frags.length; fi++) {
        var acts = frags[fi].actions || [];
        var sizes = {};
        var ai;
        for (ai = 0; ai < acts.length; ai++) {
          var g = acts[ai] && acts[ai].randomSpawnGroupKey;
          if (g) sizes[g] = (sizes[g] || 0) + 1;
        }
        for (ai = 0; ai < acts.length; ai++) {
          var g2 = acts[ai] && acts[ai].randomSpawnGroupKey;
          if (g2) index[wi + '.' + fi + '.' + ai] = { group: g2, size: sizes[g2] };
        }
      }
    }
    if (key) RG_INDEX_CACHE[key] = index;
    return index;
  }
  function applyRandomGroups(rows, level) {
    var index = randomGroupIndex(level);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.track === 'branch' || r.wave === null || r.wave === undefined) continue;
      var hit = index[r.wave + '.' + r.fragment + '.' + r.action];
      if (hit) { r.random_group = hit.group; r.random_group_size = hit.size; }
    }
    return rows;
  }
  //: 当前关卡里所有 (组, 候选) 的平铺顺序（用 spawn-waves 的原始波次数出来）。
  function rgPairs() {
    var lv = rawLevelFor(levelById(S.selected) || S.selected);
    if (!lv) return [];
    var index = randomGroupIndex({ id: S.selected, waves: lv.waves });
    var seen = {}, out = [];
    Object.keys(index).forEach(function (k) {
      var parts = k.split('.');
      var key = parts[0] + '.' + parts[1] + '|' + index[k].group;
      if (seen[key]) return;
      seen[key] = 1;
      for (var i = 0; i < (index[k].size || 1); i++) {
        out.push({ wave: Number(parts[0]), fragment: Number(parts[1]),
                   group: index[k].group, index: i, size: index[k].size || 1 });
      }
    });
    return out;
  }
  function rgPinsForCursor(cursor) {
    var pairs = rgPairs();
    if (!pairs.length) return {};
    var at = pairs[((cursor % pairs.length) + pairs.length) % pairs.length];
    var pins = {}, seen = {};
    pairs.forEach(function (p) {
      var key = p.group + '@w' + p.wave + '/f' + p.fragment;
      if (seen[key]) return;
      seen[key] = 1;
      pins[key] = (p.group === at.group && p.wave === at.wave && p.fragment === at.fragment)
        ? at.index : 0;
    });
    return pins;
  }
  // 备注列的随机组标记（用户口径 8）：`随机组 e1，当前 1/2，概率 1%`。
  //   当前 x/N = 这一组现在显示的第几条候选；概率 p% = 该候选 weight ÷ 组内 weight 之和。
  function randomGroupPercent(weights, index) {
    if (!weights || !weights.length) return null;
    var total = weights.reduce(function (a, b) { return a + Number(b || 0); }, 0);
    if (!(total > 0)) return null;
    var pct = Number(weights[index] || 0) * 100 / total;
    return Math.abs(pct - Math.round(pct)) < 1e-9 ? (Math.round(pct) + '%') : (pct.toFixed(1) + '%');
  }
  function randomGroupTag(row) {
    if (!row || !row.random_group) return '';
    var size = Number(row.random_group_size || 0) || 1;
    var weights = (row.random_group_weights && row.random_group_weights.length)
      ? row.random_group_weights : null;
    var groupKey = row.random_group + '@w' + row.wave + '/f' + row.fragment;
    var pin = Number((S.rgPins || {})[groupKey] || 0);
    var pct = randomGroupPercent(weights, pin) || (1 / size);
    var title = '点击切换：' + row.random_group + ' 共 ' + size + ' 种候选，当前第 ' + (pin + 1) + ' 种'
      + (weights ? '（权重 ' + weights.join('/') + '）' : '')
      + '· 客户端只出抽中的那一条（PhaseData::FetchActionsWithRandomSpawn 0x42005cc）';
    // 非 all 口径下，这一行就是被选中的那条（seed 抽中 / pinned 手动指定）→ 加 chosen 类。
    var cls = 'tag rg' + (S.rgPolicy !== 'all' && row.random_group_chosen ? ' chosen' : '');
    return '<span class="' + cls + '" data-rg="' + esc(groupKey) + '" data-rg-size="' + size
      + '" title="' + esc(title) + '">随机组 ' + esc(row.random_group)
      + '，当前 ' + (pin + 1) + '/' + size + '，概率 ' + esc(pct) + '</span>';
  }
  function rowHtml(row, index) {
    var sp = spawnPointOf(row);
    var isSpawn = !!row.is_spawn;
    var where = row.track === 'branch'
      ? '分支 ' + esc(row.branch || '') + ' p' + row.phase
      : 'w' + row.wave + ' f' + row.fragment + ' a' + row.action + '#' + row.seq;
    var spKey = sp ? ' data-sp="' + esc((row.route_source || 'routes') + ':' + row.route) + '"' : '';
    var picked = (S.sel && S.sel.has(index)) ? ' sel' : '';
    var pickable = sp ? ' pickable' : '';
    return '<tr class="' + (isSpawn ? 'row-spawn' : 'row-other') + picked + pickable
      + '" data-row="' + index + '" data-frame="' + row.actual_frame + '"'
      + spKey + '>'
      + '<td class=kind>' + esc(row.kind) + '</td>'
      + '<td><b>' + sf(row.actual_frame) + '</b> <span class=zero>' + row.actual_frame + '</span></td>'
      + '<td class="sp-cell"' + (sp ? ' data-sp="' + esc((row.route_source || 'routes') + ':' + row.route) + '"' : '')
      + ' title="' + (sp ? '出生点 ' + esc(sp.label) + '（prts.map 坐标）' : '') + '">'
      + (sp ? '<b>' + esc(sp.label) + '</b>' : '-') + '</td>'
      // 敌人 / 内容：本地版（preview/spawn-times.js）一直是「名字 + 编号」两段，
      // 分发版这里跟它对齐；非 SPAWN 行本来就没有名字，只显示内容 key。
      + '<td>' + (row.enemy_name
          ? esc(row.enemy_name) + ' <span class=tag>' + esc(row.key || '') + '</span>'
          : esc(row.key || '')) + '</td>'
      // 用户口径：删掉「来源 / 路线」列后每行必须只剩 5 格（多一格会把最后一列挤出可视区）。
      + '<td><span class=zero>' + where + '</span>'
      + (row.hidden_group ? ' <span class=tag>隐藏组 ' + esc(row.hidden_group) + '</span>' : '')
      + randomGroupTag(row) + delayToBornTag(row) + '</td>'
      + '</tr>';
  }
  //: 敌人 prefab 的 `_DelayToBorn`（帧）。它**不在关卡数据里**，单独存在敌人库
  //: （导出时按 `enemyDbRefs` + 关卡真正用到的 action.key 裁成 `spawn-waves.js` 的 `d`），
  //: 客户端 `Scheduler::_DealAction`（ARM64 0x27e3600 fsub / 0x27e3604 fmax）对 SPAWN 条目
  //: 做 `t = max(t - delayToBorn, 0)`。页面在备注列标出非零值，方便手算时别忘了这一步。
  function levelDelayTable() {
    var id = S.selected;
    if (!id) return null;
    var entry = (window.__SPAWN_WAVES__ || {})[id];
    if (!entry || Array.isArray(entry)) return null;
    return entry.d || null;
  }
  function delayToBornTag(row) {
    if (!row || !row.is_spawn || !row.key) return '';
    var table = levelDelayTable();
    var frames = table ? Number(table[row.key]) : 0;
    if (!frames) {
      // 变体 id（`enemy_2133_shdopl_b`）在导出时已按 base 回退写进表里，这里再兜一层
      var base = String(row.key).replace(/^(.+?)_[a-z]\d*$/, '$1');
      frames = table ? Number(table[base] || 0) : 0;
    }
    if (!(frames > 0)) return '';
    var seconds = frames / 30;
    var title = 'enemy ' + row.key + ' 的 _DelayToBorn = ' + frames + ' 帧（' + seconds
      + 's）：客户端对 SPAWN 条目做 t = max(t - delayToBorn, 0)，这一行的实际帧已按此提前；'
      + '值来自独立的敌人库（spawn-waves.js 的 d 表，导出源 enemy-delay-born-global.json）';
    return ' <span class="tag shift" title="' + esc(title) + '">delayToBorn ' + seconds + 's</span>';
  }
  function gateRowHtml(gate) {
    var prev = (gate.prev_last_spawn === null || gate.prev_last_spawn === undefined)
      ? '-' : sf(gate.prev_last_spawn);
    return '<div class="row-gate gate-line" data-gate-row="' + gate.wave + '">'
      + '<span class=gate-label>' + esc(gate.wave_label || ('第 ' + (gate.wave + 1) + ' 波'))
      + ' 波次门</span> 上一波结束帧 <input type=number class=gate-input data-gate="' + gate.wave
      + '" min=0 value="' + (gate.frame === null || gate.frame === undefined ? '' : gate.frame) + '"> '
      + '<span class=zero>默认 = 较晚者（上一波末怪 ' + esc(prev) + ' + 1 = '
      + esc(gate.prev_last_spawn_plus1) + '，上一波排空 ' + sf(gate.prev_wave_end) + '）= <b>'
      + sf(gate.default_frame) + '</b></span>'
      + (gate.source === 'user' ? ' <span class=tag>手动</span>' : '') + '</div>';
  }

  // 列宽由表头（grid）与每个 fragment 的事件表（table-layout:fixed）共用**同一组像素值**。
  // 列宽（用户口径 2026-09-18）：表头分隔条可拖动调整；切换关卡时按内容自动适配。
  //
  // 为什么必须两边同一组像素：`table-layout:fixed` 的表格在自身宽度大于列宽之和时会把富余宽度
  // **按比例**摊到各列，而表头 grid 用的是写死的像素 —— 两边会差 5px 级并逐列累积，
  // 横向滚动时表头还会在右半边整段空白。现在两边写死同一组像素、并把富余宽度算进列宽里，
  // 所以「表头 ↔ 事件列」逐像素对齐；只有内容真的放不下时才横向滚动（最右一列仍能滚到）。
  var TL_DEFAULT = [104, 132, 108, 320, 190];
  var TL_MIN = 56, TL_MAX = 520;
  var TL_WIDTHS = TL_DEFAULT.slice();
  var TL_DRAGGED = false;
  function tlWidth(w) { return Math.max(TL_MIN, Math.round(w || 120)); }
  function tlSumW() {
    return TL_WIDTHS.reduce(function (a, w) { return a + tlWidth(w); }, 0);
  }
  function tlColsCss() {
    return TL_WIDTHS.map(function (w) { return tlWidth(w) + 'px'; }).join(' ');
  }
  function tlColsHtml() {
    return TL_WIDTHS.map(function (w) {
      return '<col style="width:' + tlWidth(w) + 'px">';
    }).join('');
  }
  function applyColWidths() {
    var sum = tlSumW();
    var head = document.querySelector('#timeline .tl-head');
    if (head) {
      head.style.gridTemplateColumns = tlColsCss();
      head.style.width = sum + 'px';
    }
    Array.prototype.forEach.call(document.querySelectorAll('#timeline table.ev-table'), function (t) {
      t.style.width = sum + 'px';
    });
    Array.prototype.forEach.call(document.querySelectorAll('#timeline colgroup'), function (cg) {
      TL_WIDTHS.forEach(function (w, i) {
        var c = cg.children[i];
        if (c) c.style.width = tlWidth(w) + 'px';
      });
    });
  }
  // 切关卡自动适配：列内是 nowrap，`scrollWidth` 能测出内容宽，取表头与所有单元格的最大值。
  function autoFitColumns() {
    var head = document.querySelector('#timeline .tl-head');
    var tl = $('timeline');
    if (!head || !tl) return;
    TL_WIDTHS = TL_DEFAULT.slice();
    applyColWidths();
    var need = TL_DEFAULT.map(function () { return 0; });
    Array.prototype.forEach.call(head.children, function (sp, i) {
      if (i < need.length) need[i] = Math.max(need[i], sp.scrollWidth || 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#timeline td'), function (td) {
      var tr = td.parentElement;
      if (!tr) return;
      var i = Array.prototype.indexOf.call(tr.children, td);
      if (i >= 0 && i < need.length) need[i] = Math.max(need[i], td.scrollWidth || 0);
    });
    var w = need.map(function (v, i) {
      return Math.max(TL_MIN, Math.min(TL_MAX, Math.ceil(v + 18))) || TL_DEFAULT[i];
    });
    // 富余宽度按列宽比例摊回去：表格正好铺满容器（= 表头宽度），两边列宽逐像素相同；
    // 内容放不下时保持内容宽，让 #timeline 横向滚动到最后一列。
    var avail = Math.max(320, tl.clientWidth - 40);   // 40 = 表头/事件表左右各 20px 的内缩
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    if (sum < avail) {
      var rest = avail - sum;
      w = w.map(function (v) { return v + Math.floor(rest * (v / sum)); });
      rest = avail - w.reduce(function (a, b) { return a + b; }, 0);
      for (var i = 0; rest > 0; i = (i + 1) % w.length) { w[i] += 1; rest -= 1; }
    }
    TL_WIDTHS = w;
    applyColWidths();
  }
  function bindColumnResize() {
    var head = document.querySelector('#timeline .tl-head');
    if (!head || head.dataset.resize === '1') return;
    head.dataset.resize = '1';
    Array.prototype.forEach.call(head.querySelectorAll('.col-resize'), function (handle) {
      var col = Number(handle.dataset.col);
      handle.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var startX = ev.clientX;
        var cell = head.children[col];
        var startW = (cell && cell.getBoundingClientRect) ? cell.getBoundingClientRect().width : 120;
        var move = function (e) {
          TL_DRAGGED = true;
          TL_WIDTHS[col] = Math.max(TL_MIN, Math.min(TL_MAX, Math.round(startW + (e.clientX - startX))));
          applyColWidths();
        };
        var up = function () {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      handle.addEventListener('dblclick', function (ev) { ev.stopPropagation(); autoFitColumns(); });
    });
  }
  function fragInfoOf(frags, wave, fragment) {
    for (var i = 0; i < frags.length; i++) {
      if (frags[i].wave === wave && frags[i].fragment === fragment) return frags[i];
    }
    return null;
  }

  /* 嵌套盒子：波次盒（.wave-box）> fragment 盒（.frag-box）> 事件行（还是 <tr data-row>），
     所以点击选择 / Ctrl / Shift 多选 / 地图打点的钩子都不用改。 */
  function timelineHtml(data) {
    var rows = (data.rows || []).concat(data.branch_rows || []);
    if (S.spawnOnly) rows = rows.filter(function (r) { return r && r.is_spawn; });
    var gates = {};
    ((data && data.wave_gates) || []).forEach(function (g) { gates[g.wave] = g; });
    var frags = ((data.summary || {}).fragments || []).filter(function (f) { return f.fragment !== null; });
    S.rows = rows;
    S.spawnNo = spawnOrdinals(rows);

    var boxes = {}, boxOrder = [];
    rows.forEach(function (row, index) {
      var isBranch = row.track === 'branch';
      var key = isBranch ? 'b|' + row.branch + '|' + row.phase : 'w|' + row.wave + '|' + row.fragment;
      var box = boxes[key];
      if (!box) {
        box = { branch: isBranch, wave: row.wave, fragment: row.fragment, label: row.branch,
                phase: row.phase, items: [], spawns: 0 };
        boxes[key] = box;
        boxOrder.push(box);
      }
      box.items.push({ row: row, index: index });
      if (row.is_spawn) box.spawns += 1;
    });

    var waves = {}, waveOrder = [];
    boxOrder.forEach(function (box) {
      var key = box.branch ? 'b|' + box.label + '|' + box.phase : 'w|' + box.wave;
      var w = waves[key];
      if (!w) {
        w = { branch: box.branch, wave: box.wave, label: box.label, phase: box.phase, frags: [] };
        waves[key] = w;
        waveOrder.push(w);
      }
      w.frags.push(box);
    });

    var body = '';
    waveOrder.forEach(function (w) {
      var spawns = 0, lo = null, hi = null;
      w.frags.forEach(function (f) {
        spawns += f.spawns;
        f.items.forEach(function (it) {
          var fr = it.row.actual_frame;
          if (typeof fr === 'number') {
            if (lo === null || fr < lo) lo = fr;
            if (hi === null || fr > hi) hi = fr;
          }
        });
      });
      var span = (lo === null) ? '' : ' · ' + sf(lo) + ' → ' + sf(hi);
      body += '<div class="wave-box' + (w.branch ? ' branch-box' : '') + '">'
        + '<div class=wave-head>' + (w.branch
          ? '分支 ' + esc(w.label || '') + ' · p' + esc(w.phase) + ' · 生成 ' + spawns + ' 次' + span
          : '第 ' + (Number(w.wave) + 1) + ' 波 · w' + w.wave + ' · fragment ' + w.frags.length
            + ' 段 · 生成 ' + spawns + ' 次' + span) + '</div>';
      if (!w.branch && gates[w.wave]) body += gateRowHtml(gates[w.wave]);
      w.frags.forEach(function (f) {
        var info = w.branch ? null : fragInfoOf(frags, w.wave, f.fragment);
        body += '<div class=frag-box><div class="frag-head row-frag">'
          + (w.branch
            ? '分支片段 · ' + esc(w.label || '') + ' p' + esc(w.phase) + ' · 生成 ' + f.spawns + ' 次'
            : 'fragment f' + f.fragment + ' · 起点 ' + (info ? sf(info.start_frame) : '-')
              + ' → 排空到 <b>' + (info ? sf(info.completion_frame) : '-') + '</b>（队列条目 '
              + (info ? info.queue_entries : '-') + '） · 生成 ' + f.spawns + ' 次')
          + '</div><table class=ev-table style="width:' + tlSumW() + 'px"><colgroup>' + tlColsHtml() + '</colgroup><tbody>'
          + f.items.map(function (it) { return rowHtml(it.row, it.index); }).join('')
          + '</tbody></table></div>';
      });
      body += '</div>';
    });
    return '<div class=tl-head style="width:' + tlSumW() + 'px;grid-template-columns:' + tlColsCss() + '">'
      + '<span>事件<i class=col-resize data-col=0 title="拖动调整列宽，双击恢复自适应"></i></span>'
      + '<span>实际时间<i class=col-resize data-col=1 title="拖动调整列宽，双击恢复自适应"></i></span>'
      + '<span>出生点(prts.map)<i class=col-resize data-col=2 title="拖动调整列宽，双击恢复自适应"></i></span>'
      + '<span>敌人 / 内容<i class=col-resize data-col=3 title="拖动调整列宽，双击恢复自适应"></i></span>'
      + '<span>备注<i class=col-resize data-col=4 title="拖动调整列宽，双击恢复自适应"></i></span></div>'
      + '<div class=tl-body>' + (body || '<div class=none>没有事件</div>') + '</div>';
  }

  /* 常驻地图：点行把出生点画上去（Ctrl 单行切换 / Shift 整段选），数字=全局第几个出生。
     同一格上的多行按出生时间先后叠加，后出生的覆盖旧的（用户口径：不管遮挡）。 */
  function spawnOrdinals(rows) {
    var out = {}, n = 0;
    (rows || []).forEach(function (row, i) { if (row && row.is_spawn) out[i] = ++n; });
    return out;
  }

  function selectedMarkers(data, selected, rows, spawnNo) {
    var list = [], map = (data && data.map) || {};
    var rowCount = map.rows || ((map.cells || []).length);
    (selected || []).forEach(function (index) {
      var row = (rows || [])[index];
      if (!row) return;
      var sp = spawnPointOf(row);
      if (!sp || sp.col === null || sp.col === undefined) return;
      var sr = (sp.serialized_row !== null && sp.serialized_row !== undefined)
        ? Number(sp.serialized_row) : (sp.row !== null ? rowCount - 1 - Number(sp.row) : null);
      if (sr === null) return;
      list.push({ r: sr, c: Number(sp.col),
                  label: (spawnNo[index] !== undefined ? String(spawnNo[index]) : '*'),
                  frame: row.actual_frame || 0, spawn: !!row.is_spawn });
    });
    list.sort(function (a, b) { return a.frame - b.frame; });
    return list;
  }

  function mapBodyHtml(data, selected, rows, spawnNo) {
    var map = (data && data.map) || {}, cells = map.cells || [];
    var rowCount = map.rows || cells.length;
    var cols = map.cols || ((cells[0] || []).length);
    if (!rowCount || !cols) return '<div class=none>本关没有地图数据</div>';
    var marks = {};
    selectedMarkers(data, selected, rows, spawnNo).forEach(function (m) { marks[m.r + ',' + m.c] = m; });
    var out = [];
    for (var r = 0; r < rowCount; r++) {
      for (var c = 0; c < cols; c++) {
        var cls = (cells[r] || [])[c] || 'ground';
        var m2 = marks[r + ',' + c];
        out.push('<i class="c-' + esc(cls) + (m2 ? ' has-mk' : '') + '">'
          + (m2 ? '<b class="mk' + (m2.spawn ? '' : ' alt') + '">' + esc(m2.label) + '</b>' : '') + '</i>');
      }
    }
    var picked = (selected || []).length;
    return '<div class=map-head>地图' + (picked ? '（已选 ' + picked + ' 行）' : '') + '</div>'
      + '<div class=spawn-map id=spawn-map style="grid-template-columns:repeat(' + cols + ',22px)">'
      + out.join('') + '</div>'
      + '<div class=map-legend><i class="c-start"></i>侵入点 <i class="c-end"></i>保护点'
      + ' <span class=tag>数字=全局第几个出生</span> <span class=tag>shift/ctrl 多选</span></div>';
  }

  function mapPanelHtml(data, selected, rows, spawnNo) {
    return '<div class=grp id=map-grp><div id=map-body>'
      + mapBodyHtml(data, selected, rows, spawnNo) + '</div></div>';
  }

  function applySelection(selected, anchor, index, ctrl, shift) {
    var cur = new Set(selected || []);
    if (shift && anchor !== null && anchor !== undefined) {
      var lo = Math.min(anchor, index), hi = Math.max(anchor, index);
      for (var i = lo; i <= hi; i++) cur.add(i);
      return { selected: cur, anchor: anchor };
    }
    if (ctrl) {
      if (cur.has(index)) cur.delete(index); else cur.add(index);
      return { selected: cur, anchor: index };
    }
    return { selected: new Set([index]), anchor: index };
  }

  function bindRowSelection() {
    var box = $('timeline');
    if (!box || box.dataset.pick === '1' || !box.addEventListener) return;
    box.dataset.pick = '1';
    box.addEventListener('click', function (ev) {
      // 备注列里的随机刷怪组标签：点一下切到下一个候选（pinned 口径）。
      var tag = ev.target.closest && ev.target.closest('.tag.rg[data-rg]');
      if (tag) {
        ev.stopPropagation();
        ev.preventDefault();
        // 用户口径：点一次轮换到下一格，跨组循环（e1 → e2 → e3 → e1）。
        S.rgCursor = (Number(S.rgCursor || 0) + 1) % Math.max(1, rgPairs().length);
        S.rgPins = rgPinsForCursor(S.rgCursor);
        S.rgPolicy = 'pinned';
        recompute({});
        return;
      }
      var tr = ev.target.closest && ev.target.closest('tr[data-row]');
      if (!tr) return;
      var index = Number(tr.dataset.row);
      if (!isFinite(index)) return;
      var next = applySelection(S.sel, S.selAnchor, index, ev.ctrlKey || ev.metaKey, ev.shiftKey);
      S.sel = next.selected;
      S.selAnchor = next.anchor;
      render();
    });
  }

  /* 随机组的摘要：本页只列候选，必须把「同组只出一条」写出来，否则会被读成怪翻倍。 */
  function randomGroupSummary(data) {
    var rg = data && data.random_groups;
    var counts = (rg && rg.counts) || null;
    var groups = 0;
    if (counts && counts.groups) groups = counts.groups;
    else {
      // 行上已带 `random_group`（导出载荷自带；本地重算由 applyRandomGroups 打标）
      var seen = {};
      (data.rows || []).forEach(function (r) {
        if (r && r.random_group) seen[r.wave + '.' + r.fragment + '.' + r.random_group] = 1;
      });
      groups = Object.keys(seen).length;
    }
    if (!groups) return '';
    var seed = (rg && rg.seed !== null && rg.seed !== undefined) ? '，randomSeed ' + rg.seed : '';
    return ' <span class="tag candidate" title="同组只出抽中的那一条（PhaseData::FetchActionsWithRandomSpawn 0x42005cc；'
      + '落选条目 isValid=0，出队侧跳过且不占帧）。抽取算术仍是 candidate，见 spawn-schedule.md §16">随机组 '
      + groups + ' 组 · ' + ((rg && rg.policy === 'all')
        ? '已列出全部候选（对比口径）'
        : (rg && rg.policy === 'seed' ? '按 randomSeed 抽中的一条' : '当前候选（与实机一致：每组只出 1 条）'))
      + seed + '</span>';
  }

  function render() {
    var data = S.data;
    if (!data) return;
    $('head').innerHTML = '<div class=title>' + esc(data.level.code + ' · ' + data.level.name)
      + '</div><div class=path>' + esc(data.level.id + ' · ' + data.level.path) + '</div>';
    $('options').innerHTML = optionControls(data);
    var s = data.summary || {};
    var spawns = (data.rows || []).filter(function (r) { return r.is_spawn; });
    var rgSummary = randomGroupSummary(data);
    $('summary').innerHTML = '生成 <b>' + (s.spawns || 0) + '</b> 次'
      + (spawns.length ? ' · 首怪 ' + sf(spawns[0].actual_frame) + ' · 末怪 ' + sf(spawns[spawns.length - 1].actual_frame) : '')
      + (data.branch_notice ? ' <span class=tag>' + esc(data.branch_notice) + '</span>' : '')
      + rgSummary;
    $('timeline').innerHTML = timelineHtml(data);
    bindRowSelection();
    // 用户口径：列宽可拖动，切换关卡时自动按内容适配。
    autoFitColumns();
    bindColumnResize();
    var mapBody = $('map-body');
    if (mapBody) mapBody.innerHTML = mapBodyHtml(S.data, S.sel, S.rows, S.spawnNo);
    Array.prototype.forEach.call($('options').querySelectorAll('[data-g]'), function (n) {
      n.onchange = function () { toggleGroup(n.dataset.g, n.checked); };
    });
    Array.prototype.forEach.call($('options').querySelectorAll('[data-b]'), function (n) {
      n.onchange = function () { toggleBranch(n.dataset.b, n.checked); };
    });
    var trig = $('trigger'); if (trig) trig.onchange = function () { S.branchTrigger = Math.max(0, Number(trig.value) || 0); recompute({}); };
    // 随机刷怪组口径选择器：`#options` 每次 render() 都会重建，必须在这里重新绑。
    var rgSel = $('rg-policy');
    if (rgSel) rgSel.onchange = function () { S.rgPolicy = rgSel.value; recompute({}); };
    Array.prototype.forEach.call($('timeline').querySelectorAll('[data-gate]'), function (n) {
      n.onchange = function () {
        var w = String(n.dataset.gate);
        if (n.value === '' || !isFinite(Number(n.value))) delete S.gates[w];
        else S.gates[w] = Math.max(0, Math.round(Number(n.value)));
        recompute({});
      };
    });
  }
  function toggleGroup(name, on) {
    var i = S.groups.indexOf(name);
    if (on && i < 0) S.groups.push(name);
    if (!on && i >= 0) S.groups.splice(i, 1);
    recompute({});
  }
  function toggleBranch(name, on) {
    var i = S.branches.indexOf(name);
    if (on && i < 0) S.branches.push(name);
    if (!on && i >= 0) S.branches.splice(i, 1);
    recompute({});
  }
  /* 隐藏组任意子集 → 用 JS 核心现算（与 Python 逐条对拍过）；
     分支波次只有预计算的那几种组合（触发帧是运行时的，标 candidate）。 */
  function levelById(id) {
    for (var i = 0; i < (D.levels || []).length; i++) if (D.levels[i].id === id) return D.levels[i];
    return null;
  }
  function recompute(over) {
    over = over || {};
    // 注意：S.selected 是**关卡 id 字符串**，本地重算要的是关卡对象（曾经直接传字符串，
    // 于是隐藏组重算静默算出 0 行 —— 页面看着像「勾了没反应」）。
    var level = S.custom || levelById(S.selected) || S.selected;
    // 分发版是 gzip+base64：boot() 时 S.data 还不存在（载荷由页内 bootstrap 解压后才到），
    // 所以这里必须容忍 null，不能直接读 S.data.xxx（否则 boot 抛异常、页面只剩错误提示）。
    var prev = S.data || {};
    var consumption = over.consumption || prev.consumption || 'client_accumulated';
    var queueOrder = over.queue_order || prev.queue_order || 'mono_qsort';
    // 预计算载荷是 `all` 口径；选了 `seed` 就必须本地现算（否则页面显示的还是全部候选）。
    // `pinned` 不带 pins = 每一组都取第 0 条候选（= 页面默认口径，与实机一致：
    // 客户端每组只出一条）。以前这里会把 pinned 回退成 all（把落选条目也排进队列），
    // 于是畸症这类关卡默认就比实机晚 1 帧，点标签切回第 1 条也和初始显示不一致。
    var seededRG = (S.rgPolicy === 'seed' || S.rgPolicy === 'pinned');
    var encoded = (S.custom || seededRG) ? null
      : (D.payloads[comboKey(S.selected, S.groups, S.branches, S.branchTrigger)] || null);
    var payload = null;
    var notice = '';
    if (!encoded && S.branches.length) {
      // 分支波次的触发帧是运行时的：分发版只预计算「全开 + 触发帧 0/300」这几种组合，
      // 其余组合本地算不了，如实说明，不假装分支行已经算过。
      notice = '本关没有可用的分支定义（spawn-waves.js 缺 branches），只显示常规波次。';
    }
    // 出生点/地图只存在于预计算载荷里（分发包不塞原始 mapData/routes）：
    // 本地重算（隐藏组子集 / 随机组口径 / 默认 pinned）之前先把它们缓存好，
    // 否则出生点列会空白、右侧常驻地图是 0 格。
    ensureMapCache(level, S.selected);
    if (!encoded) {
      try {
        payload = computeLocally(level, consumption, queueOrder);
      } catch (e) {
        // 本地重算要 spawn-waves.js；缺它的关卡退回预计算载荷（`all` 口径），
        // 只把口径差异写在提示里，不让整页变成错误页。
        var fallback = D.payloads[comboKey(S.selected, [], [], 0)] || null;
        if (!fallback) {
          renderMessage(e && e.message ? e.message : String(e));
          return;
        }
        payload = decodePayload(fallback);
        payload.branch_notice = '本地重算不可用（' + (e && e.message ? e.message : String(e))
          + '），这里退回预计算载荷：随机刷怪组按「全部候选」列出。';
      }
      if (notice) payload.branch_notice = notice;
    } else {
      payload = decodePayload(encoded);
      payload.consumption = consumption;
      payload.queue_order = queueOrder;
      if (notice) payload.branch_notice = notice;
      // 缓存这一关的地图/出生点给本地重算用（见 localMap/localSpawnPoints）。
      MAP_CACHE[S.selected || (S.custom && S.custom.id) || level.id] =
        { map: payload.map, spawn_points: payload.spawn_points, wave_gates: payload.wave_gates || null };
    }
    S.data = applyGates(payload, S.gates || {});
    render();
  }
  /* 波次门：下一波要等这一波的怪全部离场。页面让用户填「上一波结束帧」，默认 = 上一波末怪 + 1。
     关键：载荷里的帧**已经按默认门值平移过**（导出时 st.build 就带默认门），所以这里只能算
     「相对默认值的额外位移」——以前拿 entry_cursor 当基线，等于把默认位移再加一遍
     （rogue4_b-6 末怪 9599 → 16105 就是这么来的）。 */
  function applyGates(base, userGates) {
    var out = base;
    var gates = (out.wave_gates || []).map(function (g) { return Object.assign({}, g); });
    if (!gates.length) return out;
    var acc = 0, shifts = [];
    gates.forEach(function (g) {
      var typed = userGates[g.wave];
      var hasUser = !(typed === undefined || typed === null || typed === '');
      var target = hasUser ? Number(typed) : Number(g.frame);
      if (!isFinite(target)) return;
      var baseline = Number(g.default_frame === undefined || g.default_frame === null
        ? g.frame : g.default_frame);
      var extra = Math.max(0, target - baseline - acc);
      acc += extra;
      shifts.push([g.wave, acc]);
      g.frame = target;
      g.requested_frame = hasUser ? target : null;
      g.extra_shift = extra;
      g.source = hasUser ? 'user' : 'default';
    });
    if (!acc) { out.wave_gates = gates; return out; }
    var shiftOf = function (wave) {
      var d = 0;
      shifts.forEach(function (pair) { if (wave >= pair[0]) d = pair[1]; });
      return d;
    };
    (out.rows || []).forEach(function (r) {
      var d = (r.track === 'wave' && r.wave !== null && r.wave !== undefined) ? shiftOf(r.wave) : 0;
      if (!d) return;
      r.actual_frame += d;
      if (r.ideal_frame != null) r.ideal_frame += d;
      if (r.config_frame != null) r.config_frame += d;
      if (r.gate_frame != null) r.gate_frame += d;
    });
    (out.branch_rows || []).forEach(function (r) {
      if (r.gate_frame != null) r.gate_frame += acc;
    });
    var frags = ((out.summary || {}).fragments || []);
    frags.forEach(function (f) {
      var d = shiftOf(f.wave);
      if (!d) return;
      if (f.start_frame != null) f.start_frame += d;
      if (f.completion_frame != null) f.completion_frame += d;
    });
    out.wave_gates = gates;
    return out;
  }

  function comboKey(id, groups, branches, trigger) {
    return [id, groups.slice().sort().join(','), branches.slice().sort().join(','), trigger].join('#');
  }
  /* 数据文件是紧凑线格式（全部 3876 关也能塞进去），选中时按需解码。 */
  function decodePayload(encoded) {
    return (encoded && encoded.l && window.SpawnCodec)
      ? window.SpawnCodec.decodePayload(encoded, { keys: D.keys || [], names: D.names || [],
                                                   groups: D.groups || [], version: D.version,
                                                   rgkeys: D.rgkeys || [] })
      : JSON.parse(JSON.stringify(encoded || {}));
  }
  /* 出生点 / 地图与隐藏组、随机组都无关，只存在于预计算载荷里；本地重算之前先缓存一份。 */
  function ensureMapCache(level, levelId) {
    var key = levelId || (level && level.id) || 'custom';
    if (MAP_CACHE[key]) return MAP_CACHE[key];
    var base = D.payloads[comboKey(key, [], [], 0)] || null;
    if (!base) return null;
    var decoded = decodePayload(base);
    // `wave_gates` 一起缓存：本地重算（隐藏组子集 / 随机组口径 / 默认 pinned）必须带上
    // 同一份波次门真值，否则 wave>=1 的波次会被算早（见 computeLocally 里那段注释）。
    MAP_CACHE[key] = { map: decoded.map, spawn_points: decoded.spawn_points,
                       wave_gates: decoded.wave_gates || null };
    return MAP_CACHE[key];
  }
  function mapCells(level) {
    var md = level.mapData || {}, grid = md.map || [], tiles = md.tiles || [];
    var rows = grid.length, cols = grid.reduce(function (n, r) { return Math.max(n, r.length); }, 0);
    var out = [];
    for (var r = 0; r < rows; r++) {
      var line = [];
      for (var c = 0; c < cols; c++) {
        var idx = grid[r][c], t = tiles[idx] || {}, key = String(t.tileKey || ''), mask = String(t.passableMask || '');
        line.push(key === 'tile_start' ? 'start' : key === 'tile_end' ? 'end' : key.indexOf('hole') >= 0 ? 'hole'
          : key.indexOf('wall') >= 0 || mask === 'FLY_ONLY' ? (key.indexOf('wall') >= 0 ? 'wall' : 'flyonly')
            : String(t.heightType) === 'HIGHLAND' ? 'highland' : 'ground');
      }
      out.push(line);
    }
    return { rows: rows, cols: cols, cells: out };
  }
  function spawnPoints(level) {
    var md = level.mapData || {}, rows = (md.map || []).length, out = {};
    [['routes', 'routes'], ['extraRoutes', 'extraRoutes']].forEach(function (pair) {
      var table = {};
      C.entries(level[pair[0]]).forEach(function (r, i) {
        var pos = (r || {}).startPosition;
        if (!pos) return;
        table[String(i)] = { row: pos.row, col: pos.col, serialized_row: rows - 1 - pos.row,
          label: C.prtsLabel(pos.row, pos.col),
          checkpoints: ((r || {}).checkpoints || []).length, end: (r || {}).endPosition };
      });
      if (Object.keys(table).length) out[pair[1]] = table;
    });
    return out;
  }
  function computeLocally(level, consumption, queueOrder) {
    if (typeof level === 'string') level = levelById(level) || { id: level };
    var lv = rawLevelFor(level);
    if (!lv) {
      throw new Error(wavesReady()
        ? '这一关没有 waves 字段，无法本地重算'
        : '缺少 spawn-waves.js（同目录的原始波次数据），无法重算隐藏组组合；请确认它与 index.html 放在一起');
    }
    var levelId = level.id || 'custom';
    // `d` = 本关敌人 prefab 的 `_delayToBorn`（帧），由导出工具按 enemyDbRefs 裁好；
    // 客户端 `_DealAction` 0x27e3600 的修正量，缺它会让 1049 个关卡的生成帧偏晚。
    var lvEntry = (window.__SPAWN_WAVES__ || {})[levelId] || {};
    // 波次门（默认 = 该波全部敌人离场 + 1，来自离线真值表 `wave-clear-frames.json`）：
    // 本地重算必须带上同一个下界，否则 00-02 / 00-04 / 00-11 / 01-05 这几关换隐藏组后
    // 会与默认视图差出整段位移（默认视图走的是导出时已带门的载荷）。
    // 波次门真值：优先用当前载荷（可能是用户改过门值后的结果），否则用同一关默认载荷里
    // 缓存下来的那份。**默认口径是 `pinned`，第一次选中关卡时 `S.data` 还不存在**，
    // 没有这条兜底就会把 wave>=1 的波次整体提前（HE-EX-4 的 wave1 实测差 1839 帧）。
    var cachedGates = (MAP_CACHE[levelId] || {}).wave_gates || null;
    var liveGates = (S.data || {}).wave_gates || null;
    var gateSource = (liveGates && liveGates.length) ? liveGates : (cachedGates || []);
    var gateMap = {};
    gateSource.forEach(function (g) {
      if (g && g.wave !== undefined && g.frame !== null && g.frame !== undefined && isFinite(Number(g.frame))) {
        gateMap[g.wave] = Number(g.frame);
      }
    });
    var sch = C.schedule(lv, { consumption: consumption, queue_order: queueOrder,
      enemy_delay_mt: lvEntry.d || null, wave_gates: gateMap,
      random_groups: { policy: S.rgPolicy || 'all', seed: levelRandomSeed(level), pins: S.rgPins || {} },
      enabled_hidden_groups: S.groups });
    var rows = sch.rows.map(function (r) {
      return { track: 'wave', track_rank: 0, kind: r.kind, is_spawn: r.kind === 'SPAWN',
        key: r.key, enemy_name: KEY_NAME[r.key] || null, wave: r.wave, fragment: r.fragment,
        action: r.action, seq: r.seq, route: r.route, route_source: 'routes',
        ideal_frame: r.ideal_frame, actual_frame: r.actual_frame, synthetic: r.synthetic,
        hidden_group: r.hidden_group || null,
        random_group: r.random_group || null, random_group_size: r.random_group_size || null,
        random_group_chosen: r.random_group_chosen || null,
        random_group_weights: r.random_group_weights || null,
        confidence: 'client_js_port (已与 Python 对拍)' };
    });
    // 分支轨：任意子集 + 任意触发帧现算（core.js:scheduleBranches，与 Python 逐条对拍）
    var branchRows = [];
    if ((S.branches || []).length) {
      if (!lv.branches) {
        notice = (notice ? notice + ' ' : '')
          + '本关没有分支定义（spawn-waves.js 缺 branches），只显示常规波次。';
      } else {
        var bsch = C.scheduleBranches(lv, { consumption: consumption, queue_order: queueOrder,
            enemy_delay_mt: lvEntry.d || null,
          enabled_hidden_groups: S.groups, branches: S.branches,
          branch_trigger_frame: S.branchTrigger });
        branchRows = bsch.rows.map(function (r) {
          return { track: 'branch', track_rank: 1, branch: r.branch, phase: r.phase,
            kind: r.kind, is_spawn: r.kind === 'SPAWN', key: r.key,
            enemy_name: KEY_NAME[r.key] || null, wave: null, fragment: null,
            action: r.action, seq: r.seq, route: r.route, route_source: 'extraRoutes',
            ideal_frame: r.ideal_frame, actual_frame: r.actual_frame, synthetic: r.synthetic,
            hidden_group: r.hidden_group || null, config_frame: r.config_frame,
            confidence: 'candidate (trigger frame is runtime)' };
        });
      }
    }
    // 本地重算的行没有导出时的随机组字段，按本关配置现算一遍（同一套判定）
    applyRandomGroups(rows, lv);
    // 与 Python payload 同一排序键（track_rank → actual_frame → wave/fragment/phase/action/seq…）
    var merged = rows.concat(branchRows);
    merged.sort(function (a, b) {
      return (a.track_rank - b.track_rank) || (a.actual_frame - b.actual_frame)
        || ((a.wave || 0) - (b.wave || 0))
        || (((a.fragment === null || a.fragment === undefined) ? -1 : a.fragment)
            - ((b.fragment === null || b.fragment === undefined) ? -1 : b.fragment))
        || ((a.phase || 0) - (b.phase || 0)) || ((a.action || 0) - (b.action || 0))
        || ((a.seq || 0) - (b.seq || 0))
        || String(a.kind || '').localeCompare(String(b.kind || ''))
        || String(a.key || '').localeCompare(String(b.key || ''));
    });
    var spawns = merged.filter(function (r) { return r.is_spawn; });
    var waveSpawns = rows.filter(function (r) { return r.is_spawn; }).length;
    return { version: D.version, level: { id: levelId, code: level.code || levelId,
      name: level.name || '', path: level.path || '(本地文件)' },
      consumption: consumption, queue_order: queueOrder, selected: { hidden_groups: S.groups },
      options: level.options || { hidden_groups: [], branches: [] },
      random_groups: localRandomGroups(level, lv),
      // 与 Python payload 同口径：rows/spawns 只数波次轨，分支轨单列 branch_rows/branch_spawns
      summary: { rows: rows.length, spawns: waveSpawns,
        branch_rows: branchRows.length, branch_spawns: spawns.length - waveSpawns,
        first_spawn: spawns[0] || null, last_spawn: spawns[spawns.length - 1] || null,
        fragments: sch.completions, skipped: [], skipped_count: 0 },
      rows: rows, branch_rows: branchRows, map: localMap(lv, levelId),
      spawn_points: localSpawnPoints(lv, levelId) };
  }
  /* 本地重算也要报「随机刷怪组」块：摘要要写 randomSeed 与口径，行上的标签也要权重。
     形状与 Python payload 一致（counts / groups / chosen_index / weights）。 */
  function localRandomGroups(level, lv) {
    var plan = C.randomGroupPlan(lv, S.rgPolicy || 'pinned', levelRandomSeed(level), S.rgPins || {});
    var total = function (g) {
      return g.candidates.reduce(function (a, c) { return a + Number(c.weight || 0); }, 0);
    };
    return { policy: plan.policy, seed: plan.seed, counts: plan.counts, confidence: plan.confidence,
      groups: (plan.groups || []).map(function (g) {
        return { wave: g.wave, fragment: g.fragment, group: g.group,
          candidates: g.candidates.map(function (c) { return c.action; }),
          weights: g.candidates.map(function (c) { return Number(c.weight || 0); }),
          kept: g.chosen_action, dropped: g.dropped, chosen_index: g.chosen,
          chosen_weight: (g.candidates[g.chosen] || {}).weight, total_weight: total(g),
          pack_keys: g.candidates.map(function () { return ''; }), policy: plan.policy };
      }) };
  }
  /* 地图/出生点与隐藏组无关：自定义文件里有 mapData 就用它，否则复用同一关
     默认载荷解码时缓存下来的副本。 */
  function localMap(lv, levelId) {
    if (lv.mapData) return mapCells(lv);
    var cached = MAP_CACHE[levelId];
    return cached ? cached.map : { rows: 0, cols: 0, cells: [] };
  }
  function localSpawnPoints(lv, levelId) {
    if (lv.mapData) return spawnPoints(lv);
    var cached = MAP_CACHE[levelId];
    return cached ? cached.spawn_points : {};
  }
  function renderMessage(msg) {
    var box = $('timeline');
    if (box) box.innerHTML = '<div class=none>' + esc(msg) + '</div>';
  }
  function select(id) {
    S.selected = id; S.custom = null; S.groups = []; S.branches = []; S.branchTrigger = 0;
    S.gates = {}; S.sel = new Set(); S.selAnchor = null;
    renderLevels();
    recompute({});          // 走统一路径：紧凑线格式在这里按需解码
  }
  function loadFile(text) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) { alert('不是合法 JSON：' + e.message); return; }
    var level = { id: 'custom', code: '自定义', name: raw.name || (raw.options && raw.options.name) || '本地关卡文件',
      path: '（本地文件）', level: raw, options: { hidden_groups: [], branches: [] },
      map: mapCells(raw) };
    S.custom = level; S.selected = null; S.groups = []; S.branches = []; S.branchTrigger = 0;
    S.sel = new Set(); S.selAnchor = null;
    S.data = null;
    recompute({});
    renderLevels();
  }
  /* 左侧边栏：拖动 #side-resize 调宽；双击分隔条或点 #side-toggle 收起/展开（localStorage 记忆）。 */
  function bindSidebar() {
    // 主流做法：侧栏右侧一条常驻的竖直轨道放箭头；收起后轨道还在，箭头掉头即可展开。
    var main = document.querySelector('main');
    var bar = document.getElementById('side-bar');
    var grip = document.getElementById('side-resize');
    var toggle = document.getElementById('side-toggle');
    if (!main || !bar || !grip) return;
    var KEY_W = 'ark.side.width', KEY_C = 'ark.side.collapsed';
    var RAIL = 22;
    var sideWidth = 320;
    var collapsed = function () { return main.classList.contains('side-collapsed'); };
    var applyWidth = function () {
      main.style.setProperty('--side-w', (collapsed() ? RAIL : sideWidth) + 'px');
    };
    var paintToggle = function () {
      if (!toggle) return;
      toggle.title = collapsed() ? '展开左侧栏' : '收起左侧栏';
      toggle.setAttribute('aria-expanded', collapsed() ? 'false' : 'true');
      toggle.setAttribute('aria-label', collapsed() ? '展开左侧栏' : '收起左侧栏');
    };
    var setCollapsed = function (on) {
      main.classList.toggle('side-collapsed', !!on);
      applyWidth();
      paintToggle();
      // 右侧变宽/变窄后按新宽度重排列宽（否则表格列停在旧宽度，看着像「右边显示不对」）。
      if (typeof autoFitColumns === 'function') autoFitColumns();
      try { localStorage.setItem(KEY_C, on ? '1' : '0'); } catch (e) { /* ignore */ }
    };
    try {
      var w0 = Number(localStorage.getItem(KEY_W) || 0);
      if (w0 >= 180 && w0 <= 640) sideWidth = w0;
      if (localStorage.getItem(KEY_C) === '1') main.classList.add('side-collapsed');
    } catch (e) { /* file:// 下 localStorage 可能不可用 */ }
    applyWidth();
    paintToggle();
    var remember = function () {
      try {
        localStorage.setItem(KEY_W, String(Math.round(sideWidth)));
        localStorage.setItem(KEY_C, collapsed() ? '1' : '0');
      } catch (e) { /* ignore */ }
    };
    grip.addEventListener('mousedown', function (ev) {
      if (collapsed()) return;
      ev.preventDefault();
      var startX = ev.clientX, startW = bar.getBoundingClientRect().width;
      var move = function (e) {
        sideWidth = Math.max(180, Math.min(640, Math.round(startW + (e.clientX - startX))));
        applyWidth();
      };
      var up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        remember();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    grip.addEventListener('dblclick', function () { setCollapsed(!collapsed()); });
    if (toggle) toggle.onclick = function () { setCollapsed(!collapsed()); };
  }

  function boot() {
    if (!refreshData().levels.length) return;
    if (!window.SpawnCore) return;
    bindSidebar();
    $('search').oninput = function () { S.query = $('search').value; renderLevels(); };
    var onlyOpts = $('only-options');
    if (onlyOpts) onlyOpts.onchange = function () { S.onlyOptions = !!onlyOpts.checked; renderLevels(); };
    // 注意：`#rg-policy` 是 render() 每次重建 #options 时新生成的节点，
    // 所以在 boot() 里抓一次引用是错的（换过关卡之后选择器就点不动了）——
    // 绑定放在 render() 里（见下），这里只留窗口 resize。
    var rt = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (!TL_DRAGGED) autoFitColumns(); }, 150);
    });
    var spawnOnly = $('spawn-only');
    if (spawnOnly) spawnOnly.onchange = function () { S.spawnOnly = !!spawnOnly.checked; render(); };
    $('file').onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { loadFile(String(fr.result)); };
      fr.readAsText(f);
    };
    renderLevels();
    var first = (D.levels.filter(function (l) { return l.id === D.default_level; })[0]) || D.levels[0];
    if (first) select(first.id);
  }
  function refresh() {
    if (!S.data) return;
    if (S.groups.length || S.branches.length) recompute({});
  }
  window.SpawnApp = { boot: boot, select: select, refresh: refresh, S: S, loadFile: loadFile,
    MAP_CACHE: MAP_CACHE,
    mapBodyHtml: mapBodyHtml, mapPanelHtml: mapPanelHtml, applySelection: applySelection, spawnOrdinals: spawnOrdinals,
    timelineHtml: timelineHtml, matchLevel: matchLevel, prtsLabel: C.prtsLabel,
    randomGroupStats: randomGroupStats, randomGroupIndex: randomGroupIndex,
    levelRandomSeed: levelRandomSeed, rgPairs: rgPairs, rgPinsForCursor: rgPinsForCursor };
  // 数据可能是 gzip+base64（见 tools/export_spawn_timeline_dist.py），
  // 那种情况下由页内 bootstrap 解压完再调 boot()。
  if (window.__SPAWN_DATA__) {
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
  }
  // spawn-waves.js 是独立的异步解压：它到位后，如果用户已经勾了隐藏组就重算一遍。
  window.addEventListener('spawn-waves-ready', refresh);
})();
