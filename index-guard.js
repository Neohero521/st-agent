/**
 * 循环卫生 guard —— 照搬 deepseek-harness `packages/guard/` 两个包的约定，不自己发明判定：
 *
 * 1) repeat-tool-reminder：只认「同一工具 + 规范化后完全相同的参数」（深度键排序 + JSON 序列化，
 *    属性顺序无关）。include 为空 = 跟踪全部工具；exclude 里的工具既不计数也不重置，穿插记录类
 *    工具因此掩盖不了循环。链按 agent 隔离，新用户消息清零。只在「恰好等于」阈值时提醒，
 *    只建议、不否决——提醒作为一条普通消息跟在工具结果后面。
 * 2) timeout-policy：只给声明了限时的工具（ToolDefinition 上的 timeoutMs）设协作式上限，
 *    超时返回 `Error: tool call timed out after <ms>ms`（TOOL_TIMEOUT），未声明的原样放行。
 */

// 默认阈值：重复 3 次短提醒，5、8 次详细提醒（DSH 基础组合包默认值）
const THRESHOLDS = [3, 5, 8];
// 与 DSH 示例一致把 todo_write 排除在外：写清单本身不是「卡住」
const EXCLUDE = new Set(['todo.write']);
// 详细提醒里最多显示多少字符参数
const ARG_PREVIEW = 500;

/** 声明了限时的工具及其预算（毫秒）。没声明的工具不设上限。 */
const TOOL_TIMEOUTS = {
    'web.fetch': 30000,
    'web.search': 30000,
};

let chain = { key: '', count: 0 };

function canon(value) {
    if (value === null || typeof value !== 'object') {
        const v = value === undefined ? null : value;
        try { return JSON.stringify(v); } catch { return String(v); }
    }
    if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

/** 新的用户消息（一轮任务开始）清零，跟 DSH 一样：全新指令绝不会被当成循环。 */
export function resetRepeat() {
    chain = { key: '', count: 0 };
}

/**
 * 记一次直接的工具调用。返回提醒文本（命中阈值时），否则 null。
 * 被用户拒绝的调用也算——反复尝试被拒的调用正是要打破的循环。
 */
export function noteRepeat(tool, args) {
    const name = String(tool || '');
    if (EXCLUDE.has(name)) return null;   // 不计也不重置：透明
    let key;
    try { key = name + '|' + canon(args); } catch { key = name + '|' + String(args); }
    if (key !== chain.key) {
        chain = { key, count: 1 };
        return null;
    }
    chain.count += 1;
    const count = chain.count;
    if (!THRESHOLDS.includes(count)) return null;

    if (count === THRESHOLDS[0]) {
        return '你在用完全相同的参数重复同一个工具调用。先仔细看上一次的结果再决定：任务没完成就换个办法、换一组参数，别把同一次调用再发一遍。';
    }
    let preview;
    try { preview = canon(args); } catch { preview = String(args); }
    const omitted = preview.length - ARG_PREVIEW;
    preview = preview.slice(0, ARG_PREVIEW) + (omitted > 0 ? `… (+${omitted} more chars)` : '');
    return `检测到重复的工具调用：\n- 工具：${name}\n- 连续次数：${count}\n- 参数：${preview}\n这些重复没有推进任务。不要再用这组完全相同的参数调用它。看最新结果，换别的动作、换参数，或者证据够了就直接收尾。`;
}

/** 工具声明的限时；没声明返回 0（不设上限）。 */
export function toolTimeoutMs(name) {
    return TOOL_TIMEOUTS[String(name || '')] || 0;
}

/** 协作式超时包装：到点先给模型一个清晰错误，不硬杀下游。 */
export async function withTimeout(promise, ms, name) {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return promise;
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`Error: tool call timed out after ${ms}ms`);
            error.name = 'ToolTimeoutError';
            error.code = 'TOOL_TIMEOUT';
            error.toolName = String(name || '');
            reject(error);
        }, ms);
    });
    try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}
