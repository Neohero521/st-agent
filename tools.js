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
 * 曾经的写法是在顶层 `for (...) { await import('./adv-tools-vN.js') }` 探针式挂载，
 * 这在本插件里是个致命写法：adv-tools-vN 与 adv-tools/adv-lib/tools-lib 之间存在交叉引用，
 * 而这些交叉引用又绕回 tools.js 所在的依赖环。模块图里只要存在「环 + 顶层 await」，
 * ESM 就永远等不到 resolve —— 整个插件一个模块都不会执行，页面表现就是
 * 「扩展列表里有 ST Agent，但悬浮球、面板、设置卡片全都不出现，控制台也没报错」。
 * 所以这里改成静态导入 + 别名（TOOLS 同名，用 as 区分），编译期就把依赖图拉直。
 */
import { ADV_TOOLS } from './adv-tools.js';
import { TOOLS as TOOLS_V14 } from './adv-tools-v14.js';
import { TOOLS as TOOLS_V15 } from './adv-tools-v15.js';
import { TOOLS as TOOLS_V16 } from './adv-tools-v16.js';
import { TOOLS as TOOLS_V17 } from './adv-tools-v17.js';
import { TOOLS as TOOLS_V18 } from './adv-tools-v18.js';
import { TOOLS as TOOLS_V19 } from './adv-tools-v19.js';
import { TOOLS as TOOLS_V20 } from './adv-tools-v20.js';
import { TOOLS as TOOLS_V21 } from './adv-tools-v21.js';
import { TOOLS as TOOLS_V22 } from './adv-tools-v22.js';
import { TOOLS as TOOLS_KIT } from './tools-kit.js';

for (const group of [TOOLS_V14, TOOLS_V15, TOOLS_V16, TOOLS_V17, TOOLS_V18, TOOLS_V19, TOOLS_V20, TOOLS_V21, TOOLS_V22, TOOLS_KIT]) {
    if (Array.isArray(group)) ADV_TOOLS.push(...group);
}
