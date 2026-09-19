import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { EXTERNAL_GOAL_PROTOCOL, UPSTREAM_AUDITED_COMMIT } from "../src/native-external-goal-contracts.js";

// Offline inspection only: never launch Codex, read authentication, or connect to a model.
const root = fileURLToPath(new URL("../", import.meta.url));
const historicalSchema = resolve(root, "../evidence/run-20260908-1215-m1/codex-schema/experimental/v2/ThreadGoalSetParams.json");
const paths = ["src/goal-manager.ts", "src/local-agent-codex.ts", "src/native-external-goal-client.ts"];
const contents = await Promise.all(paths.map(path => readFile(resolve(root, path), "utf8")));
const schemaText = await readFile(historicalSchema, "utf8");
const schema = JSON.parse(schemaText) as { title?: string; properties?: Record<string, unknown> };
if (schema.title !== "ThreadGoalSetParams" || !schema.properties) throw new Error("Unexpected historical schema; audit stopped.");
const client = contents[2]!;
const importStatements = [...client.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];/gm)].map(match => match[1]!);
const forbiddenImports = importStatements.filter(value => /child_process|local-agent|goal-manager|openai|ollama|vllm|codex-sdk/i.test(value));
if (forbiddenImports.length) throw new Error(`Forbidden direct import: ${forbiddenImports.join(", ")}`);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({
  auditKind: "offline_source_and_historical_schema_only",
  observedAt: new Date().toISOString(),
  proposedProtocol: EXTERNAL_GOAL_PROTOCOL,
  upstreamCommitReviewedViaGitHub: UPSTREAM_AUDITED_COMMIT,
  historicalSchema: { path: historicalSchema, sha256: sha(schemaText),
    properties: Object.keys(schema.properties).sort(),
    executionFieldDeclared: ["executionPolicy", "executorMode", "externalExecutor"].some(key => key in schema.properties!),
    provenance: "Existing 2026-09-08 evidence; NOT a live installed-runtime capability measurement." },
  localNativeBridge: {
    bindsCodexProvider: /provider:\s*['"]codex['"]/.test(contents[0]!),
    opensGoalSession: /runtime\.openGoalSession\(/.test(contents[0]!),
    setsActiveNativeGoal: /setNativeGoal\(threadId,\{status:'active'\}\)/.test(contents[0]!),
  },
  newClient: { directImports: importStatements, forbiddenDirectImports: forbiddenImports,
    checkScope: "Direct-import and protocol-contract checks only; not proof of native scheduler behavior." },
  sourceHashes: Object.fromEntries(paths.map((path, i) => [path, sha(contents[i]!)])),
  nativeRuntimeActivated: false,
  nativeEndToEnd: "not_run",
  deploymentDecision: "BLOCKED_UNTIL_PATCHED_NATIVE_RUNTIME_AND_REAL_NO_MODEL_ACCEPTANCE_PASS",
}, null, 2));
