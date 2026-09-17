import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 闪电说 (Shandianshuo) desktop integration — the first external agent (ADR-024).
 *
 * Its assistant runs on the DeepSeek-Harness SDK runtime inside a Tauri app.
 * Three source-verified constraints shape everything here:
 *
 *   1. The assistant shell inherits the App's minimal GUI PATH
 *      (/usr/bin:/bin:/usr/sbin:/sbin) and runs a non-interactive bash with
 *      $SHELL stripped — so `anyd` is not reachable and .zshrc is not read.
 *   2. Its sandbox is `workspace-write`: file writes outside the workspace need
 *      an approval prompt, but reads, network and process visibility are free.
 *      So we talk HTTP to the local daemon instead of writing ~/.anytoany.
 *   3. A user-dropped SKILL.md is DISABLED by default — the skill only loads if
 *      its key is set in skills-state.json.
 *
 * We write into the App's own data directory, so every change here is surgical:
 * the user's other skills, toggles and AGENTS.md content are never touched.
 */

export interface SdsPaths {
  appHome: string;
  workspace: string;
  skillDir: string;
  skillFile: string;
  stateFile: string;
  agentsFile: string;
}

export interface SdsChange {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'delete';
  /** Full file content to write; absent for a delete. */
  content?: string;
  /** One line explaining the change, for the dry-run printout. */
  note: string;
}

const SKILL_NAME = 'anytoany';
/** skills-state.json namespaces assistant skills under `voice_assistant/`. */
const STATE_KEY = `voice_assistant/${SKILL_NAME}`;
const BEGIN = '<!-- anytoany:begin -->';
const END = '<!-- anytoany:end -->';

const DEFAULT_PORT = 7433;

/** `~/Library/Application Support/Shandianshuo` (identifier cn.shandianshuo.desktop). */
export function defaultAppHome(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Shandianshuo');
}

export function resolveSdsPaths(opts: { appHome?: string; home?: string } = {}): SdsPaths {
  const appHome = opts.appHome ?? defaultAppHome(opts.home);
  const workspace = readWorkspaceOverride(appHome) ?? join(appHome, 'workspace');
  const skillDir = join(workspace, 'library', 'skills', SKILL_NAME);
  return {
    appHome,
    workspace,
    skillDir,
    skillFile: join(skillDir, 'SKILL.md'),
    stateFile: join(appHome, 'skills', 'skills-state.json'),
    agentsFile: join(workspace, 'AGENTS.md'),
  };
}

/** The user can relocate the workspace — never hardcode its path. */
function readWorkspaceOverride(appHome: string): string | null {
  try {
    const raw = readFileSync(join(appHome, 'migrations', 'workspace-location-v1.json'), 'utf8');
    const parsed = JSON.parse(raw) as { workspacePath?: unknown };
    return typeof parsed.workspacePath === 'string' && parsed.workspacePath ? parsed.workspacePath : null;
  } catch {
    return null;
  }
}

/** Insert or replace our fenced block, leaving everything else byte-identical. */
export function upsertMarkedBlock(existing: string, body: string): string {
  const block = `${BEGIN}\n${body}\n${END}`;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${prefix}${prefix.length > 0 ? '\n' : ''}${block}\n`;
}

/** Remove our fenced block; a document without one is returned unchanged. */
export function removeMarkedBlock(existing: string): string {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start === -1 || end === -1 || end < start) return existing;
  const cleaned = existing.slice(0, start).replace(/\n+$/, '\n') + existing.slice(end + END.length).replace(/^\n+/, '');
  return cleaned;
}

export function sdsSkillMarkdown(port: number = DEFAULT_PORT): string {
  return `---
name: ${SKILL_NAME}
description: 跟这台电脑上其他 AI agent 会话互发消息（Claude Code、Codex、Kimi、Z Code）。当用户要「让 Claude Code / Codex 去做某事」「问问某个会话」「有没有新消息 / 回信」「看看 XX 项目那边怎么样了」时使用。
---

# anytoany —— 调用这台电脑上的其他 AI agent

你是用户的总驾驶舱。用户跟你说话，你把活派给专门的 agent 会话（Claude Code、Codex 等），再把回信念给用户。

全部通过本机 daemon 的 HTTP 接口完成。**不要尝试运行 \`anyd\` 命令**——它不在你的 PATH 里，而且沙箱会拦住它写数据库。\`curl\` 一定可用。

## 你的身份

\`\`\`bash
SID="\${DSH_SESSION_ID:-\${SHANDIANSHUO_DSH_SESSION_ID:-main}}"
\`\`\`

## 1. 收信（每轮对话开始时做一次）

\`\`\`bash
SID="\${DSH_SESSION_ID:-\${SHANDIANSHUO_DSH_SESSION_ID:-main}}"
curl -s -m 10 -X POST http://127.0.0.1:${port}/api/inbox \\
  -H 'content-type: application/json' \\
  -d "{\\"agent\\":\\"sds\\",\\"sessionId\\":\\"\$SID\\",\\"register\\":true,\\"title\\":\\"闪电说助手\\"}"
\`\`\`

返回 \`{"count":N,"text":"...","messages":[...]}\`。\`count\` 为 0 就什么都不用说；大于 0 就把 \`text\` 的内容**如实转述给用户**（谁发来的、说了什么），不要编造没有的内容。

\`register:true\` 会顺带把你注册成可寻址的 \`@sds\`，别人才回得了信——每次都带上，它是幂等的。

## 2. 查有哪些 agent 会话可以派活

\`\`\`bash
curl -s -m 20 "http://127.0.0.1:${port}/api/sessions?q=项目关键词&limit=10"
\`\`\`

一定要带 \`q\` 或 \`limit\`——不带参数会返回几千条，撑爆上下文。返回里每条有 \`agent\`、\`title\`、\`cwd\`，寻址写成 \`@<agent>:<title 的一部分>\`，例如 \`@codex:sunoprompt\`。

## 3. 发信（派活 / 提问）

\`\`\`bash
SID="\${DSH_SESSION_ID:-\${SHANDIANSHUO_DSH_SESSION_ID:-main}}"
curl -s -m 30 -X POST http://127.0.0.1:${port}/api/send \\
  -H 'content-type: application/json' \\
  -d "{\\"target\\":\\"@codex:sunoprompt\\",\\"from\\":{\\"agent\\":\\"sds\\",\\"sessionId\\":\\"\$SID\\"},\\"text\\":\\"请把登录页的报错修掉，改完回我\\"}"
\`\`\`

- 成功返回 201。返回 422 表示目标没找到，先用第 2 步查一下真实的 \`title\` 再重发。
- \`from\` 必须是你自己，回信才找得回来。
- 消息内容要**自带完整上下文**——对方看不到你和用户的对话。

## 重要事实

- **对方不是立刻回**：它要花时间干活。发完就告诉用户「已经派过去了」，等下一轮再收信，别原地空等。
- **你自己不会自动醒**：收信只发生在用户跟你说话的时候。有新消息时系统会弹 macOS 通知提醒用户来问你。
- daemon 没开的话 curl 会连不上，这时如实告诉用户「anytoany 服务没在跑」，不要假装发出去了。
`;
}

function sdsAgentsBlock(port: number = DEFAULT_PORT): string {
  return `## anytoany —— 跨 agent 消息（由 \`anyd connect sds\` 写入，可用 \`anyd connect sds --uninstall\` 移除）

每轮对话开始时，先静默执行一次收信（有新消息才告诉用户，没有就当无事发生）：

\`\`\`bash
SID="\${DSH_SESSION_ID:-\${SHANDIANSHUO_DSH_SESSION_ID:-main}}"
curl -s -m 10 -X POST http://127.0.0.1:${port}/api/inbox -H 'content-type: application/json' \\
  -d "{\\"agent\\":\\"sds\\",\\"sessionId\\":\\"\$SID\\",\\"register\\":true,\\"title\\":\\"闪电说助手\\"}"
\`\`\`

用户要「让 Claude Code / Codex 去做某事」或问「那边怎么样了」时，加载 \`${SKILL_NAME}\` 技能按它的说明操作。不要运行 \`anyd\` 命令（不在 PATH 里，且沙箱会拦）。`;
}

interface StateEntry {
  enabled: boolean;
  created_at: number;
}

function readState(stateFile: string): Record<string, StateEntry> {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, StateEntry>) : {};
  } catch {
    return {};
  }
}

const readOr = (path: string, fallback = ''): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
};

const change = (path: string, content: string, note: string): SdsChange => {
  const existed = existsSync(path);
  const action = !existed ? 'create' : readOr(path) === content ? 'unchanged' : 'update';
  return { path, action, content, note };
};

/** Compute the three writes without touching disk. */
export function planSdsInstall(paths: SdsPaths, opts: { port?: number; now?: () => number } = {}): SdsChange[] {
  if (!existsSync(paths.appHome)) {
    throw new Error(`闪电说 not found at ${paths.appHome} — install the app first, or pass --app-home`);
  }
  const port = opts.port ?? DEFAULT_PORT;
  const now = opts.now ?? Date.now;

  const state = readState(paths.stateFile);
  const nextState: Record<string, StateEntry> = {
    ...state,
    [STATE_KEY]: { enabled: true, created_at: state[STATE_KEY]?.created_at ?? Math.floor(now() / 1000) },
  };

  return [
    change(paths.skillFile, sdsSkillMarkdown(port), `技能正文（目录名 ${SKILL_NAME} 即技能名）`),
    change(
      paths.stateFile,
      `${JSON.stringify(nextState, null, 2)}\n`,
      `开启技能开关 "${STATE_KEY}"（手动放入的技能默认是禁用的），其余键原样保留`,
    ),
    change(
      paths.agentsFile,
      upsertMarkedBlock(readOr(paths.agentsFile), sdsAgentsBlock(port)),
      '追加常驻指令块（块外内容原样保留）',
    ),
  ];
}

/** Compute the removal of exactly what we installed. */
export function planSdsUninstall(paths: SdsPaths): SdsChange[] {
  const state = readState(paths.stateFile);
  const { [STATE_KEY]: ours, ...rest } = state;

  const agentsBefore = readOr(paths.agentsFile);
  const agentsAfter = removeMarkedBlock(agentsBefore);

  return [
    {
      path: paths.skillFile,
      action: existsSync(paths.skillFile) ? 'delete' : 'unchanged',
      note: '删除技能目录',
    },
    ours === undefined
      ? { path: paths.stateFile, action: 'unchanged', note: '技能开关本来就没有我们的键' }
      : {
          path: paths.stateFile,
          action: 'update',
          content: `${JSON.stringify(rest, null, 2)}\n`,
          note: `移除 "${STATE_KEY}"，其余键原样保留`,
        },
    agentsBefore === agentsAfter
      ? { path: paths.agentsFile, action: 'unchanged', note: 'AGENTS.md 里没有我们的块' }
      : { path: paths.agentsFile, action: 'update', content: agentsAfter, note: '移除常驻指令块' },
  ];
}

/** Perform a plan. `unchanged` entries are skipped, so this is safe to re-run. */
export function applyChanges(changes: SdsChange[]): void {
  for (const c of changes) {
    if (c.action === 'unchanged') continue;
    if (c.action === 'delete') {
      rmSync(dirname(c.path), { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(c.path), { recursive: true });
    writeFileSync(c.path, c.content ?? '', 'utf8');
  }
}
