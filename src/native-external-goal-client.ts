import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import {
  EXTERNAL_GOAL_PREFIX, EXTERNAL_GOAL_PROTOCOL, ExternalGoalError,
  bindingSchema, externalCapabilitiesSchema, externalCommandSchema,
  goalRefSchema, operationEnvelopeSchema, receiptSchema, sha256Schema, statusEnvelopeSchema,
  type ExternalCapabilities, type ExternalCommand, type ExternalGoalBinding,
  type ExternalGoalRef, type ExternalGoalView, type ExternalReceipt,
} from "./native-external-goal-contracts.js";
import { ExternalGoalIntentJournal, type ExternalIntent } from "./native-external-goal-journal.js";

/** Inject a supervised, authenticated transport. This client NEVER starts a process/model.
 * Its identity must come from local executable verification, not from an RPC self-report.
 */
export interface ExternalGoalTransport {
  readonly identity: { runtimeInstanceId: string; executableSha256: string };
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export interface ExternalGoalClientOptions {
  transport: ExternalGoalTransport;
  journal: ExternalGoalIntentJournal;
  binding: ExternalGoalBinding;
  trustedExecutableSha256: string;
  /** Recheck real workspace/owner authorization on EVERY read and mutation. */
  authorize: (binding: Readonly<ExternalGoalBinding>) => Promise<void>;
}

export function externalRequestFingerprint(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Preview adapter: fork endpoints must pass capability + build binding checks first.
 * No fallback to GoalManager, thread/start, thread/resume, thread/goal/set, or turn/start.
 */
export class NativeExternalGoalClient {
  private capabilities?: ExternalCapabilities;
  private readonly binding: Readonly<ExternalGoalBinding>;
  private readonly identity: Readonly<ExternalGoalTransport["identity"]>;
  private inFlight = false;

  constructor(private readonly options: ExternalGoalClientOptions) {
    this.binding = Object.freeze(bindingSchema.parse(options.binding));
    options.journal.assertBinding(this.binding);
    if (!isAbsolute(this.binding.workspaceRoot) && !win32.isAbsolute(this.binding.workspaceRoot)) {
      throw new ExternalGoalError("INVALID_WORKSPACE", "Canonical absolute workspace required.");
    }
    this.identity = Object.freeze({ ...options.transport.identity });
    sha256Schema.parse(options.trustedExecutableSha256);
    if (this.identity.executableSha256 !== options.trustedExecutableSha256) {
      throw new ExternalGoalError("UNTRUSTED_RUNTIME", "No approved external-only runtime binary is bound.");
    }
  }

  async connect(): Promise<Readonly<ExternalCapabilities>> {
    await this.options.authorize(this.binding);
    this.checkTransportIdentity();
    if (this.capabilities) return Object.freeze({ ...this.capabilities });
    let capabilities: ExternalCapabilities;
    try {
      capabilities = externalCapabilitiesSchema.parse(await this.options.transport.request(
        `${EXTERNAL_GOAL_PREFIX}capabilities`, { protocol: EXTERNAL_GOAL_PROTOCOL, ...this.binding },
      ));
      this.checkTransportIdentity();
      if (capabilities.runtimeInstanceId !== this.identity.runtimeInstanceId
        || capabilities.executableSha256 !== this.identity.executableSha256) throw new Error("identity mismatch");
      this.options.journal.bindStore(capabilities.storeId);
    } catch (cause) {
      throw new ExternalGoalError("EXTERNAL_EXECUTOR_UNAVAILABLE", "Capability/build/store verification failed; no fallback or model turn was attempted.", { cause });
    }
    this.capabilities = capabilities;
    return Object.freeze({ ...capabilities });
  }

  async status(ref: ExternalGoalRef): Promise<ExternalGoalView | null> {
    const parsed = goalRefSchema.parse(ref);
    await this.ready();
    try {
      const result = statusEnvelopeSchema.parse(await this.options.transport.request(
        `${EXTERNAL_GOAL_PREFIX}status`, { ...this.context(), ref: parsed },
      ));
      this.assertEnvelope(result);
      if (result.view && !sameRef(result.view.ref, parsed)) this.violation("Goal identity changed.");
      return result.view;
    } catch (cause) {
      this.capabilities = undefined;
      if (cause instanceof ExternalGoalError) throw cause;
      throw new ExternalGoalError("NATIVE_STATUS_UNAVAILABLE", "Status was not validated; preflight again before further operations.", { cause });
    }
  }

  async mutate(raw: ExternalCommand): Promise<ExternalReceipt> {
    // Parse strictly before network or journal writes; policy/owner fields cannot be injected.
    const command = externalCommandSchema.parse(raw);
    if (this.inFlight) throw new ExternalGoalError("OPERATION_IN_FLIGHT", "Only one mutation per client is allowed.");
    this.inFlight = true;
    try {
      await this.ready();
      const method = `${EXTERNAL_GOAL_PREFIX}${command.kind}`;
      const body = { ...this.context(), command };
      const intent: ExternalIntent = { requestKey: command.requestKey, method,
        fingerprint: externalRequestFingerprint({ method, body }) };
      // Commit the pending intent BEFORE sending. Unknown outcomes survive process restarts.
      this.options.journal.begin(intent);
      let receipt: ExternalReceipt;
      try {
        receipt = receiptSchema.parse(await this.options.transport.request(method, {
          ...body, requestFingerprint: intent.fingerprint,
        }));
        this.assertEnvelope(receipt);
        if (receipt.requestKey !== intent.requestKey || receipt.requestFingerprint !== intent.fingerprint) {
          this.violation("Mutation receipt identity mismatch.");
        }
        this.validateReceipt(command, receipt);
      } catch (cause) {
        // No polling, retry, replay, re-create, or auto-resume after an uncertain write.
        throw new ExternalGoalError("RECONCILIATION_REQUIRED", "Outcome is unknown. Keep this request key and reconcile it explicitly.", { cause });
      }
      try {
        this.options.journal.settle(intent, receipt.outcome,
          command.kind === "create" && receipt.outcome === "applied" ? receipt.view!.ref : undefined);
      } catch (cause) {
        throw new ExternalGoalError("RECONCILIATION_REQUIRED", "The native reply was received, but its local identity/intent receipt was not committed.", { cause });
      }
      return receipt;
    } finally { this.inFlight = false; }
  }

  /** One explicit read only. notFound is NOT proof that the old request cannot still commit. */
  async reconcile(): Promise<"none" | "applied" | "rejected" | "pending" | "notFound"> {
    if (this.inFlight) throw new ExternalGoalError("OPERATION_IN_FLIGHT", "The write must return before reconciliation.");
    await this.ready();
    const intent = this.options.journal.pending();
    if (!intent) return "none";
    const result = operationEnvelopeSchema.parse(await this.options.transport.request(
      `${EXTERNAL_GOAL_PREFIX}operation`, { ...this.context(), requestKey: intent.requestKey,
        requestFingerprint: intent.fingerprint },
    ));
    this.assertEnvelope(result);
    if (result.requestKey !== intent.requestKey || result.requestFingerprint !== intent.fingerprint) {
      this.violation("Reconciliation receipt identity mismatch.");
    }
    const appliedCreate = intent.method === `${EXTERNAL_GOAL_PREFIX}create` && result.state === "applied";
    if (appliedCreate !== (result.createdRef !== null)) this.violation("Create reconciliation must return exactly its original native identity.");
    if (result.state === "applied" || result.state === "rejected") {
      this.options.journal.settle(intent, result.state, result.createdRef ?? undefined);
    }
    // Do not return/replay a historical lease. Read current status and use server fencing.
    return result.state;
  }

  /** Identity receipt only. Current Goal state must still be read from the native service. */
  async createdGoalRef(requestKey: string): Promise<ExternalGoalRef | null> {
    await this.ready();
    return this.options.journal.createdRef(requestKey);
  }

  private async ready(): Promise<void> {
    if (!this.capabilities) throw new ExternalGoalError("PREFLIGHT_REQUIRED", "Connect to an audited external-only runtime first.");
    this.checkTransportIdentity();
    await this.options.authorize(this.binding);
  }

  private context(): Record<string, unknown> {
    return { protocol: EXTERNAL_GOAL_PROTOCOL, ...this.binding, storeId: this.capabilities!.storeId };
  }

  private checkTransportIdentity(): void {
    if (this.options.transport.identity.runtimeInstanceId !== this.identity.runtimeInstanceId
      || this.options.transport.identity.executableSha256 !== this.identity.executableSha256) {
      this.violation("Transport was rebound; construct and preflight a new client.");
    }
  }

  private assertEnvelope(value: { storeId: string; runtimeInstanceId: string }): void {
    this.checkTransportIdentity();
    if (value.storeId !== this.capabilities?.storeId || value.runtimeInstanceId !== this.identity.runtimeInstanceId) {
      this.violation("Native store/runtime changed.");
    }
  }

  private validateReceipt(command: ExternalCommand, receipt: ExternalReceipt): void {
    if (command.kind !== "create" && receipt.view && !sameRef(receipt.view.ref, command.ref)) {
      this.violation("Receipt refers to another Goal.");
    }
    if (receipt.outcome === "rejected") {
      if (!receipt.errorCode || receipt.lease) this.violation("Invalid rejection receipt.");
      return;
    }
    if (receipt.errorCode || !receipt.view) this.violation("Applied mutation has no valid Goal view.");
    const view = receipt.view!;
    if (command.kind !== "create") {
      if (!sameRef(view.ref, command.ref) || view.revision !== command.expectedRevision + 1) {
        this.violation("Goal identity/revision did not advance atomically.");
      }
    } else if (view.revision !== 1 || view.fence !== 0 || view.nativeStatus !== "paused" || view.externalState !== "ready") {
      this.violation("New external Goals must start paused at revision 1.");
    }
    if (command.kind === "claim") {
      if (!receipt.lease || receipt.lease.fence !== view.fence || view.nativeStatus !== "active" || view.externalState !== "leased") {
        this.violation("Claim has no valid lease.");
      }
    } else if (receipt.lease) this.violation("Unexpected lease on a non-claim result.");
    if (command.kind === "complete" && (view.nativeStatus !== "complete" || view.externalState !== "completed")) {
      this.violation("Completion was not persisted natively.");
    }
    if (command.kind === "checkpoint" && (!view.checkpointRef || view.nativeStatus !== "active" || view.externalState !== "leased")) {
      this.violation("Checkpoint was not persisted under the active lease.");
    }
    if (command.kind === "handoff" && (view.nativeStatus !== "paused" || view.externalState !== "handoff" || view.checkpointRef !== command.checkpointRef)) {
      this.violation("Handoff did not pause at the requested checkpoint.");
    }
    if (command.kind === "control") {
      const expected = { pause: "paused", resume: "ready", stop: "stopped" } as const;
      if (view.nativeStatus !== "paused" || view.externalState !== expected[command.action]) this.violation("Control state was not persisted.");
    }
    if ("leaseToken" in command) {
      if (command.kind === "checkpoint" ? view.fence !== command.fence : view.fence <= command.fence) {
        this.violation("Lease was not retained/revoked with the required fencing generation.");
      }
    }
  }

  private violation(message: string): never {
    this.capabilities = undefined;
    throw new ExternalGoalError("NATIVE_PROTOCOL_VIOLATION", message);
  }
}

function sameRef(a: ExternalGoalRef, b: ExternalGoalRef): boolean {
  return a.threadId === b.threadId && a.goalId === b.goalId;
}
