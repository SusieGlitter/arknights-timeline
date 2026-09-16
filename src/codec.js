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
    var frags = (c.f || []).map(function (f) {
      return { wave: f[0], fragment: f[1], start_frame: f[2], completion_frame: f[3], queue_entries: f[4] };
    });
    return {
      version: tables.version,
      level: { id: c.l[0], code: c.l[1], name: c.l[2], path: c.l[3] },
      options: c.o || { hidden_groups: [], branches: [] },
      wave_gates: c.g || null,
      consumption: 'client_accumulated',
      queue_order: 'mono_qsort',
      selected: { hidden_groups: [], branches: [], branch_trigger_frame: 0 },
      summary: { rows: c.n[0], spawns: c.n[1], branch_rows: c.n[2], branch_spawns: c.n[3],
                 fragments: frags },
      rows: (c.w || []).map(function (item) { return decodeRow(item, tables); }),
      branch_rows: (c.b || []).map(function (item) { return decodeRow(item, tables); }),
      map: map,
      spawn_points: spawnPoints,
      confidence: 'dist compact payload (tools/export_spawn_timeline_dist.py)',
    };
  }

  var api = { decodeRow: decodeRow, decodePayload: decodePayload, CELLS: CELLS };
  global.SpawnCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
