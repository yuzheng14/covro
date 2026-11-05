/** Runtime-only configuration for the Covro-owned app-server child. Never writes user TOML. */
export function managedMcpArguments(value: string, name: string): string[] {
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
  return ['-c', `mcp_servers.${name}={url=${JSON.stringify(url.href)},enabled=true}`];
}
