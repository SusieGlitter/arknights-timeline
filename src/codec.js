/* 分发版线格式解码器（与 tools/export_spawn_timeline_dist.py 的 encode_payload 一一对应）。
 *
 * 为什么要压缩：用户要求分发版含**全部 3876 关**。原始载荷 ~34 KB/关（含大量重复字段与英文 key），
 * 压成「数组行 + 全局字符串表 + 地图字符串」后约 1/3，gzip+base64 后整个数据文件约 12 MB，
 * 仍是单文件、双击即用。行格式：
 *   [kind, is_spawn, keyIdx, wave, fragment, action, seq, route, extraRoutes, actual_frame,
 *    gate_frame?, branch?, phase?]
 * 长度 10/11 = 波次行（11 带 gate_frame），12/13 = 分支行（13 带 gate_frame）。
 */
(function (global) {
  'use strict';
  var CELLS = { g: 'ground', h: 'highland', w: 'wall', f: 'flyonly', o: 'hole',
                s: 'start', e: 'end', '?': 'ground' };

  function decodeRow(item, tables) {
    var isBranch = item.length >= 12;
    var key = tables.keys[item[2]] || '';
    var row = {
      kind: item[0], is_spawn: !!item[1], key: key, enemy_name: tables.names[item[2]] || null,
      wave: item[3], fragment: item[4], action: item[5], seq: item[6], route: item[7],
      route_source: item[8] ? 'extraRoutes' : 'routes', actual_frame: item[9],
      ideal_frame: item[9], synthetic: false, hidden_group: null,
      track: isBranch ? 'branch' : 'wave', track_rank: isBranch ? 1 : 0,
      confidence: 'dist compact payload',
    };
    if (!isBranch && item.length === 11) row.gate_frame = item[10];
    if (isBranch) {
      if (item.length === 13) row.gate_frame = item[10];
      row.branch = item[item.length - 2];
      row.phase = item[item.length - 1];
    }
    return row;
  }

  //: 行上的 hidden_group 用「行号+组序号」稀疏列表带（见 export_spawn_timeline_dist.py 的 hg/hgb），
  //: 这样紧凑格式既能标出隐藏组来源，又不用给每一行加一个字段。
  function applyHiddenGroups(rows, pairs, groups) {
    if (!pairs || !pairs.length) return;
    for (var i = 0; i + 1 < pairs.length; i += 2) {
      var row = rows[pairs[i]];
      if (row) row.hidden_group = groups[pairs[i + 1]] || null;
    }
  }

  /* 行上的随机刷怪组（`actions[].randomSpawnGroupKey`）同样走稀疏列表：
   *   [行号, 组序号, 同组候选数, ...]；分支行用 `-(行号+1)` 编码（见导出器的 rg）。
   * 客户端同组只出抽中的一条（`PhaseData::FetchActionsWithRandomSpawn` 0x42005cc 把落选的置
   * isValid=0，出队侧 0x27e9c00 跳过且不占帧），所以页面必须写明「N 选 1（候选）」。 */
  function applyRandomGroups(rows, branchRows, flat, keys) {
    if (!flat || !flat.length) return;
    for (var i = 0; i + 2 < flat.length; i += 3) {
      var slot = Number(flat[i]);
      var row = slot < 0 ? branchRows[-slot - 1] : rows[slot];
      if (!row) continue;
      row.random_group = keys[flat[i + 1]] || null;
      row.random_group_size = flat[i + 2];
    }
  }

  function decodePayload(c, tables) {
    var map = { rows: c.m[0], cols: c.m[1], cells: [] };
    var flat = c.m[2] || '';
    for (var r = 0; r < c.m[0]; r++) {
      var line = [];
      for (var col = 0; col < c.m[1]; col++) line.push(CELLS[flat.charAt(r * c.m[1] + col)] || 'ground');
      map.cells.push(line);
    }
    var spawnPoints = {};
    Object.keys(c.p || {}).forEach(function (src) {
      var table = {};
      Object.keys(c.p[src] || {}).forEach(function (idx) {
        var v = c.p[src][idx];
        table[idx] = { row: v[0], col: v[1], serialized_row: v[2], placeholder: !!v[3], label: v[4] };
      });
      spawnPoints[src] = table;
    });
    // 移动轨迹：`c.rp = [[route, [seg_flat, ...]], ...]`，段内是平铺的 row,col
    var routePaths = {};
    (c.rp || []).forEach(function (item) {
      var segs = [];
      (item[1] || []).forEach(function (flat) {
        var seg = [];
        for (var i = 0; i + 1 < flat.length; i += 2) seg.push([flat[i], flat[i + 1]]);
        if (seg.length >= 2) segs.push(seg);
      });
      if (segs.length) routePaths[String(item[0])] = segs;
    });
    var frags = (c.f || []).map(function (f) {
      return { wave: f[0], fragment: f[1], start_frame: f[2], completion_frame: f[3], queue_entries: f[4] };
    });
    var rows = (c.w || []).map(function (item) { return decodeRow(item, tables); });
    var branchRows = (c.b || []).map(function (item) { return decodeRow(item, tables); });
    applyHiddenGroups(rows, c.hg, tables.groups || []);
    applyHiddenGroups(branchRows, c.hgb, tables.groups || []);
    applyRandomGroups(rows, branchRows, c.rg, (tables && tables.rgkeys) || []);
    return {
      version: tables.version,
      level: { id: c.l[0], code: c.l[1], name: c.l[2], path: c.l[3] },
      options: c.o || { hidden_groups: [], branches: [] },
      wave_gates: c.g || null,
      consumption: 'client_accumulated',
      queue_order: 'mono_qsort',
      selected: { hidden_groups: [], branches: [], branch_trigger_frame: 0 },
      random_groups: c.rgs ? { policy: c.rgs[0], seed: c.rgs[1],
        counts: { groups: c.rgs[2], candidates: c.rgs[3], dropped: c.rgs[4] } } : null,
      summary: { rows: c.n[0], spawns: c.n[1], branch_rows: c.n[2], branch_spawns: c.n[3],
                 fragments: frags },
      rows: rows,
      branch_rows: branchRows,
      map: map,
      spawn_points: spawnPoints,
      route_paths: routePaths,
      confidence: 'dist compact payload (tools/export_spawn_timeline_dist.py)',
    };
  }

  var api = { decodeRow: decodeRow, decodePayload: decodePayload, applyHiddenGroups: applyHiddenGroups,
              applyRandomGroups: applyRandomGroups, CELLS: CELLS };
  global.SpawnCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
