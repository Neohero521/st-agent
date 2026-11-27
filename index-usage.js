/**
 * 上下文占用计量 —— 结构照抄 deepseek-harness `packages/llm/token-meter`：
 * 每 token 固定字符数 + 块/角色结构开销，确定性、不调模型、可回放；
 * 消费方式是「压缩阈值看 measure()，UI 占用看 measure() / 容量」。
 *
 * 但有一处必须偏离原文：DSH 自己在 dev-note 里写明
 * 「每 token 四字符启发式对 CJK 文本与 JSON Schema 严重低估」。
 * 中文写卡场景几乎全是 CJK，照抄 4 字符/token 会把 2 万字算成 5000 token，
 * 于是压缩永远不触发、直到窗口真的爆掉。这里按字符类别分开计价：
 * CJK 每字 ≈ 1 token（留 10% 余量），ASCII/拉丁按 4 字符 1 token，块与角色各加固定开销。
 */

/** 粗分：CJK 统一表意文字、假名、韩文、全角标点都算「一字一 token」 */
function isWide(codePoint) {
    return (
        (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||   // CJK 部首 / 标点 / 统一表意
        (codePoint >= 0xa960 && codePoint <= 0xa97f) ||   // 谚文字母扩展
        (codePoint >= 0xac00 && codePoint <= 0xd7ff) ||   // 谚文音节
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||   // CJK 兼容表意
        (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||   // CJK 兼容形式
        (codePoint >= 0xff00 && codePoint <= 0xffef) ||   // 全角
        (codePoint >= 0x1f300 && codePoint <= 0x1faff)    // emoji（每字符通常 1~2 token，按 1 保守）
    );
}

/** 单段文本的 token 估算 */
export function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    let wide = 0;
    let narrow = 0;
    for (const ch of s) {
        if (isWide(ch.codePointAt(0))) wide++;
        else narrow++;
    }
    return Math.ceil(wide * 1.1) + Math.ceil(narrow / 4);
}

/** 一条消息：内容 + 角色/分隔开销（DSH 的固定块开销口径） */
export function estimateMessage(message) {
    const content = message && message.content != null ? message.content : '';
    return estimateTokens(content) + 4;
}

/**
 * 构成拆分（对标 contextBreakdown）：system / tools / messages 三类分开算，
 * 因为「占了窗口的到底是系统提示、工具定义还是对话」在调提示词时完全是三种处理方式。
 */
export function contextBreakdown(messages, toolSchemas = '') {
    const list = Array.isArray(messages) ? messages : [];
    let systemTokens = 0;
    let messageTokens = 0;
    for (const m of list) {
        const n = estimateMessage(m);
        if (m && m.role === 'system') systemTokens += n;
        else messageTokens += n;
    }
    const toolsTokens = estimateTokens(toolSchemas) + (toolSchemas ? 8 : 0);
    return {
        systemTokens,
        toolsTokens,
        messageTokens,
        totalTokens: systemTokens + toolsTokens + messageTokens,
        // 中文场景给一个人话口径：约等于多少「字」
        approxChars: systemTokens * 3 + messageTokens * 3,
    };
}
