// End-to-end proof that adapter.js works against a real opencode serve process.
import * as adapter from './adapter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(__dirname, 'testcwd');

async function main() {
  console.log('--- start() ---');
  const runId = await adapter.start({
    prompt: 'Run the shell command `echo ADAPTER_PROOF_OK` and then tell me what it printed.',
    cwd,
  });
  console.log('runId:', runId);

  let sawDelta = false;
  let sawApprovalRequest = false;
  let sawToolResult = false;
  let turnEnd = null;

  for await (const evt of adapter.observe(runId)) {
    if (evt.type === 'assistant.delta') sawDelta = true;
    if (evt.type === 'approval.request') {
      sawApprovalRequest = true;
      console.log('approval.request:', evt.permission, evt.metadata);
      // Answer it from code — the whole point of the spike.
      const run = adapter.__runsForTest?.(runId);
      const [baseUrl, sessionID] = runId.split('::');
      await fetch(`${baseUrl}/session/${sessionID}/permissions/${evt.approvalID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'once' }),
      });
      console.log('-> replied "once" from code');
    }
    if (evt.type === 'tool.result') {
      sawToolResult = true;
      console.log('tool.result:', evt.tool, evt.output);
    }
    if (evt.type === 'turn.end') turnEnd = evt;
  }

  console.log('sawDelta:', sawDelta);
  console.log('sawApprovalRequest:', sawApprovalRequest);
  console.log('sawToolResult:', sawToolResult);
  console.log('turnEnd:', turnEnd);

  await adapter.disposeAll();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await adapter.disposeAll();
  process.exit(1);
});
