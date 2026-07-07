import { spawn } from "node:child_process";
import type { AgentHealthCheck, RuntimeAgentId } from "../../types";
import { classifyFailureCodeForMessage } from "../services/agent-execution.service";
import { prepareCommandInvocation } from "./command-invocation";
import { safeAgentEnvironment } from "./spawn-agent-process";

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_OUTPUT_CHARS = 2_000;

export type AgentProbeOptions = {
  toolId: RuntimeAgentId;
  commandPath: string;
  args: string[];
  stdin: string;
  checkId: string;
  label: string;
};

export async function runAgentModelProbe(options: AgentProbeOptions): Promise<AgentHealthCheck> {
  const invocation = await prepareCommandInvocation(options.commandPath, options.args, process.platform);
  return new Promise<AgentHealthCheck>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(invocation.commandPath, invocation.args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: safeAgentEnvironment(process.env, options.toolId)
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish("failed", `Model probe timed out after ${PROBE_TIMEOUT_MS}ms.`);
    }, PROBE_TIMEOUT_MS);
    const finish = (status: AgentHealthCheck["status"], message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        id: options.checkId,
        label: options.label,
        status,
        message: redactSecretLikeValues(message)
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = truncateProbeOutput(stdout + chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = truncateProbeOutput(stderr + chunk.toString());
    });
    child.on("error", (error: Error) => {
      finish("failed", `Model probe failed to start: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish("passed", "Model probe completed successfully.");
        return;
      }
      const output = `${stderr}\n${stdout}`.trim() || `Agent process exited with code ${code ?? "unknown"}.`;
      const failureCode = classifyFailureCodeForMessage(output, code === 143 ? "timeout" : "failed");
      finish("failed", `Model probe ${failureCode}: ${output}`);
    });
    child.stdin?.write(options.stdin);
    child.stdin?.end();
  });
}

function truncateProbeOutput(output: string): string {
  return output.length > MAX_PROBE_OUTPUT_CHARS ? output.slice(0, MAX_PROBE_OUTPUT_CHARS) : output;
}

function redactSecretLikeValues(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(?:api[_-]?key|token|secret)=\S+/gi, "$1=[redacted]");
}
