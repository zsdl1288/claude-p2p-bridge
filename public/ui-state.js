export const pages = {
  connection: { title: '设备与配对', description: '先确定本机身份，再连接私有网络并完成设备授权。' },
  api: { title: 'Claude 模型 API', description: '为 Claude 单独配置模型服务。模型服务和网络共享可分别启停。' },
  proxy: { title: '网络代理', description: '调用端使用 Clash TUN，服务端提供网络出口。网络共享独立于 Claude。' },
  activity: { title: '运行记录', description: '查看本机连接、配对和业务运行情况。' },
  settings: { title: '设置', description: '管理后台运行与开源许可。' }
};

export function uiState(status = {}, busy = false) {
  const identity = status.identity || {};
  const role = ['host', 'client'].includes(identity.role) ? identity.role : null;
  const loaded = identity.loaded === true;
  const locked = !loaded || identity.locked === true || identity.desiredOnline === true || identity.canSwitchRole !== true;
  return {
    role, locked,
    canSelectRole: loaded && !busy && !locked && identity.canSwitchRole !== false,
    canConnect: loaded && !busy && Boolean(role) && !locked && !identity.desiredOnline,
    canDisconnect: loaded && !busy && (identity.desiredOnline === true || locked),
    canPair: loaded && !busy && Boolean(role) && identity.desiredOnline === true && (status.network?.running === true || status.demo === true),
    model: loaded && Boolean(role) && status.capabilities?.model === true,
    proxy: loaded && Boolean(role) && status.capabilities?.proxy === true
  };
}

export function allowedPage(page, state) {
  if (!Object.hasOwn(pages, page)) return 'connection';
  if ((page === 'api' && !state.model) || (page === 'proxy' && !state.proxy)) return 'connection';
  return page;
}

export function deviceIdentity(device) {
  return [device.self ? '本机' : '', device.role === 'host' ? 'B 服务端' : device.role === 'client' ? 'A 调用端' : ''].filter(Boolean).join(' · ');
}

export function deviceConnection(device) {
  if (!device.online) return '离线';
  if (device.self) return '在线';
  if (device.path === 'direct') return 'P2P 直连';
  if (['relay', 'peer-relay'].includes(device.path)) return '加密中转';
  return '在线';
}
