import { apiGet, bridge } from './tools-lib.js';

/* ============================== 可选：桥接能力 ============================== */
export const BRIDGE_TOOLS = [
    {
        name: 'fs.info',
        kind: 'read',
        desc: '获取酒馆根目录、用户数据目录与允许访问的根。',
        params: {},
        run: async () => (await apiGet('/api/plugins/st-agent-bridge/info')).data,
    },
    {
        name: 'fs.list',
        kind: 'read',
        desc: '列出目录（可任意层级）。',
        params: { path: 'string 目录，默认 "."', depth: 'number 1-5' },
        run: async a => bridge('/fs/list', { path: a.path ?? '.', depth: a.depth ?? 1 }),
    },
    {
        name: 'fs.read',
        kind: 'read',
        desc: '读取文本文件（带行号，支持分页）。',
        params: { path: 'string', offset: 'number', limit: 'number' },
        run: async a => bridge('/fs/read', { path: a.path, offset: a.offset ?? 0, limit: a.limit ?? 1200 }),
    },
    {
        name: 'fs.write',
        kind: 'write',
        desc: '写入/覆盖文件（自动备份）。',
        params: { path: 'string', content: 'string' },
        run: async a => bridge('/fs/write', { path: a.path, content: a.content ?? '' }),
    },
    {
        name: 'fs.edit',
        kind: 'write',
        desc: '精确替换（先 read 确认原文）。',
        params: { path: 'string', oldText: 'string', newText: 'string', replaceAll: 'boolean' },
        run: async a => bridge('/fs/edit', { path: a.path, oldText: a.oldText, newText: a.newText ?? '', replaceAll: !!a.replaceAll }),
    },
    {
        name: 'fs.copy',
        kind: 'write',
        desc: '复制文件 / 目录（备份用）。',
        params: { from: 'string', to: 'string' },
        run: async a => bridge('/fs/copy', { from: a.from, to: a.to }),
    },
    {
        name: 'fs.glob',
        kind: 'read',
        desc: 'glob 查找文件（支持 ** / * / ?）。',
        params: { pattern: 'string', cwd: 'string', limit: 'number' },
        run: async a => bridge('/fs/glob', { pattern: a.pattern, cwd: a.cwd, limit: a.limit ?? 300 }),
    },
    {
        name: 'fs.grep',
        kind: 'read',
        desc: '正则搜索文件内容。',
        params: { pattern: 'string', path: 'string', glob: 'string', limit: 'number' },
        run: async a => bridge('/fs/grep', { pattern: a.pattern, path: a.path, glob: a.glob, limit: a.limit ?? 200 }),
    },
    {
        name: 'exec',
        kind: 'exec',
        desc: '在酒馆主机执行 shell（git / npm / 脚本）。',
        params: { command: 'string', cwd: 'string' },
        run: async a => bridge('/exec', { command: a.command, cwd: a.cwd }),
    },
];
