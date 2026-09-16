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
    var rows = S.levels.filter(function (l) {
      return matchLevel(l, S.query) && inScope(l, S.scope)
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
    $('count').textContent = rows.length + ' / ' + S.levels.length + ' 关（范围：' + S.scope + '）';
    Array.prototype.forEach.call(box.querySelectorAll('[data-level]'), function (n) {
      n.onclick = function () { select(n.dataset.level); };
    });
  }
  function optionControls(level) {
    var opts = (level && level.options) || {};
    var groups = opts.hidden_groups || [], branches = opts.branches || [];
    var html = '<div class=grp><h4>隐藏组 hiddenGroup</h4>';
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
    html += '<div class=grp id=map-grp><div id=map-body></div></div>';
    return html;
  }
  function spawnPointOf(row) {
    var table = (S.data.spawn_points || {})[row.route_source || 'routes'] || {};
    var sp = table[String(row.route)] || null;
    return (sp && !sp.placeholder) ? sp : null;
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
      + '<td>' + esc(row.enemy_name || row.key) + '</td>'
      + '<td>' + where + '</td>'
      + '<td>' + (row.route === null || row.route === undefined ? '-' : esc(row.route)) + '</td>'
      + '<td>' + (row.hidden_group ? '<span class=tag>隐藏组 ' + esc(row.hidden_group) + '</span>' : '') + '</td>'
      + '</tr>';
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

  // 列宽由表头（grid）与每个 fragment 的事件表（table-layout:fixed）共用，拆成多个盒子后列仍对齐。
  var TL_COLS = '104px 132px 108px auto 172px 138px 156px';
  var TL_COLS_HTML = TL_COLS.split(' ').map(function (w) {
    return '<col' + (w === 'auto' ? '' : ' style="width:' + w + '"') + '>';
  }).join('');
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
          + '</div><table class=ev-table><colgroup>' + TL_COLS_HTML + '</colgroup><tbody>'
          + f.items.map(function (it) { return rowHtml(it.row, it.index); }).join('')
          + '</tbody></table></div>';
      });
      body += '</div>';
    });
    return '<div class=tl-head style="grid-template-columns:' + TL_COLS + '">'
      + '<span>事件</span><span>实际时间</span><span>出生点(prts.map)</span>'
      + '<span>敌人 / 内容</span><span>来源</span><span>路线</span><span>标记</span></div>'
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

  function render() {
    var data = S.data;
    if (!data) return;
    $('head').innerHTML = '<div class=title>' + esc(data.level.code + ' · ' + data.level.name)
      + '</div><div class=path>' + esc(data.level.id + ' · ' + data.level.path) + '</div>';
    $('options').innerHTML = optionControls(data);
    var s = data.summary || {};
    var spawns = (data.rows || []).filter(function (r) { return r.is_spawn; });
    $('summary').innerHTML = '生成 <b>' + (s.spawns || 0) + '</b> 次'
      + (spawns.length ? ' · 首怪 ' + sf(spawns[0].actual_frame) + ' · 末怪 ' + sf(spawns[spawns.length - 1].actual_frame) : '')
      + (data.branch_notice ? ' <span class=tag>' + esc(data.branch_notice) + '</span>' : '');
    $('timeline').innerHTML = timelineHtml(data);
    bindRowSelection();
    var mapBody = $('map-body');
    if (mapBody) mapBody.innerHTML = mapBodyHtml(S.data, S.sel, S.rows, S.spawnNo);
    Array.prototype.forEach.call($('options').querySelectorAll('[data-g]'), function (n) {
      n.onchange = function () { toggleGroup(n.dataset.g, n.checked); };
    });
    Array.prototype.forEach.call($('options').querySelectorAll('[data-b]'), function (n) {
      n.onchange = function () { toggleBranch(n.dataset.b, n.checked); };
    });
    var trig = $('trigger'); if (trig) trig.onchange = function () { S.branchTrigger = Math.max(0, Number(trig.value) || 0); recompute({}); };
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
    var encoded = S.custom ? null
      : (D.payloads[comboKey(S.selected, S.groups, S.branches, S.branchTrigger)] || null);
    var payload = null;
    var notice = '';
    if (!encoded && S.branches.length) {
      // 分支波次的触发帧是运行时的：分发版只预计算「全开 + 触发帧 0/300」这几种组合，
      // 其余组合本地算不了，如实说明，不假装分支行已经算过。
      notice = '本关没有可用的分支定义（spawn-waves.js 缺 branches），只显示常规波次。';
    }
    if (!encoded) {
      try {
        payload = computeLocally(level, consumption, queueOrder);
      } catch (e) {
        renderMessage(e && e.message ? e.message : String(e));
        return;
      }
      if (notice) payload.branch_notice = notice;
    } else {
      // 数据文件是紧凑线格式（全部 3876 关也能塞进去），选中时按需解码。
      payload = (encoded.l && window.SpawnCodec)
        ? window.SpawnCodec.decodePayload(encoded, { keys: D.keys || [], names: D.names || [],
                                                     groups: D.groups || [], version: D.version })
        : JSON.parse(JSON.stringify(encoded));
      payload.consumption = consumption;
      payload.queue_order = queueOrder;
      if (notice) payload.branch_notice = notice;
      // 缓存这一关的地图/出生点给本地重算用（见 localMap/localSpawnPoints）。
      MAP_CACHE[S.selected || (S.custom && S.custom.id) || level.id] =
        { map: payload.map, spawn_points: payload.spawn_points };
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
    var sch = C.schedule(lv, { consumption: consumption, queue_order: queueOrder,
      enabled_hidden_groups: S.groups });
    var rows = sch.rows.map(function (r) {
      return { track: 'wave', track_rank: 0, kind: r.kind, is_spawn: r.kind === 'SPAWN',
        key: r.key, enemy_name: KEY_NAME[r.key] || null, wave: r.wave, fragment: r.fragment,
        action: r.action, seq: r.seq, route: r.route, route_source: 'routes',
        ideal_frame: r.ideal_frame, actual_frame: r.actual_frame, synthetic: r.synthetic,
        hidden_group: r.hidden_group || null, confidence: 'client_js_port (已与 Python 对拍)' };
    });
    // 分支轨：任意子集 + 任意触发帧现算（core.js:scheduleBranches，与 Python 逐条对拍）
    var branchRows = [];
    if ((S.branches || []).length) {
      if (!lv.branches) {
        notice = (notice ? notice + ' ' : '')
          + '本关没有分支定义（spawn-waves.js 缺 branches），只显示常规波次。';
      } else {
        var bsch = C.scheduleBranches(lv, { consumption: consumption, queue_order: queueOrder,
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
      // 与 Python payload 同口径：rows/spawns 只数波次轨，分支轨单列 branch_rows/branch_spawns
      summary: { rows: rows.length, spawns: waveSpawns,
        branch_rows: branchRows.length, branch_spawns: spawns.length - waveSpawns,
        first_spawn: spawns[0] || null, last_spawn: spawns[spawns.length - 1] || null,
        fragments: sch.completions, skipped: [], skipped_count: 0 },
      rows: rows, branch_rows: branchRows, map: localMap(lv, levelId),
      spawn_points: localSpawnPoints(lv, levelId) };
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
  function boot() {
    if (!refreshData().levels.length) return;
    if (!window.SpawnCore) return;
    $('search').oninput = function () { S.query = $('search').value; renderLevels(); };
    var scope = $('scope');
    if (scope) {
      scope.value = S.scope;
      scope.onchange = function () { S.scope = scope.value; renderLevels(); };
    }
    var onlyOpts = $('only-options');
    if (onlyOpts) onlyOpts.onchange = function () { S.onlyOptions = !!onlyOpts.checked; renderLevels(); };
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
    timelineHtml: timelineHtml, matchLevel: matchLevel, prtsLabel: C.prtsLabel };
  // 数据可能是 gzip+base64（见 tools/export_spawn_timeline_dist.py），
  // 那种情况下由页内 bootstrap 解压完再调 boot()。
  if (window.__SPAWN_DATA__) {
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
  }
  // spawn-waves.js 是独立的异步解压：它到位后，如果用户已经勾了隐藏组就重算一遍。
  window.addEventListener('spawn-waves-ready', refresh);
})();
