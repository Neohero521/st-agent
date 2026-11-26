/**
 * ST Agent Bridge - server plugin
 * 挂载路由：/api/plugins/st-agent-bridge/*
 */
const tools = require('./tools.js');

const info = {
    id: 'st-agent-bridge',
    name: 'ST Agent Bridge',
    description: '为 SillyTavern 内 Agent 扩展提供文件系统、命令执行与数据目录读写能力。',
};

/**
 * 统一响应封装
 */
function handle(fn) {
    return async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const data = await fn(body, req);
            res.json({ ok: true, data });
        } catch (error) {
            res.status(400).json({ ok: false, error: error.message || String(error) });
        }
    };
}

async function init(router) {
    tools.loadConfig();
    console.log('[st-agent-bridge] loaded. ST root:', tools.ST_ROOT);

    router.get('/ping', (req, res) => {
        res.json({ ok: true, data: { pong: true, version: '1.0.0', stRoot: tools.ST_ROOT } });
    });

    router.get('/info', (req, res) => {
        res.json({ ok: true, data: tools.info(req.user?.directories) });
    });

    router.get('/roots', (req, res) => {
        res.json({ ok: true, data: { roots: tools.info(req.user?.directories).roots } });
    });

    // 文件系统
    router.post('/fs/list', handle(b => tools.ls(b.path, b.depth)));
    router.post('/fs/stat', handle(b => tools.statOf(b.path)));
    router.post('/fs/read', handle(b => tools.readText(b.path, b.offset, b.limit)));
    router.post('/fs/write', handle(b => tools.writeText(b.path, b.content, { createBackup: b.createBackup })));
    router.post('/fs/append', handle(b => tools.appendText(b.path, b.content)));
    router.post('/fs/edit', handle(b => tools.editText(b.path, b.oldText, b.newText, b.replaceAll)));
    router.post('/fs/mkdir', handle(b => tools.mkdir(b.path)));
    router.post('/fs/move', handle(b => tools.move(b.from, b.to)));
    router.post('/fs/copy', handle(b => tools.copy(b.from, b.to)));
    router.post('/fs/delete', handle(b => tools.remove(b.path, b.confirm, b.recursive)));
    router.post('/fs/glob', handle(b => tools.globFiles(b.pattern, b.cwd, b.limit)));
    router.post('/fs/grep', handle(b => tools.grepFiles(b.pattern, b.path, b)));

    // 命令执行
    router.post('/exec', handle(b => tools.runExec(b.command, b.cwd, b.timeoutMs)));

    // 审计
    router.post('/audit/read', handle(async b => {
        const fs = require('node:fs');
        const path = require('node:path');
        const file = path.join(tools.AGENT_HOME, 'audit.jsonl');
        if (!fs.existsSync(file)) return { lines: [] };
        const raw = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        const limit = Math.min(Number(b.limit) || 100, 1000);
        return { lines: raw.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
    }));
}

async function exit() {
    console.log('[st-agent-bridge] exited.');
}

module.exports = { info, init, exit };
