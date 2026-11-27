import { ST_TOOLS_A } from './tools-set-a.js';
import { ST_TOOLS_B } from './tools-set-b.js';
import { ST_TOOLS_C } from './tools-set-c.js';
import { BRIDGE_TOOLS } from './tools-bridge.js';

export { BRIDGE_TOOLS };
export const ST_TOOLS = [...ST_TOOLS_A, ...ST_TOOLS_B, ...ST_TOOLS_C];


export function activeTools() {
    return window.__staBridgeOnline ? [...ST_TOOLS, ...BRIDGE_TOOLS] : ST_TOOLS;
}

export function toolByName(name) {
    return activeTools().find(t => t.name === name);
}

export function toolsPrompt() {
    return activeTools().map(t => {
        const params = Object.entries(t.params).map(([k, v]) => `    ${k}: ${v}`).join('\n');
        return `- ${t.name}${t.kind === 'dangerous' ? ' ⚠高危' : ''}\n  ${t.desc}\n${params ? '  参数:\n' + params : '  参数: 无'}`;
    }).join('\n\n');
}

/* ------------------------------ 可选工具模块（v1.4+） ------------------------------
 * 探针式加载：新工具模块按 adv-tools-vN 命名放进扩展目录即可自动挂载，
 * 不需要再改本文件、adv-tools.js 或 index.js。
 * 模块须导出 TOOLS 数组（元素结构与 ADV_TOOLS 相同）。
 */
import { ADV_TOOLS } from './adv-tools.js';

for (const mod of ['adv-tools-v14', 'adv-tools-v15', 'adv-tools-v16', 'adv-tools-v17', 'adv-tools-v18', 'adv-tools-v19', 'adv-tools-v20', 'adv-tools-v21']) {
    try {
        const m = await import(`./${mod}.js`);
        if (Array.isArray(m?.TOOLS)) ADV_TOOLS.push(...m.TOOLS);
    } catch { /* 模块不存在或加载失败：跳过 */ }
}
