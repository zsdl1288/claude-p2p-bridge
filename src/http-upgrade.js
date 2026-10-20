// An HTTP-upgraded socket is no longer owned by server.closeAllConnections().
// Flush the rejection, then destroy it even if the remote keeps its half open.
export function rejectUpgrade(socket, code, label) {
  // Node removes its HTTP error handler before emitting 'upgrade'. A rejected
  // socket has no WebSocket owner, including while its response is flushing.
  socket.on('error', () => socket.destroy());
  socket.end(`HTTP/1.1 ${code} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroySoon();
}
