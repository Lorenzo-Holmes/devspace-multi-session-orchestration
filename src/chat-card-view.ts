/** Pure display logic; estimates never authorize a server action. */
export type CardSnapshot = Record<string, unknown> & {
  probeId: string; diagnosticVersion: number; revision: number; serverNow: number; expiresAt: number;
  state: string; waitActive: boolean; waitStarted: boolean; waitOutcome: string | null;
  waitDeadlineAt: number | null; receiptPhase: string | null;
};
function deadlineNotStarted(v: Record<string, unknown>) {
  return v.waitActive === false && (v.waitStarted === false ||
    (v.waitOutcome === "answer_already_recorded" && ["answered", "cancelled"].includes(v.state as string)));
}
function displayDeadline(v: Record<string, unknown>) {
  // Observed Chat UI transport omits the initial null deadline. Restore only
  // this nullable display field when the explicit lifecycle permits no timer.
  // An active or elapsed wait must still carry its authoritative numeric deadline.
  return v.waitDeadlineAt === undefined && deadlineNotStarted(v) ? null : v.waitDeadlineAt;
}
export function cardSnapshot(value: unknown, id: string): CardSnapshot {
  const v = value as CardSnapshot | undefined;
  const diagnostic = cardSnapshotDiagnostic(value, id);
  if (diagnostic.invalidFields.length) throw new Error(`诊断回执校验失败（${diagnostic.invalidFields.join(", ")}）；操作已锁定。`);
  return { ...v!, waitDeadlineAt: displayDeadline(v!) as number | null };
}
/** Fixed field names and types only. Never log arbitrary keys, values or metadata tokens. */
export function cardSnapshotDiagnostic(value: unknown, id: string) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const checks: Record<string, boolean> = {
    probeId: v.probeId === id, diagnosticVersion: v.diagnosticVersion === 2,
    revision: Number.isFinite(v.revision), serverNow: Number.isFinite(v.serverNow), expiresAt: Number.isFinite(v.expiresAt),
    state: ["pending", "answered", "cancelled", "expired"].includes(v.state as string),
    waitActive: typeof v.waitActive === "boolean", waitStarted: typeof v.waitStarted === "boolean",
    waitDeadlineAt: Number.isFinite(displayDeadline(v)) || (displayDeadline(v) === null && deadlineNotStarted(v)),
  };
  return { inputType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    fieldTypes: Object.fromEntries(Object.keys(checks).map(key => [key, v[key] === null ? "null" : Array.isArray(v[key]) ? "array" : typeof v[key]])),
    invalidFields: Object.keys(checks).filter(key => !checks[key]),
    normalizedFields: v.waitDeadlineAt === undefined && displayDeadline(v) === null ? ["waitDeadlineAt"] : [] };
}
export function cardPresentation(v: CardSnapshot, snapshotAgeMs: number) {
  const remainingMs = Math.max(0, Math.min(v.expiresAt, v.waitDeadlineAt ?? v.expiresAt) - v.serverNow - Math.max(0, snapshotAgeMs));
  if (["answered", "cancelled"].includes(v.state)) return {
    canSubmit: false, remainingMs, text: v.state === "cancelled" ? "已取消本次诊断；没有操作任何目标。"
      : v.receiptPhase === "during_wait" ? "服务端在有效等待内收到答案；网页模型是否同轮继续仍需独立核对。"
        : v.receiptPhase === "before_wait" ? "答案在等待开始前已暂存；等待调用可以读取它，但不代表模型已继续。"
          : "答案到达服务端时，原等待已结束。仅记录迟到回执，没有恢复原请求。",
  };
  if (v.state === "expired") return { canSubmit: false, remainingMs, text: "历史卡片已过期；没有自动创建新测试。" };
  if (v.waitOutcome) return { canSubmit: false, remainingMs, text: `原等待已结束（${v.waitOutcome}）。此卡片已锁定，不会再次等待或自动补发消息。` };
  if (remainingMs === 0) return { canSubmit: false, remainingMs, text: "本地估算已到截止时间，按钮已锁定；服务端最终状态以回执为准。" };
  if (v.waitActive) return { canSubmit: true, remainingMs, text: `服务端已确认等待；按最近快照保守估算剩余约 ${Math.ceil(remainingMs / 1000)} 秒。` };
  return { canSubmit: true, remainingMs, text: "尚未确认服务端开始等待。可以提前选择并暂存答案；这不代表网页模型正在等待。" };
}
