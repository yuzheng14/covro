import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { WindowsInspector } from '../../src/server/preview/windows.js';

const instances: WindowsInspector[] = [];
afterEach(() => instances.splice(0).forEach((inspector) => inspector.close()));
const valid = {
  root: 1,
  rootBirth: '134098638000000000',
  processes: [
    {
      pid: 2,
      parent: 1,
      birth: '134098638000000001',
      cwd: 'C:\\projects\\中文',
      thread: 'thread',
      call: 'call',
    },
  ],
  listeners: [{ pid: 2, port: 5173, host: '127.0.0.1' }],
};
function inspector(mode = 'valid', timeoutMs = 3000) {
  let starts = 0;
  const value = new WindowsInspector(() => {
    starts++;
    return spawn(
      process.execPath,
      [
        '-e',
        `
      const readline = require('node:readline');
      const mode = ${JSON.stringify(mode)};
      const snapshot = ${JSON.stringify(valid)};
      console.error('SECRET Windows exception/environment');
      if (mode === 'startup') console.log('not json SECRET');
      else console.log(JSON.stringify({ready:true}));
      let count = 0;
      readline.createInterface({input:process.stdin}).on('line', line => {
        const q=JSON.parse(line); count++;
        if(mode==='timeout') return;
        if(mode==='exit') return process.exit(1);
        if(mode==='malformed') return console.log('SECRET raw native exception');
        if(mode==='unsolicited') return console.log(JSON.stringify({id:q.id+1,ok:true,result:{}}));
        if(mode==='failure') return console.log(JSON.stringify({id:q.id,ok:false,error:'query_failed'}));
        if(mode==='wrong-root') snapshot.root=3;
        if(mode==='birth-change' && count>1) snapshot.rootBirth='134098638000000002';
        if(mode==='missing-owner') snapshot.listeners[0].pid=3;
        if(mode==='duplicate') snapshot.processes.push(snapshot.processes[0]);
        if(mode==='extra') snapshot.processes[0].environment='SECRET';
        const result=q.method==='connected'?{connected:q.host==='127.0.0.1' && q.pid===2 && q.port===5173 && q.clientPort===9999}:snapshot;
        console.log(JSON.stringify({id:q.id,ok:true,result}));
      });
    `,
      ],
      { stdio: 'pipe' },
    );
  }, timeoutMs);
  instances.push(value);
  return { value, starts: () => starts };
}
describe('Windows source worker protocol (OS queries are verified in Windows CI)', () => {
  it('keeps one worker, preserves 100ns identity as text and binds both address and ports', async () => {
    const { value, starts } = inspector();
    expect((await value.snapshot(1)).processes.get(2)?.birth).toBe('134098638000000001');
    expect(await value.connected(2, 5173, 9999, '127.0.0.1')).toBe(true);
    expect(await value.connected(2, 5173, 9999, '::1')).toBe(false);
    expect(await value.connected(2, 5173, 9998, '127.0.0.1')).toBe(false);
    expect(starts()).toBe(1);
  });
  it.each([
    'startup',
    'malformed',
    'unsolicited',
    'failure',
    'exit',
    'wrong-root',
    'missing-owner',
    'duplicate',
    'extra',
  ])('rejects %s without exposing raw output or stderr', async (mode) => {
    await expect(inspector(mode).value.snapshot(1)).rejects.toThrow(
      /^Windows preview process inspection is unavailable$/,
    );
  });
  it('rejects root PID reuse without refreshing its identity', async () => {
    const { value } = inspector('birth-change');
    await value.snapshot(1);
    await expect(value.snapshot(1)).rejects.toThrow('unavailable');
    await expect(value.snapshot(1)).rejects.toThrow('unavailable');
  });
  it('kills a timed-out worker, rejects concurrent requests and starts fresh', async () => {
    const { value, starts } = inspector('timeout', 300);
    const results = await Promise.allSettled([value.snapshot(1), value.snapshot(1)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await expect(value.snapshot(1)).rejects.toThrow('unavailable');
    expect(starts()).toBe(2);
  });
  it('close rejects an active request and permanently prevents spawning', async () => {
    const { value, starts } = inspector('timeout');
    const pending = value.snapshot(1);
    value.close();
    await expect(pending).rejects.toThrow('unavailable');
    await expect(value.snapshot(1)).rejects.toThrow('unavailable');
    value.close();
    expect(starts()).toBe(1);
  });
});
