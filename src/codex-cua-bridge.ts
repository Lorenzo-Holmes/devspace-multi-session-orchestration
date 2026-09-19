// Trusted discovery and approvals remain in codex-cua-transport.ts. Its cleanup
// failures propagate so this serialized browser recovery facade can fail closed.
import { CodexCuaBridge as Transport, type CodexCuaElicit } from "./codex-cua-transport.js";
import { BoundedReconnect, type ReconnectHooks } from "./runtime-recovery/reconnect.js";
export * from "./codex-cua-transport.js";

export class CodexCuaBridge extends Transport {
  private readonly browserRecovery: BoundedReconnect<Transport>;
  private operationTail: Promise<unknown> = Promise.resolve();
  private operationCount = 0;
  private recoveryClosing = false;
  constructor(factory: () => Transport = () => new Transport(), hooks: Partial<ReconnectHooks> = {}) {
    super(); this.browserRecovery = new BoundedReconnect(factory, hooks);
  }
  private browserApproval(elicit?: CodexCuaElicit): CodexCuaElicit {
    return async params => {
      this.browserRecovery.noteApproval(true);
      const response = elicit ? await elicit(params) : { action: "cancel" as const };
      if (response.action === "accept") this.browserRecovery.noteApproval(false);
      return response;
    };
  }
  runtimeRecoveryStatus() { return this.browserRecovery.status(); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.recoveryClosing) return Promise.reject(new Error("CUA_BRIDGE_CLOSED"));
    if (this.operationCount >= 16) return Promise.reject(new Error("CUA_BRIDGE_BACKPRESSURE"));
    this.operationCount++;
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => {});
    return result.finally(() => { this.operationCount--; });
  }
  override listWindows(...args: Parameters<Transport["listWindows"]>): ReturnType<Transport["listWindows"]> {
    return this.serialize(() => super.listWindows(...args));
  }
  override getWindowState(...args: Parameters<Transport["getWindowState"]>): ReturnType<Transport["getWindowState"]> {
    return this.serialize(() => super.getWindowState(...args));
  }
  override actAndObserve(...args: Parameters<Transport["actAndObserve"]>): ReturnType<Transport["actAndObserve"]> {
    return this.serialize(() => super.actAndObserve(...args));
  }
  override getBrowserState(...args: Parameters<Transport["getBrowserState"]>): ReturnType<Transport["getBrowserState"]> {
    return this.serialize(() => this.browserRecovery.run(true, resource => resource.getBrowserState(args[0], this.browserApproval(args[1]))));
  }
  override getBrowserTabState(...args: Parameters<Transport["getBrowserTabState"]>): ReturnType<Transport["getBrowserTabState"]> {
    return this.serialize(() => this.browserRecovery.run(true, resource => resource.getBrowserTabState(args[0], args[1], args[2], this.browserApproval(args[3]))));
  }
  override browserActAndObserve(...args: Parameters<Transport["browserActAndObserve"]>): ReturnType<Transport["browserActAndObserve"]> {
    return this.serialize(() => this.browserRecovery.run(false, resource => resource.browserActAndObserve(args[0], args[1], args[2], args[3], this.browserApproval(args[4]))));
  }
  override async close(): Promise<void> {
    this.recoveryClosing = true;
    await this.operationTail.catch(() => {});
    await this.browserRecovery.close();
    await super.close();
  }
}
