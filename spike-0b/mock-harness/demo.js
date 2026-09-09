'use strict';

/**
 * demo.js — starts two concurrent mock runs, subscribes to both, prints
 * interleaved per-run-labeled events, answers an approval.request on one
 * run, and cleanly stops both.
 *
 * Run with: node demo.js
 */

const { MockHarnessAdapter } = require('./adapter');

function label(name, event) {
  const ts = new Date(event.ts).toISOString().split('T')[1].replace('Z', '');
  let extra = '';
  switch (event.type) {
    case 'assistant.delta':
      extra = `"${event.text}"`;
      break;
    case 'tool.start':
      extra = `${event.tool} ${JSON.stringify(event.args)}`;
      break;
    case 'tool.result':
      extra = event.result.summary;
      break;
    case 'approval.request':
      extra = `[${event.approvalId}] ${event.question}`;
      break;
    case 'approval.resolved':
      extra = `[${event.approvalId}] -> ${event.decision}`;
      break;
    case 'turn.end':
      extra = `turn ${event.turn}`;
      break;
    default:
      extra = JSON.stringify(event).slice(0, 120);
  }
  console.log(`[${ts}] (${name}) ${event.type} ${extra}`);
}

async function pump(name, iterable, onEvent) {
  for await (const event of iterable) {
    onEvent(event);
    label(name, event);
    if (event.type === 'turn.end' || event.type === 'run.stopped' || event.type === 'run.interrupted') {
      break;
    }
  }
}

async function main() {
  const adapter = new MockHarnessAdapter({
    deltaDelayRange: [50, 150],
    approvalChance: 1, // force an approval on both runs for demo determinism
  });

  const runIdA = adapter.start({
    prompt: 'Fix the flaky checkout test',
    cwd: '/repo/checkout-app',
    forceApproval: true,
  });
  const runIdB = adapter.start({
    prompt: 'Add retry logic to the payments client',
    cwd: '/repo/payments-client',
    forceApproval: true,
  });

  console.log(`Started run A: ${runIdA}`);
  console.log(`Started run B: ${runIdB}`);
  console.log('--- interleaved event stream below ---\n');

  let answeredApprovalForB = false;

  const pumpA = pump('RUN-A', adapter.observe(runIdA), () => {});
  const pumpB = pump('RUN-B', adapter.observe(runIdB), (event) => {
    if (event.type === 'approval.request' && !answeredApprovalForB) {
      answeredApprovalForB = true;
      // Answer asynchronously, simulating a human/CTO responding a beat later.
      setTimeout(() => {
        console.log(`          (answering approval ${event.approvalId} on RUN-B: approve)`);
        adapter.answerApproval(runIdB, event.approvalId, 'approved');
      }, 80);
    }
  });

  // Also answer A's approval, immediately, so both runs can reach turn.end.
  const originalObserveA = adapter.observe(runIdA);
  (async () => {
    for await (const event of originalObserveA) {
      if (event.type === 'approval.request') {
        setTimeout(() => {
          console.log(`          (answering approval ${event.approvalId} on RUN-A: approve)`);
          adapter.answerApproval(runIdA, event.approvalId, 'approved');
        }, 40);
        break;
      }
    }
  })();

  await Promise.all([pumpA, pumpB]);

  console.log('\n--- both runs reached turn.end; stopping cleanly ---');
  adapter.stop(runIdA);
  adapter.stop(runIdB);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
