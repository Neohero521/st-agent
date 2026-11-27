import { ADV_TOOLS_A } from './adv-tools-set-a.js';
import { ADV_TOOLS_B } from './adv-tools-set-b.js';
import { ADV_TOOLS_C } from './adv-tools-set-c.js';
import { helperInfo } from './adv-lib-ext.js';

export const ADV_TOOLS = [...ADV_TOOLS_A, ...ADV_TOOLS_B, ...ADV_TOOLS_C];

export function advToolByName(name) {
    return ADV_TOOLS.find(t => t.name === name) || null;
}

export function advToolsPrompt() {
    const th = helperInfo();
    const lines = ADV_TOOLS.map(t => `- ${t.name}（${t.kind}）：${t.desc}\n  参数：${Object.entries(t.params).map(([k, v]) => `${k} = ${v}`).join('；') || '无'}`);
    return [
        '',
        '## 进阶工具（变量 / 楼层 / 世界书条目 / 注入 / 正则 / 预设 / 脚本）',
        th.online ? `（检测到「酒馆助手」v${th.version}：script.* 可用）` : '（未安装「酒馆助手」：script.* 不可用，其余照常）',
        ...lines,
    ].join('\n');
}

export { helperInfo };
