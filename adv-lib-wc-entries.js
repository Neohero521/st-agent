/**
 * 写卡器条目体系（照抄 我的写卡器-v329.59.js，原文搬运，不做改写）
 *
 * 覆盖：8 条 MVU 固定条目的 meta 模板（constant/selective/position/depth/order/…）、
 * 条目名归一（AI 自创前缀 → 标准名）、条目正文固定生成（InitVar / 变量更新规则 /
 * 变量输出格式 / 格式强调 / 变量列表 / 占位符提醒）。
 * 目的：让 st-agent 写出来的条目与写卡器逐字段一致，audit 与进度检查口径也一致。
 */

const ENTRY_TEMPLATES = {
    '世界元数据': {
      constant: true,
      selective: false,
      position: 0,
      depth: 0,
      order: 240,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '状态栏': {
      constant: false,
      selective: true,
      position: 2,
      depth: 2,
      order: 35,
      sticky: null,
      cooldown: null,
      delay: null,
      prevent_recursion: false,
      exclude_recursion: false,
      delay_until_recursion: 0,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 3,
      selectiveLogic: 0,
      probability: 100,
      useProbability: true,
      group: '',
      group_weight: 100
    },
    '统一输出格式': {
      constant: true,
      selective: false,
      position: 0,
      depth: 1,
      order: 85,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '角色边界': {
      constant: true,
      selective: false,
      position: 0,
      depth: 2,
      order: 80,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '禁止项': {
      constant: true,
      selective: false,
      position: 0,
      depth: 3,
      order: 70,
      prevent_recursion: true,
      exclude_recursion: true,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '自定义条目': {
      constant: false,
      selective: true,
      position: 1,
      depth: 4,
      order: 55,
      cooldown: null,
      delay: null,
      sticky: null,
      prevent_recursion: false,
      exclude_recursion: false,
      delay_until_recursion: 0,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 5,
      selectiveLogic: 0,
      probability: 100,
      useProbability: true,
      group: '',
      group_weight: 100
    },
    '[InitVar]初始变量': {
      constant: true,
      selective: false,
      position: 0,
      order: 100,
      insertion_order: 100,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100,
      enabled: false
    },
    '变量列表': {
      constant: true,
      selective: false,
      position: 4,
      depth: 1,
      order: 200,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '变量更新规则': {
      constant: true,
      selective: false,
      position: 4,
      depth: 0,
      order: 200,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '变量输出格式': {
      constant: true,
      selective: false,
      position: 4,
      depth: 0,
      order: 200,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100
    },
    '变量输出格式强调': {
      constant: true,
      selective: false,
      position: 4,
      depth: 0,
      order: 200,
      prevent_recursion: true,
      exclude_recursion: false,
      delay_until_recursion: 0,
      cooldown: null,
      delay: null,
      sticky: null,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: false,
      group: '',
      group_weight: 100,
      enabled: false
    },
    '状态变量输出': {
      constant: false,
      selective: true,
      position: 2,
      depth: 2,
      order: 45,
      sticky: null,
      cooldown: null,
      delay: null,
      prevent_recursion: false,
      exclude_recursion: false,
      delay_until_recursion: 0,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 3,
      selectiveLogic: 0,
      probability: 100,
      useProbability: true,
      group: '',
      group_weight: 100,
      secondary_keys: []
    },
    // ★第7条专用模板（修复：<状态栏>占位符提醒 若命中通用「状态栏」模板会变触发式 constant=false，
    //   蓝灯(常驻)丢失、关键字/权重错乱。专用模板 constant=true + position=4 depth=0 order=200，
    //   与 MVU ZOD 指南第7条 D0 及最初版生成效果一致）
    '<状态栏>占位符提醒': {
      constant: true,
      selective: false,
      position: 4,
      depth: 0,
      order: 250, // ★用户要求"蓝灯常驻、权重弄高一点"：高于其他 MVU 条目（200），保证提醒权重优先
      enabled: true,
      sticky: null,
      cooldown: null,
      delay: null,
      prevent_recursion: false,
      exclude_recursion: false,
      delay_until_recursion: 0,
      use_regex: true,
      match_whole_words: null,
      scan_depth: 3,
      selectiveLogic: 0,
      probability: 100,
      useProbability: true,
      group: '',
      group_weight: 100,
      keys: ['StatusPlaceHolderImpl', '状态栏', '占位符提醒'],
      secondary_keys: []
    }
  };

function _stripOuterBrackets(s) {
    if (!s) return '';
    let r = String(s).trim();
    for (let iter = 0; iter < 2; iter++) {
      const pairs = [
        ['⟦', '⟧'],
        ['【', '】'],
        ['「', '」'],
        ['『', '』'],
        ['［', '］'],
        ['《', '》'],
        ['〈', '〉'],
        ['(', ')'],
        ['[', ']'],
        ['{', '}']
      ];
      let matched = false;
      for (let pi = 0; pi < pairs.length; pi++) {
        const L = pairs[pi][0],
          R = pairs[pi][1];
        if (r.length >= 4 && r.charAt(0) === L && r.charAt(r.length - 1) === R) {
          r = r.slice(1, -1).trim();
          matched = true;
          break;
        }
      }
      if (!matched) break;
    }
    return r;
  }
function _entryCommentCore(comment) {
    if (!comment) return '';
    let c = _stripOuterBrackets(String(comment)).trim();
    let prev = null;
    while (prev !== c) {
      prev = c;
      c = c.replace(/^\[[^\]]*\]\s*/, '').replace(/^<[^>]*>\s*/, '').trim();
    }
    return c;
  }
function getEntryTemplate(comment) {
    if (!comment) return null;
    // 1. 支持 [InitVar]xxx 前缀格式（MVU变量系统，兼容大小写）
    const commentLower = comment.toLowerCase();
    if (commentLower.indexOf('[initvar]') === 0) {
      return ENTRY_TEMPLATES['[InitVar]初始变量'];
    }
    // ★修复：第7条 <状态栏>占位符提醒 必须先于 <xxx> 前缀匹配判定——
    // 否则 "<状态栏>" 前缀会命中通用「状态栏」模板（constant=false 触发式），
    // 导致第7条丢失蓝灯(常驻)、被当成触发条目带上错误关键字、权重错乱。
    if (comment.indexOf('状态栏') >= 0 && (comment.indexOf('占位') >= 0 || comment.indexOf('提醒') >= 0)) {
      return ENTRY_TEMPLATES['<状态栏>占位符提醒'] || ENTRY_TEMPLATES['变量列表'];
    }
    // 2. 支持 <xxx> 前缀格式（标准条目）
    const m = comment.match(/^<([^>]+)>/);
    if (m) {
      const key = m[1];
      if (ENTRY_TEMPLATES[key]) return ENTRY_TEMPLATES[key];
      const fuzzyMatch = Object.keys(ENTRY_TEMPLATES).find(function(k) {
        return key.indexOf(k) >= 0 || k.indexOf(key) >= 0;
      });
      if (fuzzyMatch) return ENTRY_TEMPLATES[fuzzyMatch];
    }
    // 3. 支持 MVU 变量系统条目（无需前缀，直接匹配关键字）
    if (commentLower.indexOf('[mvu_update]') >= 0) {
      if (comment.indexOf('变量更新规则') >= 0) return ENTRY_TEMPLATES['变量更新规则'];
      if (comment.indexOf('变量输出格式强调') >= 0) return ENTRY_TEMPLATES['变量输出格式强调'];
      if (comment.indexOf('变量输出格式') >= 0) return ENTRY_TEMPLATES['变量输出格式'];
    }
    if (comment.indexOf('变量当前状态') >= 0 || comment.indexOf('变量列表') >= 0) return ENTRY_TEMPLATES['变量列表'];
    if (comment.indexOf('状态变量输出') >= 0) return ENTRY_TEMPLATES['状态变量输出'];
    // （第7条 <状态栏>占位符提醒 已在函数前部优先判定返回专用模板；此处无需重复）
    // 4. 通用匹配：遍历模板键找最长匹配
    const keys = Object.keys(ENTRY_TEMPLATES);
    let bestKey = null;
    let bestLen = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (comment.indexOf(k) >= 0 && k.length > bestLen) {
        bestKey = k;
        bestLen = k.length;
      }
    }
    if (bestKey) return ENTRY_TEMPLATES[bestKey];
    return null;
  }
function normalizeMvuEntryComment(comment) {
    if (!comment) return comment;
    const raw = String(comment);
    let c = _stripOuterBrackets(raw).trim();
    if (!c) return comment;
    // 已是标准名（精确匹配）→ 直接返回
    if (c === '[InitVar]初始变量' || c === '初始变量' || c === '[mvu_update]变量更新规则' || c === '变量更新规则' ||
      c === '变量列表' || c === '变量当前状态' || c === '[mvu_update]变量输出格式' || c === '变量输出格式' ||
      c === '[mvu_update]变量输出格式强调' || c === '变量输出格式强调' || c === '<状态栏>占位符提醒' ||
      c === '<状态栏>占位提醒' || c === '状态栏占位符提醒' || c === '状态栏占位提醒') {
      return _mapMvuStandardName(c);
    }
    const low = c.toLowerCase();
    // 剥常见自创前缀再判断（⟦⟧ 已由 _stripOuterBrackets 处理；这里处理 [MVU]/MVU·/MVU_ 等）
    let core = c;
    core = core.replace(/^\[mvu\]/i, '').replace(/^mvu[·_:-]\s*/i, '').replace(/^mvU[·_:-]\s*/i, '').trim();
    if (core !== c && core) c = core;
    const low2 = c.toLowerCase();
    // 按完整类型词命中（避免"输出格式使用说明"被误伤——需核心名整体含类型词且没有更长的类型词冲突）
    if (low2.indexOf('[initvar]') >= 0 || low2.indexOf('initvar') >= 0 || c.indexOf('初始变量') >= 0) return '[InitVar]初始变量';
    if (low2.indexOf('变量输出格式强调') >= 0 || c.indexOf('格式强调') >= 0) return '[mvu_update]变量输出格式强调';
    if (low2.indexOf('变量输出格式') >= 0 || c.indexOf('输出格式') >= 0) return '[mvu_update]变量输出格式';
    if (low2.indexOf('变量更新规则') >= 0 || (c.indexOf('更新规则') >= 0 && low2.indexOf('输出') < 0 && low2.indexOf('强调') < 0)) return '[mvu_update]变量更新规则';
    if (low2.indexOf('变量当前状态') >= 0 || low2.indexOf('变量列表') >= 0) return '变量列表';
    if ((c.indexOf('占位') >= 0) || (low2.indexOf('状态栏') >= 0 && c.indexOf('提醒') >= 0)) return '<状态栏>占位符提醒';
    return comment;
  }
function normalizeVarListContent(content) {
    // ⚠️强制重建为固定格式（不管 AI 写了什么）；开头 `---` 对齐 MVU ZOD 指南（YAML 文档分隔符），
    //   内容纯净：仅标签 + 宏，不写额外说明文字（对齐指南 5.1）
    return '---\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>';
  }
function normalizeVarOutputFormatContent(comment, content) {
    const core = _entryCommentCore(String(comment || ''));   // 剥 [xxx]/<xxx> 前缀
    if (core === '变量输出格式强调') return generateVarOutputEmphasis();
    if (core === '变量输出格式') return generateVarOutputFormat();
    return content;   // 非系统条目原样返回
  }
function normalizeStatusPlaceholderContent(_content) {
    return generateStatusPlaceholder();
  }
function generateInitVarYaml(charNames) {
    const lines = [];
    (charNames || []).forEach(function(name) {
      lines.push(name + ':');
      lines.push('  好感度: 0');
      lines.push('  心情: 平静');
      lines.push('  物品: []');
      lines.push('  衣着:');
      lines.push('    上衣: 未知');
      lines.push('    下装: 未知');
      lines.push('  _关系阶段: 泛泛之交');
    });
    if (!charNames || charNames.indexOf('主角') < 0) {
      lines.push('主角:');
      lines.push('  好感度: 0');
      lines.push('  心情: 平静');
      lines.push('  物品: []');
      lines.push('  衣着:');
      lines.push('    上衣: 未知');
      lines.push('    下装: 未知');
      lines.push('  _关系阶段: 泛泛之交');
    }
    lines.push('世界:');
    lines.push('  日期: 2025-10-22');
    lines.push('  时间: 09:00');
    lines.push('  天气: 晴');
    lines.push('$成就:');
    lines.push('  知彼知己: false');
    lines.push('  初露锋芒: false');
    lines.push('  慷慨之举: false');
    return lines.join('\n');
  }
function generateVarListContent() {
    // 生成变量当前状态内容（固定格式，对齐指南 5.1：开头 `---` YAML 分隔符，内容纯净仅标签+宏，无说明文字）
    return '---\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>';
  }
function generateVarUpdateRule(charNames) {
    const first = (charNames && charNames[0]) || '角色';
    return [
      '---',
      '变量更新规则:',
      '  世界:',
      '    当前时间:',
      '      format: YYYY年MM月DD日 星期X HH:MM',
      '      check:',
      '        - 剧情时间推进、跨日、跨场景时更新',
      '    当前地点:',
      '      check:',
      '        - 角色移动 / 场景切换时更新',
      '    近期事务:',
      '      type: |-',
      '        {',
      '          [事务名: string]: string;',
      '        }',
      '      check:',
      '        - 记录需要完成的任务、约定、重要事件',
      '        - 完成后移除，新增时及时添加，最多保持 5~8 项',
      '    天气:',
      '      type: \'晴\' | \'多云\' | \'雨\' | \'暴雨\' | \'雪\'',
      '      check:',
      '        - 剧情明确表现天气变化时更新',
      '  ' + first + ':',
      '    好感度:',
      '      type: number',
      '      range: 0~100',
      '      check:',
      '        - 根据角色对 <user> 行为的感知与反应调整 ±(3~6)',
      '        - 仅在当前回复中角色确实察觉到时更新',
      '    心情:',
      '      check:',
      '        - 根据当前场景下角色的真实情绪更新',
      '    物品:',
      '      type: |-',
      '        string[]',
      '      check:',
      '        - 获得、消耗、遗失或转移物品时新增/删除元素',
      '    衣着:',
      '      check:',
      '        - 换装、衣物损坏、特殊场合时更新',
      '        - 描述需包含颜色、材质、款式等细节',
      '  主角:',
      '    物品栏:',
      '      type: |-',
      '        {',
      '          [物品名: string]: {',
      '            描述: string;',
      '            数量?: number;  // 默认为 1',
      '          }',
      '        }',
      '      check:',
      '        - 获取、消耗、丢弃物品时更新数量',
      '        - 数量归零后该条目不再显示',
    ].join('\n');
  }
function generateVarOutputFormat() {
    return [
      '---',
      '变量输出格式:',
      '  rule:',
      '    - 你必须在下次回复正文的末尾同时输出「更新分析」和「实际更新命令」',
      '    - 所有变量内容只能根据 <变量更新规则> 计算并更新',
      '    - 更新命令必须遵循 JSON Patch (RFC 6902) 标准，是一个合法的 JSON 数组，仅支持以下操作：',
      '      - replace: 替换已存在路径的值（用于字符串、布尔、枚举，或设置绝对数值）',
      '      - delta: 按增减值更新已存在的数值路径（value 为变动值，不是最终值）',
      '      - insert: 向对象或数组插入新项（对象用于创建新属性；数组用 `-` 表示追加到末尾）',
      '      - remove: 删除已存在的路径',
      '      - move: 移动现有值（from → to）',
      '    - 数值增减必须用 delta；设置绝对新值必须用 replace；insert 只能用于新属性/新元素，不得用于模拟已有数值/字符串更新',
      '    - 不要更新以 `_` 开头的字段（只读变量，AI 可见不可更新，例如 `_关系阶段`）',
      '    - 不要更新以 `$` 开头的字段（派生显示字段，AI 不可见，由脚本/EJS 维护，例如 `$成就`）',
      '    - 更新前必须进行历史上下文去重：扫描先前消息中已反映变量变化的事件（如交易、获得/失去物品、金钱收支等）；若该变化已在历史中处理过，不得重复更新；仅依据本次回复中的新事件更新',
      '  format: |-',
      '    <UpdateVariable>',
      '    <Analysis>（用中文，不超过80字，按要点简写）',
      '    - ${计算经过的时间：...}',
      '    - ${是否允许剧情重大变化：是/否（特殊剧情或时间跨度较大时允许）}',
      '    - ${历史查重：列出先前消息中已反映变量变化的事件；若无则写“无”}',
      '    - ${仅依据本次回复，结合每个变量对应的 check 逐一分析；跳过历史已处理变量：...}',
      '    - ${逐项列出变化：当前值 → 新值，或 当前值 + delta → 新值；确认数值增减用 delta、绝对赋值用 replace、新键/新元素用 insert、移动用 move、删除用 remove，且不触碰 `_`/`$` 字段}',
      '    </Analysis>',
      '    <JSONPatch>',
      '    [',
      '      { "op": "replace", "path": "${/到/已存在/变量/的路径}", "value": "${新值}" },',
      '      { "op": "delta", "path": "${/到/数值/变量/的路径}", "value": "${正或负的变动值}" },',
      '      { "op": "insert", "path": "${/到/对象/的新键}", "value": "${新值}" },',
      '      { "op": "insert", "path": "${/到/数组/-}", "value": "${新值}" },',
      '      { "op": "remove", "path": "${/到/对象/的键}" },',
      '      { "op": "move", "from": "${/到/变量/的路径}", "to": "${/到/另/一/路径}" }',
      '    ]',
      '    </JSONPatch>',
      '    </UpdateVariable>'
    ].join('\n');
  }
function generateVarOutputEmphasis() {
    return [
      '---',
      '变量输出格式强调:',
      // ★v319.1 用户要求：变量块属于「正文末尾」，不是整条回复的末尾（回复最末尾留给占位符）
      '  rule: 以下内容必须插入到正文末尾，不可省略',
      '  format: |-',
      '    <UpdateVariable>',
      '    ...',
      '    </UpdateVariable>'
    ].join('\n');
  }
function generateStatusPlaceholder() {
    // ★v319.3 用户要求：去掉「说明」段，只保留 rule + format
    return [
      '---',
      '状态栏占位提醒:',
      '  rule: 每次回复的最末尾（正文与 <UpdateVariable> 变量更新块之后），必须单独输出一行状态栏占位符，不得省略、不得改写',
      '  format: <StatusPlaceHolderImpl/>'
    ].join('\n');
  }

function _mapMvuStandardName(c) {
    if (c === '[InitVar]初始变量' || c === '初始变量') return '[InitVar]初始变量';
    if (c === '[mvu_update]变量更新规则' || c === '变量更新规则') return '[mvu_update]变量更新规则';
    if (c === '变量列表' || c === '变量当前状态') return '变量列表';
    if (c === '[mvu_update]变量输出格式' || c === '变量输出格式') return '[mvu_update]变量输出格式';
    if (c === '[mvu_update]变量输出格式强调' || c === '变量输出格式强调') return '[mvu_update]变量输出格式强调';
    return '<状态栏>占位符提醒';
  }

/** 条目名归一（AI 自创前后缀 → 标准名） */
export function normalizeEntryComment(c) {
    return normalizeMvuEntryComment(c);
}

/** 按条目名取 meta 模板；取不到返回 null */
export function entryTemplate(comment) {
    return getEntryTemplate(comment);
}

/** 条目正文归一：变量列表 / 输出格式 / 强调 / 占位提醒 强制重建 */
export function normalizeEntryContent(comment, content) {
    const core = _entryCommentCore(String(comment || ''));
    if (core === '变量列表' || core === '变量当前状态') return normalizeVarListContent(content);
    if (core === '变量输出格式' || core === '变量输出格式强调') return normalizeVarOutputFormatContent(comment, content);
    if (core === '占位符提醒') return normalizeStatusPlaceholderContent(content);
    return content;
}

export const wcInitVarYaml = generateInitVarYaml;
export const wcVarUpdateRule = generateVarUpdateRule;
export const wcVarOutputFormat = generateVarOutputFormat;
export const wcVarOutputEmphasis = generateVarOutputEmphasis;
export const wcStatusPlaceholder = generateStatusPlaceholder;
export const wcVarListContent = generateVarListContent;
export const ENTRY_TEMPLATE_NAMES = Object.keys(ENTRY_TEMPLATES);
