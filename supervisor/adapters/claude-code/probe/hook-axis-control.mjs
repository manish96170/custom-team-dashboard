// Positive control for the crash slice's "0 hooks fired" assertion.
//
// `inherit` loads the developer's global config, so `harness.hook` events MUST appear — without that
// row, "hooks=0" is indistinguishable from "the adapter never maps hook events at all" and the negative
// assertion proves nothing.
//
// All three profiles, because `none` is the DEFAULT since 2026-09-08 (repo config executes repo hooks,
// so it is opt-in) and the default is the row people will actually rely on.
import * as a from '/path/to/custom-team-dashboard/supervisor/adapters/claude-code/adapter.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const cwd = fs.mkdtempSync(path.join(process.env.HOME, 'ctd-hookctl-'));
for (const profile of ['inherit', 'project', 'none']) {
  const runId = a.start({ prompt: 'hi', cwd, envProfile: profile });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const log = a._getRunForTest(runId)?._eventLog ?? [];
    if (log.some(e => e.type === 'session.init')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const log = a._getRunForTest(runId)._eventLog;
  const hooks = log.filter(e => e.type === 'harness.hook' && e.phase === 'started');
  const init = log.find(e => e.type === 'session.init');
  console.log(`${profile.padEnd(8)} hooks=${hooks.length} mcp=${init?.mcpServers?.length ?? '?'} tools=${init?.toolCount ?? '?'} names=${JSON.stringify([...new Set(hooks.map(h=>h.hookName))])}`);
  a.stop(runId);
}
await a.disposeAll({ graceMs: 500 });
fs.rmSync(cwd, { recursive: true, force: true });
