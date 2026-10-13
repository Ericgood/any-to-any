import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realExec } from './adapters/exec.js';
import { defaultDbPath, createDb } from './mailbox/db.js';
/**
 * Can the Claude doorbell wake a running session (ADR-027)? Claude Code holds a
 * peer message for approval when the receiver bypasses permission prompts, and the
 * desktop App can't show that dialog — so the frame expires. The pull hook still
 * delivers on the next prompt; `accept` is what makes delivery immediate. Changing
 * it is the owner's call, so this only reports.
 */
export function crossSessionInboundCheck(settings) {
    const value = settings?.crossSessionInbound;
    if (value === 'refuse') {
        return {
            name: 'claude doorbell (crossSessionInbound)',
            ok: false,
            note: '"refuse" — running Claude sessions drop the doorbell; mail waits for the next prompt. Set it to "accept" in ~/.claude/settings.json to deliver immediately',
        };
    }
    if (value === 'accept') {
        return { name: 'claude doorbell (crossSessionInbound)', ok: true, note: '"accept" — running sessions wake on new mail' };
    }
    if (settings?.permissions?.defaultMode === 'bypassPermissions') {
        return {
            name: 'claude doorbell (crossSessionInbound)',
            ok: true,
            note: 'OFF — your sessions default to Bypass permissions, which hold peer messages, so the daemon does not ring; mail arrives on the next prompt as before. To have running sessions wake on new mail, set "crossSessionInbound": "accept" in ~/.claude/settings.json',
        };
    }
    return {
        name: 'claude doorbell (crossSessionInbound)',
        ok: true,
        note: 'unset — wakes sessions that prompt for permissions; a session in Bypass permissions holds the doorbell (mail then arrives on its next prompt). Set "crossSessionInbound": "accept" in ~/.claude/settings.json if you want those woken too',
    };
}
/**
 * ZCode's native mailbox (ADR-029). A flagged runtime creates `<root>/<sess>/unread`
 * on every turn, so those dirs are ZCode's own record that the doorbell works.
 */
export function zcodeMailboxCheck(root, zcodeInstalled) {
    if (!zcodeInstalled)
        return null;
    let seen = 0;
    try {
        seen = readdirSync(root).filter((d) => existsSync(join(root, d, 'unread'))).length;
    }
    catch {
        seen = 0; // no mailbox root yet
    }
    return {
        name: 'zcode doorbell (session mailbox)',
        ok: true,
        note: seen > 0
            ? `on — ${seen} session(s) have run with ZCode's mailbox; mail to a session mid-turn lands at its next tool call`
            : 'off — a ZCode session that is mid-turn gets a second, headless turn instead (the old behaviour). To turn it on: launchctl setenv ZCODE_MESSAGE_ENABLED 1, then quit and reopen ZCode (lasts until reboot)',
    };
}
async function which(cmd) {
    const { stdout, code } = await realExec('which', [cmd], { timeoutMs: 5000 });
    return code === 0 ? stdout.trim() : null;
}
export async function runDoctor() {
    const home = homedir();
    const checks = [];
    const claudeBin = await which('claude');
    checks.push({
        name: 'claude CLI',
        ok: claudeBin !== null,
        note: claudeBin ?? 'not found — claude sessions cannot be delivered to',
    });
    const codexBin = await which('codex');
    checks.push({
        name: 'codex CLI',
        ok: codexBin !== null,
        note: codexBin ?? 'not found — codex sessions cannot be delivered to',
    });
    if (codexBin) {
        // ADR-027: live Codex Desktop threads are reached through `codex queue` (CLI 0.149+)
        const { code } = await realExec('codex', ['queue', '--help'], { timeoutMs: 10_000 });
        checks.push({
            name: 'codex queue (live Desktop threads)',
            ok: code === 0,
            note: code === 0 ? 'supported' : 'missing — upgrade: npm i -g @openai/codex@latest',
        });
    }
    checks.push({
        name: 'claude sessions',
        ok: existsSync(join(home, '.claude', 'projects')),
        note: '~/.claude/projects',
    });
    checks.push({
        name: 'codex sessions',
        ok: existsSync(join(home, '.codex', 'sessions')),
        note: '~/.codex/sessions',
    });
    checks.push({
        name: 'codex auth (file-based, auto-delivery ready)',
        ok: existsSync(join(home, '.codex', 'auth.json')),
        note: '~/.codex/auth.json',
    });
    try {
        createDb(defaultDbPath()).prepare('SELECT 1').get();
        checks.push({ name: 'mailbox db', ok: true, note: defaultDbPath() });
    }
    catch (e) {
        checks.push({ name: 'mailbox db', ok: false, note: e instanceof Error ? e.message : String(e) });
    }
    const skillInstalled = existsSync(join(home, '.claude', 'skills', 'any-to-any', 'SKILL.md'));
    checks.push({
        name: 'skill installed',
        ok: skillInstalled,
        note: skillInstalled ? '~/.claude/skills/any-to-any' : 'run: anyd setup',
    });
    // Desktop-App agents (ADR-024). Only reported when the app is actually here —
    // an absent 闪电说 is not a problem to nag about.
    const { resolveSdsPaths, detectSds } = await import('./integrations/sds.js');
    const sds = detectSds(resolveSdsPaths({ home }));
    if (sds.appInstalled) {
        checks.push({
            name: '闪电说 assistant (external agent)',
            ok: sds.skillEnabled,
            note: sds.skillEnabled
                ? 'connected — registers as @sds and pulls over HTTP'
                : sds.skillInstalled
                    ? 'skill present but DISABLED in 闪电说 — re-run: anyd connect sds --apply'
                    : 'run: anyd connect sds --apply',
        });
    }
    // ADR-028: this device's identity and who it trusts
    try {
        const { loadOrCreateIdentity, shortDeviceId } = await import('./cluster/identity.js');
        const { createTrustStore } = await import('./cluster/trust.js');
        const { statSync } = await import('node:fs');
        const identity = loadOrCreateIdentity();
        const keyMode = statSync(join(home, '.anytoany', 'identity', 'key.pem')).mode & 0o777;
        const paired = createTrustStore().list();
        checks.push({
            name: 'device identity (mutual TLS)',
            ok: keyMode === 0o600,
            note: keyMode === 0o600
                ? `${shortDeviceId(identity.id)}… — ${paired.length} paired device(s)${paired.length ? `: ${paired.map((d) => `@${d.name}`).join(', ')}` : ' (anyd pair to add one)'}`
                : `private key is readable by others (mode ${keyMode.toString(8)}) — run: chmod 600 ~/.anytoany/identity/key.pem`,
        });
    }
    catch (e) {
        checks.push({ name: 'device identity (mutual TLS)', ok: false, note: e instanceof Error ? e.message : String(e) });
    }
    const { mailboxRoot } = await import('./adapters/zcode-mailbox.js');
    const zcodeMailbox = zcodeMailboxCheck(mailboxRoot(), existsSync('/Applications/ZCode.app') || existsSync(join(home, '.zcode')));
    if (zcodeMailbox)
        checks.push(zcodeMailbox);
    let hookRegistered = false;
    let claudeSettings = null;
    try {
        const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
        claudeSettings = settings;
        hookRegistered =
            settings.hooks?.['UserPromptSubmit']?.some((m) => m.hooks.some((h) => h.command.includes('anyd hook claude-prompt-submit'))) ?? false;
    }
    catch {
        /* missing settings file — hook not registered */
    }
    checks.push({
        name: 'claude inbox hook',
        ok: hookRegistered,
        note: hookRegistered ? 'UserPromptSubmit registered' : 'run: anyd setup',
    });
    checks.push(crossSessionInboundCheck(claudeSettings));
    let allOk = true;
    for (const c of checks) {
        if (!c.ok)
            allOk = false;
        console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`);
    }
    console.log(`\nnote: claude CLI login state cannot be checked offline; if deliveries fail with "Not logged in", run \`claude\` once to log in (see ADR-008).`);
    return allOk;
}
//# sourceMappingURL=doctor.js.map