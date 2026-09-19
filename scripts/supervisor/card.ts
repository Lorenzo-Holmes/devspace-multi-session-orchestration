import { App } from "@modelcontextprotocol/ext-apps";
import { renderSupervisor } from "../../src/supervisor-view.js";
const app = new App({ name: "DevSpace Supervisor", version: "1.0.0" });
app.ontoolresult = result => {
  const target = document.getElementById("dashboard")!;
  try {
    if (result.isError) throw new Error("监督摘要读取失败");
    target.innerHTML = renderSupervisor(result.structuredContent?.summary);
  } catch { target.textContent = "未收到有效的监督摘要，请重新读取 supervisor_summary。"; }
};
void app.connect().catch(() => { document.getElementById("dashboard")!.textContent = "等待宿主连接。"; });
