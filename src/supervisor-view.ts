import { supervisorSummarySchema, type SupervisorSummary } from "./supervisor-contracts.js";
const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const labels: Record<keyof SupervisorSummary["counts"], string> = {
  active: "Active · 活跃", idle: "Idle · 空闲", stalled: "Stalled · 停滞", blocked: "Blocked · 受阻",
  readyReview: "Ready Review · 待审查", conflicts: "Conflicts · 冲突", alerts: "Alerts · 告警", completed: "Completed · 完成",
};
export function renderSupervisor(value: unknown): string {
  const s = supervisorSummarySchema.parse(value);
  return `<header><p class="eyebrow">DEVSPACE / SUPERVISOR</p><h1>项目监督面板</h1><p class="project">${escape(s.project)}</p><p class="meta">只读快照 · ${escape(s.generatedAt)}${s.truncated ? " · 已截断，请使用对应列表工具继续查询" : ""}</p></header>
    <div class="metrics">${Object.entries(s.counts).map(([key, value]) => `<article class="metric ${key}"><span>${escape(labels[key as keyof typeof labels])}</span><strong>${value}</strong></article>`).join("")}</div>
    <p class="notice">活动记录与心跳仅反映已观测事件，不证明模型仍在线。审查门禁按上次检查时间展示。</p>
    <div class="sections">${s.sections.map(section => `<section><h2>${escape(section.title)} <small>${section.total}</small></h2>${section.items.length ? section.items.map(row => `<details><summary><span>${escape(row.title)}</span><em>${escape(row.state)}</em></summary><p>${escape(row.detail)}</p>${row.timeline.length ? `<ol>${row.timeline.map(event => `<li><time>${escape(event.at)}</time> <b>${escape(event.kind)}</b><p>${escape(event.detail)}</p></li>`).join("")}</ol>` : ""}</details>`).join("") : '<p class="empty">暂无记录</p>'}</section>`).join("")}</div>`;
}
