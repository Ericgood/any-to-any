#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { listAllSessions } from './directory/scanner.js';
import { formatRelativeTime, shortenHome } from './format.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const defaultAdapters = () => [createClaudeAdapter(), createCodexAdapter()];

const program = new Command();

program
  .name('anyd')
  .description('anytoany — session-to-session messaging for AI coding agents')
  .version(version);

const notImplemented = (cmd: string) => () => {
  console.error(`anyd ${cmd}: not implemented yet (Phase 1 in progress)`);
  process.exitCode = 1;
};

program.command('start').description('Start the anyd daemon').action(notImplemented('start'));
program.command('stop').description('Stop the anyd daemon').action(notImplemented('stop'));
program.command('status').description('Show daemon status and delivery stats').action(notImplemented('status'));
program
  .command('list')
  .description('List addressable sessions discovered on this machine')
  .option('--json', 'output as JSON')
  .option('--limit <n>', 'max sessions to show (0 = all)', '20')
  .action(async (opts: { json?: boolean; limit: string }) => {
    const { sessions, errors } = await listAllSessions(defaultAdapters());
    const limit = Number.parseInt(opts.limit, 10) || 0;
    const shown = limit > 0 ? sessions.slice(0, limit) : sessions;

    if (opts.json) {
      console.log(
        JSON.stringify(
          { sessions: shown, total: sessions.length, errors: errors.map((e) => ({ agent: e.agent, message: e.error.message })) },
          null,
          2,
        ),
      );
      return;
    }
    for (const s of shown) {
      const id = s.sessionId.slice(0, 8);
      console.log(`@${s.agent}:${s.title}  [${id}]  (${formatRelativeTime(s.lastActiveAt)}, ${shortenHome(s.cwd)})`);
    }
    if (sessions.length > shown.length) {
      console.log(`… ${sessions.length - shown.length} more (use --limit 0 for all)`);
    }
    for (const e of errors) {
      console.error(`warning: ${e.agent} scan failed: ${e.error.message}`);
    }
  });
program
  .command('send')
  .description('Send a message to a session, e.g. anyd send "@codex:frontend" "hello"')
  .argument('<target>', 'target session, @<agent>[:<session>]')
  .argument('<message>', 'message text')
  .option('--from <self>', 'sender identity, @<agent>:<session>')
  .action(notImplemented('send'));
program
  .command('inbox')
  .description('Show unread inbox messages')
  .option('--session <id>', 'filter by recipient session')
  .option('--all', 'include read/delivered messages')
  .option('--json', 'output as JSON')
  .action(notImplemented('inbox'));
program
  .command('reply')
  .description('Reply to a message thread')
  .argument('<messageId>', 'message id to reply to')
  .argument('<message>', 'reply text')
  .action(notImplemented('reply'));
program
  .command('conversations')
  .description('List established session-to-session conversations')
  .option('--json', 'output as JSON')
  .action(notImplemented('conversations'));

program.parse();
