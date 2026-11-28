/**
 * 带超时的 fetch 封装。
 *
 * 为什么必须有：`/api/extensions/install` 在后端执行 `git clone`，
 * 中国大陆主机访问 GitHub 经常挂 2~10 分钟甚至一直 pending；浏览器 fetch 默认**没有超时**，
 * 于是工具调用永不返回 → Agent 那一步永远不结束 → 面板一直「执行中」，用户看到的就是「卡死」。
 * 所有走 /api/* 的写入都要经过这里，宁可超时报错让人看见，也不要静默挂死。
 */
export const NET_TIMEOUT_MS = 25000;
export const INSTALL_TIMEOUT_MS = 90000;

export class NetTimeoutError extends Error {
    constructor(path, ms) {
        super(`请求超时（${Math.round(ms / 1000)}s）：${path} —— 后端没有返回。常见原因：主机在跑 git clone（外网不通）、目录锁死或进程卡住。不要原样重试同一个请求，先把情况告诉用户。`);
        this.name = 'NetTimeoutError';
        this.path = path;
        this.timeoutMs = ms;
    }
}

export async function fetchWithTimeout(url, options = {}, ms = NET_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } catch (err) {
        if (err && (err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('abort'))) {
            throw new NetTimeoutError(url, ms);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
