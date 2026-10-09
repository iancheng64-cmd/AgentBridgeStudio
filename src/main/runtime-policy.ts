/** Exact distributions covered by native, Code Mode, MCP and real SSH loopback probes. */
export const VERIFIED_EXECUTOR_VERSIONS = ["0.159.2", "0.160.0"] as const;
export function isVerifiedExecutorVersion(version: string) { return (VERIFIED_EXECUTOR_VERSIONS as readonly string[]).includes(version); }

/** Runtime-owned extensions must not regain execution capabilities behind the Mac route. */
export const runtimeIsolationOverrides: Record<string, unknown> = {
  "features.deferred_executor": true,
  "features.apps": false,
  "features.plugins": false,
  "features.plugin_hooks": false,
  "features.hooks": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.computer_use": false,
  "features.in_app_browser": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.skip_host_skill_discovery": true,
  "features.skill_mcp_dependency_install": false,
  "features.remote_plugin": false,
};
export function isolatedRuntimeArgs() {
  return Object.entries(runtimeIsolationOverrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
export function macThreadConfig(config: any, server: { name: string; url: string; token: string; environmentId?: string } | undefined, autoCompactPercent?: number) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Runtime 未提供可驗證的設定，無法隔離遠端工具。");
  const servers = config.mcp_servers || {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("Runtime MCP 設定格式無效。");
  const overrides: Record<string, unknown> = { ...runtimeIsolationOverrides };
  // A nested map preserves server names literally, including dots and quotes.
  // The config loader recursively merges it, retaining each disabled server's transport.
  const mcpServers: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(servers)) mcpServers[name] = { enabled: false };
  // 0.160 may synthesize this connector after config/read, outside mcp_servers.
  // Supply an inert, disabled transport before thread creation; never permit it
  // merely because its current catalog is empty or authentication is pending.
  if (!Object.prototype.hasOwnProperty.call(mcpServers,"composio")) mcpServers.composio = { enabled:false, url:"http://127.0.0.1:9/mcp" };
  if (server) mcpServers[server.name] = {
    url: server.url, ...(server.environmentId ? { environment_id: server.environmentId } : {}), enabled: true, required: true,
    http_headers: { Authorization: `Bearer ${server.token}` },
    startup_timeout_sec: 20, tool_timeout_sec: 180,
  };
  overrides.mcp_servers = mcpServers;
  if (typeof autoCompactPercent === "number" && Number.isFinite(autoCompactPercent)) {
    const pct = Math.max(10, Math.min(95, Math.round(autoCompactPercent)));
    const contextWindow = Number(config?.model_context_window) || 128000;
    overrides.model_auto_compact_token_limit = Math.round(contextWindow * (pct / 100));
    overrides.model_auto_compact_token_limit_scope = "total";
  }
  return overrides;
}
export function validateMacMcpInventory(data: any[], serverName?: string) {
  if (!Array.isArray(data)) throw new Error("Runtime MCP 工具清單格式無效。");
  for (const item of data) {
    if (item.name !== serverName && (item.runtimeStatus !== "disabled" || Object.keys(item.tools || {}).length || item.resources?.length || item.resourceTemplates?.length)) throw new Error(`Runtime 仍暴露非 Mac 工具：${String(item.name).slice(0,120)}（狀態 ${String(item.runtimeStatus).slice(0,40)}，工具 ${Object.keys(item.tools || {}).length}）；已停止對話以避免在遠端執行。`);
  }
  if (serverName) {
    const local = data.find(item => item.name === serverName);
    if (!local || local.toolsError || !Object.keys(local.tools || {}).some(name => name.includes("mac_fs_read"))) throw new Error("Runtime 尚未載入 Mac 工具；請重新連線。");
  }
}
