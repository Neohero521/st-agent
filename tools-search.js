import { searchSessions, matchEvents, readEvent, SEARCH_LIMITS } from './index-search.js';

/**
 * 会话历史三件套（对标 DSH 的 session_search / session_event_search / session_event_read）
 * 全是 read：只读历史，不碰任何存储。
 */

export const TOOLS = [
    {
        name: 'session.search',
        kind: 'read',
        desc: '跨会话搜原文（默认**排除当前会话**，DSH 同款）：返回会话标题 + 命中数 + 最佳那条的摘录。'
            + '换一段"上次那张卡的 MVU 结构写在哪个条目里""我之前用的是哪套状态栏模板"这种 recollection 时先搜这个，别靠猜。'
            + 'query 用一句原话片段（名字、uid、条目名），别塞一整段任务描述；结果无游标、不 paginate，'
            + `命中超过 ${SEARCH_LIMITS.MAX_SESSION_HITS} 个会话会被截断并提示你缩窄，缩小重搜比翻页快。`,
        params: {
            query: 'string 要搜的原文片段（中文照抄、英文原词，大小写不敏感）',
            include_current: 'boolean 可选，默认 false（不含当前会话）；要搜自己就传 true',
        },
        run: async a => ({ ok: true, ...searchSessions(a) }),
    },
    {
        name: 'session.match',
        kind: 'read',
        desc: '在一个会话里搜原文，给出每条命中的 idx 与摘录。适合"这份历史里到底哪几条提到过 TestBook"。'
            + `最多 ${SEARCH_LIMITS.MAX_EVENT_HITS} 条；要全文就用 session.read 打开对应 idx。`,
        params: {
            session: 'string 可选，会话 id，或 current（默认）',
            query: 'string 原文片段',
        },
        run: async a => ({ ok: true, ...matchEvents(a) }),
    },
    {
        name: 'session.read',
        kind: 'read',
        desc: '读某条消息的完整正文（截 6000 字）+ 可选前后各两条摘要。session.match 给了 idx，就用这个打开看全。',
        params: {
            session: 'string 可选，会话 id，或 current（默认）',
            idx: 'number 消息下标（从 0 开始，session.match 会给）',
            neighbors: 'boolean 可选，默认 true：带前后摘要',
        },
        run: async a => ({ ok: true, ...readEvent(a) }),
    },
];
