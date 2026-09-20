import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ValidationCommandDefinition {
  kind: "test" | "build" | "typecheck";
  checkDefinition: string;
  requiresTestCount: boolean;
}

function tokenize(command: string, allowAnd = false): string[] | undefined {
  if (!command || command.length > 32_768 || /[\r\n\x00]/.test(command)) return undefined;
  const result: string[] = [];
  let token = "", quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && command[i + 1] === quote) token += command[++i];
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { result.push(token); token = ""; } continue; }
    if (allowAnd && char === "&" && command[i + 1] === "&") {
      if (token) result.push(token);
      result.push("&&"); token = ""; i++; continue;
    }
    if (/[;&|<>`$()]/.test(char)) return undefined;
    token += char;
  }
  if (quote) return undefined;
  if (token) result.push(token);
  return result.length && result.length <= 200 ? result : undefined;
}

function direct(argv: string[]): Omit<ValidationCommandDefinition, "checkDefinition"> | undefined {
  const program = basename(argv[0] ?? "").toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, "");
  if (argv.some(arg => /^(?:--help|-h|--version|-v|--list.*|--collect-only|--eval|-e)$/i.test(arg))) return undefined;
  if (["node", "tsx"].includes(program) && argv.includes("--test")) {
    return { kind: "test", requiresTestCount: true };
  }
  if (["pytest", "jest", "vitest", "mocha"].includes(program)) {
    return { kind: "test", requiresTestCount: false };
  }
  if (["tsc", "vue-tsc"].includes(program)) return { kind: "typecheck", requiresTestCount: false };
  if (program === "vite" && argv[1] === "build") return { kind: "build", requiresTestCount: false };
  return undefined;
}

export async function identifyValidationCommand(command: string, cwd: string): Promise<ValidationCommandDefinition | undefined> {
  const top = tokenize(command);
  if (!top) return undefined;
  const definitions: string[] = [command];
  let manifestText: string | undefined;

  const resolve = async (argv: string[], depth: number): Promise<Omit<ValidationCommandDefinition, "checkDefinition"> | undefined> => {
    if (depth > 6) return undefined;
    const known = direct(argv);
    if (known) return known;
    const program = basename(argv[0] ?? "").toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, "");
    if (!["pnpm", "npm", "yarn"].includes(program)) return undefined;
    if (argv[1] === "exec") return resolve(argv.slice(2), depth + 1);
    const scriptName = argv[1] === "run" ? argv[2] : argv[1];
    const consumed = argv[1] === "run" ? 3 : 2;
    if (!scriptName || argv.length !== consumed || !/^(?:test|build|typecheck|check)(?::[\w-]+)?$/.test(scriptName)) return undefined;
    try {
      manifestText ??= await readFile(join(cwd, "package.json"), "utf8");
      if (manifestText.length > 1_048_576) return undefined;
      const parsed = JSON.parse(manifestText) as { scripts?: Record<string, unknown> };
      const script = parsed.scripts?.[scriptName];
      if (typeof script !== "string") return undefined;
      definitions.push(scriptName, script);
      const tokens = tokenize(script, true);
      if (!tokens) return undefined;
      let found: Omit<ValidationCommandDefinition, "checkDefinition"> | undefined;
      let start = 0;
      for (let index = 0; index <= tokens.length; index++) {
        if (index !== tokens.length && tokens[index] !== "&&") continue;
        const segment = tokens.slice(start, index);
        start = index + 1;
        const nested = await resolve(segment, depth + 1);
        if (nested) found = nested;
      }
      if (!found) return undefined;
      if (scriptName.startsWith("test")) return { kind: "test", requiresTestCount: found.requiresTestCount };
      if (scriptName.startsWith("build")) return { kind: "build", requiresTestCount: false };
      return { kind: "typecheck", requiresTestCount: false };
    } catch { return undefined; }
  };

  const resolved = await resolve(top, 0);
  if (!resolved) return undefined;
  const fingerprint = createHash("sha256").update(JSON.stringify(definitions)).update(manifestText ?? "").digest("hex");
  return { ...resolved, checkDefinition: `${resolved.kind}:sha256:${fingerprint}` };
}

export function hasPositiveValidationReceipt(definition: ValidationCommandDefinition, output: string): boolean {
  if (!definition.requiresTestCount) return true;
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, "");
  for (const pattern of [
    /(?:^|\n)\s*(?:#|ℹ)?\s*tests\s+(\d+)\b/g,
    /(?:^|\n)\s*(?:#|ℹ)?\s*pass\s+(\d+)\b/g,
    /(?:^|\n)\s*1\.\.(\d+)\s*(?:\r?\n|$)/g,
  ]) {
    if ([...normalized.matchAll(pattern)].some(match => Number(match[1]) > 0)) return true;
  }
  return false;
}
