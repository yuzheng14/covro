// Runs with the target Node and exactly the restart environment. Never starts app-server.
import { loadConfig } from '../server/config.js';
import { probeCodexIdentity } from '../codex/identity.js';
try {
  const config = await loadConfig({ configPath: process.argv[2]!, development: false });
  console.log(
    JSON.stringify({ identity: await probeCodexIdentity(config.codex.binary, config.codex.home) }),
  );
} catch {
  // Child-process errors may include environment or arbitrary CLI output.
  console.log(
    JSON.stringify({
      error: '无法探测重启目标 Codex；请检查配置的 binary、目标 PATH、Node 和服务环境。',
    }),
  );
  process.exitCode = 1;
}
