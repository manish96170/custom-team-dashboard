import { spawn } from 'node:child_process';
import fs from 'node:fs';

const out = fs.createWriteStream('./stream_events.log', { flags: 'a' });
const child = spawn('opencode', ['run', 'Write a 200 word short story about a lighthouse keeper.', '--format', 'json', '-m', 'amazon-bedrock/us.anthropic.claude-sonnet-5', '--dir', './testcwd']);

const t0 = Date.now();
let buf = '';
child.stdout.on('data', (chunk) => {
  const t = Date.now() - t0;
  buf += chunk.toString();
  let lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      out.write(`[t=${t}ms] type=${obj.type} partID=${obj.part?.id ?? ''} textLen=${obj.part?.text?.length ?? ''}\n`);
    } catch (e) {
      out.write(`[t=${t}ms] RAW: ${line.slice(0,150)}\n`);
    }
  }
});
child.stderr.on('data', d => out.write('STDERR: ' + d));
child.on('close', code => { out.write('EXIT CODE ' + code + '\n'); out.end(); });
