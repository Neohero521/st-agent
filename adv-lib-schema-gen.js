/**
 * 从 [InitVar] 条目反推 zod schema（照抄 我的写卡器-v329.59.js 的 generateMvuSchemaScript）
 *
 * 写卡器原文口径：
 *   - HEADER 只 import registerMvuSchema（z 与 _ 在酒馆助手 iframe 里是全局，裸 import z 会崩）
 *   - null → z.string().nullable().prefault(null)（漏 .nullable() 开局就报「期望 string 实际 null」）
 *   - number → z.coerce.number()（模型常把数值写成 "85" 字符串）
 *   - 空对象 → z.record(z.string(), z.string()).prefault({})（可被 JSON Patch remove 后重建）
 *   - 非空对象 → z.object({...})，不加 prefault 具体值（具体值由 [InitVar] 承载）
 *   - 数组 → z.array(子类型)，不加 prefault
 *   - 不自动加 0~100 clamp 之类业务约束（除非卡里明确要求）
 *   - FOOTER 固定 $(() => { registerMvuSchema(Schema); });
 * 关键价值：schema 和 InitVar 的键名/层级天然一致，从根上消灭「顶层键错位」这种 Agent 手写才会犯的错。
 */
import { parseInitVarYaml } from './adv-lib-mvu-preview.js';

function escapeKey(key) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || /^[\u4e00-\u9fff\w]+$/.test(key)) return key;
    return "'" + String(key).replace(/'/g, "\\'") + "'";
}

// InitVar 里写成 null 的字段无从判断类型；按字段名给个合理猜测（数值类字段用 coerce.number，
// 否则会是 z.string() —— 一开局把 0 当字符串校验失败，就是「变量直接不动」的常见死因）
const NUM_KEY = /^(好感度|好感|信任|疑心|声望|心动值|防备心|亲密度|依赖度|感情|对男友感情|恐惧|愤怒|理智|体力|精神|金钱|金币|银两|年龄|等级|进度|数量|分数|积分|威望|魅力|颜值|san值)$/;
function looksNumeric(key) {
    const k = String(key || '').trim();
    if (NUM_KEY.test(k)) return true;
    return /(度|值)$/.test(k) && !/^(态度|温度|清晰度|透明度|尺度)$/.test(k);
}

function genValueZod(val, key) {
    if (val === null || val === undefined) {
        if (looksNumeric(key)) return 'z.coerce.number().nullable().prefault(0)';
        return 'z.string().nullable().prefault(null)';
    }
    if (typeof val === 'boolean') return 'z.boolean()';
    if (typeof val === 'number') return 'z.coerce.number()';
    if (typeof val === 'string') return 'z.string()';
    if (Array.isArray(val)) {
        let item = 'z.string()';
        if (val.length > 0) {
            if (typeof val[0] === 'number') item = 'z.coerce.number()';
            else if (typeof val[0] === 'boolean') item = 'z.boolean()';
            else if (val[0] && typeof val[0] === 'object' && !Array.isArray(val[0])) item = 'z.object({\n' + genObjectLines(val[0], 4) + '\n    })';
        }
        return 'z.array(' + item + ')';
    }
    return 'z.string()';
}

function genObjectLines(obj, indent) {
    const pad = new Array(indent + 1).join(' ');
    let lines = [];
    const keys = Object.keys(obj);
    keys.forEach(function (key, i) {
        const val = obj[key];
        const comma = i < keys.length - 1 ? ',' : '';
        if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
            if (Object.keys(val).length === 0) {
                lines.push(pad + escapeKey(key) + ': z.record(z.string(), z.string()).prefault({})' + comma);
            } else {
                lines.push(pad + escapeKey(key) + ': z.object({');
                lines = lines.concat(genObjectLines(val, indent + 2));
                lines.push(pad + '})' + comma);
            }
            return;
        }
        lines.push(pad + escapeKey(key) + ': ' + genValueZod(val, key) + comma);
    });
    return lines;
}

const HEADER = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\n\nexport const Schema = z.object({";
const FOOTER = "});\n\n$(() => {\n  registerMvuSchema(Schema);\n});";

/** InitVar YAML → zod schema 源码（含头尾，可直接写进「变量结构」脚本位） */
export function schemaFromInitVar(text) {
    let obj = null;
    try { obj = parseInitVarYaml(String(text || '')); } catch (e) { obj = null; }
    // 兼容 AI 多套的 stat_data 层
    if (obj && obj.stat_data && typeof obj.stat_data === 'object' && Object.keys(obj).length === 1) obj = obj.stat_data;
    if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) {
        throw new Error('InitVar 解析为空：先把 [InitVar]初始变量 写好（顶层就是变量根，如 角色名: / 世界:），再反推 schema');
    }
    const lines = genObjectLines(obj, 2);
    return { code: HEADER + '\n' + lines.join('\n') + '\n' + FOOTER, topKeys: Object.keys(obj), fields: lines.length };
}
