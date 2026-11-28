/**
 * 共享任务板（对标 deepseek-harness packages/team/agent-team）
 *
 * DSH 语义照抄、执行方式本地化：
 *   · task-id 是 task-1、task-2…，每次变更 revision +1，更新是 compare-and-set；
 *   · blockedBy 必须指向未删除任务且保持无环——环会被拒，不是警告；
 *   · writeScopes 是**提示性**路径前缀，不是锁（重叠只给 warning）；
 *   · pending 表示未开始或已释放，in_progress 带负责人，completed 满足依赖，deleted 是保留墓碑；
 *   · ready = pending 且 blockedBy 全部 completed。
 *
 * 与 DSH 的差异（单生成通道 + 单进程）：
 *   · 负责人用子任务名（sub.spawn 的 name）或 'lead'，不用 Session id；
 *   · 任务板挂在当前会话上（session.team），刷新不丢（EXTRA_FIELDS 已加 team）；
 *   · 「任务就绪不会唤醒负责人」——这条保留，工具只改数据，唤醒靠 sub.spawn/sub.continue。
 */

import { getActiveSession, getSession, flushSessions } from './index-sessions.js';

const MAX_TASKS = 200;
const STATUS = new Set(['pending', 'in_progress', 'completed', 'deleted']);

/** 任务板（懒建）：{ enabled, seq, tasks[] } */
export function board(session) {
    const s = session || getActiveSession();
    if (!s) return null;
    if (!s.team || typeof s.team !== 'object') {
        s.team = { enabled: true, seq: 0, tasks: [] };
    }
    const t = s.team;
    if (!Array.isArray(t.tasks)) t.tasks = [];
    if (typeof t.seq !== 'number') t.seq = t.tasks.length;
    if (t.enabled === undefined) t.enabled = true;
    return t;
}

export function teamEnabled(session) {
    const t = board(session);
    return !!(t && t.enabled !== false);
}

export function setTeamEnabled(on, session) {
    const t = board(session);
    if (!t) throw new Error('没有活动会话');
    t.enabled = !!on;
    flushSessions();
    return { enabled: t.enabled };
}

function normScopes(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const p = String(raw || '').trim().replace(/\\/g, '/');
        if (!p) continue;
        if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`writeScopes 只接受相对路径：${p}`);
        const seg = p.split('/');
        if (seg.includes('..')) throw new Error(`writeScopes 不能含 .. 路径段：${p}`);
        out.push(p.replace(/\/+$/, ''));
    }
    return out.slice(0, 8);
}

/** 能直接开工 = pending 且所有阻塞任务都已完成（被删的阻塞项不再算阻塞） */
function readiness(t, task) {
    const byId = new Map(t.tasks.map(x => [x.id, x]));
    const blockers = (task.blockedBy || []).map(id => byId.get(id)).filter(Boolean);
    const open = blockers.filter(b => b.status !== 'completed' && b.status !== 'deleted');
    return { ready: task.status === 'pending' && open.length === 0, blocked_by_open: open.map(b => b.id) };
}

function scopeWarnings(t, task) {
    const mine = task.writeScopes || [];
    if (!mine.length) return [];
    const out = [];
    for (const other of t.tasks) {
        if (other.id === task.id || other.status === 'completed' || other.status === 'deleted') continue;
        for (const a of mine) {
            for (const b of other.writeScopes || []) {
                const na = a.replace(/\/$/, ''); const nb = b.replace(/\/$/, '');
                if (na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')) {
                    out.push(`${task.id} 的 ${a} 与 ${other.id}(${other.status}) 的 ${b} 重叠`);
                }
            }
        }
    }
    return out;
}

/** 视图（不改持久快照）：ready / writeScopeWarnings / owner 名 */
export function view(t, task) {
    const r = readiness(t, task);
    return {
        id: task.id,
        revision: task.revision,
        subject: task.subject,
        description: task.description || '',
        status: task.status,
        owner: task.ownerName || task.ownerId || '',
        blockedBy: [...(task.blockedBy || [])],
        writeScopes: [...(task.writeScopes || [])],
        ready: r.ready,
        blocked_by_open: r.blocked_by_open,
        writeScopeWarnings: scopeWarnings(t, task),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function assertAcyclic(t, id, blockedBy) {
    // 从每个新阻塞项往回追，追到 id 就是成环
    const byId = new Map(t.tasks.map(x => [x.id, x]));
    const seen = new Set();
    const walk = (cur) => {
        if (!cur || seen.has(cur)) return;
        if (cur === id) throw new Error(`blockedBy 成环：${id} 的依赖链绕回自己`);
        seen.add(cur);
        const node = byId.get(cur);
        if (!node) return;
        for (const b of node.blockedBy || []) walk(b);
    };
    for (const b of blockedBy) {
        if (!byId.has(b)) throw new Error(`blockedBy 指向不存在的任务：${b}（已删除的任务也不能当依赖）`);
        if (byId.get(b).status === 'deleted') throw new Error(`blockedBy 指向已删除任务：${b}`);
        walk(b);
    }
}

export function createTask({ subject, description, blocked_by, write_scopes, owner }, session) {
    const t = board(session);
    if (!t) throw new Error('没有活动会话，任务板无处可挂');
    const subj = String(subject || '').trim();
    if (!subj) throw new Error('team.task.create 需要 subject');
    if (t.tasks.filter(x => x.status !== 'deleted').length >= MAX_TASKS) throw new Error(`任务太多（上限 ${MAX_TASKS}），先清理墓碑`);
    const blocked = Array.isArray(blocked_by) ? blocked_by.map(String) : (blocked_by ? [String(blocked_by)] : []);
    t.seq += 1;
    const id = `task-${t.seq}`;
    assertAcyclic(t, id, blocked);
    const now = Date.now();
    const task = {
        id,
        revision: 1,
        subject: subj,
        description: String(description || ''),
        status: 'pending',
        ownerId: '',
        ownerName: String(owner || '').trim(),
        blockedBy: blocked,
        writeScopes: normScopes(write_scopes),
        createdAt: now,
        updatedAt: now,
    };
    t.tasks.push(task);
    flushSessions();
    return view(t, task);
}

export function listTasks({ status, unowned, owner, offset, limit } = {}, session) {
    const t = board(session);
    if (!t) throw new Error('没有活动会话');
    let list = t.tasks.filter(x => x.status !== 'deleted');
    if (status) list = list.filter(x => x.status === status);
    if (unowned === true) list = list.filter(x => !x.ownerId && !x.ownerName);
    if (unowned === false) list = list.filter(x => x.ownerId || x.ownerName);
    if (owner) list = list.filter(x => (x.ownerName || '') === String(owner) || x.ownerId === String(owner));
    const views = list.map(x => view(t, x));
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.min(100, Math.max(1, Number(limit) || 100));
    return { total: views.length, offset: off, count: Math.min(lim, views.length - off), tasks: views.slice(off, off + lim) };
}

export function getTask(id, session) {
    const t = board(session);
    if (!t) throw new Error('没有活动会话');
    const task = t.tasks.find(x => x.id === String(id));
    if (!task) throw new Error(`没有 ${id} 这个任务`);
    return view(t, task);
}

/**
 * 一次带 revision 的变更。action：
 *   claim(owner) / start / complete / release / reassign(owner) / edit(subject,description,write_scopes,blocked_by) / delete
 */
export function updateTask({ id, revision, action, owner, subject, description, write_scopes, blocked_by }, { caller } = {}, session) {
    const t = board(session);
    if (!t) throw new Error('没有活动会话');
    const task = t.tasks.find(x => x.id === String(id));
    if (!task) throw new Error(`没有 ${id} 这个任务`);
    if (task.status === 'deleted') throw new Error(`${id} 已删除，墓碑不能再改`);
    if (revision !== undefined && revision !== null && Number(revision) !== Number(task.revision)) {
        throw new Error(`revision 过期：你是 ${revision}，现在 ${task.revision}（先 team.task.get 重读再改）`);
    }
    const who = String(caller || owner || 'lead').trim() || 'lead';
    const act = String(action || '').trim();
    const now = Date.now();

    if (act === 'claim') {
        const r = readiness(t, task);
        if (task.status !== 'pending') throw new Error(`${id} 现在是 ${task.status}，只有 pending 能被认领`);
        if (!r.ready) throw new Error(`${id} 还没就绪，阻塞在 ${r.blocked_by_open.join('、')}`);
        task.ownerId = who;
        task.ownerName = String(owner || who);
        task.status = 'in_progress';
    } else if (act === 'start') {
        if (task.status !== 'pending') throw new Error(`${id} 现在是 ${task.status}`);
        const r = readiness(t, task);
        if (!r.ready) throw new Error(`${id} 还没就绪，阻塞在 ${r.blocked_by_open.join('、')}`);
        task.status = 'in_progress';
    } else if (act === 'complete') {
        if (task.status === 'completed') throw new Error(`${id} 已经完成了`);
        if (!task.ownerId && !task.ownerName) notesAdd(task, who);
        task.status = 'completed';
        task.ownerId = task.ownerId || who;
        task.ownerName = task.ownerName || who;
    } else if (act === 'release') {
        task.status = 'pending';
        task.ownerId = '';
        task.ownerName = '';
    } else if (act === 'reassign') {
        const name = String(owner || '').trim();
        if (!name) throw new Error('reassign 需要 owner');
        task.ownerName = name;
        task.ownerId = name;
    } else if (act === 'edit') {
        if (subject !== undefined) {
            const s = String(subject || '').trim();
            if (!s) throw new Error('subject 不能为空');
            task.subject = s;
        }
        if (description !== undefined) task.description = String(description || '');
        if (write_scopes !== undefined) task.writeScopes = normScopes(write_scopes);
        if (blocked_by !== undefined) {
            const blocked = Array.isArray(blocked_by) ? blocked_by.map(String) : [String(blocked_by)];
            assertAcyclic(t, task.id, blocked);
            task.blockedBy = blocked;
        }
    } else if (act === 'delete') {
        task.status = 'deleted';
    } else {
        throw new Error(`不认识的 action：${act}（可用 claim/start/complete/release/reassign/edit/delete）`);
    }

    task.revision += 1;
    task.updatedAt = now;
    flushSessions();
    return view(t, task);
}

function notesAdd(task, who) {
    if (!task.notes) task.notes = [];
    task.notes.push(`${who} 直接完成`);
}

/** 给提示词用的紧凑一行视图：只给活任务、按 id 排序 */
export function teamBrief(session) {
    const t = board(session);
    if (!t || t.enabled === false) return '';
    const live = t.tasks.filter(x => x.status !== 'deleted');
    if (!live.length) return '';
    const parts = live.slice(-12).map(x => {
        const r = readiness(t, x);
        const owner = x.ownerName || x.ownerId;
        return `${x.id}[${x.status}${r.ready ? ',就绪' : ''}${owner ? '→' + owner : ''}] ${x.subject}`;
    });
    const more = live.length > 12 ? ` …还有 ${live.length - 12} 条` : '';
    return live.join ? parts.join(' · ') + more : '';
}
