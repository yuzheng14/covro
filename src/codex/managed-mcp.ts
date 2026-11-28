import { isDeepStrictEqual } from 'node:util';
import type { ThreadItem } from './generated/v2/ThreadItem.js';

export const MANAGED_MCP_TOKEN_ENV = 'COVRO_MANAGED_MCP_TOKEN';

export const managedLoopToolNames = ['list_loops', 'create_loop', 'update_loop'] as const;
export type ManagedLoopTool = (typeof managedLoopToolNames)[number];

type LiveCall = {
  threadId: string;
  turnId: string;
  tool: string;
  arguments: unknown;
};

/** Only notifications from the current app-server stdio connection can populate this registry. */
export class ManagedMcpCalls {
  private readonly calls = new Map<string, LiveCall>();

  observe(server: string, threadId: string, turnId: string, item: ThreadItem, started: boolean) {
    if (
      item.type !== 'mcpToolCall' ||
      item.server !== server ||
      !managedLoopToolNames.some((tool) => tool === item.tool)
    )
      return;
    const key = JSON.stringify([threadId, item.id]);
    if (!started) {
      this.calls.delete(key);
      return;
    }
    // Bound storage to small, currently executing managed tool calls.
    const args = item.arguments ?? {};
    if (JSON.stringify(args).length > 32_768) return;
    if (this.calls.size >= 256) this.calls.delete(this.calls.keys().next().value!);
    this.calls.set(key, { threadId, turnId, tool: item.tool, arguments: args });
  }

  match(
    threadId: string,
    callId: string,
    tool: ManagedLoopTool,
    args: unknown,
  ): string | undefined {
    const call = this.calls.get(JSON.stringify([threadId, callId]));
    if (call?.tool === tool && isDeepStrictEqual(call.arguments, args)) return call.turnId;
  }

  finishTurn(threadId: string, turnId: string) {
    for (const [key, call] of this.calls)
      if (call.threadId === threadId && call.turnId === turnId) this.calls.delete(key);
  }

  clear() {
    this.calls.clear();
  }
}

/** Runtime-only configuration for the Covro-owned app-server child. Never writes user TOML. */
export function managedMcpArguments(value: string, name: string, authenticated = false): string[] {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/mcp' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^covro_[a-z0-9_]+$/.test(name)
  )
    throw new Error('Managed MCP must use a loopback HTTP /mcp endpoint');
  const credential = authenticated ? `,bearer_token_env_var="${MANAGED_MCP_TOKEN_ENV}"` : '';
  return ['-c', `mcp_servers.${name}={url=${JSON.stringify(url.href)},enabled=true${credential}}`];
}
