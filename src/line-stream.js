// Bound a partial line before decoding it; readline's line event arrives only
// after the complete line has already been buffered. Pipe chunks may split UTF-8.
export function consumeLines(input, { maxBytes, onLine, onError }) {
  let parts = [], size = 0, closed = false;
  const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const close = () => { closed = true; parts = []; size = 0; input.off('data', data); input.off('end', end); };
  const fail = (error) => { close(); onError(error); };
  const append = (part) => {
    size += part.length;
    if (size > maxBytes) { fail(new Error(`单行输出超过 ${maxBytes / 1024} KiB`)); return false; }
    if (part.length) parts.push(part);
    return true;
  };
  const line = () => {
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    parts = []; size = 0;
    let text;
    try { text = decode.decode(bytes); }
    catch { fail(new Error('输出不是有效的 UTF-8')); return; }
    onLine(text.endsWith('\r') ? text.slice(0, -1) : text);
  };
  const data = (chunk) => {
    if (closed) return;
    let start = 0, next;
    while ((next = chunk.indexOf(10, start)) !== -1) {
      if (!append(chunk.subarray(start, next))) return;
      line(); if (closed) return;
      start = next + 1;
    }
    append(chunk.subarray(start));
  };
  const end = () => { if (!closed && size) line(); close(); };
  input.on('data', data); input.once('end', end);
  return close;
}
