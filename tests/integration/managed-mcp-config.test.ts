import { expect, it } from 'vitest';
import { managedMcpArguments } from '../../src/codex/managed-mcp.js';

it('uses process-only CLI configuration without credentials or config writes', () => {
  expect(managedMcpArguments('http://127.0.0.1:42123/mcp', 'covro_example')).toEqual([
    '-c',
    'mcp_servers.covro_example={url="http://127.0.0.1:42123/mcp",enabled=true}',
  ]);
});

it.each([
  'https://127.0.0.1:1234/mcp',
  'http://example.com:1234/mcp',
  'http://0.0.0.0:1234/mcp',
  'http://127.0.0.1/mcp',
  'http://127.0.0.1:1234/other',
  'http://user:secret@127.0.0.1:1234/mcp',
  'http://127.0.0.1:1234/mcp?token=secret',
])('rejects an invalid internal endpoint: %s', (url) => {
  expect(() => managedMcpArguments(url, 'covro_example')).toThrow('loopback HTTP /mcp endpoint');
});
