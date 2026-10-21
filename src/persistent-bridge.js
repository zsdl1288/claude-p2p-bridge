import { Bridge } from './bridge.js';
import { encodeInvitation, parseInvitation } from './crypto.js';

// All pairing mutations share a queue. Startup recovery may wait for the
// network, but forgetting/pausing invalidates queued recovery immediately.
export class PersistentBridge extends Bridge {
  constructor({ store, restoreDelay = 1500, ...options }) {
    super(options);
    this.store = store; this.restoreDelay = restoreDelay;
    this.operations = Promise.resolve(); this.generation = 0; this.restoreAttempts = 0;
    this.saved = null; this.loaded = false; this.paused = false; this.closing = false;
    this.pairingInvalid = false;
    this.restoreMessage = ''; this.storageError = ''; this.networkResets = 0;
    this.onNetworkReset = () => { ++this.networkResets; this.recoverNetwork(); };
    this.networkAdapter?.on?.('reset', this.onNetworkReset);
    this.on('state', () => {
      if (!this.pairingInvalid && this.saved && this.peer?.state.pairingRejected
          && encodeInvitation(this.peer.pairing) === this.saved.invitation) {
        this.pairingInvalid = true; this.cancelRestore();
      }
    });
  }
  enqueue(task) {
    const result = this.operations.then(task);
    this.operations = result.catch(() => {});
    return result;
  }
  networkIdentity() {
    if (this.peer || !this.saved) return super.networkIdentity();
    const role = this.saved.role;
    return { role, serverAddress: role === 'client' ? parseInvitation(this.saved.invitation, { allowLoopback: this.demo }).host : null };
  }
  status() {
    const state = super.status();
    const role = state.role || this.saved?.role || null;
    const pair = this.saved ? parseInvitation(this.saved.invitation, { allowLoopback: this.demo }) : null;
    const summary = pair ? { role: this.saved.role, host: pair.host, port: pair.port, endpoint: `${pair.host}:${pair.port}` } : null;
    let phase = !this.loaded ? 'loading' : 'none';
    let message = !this.loaded ? '正在读取已保存的配对' : '成功配对后会自动保存';
    if (this.saved) {
      phase = this.paused ? 'paused' : state.online ? 'connected' : this.peer ? this.peer.role === 'host' ? 'waiting-peer' : 'connecting' : 'waiting-network';
      message = this.paused ? '已暂停连接，下次启动仍会自动连接' : state.online ? '配对已保存，自动连接已启用'
        : this.peer?.role === 'host' ? 'B 服务已恢复，等待 A 自动连接'
        : this.peer?.role === 'client' ? '正在自动连接 B，等待对端上线'
        : this.restoreMessage || '正在恢复已保存的配对';
    }
    if (this.saved && this.pairingInvalid) { phase = 'invalid'; message = '配对已失效，请使用服务端的新配对码重新配对'; }
    if (this.storageError) { phase = 'error'; message = this.storageError; }
    return { ...state, role, config: state.config || this.saved?.config || null,
      invitation: state.invitation || (this.saved?.role === 'host' ? this.saved.invitation : null),
      pairing: { saved: Boolean(this.saved), valid: Boolean(this.saved && !this.pairingInvalid), paused: this.paused, summary,
        role, state: phase, autoConnect: Boolean(this.saved && !this.paused && !this.pairingInvalid), message, error: this.storageError || null } };
  }
  start() {
    if (!this.started) this.started = this.enqueue(async () => {
      try {
        this.saved = await this.store.load();
        if (this.saved) this.log('已读取加密保存的配对，将自动恢复连接');
      } catch (error) { this.storageError = error.message; this.log(this.storageError); }
      this.loaded = true; this.emit('state');
      this.scheduleRestore(0);
    });
    return this.started;
  }
  cancelRestore() { ++this.generation; clearTimeout(this.restoreTimer); this.restoreTimer = null; }
  canRestore() { return true; }
  hostRestoreInput() { return this.saved.config || {}; }
  pairingConfig(role) { return role === 'host' ? this.config : null; }
  validateActivation() {}
  recoverNetwork() {
    // A restarted helper loses its tsnet listener while the local WebSocket
    // server can remain alive. Recreate B's listener from the saved pairing.
    // Client sockets already reconnect through their normal retry loop.
    if (this.closing || this.paused || !this.canRestore() || !this.saved || this.peer?.role !== 'host') return;
    this.cancelRestore();
    const generation = this.generation;
    const peer = this.peer;
    const current = () => generation === this.generation && !this.closing && !this.paused && this.canRestore() && this.saved;
    this.enqueue(async () => {
      if (!current() || (this.peer && this.peer !== peer)) return;
      await super.disconnect();
      if (!current()) return;
      this.restoreMessage = '内置组网已中断，正在恢复已保存的 B 端服务';
      this.log(this.restoreMessage);
      this.scheduleRestore(0);
    }).catch((error) => {
      if (!current()) return;
      this.restoreMessage = `恢复组网服务：${error.message}`;
      this.log(this.restoreMessage);
      this.scheduleRestore();
    });
  }
  scheduleRestore(delay = this.restoreDelay) {
    if (!this.saved || this.pairingInvalid || this.paused || this.closing || !this.canRestore()) return;
    clearTimeout(this.restoreTimer);
    const generation = this.generation;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.enqueue(() => this.restore(generation)).catch(() => {});
    }, delay);
    this.restoreTimer.unref();
  }
  async restore(generation) {
    const current = () => generation === this.generation && !this.closing && !this.paused && !this.pairingInvalid && this.canRestore() && this.saved;
    if (!current() || this.peer) return;
    try {
      if (!this.demo) {
        // This starts the previously authorized node; it never invokes an
        // interactive login or opens a browser on the user's behalf.
        if (this.networkAdapter?.connect) { await this.networkAdapter.connect(); this.invalidateNetworkInfo(); }
        if (!current()) return;
        const network = await this.networkInfo(true);
        if (!current()) return;
        if (!network.running) throw new Error('正在等待私有网络连接；登录失效时请在窗口中重新登录');
      }
      if (!current()) return;
      if (this.saved.role === 'host') {
        const pairing = parseInvitation(this.saved.invitation, { allowLoopback: this.demo });
        // The saved pairing address is authoritative. A second local address
        // or a changed enumeration order does not invalidate that invitation.
        await super.host({ ...this.hostRestoreInput(), tailscaleIp: pairing.host }, { pairing });
      } else {
        await super.join({ invitation: this.saved.invitation }, { retryInitial: true });
      }
      if (!current()) { await super.disconnect(); return; }
      this.restoreMessage = ''; this.restoreAttempts = 0;
      this.log('已恢复原配对；无需重新复制配对码');
    } catch (error) {
      if (!current()) return;
      this.restoreMessage = `自动恢复连接：${error.message}`;
      if (this.lastRestoreError !== this.restoreMessage) { this.log(this.restoreMessage); this.lastRestoreError = this.restoreMessage; }
      this.scheduleRestore(Math.min(this.restoreDelay * 2 ** Math.min(this.restoreAttempts++, 4), 15000));
    }
    this.emit('state');
  }
  async activate(role, input) {
    await this.start();
    this.cancelRestore();
    return this.enqueue(async () => {
      if (this.closing) throw new Error('客户端正在退出');
      this.validateActivation(role);
      const previousPeer = this.peer;
      const networkResets = this.networkResets;
      try {
        if (role === 'host') await super.host(input); else await super.join(input);
        // Listener/dial setup can outlive an explicit down or process close.
        // Recheck before committing credentials, so that cancelled setup does
        // not become a newly saved authorization on the next launch.
        if (this.closing) throw new Error('客户端正在退出');
        this.validateActivation(role);
        const config = this.pairingConfig(role);
        const record = { v: config ? 1 : 2, mode: this.demo ? 'demo' : 'tailscale', role,
          invitation: encodeInvitation(this.peer.pairing), ...(config ? { config } : {}) };
        this.saved = await this.store.save(record);
        this.paused = false; this.pairingInvalid = false; this.storageError = ''; this.restoreMessage = ''; this.lastRestoreError = '';
        this.log('配对已加密保存，下次打开客户端会自动连接');
        // The first listener can lose its helper while saving credentials.
        // There was no saved pairing for the reset handler to recover yet;
        // recreate it now under the same cancellation/generation checks.
        if (role === 'host' && networkResets !== this.networkResets) this.recoverNetwork();
        return this.status();
      } catch (error) {
        // Never report a durable pairing when writing the credentials failed.
        if (this.peer !== previousPeer) await super.disconnect();
        if (!this.peer) this.paused = true;
        throw error;
      }
    });
  }
  host(input) { return this.activate('host', input); }
  join(input) { return this.activate('client', input); }
  async pause() {
    await this.start(); this.paused = true; this.cancelRestore();
    return this.enqueue(async () => {
      // An earlier queued activation/resume may have re-enabled recovery after
      // the immediate invalidation above. Apply the final state in queue order.
      this.paused = true; this.cancelRestore();
      await super.disconnect(); this.log('已暂停连接，保存的配对仍然保留'); return this.status();
    });
  }
  async resume() {
    await this.start(); this.cancelRestore();
    return this.enqueue(async () => {
      if (this.closing) throw new Error('客户端正在退出');
      if (!this.canRestore()) throw new Error('私有网络已主动断开，请先重新连接');
      if (!this.saved) throw new Error('没有可恢复的配对，请先完成一次配对');
      if (this.pairingInvalid) throw new Error('配对已失效，请使用服务端的新配对码重新配对');
      await super.disconnect();
      this.paused = false; this.restoreMessage = ''; this.restoreAttempts = 0;
      this.scheduleRestore(0); this.emit('state'); return this.status();
    });
  }
  async disconnect() {
    await this.start(); this.paused = true; this.cancelRestore();
    return this.enqueue(() => this.forgetPairing());
  }
  async forgetPairing() {
    this.paused = true; this.cancelRestore();
    await super.disconnect();
    try { await this.store.clear(); }
    catch { this.storageError = '配对已停止，但保存的信息未能删除，请重试“忘记配对”'; throw new Error(this.storageError); }
    this.saved = null; this.pairingInvalid = false; this.storageError = ''; this.restoreMessage = '';
    this.log('已忘记配对并撤销本次服务；下次启动不会自动连接');
    return this.status();
  }
  close() {
    this.closing = true; this.cancelRestore();
    this.channelSpeed.close();
    this.speedTransport.close();
    this.channelRecovery.close();
    this.networkAdapter?.off?.('reset', this.onNetworkReset);
    return this.enqueue(() => super.disconnect());
  }
}
