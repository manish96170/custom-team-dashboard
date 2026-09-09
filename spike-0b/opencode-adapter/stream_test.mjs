import { spawn } from 'node:child_process';

const child = spawn('opencode', ['run', 'Count from 1 to 20, one number per line, nothing else.', '--format', 'json', '-m', 'amazon-bedrock/us.anthropic.claude-sonnet-5', '--dir', './testcwd']);

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
      console.log(`[t=${t}ms] type=${obj.type} textLen=${obj.part?.text?.length ?? ''} tool=${obj.part?.tool ?? ''}`);
    } catch (e) {
      console.log(`[t=${t}ms] RAW: ${line.slice(0,100)}`);
    }
  }
});
child.stderr.on('data', d => process.stderr.write('STDERR: ' + d));
child.on('close', code => console.log('EXIT CODE', code));
