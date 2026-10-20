import { PersistentBridge } from './persistent-bridge.js';
import { ApplicationStore } from './application-store.js';
import { parseInvitation } from './crypto.js';
import { PeerDiscovery } from './peer-discovery.js';
import { randomUUID } from 'node:crypto';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

// Identity intent is independent of observed connectivity. Only an explicit,
// completed network-down transition unlocks the role; a lost route never does.
// All durable mutations use PersistentBridge's single queue. Epochs invalidate
// queued/in-flight recovery before a later down operation reaches that queue.
export class ApplicationBridge extends PersistentBridge {
  constructor({ applicationStore, directory, ...options }) {
    super(options);
    this.applicationStore = applicationStore || new ApplicationStore({ directory: directory || options.store.directory, demo: this.demo });
    this.selectedRole = null;
    this.intentOnline = false; this.roleLocked = false; this.identityChanging = false; this.networkEpoch = 0;
    this.modelPreferences = { enabled: false, config: null };
    this.applicationError = ''; this.modelConfigurationError = '';
    this.applicationRevision = 0;
    this.applicationInstanceId = randomUUID();
    this.discovery = new PeerDiscovery({ adapter: this.demo ? null : this.networkAdapter });
    this.on('state', () => { ++this.applicationRevision; });
  }
  start() {
    if (!this.applicationStarting) this.applicationStarting = this.loadApplication();
    return this.applicationStarting;
  }
  async loadApplication() {
    let preferences;
    try { preferences = await this.applicationStore.load(); }
    catch (error) { this.applicationError = `身份配置无法恢复：${error.message}`; }
    await super.start();
    if (preferences) {
      this.selectedRole = preferences.role;
      this.intentOnline = preferences.desiredOnline;
      this.roleLocked = preferences.locked;
      this.modelPreferences = preferences.model;
    } else if (this.saved) {
      // Upgrade in place: retain the old role, invitation and DPAPI identity.
      this.selectedRole = this.saved.role;
      this.intentOnline = !this.applicationError;
      this.roleLocked = true;
      if (this.saved.role === 'host' && this.saved.config) this.modelPreferences = { enabled: true, config: this.saved.config };
    }
    if (this.stopRequested) this.intentOnline = false;
    if (this.saved && this.selectedRole !== this.saved.role) {
      this.applicationError = '保存的配对与当前身份不一致，请断开私有网络后重新选择身份';
      this.intentOnline = false; this.roleLocked = true;
    }
    if (this.modelPreferences.config) {
      try {
        const fields = { ...this.modelPreferences.config, enabled: this.modelPreferences.enabled };
        const prepared = await this.prepareModel(fields);
        this.modelPreferences = prepared;
      } catch (error) {
        // A missing old Claude workspace must not stop networking. Preserve its
        // editable configuration, disable only this business, and report why.
        this.modelPreferences = { ...this.modelPreferences, enabled: false };
        this.modelConfigurationError = `Claude 配置尚不能启用：${error.message}`;
        try { this.modelPreferences = await this.prepareModel({ ...this.modelPreferences.config, enabled: false }); }
        catch { this.modelPreferences = { enabled: false, config: null }; }
      }
    }
    this.applyModelPreferences();
    if (!preferences && this.saved && !this.applicationError) {
      try { await this.persistApplication(); }
      catch (error) { this.applicationError = `身份配置保存失败：${error.message}`; this.intentOnline = false; }
    }
    this.applicationReady = true;
    this.paused = !this.intentOnline;
    if (this.demo && this.intentOnline && !this.stopRequested) this.demoNetworkConnected = true;
    this.emit('state');
    if (this.applicationClosing || this.applicationError) return this.status();
    if (this.intentOnline) {
      if (this.saved) this.scheduleRestore(0);
      else this.enqueue(() => this.restorePrivateNetwork(this.networkEpoch)).catch((error) => { this.networkError = error.message; this.emit('state'); });
    } else if (this.roleLocked && !this.stopRequested) {
      // Resume an interrupted explicit down, never the opposite transition.
      this.networkDownPending = true;
      this.networkDownPromise = this.enqueue(() => this.finishNetworkDown())
        .catch((error) => { this.networkError = error.message; this.emit('state'); })
        .finally(() => { this.networkDownPending = false; this.networkDownPromise = null; this.emit('state'); });
    }
    return this.status();
  }
  snapshotApplication(overrides = {}) {
    return { v: 1, role: this.selectedRole, desiredOnline: this.intentOnline, locked: this.roleLocked,
      model: { ...this.modelPreferences }, ...overrides };
  }
  persistApplication(overrides) { return this.applicationStore.save(this.snapshotApplication(overrides)); }
  applyModelPreferences() { this.applyModel({ ...this.modelPreferences, enabled: this.selectedRole === 'host' && this.modelPreferences.enabled }); }
  canRestore() { return this.applicationReady && !this.applicationClosing && !this.stopRequested && this.intentOnline && this.saved?.role === this.selectedRole; }
  validateActivation(role) {
    if (this.applicationClosing || !this.intentOnline || this.stopRequested || !this.roleLocked || role !== this.selectedRole) throw conflict('身份或私有网络状态已改变，请重新连接后再配对');
  }
  hostRestoreInput() { return {}; }
  pairingConfig() { return null; }
  networkIdentity() {
    const previous = super.networkIdentity();
    const role = this.selectedRole || previous.role;
    return { role, serverAddress: previous.role === role ? previous.serverAddress : null };
  }
  networkStatus() {
    const state = super.networkStatus();
    if (!state || !this.discovery) return state;
    return { ...state, devices: state.devices.map((device) => {
      if (device.self && this.demo) return { ...device, online: this.demoNetworkConnected === true };
      const discovered = !device.self && device.online && this.discovery.roles.get(device.address);
      return discovered && !device.role ? { ...device, role: discovered.role } : device;
    }) };
  }
  async networkInfo(refresh = false) {
    await super.networkInfo(refresh);
    if (this.intentOnline && !this.stopRequested && !this.applicationClosing && this.network?.running && !this.demo) {
      // Device discovery never delays a status read or grants business access.
      // The discoverer bounds outstanding allocations and rejects stale replies.
      if (!this.discovering) {
        const before = JSON.stringify([...this.discovery.roles]);
        const discovering = this.discovery.refresh(this.network.peers).then(() => {
          if (!this.applicationClosing && before !== JSON.stringify([...this.discovery.roles])) this.emit('state');
        }).catch(() => {}).finally(() => { if (this.discovering === discovering) this.discovering = null; });
        this.discovering = discovering;
      } else this.discovery.refresh(this.network.peers).catch(() => {});
    } else this.discovery.reset();
    return this.networkStatus();
  }
  status() {
    const state = super.status();
    const role = this.selectedRole || state.role;
    const ready = Boolean(this.applicationReady && !this.identityChanging && this.saved && this.saved.role === role && !this.storageError);
    const connected = this.demo ? Boolean(this.demoNetworkConnected) : this.network?.running === true;
    let phase = !this.applicationReady ? 'loading' : !role ? 'unselected' : this.intentOnline ? connected ? 'connected' : this.networkTransition === 'connecting' ? 'connecting' : 'reconnecting' : 'disconnected';
    let message = !role ? '请先选择调用端或服务端，再连接私有网络'
      : this.intentOnline ? connected ? '私有网络已连接，身份已锁定；切换身份前请主动断开私有网络' : '正在连接或恢复私有网络；身份保持锁定'
      : this.roleLocked ? '正在完成私有网络断开；完成后才能切换身份' : '私有网络已断开，可以切换身份；登录信息保留';
    if (this.identityChanging) { phase = 'switching'; message = '正在保存身份变更，请等待完成后连接私有网络'; }
    const error = this.applicationError || this.networkError;
    if (error) { phase = 'error'; message = error; }
    const model = { ...state.model };
    if (role === 'host') {
      model.config = this.modelPreferences.config;
      model.configured = Boolean(model.config);
      model.enabled = this.modelPreferences.enabled;
      if (this.modelConfigurationError) model.message = this.modelConfigurationError;
    }
    const pairing = { ...state.pairing, role, ready, autoConnect: Boolean(this.saved && state.pairing.valid && this.intentOnline && !this.paused) };
    if (this.saved && state.pairing.valid && !this.intentOnline) Object.assign(pairing, { state: 'network-disconnected', message: '私有网络已主动断开；配对保留，重新连接后恢复' });
    return { ...state, role, model, pairing, instanceId: this.applicationInstanceId, revision: this.applicationRevision,
      identity: { role, locked: Boolean(this.roleLocked || this.intentOnline), desiredOnline: this.intentOnline,
        loaded: this.applicationReady === true,
        canSwitchRole: this.applicationReady && !this.identityChanging && !this.networkDownPending && !this.roleLocked && !this.intentOnline && !this.applicationError && !this.applicationClosing,
        state: phase, message, error: error || null },
      capabilities: { model: ready, proxy: ready } };
  }
  requireBusiness(business) {
    if (this.applicationClosing || this.closing) throw conflict('客户端正在退出');
    if (this.identityChanging) throw conflict('正在切换身份，请等待完成');
    if (!this.status().capabilities[business]) throw conflict('请先在“设备与配对”完成配对或创建服务身份');
  }
  async selectIdentity(input) {
    await this.start();
    if (Object.keys(input).length !== 1 || !['host', 'client'].includes(input.role)) throw new Error('请选择调用端或服务端身份');
    if (this.identityChanging) throw conflict('正在切换身份，请等待完成');
    const check = () => { if (this.networkDownPending || this.roleLocked || this.intentOnline || this.applicationError) throw conflict('身份已锁定，请先主动断开私有网络后再切换'); };
    check();
    // Reserve the whole asynchronous revocation/commit. Login publishes its
    // intent before joining the same queue, so queueing alone cannot prevent
    // it from locking the old role while this operation commits a new one.
    this.identityChanging = true; this.emit('state');
    try { await this.enqueue(async () => {
      check();
      if (this.applicationClosing) throw conflict('客户端正在退出');
      if (this.selectedRole === input.role && (!this.saved || this.saved.role === input.role)) return this.status();
      // Revocation precedes the new role's commit. A failed write can leave a
      // stopped old identity, but can never resurrect its previous credentials.
      await this.forgetPairing();
      this.discovery.reset();
      await this.proxyController?.resetAuthorization?.();
      const model = { ...this.modelPreferences, enabled: false };
      await this.persistApplication({ role: input.role, desiredOnline: false, locked: false, model });
      this.selectedRole = input.role; this.modelPreferences = model;
      this.networkError = ''; this.modelConfigurationError = '';
      this.applyModelPreferences(); ++this.networkEpoch;
      this.log(input.role === 'host' ? '已选择服务端身份；连接私有网络后创建配对码' : '已选择调用端身份；连接私有网络后与服务端配对');
      return this.status();
    }); } finally { this.identityChanging = false; this.emit('state'); }
    return this.status();
  }
  async loginNetwork() {
    await this.start();
    if (this.networkDownPending) throw conflict('正在退出私有网络，请等待完成后重新连接');
    if (this.identityChanging) throw conflict('正在切换身份，请等待完成后连接私有网络');
    if (!this.selectedRole) throw conflict('请先选择调用端或服务端身份');
    if (this.applicationError) throw conflict('请先断开私有网络恢复身份状态');
    if (this.applicationClosing) throw conflict('客户端正在退出');
    const epoch = ++this.networkEpoch;
    this.invalidateNetworkInfo();
    this.stopRequested = false; this.intentOnline = true; this.roleLocked = true;
    this.networkTransition = 'connecting'; this.networkError = ''; this.emit('state');
    return this.enqueue(async () => {
      if (epoch !== this.networkEpoch || this.stopRequested) throw conflict('连接已取消');
      try {
        await this.persistApplication();
        if (epoch !== this.networkEpoch || this.stopRequested) return this.status();
        if (this.demo) { await super.networkInfo(true); this.demoNetworkConnected = true; }
        else if (this.networkAdapter) this.setNetwork(await this.networkAdapter.login());
        else { this.setNetwork(await this.networkProvider()); if (!this.network.running) throw new Error('请在系统 Tailscale 客户端中登录并连接'); }
        if (epoch !== this.networkEpoch || this.stopRequested) return this.status();
        this.paused = false; this.networkTransition = ''; this.networkError = '';
        this.scheduleRestore(0); this.emit('state'); return this.status();
      } catch (error) { if (epoch === this.networkEpoch) { this.networkError = error.message; this.networkTransition = ''; this.emit('state'); } throw error; }
    });
  }
  async restorePrivateNetwork(epoch) {
    if (!this.intentOnline || this.stopRequested || this.applicationClosing || epoch !== this.networkEpoch) return;
    if (this.demo) { await super.networkInfo(true); this.demoNetworkConnected = true; }
    else if (this.networkAdapter) { await this.networkAdapter.connect(); this.invalidateNetworkInfo(); }
    if (!this.intentOnline || this.stopRequested || this.applicationClosing || epoch !== this.networkEpoch) return;
    await this.networkInfo(true); this.emit('state');
  }
  disconnectNetwork() {
    if (this.networkDownPromise) return this.networkDownPromise;
    // Invalidate recovery immediately, including before startup loading ends.
    this.networkDownPending = true;
    this.stopRequested = true; this.intentOnline = false; this.paused = true;
    ++this.networkEpoch; this.cancelRestore();
    this.invalidateNetworkInfo();
    this.discovery.reset();
    this.networkDownPromise = (async () => {
      await this.start();
      this.stopRequested = true; this.intentOnline = false; this.paused = true;
      ++this.networkEpoch; this.cancelRestore();
      return this.enqueue(() => this.finishNetworkDown());
    })().finally(() => { this.networkDownPending = false; this.networkDownPromise = null; this.emit('state'); })
      .then(() => this.status());
    return this.networkDownPromise;
  }
  async finishNetworkDown() {
    this.intentOnline = false; this.paused = true; this.cancelRestore();
    let persistenceError;
    try { await this.persistApplication({ desiredOnline: false, locked: Boolean(this.selectedRole) }); }
    catch (error) { persistenceError = error; }
    await this.stopPeer();
    try {
      if (this.demo) this.demoNetworkConnected = false;
      else if (this.networkAdapter?.disconnect) this.setNetwork(await this.networkAdapter.disconnect());
      else {
        this.setNetwork(await this.networkProvider());
        if (this.network.running) throw new Error('当前使用系统 Tailscale，请先在系统客户端断开，再重试');
      }
      this.networkAt = Date.now();
      if (!this.demo && this.network?.running) throw new Error('私有网络尚未完全断开，请重试；身份仍保持锁定');
      if (persistenceError) throw new Error(`私有网络已断开，但停止状态无法保存，身份仍锁定，请重试：${persistenceError.message}`);
      await this.persistApplication({ desiredOnline: false, locked: false });
      this.roleLocked = false; this.networkTransition = ''; this.networkError = ''; this.applicationError = '';
      this.log('已主动断开私有网络；登录和配对保留，不会自动连回；现在可以切换身份');
      return this.status();
    } catch (error) { this.roleLocked = true; this.networkError = error.message; this.emit('state'); throw error; }
  }
  async requireNetworkRole(role) {
    await this.start();
    if (this.identityChanging) throw conflict('正在切换身份，请等待完成');
    if (this.selectedRole !== role) throw conflict(role === 'host' ? '当前身份不是服务端' : '当前身份不是调用端');
    if (!this.intentOnline || this.stopRequested || !this.roleLocked) throw conflict('请先连接私有网络');
    const network = await this.networkInfo(true);
    if (this.demo ? !this.demoNetworkConnected : !network?.running) throw conflict('私有网络尚未连接，请先完成登录或等待网络恢复');
    if (!this.intentOnline || this.stopRequested) throw conflict('私有网络连接已取消');
  }
  async host(input = {}) {
    if (Object.keys(input).some((key) => !['tailscaleIp', 'bridgePort'].includes(key))) throw new Error('设备配对不接受 Claude 配置，请在“模型 API”单独配置');
    await this.requireNetworkRole('host');
    return super.host(input);
  }
  async join(input) {
    await this.requireNetworkRole('client');
    const pairing = parseInvitation(input.invitation, { allowLoopback: this.demo });
    if (!this.demo && this.network?.addresses.includes(pairing.host)) throw new Error('不能将本机选作远端服务端');
    return super.join(input);
  }
  async configureModel(input) {
    await this.start(); this.requireBusiness('model');
    if (this.selectedRole !== 'host') throw conflict('仅服务端可以配置本机 Claude');
    return this.enqueue(async () => {
      this.requireBusiness('model');
      if (this.selectedRole !== 'host') throw conflict('当前身份已改变');
      const prepared = await this.prepareModel(input);
      this.requireBusiness('model');
      await this.persistApplication({ model: prepared });
      this.modelPreferences = prepared; this.modelConfigurationError = '';
      this.applyModelPreferences(); return this.status();
    });
  }
  async resume() {
    await this.start();
    if (!this.intentOnline || this.stopRequested) throw conflict('私有网络已主动断开，请先点击“连接私有网络”');
    return super.resume();
  }
  run(input, emit, signal) { this.requireBusiness('model'); return super.run(input, emit, signal); }
  close() {
    this.applicationClosing = true; ++this.networkEpoch; this.cancelRestore();
    this.invalidateNetworkInfo();
    this.discovery.close();
    if (!this.applicationClosingPromise) this.applicationClosingPromise = (async () => { await this.applicationStarting?.catch(() => {}); return super.close(); })();
    return this.applicationClosingPromise;
  }
}
