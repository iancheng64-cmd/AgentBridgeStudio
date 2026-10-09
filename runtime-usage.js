"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenCount = tokenCount;
exports.tokenDelta = tokenDelta;
exports.rateLimitSummary = rateLimitSummary;
exports.sharedQuotaChange = sharedQuotaChange;
exports.mergeRateLimitSummary = mergeRateLimitSummary;
exports.updateUsage = updateUsage;
exports.usageTotals = usageTotals;
exports.normalizeClaudeWindowId = normalizeClaudeWindowId;
exports.claudeRateLimitSummary = claudeRateLimitSummary;
exports.mergeClaudeRateLimitSummary = mergeClaudeRateLimitSummary;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function tokenCount(value) { return { totalTokens: finite(value?.totalTokens), inputTokens: finite(value?.inputTokens), cachedInputTokens: finite(value?.cachedInputTokens), outputTokens: finite(value?.outputTokens) }; }
function tokenDelta(current, baseline) { return Object.fromEntries(Object.entries(current).map(([key, value]) => { const old = baseline?.[key]; return [key, value !== null && old !== null && old !== undefined && value >= old ? value - old : null]; })); }
function rateLimitSummary(value, at = Date.now()) {
    const window = (raw) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null; const used = finite(raw.usedPercent), duration = finite(raw.windowDurationMins), reset = finite(raw.resetsAt); if (used === null && duration === null && reset === null)
        return null; return { usedPercent: used === null ? null : Math.min(100, used), remainingPercent: used === null ? null : Math.max(0, 100 - Math.min(100, used)), windowDurationMins: duration, resetsAt: reset }; };
    const map = value?.rateLimitsByLimitId;
    const entries = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length ? Object.entries(map) : value?.rateLimits && typeof value.rateLimits === 'object' ? [[value.rateLimits.limitId || 'codex', value.rateLimits]] : [];
    const buckets = entries.map(([id, raw]) => ({ id: String(id).slice(0, 100), name: typeof raw?.limitName === 'string' ? raw.limitName.slice(0, 100) : String(id).slice(0, 100), primary: window(raw?.primary), secondary: window(raw?.secondary) }));
    return { updatedAt: at, available: buckets.some(bucket => !!(bucket.primary || bucket.secondary)), ordinaryUsageAllowed: typeof value?.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : null, buckets };
}
function sharedQuotaChange(first, last) { return last.buckets.flatMap(bucket => ['primary', 'secondary'].map(kind => { const current = bucket[kind]; const prior = first.buckets.find(old => old.id === bucket.id)?.[kind]; const sameWindow = !!current && !!prior && current.resetsAt !== null && current.resetsAt === prior.resetsAt; return { id: bucket.id, window: kind, usedPercentChange: sameWindow && current.usedPercent !== null && prior.usedPercent !== null && current.usedPercent >= prior.usedPercent ? current.usedPercent - prior.usedPercent : null, resetChanged: !!current && !!prior && current.resetsAt !== null && prior.resetsAt !== null && current.resetsAt !== prior.resetsAt }; })); }
/** Rolling notifications omit other buckets and may lack nullable metadata. */
function mergeRateLimitSummary(previous, patch, at = Date.now()) {
    const incoming = rateLimitSummary(patch, at), buckets = [...(previous?.buckets || [])];
    for (const bucket of incoming.buckets) {
        const index = buckets.findIndex(old => old.id === bucket.id), old = index >= 0 ? buckets[index] : undefined;
        const raw = patch?.rateLimitsByLimitId?.[bucket.id] || patch?.rateLimits;
        const mergeWindow = (current, next) => next ? { usedPercent: next.usedPercent ?? current?.usedPercent ?? null, remainingPercent: next.remainingPercent ?? current?.remainingPercent ?? null, windowDurationMins: next.windowDurationMins ?? current?.windowDurationMins ?? null, resetsAt: next.resetsAt ?? current?.resetsAt ?? null } : current || null;
        const merged = { ...bucket, name: typeof raw?.limitName === 'string' ? bucket.name : old?.name || bucket.name, primary: mergeWindow(old?.primary || null, bucket.primary), secondary: mergeWindow(old?.secondary || null, bucket.secondary) };
        if (index >= 0)
            buckets[index] = merged;
        else
            buckets.push(merged);
    }
    return { updatedAt: at, available: buckets.some(bucket => !!(bucket.primary || bucket.secondary)), ordinaryUsageAllowed: incoming.ordinaryUsageAllowed ?? previous?.ordinaryUsageAllowed ?? null, buckets };
}
function updateUsage(records, requestId, raw) {
    const counts = tokenCount(raw);
    return records.map(record => record.requestId === requestId ? { ...record, usage: { ...counts, complete: raw?.complete === true && counts.totalTokens !== null, source: typeof raw?.source === 'string' ? raw.source.slice(0, 100) : 'unknown', costUsd: finite(raw?.costUsd), cacheWriteTokens: finite(raw?.cacheWriteTokens) } } : record);
}
function usageTotals(records) {
    const complete = records.filter(record => record.usage?.complete && record.usage.totalTokens !== null);
    return { requests: records.length, completed: records.filter(record => record.status === 'completed').length, measured: complete.length, unmeasured: records.length - complete.length, totalTokens: complete.reduce((sum, record) => sum + record.usage.totalTokens, 0) };
}
function normalizeClaudeWindowId(id) {
    const lower = id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (lower.includes('five_hour') || lower.includes('5_hour') || lower.includes('5hour') || lower === '5h') {
        if (lower.includes('opus'))
            return 'five_hour_opus';
        if (lower.includes('sonnet'))
            return 'five_hour_sonnet';
        return 'five_hour';
    }
    if (lower.includes('seven_day') || lower.includes('7_day') || lower.includes('7day') || lower === '7d') {
        if (lower.includes('opus'))
            return 'seven_day_opus';
        if (lower.includes('sonnet'))
            return 'seven_day_sonnet';
        return 'seven_day';
    }
    return id;
}
const claudeWindowMeta = {
    five_hour: { name: '5 小時額度 (5 hour limit)', minutes: 300 },
    five_hour_opus: { name: '5 小時 Opus 額度', minutes: 300 },
    five_hour_sonnet: { name: '5 小時 Sonnet 額度', minutes: 300 },
    seven_day: { name: '7 天額度 (7 day limit)', minutes: 10080 },
    seven_day_opus: { name: '7 天 Opus 額度', minutes: 10080 },
    seven_day_sonnet: { name: '7 天 Sonnet 額度', minutes: 10080 },
    overage: { name: '超額用量', minutes: null }
};
function claudeRateLimitSummary(raw, at = Date.now()) {
    const type = typeof raw?.rateLimitType === 'string' ? raw.rateLimitType : 'unknown';
    const windows = raw?.unifiedWindows && typeof raw.unifiedWindows === 'object' && !Array.isArray(raw.unifiedWindows)
        ? Object.entries(raw.unifiedWindows)
        : (raw?.windows && Array.isArray(raw.windows) ? raw.windows.map((w) => [w.id || type, w]) : [[type, raw]]);
    return { updatedAt: at, status: typeof raw?.status === 'string' ? raw.status : 'unknown', windows: windows.map(([id, value]) => {
            const rawKey = String(id).slice(0, 100), key = normalizeClaudeWindowId(rawKey), meta = claudeWindowMeta[key] || claudeWindowMeta[rawKey];
            const util = finite(value?.utilization);
            const usedRaw = util !== null ? (util <= 1 ? util * 100 : util) : (finite(value?.usedPercent) ?? finite(value?.used_percent));
            const used = usedRaw !== null ? Math.max(0, Math.min(100, usedRaw)) : null;
            const remRaw = finite(value?.remainingPercent) ?? finite(value?.remaining_percent);
            const rem = remRaw !== null ? Math.max(0, Math.min(100, remRaw)) : (used !== null ? Math.max(0, 100 - used) : null);
            let resets = finite(value?.resetsAt);
            if (resets !== null && resets > 1e11)
                resets = Math.floor(resets / 1000);
            return { id: key, name: meta?.name || value?.name || key, usedPercent: used, remainingPercent: rem, resetsAt: resets, windowDurationMins: meta?.minutes ?? finite(value?.windowDurationMins) ?? null };
        }) };
}
function mergeClaudeRateLimitSummary(previous, raw, at = Date.now()) {
    const incoming = raw?.windows && Array.isArray(raw.windows) ? raw : claudeRateLimitSummary(raw, at);
    const windows = [...(previous?.windows || [])];
    for (const next of incoming.windows) {
        const index = windows.findIndex(old => old.id === next.id), old = index >= 0 ? windows[index] : undefined;
        const resetChanged = old?.resetsAt !== null && old?.resetsAt !== undefined && next.resetsAt !== null && next.resetsAt !== old.resetsAt;
        const merged = { ...next, name: next.name || old?.name || next.id, usedPercent: next.usedPercent ?? (resetChanged ? null : old?.usedPercent ?? null), remainingPercent: next.remainingPercent ?? (resetChanged ? null : old?.remainingPercent ?? null), resetsAt: next.resetsAt ?? old?.resetsAt ?? null, windowDurationMins: next.windowDurationMins ?? old?.windowDurationMins ?? null };
        if (index >= 0)
            windows[index] = merged;
        else
            windows.push(merged);
    }
    windows.sort((a, b) => (a.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (b.windowDurationMins ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
    return { updatedAt: at, status: incoming.status && incoming.status !== 'unknown' ? incoming.status : previous?.status || 'unknown', windows };
}
