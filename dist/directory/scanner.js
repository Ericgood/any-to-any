export async function listAllSessions(adapters) {
    const settled = await Promise.allSettled(adapters.map((a) => a.listSessions()));
    const sessions = [];
    const errors = [];
    settled.forEach((result, i) => {
        const adapter = adapters[i];
        if (!adapter)
            return;
        if (result.status === 'fulfilled') {
            sessions.push(...result.value);
        }
        else {
            const cause = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
            errors.push({ agent: adapter.agent, error: cause });
        }
    });
    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return { sessions, errors };
}
//# sourceMappingURL=scanner.js.map