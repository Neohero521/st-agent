/**
 * ST Agent Bridge - 服务端能力层
 * 给 SillyTavern 内的 Agent 扩展提供真正的文件系统 / 进程 / 数据目录能力。
 * 纯 Node 实现，零第三方依赖。
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const PLUGIN_DIR = __dirname;
const ST_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const AGENT_HOME = path.join(ST_ROOT, 'data', '_agent');
const BACKUP_DIR = path.join(AGENT_HOME, 'backups');
const AUDIT_LOG = path.join(AGENT_HOME, 'audit.jsonl');

const DEFAULT_CONFIG = {
    allowExec: true,
    allowDelete: true,
    extraRoots: [],
    denyGlobs: ['**/.env', '**/secrets.json', '**/*.secret', '**/.git/config'],
    maxReadBytes: 2097152,
    maxWriteBytes: 10485760,
    backup: true,
    audit: true,
    execTimeoutMs: 120000,
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv'],
};

let config = null;

function loadConfig() {
    let fileConfig = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('[st-agent-bridge] config.json 解析失败，使用默认配置:', e.message);
    }
    config = { ...DEFAULT_CONFIG, ...fileConfig };
    return config;
}

function getConfig() {
    return config || loadConfig();
}

function getRoots() {
    const cfg = getConfig();
    const roots = [ST_ROOT, path.join(ST_ROOT, 'data'), ...(Array.isArray(cfg.extraRoots) ? cfg.extraRoots : [])];
    return roots.map(r => path.resolve(String(r))).filter((r, i, arr) => arr.indexOf(r) === i);
}

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 解析并校验路径。相对路径以 ST 根目录为基准。
 * @param {string} input 用户给出的路径
 * @param {object} [opts]
 */
function resolvePath(input, opts = {}) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('缺少 path 参数');
    }
    let raw = input.trim();
    if (raw === '~' || raw.startsWith('~/')) {
        raw = path.join(os.homedir(), raw.slice(1));
    }
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ST_ROOT, raw);
    const roots = getRoots();
    const inRoot = roots.some(root => isInside(root, abs));
    if (!inRoot) {
        throw new Error(`路径越界：${abs} 不在允许的范围内。允许的根目录：${roots.join(', ')}`);
    }
    if (opts.mustExist !== false && !fs.existsSync(abs)) {
        throw new Error(`路径不存在：${abs}`);
    }
    return abs;
}

function denyCheck(absPath) {
    const cfg = getConfig();
    const rel = toPosix(path.relative(ST_ROOT, absPath));
    for (const pat of cfg.denyGlobs || []) {
        if (globToRegExp(pat).test(rel) || globToRegExp(pat).test(path.basename(absPath))) {
            throw new Error(`该路径受保护，禁止访问：${absPath}`);
        }
    }
    return true;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function audit(entry) {
    if (!getConfig().audit) return;
    try {
        ensureDir(AGENT_HOME);
        fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
        // 审计日志过大时截断
        const stat = fs.statSync(AUDIT_LOG);
        if (stat.size > 5 * 1024 * 1024) {
            fs.writeFileSync(AUDIT_LOG, '', 'utf8');
            fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), op: 'audit-rotate' }) + '\n', 'utf8');
        }
    } catch (e) {
        console.warn('[st-agent-bridge] 审计写入失败:', e.message);
    }
}

function backupFile(absPath) {
    if (!getConfig().backup) return null;
    try {
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const rel = path.relative(ST_ROOT, absPath) || path.basename(absPath);
        const dest = path.join(BACKUP_DIR, ts, rel);
        ensureDir(path.dirname(dest));
        fs.copyFileSync(absPath, dest);
        return dest;
    } catch (e) {
        console.warn('[st-agent-bridge] 备份失败:', e.message);
        return null;
    }
}

/* ----------------------------- glob / grep ----------------------------- */

function globToRegExp(glob) {
    let re = '';
    const g = toPosix(glob);
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                i++;
                if (g[i + 1] === '/') i++;
                re += '(?:.*/)?';
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            const end = g.indexOf('}', i);
            if (end === -1) { re += '\\{'; continue; }
            const parts = g.slice(i + 1, end).split(',').map(p => escRe(p));
            re += '(' + parts.join('|') + ')';
            i = end;
        } else if (c === '[') {
            const end = g.indexOf(']', i);
            if (end === -1) { re += '\\['; continue; }
            re += '[' + g.slice(i + 1, end) + ']';
            i = end;
        } else {
            re += escRe(c);
        }
    }
    return new RegExp('^' + re + '$');
}

function escRe(char) {
    return /[.*+?^${}()|[\]\\/]/.test(char) ? '\\' + char : char;
}

function walkFiles(baseDir, { maxFiles = 5000, followSymlinks = false } = {}) {
    const cfg = getConfig();
    const out = [];
    const stack = [baseDir];
    while (stack.length && out.length < maxFiles) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (cfg.ignoreDirs?.includes(ent.name)) continue;
            const full = path.join(dir, ent.name);
            // 备份快照不参与检索，避免噪音与膨胀
            if (full.includes(path.join('_agent', 'backups'))) continue;
            if (ent.isSymbolicLink() && !followSymlinks) continue;
            if (ent.isDirectory()) {
                stack.push(full);
            } else if (ent.isFile()) {
                try {
                    if (fs.statSync(full).size <= 4 * 1024 * 1024) out.push(full);
                } catch { /* ignore */ }
            }
        }
    }
    return out;
}

/**
 * 支持 {a,b} / ** / ? 的简易 glob
 */
async function globFiles(pattern, cwd, limit = 300) {
    const base = cwd ? resolvePath(cwd) : ST_ROOT;
    const isAbs = path.isAbsolute(pattern);
    const re = globToRegExp(isAbs ? pattern : toPosix(pattern));
    const files = walkFiles(base);
    const hits = [];
    for (const file of files) {
        const rel = isAbs ? toPosix(file) : toPosix(path.relative(base, file));
        if (re.test(rel) || re.test(toPosix(path.relative(ST_ROOT, file)))) {
            hits.push({ path: file, rel, size: fs.statSync(file).size });
            if (hits.length >= limit) break;
        }
    }
    return { base, pattern, count: hits.length, truncated: hits.length >= limit, files: hits };
}

/**
 * 在目录/文件中用正则搜索
 */
async function grepFiles(pattern, targetPath, opts = {}) {
    const base = targetPath ? resolvePath(targetPath) : ST_ROOT;
    const limit = Number(opts.limit) || 200;
    const contextLines = Number(opts.contextLines) || 0;
    const fileGlob = opts.glob ? globToRegExp(opts.glob) : null;
    let re;
    try {
        re = new RegExp(pattern, opts.ignoreCase ? 'i' : '');
    } catch (e) {
        throw new Error('正则表达式无效：' + e.message);
    }

    const stat = fs.statSync(base);
    const files = stat.isFile() ? [base] : walkFiles(base);
    const hits = [];
    for (const file of files) {
        const rel = toPosix(path.relative(base, file));
        if (fileGlob && !fileGlob.test(rel) && !fileGlob.test(toPosix(path.basename(file)))) continue;
        let content;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch { continue; }
        if (content.includes('\u0000')) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            const ctx = contextLines > 0
                ? lines.slice(Math.max(0, i - contextLines), Math.min(lines.length, i + contextLines + 1)).join('\n')
                : lines[i];
            hits.push({ file, rel, line: i + 1, text: ctx });
            if (hits.length >= limit) return { count: hits.length, truncated: true, hits };
        }
    }
    return { count: hits.length, truncated: false, hits };
}

/* ----------------------------- 文件操作 ----------------------------- */

function ls(targetPath, depth = 1) {
    const abs = resolvePath(targetPath || '.');
    const maxDepth = Math.min(Math.max(Number(depth) || 1, 1), 5);
    const entries = [];
    const visit = (dir, level) => {
        if (level > maxDepth) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            let size = 0;
            try { size = ent.isFile() ? fs.statSync(full).size : 0; } catch { }
            entries.push({
                name: ent.name,
                path: full,
                rel: toPosix(path.relative(ST_ROOT, full)),
                type: ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : 'file',
                size,
            });
            if (ent.isDirectory() && level < maxDepth) visit(full, level + 1);
            if (entries.length >= 800) return;
        }
    };
    visit(abs, 1);
    return { path: abs, entries, truncated: entries.length >= 800 };
}

function statOf(p) {
    const abs = resolvePath(p);
    const st = fs.statSync(abs);
    return {
        path: abs,
        rel: toPosix(path.relative(ST_ROOT, abs)),
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
    };
}

function readText(p, offset, limit) {
    const abs = resolvePath(p);
    denyCheck(abs);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error('目标是一个目录，请用 fs.list');
    const maxBytes = getConfig().maxReadBytes;
    if (st.size > maxBytes) throw new Error(`文件过大（${st.size} 字节），超过读取上限 ${maxBytes}`);
    // 二进制检测（PNG 角色卡、图片等）
    const probe = Buffer.alloc(Math.min(st.size, 1024));
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, probe, 0, probe.length, 0); } finally { fs.closeSync(fd); }
    if (probe.includes(0)) {
        const ext = path.extname(abs).toLowerCase();
        throw new Error(`这是二进制文件（${ext || '未知类型'}，${st.size} 字节），不能用 fs.read 读取。角色卡 PNG 请改用 st.* 工具，或先用 fs.copy 备份。`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, Number(offset) || 0);
    const count = Math.min(Number(limit) || 1200, 4000);
    const slice = lines.slice(start, start + count);
    return {
        path: abs,
        totalLines: lines.length,
        startLine: start + 1,
        endLine: start + slice.length,
        truncated: start + slice.length < lines.length,
        content: slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n'),
    };
}

function writeText(p, content, opts = {}) {
    const abs = resolvePath(p, { mustExist: false });
    denyCheck(abs);
    const cfg = getConfig();
    const body = String(content ?? '');
    if (body.length > cfg.maxWriteBytes) throw new Error(`内容过大（${body.length} 字符）`);
    const existed = fs.existsSync(abs);
    if (existed && fs.statSync(abs).isDirectory()) throw new Error('目标是一个目录');
    if (existed && opts.createBackup !== false) backupFile(abs);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, body, 'utf8');
    audit({ op: 'write', path: abs, bytes: body.length, existed });
    return { path: abs, bytes: body.length, created: !existed, updated: existed };
}

function appendText(p, content) {
    const abs = resolvePath(p, { mustExist: false });
    denyCheck(abs);
    const existed = fs.existsSync(abs);
    if (existed) backupFile(abs);
    ensureDir(path.dirname(abs));
    fs.appendFileSync(abs, String(content ?? ''), 'utf8');
    audit({ op: 'append', path: abs, bytes: String(content ?? '').length });
    return { path: abs, appended: String(content ?? '').length };
}

function editText(p, oldText, newText, replaceAll = false) {
    const abs = resolvePath(p);
    denyCheck(abs);
    const raw = fs.readFileSync(abs, 'utf8');
    if (!oldText) throw new Error('oldText 不能为空');
    const count = raw.split(oldText).length - 1;
    if (count === 0) throw new Error('未找到要替换的文本（注意缩进与换行必须完全一致）');
    if (count > 1 && !replaceAll) throw new Error(`该文本出现 ${count} 次，请提供更多上下文，或设置 replaceAll=true`);
    backupFile(abs);
    const next = replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText);
    fs.writeFileSync(abs, next, 'utf8');
    audit({ op: 'edit', path: abs, occurrences: count, replaceAll: !!replaceAll });
    return { path: abs, occurrences: count, bytes: next.length };
}

function mkdir(p) {
    const abs = resolvePath(p, { mustExist: false });
    ensureDir(abs);
    audit({ op: 'mkdir', path: abs });
    return { path: abs, ok: true };
}

function copy(from, to) {
    const src = resolvePath(from);
    const dst = resolvePath(to, { mustExist: false });
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        ensureDir(dst);
        fs.cpSync(src, dst, { recursive: true });
    } else {
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
    }
    audit({ op: 'copy', from: src, to: dst });
    return { from: src, to: dst, bytes: st.isFile() ? st.size : null, ok: true };
}

function move(from, to) {    const src = resolvePath(from);
    const dst = resolvePath(to, { mustExist: false });
    ensureDir(path.dirname(dst));
    if (fs.existsSync(dst)) backupFile(dst);
    fs.renameSync(src, dst);
    audit({ op: 'move', from: src, to: dst });
    return { from: src, to: dst, ok: true };
}

function remove(p, confirm, recursive) {
    const cfg = getConfig();
    if (!cfg.allowDelete) throw new Error('服务端配置已禁用删除操作（config.json: allowDelete=false）');
    if (confirm !== true) throw new Error('删除是高危操作，必须传 confirm: true');
    const abs = resolvePath(p);
    const roots = getRoots();
    if (roots.some(r => r === abs)) throw new Error('不能删除允许范围内的根目录');
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
        if (!recursive) throw new Error('目标是非空目录，需要 recursive: true');
        fs.rmSync(abs, { recursive: true, force: true });
    } else {
        backupFile(abs);
        fs.rmSync(abs, { force: true });
    }
    audit({ op: 'delete', path: abs, recursive: !!recursive });
    return { path: abs, ok: true };
}

function runExec(command, cwd, timeoutMs) {
    const cfg = getConfig();
    if (!cfg.allowExec) throw new Error('服务端配置已禁用命令执行（config.json: allowExec=false）');
    const workdir = cwd ? resolvePath(cwd) : ST_ROOT;
    const timeout = Math.min(Number(timeoutMs) || cfg.execTimeoutMs, 600000);
    return new Promise(resolve => {
        exec(String(command), { cwd: workdir, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            audit({ op: 'exec', cwd: workdir, command: String(command).slice(0, 500), exit: err ? (err.code ?? 1) : 0 });
            resolve({
                cwd: workdir,
                command: String(command),
                exitCode: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
                stdout: String(stdout || '').slice(0, 200000),
                stderr: String(stderr || '').slice(0, 100000),
                timedOut: !!(err && err.killed),
            });
        });
    });
}

/* ----------------------------- 信息 ----------------------------- */

function info(userDirectories) {
    const dirs = userDirectories || {};
    let defaultUserRoot = null;
    try {
        const dataDir = path.join(ST_ROOT, 'data');
        const candidates = fs.readdirSync(dataDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
            .map(e => e.name);
        if (candidates.length) defaultUserRoot = path.join(dataDir, candidates[0]);
    } catch { /* ignore */ }

    return {
        stRoot: ST_ROOT,
        dataRoot: path.join(ST_ROOT, 'data'),
        userRoot: absify(dirs.root || defaultUserRoot),
        agentHome: AGENT_HOME,
        roots: getRoots(),
        platform: process.platform,
        node: process.version,
        config: getConfig(),
        stDirs: {
            characters: absify(dirs.characters || (defaultUserRoot ? path.join(defaultUserRoot, 'characters') : null)),
            worlds: absify(dirs.worlds || (defaultUserRoot ? path.join(defaultUserRoot, 'worlds') : null)),
            chats: absify(dirs.chats || (defaultUserRoot ? path.join(defaultUserRoot, 'chats') : null)),
            groups: absify(dirs.groups || (defaultUserRoot ? path.join(defaultUserRoot, 'groups') : null)),
            groupChats: absify(dirs.groupChats || (defaultUserRoot ? path.join(defaultUserRoot, 'group chats') : null)),
            presets: absify(dirs.openAI_Settings || (defaultUserRoot ? path.join(defaultUserRoot, 'OpenAI Settings') : null)),
            settings: absify(dirs.settings || (defaultUserRoot ? path.join(defaultUserRoot, 'settings.json') : null)),
            themes: absify(dirs.themes || (defaultUserRoot ? path.join(defaultUserRoot, 'themes') : null)),
            extensions: absify(dirs.extensions || path.join(ST_ROOT, 'public', 'scripts', 'extensions')),
            backups: absify(dirs.backups || (defaultUserRoot ? path.join(defaultUserRoot, 'backups') : null)),
            vectors: absify(dirs.vectors || (defaultUserRoot ? path.join(defaultUserRoot, 'vectors') : null)),
        },
    };
}

function absify(p) {
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(ST_ROOT, p);
}

module.exports = {
    ST_ROOT,
    AGENT_HOME,
    getConfig,
    loadConfig,
    resolvePath,
    info,
    ls,
    statOf,
    readText,
    writeText,
    appendText,
    editText,
    mkdir,
    move,
    copy,
    remove,
    globFiles,
    grepFiles,
    runExec,
    audit,
    globToRegExp,
};
