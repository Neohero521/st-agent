import { getContext } from '../../../extensions.js';
import { CATALOG, reg } from './v20-catalog-a.js';
import { planOps } from './v20-plan.js';
import { opsApply } from './v20-apply.js';
import { writeCardExtensions } from './adv-lib-card.js';

/**
 * 成套写卡（write kit）
 *
 * 写卡器 v329.59 在「写入酒馆」上是按「一套资产一次落地」来做的：角色卡字段、
 * 世界书一整批条目、酒馆助手脚本（含 MVU schema / 本体 / 状态栏）、正则，
 * 一次写完之后**立刻回读核对**，缺哪条当场补，而不是写完就说“好了”。
 *
 * 这里把那套动作编译成批量操作（ops），复用已有的「预演 → 快照 → 逐条隔离 → 可回滚」
 * 链路：card.compose 默认只预演，commit=true 才真正落盘，落盘后逐项回读比对。
 *
 * 为什么不用现成的单条工具串行调用：单条写没有批次快照，第 3 条失败后前 2 条已经改脏，
 * 想退回去只能手动。走 ops 才有一条 ops.undo 整体回退的余地。
 */

const c = () => getContext();
const OPS_LIMIT = 40;

function short(v, n = 40) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? '');
}

function cardOf(nameOrAvatar) {
    const list = c()?.characters ?? [];
    if (!nameOrAvatar) return list[c()?.characterId] || null;
    return list.find(x => x && (x.name === nameOrAvatar || x.avatar === nameOrAvatar)) || null;
}

function scriptTree(card) {
    const th = card?.data?.extensions?.tavern_helper;
    return Array.isArray(th?.scripts) ? th.scripts : [];
}

function flatten(node, out = []) {
    for (const item of node || []) {
        if (!item) continue;
        if (item.type === 'folder') flatten(item.scripts, out);
        else out.push(item);
    }
    return out;
}

/* ------------------------------ 补两条可批处理清单 ------------------------------ */

// script.upsert 是 v1.16 引入的规范写入（带 button/data/export_with），
// 但批量清单里只有旧的 script.set，导致 ops 里写脚本会被判“不允许批处理”。
reg('script.upsert', 2, 'none',
    a => `脚本 ${a.name || a.id || '?'}`,
    async a => {
        const card = cardOf(a.card);
        const all = flatten(scriptTree(card));
        const hit = all.find(s => (a.id && s.id === a.id) || (a.name && s.name === a.name));
        if (!String(a.content || '').trim()) return { error: 'content 为空：写脚本必须给完整 JS 源码' };
        return hit
            ? { change: 'update', note: `已有同名脚本（id=${hit.id}），将原地更新` }
            : { change: 'create', note: `当前共 ${all.length} 个脚本` };
    });

reg('lore.bind', 2, 'none',
    a => `绑定世界书 ${a.primary || a.name || '(只读)'}`,
    async a => {
        if (!a.role) return { change: 'noop', note: '只回读当前绑定' };
        if (a.role === 'character' && !a.primary && !a.additional) return { error: '缺少 primary 或 additional' };
        return { change: 'update', note: `role=${a.role}` };
    });

reg('lb.setEntry', 2, 'world',
    a => `条目 ${a.name || '?'} / ${a.comment || a.uid || '?'}`,
    async a => {
        if (!a.name) return { error: '缺少 name（世界书名）' };
        if (!a.comment && a.uid === undefined) return { error: '缺少 comment 与 uid：不知道要写哪一条' };
        const data = await c().loadWorldInfo(String(a.name)).catch(() => null);
        const rows = Object.entries(data?.entries || {}).map(([uid, row]) => ({ uid: Number(uid), ...row }));
        const hit = a.uid !== undefined ? rows.find(r => r.uid === Number(a.uid)) : rows.find(r => coreName(r.comment) === coreName(a.comment));
        return hit ? { change: 'update', note: `uid=${hit.uid}` } : { change: 'create', note: `当前 ${rows.length} 条` };
    });

/** 核心名：剥掉 [xxx] / <xxx> / 【xxx】 等外层，用来认「同一条条目」的不同叫法 */
function coreName(s) {
    let x = String(s || '').trim();
    let prev = null;
    while (prev !== x) {
        prev = x;
        x = x.replace(/^[\[【<《（(][^\]】>》\）)]*[\]】>》\）)]\s*/, '').trim();
    }
    return x;
}

/* ------------------------------ 编译 ------------------------------ */

async function buildOps(spec) {
    const ops = [];
    const notes = [];
    const card = spec.card;

    if (spec.fields && typeof spec.fields === 'object') {
        const keys = Object.keys(spec.fields).filter(k => spec.fields[k] !== undefined);
        if (keys.length) {
            const args = { name: card };
            for (const k of keys) args[k] = spec.fields[k];
            ops.push({ tool: 'char.edit', args, why: '角色卡字段' });
        }
    }

    if (spec.book && typeof spec.book === 'object') {
        const bookName = String(spec.book.name || '').trim();
        if (!bookName) throw new Error('book.name 为空：成套写卡必须指明世界书名');
        if (spec.book.create) ops.push({ tool: 'world.create', args: { name: bookName }, why: '建世界书' });
        const entries = Array.isArray(spec.book.entries) ? spec.book.entries : [];
        if (entries.length > OPS_LIMIT - ops.length) throw new Error(`条目过多（${entries.length}），单批上限 ${OPS_LIMIT}，请分两批`);
        // lb.setEntry 是「有 uid 就改、没 uid 就新建」，不会按 comment 自动合并。
        // 所以先读一遍这本书，把已存在的 comment 对上 uid 带上 —— 否则同一条目每写一次就多堆一条。
        const data = spec.book.create ? null : await c().loadWorldInfo(bookName).catch(() => null);
        const rows = Object.entries(data?.entries || {}).map(([uid, row]) => ({ uid: Number(uid), ...row }));
        for (const e of entries) {
            if (!e || !e.comment) { notes.push('跳过一条没有 comment 的条目'); continue; }
            const comment = String(e.comment);
            const hit = rows.find(r => String(r.comment || '').trim() === comment.trim()) || rows.find(r => coreName(r.comment) === coreName(comment));
            ops.push({
                tool: 'lb.setEntry',
                args: {
                    name: bookName,
                    uid: hit ? hit.uid : undefined,
                    comment,
                    content: String(e.content ?? ''),
                    position: e.position ?? 0,
                    depth: e.depth ?? 4,
                    order: e.order ?? 100,
                    constant: e.constant ?? false,
                    enabled: e.enabled !== false,
                },
                why: e.why || (hit ? '更新条目' : '新建条目'),
            });
        }
        if (spec.book.bind) {
            // lore.bind 只认「当前打开的那张卡」。没开卡时它会报「未打开任何角色卡」，
            // 那会让整批记成 failed —— 但书和条目其实都写成功了。所以先探测，绑不上只提示。
            if (!c()?.characterId) notes.push('当前没打开角色卡，跳过「绑定世界书」；打开卡后再调 lore.bind 即可');
            else ops.push({ tool: 'lore.bind', args: { role: 'character', primary: bookName, additional: spec.book.additional }, why: '绑到角色卡' });
        }
    }

    const avatar = cardOf(card)?.avatar;
    for (const s of spec.scripts || []) {
        if (!s || !s.name) { notes.push('跳过一条没有 name 的脚本'); continue; }
        // script.upsert 的真实入参只有 card / name / id / content / enabled / buttons / data：
        // info 与 export_with 由它按规范固定填，传了也不会被接收 —— 与其静默吞掉，不如点名告诉模型。
        const args = { name: String(s.name), content: String(s.content ?? '') };
        if (avatar) args.card = avatar;
        if (s.id) args.id = s.id;
        if (s.enabled !== undefined) args.enabled = s.enabled;
        if (s.buttons !== undefined) args.buttons = s.buttons;
        if (s.data !== undefined) args.data = s.data;
        if (s.info || s.export_with) notes.push(`script.upsert 不接受 info / export_with，已按规范固定填写：${s.name}`);
        ops.push({ tool: 'script.upsert', args, why: s.why || '酒馆助手脚本' });
    }

    for (const r of spec.regexes || []) {
        if (!r || !r.scriptName) { notes.push('跳过一条没有 scriptName 的正则'); continue; }
        // 成套写卡的正则必须落在目标卡的正则位：写全局会把这张卡的美化糊到所有卡上
        const rxArgs = {
            scriptName: String(r.scriptName),
            findRegex: r.findRegex,
            replaceString: r.replaceString ?? '',
            placement: r.placement,
            disabled: r.disabled,
            markdownOnly: r.markdownOnly,
            promptOnly: r.promptOnly,
            runOnEdit: r.runOnEdit,
            scope: r.scope === 'global' ? 'global' : 'card',
        };
        if (avatar) rxArgs.card = avatar;
        ops.push({ tool: 'regex.upsert', args: rxArgs, why: r.why || '正则' });
    }

    if (ops.length > OPS_LIMIT) throw new Error(`本套 ${ops.length} 条超过单批上限 ${OPS_LIMIT}，请拆成两批（例如先条目、再脚本+正则）`);
    return { ops, notes };
}

/* ------------------------------ 回读核对 ------------------------------ */

/**
 * 写完必须回读：酒馆的写入是「请求成功 ≠ 落盘成功」。
 * 角色卡走 merge-attributes 深合并、世界书走 saveWorldInfo、正则走 extensionSettings，
 * 任何一处失败都不会报，所以逐项去读一遍真实值，才算真的写进去。
 */
async function verify(spec) {
    const out = { card: null, book: null, scripts: [], regexes: [], problems: [] };
    const card = cardOf(spec.card);

    if (spec.fields) {
        const keys = Object.keys(spec.fields).filter(k => spec.fields[k] !== undefined && k !== 'name');
        const bad = keys.filter(k => {
            const got = card?.[k] ?? card?.data?.[k];
            return typeof spec.fields[k] === 'string' ? String(got ?? '') !== String(spec.fields[k]) : got === undefined;
        });
        out.card = { name: card?.name, checked: keys.length, mismatched: bad };
        if (bad.length) out.problems.push(`角色卡字段没写进去：${bad.join('、')}`);
    }

    if (spec.book?.name) {
        const data = await c().loadWorldInfo(String(spec.book.name)).catch(() => null);
        const entries = Object.values(data?.entries || {});
        const want = (spec.book.entries || []).map(e => String(e.comment));
        const names = entries.map(e => String(e.comment || ''));
        const missing = want.filter(w => !names.includes(w));
        out.book = { name: spec.book.name, entries: names.length, wanted: want.length, missing };
        if (missing.length) out.problems.push(`世界书缺条目：${missing.join('、')}`);
    }

    if (spec.scripts?.length) {
        const all = flatten(scriptTree(cardOf(spec.card)));
        for (const s of spec.scripts) {
            const hit = all.find(x => (s.id && x.id === s.id) || x.name === String(s.name));
            out.scripts.push({ name: s.name, ok: !!hit, id: hit?.id, bytes: String(hit?.content || '').length });
            if (!hit) out.problems.push(`脚本没写进去：${s.name}`);
        }
    }

    if (spec.regexes?.length) {
        // 回读要与写入同源：卡级读 data.extensions.regex_scripts（全局只是兜底，兼容旧数据）
        const scoped = Array.isArray(card?.data?.extensions?.regex_scripts) ? card.data.extensions.regex_scripts : [];
        const global = c()?.extensionSettings?.regex ?? [];
        for (const r of spec.regexes) {
            const wantGlobal = r.scope === 'global';
            const hit = (wantGlobal ? global : scoped).find(x => x.scriptName === String(r.scriptName))
                || (wantGlobal ? null : global.find(x => x.scriptName === String(r.scriptName)));
            out.regexes.push({ scriptName: r.scriptName, ok: !!hit, placement: hit?.placement, scope: wantGlobal ? 'global' : 'scoped' });
            if (!hit) out.problems.push(`正则没写进去：${r.scriptName}（${wantGlobal ? '全局' : '卡内'}）`);
        }
    }

    out.ok = out.problems.length === 0;
    return out;
}

/* ------------------------------ 工具 ------------------------------ */

export const TOOLS = [
    {
        name: 'card.compose',
        kind: 'write',
        desc: '成套写卡：一次提交角色卡字段 + 世界书整批条目 + 酒馆助手脚本 + 正则，走「预演 → 快照 → 逐条执行 → 回读核对」。默认只预演（列出每条会新建还是更新、风险等级），commit=true 才落盘；落盘失败可 ops.undo 整体回滚。写完自动回读，把没写进去的条目/脚本/正则点名报出来。',
        params: {
            card: 'string 角色名或头像（可空=当前角色）',
            fields: 'object 要写的卡字段（description/personality/scenario/first_mes/mes_example/creator_notes…）',
            book: 'object {name, create?, bind?, additional?, entries:[{comment, content, position?, depth?, order?, constant?, enabled?}]}',
            scripts: 'array [{name, id?, content, info?, enabled?, button?, export_with?, data?}]',
            regexes: 'array [{scriptName, findRegex, replaceString?, placement?, disabled?, markdownOnly?, promptOnly?, scope?}]（scope 默认 card：写目标卡的正则位，只对这张卡生效；要全剧通用才传 global）',
            commit: 'boolean 默认 false（只预演）；true 才真正写盘',
        },
        run: async a => {
            const { ops, notes } = await buildOps(a);
            if (!ops.length) throw new Error('没有任何可写入的内容：检查 fields / book.entries / scripts / regexes');
            const plan = await planOps(ops);

            if (!a.commit) {
                return {
                    ok: plan.errors.length === 0,
                    committed: false,
                    total: ops.length,
                    counts: plan.counts,
                    highestRisk: plan.highest,
                    items: plan.items,
                    errors: plan.errors,
                    notes,
                    hint: '这是预演，没有写盘。确认后带 commit:true 再调一次（会拍快照，可用 ops.undo 回滚）。',
                };
            }

            if (plan.errors.length) {
                return { ok: false, committed: false, errors: plan.errors, items: plan.items, hint: '预演就有错误，已中止，一条都没写。' };
            }

            const applied = await opsApply({ ops });
            const check = await verify(a);
            return {
                ok: applied.ok !== false && check.ok,
                committed: true,
                applied: {
                    applied: applied.applied,
                    failed: applied.failed,
                    skipped: applied.skipped,
                    journalId: applied.journal,
                    undoable: applied.undoable,
                    errors: applied.errors,
                    warnings: applied.warnings,
                },
                verify: check,
                problems: check.problems,
                hint: check.ok ? '全部回读通过。' : '有项目没落地，按 problems 点名补；整体写坏了可用 ops.undo 回滚该批。',
            };
        },
    },
    {
        name: 'script.folder',
        kind: 'write',
        desc: '酒馆助手脚本树的文件夹（folder）操作：建文件夹、把脚本移进/移出文件夹、删空文件夹、列整棵树的层级。此前只能读脚本列表、没法建 folder，写整套卡时脚本只能平铺。',
        params: {
            action: "list|create|move|remove 默认 list",
            name: 'string 文件夹名',
            id: 'string 文件夹 id（与 name 二选一）',
            scriptName: 'string move 时要移动的脚本名',
            scriptId: 'string move 时要移动的脚本 id',
            icon: 'string 图标，默认 fa-solid fa-folder',
            color: 'string 颜色',
            card: 'string 角色名或头像（可空=当前角色）',
        },
        run: async a => {
            const card = cardOf(a.card);
            if (!card) throw new Error('拿不到角色卡：先打开一张卡');
            const tree = JSON.parse(JSON.stringify(scriptTree(card)));
            const action = String(a.action || 'list');

            const walk = (nodes, parent) => {
                for (const n of nodes || []) {
                    if (n?.type === 'folder') walk(n.scripts, n);
                }
            };

            const layout = () => {
                const lines = [];
                const dump = (nodes, depth) => {
                    for (const n of nodes || []) {
                        if (n?.type === 'folder') {
                            lines.push(`${'  '.repeat(depth)}📁 ${n.name}（${(n.scripts || []).length} 项）`);
                            dump(n.scripts, depth + 1);
                        } else {
                            lines.push(`${'  '.repeat(depth)}📄 ${n.name}${n.enabled === false ? '（停用）' : ''}`);
                        }
                    }
                };
                dump(tree, 0);
                return lines;
            };

            const findFolder = nodes => {
                for (const n of nodes || []) {
                    if (n?.type === 'folder' && ((a.id && n.id === a.id) || (a.name && n.name === String(a.name)))) return n;
                    if (n?.type === 'folder') {
                        const deep = findFolder(n.scripts);
                        if (deep) return deep;
                    }
                }
                return null;
            };

            const takeScript = root => {
                let found = null;
                const scan = nodes => {
                    for (let i = 0; i < nodes.length; i++) {
                        const n = nodes[i];
                        if (!n) continue;
                        if (n.type === 'folder') { scan(n.scripts); continue; }
                        if ((a.scriptId && n.id === a.scriptId) || (a.scriptName && n.name === String(a.scriptName))) {
                            found = n; nodes.splice(i, 1); return;
                        }
                    }
                };
                scan(root);
                return found;
            };

            if (action === 'list') {
                return { ok: true, folders: [], tree: layout(), scripts: flatten(tree).length, note: '📁 是 folder，📄 是脚本' };
            }

            if (action === 'create') {
                if (!a.name && !a.id) throw new Error('create 需要 name');
                if (findFolder(tree)) return { ok: true, existed: true, tree: layout() };
                tree.push({
                    type: 'folder',
                    enabled: true,
                    name: String(a.name),
                    id: a.id || `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    icon: a.icon || 'fa-solid fa-folder',
                    color: a.color,
                    scripts: [],
                });
            } else if (action === 'move') {
                const folder = findFolder(tree);
                if (!folder) throw new Error(`没找到文件夹：${a.name || a.id}`);
                const script = takeScript(tree);
                if (!script) throw new Error(`没找到脚本：${a.scriptName || a.scriptId}`);
                folder.scripts = folder.scripts || [];
                folder.scripts.push(script);
            } else if (action === 'remove') {
                const idxOf = nodes => nodes.findIndex(n => n?.type === 'folder' && ((a.id && n.id === a.id) || (a.name && n.name === String(a.name))));
                const strip = nodes => {
                    const i = idxOf(nodes);
                    if (i >= 0) {
                        const folder = nodes[i];
                        if ((folder.scripts || []).length) throw new Error(`文件夹非空（${folder.scripts.length} 项），先 move 出来再删`);
                        nodes.splice(i, 1);
                        return true;
                    }
                    for (const n of nodes) if (n?.type === 'folder' && strip(n.scripts)) return true;
                    return false;
                };
                if (!strip(tree)) throw new Error(`没找到文件夹：${a.name || a.id}`);
            } else {
                throw new Error(`action 只能是 list / create / move / remove，收到 ${action}`);
            }

            // v1.30：与 script.upsert 同一条通道（edit-attribute → merge → TavernHelper）
            const w = await writeCardExtensions(card.avatar, ext => {
                const th = (ext.tavern_helper = ext.tavern_helper || {});
                th.scripts = tree;
                if (!th.variables || typeof th.variables !== 'object') th.variables = {};
                return ext;
            });
            c().saveSettingsDebounced?.();
            return { ok: true, action, tree: layout(), scripts: flatten(tree).length, channel: w.channel };
        },
    },
    {
        name: 'card.series',
        kind: 'write',
        desc: '成套写「系列卡」：一个世界观拆 N 张卡——共享层（MVU 7 条 / schema 脚本 / 状态栏正则）每张卡各写一份，'
            + '独有层（这一卷的人设条目、独有脚本）各写各的，世界书只建一本。'
            + '默认只预演（逐卡列出条数/风险/错误）；commit:true 才逐卡落盘，每卡一批、每卡可单独 ops.undo。'
            + '多卷独有条目默认自动加 [卡名] 前缀，避免两卷同名条目互相覆盖。',
        params: {
            book: 'object {name, create?, bind?}：共享的那本世界书',
            shared: 'object {entries[], scripts[], regexes[]}：每张卡都要有的公共资产。世界书共享条目只写一次，脚本/正则每卡各一份（卡内资产）',
            cards: 'array [{card, fields?, entries?, scripts?, regexes?}]：每张卡。entries 是这一卷独有、写进同一本书的条目',
            prefix: 'boolean 默认 true：给每卷独有条目的 comment 加 [卡名] 前缀',
            commit: 'boolean 默认 false（只预演）',
        },
        run: async a => {
            const list = Array.isArray(a.cards) ? a.cards : [];
            if (!list.length) throw new Error('cards 为空：至少要一张卡');
            const bookName = String(a.book?.name || '').trim();
            if (!bookName) throw new Error('book.name 为空：系列卡共用一本世界书，必须给名字');
            const shared = a.shared && typeof a.shared === 'object' ? a.shared : {};
            const shEntries = Array.isArray(shared.entries) ? shared.entries : [];
            const shScripts = Array.isArray(shared.scripts) ? shared.scripts : [];
            const shRegexes = Array.isArray(shared.regexes) ? shared.regexes : [];
            const usePrefix = a.prefix !== false;

            // ① 重名检测（不前缀时同名的独有条目会互相覆盖）
            const conflicts = [];
            const seen = new Map();
            const cardNameOf = v => String(v?.card || v?.name || '').trim();
            list.forEach(v => {
                const who = cardNameOf(v);
                for (const e of Array.isArray(v?.entries) ? v.entries : []) {
                    const cm = String(e?.comment || '').trim();
                    if (!cm || usePrefix) continue;
                    if (seen.has(cm)) conflicts.push(`${cm} 同时出现在「${seen.get(cm)}」和「${who}」`);
                    else seen.set(cm, who);
                }
            });
            if (conflicts.length) {
                throw new Error(`不同卷的独有条目重名（会互相覆盖）：${conflicts.join('；')}。传 prefix:true 自动加 [卡名] 前缀，或自己改名`);
            }

            // ② 编译每卡的 compose 规格
            const specs = [];
            list.forEach((v, i) => {
                const name = cardNameOf(v);
                if (!name) throw new Error(`第 ${i + 1} 张卡缺 card 名`);
                const entries = [];
                if (i === 0) entries.push(...shEntries);
                for (const e of Array.isArray(v.entries) ? v.entries : []) {
                    if (!e) continue;
                    entries.push(usePrefix && e.comment
                        ? Object.assign({}, e, { comment: `[${name}]${String(e.comment).trim()}` })
                        : e);
                }
                const needBook = entries.length > 0 || (i === 0 && (a.book?.create || shEntries.length));
                specs.push({
                    card: name,
                    fields: v.fields,
                    book: needBook ? { name: bookName, create: i === 0 && !!a.book?.create, entries } : undefined,
                    scripts: shScripts.concat(Array.isArray(v.scripts) ? v.scripts : []),
                    regexes: shRegexes.concat(Array.isArray(v.regexes) ? v.regexes : []),
                });
            });

            const buildAll = async () => {
                const out = [];
                for (const spec of specs) {
                    const got = await buildOps(spec);
                    out.push({ spec, ops: got.ops, notes: got.notes });
                }
                return out;
            };

            // ③ 预演
            if (!a.commit) {
                const built = await buildAll();
                const rows = [];
                let total = 0;
                let highest = 0;
                for (const b of built) {
                    const plan = await planOps(b.ops);
                    rows.push({
                        card: b.spec.card,
                        ops: b.ops.length,
                        counts: plan.counts,
                        highestRisk: plan.highest,
                        errors: plan.errors,
                        notes: b.notes.filter(Boolean),
                    });
                    total += b.ops.length;
                    highest = Math.max(highest, plan.highest || 0);
                }
                return {
                    ok: rows.every(r => r.errors.length === 0),
                    committed: false,
                    book: bookName,
                    cards: rows,
                    total,
                    highestRisk: highest,
                    conflicts,
                    hint: '这是预演，没有写盘。确认后带 commit:true 再调一次：会逐卡执行、逐卡回读，每卡一批可单独 ops.undo。',
                };
            }

            // ④ 落盘：重新编译一次（拿最新 uid），逐卡执行 + 回读
            const built = await buildAll();
            const out = [];
            let totalOps = 0;
            for (const b of built) {
                const plan = await planOps(b.ops);
                if (plan.errors.length) {
                    out.push({ card: b.spec.card, ok: false, skipped: true, errors: plan.errors });
                    continue;
                }
                const applied = await opsApply({ ops: b.ops });
                const check = await verify(b.spec);
                totalOps += b.ops.length;
                out.push({
                    card: b.spec.card,
                    ok: applied.ok !== false && check.ok,
                    applied: {
                        applied: applied.applied,
                        failed: applied.failed,
                        skipped: applied.skipped,
                        journalId: applied.journal,
                        undoable: applied.undoable,
                        errors: applied.errors,
                    },
                    verify: check,
                    problems: check.problems,
                });
            }
            const bad = out.filter(r => !r.ok);
            return {
                ok: bad.length === 0,
                committed: true,
                book: bookName,
                cards: out,
                total: totalOps,
                problems: bad.map(r => `${r.card}：${(r.problems || r.errors || []).join('；')}`),
                hint: bad.length
                    ? '有卡没落地：按 problems 点名的那张单独补，或对它的 journalId 用 ops.undo 回滚这一卡。'
                    : '全部回读通过。共享层的条目只写了一次，脚本与正则每卡各一份。',
            };
        },
    },
];
