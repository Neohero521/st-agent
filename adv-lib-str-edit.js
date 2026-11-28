/**
 * 字面行级编辑（照抄 DSH packages/fs/fs-local/src/fsio.ts 的 applyLiteralEdit 语义）
 *
 * DSH 的 edit 就三条铁律，没有五级降级：
 *   ① old_string 必须非空、且与 new_string 不同（相同 = 保证空转）；
 *   ② 一处都匹配不到 → NOT_FOUND；
 *   ③ 命中多处以 replace_all=false → AMBIGUOUS（让调用方给更具体的 old_string，或 replace_all=true）。
 * 换行先归一成 LF 再比较，避免 CRLF 让整段"看起来全变了"。
 * 这里额外补两件 DSH 前端才有的体验：命中位置带行号/列号，找不到时给最相近的行，方便下一轮直接改准。
 */

export function normalizeNewlines(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 字面计数（不重叠） */
export function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0;
    let i = 0;
    while (true) {
        const at = hay.indexOf(needle, i);
        if (at < 0) break;
        n += 1;
        i = at + needle.length;
    }
    return n;
}

function lineColAt(text, idx) {
    const before = text.slice(0, idx);
    const line = before.split('\n').length;
    const col = idx - (before.lastIndexOf('\n') + 1) + 1;
    return { line, col };
}

/** 每处命中的行号、列号、以及那一行的原文（截 120 字） */
export function matchSpans(text, needle, limit = 8) {
    const out = [];
    let i = 0;
    while (out.length < limit) {
        const at = text.indexOf(needle, i);
        if (at < 0) break;
        const { line, col } = lineColAt(text, at);
        const lineText = text.split('\n')[line - 1] || '';
        out.push({ index: at, line, col, line_text: lineText.length > 120 ? lineText.slice(0, 120) + '…' : lineText });
        i = at + needle.length;
    }
    return out;
}

/** 找不到时给最相近的行：取 old_string 首行前 12 字做锚，实在没有就取前 6 字 */
export function nearestLines(text, oldStr, limit = 3) {
    const first = normalizeNewlines(oldStr).split('\n')[0].trim();
    const anchors = [first.slice(0, 12), first.slice(0, 6)].filter(a => a.length >= 3);
    const rows = normalizeNewlines(text).split('\n');
    const hits = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (anchors.length && !anchors.some(a => row.indexOf(a) >= 0)) continue;
        hits.push({ line: i + 1, line_text: row.length > 120 ? row.slice(0, 120) + '…' : row });
        if (hits.length >= limit) break;
    }
    if (!hits.length) {
        const token = first.replace(/[^\u4e00-\u9fa5A-Za-z0-9_$]/g, ' ').trim().split(/\s+/)[0] || '';
        if (token.length >= 2) {
            for (let i = 0; i < rows.length && hits.length < limit; i++) {
                if (rows[i].indexOf(token) >= 0) hits.push({ line: i + 1, line_text: rows[i].slice(0, 120) });
            }
        }
    }
    return hits;
}

/**
 * 做一次字面编辑。返回结构化结果（不抛错，工具层直接把它当返回值给模型看）。
 * @returns {{ok:boolean, code?:string, message?:string, content?:string, replacements?:number, matches?:Array, nearest?:Array}}
 */
export function editText(content, oldStr, newStr, replaceAll = false, label = '内容') {
    const c = normalizeNewlines(content);
    const o = normalizeNewlines(oldStr);
    const n = normalizeNewlines(newStr);
    if (!o) return { ok: false, code: 'EMPTY_OLD', message: 'old_string 不能为空（要删除就把 new_string 留空，old_string 仍得是原文）' };
    if (o === n) return { ok: false, code: 'NO_OP', message: 'old_string 与 new_string 完全相同，这次编辑不会改变任何东西' };
    const matches = matchSpans(c, o, 12);
    if (!matches.length) {
        const rows = c.split('\n');
        let near = nearestLines(c, o, 3);
        if (!near.length) {
            near = rows.slice(0, 3).map((row, i) => ({ line: i + 1, line_text: row.length > 120 ? row.slice(0, 120) + '…' : row }));
        }
        return {
            ok: false,
            code: 'NOT_FOUND',
            message: `在${label}里找不到 old_string。别整体重写：先从下面真实存在的行里挑一段原文（含缩进）改成唯一匹配再试`,
            nearest: near,
            total_lines: rows.length,
            bytes: c.length,
        };
    }
    if (!replaceAll && matches.length > 1) {
        return {
            ok: false,
            code: 'AMBIGUOUS',
            message: `old_string 在${label}里匹配 ${matches.length} 处（要求唯一）：给它多带一行上下文，或显式 replace_all=true`,
            matches,
        };
    }
    const out = replaceAll ? c.split(o).join(n) : c.slice(0, matches[0].index) + n + c.slice(matches[0].index + o.length);
    return {
        ok: true,
        code: 'OK',
        content: out,
        replacements: replaceAll ? matches.length : 1,
        matches,
        before_bytes: c.length,
        after_bytes: out.length,
    };
}

/** 编辑预览：把改动前后的命中行并排列出来（面板 / 工具结果都够读） */
export function editPreview(before, after, oldStr, newStr) {
    const b = normalizeNewlines(before).split('\n');
    const a = normalizeNewlines(after).split('\n');
    let same = 0;
    while (same < b.length && same < a.length && b[same] === a[same]) same += 1;
    let tail = 0;
    while (tail < b.length - same && tail < a.length - same && b[b.length - 1 - tail] === a[a.length - 1 - tail]) tail += 1;
    return {
        first_changed_line: same + 1,
        removed_lines: b.length - same - tail,
        added_lines: a.length - same - tail,
        removed: b.slice(same, b.length - tail),
        added: a.slice(same, a.length - tail),
    };
}
