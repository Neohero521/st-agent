/**
 * 非 MVU 脚本：规范 + 可跑模板（照抄写卡器 SCRIPTUI_SPEC / 悬浮球标准写法 / 实跑脚本范式）
 *
 * 写卡器原文要点（v329.59 14756–14806）：
 *  · 入口 $(() => {}) 而不是 DOMContentLoaded；卸载 pagehide 而不是 unload
 *  · 挂载：脚本内 $ 就是酒馆页面 jQuery；禁止 window.top.document，禁止取不到 top 就回退自己的 document
 *  · 三种渲染：innerHTML / createScriptIdDiv + Vue / createScriptIdIframe 隔离
 *  · 按钮：appendInexistentScriptButtons → eventOn(getButtonEvent(name))
 *  · 状态：getVariables({type:'script', script_id:getScriptId()})，不裸存 localStorage
 *  · 错误：入口 errorCatched(init)()，不可恢复 throw，可恢复 console.warn
 *  · 悬浮球：纯 div + position:fixed；pointerdown + setPointerCapture；>4px 才算拖拽；拖拽后吞一次 click
 */

export const SCRIPT_RUNTIME_SPEC = {
    entry: "$(() => { errorCatched(init)(); }) —— jQuery ready，不要 DOMContentLoaded",
    unload: "$(window).on('pagehide', cleanup) —— 不要 unload；切聊天/切卡时回收监听与定时器",
    mount: [
        "脚本里的 $ 就是酒馆页面的 jQuery（window.$ = parent.$）：$('<style id=…>').text(css).appendTo('head')、$('<div id=…>').appendTo('body')",
        '禁止 window.top.document；禁止 window.parent.document 探测/挂载（沙箱下拿不到就静默回退脚本隐藏 iframe，界面永远不显示）',
        '需要 iframe 内容用 createScriptIdIframe().appendTo(body) → contentDocument；手动 iframe 必须父页面 document 建 + contentDocument.write',
            ],
    render: [
        '① innerHTML 进容器（轻量展示）',
        '② createScriptIdDiv() + Vue createApp（复杂交互；补充酒馆样式时**禁用 tailwind**，用 teleportStyle 复制到 head）',
        '③ createScriptIdIframe()（独立组件，样式隔离；优先 tailwind，额外样式 teleportStyle 到 iframe head，必须等 load 完成再 mount）',
    ],
    buttons: "appendInexistentScriptButtons(['按钮名']) 确保存在 → eventOn(getButtonEvent('按钮名'), cb)；按钮要在 script.button.buttons 里声明并 visible",
    state: "getVariables({type:'script', script_id: getScriptId()})；不要 localStorage 裸键（会被当聊天变量污染作用域）",
    errors: '入口 errorCatched(init)()；不可恢复 throw Error；可恢复 console.warn；日志前缀【脚本|脚本名】',
    libs: '预置可直接用：$ / _ / toastr / ejs / Vue / Pinia / zod / gsap / pixi.js / @vueuse/core / vue-router(createMemoryHistory) / yaml / showdown / klona / async-wait-until',
    refresh: 'MESSAGE_UPDATED 防抖 300ms 再读变量（写回后数据才可靠）；MESSAGE_RECEIVED 延迟 1000ms 兜底；再加 1.5s 低频 JSON 对比巡检防事件漏发',
    float: [
        '宿主同挂载规则：$(\'<style>\').appendTo(\'head\')、$(\'<div id=…>\').appendTo(\'body\')',
        '简单悬浮球/设置面板用纯 div + position:fixed，不要为悬浮球建 iframe',
        '必须 $(() => {}) 或 readyState 检查；$ 缺失时 window.parent.$ / window.jQuery 兜底',
        '拖拽 pointerdown + setPointerCapture，move/up 绑父页面 document，位移 >4px 才算拖拽，拖拽后吞一次 click，clamp 到视口，位置存脚本变量',
        '自愈：MutationObserver / 低频检查根节点，不存在才重建，禁止重复 append',
        '常见失败：取到隐藏/跨域文档、没等 DOM ready、$ 未定义、iframe 挂错 document、z-index 被祖先 transform 限制',
    ],
};

const HOST_BOOT = [
    '(() => {',
    '  const ID = "sta-__ID__";',
    '  const STYLE_ID = "sta-__ID__-style";',
    "  const SCRIPT_ID = (typeof getScriptId === 'function' ? getScriptId() : 'sat-agent');",
    '',
    '  function cleanup() {',
    '    try { if (window.__STA_OBS) { window.__STA_OBS.disconnect(); window.__STA_OBS = null; } } catch (e) {}',
    '    $(`#${ID}`).remove();',
    '    $(`#${STYLE_ID}`).remove();',
    '    $(window).off("resize", clampPos);',
    '  }',
    '',
    '  function clampPos(p) {',
    '    const w = $(window).width() || 375, h = $(window).height() || 667;',
    '    const size = 52;',
    '    return {',
    '      x: Math.min(Math.max(p.x, 6), w - size - 6),',
    '      y: Math.min(Math.max(p.y, 6), h - size - 6),',
    '    };',
    '  }',
    '',
    '  function readPos() {',
    "    try {",
    "      const v = getVariables({ type: 'script', script_id: SCRIPT_ID }) || {};",
    '      if (v.__ID__Pos && typeof v.__ID__Pos.x === "number") return v.__ID__Pos;',
    '    } catch (e) {}',
    '    return { x: (($(window).width() || 375) - 70), y: (($(window).height() || 667) * 0.58) };',
    '  }',
    '',
    '  function savePos(p) {',
    "    try {",
    "      const cur = getVariables({ type: 'script', script_id: SCRIPT_ID }) || {};",
    "      setVariables({ type: 'script', script_id: SCRIPT_ID }, Object.assign({}, cur, { __ID__Pos: p }));",
    '    } catch (e) { console.warn("[脚本|__ID__] 位置保存失败", e); }',
    '  }',
    '',
    '  function init() {',
    '    if (typeof $ === "undefined") { const $p = (window.parent && window.parent.$) || window.jQuery; if (!$p) return; window.$ = $p; }',
    '    cleanup();',
    '    const pos = clampPos(readPos());',
    '',
    '    $("<style>").attr("id", STYLE_ID).text(css()).appendTo("head");',
    '    const $ball = $("<div id=\\"" + ID + "\\" class=\\"sta-ball\\" role=\\"button\\" aria-label=\\"__LABEL__\\">__ICON__</div>");',
    '    $ball.css({ left: pos.x + "px", top: pos.y + "px" }).appendTo("body");',
    '',
    '    // 拖拽：>4px 才算拖，拖完吞一次 click 防误触',
    '    let drag = null;',
    '    $ball.on("pointerdown", function (e) {',
    '      e.preventDefault();',
    '      drag = { sx: e.clientX, sy: e.clientY, ox: parseFloat($ball.css("left")), oy: parseFloat($ball.css("top")), moved: false };',
    '      try { $ball[0].setPointerCapture(e.pointerId); } catch (_e) {}',
    '    });',
    '    $(document).on("pointermove", function (e) {',
    '      if (!drag) return;',
    '      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;',
    '      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;',
    '      drag.moved = true;',
    '      const p = clampPos({ x: drag.ox + dx, y: drag.oy + dy });',
    '      $ball.css({ left: p.x + "px", top: p.y + "px" });',
    '    });',
    '    $(document).on("pointerup pointercancel", function () {',
    '      if (!drag) return;',
    '      const moved = drag.moved;',
    '      drag = null;',
    '      if (moved) {',
    '        savePos({ x: parseFloat($ball.css("left")), y: parseFloat($ball.css("top")) });',
    '        $ball.one("click", function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); });',
    '      }',
    '    });',
    '',
    '    $ball.on("click", onTap);',
    '',
    '    // 自愈：球被别的东西重绘掉就重建（只在不存在时建）',
    "    try {",
    '      window.__STA_OBS = new MutationObserver(function () {',
    '        if (!$(`#${ID}`).length) { $(window).off("resize", clampPos); init(); }',
    '      });',
    '      window.__STA_OBS.observe(document.body, { childList: true, subtree: false });',
    '    } catch (e) { console.warn("[脚本|__ID__] 观察器创建失败", e); }',
    '',
    '    $(window).on("pagehide", cleanup);',
    '  }',
    '',
    '  function css() {',
    '    return `',
    '      .sta-ball { position: fixed; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;',
    '        display: flex; align-items: center; justify-content: center; cursor: grab; user-select: none;',
    '        touch-action: none; color: #fff; font-size: 24px; line-height: 1;',
    '        background: linear-gradient(160deg, #5b4636, #8a6a4a);',
    '        box-shadow: 0 6px 18px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.14); }',
    '      .sta-ball:active { cursor: grabbing; transform: scale(.96); }',
    '      @media (max-width: 520px) { .sta-ball { width: 48px; height: 48px; font-size: 22px; } }',
    '    `;',
    '  }',
    '',
    '  // 点击行为（按需改这里）',
    '  function onTap() {',
    '    try {',
    "      if (typeof toastr !== 'undefined') toastr.info('__LABEL__ 已点击');",
    '      // 需要发消息就用：triggerSlash("/send __LABEL__|/trigger")',
    '    } catch (e) { console.error("[脚本|__ID__] 点击处理失败", e); }',
    '  }',
    '',
    '  $(() => { try { errorCatched(init)(); } catch (e) { init(); } });',
    '})();',
];

const HUD_BOOT = [
    '(() => {',
    '  const ID = "sta-__ID__";',
    '  const STYLE_ID = "sta-__ID__-style";',
    "  const SCRIPT_ID = (typeof getScriptId === 'function' ? getScriptId() : 'st-agent');",
    '  let last = "";',
    '  let timer = 0;',
    '',
    '  function statData() {',
    '    try {',
    "      const v = getVariables({ type: 'message' }) || {};",
    '      if (v.stat_data) return v.stat_data;',
    '    } catch (e) {}',
    '    try {',
    '      const all = getAllVariables() || {};',
    '      if (all.stat_data) return all.stat_data;',
    '    } catch (e) {}',
    '    try {',
    "      const th = window.TavernHelper;",
    '      if (th && th.getVariables) {',
    "        const v = th.getVariables({ type: 'message' }) || {};",
    '        if (v.stat_data) return v.stat_data;',
    '      }',
    '    } catch (e) {}',
    '    return null;',
    '  }',
    '',
    '  function pick(data) {',
    '    if (!data) return { "__KEY__": "—" };',
    '    const out = {};',
    '    __PICK_LINES__',
    '    return out;',
    '  }',
    '',
    '  function render(data) {',
    '    const vals = pick(data);',
    '    let html = `<div id="${ID}" class="sta-hud">`;',
    '    html += `<div class="sta-hud-h">__LABEL__</div>`;',
    '    Object.keys(vals).forEach(function (k) {',
    '      html += `<div class="sta-hud-r"><span class="k">${k}</span><span class="v">${String(vals[k])}</span></div>`;',
    '    });',
    '    html += "</div>";',
    '    const $el = $(`#${ID}`);',
    '    if ($el.length) $el.replaceWith(html);',
    '    else $(html).appendTo("body");',
    '  }',
    '',
    '  function sync() {',
    '    try {',
    '      const data = statData();',
    '      const s = JSON.stringify(data || {});',
    '      if (s === last) return;',
    '      last = s;',
    '      render(data);',
    '    } catch (e) { console.warn("[脚本|__ID__] 同步失败", e); }',
    '  }',
    '',
    '  function debouncedSync() {',
    '    clearTimeout(timer);',
    '    timer = setTimeout(sync, 300);',
    '  }',
    '',
    '  function init() {',
    '    if (typeof $ === "undefined") { const $p = (window.parent && window.parent.$) || window.jQuery; if (!$p) return; window.$ = $p; }',
    '    $(`#${ID}`).remove();',
    '    $(`#${STYLE_ID}`).remove();',
    '    $("<style>").attr("id", STYLE_ID).text(css()).appendTo("head");',
    '    sync();',
    '',
    '    const ev = (window.Mvu && window.Mvu.events && window.Mvu.events.VARIABLE_UPDATE_ENDED) || null;',
    '    if (ev && typeof eventOn === "function") eventOn(ev, debouncedSync);',
    '    const te = window.tavern_events || {};',
    '    try {',
    '      if (typeof eventOn === "function") {',
    '        if (te.MESSAGE_UPDATED) eventOn(te.MESSAGE_UPDATED, debouncedSync);',
    '        if (te.MESSAGE_RECEIVED) eventOn(te.MESSAGE_RECEIVED, function () { setTimeout(sync, 1000); });',
    '        if (te.CHAT_CHANGED) eventOn(te.CHAT_CHANGED, function () { last = ""; sync(); });',
    '      }',
    '    } catch (e) { console.warn("[脚本|__ID__] 事件绑定失败", e); }',
    '',
    '    // 低频巡检兜底（事件漏发时不至于一直读旧值）',
    "    if (!window.__STA_HUD_TIMER) window.__STA_HUD_TIMER = setInterval(sync, 1500);",
    '',
    '    $(window).on("pagehide", cleanup);',
    '  }',
    '',
    '  function cleanup() {',
    '    clearTimeout(timer);',
    '    try { if (window.__STA_HUD_TIMER) { clearInterval(window.__STA_HUD_TIMER); window.__STA_HUD_TIMER = null; } } catch (e) {}',
    '    $(`#${ID}`).remove();',
    '    $(`#${STYLE_ID}`).remove();',
    '  }',
    '',
    '  function css() {',
    '    return `',
    '      .sta-hud { position: fixed; left: 10px; bottom: 12px; z-index: 2147482000; width: 190px;',
    '        border-radius: 12px; border: 1px solid rgba(255,255,255,.16);',
    '        background: rgba(24,22,20,.82); color: #f0e6d8; font-size: 12px;',
    '        backdrop-filter: blur(8px); box-shadow: 0 8px 22px rgba(0,0,0,.3); overflow: hidden; }',
    '      .sta-hud-h { padding: 7px 10px; font-weight: 600; letter-spacing: .04em;',
    '        background: linear-gradient(90deg, rgba(160,120,70,.35), rgba(160,120,70,.06)); }',
    '      .sta-hud-r { display: flex; justify-content: space-between; gap: 8px; padding: 4px 10px;',
    '        border-top: 1px solid rgba(255,255,255,.06); }',
    '      .sta-hud-r .k { opacity: .72; }',
    '      .sta-hud-r .v { font-weight: 600; }',
    '      @media (max-width: 520px) { .sta-hud { width: 150px; font-size: 11px; } }',
    '    `;',
    '  }',
    '',
    '  $(() => { try { errorCatched(init)(); } catch (e) { init(); } });',
    '})();',
];

const PANEL_BOOT = [
    '(() => {',
    '  const ID = "sta-__ID__";',
    '',
    '  function build() {',
    '    return `',
    '      <!DOCTYPE html><html><head><meta charset="utf-8">',
    '      <style>',
    '        body { margin: 0; padding: 14px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;',
    '          background: #1c1a18; color: #eee6da; }',
    '        .card { border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 12px; }',
    '        .h { font-weight: 600; margin-bottom: 8px; }',
    '        .row { display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.06); }',
    '        .btn { margin-top: 10px; width: 100%; padding: 9px; border-radius: 10px; border: 0;',
    '          background: linear-gradient(160deg,#6a5236,#9a7a52); color: #fff; font-size: 13px; }',
    '      </style></head><body>',
    '      <div class="card"><div class="h">__LABEL__</div><div id="rows"></div>',
    '        <button class="btn" id="go">__ACTION__</button></div>',
    '      <script>',
    '        const rows = document.getElementById("rows");',
    '        // 需要数据时在父页面侧算好再传进来（iframe 内不直接读酒馆变量）',
    '        const data = window.__STA_DATA__ || {};',
    '        Object.keys(data).forEach(function (k) {',
    '          const d = document.createElement("div"); d.className = "row";',
    '          d.innerHTML = "<span>" + k + "</span><span>" + data[k] + "</span>";',
    '          rows.appendChild(d);',
    '        });',
    '        document.getElementById("go").addEventListener("click", function () {',
    '          try { parent.postMessage({ __sta: "__ID__", action: "go" }, "*"); } catch (e) {}',
    '        });',
    '      <\\/script></body></html>',
    '    `;',
    '  }',
    '',
    '  function init() {',
    '    if (typeof $ === "undefined") { const $p = (window.parent && window.parent.$) || window.jQuery; if (!$p) return; window.$ = $p; }',
    '    $(`#${ID}`).remove();',
    '    // 父页面 jQuery 挂 style + iframe：不要 window.top.document',
    '    $("<style>").attr("id", ID + "-style").text(`',
    '      #${ID} { position: fixed; left: 50%; top: 12vh; transform: translateX(-50%);',
    '        width: min(92vw, 420px); height: min(70vh, 560px); z-index: 2147482500;',
    '        border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,255,255,.18);',
    '        box-shadow: 0 18px 46px rgba(0,0,0,.42); }',
    '      #${ID} iframe { width: 100%; height: 100%; border: 0; }',
    '    `).appendTo("head");',
    '    const $wrap = $("<div id=\\"" + ID + "\\"></div>").appendTo("body");',
    '    const ifr = document.createElement("iframe");',
    '    ifr.setAttribute("sandbox", "allow-scripts allow-same-origin");',
    '    ifr.style.cssText = "width:100%;height:100%;border:0";',
    '    $wrap[0].appendChild(ifr);',
    "    try { ifr.contentDocument.open(); ifr.contentDocument.write(build()); ifr.contentDocument.close(); }",
    '    catch (e) { ifr.src = "about:srcdoc"; ifr.srcdoc = build(); console.warn("[脚本|__ID__] iframe 写入兜底", e); }',
    '',
    '    $(window).on("message", function (e) {',
    '      const d = e.data || {};',
    '      if (d.__sta !== "__ID__") return;',
    '      if (d.action === "go") {',
    '        try { triggerSlash("/send __ACTION__|/trigger"); } catch (err) { console.warn("[脚本|__ID__] 动作失败", err); }',
    '      }',
    '    });',
    '    $(window).on("pagehide", cleanup);',
    '  }',
    '',
    '  function cleanup() {',
    '    $(`#${ID}`).remove();',
    '    $(`#${ID}-style`).remove();',
    '  }',
    '',
    '  $(() => { try { errorCatched(init)(); } catch (e) { init(); } });',
    '})();',
];

const BAR_BOOT = [
    '(() => {',
    '  const BTN = "__LABEL__";',
    '',
    '  async function onClick() {',
    "    try {",
    '      // 点按钮 = 以用户身份发一句并触发生成；要只发不生成就只留 /send',
    '      triggerSlash("/send " + BTN + "|/trigger");',
    "    } catch (e) { console.error('[脚本|__ID__] 按钮失败', e); }",
    '  }',
    '',
    '  function init() {',
    '    if (typeof appendInexistentScriptButtons !== "function") return;',
    '    appendInexistentScriptButtons([BTN]);',
    '    if (typeof eventOn === "function" && typeof getButtonEvent === "function") {',
    '      eventOn(getButtonEvent(BTN), onClick);',
    '    }',
    '  }',
    '',
    '  $(() => { try { errorCatched(init)(); } catch (e) { init(); } });',
    '})();',
];

function fill(lines, vars) {
    let out = lines.join('\n');
    for (const k of Object.keys(vars)) {
        out = out.split(`__${k}__`).join(String(vars[k]));
    }
    return out;
}

function safeId(s) {
    return String(s || 'float').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'float';
}

/** 悬浮球脚本（纯 div，可拖拽，位置持久化到脚本变量） */
export function floatingBallScript(opts = {}) {
    const id = safeId(opts.id || 'ball');
    return fill(HOST_BOOT, {
        ID: id,
        ICON: opts.icon || '✦',
        LABEL: opts.label || '悬浮球',
    });
}

/** 变量 HUD 脚本（底部小面板，监听 MVU 与消息事件 + 巡检兜底） */
export function hudScript(opts = {}) {
    const id = safeId(opts.id || 'hud');
    const keys = Array.isArray(opts.keys) && opts.keys.length ? opts.keys : ['好感度'];
    const pickLines = keys
        .map(k => `    out["${k}"] = (data && data["${k}"] !== undefined) ? data["${k}"] : "—";`)
        .join('\n');
    return fill(HUD_BOOT, { ID: id, LABEL: opts.label || '状态', KEY: keys[0], PICK_LINES: pickLines });
}

/** 独立面板脚本（createScriptIdIframe 式隔离 + postMessage 回父页面） */
export function panelScript(opts = {}) {
    const id = safeId(opts.id || 'panel');
    return fill(PANEL_BOOT, {
        ID: id,
        LABEL: opts.label || '面板',
        ACTION: opts.action || '继续',
    });
}

/** 酒馆助手按钮脚本（按钮注册 + 斜杠命令） */
export function barScript(opts = {}) {
    const id = safeId(opts.id || 'bar');
    return fill(BAR_BOOT, { ID: id, LABEL: opts.label || '开始' });
}

export const SCRIPT_TEMPLATE_KINDS = ['floating', 'hud', 'panel', 'bar'];

export function scriptTemplate(kind, opts = {}) {
    const k = String(kind || '').toLowerCase();
    if (k === 'floating') return floatingBallScript(opts);
    if (k === 'hud') return hudScript(opts);
    if (k === 'panel') return panelScript(opts);
    if (k === 'bar') return barScript(opts);
    throw new Error(`未知脚本模板：${kind}（可选 ${SCRIPT_TEMPLATE_KINDS.join(' / ')}）`);
}
