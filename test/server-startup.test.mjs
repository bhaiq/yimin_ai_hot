import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("server imports its dependencies and starts listening", { timeout: 10_000 }, async (t) => {
  // 语法检查无法发现 ESM 导出缺失；用随机本机端口启动，且不请求触发数据库或外部调用的 API。
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await closed;
  });

  let output = "";
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Server exited before readiness (${code ?? signal}): ${output}`));
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Immigration Hot is running at http://127.0.0.1:")) resolve();
    });
  });
  assert.equal(child.exitCode, null);
});
