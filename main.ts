// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// ==================== Type Definitions ====================

interface ApiKey {
    id: string;
    key: string;
    createdAt?: number;  // 导入时间戳
}

// 数据库存储结构（兼容旧数据）
interface StoredApiKey {
    key: string;
    createdAt: number;
}

interface ApiUsageData {
    id: string;
    key: string;
    fullKey: string;
    startDate: string;
    endDate: string;
    orgTotalTokensUsed: number;
    totalAllowance: number;
    usedRatio: number;
    createdAt?: number;  // 导入时间戳
}

interface ApiErrorData {
    id: string;
    key: string;
    fullKey: string;
    error: string;
    createdAt?: number;  // 导入时间戳
}

type ApiKeyResult = ApiUsageData | ApiErrorData;

interface UsageTotals {
    total_orgTotalTokensUsed: number;
    total_totalAllowance: number;
    totalRemaining: number;
}

interface AggregatedResponse {
    update_time: string;
    total_count: number;
    totals: UsageTotals;
    data: ApiKeyResult[];
}

interface ApiResponse {
    usage: {
        startDate: number;
        endDate: number;
        standard: {
            orgTotalTokensUsed: number;
            totalAllowance: number;
            usedRatio: number;
        };
    };
}

interface BatchImportResult {
    success: boolean;
    added: number;
    skipped: number;
}

interface AggregatedCacheEntry {
    version: number;
    updatedAt: number;
    payload: AggregatedResponse;
}

// ==================== Configuration ====================

const CONFIG = {
    PORT: 8000,
    API_ENDPOINT: 'https://app.factory.ai/api/organization/members/chat-usage',
    USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    TIMEZONE_OFFSET_HOURS: 8, // Beijing time
    KEY_MASK_PREFIX_LENGTH: 4,
    KEY_MASK_SUFFIX_LENGTH: 4,
    AUTO_REFRESH_INTERVAL_SECONDS: 60, // Set auto-refresh interval to 60 seconds
    EXPORT_PASSWORD: Deno.env.get("EXPORT_PASSWORD") || "admin123", // Default password for key export
    ACCESS_PASSWORD: Deno.env.get("PASSWORD") || "", // Access password for dashboard (empty = no password required)
} as const;

// KV keys / helpers
const KV_KEY_PREFIX = ["api_keys"] as const;
const KV_KEY_INDEX_PREFIX = ["api_key_index"] as const;
const KV_DATA_VERSION_KEY = ["meta", "data_version"] as const;
const KV_INDEX_READY_KEY = ["meta", "index_ready"] as const;
const KV_AGGREGATED_CACHE_KEY = ["cache", "aggregated"] as const;
const KV_REFRESH_LOCK_KEY = ["locks", "refresh"] as const;
const KV_ATOMIC_BATCH_SIZE = 4; // keep atomic ops well under the limit (each key uses 2 ops)
const REFRESH_LOCK_TTL_MS = 30_000;

// ==================== Server State and Caching (NEW) ====================

class ServerState {
    private cachedData: AggregatedResponse | null = null;
    private lastError: string | null = null;
    private isUpdating = false;
    // 追踪已删除的 key IDs 及其删除时间，防止并发刷新时数据重新出现
    private pendingDeletions: Map<string, number> = new Map();
    // 用于等待当前更新完成的 Promise
    private updatePromise: Promise<void> | null = null;
    private updateResolve: (() => void) | null = null;
    // pendingDeletions 清理的最小等待时间（毫秒），应大于自动刷新间隔
    private static readonly DELETION_CLEANUP_DELAY_MS = 120000; // 2分钟
    // 当前缓存的数据版本号（用于多实例同步）
    private cachedDataVersion: number = 0;

    // 等待当前更新完成
    async waitForUpdate(): Promise<void> {
        if (this.updatePromise) {
            await this.updatePromise;
        }
    }

    // 获取缓存的数据版本号
    getCachedDataVersion(): number {
        return this.cachedDataVersion;
    }

    // 设置缓存的数据版本号
    setCachedDataVersion(version: number): void {
        this.cachedDataVersion = version;
    }

    // 获取数据时始终过滤掉已删除的keys
    getData(): AggregatedResponse | null {
        if (!this.cachedData) return null;

        // 始终在返回数据时过滤pendingDeletions，防止任何竞态条件
        if (this.pendingDeletions.size === 0) {
            console.log(`[getData] Returning cached data directly (${this.cachedData.data.length} items)`);
            return this.cachedData;
        }

        console.log(`[getData] Filtering with ${this.pendingDeletions.size} pending deletions`);
        const filteredData = this.cachedData.data.filter(item => !this.pendingDeletions.has(item.id));
        console.log(`[getData] After filter: ${filteredData.length} items (was ${this.cachedData.data.length})`);

        // 重新计算统计值
        let totalUsed = 0, totalAllowance = 0, totalRemaining = 0;
        filteredData.forEach(item => {
            if (!('error' in item)) {
                totalUsed += item.orgTotalTokensUsed || 0;
                totalAllowance += item.totalAllowance || 0;
                totalRemaining += Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
            }
        });

        return {
            ...this.cachedData,
            total_count: filteredData.length,
            data: filteredData,
            totals: {
                total_orgTotalTokensUsed: totalUsed,
                total_totalAllowance: totalAllowance,
                totalRemaining: totalRemaining
            }
        };
    }
    
    getError = () => this.lastError;
    isCurrentlyUpdating = () => this.isUpdating;
    getPendingDeletionsSize = () => this.pendingDeletions.size;

    updateCache(data: AggregatedResponse) {
        console.log(`[updateCache] Called with ${data.data.length} items, pendingDeletions size: ${this.pendingDeletions.size}`);
        // 始终过滤掉已删除的 keys（处理并发刷新问题）
        if (this.pendingDeletions.size > 0) {
            const pendingIds = Array.from(this.pendingDeletions.keys());
            console.log(`[updateCache] Filtering out pending deletions: ${pendingIds.join(', ')}`);
            const newDataIds = new Set(data.data.map(item => item.id));
            const filteredData = data.data.filter(item => !this.pendingDeletions.has(item.id));
            console.log(`[updateCache] After filter: ${filteredData.length} items (removed ${data.data.length - filteredData.length})`);

            // 重新计算统计值
            let totalUsed = 0, totalAllowance = 0, totalRemaining = 0;
            filteredData.forEach(item => {
                if (!('error' in item)) {
                    totalUsed += item.orgTotalTokensUsed || 0;
                    totalAllowance += item.totalAllowance || 0;
                    totalRemaining += Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                }
            });

            this.cachedData = {
                ...data,
                total_count: filteredData.length,
                data: filteredData,
                totals: {
                    total_orgTotalTokensUsed: totalUsed,
                    total_totalAllowance: totalAllowance,
                    totalRemaining: totalRemaining
                }
            };

            // 清理 pendingDeletions：只移除那些满足以下条件的 key：
            // 1. 新数据中不包含该 key（说明数据库已删除）
            // 2. 删除时间已超过阈值（确保所有并发刷新都已完成）
            const now = Date.now();
            this.pendingDeletions.forEach((deletionTime, id) => {
                if (!newDataIds.has(id) && (now - deletionTime) > ServerState.DELETION_CLEANUP_DELAY_MS) {
                    console.log(`[updateCache] Cleaning up pendingDeletion: ${id}`);
                    this.pendingDeletions.delete(id);
                }
            });
        } else {
            console.log(`[updateCache] No pending deletions, setting cache directly`);
            this.cachedData = data;
        }

        this.lastError = null;
        this.isUpdating = false;
        // 通知等待者更新完成
        if (this.updateResolve) {
            this.updateResolve();
            this.updatePromise = null;
            this.updateResolve = null;
        }
    }

    setError(errorMessage: string) {
        this.lastError = errorMessage;
        this.isUpdating = false;
        // 通知等待者更新完成（即使出错）
        if (this.updateResolve) {
            this.updateResolve();
            this.updatePromise = null;
            this.updateResolve = null;
        }
    }

    startUpdate() {
        this.isUpdating = true;
        // 创建一个 Promise，让其他调用者可以等待
        if (!this.updatePromise) {
            this.updatePromise = new Promise<void>((resolve) => {
                this.updateResolve = resolve;
            });
        }
    }

    // 标记 keys 为已删除（增量更新缓存 + 记录到待删除列表）
    removeKeysFromCache(idsToRemove: string[]) {
        console.log(`[removeKeysFromCache] Removing ids: ${idsToRemove.join(', ')}`);
        // 添加到待删除列表，记录删除时间，确保后续刷新也会过滤这些 key
        const now = Date.now();
        idsToRemove.forEach(id => this.pendingDeletions.set(id, now));

        if (!this.cachedData) {
            console.log(`[removeKeysFromCache] No cached data, only added to pendingDeletions`);
            return;
        }

        const idsSet = new Set(idsToRemove);
        const beforeCount = this.cachedData.data.length;
        const removedData = this.cachedData.data.filter(item => idsSet.has(item.id));
        console.log(`[removeKeysFromCache] Found ${removedData.length} items to remove from cache (before: ${beforeCount})`);

        // 计算被移除的有效数据的统计值
        let removedUsed = 0, removedAllowance = 0, removedRemaining = 0;
        removedData.forEach(item => {
            if (!('error' in item)) {
                removedUsed += item.orgTotalTokensUsed || 0;
                removedAllowance += item.totalAllowance || 0;
                removedRemaining += Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
            }
        });

        // 更新缓存
        const newData = this.cachedData.data.filter(item => !idsSet.has(item.id));
        this.cachedData = {
            ...this.cachedData,
            total_count: newData.length,
            data: newData,
            totals: {
                total_orgTotalTokensUsed: this.cachedData.totals.total_orgTotalTokensUsed - removedUsed,
                total_totalAllowance: this.cachedData.totals.total_totalAllowance - removedAllowance,
                totalRemaining: this.cachedData.totals.totalRemaining - removedRemaining
            },
            update_time: this.cachedData.update_time
        };
        console.log(`[removeKeysFromCache] Cache updated, new count: ${this.cachedData.data.length}`);
    }
}

const serverState = new ServerState();


// ==================== Database Initialization ====================

const kv = await Deno.openKv();

// ==================== Database Operations ====================

function chunkArray<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
}

// 数据版本号管理（用于多实例同步）
async function getDataVersion(): Promise<number> {
    const result = await kv.get<number>(KV_DATA_VERSION_KEY);
    return result.value || 0;
}

async function bumpDataVersion(): Promise<number> {
    // 使用乐观锁来避免竞争，失败时重试几次
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await kv.get<number>(KV_DATA_VERSION_KEY);
        const next = (current.value || 0) + 1;
        const atomic = kv.atomic();
        if (current.versionstamp) {
            atomic.check(current);
        }
        atomic.set(KV_DATA_VERSION_KEY, next);
        const res = await atomic.commit();
        if (res.ok) return next;
    }
    const fallback = Date.now();
    await kv.set(KV_DATA_VERSION_KEY, fallback);
    return fallback;
}

async function invalidateAggregatedCache() {
    await kv.delete(KV_AGGREGATED_CACHE_KEY);
}

async function getAllKeys(): Promise<ApiKey[]> {
    const keys: ApiKey[] = [];
    const entries = kv.list<string | StoredApiKey>({ prefix: KV_KEY_PREFIX });

    for await (const entry of entries) {
        const id = entry.key[1] as string;
        const value = entry.value;

        // 兼容旧数据（字符串）和新数据（对象）
        if (typeof value === 'string') {
            keys.push({ id, key: value, createdAt: undefined });
        } else if (value && typeof value === 'object') {
            keys.push({ id, key: value.key, createdAt: value.createdAt });
        }
    }

    return keys;
}

async function ensureKeyIndexBuilt() {
    const ready = await kv.get<boolean>(KV_INDEX_READY_KEY);
    if (ready.value) return;

    const keys = await getAllKeys();
    if (keys.length === 0) {
        await kv.set(KV_INDEX_READY_KEY, true);
        return;
    }

    for (const group of chunkArray(keys, KV_ATOMIC_BATCH_SIZE * 2)) {
        const atomic = kv.atomic();
        group.forEach(({ key, id }) => {
            atomic.set([...KV_KEY_INDEX_PREFIX, key], id);
        });
        await atomic.commit();
    }

    await kv.set(KV_INDEX_READY_KEY, true);
}

async function apiKeyExists(key: string): Promise<boolean> {
    const indexed = await kv.get<string>([...KV_KEY_INDEX_PREFIX, key]);
    if (indexed.value) return true;

    // 如果索引还没构建完成，降级为全量扫描以避免重复写入
    const ready = await kv.get<boolean>(KV_INDEX_READY_KEY);
    if (!ready.value) {
        const keys = await getAllKeys();
        return keys.some(k => k.key === key);
    }
    return false;
}

async function addKeysBulk(items: ApiKey[]): Promise<number> {
    if (items.length === 0) return await getDataVersion();

    for (const group of chunkArray(items, KV_ATOMIC_BATCH_SIZE)) {
        const atomic = kv.atomic();
        group.forEach(({ id, key, createdAt }) => {
            const storedData: StoredApiKey = {
                key,
                createdAt: createdAt || Date.now()
            };
            atomic.set([...KV_KEY_PREFIX, id], storedData);
            atomic.set([...KV_KEY_INDEX_PREFIX, key], id);
        });
        const res = await atomic.commit();
        if (!res.ok) throw new Error("KV atomic commit failed during add");
    }

    const newVersion = await bumpDataVersion();
    await invalidateAggregatedCache();
    return newVersion;
}

async function getKeysByIds(ids: string[]): Promise<ApiKey[]> {
    const records = await Promise.all(ids.map(async (id): Promise<ApiKey | null> => {
        const res = await kv.get<string | StoredApiKey>([...KV_KEY_PREFIX, id]);
        if (!res.value) return null;
        if (typeof res.value === 'string') {
            return { id, key: res.value };
        }
        return { id, key: res.value.key, createdAt: res.value.createdAt };
    }));
    return records.filter(Boolean) as ApiKey[];
}

async function deleteKeysBulk(items: ApiKey[]): Promise<number> {
    if (items.length === 0) return await getDataVersion();

    for (const group of chunkArray(items, KV_ATOMIC_BATCH_SIZE)) {
        const atomic = kv.atomic();
        group.forEach(({ id, key }) => {
            atomic.delete([...KV_KEY_PREFIX, id]);
            atomic.delete([...KV_KEY_INDEX_PREFIX, key]);
        });
        const res = await atomic.commit();
        if (!res.ok) throw new Error("KV atomic commit failed during delete");
    }

    const newVersion = await bumpDataVersion();
    await invalidateAggregatedCache();
    return newVersion;
}

// ==================== Utility Functions ====================

function maskApiKey(key: string): string {
    if (key.length <= CONFIG.KEY_MASK_PREFIX_LENGTH + CONFIG.KEY_MASK_SUFFIX_LENGTH) {
        return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...`;
    }
    return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...${key.substring(key.length - CONFIG.KEY_MASK_SUFFIX_LENGTH)}`;
}

function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp && timestamp !== 0) return 'N/A';

    try {
        return new Date(timestamp).toISOString().split('T')[0];
    } catch {
        return 'Invalid Date';
    }
}

function getBeijingTime(): Date {
    return new Date(Date.now() + CONFIG.TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
}

function createJsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function createErrorResponse(message: string, status = 500): Response {
    return createJsonResponse({ error: message }, status);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// HTML content is embedded as a template string
const HTML_CONTENT = `  
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>  
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --text: #e6edf3;
            --text-secondary: #8b949e;
            --text-muted: #484f58;
            --border: #30363d;
            --accent: #58a6ff;
            --success: #3fb950;
            --danger: #f85149;
            --warning: #d29922;
            --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            --font-mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body { 
            font-family: var(--font-sans); 
            background: var(--bg);
            color: var(--text);
            min-height: 100vh; 
            padding: 48px;
            line-height: 1.6;
        }

        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

        .container { max-width: 1400px; margin: 0 auto; }

        /* Header */
        .header { 
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 32px;
            margin-bottom: 48px;
            padding-bottom: 32px;
            border-bottom: 1px solid var(--border);
        }

        .header-left h1 { 
            font-size: 32px; 
            font-weight: 600; 
            color: var(--text);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 16px;
            letter-spacing: -0.5px;
        }

        .header-left .update-time { 
            font-size: 14px; 
            color: var(--text-secondary); 
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .header-actions { display: flex; gap: 12px; flex-wrap: wrap; }

        /* Buttons */
        .btn { 
            background: transparent; 
            color: var(--text-secondary); 
            border: 1px solid var(--border); 
            border-radius: 8px; 
            padding: 12px 24px; 
            font-size: 14px; 
            font-weight: 500;
            font-family: var(--font-sans);
            cursor: pointer; 
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn:hover { 
            color: var(--text);
            border-color: var(--text-muted);
            background: var(--bg-tertiary);
        }

        .btn-primary { 
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .btn-primary:hover { 
            background: #4a9aef;
            border-color: #4a9aef;
        }

        .btn-success { color: var(--success); border-color: var(--success); }
        .btn-success:hover { background: rgba(63, 185, 80, 0.15); }

        .btn-danger { color: var(--danger); border-color: var(--danger); }
        .btn-danger:hover { background: rgba(248, 81, 73, 0.15); }

        .btn-sm {
            padding: 8px 12px;
            font-size: 13px;
            border-radius: 6px;
        }

        .btn-icon {
            padding: 8px;
            min-width: 36px;
            justify-content: center;
        }

        /* Stats Cards */
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(4, 1fr); 
            gap: 24px; 
            margin-bottom: 48px;
        }

        .stat-card { 
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px; 
            padding: 28px;
        }

        .stat-card:hover { border-color: var(--text-muted); }

        .stat-icon { 
            width: 44px; height: 44px;
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 20px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
        }

        .stat-label { 
            font-size: 14px; 
            color: var(--text-secondary); 
            font-weight: 500;
            margin-bottom: 8px;
        }

        .stat-value { 
            font-size: 36px; 
            font-weight: 600; 
            color: var(--text);
            letter-spacing: -0.5px;
        }

        .stat-value.gradient { color: var(--success); }

        /* Table */
        .table-container { 
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 16px; 
            overflow: hidden;
        }

        .table-wrapper { overflow-x: auto; }

        table { width: 100%; border-collapse: collapse; }

        th {
            text-align: left;
            padding: 14px 16px;
            color: var(--text-secondary);
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border);
            white-space: nowrap;
        }

        th.sortable {
            cursor: pointer;
            user-select: none;
            transition: background 0.2s, color 0.2s;
        }
        th.sortable:hover {
            background: var(--bg-secondary);
            color: var(--text);
        }
        th.sortable.active {
            color: var(--accent);
        }
        .sort-icon {
            margin-left: 6px;
            opacity: 0.4;
            font-size: 12px;
        }
        .sort-icon.active {
            opacity: 1;
            color: var(--accent);
        }
        .th-content {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .th-content.right {
            justify-content: flex-end;
        }

        td {
            padding: 12px 16px;
            color: var(--text);
            font-size: 14px;
            border-bottom: 1px solid var(--border);
            vertical-align: middle;
            white-space: nowrap;
        }

        tbody tr:hover { background: var(--bg-tertiary); }
        tbody tr:last-child td { border-bottom: none; }

        /* Pagination */
        .pagination-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 24px;
            border-top: 1px solid var(--border);
            background: var(--bg-secondary);
            flex-wrap: wrap;
            gap: 16px;
        }
        .pagination-info {
            color: var(--text-secondary);
            font-size: 14px;
        }
        .pagination-info strong {
            color: var(--text);
        }
        .pagination-controls {
            display: flex;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
        }
        .page-size-selector {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--text-secondary);
            font-size: 14px;
        }
        .page-size-selector select {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 10px;
            color: var(--text);
            font-size: 14px;
            cursor: pointer;
        }
        .page-size-selector select:hover {
            border-color: var(--text-muted);
        }
        .page-size-selector select:focus {
            outline: none;
            border-color: var(--accent);
        }
        .page-buttons {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .page-btn {
            min-width: 36px;
            height: 36px;
            padding: 0 12px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-secondary);
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .page-btn:hover:not(:disabled) {
            background: var(--bg);
            border-color: var(--text-muted);
            color: var(--text);
        }
        .page-btn.active {
            background: var(--accent);
            border-color: var(--accent);
            color: white;
        }
        .page-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .page-btn.nav-btn {
            font-weight: 600;
            font-size: 16px;
        }
        .page-ellipsis {
            color: var(--text-muted);
            padding: 0 8px;
        }
        .page-jump {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--text-secondary);
            font-size: 14px;
        }
        .page-jump input {
            width: 60px;
            padding: 6px 10px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text);
            font-size: 14px;
            text-align: center;
        }
        .page-jump input:focus {
            outline: none;
            border-color: var(--accent);
        }
        .page-jump input::-webkit-inner-spin-button,
        .page-jump input::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        @media (max-width: 768px) {
            .pagination-container {
                flex-direction: column;
                align-items: flex-start;
            }
            .pagination-controls {
                width: 100%;
                justify-content: space-between;
            }
            .page-buttons {
                order: -1;
                width: 100%;
                justify-content: center;
                margin-bottom: 12px;
            }
        }

        .key-cell {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .key-badge {
            font-family: var(--font-mono);
            background: var(--bg-tertiary);
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 13px;
            color: var(--text);
            border: 1px solid var(--border);
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .copy-btn {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            color: var(--accent);
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--font-sans);
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }
        .copy-btn:hover {
            background: var(--accent);
            color: var(--bg);
            border-color: var(--accent);
        }
        .copy-btn.copied {
            background: var(--success);
            color: white;
            border-color: var(--success);
        }

        .status-dot {
            display: inline-block;
            width: 8px; height: 8px;
            border-radius: 50%;
            margin-right: 10px;
        }
        .status-dot.active { background: var(--success); }
        .status-dot.warning { background: var(--warning); }
        .status-dot.danger { background: var(--danger); }

        /* Checkbox */
        .checkbox-cell {
            width: 40px;
            text-align: center;
        }
        .row-checkbox {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--accent);
        }
        .select-actions {
            display: none;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border);
        }
        .select-actions.show {
            display: flex;
        }
        .select-count {
            color: var(--text-secondary);
            font-size: 14px;
        }
        tr.selected {
            background: rgba(88, 166, 255, 0.1) !important;
        }
        .row-refreshing {
            opacity: 0.6;
            pointer-events: none;
        }

        /* Progress Bar */
        .progress-track {
            width: 100%;
            height: 6px;
            background: var(--border);
            border-radius: 3px;
            overflow: hidden;
            margin-top: 8px;
        }
        .progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease;
        }
        .progress-low { background: var(--success); }
        .progress-medium { background: var(--warning); }
        .progress-high { background: var(--danger); }

        /* FAB */
        .fab {
            position: fixed;
            bottom: 32px;
            right: 32px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: var(--text);
            color: var(--bg);
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            z-index: 100;
        }
        .fab:hover { transform: scale(1.1); background: var(--text-secondary); }

        /* Modal */
        .modal { 
            display: none; 
            position: fixed; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            background: rgba(0, 0, 0, 0.9); 
            z-index: 1000; 
            align-items: center; 
            justify-content: center;
        }
        .modal.show { display: flex; }
        
        .modal-content { 
            background: var(--bg-secondary); 
            border: 1px solid var(--border);
            border-radius: 16px; 
            width: 90%; 
            max-width: 600px; 
        }

        .modal-header { 
            padding: 24px 32px; 
            border-bottom: 1px solid var(--border);
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .modal-header h2 { font-size: 20px; font-weight: 600; }

        .close-btn { 
            background: transparent; 
            border: none; 
            color: var(--text-secondary); 
            font-size: 28px; 
            cursor: pointer; 
            line-height: 1;
        }
        .close-btn:hover { color: var(--text); }

        .modal-body { padding: 32px; }

        .form-group label { 
            display: block; 
            margin-bottom: 12px; 
            color: var(--text); 
            font-size: 15px; 
            font-weight: 500; 
        }
        .form-group textarea { 
            width: 100%; 
            padding: 16px; 
            background: var(--bg);
            border: 1px solid var(--border); 
            border-radius: 8px; 
            color: var(--text);
            font-family: var(--font-mono);
            font-size: 14px;
            min-height: 200px;
            resize: vertical;
        }
        .form-group textarea:focus { 
            outline: none; 
            border-color: var(--text-muted); 
        }

        /* Animations */
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(100%); } to { opacity: 1; transform: translateX(0); } }
        @keyframes slideOutRight { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(100%); } }

        /* Toast Styles */
        .toast-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10001;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        }
        .toast {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 14px 20px;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(12px);
            animation: slideInRight 0.3s ease;
            pointer-events: auto;
            min-width: 280px;
            max-width: 400px;
        }
        .toast.hiding {
            animation: slideOutRight 0.3s ease forwards;
        }
        .toast-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        .toast-success .toast-icon { background: rgba(16, 185, 129, 0.2); color: var(--success); }
        .toast-error .toast-icon { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
        .toast-info .toast-icon { background: rgba(59, 130, 246, 0.2); color: var(--accent); }
        .toast-content {
            flex: 1;
        }
        .toast-title {
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 2px;
        }
        .toast-message {
            font-size: 13px;
            color: var(--text-secondary);
        }
        
        .spinner { 
            width: 20px; height: 20px; 
            border: 2px solid var(--border); 
            border-top-color: var(--accent); 
            border-radius: 50%; 
            animation: spin 0.8s linear infinite; 
        }

        .loading-container { 
            text-align: center; 
            padding: 80px; 
            color: var(--text-secondary); 
            font-size: 16px;
        }
        .loading-spinner-lg {
            width: 40px; height: 40px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 24px;
        }

        /* Fade transition for content */
        .fade-in {
            animation: fadeIn 0.3s ease;
        }
        .slide-in {
            animation: slideIn 0.4s ease;
        }

        /* Theme Toggle */
        .theme-toggle {
            position: fixed;
            bottom: 100px;
            right: 32px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            color: var(--text-secondary);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            transition: all 0.3s ease;
            z-index: 100;
        }
        .theme-toggle:hover {
            background: var(--bg-tertiary);
            color: var(--text);
            border-color: var(--text-muted);
        }

        /* Light Theme */
        body.light-theme {
            --bg: #ffffff;
            --bg-secondary: #f6f8fa;
            --bg-tertiary: #eaeef2;
            --text: #1f2328;
            --text-secondary: #656d76;
            --text-muted: #8c959f;
            --border: #d0d7de;
            --accent: #0969da;
            --success: #1a7f37;
            --danger: #cf222e;
            --warning: #9a6700;
        }

        body.light-theme .fab {
            background: var(--accent);
            color: white;
        }
        body.light-theme .fab:hover {
            background: #0860ca;
        }

        body.light-theme .modal-content {
            background: var(--bg);
        }

        body.light-theme .key-badge {
            background: var(--bg-tertiary);
        }

        body.light-theme .copy-btn {
            background: var(--bg);
        }

        /* Responsive */
        @media (max-width: 1200px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 768px) {
            body { padding: 24px; }
            .header { flex-direction: column; align-items: stretch; }
            .stats-grid { grid-template-columns: 1fr; }
            .stat-value { font-size: 28px; }
            th, td { padding: 16px; font-size: 14px; }
            .fab { bottom: 20px; right: 20px; width: 48px; height: 48px; }
            .theme-toggle { bottom: 80px; right: 20px; width: 40px; height: 40px; }
        }
    </style>  
</head>  
<body>
    <div class="container">
        <div class="header">
            <div class="header-left">
                <h1>Droid API Key 监控看板</h1>
                <div class="update-time" id="updateTime">
                    <span class="spinner" style="width: 14px; height: 14px; border-width: 1px;"></span> 正在连接...
                </div>
                <div class="update-time" id="countdownTime" style="margin-left: 12px; opacity: 0.7;"></div>
            </div>
            <div class="header-actions">
                <button class="btn" onclick="openSettingsModal()" style="background: var(--bg-tertiary);">
                    ⚙️ 设置
                </button>
                <button class="btn btn-primary" onclick="openManageModal()">
                    <span>+</span> 导入 Key
                </button>
                <button class="btn btn-danger" onclick="openBatchDeleteModal()">
                    <span>-</span> 批量删除
                </button>
                <button class="btn btn-success" onclick="exportKeys()" id="exportKeysBtn">
                    导出 Key
                </button>
                <button class="btn btn-danger" onclick="deleteZeroBalanceKeys()" id="deleteZeroBtn">
                    清理无效
                </button>
                <button class="btn btn-danger" onclick="deleteAllKeys()" id="deleteAllBtn">
                    全部删除
                </button>
            </div>
        </div>

        <div class="stats-grid" id="statsCards">
            <!-- Stats will be injected here -->
        </div>

        <div class="table-container">
            <div class="select-actions" id="selectActions">
                <span class="select-count"><span id="selectedCount">0</span> 项已选择</span>
                <button class="btn btn-sm btn-primary" onclick="copySelectedKeys()">复制选中</button>
                <button class="btn btn-sm btn-danger" onclick="deleteSelectedKeys()">删除选中</button>
                <button class="btn btn-sm" onclick="clearSelection()">取消选择</button>
            </div>
            <div class="table-wrapper">
                <div id="tableContent">
                    <div class="loading-container">
                        <div class="loading-spinner-lg"></div>
                        <div>正在获取最新数据...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Theme Toggle Button -->
    <button class="theme-toggle" onclick="toggleTheme()" title="切换主题" id="themeToggle">
        <span id="themeIcon">☀️</span>
    </button>

    <!-- Refresh FAB -->
    <button class="fab" onclick="loadData()" title="刷新数据" id="refreshFab">
        <span id="refreshIcon" style="display: inline-block; transition: transform 0.3s;">↻</span>
        <span class="spinner" style="display: none;" id="spinner"></span>
    </button>

    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>批量导入 API Key</h2>
                <button class="close-btn" onclick="closeManageModal()">×</button>
            </div>
            <div class="modal-body">
                <div id="modalMessage"></div>
                <form onsubmit="batchImportKeys(event)">
                    <div class="form-group">
                        <label>请输入 API Keys（每行一个）</label>
                        <textarea id="batchKeysInput" placeholder="支持格式：&#10;fk-xxxxxxxxxxxxx&#10;my-id:fk-xxxxxxxxxxxxx"></textarea>
                    </div>
                    <div style="display: flex; gap: 12px; margin-top: 24px;">
                        <button type="submit" id="importBtn" class="btn btn-primary" style="flex: 1; justify-content: center;">开始导入</button>
                        <button type="button" class="btn" style="background: rgba(255,255,255,0.1);" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>

    <!-- Batch Delete Modal -->
    <div id="batchDeleteModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>批量删除 API Key</h2>
                <button class="close-btn" onclick="closeBatchDeleteModal()">×</button>
            </div>
            <div class="modal-body">
                <div id="batchDeleteMessage"></div>
                <form onsubmit="batchDeleteKeysByValue(event)">
                    <div class="form-group">
                        <label>请输入要删除的 API Keys（每行一个）</label>
                        <textarea id="batchDeleteKeysInput" placeholder="粘贴要删除的 Key，每行一个：&#10;fk-xxxxxxxxxxxxx&#10;fk-yyyyyyyyyyyyy"></textarea>
                    </div>
                    <div style="display: flex; gap: 12px; margin-top: 24px;">
                        <button type="submit" id="batchDeleteBtn" class="btn btn-danger" style="flex: 1; justify-content: center;">确认删除</button>
                        <button type="button" class="btn" style="background: rgba(255,255,255,0.1);" onclick="document.getElementById('batchDeleteKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>

    <!-- Settings Modal -->
    <div id="settingsModal" class="modal">
        <div class="modal-content" style="max-width: 450px;">
            <div class="modal-header">
                <h2>⚙️ 设置</h2>
                <button class="close-btn" onclick="closeSettingsModal()">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label>自动刷新间隔（秒）</label>
                    <input type="number" id="refreshIntervalInput" min="10" max="3600" value="60" style="width: 100%; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary);">
                    <small style="color: var(--text-secondary); margin-top: 6px; display: block;">设置数据自动刷新的时间间隔（10-3600秒）</small>
                </div>
                <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border);">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="color: var(--text-secondary);">密码保护状态</span>
                        <span id="passwordStatus" style="color: var(--success);">未启用</span>
                    </div>
                    <small style="color: var(--text-secondary); margin-top: 8px; display: block;">在 Deno Deploy 中设置环境变量 <code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">PASSWORD</code> 来启用密码保护</small>
                </div>
                <div style="margin-top: 24px;">
                    <button class="btn btn-primary" onclick="saveSettings()" style="width: 100%; justify-content: center;">保存设置</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Password Modal -->
    <div id="passwordModal" class="modal" style="z-index: 10000;">
        <div class="modal-content" style="max-width: 380px;">
            <div class="modal-header">
                <h2>🔐 访问验证</h2>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 20px;">此面板需要密码才能访问</p>
                <div class="form-group">
                    <label>请输入访问密码</label>
                    <input type="password" id="accessPasswordInput" placeholder="输入密码" style="width: 100%; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary);" onkeypress="if(event.key==='Enter')verifyAccessPassword()">
                </div>
                <div id="passwordError" style="color: var(--danger); margin-top: 10px; display: none;">密码错误，请重试</div>
                <div style="margin-top: 20px;">
                    <button class="btn btn-primary" onclick="verifyAccessPassword()" style="width: 100%; justify-content: center;">验证</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Custom Confirm Modal -->
    <div id="confirmModal" class="modal" style="z-index: 10002;">
        <div class="modal-content" style="max-width: 420px;">
            <div class="modal-header" style="border-bottom: none; padding-bottom: 0;">
                <h2 id="confirmTitle" style="display: flex; align-items: center; gap: 12px;">
                    <span id="confirmIcon" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px;"></span>
                    <span id="confirmTitleText">确认操作</span>
                </h2>
                <button class="close-btn" onclick="closeConfirmModal(false)">×</button>
            </div>
            <div class="modal-body" style="padding-top: 16px;">
                <p id="confirmMessage" style="color: var(--text-secondary); font-size: 15px; line-height: 1.6; margin-bottom: 24px;"></p>
                <div id="confirmInputContainer" style="display: none; margin-bottom: 20px;">
                    <input type="text" id="confirmInput" placeholder="" style="width: 100%; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 14px;">
                    <small id="confirmInputHint" style="color: var(--text-muted); margin-top: 6px; display: block;"></small>
                </div>
                <div style="display: flex; gap: 12px;">
                    <button id="confirmCancelBtn" class="btn" style="flex: 1; justify-content: center; background: var(--bg-tertiary);" onclick="closeConfirmModal(false)">取消</button>
                    <button id="confirmOkBtn" class="btn btn-danger" style="flex: 1; justify-content: center;" onclick="closeConfirmModal(true)">确认</button>
                </div>
            </div>
        </div>
    </div>
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;
        let isLoading = false;
        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';

        // 排序状态
        let sortConfig = {
            column: 'remaining',  // 默认按剩余额度排序
            direction: 'desc'     // desc = 降序, asc = 升序
        };

        // 分页状态
        let paginationConfig = {
            currentPage: 1,
            pageSize: 20,         // 每页显示条数
            pageSizeOptions: [10, 20, 50, 100]  // 可选的每页条数
        };

        // 获取分页后的数据
        function getPaginatedData(data) {
            const start = (paginationConfig.currentPage - 1) * paginationConfig.pageSize;
            const end = start + paginationConfig.pageSize;
            return data.slice(start, end);
        }

        // 计算总页数
        function getTotalPages(totalItems) {
            return Math.ceil(totalItems / paginationConfig.pageSize) || 1;
        }

        // 跳转到指定页
        function goToPage(page) {
            if (!currentApiData) return;
            const totalPages = getTotalPages(currentApiData.data.length);

            // 边界检查
            if (page < 1) page = 1;
            if (page > totalPages) page = totalPages;

            if (paginationConfig.currentPage !== page) {
                paginationConfig.currentPage = page;
                savePaginationConfig();
                displayData(currentApiData);
            }
        }

        // 上一页
        function prevPage() {
            goToPage(paginationConfig.currentPage - 1);
        }

        // 下一页
        function nextPage() {
            goToPage(paginationConfig.currentPage + 1);
        }

        // 跳转到第一页
        function firstPage() {
            goToPage(1);
        }

        // 跳转到最后一页
        function lastPage() {
            if (!currentApiData) return;
            const totalPages = getTotalPages(currentApiData.data.length);
            goToPage(totalPages);
        }

        // 修改每页条数
        function changePageSize(newSize) {
            const oldSize = paginationConfig.pageSize;
            paginationConfig.pageSize = parseInt(newSize);

            // 计算新的当前页（尽量保持查看的数据位置不变）
            const firstItemIndex = (paginationConfig.currentPage - 1) * oldSize;
            paginationConfig.currentPage = Math.floor(firstItemIndex / paginationConfig.pageSize) + 1;

            // 边界检查
            if (currentApiData) {
                const totalPages = getTotalPages(currentApiData.data.length);
                if (paginationConfig.currentPage > totalPages) {
                    paginationConfig.currentPage = totalPages;
                }
            }

            savePaginationConfig();
            if (currentApiData) {
                displayData(currentApiData);
            }
        }

        // 跳转到输入的页码
        function jumpToPage(input) {
            const page = parseInt(input.value);
            if (!isNaN(page)) {
                goToPage(page);
            }
            // 恢复显示当前实际页码
            input.value = paginationConfig.currentPage;
        }

        // 保存分页配置到 localStorage
        function savePaginationConfig() {
            localStorage.setItem('paginationConfig', JSON.stringify({
                pageSize: paginationConfig.pageSize
                // 注意：不保存 currentPage，每次刷新从第一页开始
            }));
        }

        // 初始化分页配置
        function initPaginationConfig() {
            const saved = localStorage.getItem('paginationConfig');
            if (saved) {
                try {
                    const config = JSON.parse(saved);
                    if (config.pageSize) {
                        paginationConfig.pageSize = config.pageSize;
                    }
                } catch (e) {
                    // 使用默认值
                }
            }
        }

        // 验证并修正当前页（用于删除操作后）
        function validateCurrentPage() {
            if (!currentApiData) return;
            const totalPages = getTotalPages(currentApiData.data.length);
            if (paginationConfig.currentPage > totalPages) {
                paginationConfig.currentPage = Math.max(1, totalPages);
            }
        }

        // 生成分页控件 HTML
        function generatePaginationHTML(totalItems) {
            const totalPages = getTotalPages(totalItems);
            const currentPage = paginationConfig.currentPage;

            // 生成页码按钮
            let pageButtons = '';
            const maxVisiblePages = 5;
            let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
            let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

            // 调整起始页
            if (endPage - startPage + 1 < maxVisiblePages) {
                startPage = Math.max(1, endPage - maxVisiblePages + 1);
            }

            // 第一页按钮
            if (startPage > 1) {
                pageButtons += \`<button class="page-btn" onclick="goToPage(1)">1</button>\`;
                if (startPage > 2) {
                    pageButtons += \`<span class="page-ellipsis">...</span>\`;
                }
            }

            // 中间页码
            for (let i = startPage; i <= endPage; i++) {
                pageButtons += \`<button class="page-btn \${i === currentPage ? 'active' : ''}" onclick="goToPage(\${i})">\${i}</button>\`;
            }

            // 最后一页按钮
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    pageButtons += \`<span class="page-ellipsis">...</span>\`;
                }
                pageButtons += \`<button class="page-btn" onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
            }

            return \`
                <div class="pagination-container">
                    <div class="pagination-info">
                        共 <strong>\${totalItems}</strong> 条记录，
                        第 <strong>\${currentPage}</strong> / <strong>\${totalPages}</strong> 页
                    </div>
                    <div class="pagination-controls">
                        <div class="page-size-selector">
                            <label>每页</label>
                            <select onchange="changePageSize(this.value)">
                                \${paginationConfig.pageSizeOptions.map(size =>
                                    \`<option value="\${size}" \${size === paginationConfig.pageSize ? 'selected' : ''}>\${size}</option>\`
                                ).join('')}
                            </select>
                            <label>条</label>
                        </div>
                        <div class="page-buttons">
                            <button class="page-btn nav-btn" onclick="firstPage()" \${currentPage === 1 ? 'disabled' : ''} title="第一页">«</button>
                            <button class="page-btn nav-btn" onclick="prevPage()" \${currentPage === 1 ? 'disabled' : ''} title="上一页">‹</button>
                            \${pageButtons}
                            <button class="page-btn nav-btn" onclick="nextPage()" \${currentPage === totalPages ? 'disabled' : ''} title="下一页">›</button>
                            <button class="page-btn nav-btn" onclick="lastPage()" \${currentPage === totalPages ? 'disabled' : ''} title="最后一页">»</button>
                        </div>
                        <div class="page-jump">
                            <label>跳至</label>
                            <input type="number" min="1" max="\${totalPages}" value="\${currentPage}"
                                   onkeypress="if(event.key==='Enter')jumpToPage(this)"
                                   onblur="jumpToPage(this)">
                            <label>页</label>
                        </div>
                    </div>
                </div>
            \`;
        }

        // 排序函数
        function sortData(data, column, direction) {
            const sorted = [...data];

            sorted.sort((a, b) => {
                // 错误的 key 排在最后
                const aHasError = 'error' in a;
                const bHasError = 'error' in b;
                if (aHasError && !bHasError) return 1;
                if (!aHasError && bHasError) return -1;
                if (aHasError && bHasError) return 0;

                let aVal, bVal;

                switch (column) {
                    case 'key':
                        aVal = a.key || '';
                        bVal = b.key || '';
                        break;
                    case 'createdAt':
                        aVal = a.createdAt || 0;
                        bVal = b.createdAt || 0;
                        break;
                    case 'endDate':
                        aVal = a.endDate ? new Date(a.endDate).getTime() : 0;
                        bVal = b.endDate ? new Date(b.endDate).getTime() : 0;
                        break;
                    case 'totalAllowance':
                        aVal = a.totalAllowance || 0;
                        bVal = b.totalAllowance || 0;
                        break;
                    case 'used':
                        aVal = a.orgTotalTokensUsed || 0;
                        bVal = b.orgTotalTokensUsed || 0;
                        break;
                    case 'remaining':
                        aVal = Math.max(0, (a.totalAllowance || 0) - (a.orgTotalTokensUsed || 0));
                        bVal = Math.max(0, (b.totalAllowance || 0) - (b.orgTotalTokensUsed || 0));
                        break;
                    case 'usedRatio':
                        aVal = a.usedRatio || 0;
                        bVal = b.usedRatio || 0;
                        break;
                    default:
                        return 0;
                }

                if (typeof aVal === 'string') {
                    return direction === 'asc'
                        ? aVal.localeCompare(bVal)
                        : bVal.localeCompare(aVal);
                }

                return direction === 'asc' ? aVal - bVal : bVal - aVal;
            });

            return sorted;
        }

        // 切换排序
        function toggleSort(column) {
            if (sortConfig.column === column) {
                // 同一列，切换方向
                sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
            } else {
                // 不同列，默认降序
                sortConfig.column = column;
                sortConfig.direction = 'desc';
            }

            // 排序时重置到第一页（重要：避免排序后当前页超出范围或数据不连贯）
            paginationConfig.currentPage = 1;

            // 保存排序偏好到 localStorage
            localStorage.setItem('sortConfig', JSON.stringify(sortConfig));

            // 重新渲染表格
            if (currentApiData) {
                displayData(currentApiData);
            }
        }

        // 获取排序图标
        function getSortIcon(column) {
            if (sortConfig.column !== column) {
                return '<span class="sort-icon">⇅</span>';
            }
            return sortConfig.direction === 'asc'
                ? '<span class="sort-icon active">↑</span>'
                : '<span class="sort-icon active">↓</span>';
        }

        // 初始化排序配置
        function initSortConfig() {
            const saved = localStorage.getItem('sortConfig');
            if (saved) {
                try {
                    sortConfig = JSON.parse(saved);
                } catch (e) {
                    // 使用默认值
                }
            }
        }

        // 计算距离到期还有多少天
        function getDaysUntilExpiry(endDateStr) {
            if (!endDateStr || endDateStr === 'N/A') return Infinity;
            try {
                const endDate = new Date(endDateStr);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                endDate.setHours(0, 0, 0, 0);
                const diffTime = endDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                return diffDays;
            } catch {
                return Infinity;
            }
        }

        // 获取日期显示样式
        function getDateStyle(endDateStr) {
            const daysLeft = getDaysUntilExpiry(endDateStr);
            if (daysLeft <= 0) {
                return 'color: var(--danger); font-weight: 600;'; // 已过期
            } else if (daysLeft <= 5) {
                return 'color: var(--danger);'; // 5天内到期
            } else if (daysLeft <= 10) {
                return 'color: var(--warning);'; // 10天内到期
            }
            return 'color: var(--text-secondary);'; // 正常
        }

        // 获取到期提示文字
        function getExpiryTooltip(endDateStr) {
            const daysLeft = getDaysUntilExpiry(endDateStr);
            if (daysLeft <= 0) {
                return '已过期';
            } else if (daysLeft === 1) {
                return '明天到期';
            } else if (daysLeft <= 5) {
                return daysLeft + '天后到期';
            }
            return '';
        }

        // 格式化导入时间
        function formatCreatedAt(timestamp) {
            if (!timestamp) return '-';
            try {
                const date = new Date(timestamp);
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                return month + '-' + day + ' ' + hours + ':' + minutes;
            } catch {
                return '-';
            }
        }

        // 获取导入时间的完整格式（用于 tooltip）
        function getCreatedAtFull(timestamp) {
            if (!timestamp) return '未知';
            try {
                const date = new Date(timestamp);
                return date.toLocaleString('zh-CN');
            } catch {
                return '未知';
            }
        }  

        // Theme Toggle Function
        function toggleTheme() {
            const body = document.body;
            const themeIcon = document.getElementById('themeIcon');
            const isLight = body.classList.toggle('light-theme');
            themeIcon.textContent = isLight ? '🌙' : '☀️';
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
        }

        // Initialize theme from localStorage
        function initTheme() {
            const savedTheme = localStorage.getItem('theme');
            const themeIcon = document.getElementById('themeIcon');
            if (savedTheme === 'light') {
                document.body.classList.add('light-theme');
                themeIcon.textContent = '🌙';
            }
        }

        // Toast 提示函数
        function showToast(title, message, type = 'info', duration = 3000) {
            const container = document.getElementById('toastContainer');
            const icons = {
                success: '✓',
                error: '✕',
                info: 'ℹ'
            };
            
            const toast = document.createElement('div');
            toast.className = 'toast toast-' + type;
            toast.innerHTML = \`
                <div class="toast-icon">\${icons[type] || icons.info}</div>
                <div class="toast-content">
                    <div class="toast-title">\${title}</div>
                    \${message ? '<div class="toast-message">' + message + '</div>' : ''}
                </div>
            \`;
            
            container.appendChild(toast);
            
            setTimeout(() => {
                toast.classList.add('hiding');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }

        // Custom Confirm Modal Functions
        let confirmResolve = null;
        let confirmRequiredInput = null;
        
        function showConfirm(options) {
            return new Promise((resolve) => {
                confirmResolve = resolve;
                confirmRequiredInput = options.requiredInput || null;
                
                const modal = document.getElementById('confirmModal');
                const iconEl = document.getElementById('confirmIcon');
                const titleEl = document.getElementById('confirmTitleText');
                const messageEl = document.getElementById('confirmMessage');
                const okBtn = document.getElementById('confirmOkBtn');
                const inputContainer = document.getElementById('confirmInputContainer');
                const inputEl = document.getElementById('confirmInput');
                const inputHint = document.getElementById('confirmInputHint');
                
                const type = options.type || 'warning';
                if (type === 'danger') {
                    iconEl.style.background = 'rgba(248, 81, 73, 0.15)';
                    iconEl.style.color = 'var(--danger)';
                    iconEl.textContent = '⚠️';
                    okBtn.className = 'btn btn-danger';
                } else if (type === 'warning') {
                    iconEl.style.background = 'rgba(210, 153, 34, 0.15)';
                    iconEl.style.color = 'var(--warning)';
                    iconEl.textContent = '⚠️';
                    okBtn.className = 'btn btn-danger';
                } else {
                    iconEl.style.background = 'rgba(88, 166, 255, 0.15)';
                    iconEl.style.color = 'var(--accent)';
                    iconEl.textContent = 'ℹ️';
                    okBtn.className = 'btn btn-primary';
                }
                
                titleEl.textContent = options.title || '确认操作';
                messageEl.textContent = options.message || '确定要执行此操作吗？';
                okBtn.textContent = options.confirmText || '确认';
                okBtn.style.flex = '1';
                okBtn.style.justifyContent = 'center';
                
                if (confirmRequiredInput) {
                    inputContainer.style.display = 'block';
                    inputEl.value = '';
                    inputEl.placeholder = '请输入 "' + confirmRequiredInput + '"';
                    inputHint.textContent = '请输入上方引号内的内容以确认操作';
                    inputEl.onkeypress = (e) => {
                        if (e.key === 'Enter') closeConfirmModal(true);
                    };
                } else {
                    inputContainer.style.display = 'none';
                }
                
                modal.classList.add('show');
                
                setTimeout(() => {
                    if (confirmRequiredInput) {
                        inputEl.focus();
                    } else {
                        okBtn.focus();
                    }
                }, 100);
            });
        }
        
        function closeConfirmModal(confirmed) {
            const modal = document.getElementById('confirmModal');
            const inputEl = document.getElementById('confirmInput');
            
            if (confirmed && confirmRequiredInput) {
                if (inputEl.value !== confirmRequiredInput) {
                    inputEl.style.borderColor = 'var(--danger)';
                    inputEl.focus();
                    showToast('输入错误', '请输入正确的确认文本', 'error', 2000);
                    return;
                }
            }
            
            inputEl.style.borderColor = '';
            modal.classList.remove('show');
            
            if (confirmResolve) {
                confirmResolve(confirmed);
                confirmResolve = null;
            }
            confirmRequiredInput = null;
        }

        // Cookie 工具函数
        function setCookie(name, value, days) {
            const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
            document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/';
        }
        
        function getCookie(name) {
            const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
            return match ? decodeURIComponent(match[2]) : null;
        }

        // 密码验证相关
        let isAuthenticated = false;

        async function checkPasswordRequired() {
            try {
                const response = await fetch('/api/auth/check');
                const data = await response.json();
                
                // 更新设置页面的密码状态
                const statusEl = document.getElementById('passwordStatus');
                if (statusEl) {
                    if (data.required) {
                        statusEl.textContent = '已启用';
                        statusEl.style.color = 'var(--accent)';
                    } else {
                        statusEl.textContent = '未启用';
                        statusEl.style.color = 'var(--text-secondary)';
                    }
                }
                
                if (data.required) {
                    // 检查 cookie 是否有有效的密码
                    const savedAuth = getCookie('auth_token');
                    if (savedAuth === 'verified') {
                        isAuthenticated = true;
                        return;
                    }
                    // 显示密码弹窗
                    document.getElementById('passwordModal').classList.add('show');
                } else {
                    isAuthenticated = true;
                }
            } catch (error) {
                console.error('检查密码失败:', error);
                isAuthenticated = true; // 出错时允许访问
            }
        }

        async function verifyAccessPassword() {
            const password = document.getElementById('accessPasswordInput').value;
            const errorEl = document.getElementById('passwordError');
            
            try {
                const response = await fetch('/api/auth/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                
                if (response.ok) {
                    // 保存到 cookie，7 天过期
                    setCookie('auth_token', 'verified', 7);
                    isAuthenticated = true;
                    document.getElementById('passwordModal').classList.remove('show');
                    errorEl.style.display = 'none';
                } else {
                    errorEl.style.display = 'block';
                    document.getElementById('accessPasswordInput').value = '';
                }
            } catch (error) {
                errorEl.textContent = '网络错误，请重试';
                errorEl.style.display = 'block';
            }
        }

        // 设置相关
        let autoRefreshInterval = null;
        let refreshIntervalSeconds = 60;

        function openSettingsModal() {
            const savedInterval = localStorage.getItem('refreshInterval') || 60;
            document.getElementById('refreshIntervalInput').value = savedInterval;
            document.getElementById('settingsModal').classList.add('show');
        }

        function closeSettingsModal() {
            document.getElementById('settingsModal').classList.remove('show');
        }

        function saveSettings() {
            const interval = parseInt(document.getElementById('refreshIntervalInput').value) || 60;
            const clampedInterval = Math.min(3600, Math.max(10, interval));
            
            localStorage.setItem('refreshInterval', clampedInterval);
            refreshIntervalSeconds = clampedInterval;
            
            // 重新设置自动刷新和倒计时
            resetCountdown();
            
            closeSettingsModal();
            showToast('设置已保存', '自动刷新间隔: ' + clampedInterval + ' 秒', 'success');
        }

        // 倒计时相关变量
        let countdownSeconds = 60;
        let countdownTimer = null;

        function updateCountdownDisplay() {
            const countdownEl = document.getElementById('countdownTime');
            if (countdownEl && countdownSeconds > 0) {
                const mins = Math.floor(countdownSeconds / 60);
                const secs = countdownSeconds % 60;
                if (mins > 0) {
                    countdownEl.textContent = '下次刷新: ' + mins + '分' + secs + '秒';
                } else {
                    countdownEl.textContent = '下次刷新: ' + secs + '秒';
                }
            }
        }

        function startCountdown() {
            // 清除现有倒计时
            if (countdownTimer) {
                clearInterval(countdownTimer);
            }
            
            countdownSeconds = refreshIntervalSeconds;
            updateCountdownDisplay();
            
            countdownTimer = setInterval(() => {
                countdownSeconds--;
                if (countdownSeconds <= 0) {
                    countdownSeconds = refreshIntervalSeconds;
                }
                updateCountdownDisplay();
            }, 1000);
        }

        function resetCountdown() {
            // 清除现有定时器
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
            }
            if (countdownTimer) {
                clearInterval(countdownTimer);
            }
            
            // 重新开始倒计时和自动刷新
            countdownSeconds = refreshIntervalSeconds;
            updateCountdownDisplay();
            
            autoRefreshInterval = setInterval(loadData, refreshIntervalSeconds * 1000);
            countdownTimer = setInterval(() => {
                countdownSeconds--;
                if (countdownSeconds <= 0) {
                    countdownSeconds = refreshIntervalSeconds;
                }
                updateCountdownDisplay();
            }, 1000);
        }

        function initAutoRefresh() {
            refreshIntervalSeconds = parseInt(localStorage.getItem('refreshInterval')) || 60;
            autoRefreshInterval = setInterval(loadData, refreshIntervalSeconds * 1000);
            startCountdown();
        }
  
        function loadData(retryCount = 0, isInitial = false) {
            if (isLoading) return;
            isLoading = true;

            const spinner = document.getElementById('spinner');  
            const refreshIcon = document.getElementById('refreshIcon');
            const refreshFab = document.getElementById('refreshFab');
            const updateTime = document.getElementById('updateTime');
            const tableContent = document.getElementById('tableContent');

            // Show loading state (只更新按钮和时间，不清空表格)
            spinner.style.display = 'inline-block';  
            refreshIcon.style.display = 'none';
            refreshFab.style.pointerEvents = 'none';
            
            // 如果是初次加载或表格为空，显示加载提示
            if (isInitial || !currentApiData) {
                updateTime.innerHTML = '<span class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></span> 加载中...';
            } else {
                // 刷新时只更新时间区域
                updateTime.innerHTML = '<span class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></span> 刷新中...';
            }
  
            fetch('/api/data?t=' + new Date().getTime())  
                .then(response => {  
                    if (response.status === 503 && retryCount < 5) {
                        console.log(\`Server initializing, retrying in 2 seconds... (attempt \${retryCount + 1}/5)\`);
                        if (!currentApiData) {
                            tableContent.innerHTML = \`<div class="loading-container"><div class="loading-spinner-lg"></div><div>服务器正在初始化数据... (尝试 \${retryCount + 1}/5)</div></div>\`;
                        }
                        setTimeout(() => {
                            isLoading = false;
                            loadData(retryCount + 1, isInitial);
                        }, 2000);
                        return null;
                    }
                    if (!response.ok) throw new Error('无法加载数据: ' + response.statusText);  
                    return response.json();  
                })  
                .then(data => {
                    if (data === null) return;
                    if (data.error) throw new Error(data.error);  
                    displayData(data);
                    // 数据加载成功后重置倒计时
                    countdownSeconds = refreshIntervalSeconds;
                    updateCountdownDisplay();
                })  
                .catch(error => {
                    if (!currentApiData) {
                        tableContent.innerHTML = \`<div class="loading-container" style="color: var(--danger)">加载失败: \${error.message}</div>\`;
                    }
                    document.getElementById('updateTime').innerHTML = '<span style="color: var(--danger);">加载失败</span>';  
                })  
                .finally(() => {
                    isLoading = false;
                    spinner.style.display = 'none';  
                    refreshIcon.style.display = 'inline-block';
                    refreshFab.style.pointerEvents = 'auto';
                });  
        }  
  
        function displayData(data) {
            currentApiData = data;
            document.getElementById('updateTime').innerHTML = \`最后更新: \${data.update_time} <span style="margin: 0 8px; opacity: 0.3">|</span> 共 \${data.total_count} 个 Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;
            const progressClass = overallRatio < 0.5 ? 'progress-low' : overallRatio < 0.8 ? 'progress-medium' : 'progress-high';

            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card slide-in" style="animation-delay: 0ms;">
                    <div class="stat-icon" style="color: var(--accent); background: rgba(88, 166, 255, 0.1);"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M15 9.5c-1-1-2.5-1-3.5 0s-1 2.5 0 3.5 2.5 1 3.5 0M9 14.5c1 1 2.5 1 3.5 0"/></svg></div>
                    <div class="stat-label">总计额度</div>
                    <div class="stat-value">\${formatNumber(totalAllowance)}</div>
                </div>  
                <div class="stat-card slide-in" style="animation-delay: 50ms;">
                    <div class="stat-icon" style="color: var(--warning); background: rgba(210, 153, 34, 0.1);"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></div>
                    <div class="stat-label">已使用</div>
                    <div class="stat-value">\${formatNumber(totalUsed)}</div>
                </div>  
                <div class="stat-card slide-in" style="animation-delay: 100ms;">
                    <div class="stat-icon" style="color: var(--success); background: rgba(63, 185, 80, 0.1);"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
                    <div class="stat-label">剩余额度</div>
                    <div class="stat-value gradient">\${formatNumber(totalRemaining)}</div>
                </div>  
                <div class="stat-card slide-in" style="animation-delay: 150ms;">
                    <div class="stat-icon" style="color: var(--danger); background: rgba(248, 81, 73, 0.1);"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
                    <div class="stat-label">使用率</div>
                    <div class="stat-value">\${formatPercentage(overallRatio)}</div>
                    <div class="progress-track"><div class="progress-fill \${progressClass}" style="width: \${Math.min(overallRatio * 100, 100)}%"></div></div>
                </div>  
            \`;  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th class="checkbox-cell"><input type="checkbox" class="row-checkbox" id="selectAll" onchange="toggleSelectAll(this)"></th>
                            <th class="sortable \${sortConfig.column === 'key' ? 'active' : ''}" onclick="toggleSort('key')">
                                <div class="th-content">API Key \${getSortIcon('key')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'createdAt' ? 'active' : ''}" onclick="toggleSort('createdAt')">
                                <div class="th-content">导入时间 \${getSortIcon('createdAt')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'endDate' ? 'active' : ''}" onclick="toggleSort('endDate')">
                                <div class="th-content">有效期 \${getSortIcon('endDate')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'totalAllowance' ? 'active' : ''}" onclick="toggleSort('totalAllowance')" style="text-align: right;">
                                <div class="th-content right">总额度 \${getSortIcon('totalAllowance')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'used' ? 'active' : ''}" onclick="toggleSort('used')" style="text-align: right;">
                                <div class="th-content right">已使用 \${getSortIcon('used')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'remaining' ? 'active' : ''}" onclick="toggleSort('remaining')" style="text-align: right;">
                                <div class="th-content right">剩余 \${getSortIcon('remaining')}</div>
                            </th>
                            <th class="sortable \${sortConfig.column === 'usedRatio' ? 'active' : ''}" onclick="toggleSort('usedRatio')" style="width: 160px;">
                                <div class="th-content">使用率 \${getSortIcon('usedRatio')}</div>
                            </th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;

            // 使用当前排序配置排序数据
            const sortedData = sortData(data.data, sortConfig.column, sortConfig.direction);

            // 验证当前页是否有效
            const totalPages = getTotalPages(sortedData.length);
            if (paginationConfig.currentPage > totalPages) {
                paginationConfig.currentPage = Math.max(1, totalPages);
            }

            // 分页：获取当前页的数据
            const paginatedData = getPaginatedData(sortedData);

            paginatedData.forEach(item => {
                const rawKey = item.fullKey || item.key || '';
                const copyValue = JSON.stringify(rawKey);
                const isSelected = selectedKeys.has(item.id);
                const selectedClass = isSelected ? 'selected' : '';
                const checkedAttr = isSelected ? 'checked' : '';

                if (item.error) {
                    tableHTML += \`
                        <tr id="key-row-\${item.id}" data-key-id="\${item.id}" class="\${selectedClass}">
                            <td class="checkbox-cell"><input type="checkbox" class="row-checkbox" data-id="\${item.id}" onchange="updateSelection()" \${checkedAttr}></td>
                            <td>
                                <div class="key-cell">
                                    <span class="key-badge" title="\${item.key}">\${item.key}</span>
                                    <button class="copy-btn" onclick='copyKey(\${copyValue}, this)' title="复制">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                    </button>
                                </div>
                            </td>
                            <td style="color: var(--text-muted); font-size: 13px;" title="\${getCreatedAtFull(item.createdAt)}">\${formatCreatedAt(item.createdAt)}</td>
                            <td colspan="5" style="color: var(--danger); font-weight: 500;">\${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-sm" onclick="refreshSingleKey('\${item.id}', this)">↻</button>
                                <button class="btn btn-sm btn-danger" style="margin-left: 6px;" onclick="deleteKeyFromTable('\${item.id}')">×</button>
                            </td>
                        </tr>\`;
                } else {
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    const ratio = item.usedRatio || 0;
                    const progressClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';
                    const statusDot = remaining > 0 ? 'active' : 'danger';

                    tableHTML += \`
                        <tr id="key-row-\${item.id}" data-key-id="\${item.id}" class="\${selectedClass}">
                            <td class="checkbox-cell"><input type="checkbox" class="row-checkbox" data-id="\${item.id}" onchange="updateSelection()" \${checkedAttr}></td>
                            <td>
                                <div class="key-cell">
                                    <span class="status-dot \${statusDot}"></span>
                                    <span class="key-badge" title="\${item.key}">\${item.key}</span>
                                    <button class="copy-btn" onclick='copyKey(\${copyValue}, this)' title="复制">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                    </button>
                                </div>
                            </td>
                            <td style="color: var(--text-muted); font-size: 13px;" title="\${getCreatedAtFull(item.createdAt)}">\${formatCreatedAt(item.createdAt)}</td>
                            <td style="\${getDateStyle(item.endDate)}" title="\${getExpiryTooltip(item.endDate)}">\${item.startDate} ~ \${item.endDate}\${getExpiryTooltip(item.endDate) ? ' ⚠️' : ''}</td>
                            <td style="text-align: right;">\${formatNumber(item.totalAllowance)}</td>
                            <td style="text-align: right;">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td style="text-align: right; color: \${remaining > 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: 600;">\${formatNumber(remaining)}</td>
                            <td>
                                <div style="display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px;">
                                    <span>\${formatPercentage(ratio)}</span>
                                </div>
                                <div class="progress-track"><div class="progress-fill \${progressClass}" style="width: \${Math.min(ratio * 100, 100)}%"></div></div>
                            </td>
                            <td style="text-align: center; white-space: nowrap;">
                                <button class="btn btn-sm" onclick="refreshSingleKey('\${item.id}', this)" title="刷新">↻</button>
                                <button class="btn btn-sm btn-danger" style="margin-left: 6px;" onclick="deleteKeyFromTable('\${item.id}')" title="删除">×</button>
                            </td>
                        </tr>\`;
                }
            });

            tableHTML += \`</tbody></table>\`;

            // 添加分页控件
            tableHTML += generatePaginationHTML(sortedData.length);

            document.getElementById('tableContent').innerHTML = tableHTML;
            // Add fade-in animation
            document.getElementById('tableContent').classList.add('fade-in');

            // 更新全选 checkbox 状态和选择计数
            updateSelectionUI();
            const allCheckboxes = document.querySelectorAll('tbody .row-checkbox');
            const checkedCheckboxes = document.querySelectorAll('tbody .row-checkbox:checked');
            const selectAllCheckbox = document.getElementById('selectAll');
            if (selectAllCheckbox && allCheckboxes.length > 0) {
                selectAllCheckbox.checked = checkedCheckboxes.length === allCheckboxes.length;
                selectAllCheckbox.indeterminate = checkedCheckboxes.length > 0 && checkedCheckboxes.length < allCheckboxes.length;
            }
        }  
  
        document.addEventListener('DOMContentLoaded', async () => {
            initTheme();
            initSortConfig();       // 初始化排序配置
            initPaginationConfig(); // 初始化分页配置
            await checkPasswordRequired();  // 先检查密码
            loadData(0, true);  // 初次加载
            initAutoRefresh();  // 初始化自动刷新
        });

        // Copy Key Function - 复制单个 Key
        function copyKey(key, btn) {
            navigator.clipboard.writeText(key).then(() => {
                // 按钮变绿显示勾
                btn.style.background = 'var(--success)';
                btn.style.borderColor = 'var(--success)';
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
                
                showToast('复制成功', key.substring(0, 10) + '...', 'success', 2000);
                
                // 1秒后恢复
                setTimeout(() => {
                    btn.style.background = '';
                    btn.style.borderColor = '';
                    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
                }, 1000);
            }).catch(err => {
                showToast('复制失败', err.message, 'error');
            });
        }

        // Copy Selected Keys - 复制选中的 Keys
        async function copySelectedKeys() {
            if (selectedKeys.size === 0) {
                showToast('未选择', '请先选择要复制的 Key', 'info');
                return;
            }
            
            try {
                // 通过导出 API 获取完整的 key
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    showToast('获取失败', result.error || '获取失败', 'error');
                    return;
                }
                
                const result = await response.json();
                if (!result.success || !result.keys) {
                    showToast('获取失败', '无法获取完整 Key', 'error');
                    return;
                }
                
                // 筛选选中的 key
                const selectedIdArray = Array.from(selectedKeys);
                const keysToExport = result.keys.filter(k => selectedIdArray.includes(k.id));
                
                if (keysToExport.length === 0) {
                    showToast('复制失败', '未找到对应的 Key 数据', 'error');
                    return;
                }
                
                const text = keysToExport.map(k => k.key).join('\\n');
                await navigator.clipboard.writeText(text);
                showToast('复制成功', '已复制 ' + keysToExport.length + ' 个完整 Key 到剪贴板', 'success');
                clearSelection();
            } catch (err) {
                showToast('复制失败', err.message, 'error');
            }
        }

        // Refresh Single Key - 只让图标旋转，按钮边框不动
        async function refreshSingleKey(keyId, btn) {
            const row = document.getElementById('key-row-' + keyId);
            if (!row || btn.disabled) return;

            // 保存原始内容，替换为旋转的图标
            btn.disabled = true;
            const originalText = btn.innerHTML;
            btn.innerHTML = '<span style="display:inline-block;animation:spin 0.6s linear infinite">↻</span>';

            try {
                const response = await fetch('/api/keys/' + keyId + '/refresh', {
                    method: 'POST'
                });

                if (!response.ok) throw new Error('刷新失败');

                const result = await response.json();
                
                if (result.success && result.data && !result.data.error) {
                    const d = result.data;
                    
                    // 更新本地缓存
                    if (currentApiData && currentApiData.data) {
                        const idx = currentApiData.data.findIndex(item => item.id === keyId);
                        if (idx !== -1) currentApiData.data[idx] = d;
                    }
                    
                    // 获取所有单元格
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 9) {
                        const remaining = Math.max(0, d.totalAllowance - d.orgTotalTokensUsed);
                        const ratio = d.usedRatio || 0;
                        const pClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';

                        // 直接更新数字，带淡入淡出效果
                        // cells[0]=checkbox, cells[1]=API Key, cells[2]=导入时间 (不更新这三个)

                        // 有效期 (cells[3])
                        cells[3].style.transition = 'opacity 0.2s';
                        cells[3].style.opacity = '0.4';
                        setTimeout(() => {
                            const dateStyle = getDateStyle(d.endDate);
                            const tooltip = getExpiryTooltip(d.endDate);
                            cells[3].setAttribute('style', dateStyle);
                            cells[3].setAttribute('title', tooltip);
                            cells[3].textContent = d.startDate + ' ~ ' + d.endDate + (tooltip ? ' ⚠️' : '');
                            cells[3].style.opacity = '1';
                        }, 200);

                        // 总额度 (cells[4])
                        cells[4].style.transition = 'opacity 0.2s';
                        cells[4].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[4].textContent = formatNumber(d.totalAllowance);
                            cells[4].style.opacity = '1';
                        }, 200);

                        // 已使用 (cells[5])
                        cells[5].style.transition = 'opacity 0.2s';
                        cells[5].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[5].textContent = formatNumber(d.orgTotalTokensUsed);
                            cells[5].style.opacity = '1';
                        }, 200);

                        // 剩余 (cells[6])
                        cells[6].style.transition = 'opacity 0.2s, color 0.3s';
                        cells[6].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[6].textContent = formatNumber(remaining);
                            cells[6].style.color = remaining > 0 ? 'var(--success)' : 'var(--danger)';
                            cells[6].style.opacity = '1';
                        }, 200);

                        // 使用率 + 进度条 (cells[7])
                        cells[7].style.transition = 'opacity 0.2s';
                        cells[7].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[7].innerHTML = '<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span>' + formatPercentage(ratio) + '</span></div><div class="progress-track"><div class="progress-fill ' + pClass + '" style="width:' + Math.min(ratio*100,100) + '%;transition:width 0.3s"></div></div>';
                            cells[7].style.opacity = '1';
                        }, 200);

                        // 更新状态点
                        const dot = row.querySelector('.status-dot');
                        if (dot) {
                            dot.style.transition = 'background 0.3s';
                            dot.className = 'status-dot ' + (remaining > 0 ? 'active' : 'danger');
                        }
                    }
                }
            } catch (err) {
                console.error('刷新失败:', err);
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }

        // 多选功能
        let selectedKeys = new Set();

        function toggleSelectAll(checkbox) {
            const checkboxes = document.querySelectorAll('tbody .row-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = checkbox.checked;
                const row = cb.closest('tr');
                if (checkbox.checked) {
                    selectedKeys.add(cb.dataset.id);
                    row.classList.add('selected');
                } else {
                    selectedKeys.delete(cb.dataset.id);
                    row.classList.remove('selected');
                }
            });
            updateSelectionUI();
        }

        function updateSelection() {
            selectedKeys.clear();
            const checkboxes = document.querySelectorAll('tbody .row-checkbox:checked');
            checkboxes.forEach(cb => {
                selectedKeys.add(cb.dataset.id);
                cb.closest('tr').classList.add('selected');
            });
            
            // 更新未选中行的样式
            document.querySelectorAll('tbody .row-checkbox:not(:checked)').forEach(cb => {
                cb.closest('tr').classList.remove('selected');
            });

            // 更新全选框状态
            const allCheckboxes = document.querySelectorAll('tbody .row-checkbox');
            const selectAllCheckbox = document.getElementById('selectAll');
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = allCheckboxes.length > 0 && checkboxes.length === allCheckboxes.length;
                selectAllCheckbox.indeterminate = checkboxes.length > 0 && checkboxes.length < allCheckboxes.length;
            }

            updateSelectionUI();
        }

        function updateSelectionUI() {
            const selectActions = document.getElementById('selectActions');
            const selectedCount = document.getElementById('selectedCount');
            
            if (selectedKeys.size > 0) {
                selectActions.classList.add('show');
                selectedCount.textContent = selectedKeys.size;
            } else {
                selectActions.classList.remove('show');
            }
        }

        function clearSelection() {
            selectedKeys.clear();
            document.querySelectorAll('.row-checkbox').forEach(cb => {
                cb.checked = false;
                const row = cb.closest('tr');
                if (row) row.classList.remove('selected');
            });
            updateSelectionUI();
        }

        async function deleteSelectedKeys() {
            if (selectedKeys.size === 0) return;
            
            const confirmed = await showConfirm({
                title: '删除确认',
                message: '确定要删除选中的 ' + selectedKeys.size + ' 个 Key 吗？',
                type: 'warning',
                confirmText: '删除'
            });
            if (!confirmed) return;

            const idsToDelete = Array.from(selectedKeys);
            
            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: idsToDelete })
                });

                if (response.ok) {
                    showToast('删除成功', '已删除 ' + idsToDelete.length + ' 个 Key', 'success');
                    clearSelection();
                    loadData();
                } else {
                    const result = await response.json();
                    showToast('删除失败', result.error || '未知错误', 'error');
                }
            } catch (error) {
                showToast('网络错误', error.message, 'error');
            }
        }

        // Modal and Key Management Functions
        function openManageModal() {
            document.getElementById('manageModal').classList.add('show');
            clearMessage();
        }

        function closeManageModal() {
            document.getElementById('manageModal').classList.remove('show');
            clearMessage();
        }

        // Batch Delete Modal Functions
        function openBatchDeleteModal() {
            document.getElementById('batchDeleteModal').classList.add('show');
            clearBatchDeleteMessage();
        }

        function closeBatchDeleteModal() {
            document.getElementById('batchDeleteModal').classList.remove('show');
            clearBatchDeleteMessage();
        }

        function showBatchDeleteMessage(message, isError = false) {
            const msgDiv = document.getElementById('batchDeleteMessage');
            msgDiv.innerHTML = \`<div style="padding: 12px; border-radius: 8px; margin-bottom: 16px; background: \${isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)'}; color: \${isError ? '#f87171' : '#34d399'}; border: 1px solid \${isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'};">\${message}</div>\`;
            setTimeout(() => clearBatchDeleteMessage(), 5000);
        }

        function clearBatchDeleteMessage() {
            document.getElementById('batchDeleteMessage').innerHTML = '';
        }

        async function batchDeleteKeysByValue(event) {
            event.preventDefault();
            const input = document.getElementById('batchDeleteKeysInput').value.trim();
            if (!input) return showBatchDeleteMessage('请输入要删除的 Keys', true);

            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            if (lines.length === 0) return showBatchDeleteMessage('没有有效的 Key 可以删除', true);

            // 确认删除
            const confirmed = await showConfirm({
                title: '批量删除确认',
                message: '确定要删除输入的 ' + lines.length + ' 个 Key 吗？',
                type: 'warning',
                confirmText: '删除'
            });
            if (!confirmed) return;

            // 显示删除中动画
            const deleteBtn = document.getElementById('batchDeleteBtn');
            deleteBtn.disabled = true;
            const originalText = deleteBtn.innerHTML;
            deleteBtn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> 删除中...';

            try {
                const response = await fetch('/api/keys/batch-delete-by-value', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys: lines })
                });
                const result = await response.json();
                if (response.ok) {
                    document.getElementById('batchDeleteKeysInput').value = '';
                    closeBatchDeleteModal();
                    let msg = '成功删除 ' + result.deleted + ' 个 Key';
                    if (result.notFound > 0) {
                        msg += '，' + result.notFound + ' 个未找到';
                    }
                    showToast('删除成功', msg, 'success');
                    loadData();
                } else {
                    showBatchDeleteMessage(result.error || '批量删除失败', true);
                }
            } catch (error) {
                showBatchDeleteMessage('网络错误: ' + error.message, true);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = originalText;
            }
        }

        function showMessage(message, isError = false) {
            const msgDiv = document.getElementById('modalMessage');
            msgDiv.innerHTML = \`<div style="padding: 12px; border-radius: 8px; margin-bottom: 16px; background: \${isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)'}; color: \${isError ? '#f87171' : '#34d399'}; border: 1px solid \${isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'};">\${message}</div>\`;
            setTimeout(() => clearMessage(), 5000);
        }

        function clearMessage() {
            document.getElementById('modalMessage').innerHTML = '';
        }

        async function exportKeys() {
            const exportBtn = document.getElementById('exportKeysBtn');
            exportBtn.disabled = true;
            const originalHTML = exportBtn.innerHTML;
            exportBtn.innerHTML = '<span class="spinner"></span> 导出中...';

            try {
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });

                const result = await response.json();

                if (response.ok) {
                    const keysText = result.keys.map(k => k.key).join('\\n');
                    const blob = new Blob([keysText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = Object.assign(document.createElement('a'), {
                        href: url,
                        download: \`api_keys_export_\${new Date().toISOString().split('T')[0]}.txt\`
                    });
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showToast('导出成功', '成功导出 ' + result.keys.length + ' 个 Key', 'success');
                } else {
                    showToast('导出失败', result.error || '未知错误', 'error');
                }
            } catch (error) {
                showToast('网络错误', error.message, 'error');
            } finally {
                exportBtn.disabled = false;
                exportBtn.innerHTML = originalHTML;
            }
        }

        async function deleteAllKeys() {
            if (!currentApiData) {
                showToast('提示', '请先加载数据', 'info');
                return;
            }
            const totalKeys = currentApiData.total_count;
            if (totalKeys === 0) {
                showToast('提示', '没有可删除的 Key', 'info');
                return;
            }

            const confirmed = await showConfirm({
                title: '危险操作',
                message: '确定要删除所有 ' + totalKeys + ' 个 Key 吗？此操作不可恢复！',
                type: 'danger',
                confirmText: '删除全部',
                requiredInput: '确认删除'
            });
            if (!confirmed) return;

            const deleteBtn = document.getElementById('deleteAllBtn');
            deleteBtn.disabled = true;
            const originalHTML = deleteBtn.innerHTML;
            deleteBtn.innerHTML = '<span class="spinner"></span> 删除中...';

            try {
                const allIds = currentApiData.data.map(item => item.id);
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: allIds })
                });

                const result = await response.json();
                if (response.ok) {
                    showToast('删除成功', '已删除 ' + (result.deleted || totalKeys) + ' 个 Key', 'success');
                    loadData();
                } else {
                    showToast('删除失败', result.error || '未知错误', 'error');
                }
            } catch (error) {
                showToast('网络错误', error.message, 'error');
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = originalHTML;
            }
        }

        async function deleteZeroBalanceKeys() {
            if (!currentApiData) {
                showToast('提示', '请先加载数据', 'info');
                return;
            }
            const invalidKeys = currentApiData.data.filter(item => {
                // 401 错误视为无效 key
                if (item.error) return (item.error || '').includes('401');
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (invalidKeys.length === 0) {
                showToast('太棒了！', '没有找到无效或余额为 0 的 Key', 'success');
                return;
            }
            const confirmed = await showConfirm({
                title: '清理确认',
                message: '发现 ' + invalidKeys.length + ' 个无效或余额为 0 的 Key，确定要删除吗？',
                type: 'warning',
                confirmText: '清理'
            });
            if (!confirmed) return;

            const deleteBtn = document.getElementById('deleteZeroBtn');
            deleteBtn.disabled = true;
            const originalHTML = deleteBtn.innerHTML;
            deleteBtn.innerHTML = '<span class="spinner"></span> 清理中...';

            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: invalidKeys.map(k => k.id) })
                });
                const result = await response.json();
                if (response.ok) {
                    showToast('清理成功', '已清理 ' + (result.deleted || invalidKeys.length) + ' 个无效 Key', 'success');
                    loadData();
                } else {
                    showToast('清理失败', result.error || '未知错误', 'error');
                }
            } catch (error) {
                showToast('网络错误', error.message, 'error');
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = originalHTML;
            }
        }

        async function batchImportKeys(event) {
            event.preventDefault();
            const input = document.getElementById('batchKeysInput').value.trim();
            if (!input) return showMessage('请输入要导入的 Keys', true);

            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const keysToImport = [];
            const timestamp = Date.now();
            let autoIdCounter = 1;

            for (const line of lines) {
                if (line.includes(':')) {
                    const [id, key] = line.split(':').map(s => s.trim());
                    if (id && key) keysToImport.push({ id, key });
                } else {
                    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    keysToImport.push({
                        id: \`key-\${timestamp}-\${autoIdCounter++}-\${randomSuffix}\`,
                        key: line
                    });
                }
            }

            if (keysToImport.length === 0) return showMessage('没有有效的 Key 可以导入', true);

            // 显示导入中动画
            const importBtn = document.getElementById('importBtn');
            importBtn.disabled = true;
            const originalText = importBtn.innerHTML;
            importBtn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> 导入中...';

            try {
                const response = await fetch('/api/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(keysToImport)
                });
                const result = await response.json();
                if (response.ok) {
                    document.getElementById('batchKeysInput').value = '';
                    closeManageModal();
                    showToast('导入成功', '成功导入 ' + result.added + ' 个 Key' + (result.skipped > 0 ? '，跳过 ' + result.skipped + ' 个重复' : ''), 'success');
                    loadData();
                } else {
                    showMessage(result.error || '批量导入失败', true);
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, true);
            } finally {
                importBtn.disabled = false;
                importBtn.innerHTML = originalText;
            }
        }

        async function deleteKeyFromTable(id) {
            const confirmed = await showConfirm({
                title: '删除确认',
                message: '确定要删除这个 Key 吗？',
                type: 'warning',
                confirmText: '删除'
            });
            if (!confirmed) return;
            try {
                const response = await fetch(\`/api/keys/\${id}\`, { method: 'DELETE' });
                const result = await response.json();
                if (response.ok) {
                    showToast('删除成功', 'Key 已删除', 'success');
                    loadData();
                } else {
                    showToast('删除失败', result.error || '未知错误', 'error');
                }
            } catch (error) {
                showToast('网络错误', error.message, 'error');
            }
        }



        document.addEventListener('click', (event) => {
            const manageModal = document.getElementById('manageModal');
            const settingsModal = document.getElementById('settingsModal');
            const confirmModal = document.getElementById('confirmModal');
            const batchDeleteModal = document.getElementById('batchDeleteModal');
            if (event.target === manageModal) closeManageModal();
            if (event.target === settingsModal) closeSettingsModal();
            if (event.target === confirmModal) closeConfirmModal(false);
            if (event.target === batchDeleteModal) closeBatchDeleteModal();
        });
    </script>
</body>
</html>
`;


// ==================== API Data Fetching ====================

/**
 * Batch process promises with concurrency control to avoid rate limiting.
 */
async function batchProcess<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    concurrency: number = 10,
    delayMs: number = 100
): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);

        // Add delay between batches to avoid rate limiting
        if (i + concurrency < items.length) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return results;
}

/**
 * Fetches usage data for a single API key with retry logic.
 */
async function fetchApiKeyData(id: string, key: string, createdAt?: number, retryCount = 0): Promise<ApiKeyResult> {
    const maskedKey = maskApiKey(key);
    const maxRetries = 2;

    try {
        const response = await fetch(CONFIG.API_ENDPOINT, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'User-Agent': CONFIG.USER_AGENT,
            }
        });

        if (!response.ok) {
            if (response.status === 401 && retryCount < maxRetries) {
                const delayMs = (retryCount + 1) * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return fetchApiKeyData(id, key, createdAt, retryCount + 1);
            }
            return { id, key: maskedKey, fullKey: key, error: `HTTP ${response.status}`, createdAt };
        }

        const apiData: ApiResponse = await response.json();
        const { usage } = apiData;

        if (!usage?.standard) {
            return { id, key: maskedKey, fullKey: key, error: 'Invalid API response', createdAt };
        }

        const { standard } = usage;
        return {
            id,
            key: maskedKey,
            fullKey: key,
            startDate: formatDate(usage.startDate),
            endDate: formatDate(usage.endDate),
            orgTotalTokensUsed: standard.orgTotalTokensUsed || 0,
            totalAllowance: standard.totalAllowance || 0,
            usedRatio: standard.usedRatio || 0,
            createdAt,
        };
    } catch (error) {
        return { id, key: maskedKey, fullKey: key, error: 'Failed to fetch', createdAt };
    }
}


// ==================== Type Guards ====================

const isApiUsageData = (result: ApiKeyResult): result is ApiUsageData => !('error' in result);

// ==================== Data Aggregation ====================

/**
 * Aggregates data from all configured API keys.
 */
async function getAggregatedData(): Promise<AggregatedResponse> {
    const keyPairs = await getAllKeys();
    const beijingTime = getBeijingTime();
    const emptyResponse = {
        update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
        total_count: 0,
        totals: { total_orgTotalTokensUsed: 0, total_totalAllowance: 0, totalRemaining: 0 },
        data: [],
    };

    if (keyPairs.length === 0) return emptyResponse;

    const results = await batchProcess(
        keyPairs,
        ({ id, key, createdAt }) => fetchApiKeyData(id, key, createdAt),
        10,
        100
    );

    const validResults = results.filter(isApiUsageData);
    const sortedValid = validResults
        .map(r => ({ ...r, remaining: Math.max(0, r.totalAllowance - r.orgTotalTokensUsed) }))
        .sort((a, b) => b.remaining - a.remaining)
        .map(({ remaining, ...rest }) => rest);

    const totals = validResults.reduce((acc, res) => ({
        total_orgTotalTokensUsed: acc.total_orgTotalTokensUsed + res.orgTotalTokensUsed,
        total_totalAllowance: acc.total_totalAllowance + res.totalAllowance,
        totalRemaining: acc.totalRemaining + Math.max(0, res.totalAllowance - res.orgTotalTokensUsed)
    }), emptyResponse.totals);

    logKeysWithBalance(validResults, keyPairs);

    return {
        update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
        total_count: keyPairs.length,
        totals,
        data: [...sortedValid, ...results.filter(r => 'error' in r)],
    };
}

/**
 * Logs API keys that still have remaining balance.
 */
function logKeysWithBalance(validResults: ApiUsageData[], keyPairs: ApiKey[]): void {
    const keysWithBalance = validResults.filter(r => {
        const remaining = r.totalAllowance - r.orgTotalTokensUsed;
        return remaining > 0;
    });

    if (keysWithBalance.length > 0) {
        console.log("=".repeat(80));
        console.log("📋 剩余额度大于0的API Keys:");
        console.log("-".repeat(80));

        keysWithBalance.forEach(item => {
            const originalKeyPair = keyPairs.find(kp => kp.id === item.id);
            if (originalKeyPair) {
                console.log(maskApiKey(originalKeyPair.key));
            }
        });

        console.log("=".repeat(80) + "\n");
    } else {
        console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
    }
}


// ==================== Shared Cache & Lock Helpers ====================

async function loadAggregatedCacheFromKv(): Promise<AggregatedCacheEntry | null> {
    const cached = await kv.get<AggregatedCacheEntry>(KV_AGGREGATED_CACHE_KEY);
    return cached.value || null;
}

async function saveAggregatedCacheToKv(payload: AggregatedResponse, version: number) {
    const entry: AggregatedCacheEntry = {
        version,
        updatedAt: Date.now(),
        payload
    };
    await kv.set(KV_AGGREGATED_CACHE_KEY, entry);
}

async function hydrateCacheFromKv() {
    const cached = await loadAggregatedCacheFromKv();
    if (cached) {
        serverState.updateCache(cached.payload);
        serverState.setCachedDataVersion(cached.version);
    }
}

async function acquireRefreshLock(): Promise<boolean> {
    const res = await kv.atomic()
        .check({ key: KV_REFRESH_LOCK_KEY, versionstamp: null })
        .set(KV_REFRESH_LOCK_KEY, true, { expireIn: REFRESH_LOCK_TTL_MS })
        .commit();
    return res.ok;
}

async function releaseRefreshLock() {
    await kv.delete(KV_REFRESH_LOCK_KEY);
}


// ==================== Auto-Refresh Logic (NEW) ====================

/**
 * Periodically fetches data and updates the server state cache.
 * @param waitIfBusy - 如果为 true，当有正在进行的更新时会等待它完成后再执行新的刷新
 */
async function autoRefreshData(waitIfBusy = false) {
    // 如果正在更新
    if (serverState.isCurrentlyUpdating()) {
        if (waitIfBusy) {
            // 等待当前更新完成
            await serverState.waitForUpdate();
        } else {
            // 定时刷新：直接跳过，避免排队
            return;
        }
    }

    // 尝试获取锁，waitIfBusy 时重试几次
    const maxAttempts = waitIfBusy ? 5 : 1;
    let lockAcquired = false;
    for (let i = 0; i < maxAttempts; i++) {
        lockAcquired = await acquireRefreshLock();
        if (lockAcquired) break;
        await sleep(800);
    }
    if (!lockAcquired) {
        console.log("[autoRefreshData] Another instance holds the lock, skipping.");
        if (waitIfBusy) {
            const cached = await loadAggregatedCacheFromKv();
            if (cached) {
                serverState.updateCache(cached.payload);
                serverState.setCachedDataVersion(cached.version);
            }
        }
        return;
    }

    const timestamp = format(getBeijingTime(), "HH:mm:ss");
    console.log(`[${timestamp}] Starting data refresh...`);
    serverState.startUpdate();

    try {
        const data = await getAggregatedData();

        // 获取当前数据库版本号
        const currentDbVersion = await getDataVersion();

        // 再次获取数据库中当前存在的 key IDs，过滤掉已被删除的 keys
        // 这是为了解决多实例环境下（如 Deno Deploy）的数据同步问题
        const currentDbKeys = await getAllKeys();
        const currentDbKeyIds = new Set(currentDbKeys.map(k => k.id));

        const validData = data.data.filter(item => currentDbKeyIds.has(item.id));

        if (validData.length !== data.data.length) {
            console.log(`[${timestamp}] Filtered out ${data.data.length - validData.length} stale keys`);

            // 重新计算统计值
            let totalUsed = 0, totalAllowance = 0, totalRemaining = 0;
            validData.forEach(item => {
                if (!('error' in item)) {
                    totalUsed += item.orgTotalTokensUsed || 0;
                    totalAllowance += item.totalAllowance || 0;
                    totalRemaining += Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                }
            });

            const filteredData: AggregatedResponse = {
                ...data,
                total_count: validData.length,
                data: validData,
                totals: {
                    total_orgTotalTokensUsed: totalUsed,
                    total_totalAllowance: totalAllowance,
                    totalRemaining: totalRemaining
                }
            };
            serverState.updateCache(filteredData);
            await saveAggregatedCacheToKv(filteredData, currentDbVersion);
        } else {
            serverState.updateCache(data);
            await saveAggregatedCacheToKv(data, currentDbVersion);
        }

        // 更新缓存的版本号
        serverState.setCachedDataVersion(currentDbVersion);

        console.log(`[${timestamp}] Data updated successfully (version: ${currentDbVersion}).`);
    } catch (error) {
        serverState.setError(error instanceof Error ? error.message : 'Refresh failed');
    } finally {
        await releaseRefreshLock();
    }
}



// ==================== Route Handlers ====================

/**
 * Handles the root path - serves the HTML dashboard.
 */
function handleRoot(): Response {
    return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
}

/**
 * Handles the /api/data endpoint - returns cached aggregated usage data.
 */
async function handleGetData(): Promise<Response> {
    // 检查数据版本号，如果不匹配则需要刷新（解决多实例同步问题）
    const dbVersion = await getDataVersion();
    const cachedVersion = serverState.getCachedDataVersion();

    if (dbVersion !== cachedVersion && !serverState.isCurrentlyUpdating()) {
        console.log(`[handleGetData] Version mismatch (db: ${dbVersion}, cached: ${cachedVersion}), trying KV cache/refresh`);
        const kvCached = await loadAggregatedCacheFromKv();
        if (kvCached && kvCached.version === dbVersion) {
            serverState.updateCache(kvCached.payload);
            serverState.setCachedDataVersion(kvCached.version);
        } else {
            // 同步刷新，确保返回最新数据
            await autoRefreshData(true);
        }
    }

    let cachedData = serverState.getData();

    if (!cachedData) {
        const kvCached = await loadAggregatedCacheFromKv();
        if (kvCached && kvCached.version === dbVersion) {
            serverState.updateCache(kvCached.payload);
            serverState.setCachedDataVersion(kvCached.version);
            cachedData = serverState.getData();
        }
    }

    if (cachedData) {
        return createJsonResponse(cachedData);
    }

    const lastError = serverState.getError();
    if (lastError) {
        return createErrorResponse(lastError, 500);
    }

    // If there's no data and no error, it means an update is in progress
    if (serverState.isCurrentlyUpdating()) {
        return createErrorResponse("数据正在更新中，请稍候...", 503);
    }

    // This shouldn't happen normally after initial load, but just in case
    return createErrorResponse("暂无数据，请稍后刷新。", 503);
}

/**
 * Handles GET /api/keys - returns all stored API keys.
 */
async function handleGetKeys(): Promise<Response> {
    try {
        const keys = await getAllKeys();
        return createJsonResponse(keys);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error getting keys:', errorMessage);
        return createErrorResponse(errorMessage, 500);
    }
}

/**
 * Handles POST /api/keys - adds single or multiple API keys.
 */
async function handleAddKeys(req: Request): Promise<Response> {
    try {
        const body = await req.json();

        // Support batch import
        if (Array.isArray(body)) {
            return await handleBatchImport(body);
        } else {
            return await handleSingleKeyAdd(body);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
        console.error('Error adding keys:', errorMessage);
        return createErrorResponse(errorMessage, 400);
    }
}

async function handleBatchImport(items: unknown[]): Promise<Response> {
    let added = 0, skipped = 0;

    // 先对输入进行去重
    const seenKeys = new Set<string>();
    const keysToAdd: ApiKey[] = [];
    const timestamp = Date.now();
    let counter = 0;

    for (const item of items) {
        if (!item || typeof item !== 'object' || !('key' in item)) continue;

        const { key } = item as { key: string };
        const normalizedKey = key.trim();
        if (!normalizedKey) continue;

        // 检查是否已存在于数据库或本次导入已包含
        if (seenKeys.has(normalizedKey) || await apiKeyExists(normalizedKey)) {
            skipped++;
            continue;
        }

        seenKeys.add(normalizedKey);
        keysToAdd.push({
            id: `key-${timestamp}-${counter++}-${Math.random().toString(36).substring(2, 8)}`,
            key: normalizedKey,
            createdAt: timestamp
        });
        added++;
    }

    if (keysToAdd.length > 0) {
        await addKeysBulk(keysToAdd);
        // 同步刷新，确保前端能立刻看到新增
        await autoRefreshData(true);
    }

    return createJsonResponse({ success: true, added, skipped });
}

async function handleSingleKeyAdd(body: unknown): Promise<Response> {
    if (!body || typeof body !== 'object' || !('key' in body)) {
        return createErrorResponse("key is required", 400);
    }

    const { key } = body as { key: string };
    const normalizedKey = key.trim();
    if (!normalizedKey) return createErrorResponse("key cannot be empty", 400);
    if (await apiKeyExists(normalizedKey)) return createErrorResponse("API key already exists", 409);

    const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await addKeysBulk([{ id, key: normalizedKey }]);
    // 同步刷新，确保前端能立刻看到新增
    await autoRefreshData(true);

    return createJsonResponse({ success: true });
}

async function handleDeleteKey(pathname: string): Promise<Response> {
    const id = pathname.split("/api/keys/")[1];
    console.log(`[DELETE] Received delete request for id: ${id}`);
    if (!id) return createErrorResponse("Key ID is required", 400);

    // 先标记为待删除，防止并发刷新带来旧数据
    serverState.removeKeysFromCache([id]);
    console.log(`[DELETE] Marked as pending deletion, pendingDeletions size: ${serverState.getPendingDeletionsSize()}`);

    const records = await getKeysByIds([id]);
    if (records.length === 0) {
        return createErrorResponse("Key not found", 404);
    }

    const newVersion = await deleteKeysBulk(records);
    serverState.setCachedDataVersion(newVersion);
    const updated = serverState.getData();
    if (updated) {
        await saveAggregatedCacheToKv(updated, newVersion);
    }
    console.log(`[DELETE] Database delete completed for id: ${id}`);

    return createJsonResponse({ success: true });
}

async function handleBatchDeleteKeys(req: Request): Promise<Response> {
    try {
        const { ids } = await req.json() as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) {
            return createErrorResponse("ids array is required", 400);
        }

        // 先标记为待删除，防止并发刷新带来旧数据
        serverState.removeKeysFromCache(ids);

        const records = await getKeysByIds(ids);
        const newVersion = await deleteKeysBulk(records);
        serverState.setCachedDataVersion(newVersion);
        const updated = serverState.getData();
        if (updated) {
            await saveAggregatedCacheToKv(updated, newVersion);
        }

        return createJsonResponse({ success: true, deleted: records.length });
    } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : 'Invalid JSON', 400);
    }
}

/**
 * Handles POST /api/keys/batch-delete-by-value - Batch delete keys by their value.
 */
async function handleBatchDeleteByValue(req: Request): Promise<Response> {
    try {
        const { keys } = await req.json() as { keys: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
            return createErrorResponse("keys array is required", 400);
        }

        // 找到要删除的 key 对应的 id
        const recordsToDelete: ApiKey[] = [];
        let notFound = 0;
        const seen = new Set<string>();

        keys.forEach(k => {
            const trimmedKey = k.trim();
            if (!trimmedKey) return;
            if (seen.has(trimmedKey)) return;
            seen.add(trimmedKey);
        });

        const uniqueKeys = Array.from(seen);
        const lookups = await Promise.all(uniqueKeys.map(key => kv.get<string>([...KV_KEY_INDEX_PREFIX, key])));
        lookups.forEach((res, idx) => {
            const key = uniqueKeys[idx];
            if (res.value) {
                recordsToDelete.push({ id: res.value, key });
            } else {
                notFound++;
            }
        });

        if (recordsToDelete.length === 0) {
            return createJsonResponse({ success: true, deleted: 0, notFound });
        }

        // 先标记为待删除，防止并发刷新带来旧数据
        serverState.removeKeysFromCache(recordsToDelete.map(r => r.id));

        // 然后批量删除数据库
        const newVersion = await deleteKeysBulk(recordsToDelete);
        serverState.setCachedDataVersion(newVersion);
        const updated = serverState.getData();
        if (updated) {
            await saveAggregatedCacheToKv(updated, newVersion);
        }

        return createJsonResponse({
            success: true,
            deleted: recordsToDelete.length,
            notFound
        });
    } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : 'Invalid JSON', 400);
    }
}

/**
 * Handles POST /api/keys/export - exports all API keys.
 */
async function handleExportKeys(_req: Request): Promise<Response> {
    try {
        // Get all keys (unmasked)
        const keys = await getAllKeys();

        return createJsonResponse({
            success: true,
            keys
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error exporting keys:', errorMessage);
        return createErrorResponse(errorMessage, 500);
    }
}

/**
 * Handles GET /api/auth/check - checks if password is required
 */
function handleAuthCheck(): Response {
    return createJsonResponse({
        required: CONFIG.ACCESS_PASSWORD !== "",
    });
}

/**
 * Handles POST /api/auth/verify - verifies access password
 */
async function handleAuthVerify(req: Request): Promise<Response> {
    try {
        const { password } = await req.json() as { password: string };

        if (CONFIG.ACCESS_PASSWORD === "") {
            return createJsonResponse({ success: true });
        }

        if (password === CONFIG.ACCESS_PASSWORD) {
            return createJsonResponse({ success: true });
        }

        return createErrorResponse("密码错误", 401);
    } catch (error) {
        return createErrorResponse("Invalid request", 400);
    }
}

/**
 * Handles POST /api/keys/:id/refresh - refreshes data for a single API key.
 */
async function handleRefreshSingleKey(pathname: string): Promise<Response> {
    try {
        const id = pathname.split("/api/keys/")[1].replace("/refresh", "");

        if (!id) {
            return createErrorResponse("Key ID is required", 400);
        }

        const records = await getKeysByIds([id]);
        if (records.length === 0) {
            return createErrorResponse("Key not found", 404);
        }

        // Fetch fresh data for this key
        const { key, createdAt } = records[0];
        const keyData = await fetchApiKeyData(id, key, createdAt);

        return createJsonResponse({
            success: true,
            data: keyData
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error refreshing key:', errorMessage);
        return createErrorResponse(errorMessage, 500);
    }
}

// ==================== Main Request Handler ====================

/**
 * Main HTTP request handler that routes requests to appropriate handlers.
 */
async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Route: Root path - Dashboard
    if (url.pathname === "/") {
        return handleRoot();
    }

    // Route: GET /api/data - Get aggregated usage data
    if (url.pathname === "/api/data" && req.method === "GET") {
        return await handleGetData();
    }

    // Route: GET /api/keys - Get all keys
    if (url.pathname === "/api/keys" && req.method === "GET") {
        return await handleGetKeys();
    }

    // Route: POST /api/keys - Add key(s)
    if (url.pathname === "/api/keys" && req.method === "POST") {
        return await handleAddKeys(req);
    }

    // Route: POST /api/keys/batch-delete - Batch delete keys
    if (url.pathname === "/api/keys/batch-delete" && req.method === "POST") {
        return await handleBatchDeleteKeys(req);
    }

    // Route: POST /api/keys/batch-delete-by-value - Batch delete keys by value
    if (url.pathname === "/api/keys/batch-delete-by-value" && req.method === "POST") {
        return await handleBatchDeleteByValue(req);
    }

    // Route: POST /api/keys/export - Export keys with password
    if (url.pathname === "/api/keys/export" && req.method === "POST") {
        return await handleExportKeys(req);
    }

    // Route: GET /api/auth/check - Check if password is required
    if (url.pathname === "/api/auth/check" && req.method === "GET") {
        return handleAuthCheck();
    }

    // Route: POST /api/auth/verify - Verify access password
    if (url.pathname === "/api/auth/verify" && req.method === "POST") {
        return await handleAuthVerify(req);
    }

    // Route: DELETE /api/keys/:id - Delete a key
    if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
        return await handleDeleteKey(url.pathname);
    }

    // Route: POST /api/keys/:id/refresh - Refresh single key
    if (url.pathname.match(/^\/api\/keys\/.+\/refresh$/) && req.method === "POST") {
        return await handleRefreshSingleKey(url.pathname);
    }

    // 404 for all other routes
    return new Response("Not Found", { status: 404 });
}

// ==================== Server Initialization ====================

async function startServer() {
    console.log("Initializing server...");

    // 确保旧数据构建好索引，避免重复写入和慢查询
    await ensureKeyIndexBuilt();

    // 优先从 KV 缓存里加载数据，减少冷启动空白时间
    await hydrateCacheFromKv();

    // Perform an initial data fetch on startup and WAIT for it to complete
    console.log("Performing initial data fetch...");
    await autoRefreshData();
    console.log("Initial data loaded successfully.");

    // Set up the interval for subsequent refreshes
    setInterval(autoRefreshData, CONFIG.AUTO_REFRESH_INTERVAL_SECONDS * 1000);

    console.log(`Server running on http://localhost:${CONFIG.PORT}`);
    serve(handler, { port: CONFIG.PORT });
}

startServer();
