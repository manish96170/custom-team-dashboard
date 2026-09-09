// test-adapter.js — runs the actual adapter.js against the real `claude` CLI
// and prints a trace, to prove the module (not just raw CLI calls) works.
import { start, sendInput, observe, interrupt, clearContext, stop } from './adapter.js';
import { mkdirSync } from 'node:fs';

const cwd = new URL('./sandbox/adapter-e2e', import.meta.url).pathname;
mkdirSync(cwd, { recursive: true });

async function main() {
  console.log('--- start() ---');
  const runId = start({
    prompt: 'Remember the code word KIWI. Just say OK.',
    cwd,
    model: 'sonnet',
    permissionMode: 'default',
  });
  console.log('runId =', runId);

  console.log('--- observe() until first turn.end ---');
  await drainUntilTurnEnd(runId);

  console.log('--- sendInput() (same runId, same resident process) ---');
  sendInput(runId, 'What was the code word?');
  await drainUntilTurnEnd(runId);

  console.log('--- interrupt() mid-turn ---');
  sendInput(runId, 'Write a 3000 word essay about the history of tea.');
  // give it a moment to start streaming, then interrupt
  await new Promise((r) => setTimeout(r, 3000));
  interrupt(runId);
  await drainUntilTurnEnd(runId);

  console.log('--- clearContext() ---');
  const ack = clearContext(runId);
  console.log('clearContext ack:', ack);
  await drainUntilTurnEnd(runId); // the /clear turn itself

  sendInput(runId, 'What was the code word? If you do not know, say I DO NOT KNOW.');
  await drainUntilTurnEnd(runId);

  console.log('--- stop() ---');
  stop(runId);
  await new Promise((r) => setTimeout(r, 500));
  console.log('done');
  process.exit(0);
}

async function drainUntilTurnEnd(runId) {
  for await (const evt of observe(runId)) {
    if (evt.type === 'assistant.delta') process.stdout.write('.');
    else if (evt.type === 'tool.start') console.log(`\n[tool.start] ${evt.toolName}`);
    else if (evt.type === 'tool.result') console.log(`[tool.result] error=${evt.isError}`);
    else if (evt.type === 'turn.end') {
      console.log(`\n[turn.end] result=${JSON.stringify(evt.result)} terminalReason=${evt.terminalReason} isError=${evt.isError}`);
      return;
    } else if (evt.type === 'process.exit') {
      console.log(`\n[process.exit] code=${evt.code} signal=${evt.signal}`);
      return;
    }
  }
}

main().catch((e) => {
  console.error('TEST FAILED', e);
  process.exit(1);
});
