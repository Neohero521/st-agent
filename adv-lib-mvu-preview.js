/**
 * 状态栏：写卡器标准模板 + 预览沙箱（照抄 我的写卡器-v329.59.js）
 *
 * 写卡器这套状态栏不是"裸 HTML + getvar 宏"，而是完整 HTML 文档：
 *   <!doctype html> → <head><style>…</style><script type="module"> init / populateCharacterData …</script></head> → <body>
 * 关键结构（写错任意一条状态栏就不读变量）：
 *   · await waitGlobalInitialized('Mvu') → await waitUntil(() => _.has(getVariables({type:'message'}),'stat_data'))
 *   · eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (variables) => populateCharacterData(variables))
 *       —— 回调第一个参数就是 MvuData（含 stat_data），别再拿 data?.new_variables
 *   · $(errorCatched(init)) 入口；getAllVariables() 读全量
 * 预览：mock 出 $ / _ / getVariables / getAllVariables / waitUntil / waitGlobalInitialized / eventOn / Mvu / getvar 等，
 *   让状态栏在 srcdoc iframe 里能真的跑起来（不必等 MagVarUpdate 装好）。
 */

/** 写卡器 MVU_STATUS_BAR_TEMPLATE 原文（AI 按此结构填 body/style） */
export const WC_STATUS_TEMPLATE = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <style>\n  body {\n    margin: 0;\n    padding: 0;\n  }\n\n  /* 在这里根据用户要求的UI风格自由设计样式 */\n  </style>\n  <script type=\"module\">\n    function populateCharacterData(vars) {\n      const all_variables = vars || getAllVariables();\n\n      // 注意：所有变量路径必须以 'stat_data.' 开头\n\n      // 普通变量\n      const variable1 = _.get(all_variables, 'stat_data.xxx', 'N/A');\n      $('#id1').text(variable1);\n\n      // 数组类型变量（如背包、记忆列表）\n      const items = _.get(all_variables, 'stat_data.背包', []);\n      const html = items.map(i => `<li>${i}</li>`).join('');\n      $('#items-list').html(html);\n\n      // 对象类型变量（如NPCs）\n      const npcs = _.get(all_variables, 'stat_data.NPCs', {});\n      Object.entries(npcs).forEach(([name, data]) => {\n        const relation = _.get(data, '关系值', 0);\n        console.log(`${name}: 关系${relation}`);\n      });\n\n      // 嵌套对象（推荐使用可选链）\n      const user = _.get(all_variables, 'stat_data.用户信息', {});\n      const weapon = user.法宝?.本命法宝 || '无';\n      $('#weapon').text(weapon);\n\n      // ... 更多变量\n    }\n\n    async function init() {\n      await waitGlobalInitialized('Mvu');\n      await waitUntil(() => _.has(getVariables({type: 'message'}), 'stat_data'));\n      populateCharacterData();\n\n      // 监听变量更新事件，实现自动刷新（回调里直接用事件参数，不要再调 getAllVariables()）\n      eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (variables) => {\n        populateCharacterData(variables);\n      });\n\n      $('.section-header').on('click', function () {\n        toggleSection($(this));\n      });\n    }\n\n    $(errorCatched(init));\n  </script>\n</head>\n<body>\n  <!-- 在这里根据用户要求的UI风格自由设计HTML结构 -->\n  <!-- 每个需要显示的变量必须有唯一的 id，在 populateCharacterData 中用 $('#id').text(value) 填充 -->\n</body>\n</html>";

/** 写卡器预览 mock（原文搬运，statData 为预览用假变量） */
export function mockScript(statData) {
    statData = statData || {};
    const statDataJson = JSON.stringify(statData).replace(/<\/script/gi, '<\\/script');
    return '<script>\n' +
      '/* === 写卡器预览用 mock API（模拟酒馆运行时）=== */\n' +
      '(function() {\n' +
      '  var statData = ' + statDataJson + ';\n' +
      '  window.__PREVIEW_MOCK_STAT_DATA__ = statData;\n' +
      '  window.getAllVariables = function() { return { stat_data: statData }; };\n' +
      '  window.waitGlobalInitialized = function(name) { return Promise.resolve(); };\n' +
      '  // ★v221 修复：AI生成HTML常按知识文本用 await waitUntil(() => _.has(getVariables({type:\'message\'}), \'stat_data\'))\n' +
      '  //   预览沙箱没有 MVU bundle 提供 waitUntil，缺此定义会抛 ReferenceError: waitUntil is not defined 崩掉 init\n' +
      '  window.waitUntil = function(fn, timeout) {\n' +
      '    return Promise.resolve().then(function() {\n' +
      '      if (typeof fn !== "function") return undefined;\n' +
      '      var r = fn();\n' +
      '      if (r && typeof r.then === "function") return r;\n' +
      '      return r;\n' +
      '    });\n' +
      '  };\n' +
      '  window.eventOn = function(evt, cb) {};\n' +
      '  window.errorCatched = function(fn) {\n' +
      '    return function() {\n' +
      '      try {\n' +
      '        var r = fn.apply(this, arguments);\n' +
      '        if (r && typeof r.catch === "function") {\n' +
      '          r.catch(function(e) { console.warn("[预览 mock] statusbar async error:", e && e.message, e && e.stack); });\n' +
      '        }\n' +
      '        return r;\n' +
      '      } catch(e) { console.warn("[预览 mock] statusbar sync error:", e && e.message, e && e.stack); }\n' +
      '    };\n' +
      '  };\n' +
      '  window.Mvu = { events: { VARIABLE_INITIALIZED: "VARIABLE_INITIALIZED", VARIABLE_UPDATE_ENDED: "VARIABLE_UPDATE_ENDED" } };\n' +
      '  // ★修复 P1-11：EJS 预览兼容——getvar / getwi / activewi / print / YAML\n' +
      '  window.getvar = function(key, opt) {\n' +
      '    if (key == null) return window.__PREVIEW_MOCK_STAT_DATA__ || {};\n' +
      '    var k = String(key);\n' +
      '    if (k === "stat_data") return window.__PREVIEW_MOCK_STAT_DATA__ || {};\n' +
      '    if (k.indexOf("stat_data.") === 0) k = k.slice(10);\n' +
      '    var keys = k.split(".");\n' +
      '    var cur = window.__PREVIEW_MOCK_STAT_DATA__ || {};\n' +
      '    for (var i = 0; i < keys.length; i++) {\n' +
      '      if (cur == null) return (opt && opt.defaults !== undefined) ? opt.defaults : undefined;\n' +
      '      cur = cur[keys[i]];\n' +
      '    }\n' +
      '    if (cur === undefined && opt && opt.defaults !== undefined) return opt.defaults;\n' +
      '    return cur;\n' +
      '  };\n' +
      '  window.getwi = async function() { console.warn("[预览 mock] getwi 在预览中返回空串"); return ""; };\n' +
      '  window.activewi = async function() { console.warn("[预览 mock] activewi 在预览中为 no-op"); return false; };\n' +
      '  window.print = function() { try { console.log.apply(console, ["[预览 mock] print:"].concat(Array.prototype.slice.call(arguments))); } catch(_) {} };\n' +
      '  window.YAML = { stringify: function(o) { try { return JSON.stringify(o, null, 2); } catch(_) { return String(o); } } };\n' +
      '  // StageDog 标准变量 API：getVariables(option) 消息级 scope\n' +
      '  window.getVariables = function(opt) {\n' +
      '    opt = opt || {};\n' +
      '    // type: "message" → 当前楼层变量；默认"latest"\n' +
      '    // 返回结构与 getAllVariables 一致（预览模式下不区分楼层）\n' +
      '    return { stat_data: window.__PREVIEW_MOCK_STAT_DATA__ || {} };\n' +
      '  };\n' +
      '  window._ = {\n' +
      '    get: function(obj, path, def) {\n' +
      '      if (obj == null) return def;\n' +
      '      var keys = String(path).split(".");\n' +
      '      var cur = obj;\n' +
      '      for (var i = 0; i < keys.length; i++) {\n' +
      '        if (cur == null) return def;\n' +
      '        cur = cur[keys[i]];\n' +
      '      }\n' +
      '      return cur === undefined ? def : cur;\n' +
      '    },\n' +
      '    has: function(obj, path) {\n' +
      '      if (obj == null) return false;\n' +
      '      var keys = String(path).split(".");\n' +
      '      var cur = obj;\n' +
      '      for (var i = 0; i < keys.length; i++) {\n' +
      '        if (cur == null || !Object.prototype.hasOwnProperty.call(cur, keys[i])) return false;\n' +
      '        cur = cur[keys[i]];\n' +
      '      }\n' +
      '      return true;\n' +
      '    }\n' +
      '  };\n' +
      '  function _miniJQ(sel) {\n' +
      '    if (typeof sel === "function") {\n' +
      '      try {\n' +
      '        if (document.readyState === "complete" || document.readyState === "interactive") { sel(); }\n' +
      '        else { document.addEventListener("DOMContentLoaded", sel); }\n' +
      '      } catch(e) { console.warn("[预览 mock] $(fn):", e); }\n' +
      '      return { ready: function(fn) { try { fn(); } catch(e) {} return this; } };\n' +
      '    }\n' +
      '    var el = (typeof sel === "string") ? document.querySelector(sel) : sel;\n' +
      '    return {\n' +
      '      0: el, length: el ? 1 : 0,\n' +
      '      html: function(s) { if (el) el.innerHTML = (s == null ? (el.innerHTML || "") : String(s)); return this; },\n' +
      '      text: function(s) { if (el) el.textContent = s; return this; },\n' +
      '      addClass: function(c) { if (el) el.classList.add(c); return this; },\n' +
      '      removeClass: function(c) { if (el) el.classList.remove(c); return this; },\n' +
      '      ready: function(fn) { try { fn(); } catch(e) {} return this; },\n' +
      '      on: function(ev, fn) { if (el && el.addEventListener) { try { el.addEventListener(ev, fn); } catch(e) {} } return this; },\n' +
      '      off: function(ev, fn) { if (el && el.removeEventListener) { try { el.removeEventListener(ev, fn); } catch(e) {} } return this; },\n' +
      '      css: function() { return this; },\n' +
      '      attr: function(k, v) { if (el) { if (v === undefined) return el.getAttribute(k); try { el.setAttribute(k, v); } catch(e) {} } return this; },\n' +
      '      append: function(c) { if (el) { try { el.insertAdjacentHTML("beforeend", c); } catch(e) {} } return this; },\n' +
      '      prepend: function(c) { if (el) { try { el.insertAdjacentHTML("afterbegin", c); } catch(e) {} } return this; },\n' +
      '      find: function(s) { return _miniJQ(el ? el.querySelector(s) : null); },\n' +
      '      closest: function(s) { return _miniJQ(el && el.closest ? el.closest(s) : null); },\n' +
      '      parent: function() { return _miniJQ(el ? el.parentElement : null); },\n' +
      '      children: function() { return _miniJQ(el ? el.firstElementChild : null); },\n' +
      '      val: function(v) { if (el) { if (v === undefined) return el.value; el.value = v; } return this; },\n' +
      '      each: function(fn) { if (el) { try { fn.call(el, 0, el); } catch(e) {} } return this; },\n' +
      '      hide: function() { if (el) el.style.display = "none"; return this; },\n' +
      '      show: function() { if (el) el.style.display = ""; return this; },\n' +
      '      toggle: function() { if (el) el.style.display = (el.style.display === "none") ? "" : "none"; return this; },\n' +
      '      data: function(k, v) { if (el && el.dataset) { if (v === undefined) return el.dataset[k]; el.dataset[k] = v; } return this; }\n' +
      '    };\n' +
      '  }\n' +
      '  window.$ = window.jQuery = _miniJQ;\n' +
      '  function fallbackRender() {\n' +
      '    var root = document.getElementById("render-root") || document.querySelector(".card-body") || document.body;\n' +
      '    if (!root) return;\n' +
      '    var stillLoading = root.querySelector(".loading-state");\n' +
      '    if (!stillLoading) return;\n' +
      '    var htmlStr = "";\n' +
      '    var data = statData || {};\n' +
      '    function rt(obj, level) {\n' +
      '      level = level || 0;\n' +
      '      var indentClass = "indent-" + Math.min(level, 4);\n' +
      '      var itemsHtml = "";\n' +
      '      var keys = Object.keys(obj || {});\n' +
      '      for (var k = 0; k < keys.length; k++) {\n' +
      '        var key = keys[k];\n' +
      '        var value = obj[key];\n' +
      '        if (key.indexOf("_") === 0 || key.indexOf("$") === 0) continue;\n' +
      '        var isPlainObj = value !== null && typeof value === "object" && !Array.isArray(value);\n' +
      '        if (isPlainObj) {\n' +
      '          if (itemsHtml) { htmlStr += "<div class=\\"stat-grid " + indentClass + "\\">" + itemsHtml + "</div>"; itemsHtml = ""; }\n' +
      '          if (level > 0) { htmlStr += "<div class=\\"category-title " + indentClass + "\\">" + key + "</div>"; }\n' +
      '          rt(value, level + 1);\n' +
      '          continue;\n' +
      '        }\n' +
      '        itemsHtml += "<div class=\\"stat-item\\"><span class=\\"stat-label\\">" + key + "</span><span class=\\"stat-value\\">";\n' +
      '        if (typeof value === "number") itemsHtml += "<span class=\\"value-number\\">" + value + "</span>";\n' +
      '        else if (typeof value === "boolean") itemsHtml += value ? "<span class=\\"value-true\\">✓</span>" : "<span class=\\"value-false\\">✕</span>";\n' +
      '        else if (Array.isArray(value)) itemsHtml += "<span class=\\"value-text\\">[" + value.join(", ") + "]</span>";\n' +
      '        else itemsHtml += "<span class=\\"value-text\\">" + String(value == null ? "" : value) + "</span>";\n' +
      '        itemsHtml += "</span></div>";\n' +
      '      }\n' +
      '      if (itemsHtml) htmlStr += "<div class=\\"stat-grid " + indentClass + "\\">" + itemsHtml + "</div>";\n' +
      '    }\n' +
      '    rt(data, 0);\n' +
      '    try {\n' +
      '      root.innerHTML = htmlStr;\n' +
      '      root.classList.add("flash-update");\n' +
      '      setTimeout(function() { try { root.classList.remove("flash-update"); } catch(_) {} }, 300);\n' +
      '    } catch(_) {}\n' +
      '  }\n' +
      '  setTimeout(fallbackRender, 500);\n' +
      '  setTimeout(fallbackRender, 1500);\n' +
      '  setTimeout(fallbackRender, 3500);\n' +
      '})();\n' +
      '<\/script>\n';
  }

/** 补全 HTML 骨架：AI 只给片段时补 doctype/head/body；缺 render-root 时补一个 */
export function ensureHtmlDoc(html) {
    let s = String(html || '').trim();
    while (/^```[^\n]*\n/.test(s)) s = s.replace(/^```[^\n]*\n/, '');
    s = s.replace(/\n```\s*$/, '');
    const hasDocType = /<!doctype\s/i.test(s);
    const hasHtmlTag = /<html[\s>]/i.test(s);
    const hasHeadTag = /<head[\s>]/i.test(s);
    if (!hasDocType && !hasHtmlTag) {
        s = '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <title>MVU StatusBar</title>\n</head>\n<body>\n' + s + '\n</body>\n</html>';
    } else if (hasHtmlTag && !hasHeadTag) {
        s = s.replace(/<html([^>]*)>/i, '<html$1>\n<head></head>');
    }
    if (s.indexOf('id="render-root"') < 0 && s.indexOf("id='render-root'") < 0) {
        if (/<body([^>]*)>/i.test(s)) {
            s = s.replace(/(<body[^>]*>)/i,
                '$1\n<div class="mvu-status-card"><div class="card-body" id="render-root"><div class="loading-state">正在加载状态数据...</div></div></div>');
        }
    }
    return s;
}

/** 把 mock 脚本插到 <head> 最前面（早于状态栏自己的 script 执行，$ / _ / getVariables 先就绪） */
export function injectMock(html, statData) {
    const doc = ensureHtmlDoc(html);
    const mock = mockScript(statData || {});
    const head = doc.match(/<head[^>]*>/i);
    if (head) {
        const idx = doc.indexOf(head[0]);
        return doc.slice(0, idx + head[0].length) + '\n' + mock + '\n' + doc.slice(idx + head[0].length);
    }
    if (doc.indexOf('<body') >= 0) return doc.replace(/<body/i, mock + '<body');
    return mock + doc;
}

/**
 * 轻量 InitVar YAML → 对象（预览用）。只认写卡器那套：
 *   key: value / key:（嵌对象）/ - item（数组）/ 0 / true / null / [] / {}
 * 不引第三方 yaml，够把 stat_data 还原出来就行。
 */
export function parseInitVarYaml(text) {
    const rows = String(text || '').split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l) && !/^\s*---\s*$/.test(l));
    const root = {};
    const stack = [{ indent: -1, node: root }];
    let lastKey = null;
    for (let ri = 0; ri < rows.length; ri++) {
        const raw = rows[ri];
        const indent = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
        const line = raw.trim();
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
        const parent = stack[stack.length - 1].node;
        if (line.startsWith('- ')) {
            const v = line.slice(2).trim();
            if (Array.isArray(parent)) parent.push(scalar(v));
            continue;
        }
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim().replace(/^['"]|['"]$/g, '');
        const rest = m[2].trim();
        if (rest === '') {
            // 下一行决定是对象还是数组
            const next = rows[ri + 1];
            const child = next && /^\s*-\s/.test(next) ? [] : {};
            parent[key] = child;
            stack.push({ indent, node: child });
            lastKey = key;
        } else {
            parent[key] = scalar(rest);
            lastKey = key;
        }
    }
    return root;
}

function scalar(v) {
    const s = String(v).trim().replace(/^['"]|['"]$/g, '');
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === '[]') return [];
    if (s === '{}') return {};
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('[') || s.startsWith('{')) {
        try { return JSON.parse(s.replace(/'/g, '"')); } catch { return s; }
    }
    return s;
}
