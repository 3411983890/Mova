/**
 * Probe: full turn through the real ACP engine, with an explicit model id,
 * to confirm session/set_model + event translation work end to end.
 */
import { spawn } from 'node:child_process';
import { createAcpEngine } from '../../electron/acp/engine.mjs';
import { createGate } from '../../electron/acp/gate.mjs';

const command = process.argv[2] || 'C:\\Users\\34119\\AppData\\Local\\agy\\bin\\agy.exe';
const modelId = process.argv[3] || 'gemini-4-argon-high';
const prompt = process.argv[4] || '只回复四个字：测试通过';

const started = Date.now();
const engine = createAcpEngine({
  spawn: (...args) => spawn(...args),
  gate: createGate({ projectRoots: [], preset: 'default', approvals: null }),
});
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120_000);

try {
  const result = await engine.runTurn({
    command,
    prompt,
    cwd: process.env.APPDATA,
    modelId,
    signal: controller.signal,
    emit: (event) => {
      console.log(`+${String(Date.now() - started).padStart(6)}ms  ${JSON.stringify(event).slice(0, 260)}`);
    },
    mcpServers: async () => [],
  });
  console.log('RESULT:', JSON.stringify(result).slice(0, 300));
} catch (error) {
  console.log('THROW:', error?.code, '|', String(error?.detail ?? error?.message ?? error).slice(0, 240));
} finally {
  clearTimeout(timer);
  await engine.dispose().catch(() => {});
  process.exit(0);
}
