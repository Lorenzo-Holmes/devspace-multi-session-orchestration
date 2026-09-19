import { supervisorSummarySchema } from "./supervisor-contracts.js";
import { renderSupervisorPresentation } from "./supervisor-presenter/render.js";
/** Keep the production v1 schema unchanged; future adapters must opt in explicitly. */
export function renderSupervisor(value: unknown, nowMs = Date.now()): string {
  return renderSupervisorPresentation(supervisorSummarySchema.parse(value), { nowMs });
}
