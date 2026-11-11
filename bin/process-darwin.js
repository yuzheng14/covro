/* Read-only JavaScript for macOS's system JXA runtime; no Apple Events or UI APIs.
 * Darwin's 64-bit public proc_info ABI is shared by arm64 and x86_64.
 * Only process identity, cwd and the two execution markers leave this process. */
ObjC.import('Foundation');
ObjC.import('stdlib');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
ObjC.bindFunction('calloc', ['unsigned char *', ['unsigned long', 'unsigned long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
ObjC.bindFunction('memset', ['void *', ['void *', 'int', 'unsigned long']]);
if (Ref.equals($.dlopen('/usr/lib/libproc.dylib', 2), null)) unavailable();
ObjC.bindFunction('proc_listallpids', ['int', ['void *', 'int']]);
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
ObjC.bindFunction('sysctl', [
  'int',
  ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long'],
]);

function unavailable() {
  throw new Error('Process metadata is unavailable');
}
function allocate(size) {
  let buffer = $.calloc(size, 1);
  if (Ref.equals(buffer, null)) unavailable();
  return buffer;
}
function u32(buffer, offset) {
  return (
    Number(buffer[offset]) +
    Number(buffer[offset + 1]) * 256 +
    Number(buffer[offset + 2]) * 65536 +
    Number(buffer[offset + 3]) * 16777216
  );
}
function put32(buffer, offset, value) {
  for (let i = 0; i < 4; i++) buffer[offset + i] = Math.floor(value / Math.pow(256, i)) % 256;
}
function u64(buffer, offset) {
  let value = u32(buffer, offset) + u32(buffer, offset + 4) * 4294967296;
  if (!Number.isSafeInteger(value)) unavailable();
  return value;
}
function info(pid, buffer) {
  if ($.proc_pidinfo(pid, 3, 0, buffer, 136) !== 136 || u32(buffer, 12) !== pid) return null;
  let seconds = u64(buffer, 120),
    micros = u64(buffer, 128);
  if (seconds < 1 || micros >= 1000000) unavailable();
  return {
    pid: pid,
    parent: u32(buffer, 16),
    birth: String(seconds) + '.' + ('000000' + String(micros)).slice(-6),
  };
}
function same(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.birth === b.birth);
}
function endOfString(buffer, offset, size) {
  for (let i = offset; i < size; i++) if (Number(buffer[i]) === 0) return i;
  unavailable();
}
function environment(pid) {
  let limit = 1048576,
    buffer = allocate(limit),
    mib = allocate(12),
    size = Ref('unsigned long');
  try {
    put32(mib, 0, 1);
    put32(mib, 4, 49);
    put32(mib, 8, pid);
    size[0] = limit;
    if ($.sysctl(mib, 3, buffer, size, null, 0) !== 0 || size[0] < 4 || size[0] > limit)
      unavailable();
    let length = Number(size[0]),
      argc = u32(buffer, 0);
    if (argc < 1 || argc > 65536) unavailable();
    let offset = endOfString(buffer, 4, length);
    while (offset < length && Number(buffer[offset]) === 0) offset++;
    for (let i = 0; i < argc; i++) {
      if (offset >= length) unavailable();
      offset = endOfString(buffer, offset, length) + 1;
    }
    let markers = {},
      keys = ['CODEX_THREAD_ID=', 'CODEX_TOOL_CALL_ID='];
    while (offset < length && Number(buffer[offset]) !== 0) {
      let end = endOfString(buffer, offset, length);
      for (let k = 0; k < keys.length; k++) {
        let key = keys[k],
          matches = end - offset >= key.length;
        for (let j = 0; matches && j < key.length; j++)
          matches = Number(buffer[offset + j]) === key.charCodeAt(j);
        if (!matches) continue;
        if (
          markers[key] !== undefined ||
          end - offset - key.length < 1 ||
          end - offset - key.length > 160
        )
          unavailable();
        let value = '';
        for (let j = offset + key.length; j < end; j++)
          value += String.fromCharCode(Number(buffer[j]));
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) unavailable();
        markers[key] = value;
      }
      offset = end + 1;
    }
    if (!markers[keys[0]] || !markers[keys[1]]) unavailable();
    return { thread: markers[keys[0]], call: markers[keys[1]] };
  } finally {
    $.memset(buffer, 0, limit);
    $.free(buffer);
    $.free(mib);
  }
}
function cwd(pid) {
  let buffer = allocate(2352);
  try {
    if ($.proc_pidinfo(pid, 9, 0, buffer, 2352) !== 2352) unavailable();
    let start = 152,
      end = endOfString(buffer, start, start + 1024),
      text = '';
    for (let i = start; i < end; i++)
      text += '%' + ('0' + Number(buffer[i]).toString(16)).slice(-2);
    let path = decodeURIComponent(text);
    if (path[0] !== '/') unavailable();
    return path;
  } finally {
    $.free(buffer);
  }
}
function number(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2147483647) unavailable();
  return Number(value);
}
function identity(pid, buffer) {
  const before = info(pid, buffer);
  if (!before) unavailable();
  const markers = environment(pid);
  const path = cwd(pid);
  if (!same(before, info(pid, buffer))) unavailable();
  return {
    pid: before.pid,
    parent: before.parent,
    birth: before.birth,
    cwd: path,
    thread: markers.thread,
    call: markers.call,
  };
}
/* exported run */
function run(argv) {
  if (argv.length !== 2 || ['table', 'identity', 'identities'].indexOf(argv[0]) === -1)
    unavailable();
  const buffer = allocate(136);
  let pids = null;
  try {
    if (argv[0] === 'identities') {
      const ids = argv[1].split(',').map(number);
      if (ids.length > 256 || new Set(ids).size !== ids.length) unavailable();
      const result = [];
      for (const pid of ids) {
        try {
          result.push(identity(pid, buffer));
        } catch {
          /* Exited or unmarked: no positive evidence. */
        }
      }
      return JSON.stringify(result);
    }
    const pid = number(argv[1]);
    if (argv[0] === 'identity') return JSON.stringify(identity(pid, buffer));
    const before = info(pid, buffer);
    if (!before) unavailable();
    let count = $.proc_listallpids(null, 0);
    if (count < 1 || count > 131072) unavailable();
    const capacity = count + 1024;
    pids = allocate(capacity * 4);
    count = $.proc_listallpids(pids, capacity * 4);
    if (count < 1 || count >= capacity) unavailable();
    const result = [];
    for (let i = 0; i < count; i++) {
      const id = u32(pids, i * 4);
      if (id > 0 && id <= 2147483647) {
        const row = info(id, buffer);
        if (row) result.push(row);
      }
    }
    if (!same(before, info(pid, buffer))) unavailable();
    return JSON.stringify(result);
  } finally {
    $.free(buffer);
    if (pids) $.free(pids);
  }
}
