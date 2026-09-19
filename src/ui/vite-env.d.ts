declare module "*.css";

interface Window {
  openai?: {
    toolOutput?: unknown;
    toolResponseMetadata?: unknown;
    callTool?: (name: string, arguments_: Record<string, unknown>) => Promise<unknown>;
  };
}
