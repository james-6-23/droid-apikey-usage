// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// ==================== Type Definitions ====================

interface ApiKey {
  id: string;
  key: string;
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
}

interface ApiErrorData {
  id: string;
  key: string;
  fullKey: string;
  error: string;
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

// ==================== Server State and Caching (NEW) ====================

class ServerState {
  private cachedData: AggregatedResponse | null = null;
  private lastError: string | null = null;
  private isUpdating = false;

  getData = () => this.cachedData;
  getError = () => this.lastError;
  isCurrentlyUpdating = () => this.isUpdating;

  updateCache(data: AggregatedResponse) {
    this.cachedData = data;
    this.lastError = null;
    this.isUpdating = false;
  }

  setError(errorMessage: string) {
    this.lastError = errorMessage;
    this.isUpdating = false;
  }

  startUpdate() {
    this.isUpdating = true;
  }
}

const serverState = new ServerState();


// ==================== Database Initialization ====================

const kv = await Deno.openKv();

// ==================== Database Operations ====================

async function getAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const entries = kv.list<string>({ prefix: ["api_keys"] });

  for await (const entry of entries) {
    const id = entry.key[1] as string;
    keys.push({ id, key: entry.value });
  }

  return keys;
}

async function addKey(id: string, key: string): Promise<void> {
  await kv.set(["api_keys", id], key);
}

async function deleteKey(id: string): Promise<void> {
  await kv.delete(["api_keys", id]);
}

async function apiKeyExists(key: string): Promise<boolean> {
  const keys = await getAllKeys();
  return keys.some(k => k.key === key);
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
            padding: 20px 24px; 
            color: var(--text-secondary); 
            font-size: 13px; 
            font-weight: 600; 
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border);
        }

        td { 
            padding: 20px 24px; 
            color: var(--text); 
            font-size: 15px; 
            border-bottom: 1px solid var(--border);
            vertical-align: middle;
        }

        tbody tr:hover { background: var(--bg-tertiary); }
        tbody tr:last-child td { border-bottom: none; }

        .key-cell {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .key-badge { 
            font-family: var(--font-mono); 
            background: var(--bg-tertiary); 
            padding: 8px 14px; 
            border-radius: 6px; 
            font-size: 14px; 
            color: var(--text);
            border: 1px solid var(--border);
            max-width: 280px;
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
                <h1>API 监控看板</h1>
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
                        <button type="submit" class="btn btn-primary" style="flex: 1; justify-content: center;">开始导入</button>
                        <button type="button" class="btn" style="background: rgba(255,255,255,0.1);" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
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
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;
        let isLoading = false;
        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';  

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
                            <th>API Key</th>
                            <th>有效期</th>
                            <th style="text-align: right;">总额度</th>
                            <th style="text-align: right;">已使用</th>
                            <th style="text-align: right;">剩余</th>
                            <th style="width: 200px;">使用率</th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;

            // 按已使用额度从高到低排序
            const sortedData = [...data.data].sort((a, b) => {
                const usedA = a.orgTotalTokensUsed || 0;
                const usedB = b.orgTotalTokensUsed || 0;
                return usedB - usedA;
            });

            sortedData.forEach(item => {
                const rawKey = item.fullKey || item.key || '';
                const copyValue = rawKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                if (item.error) {
                    tableHTML += \`
                        <tr id="key-row-\${item.id}" data-key-id="\${item.id}">
                            <td class="checkbox-cell"><input type="checkbox" class="row-checkbox" data-id="\${item.id}" onchange="updateSelection()"></td>
                            <td>
                                <div class="key-cell">
                                    <span class="key-badge" title="\${item.key}">\${item.key}</span>
                                    <button class="copy-btn" onclick="copyKey('\${copyValue}', this)" title="复制">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                    </button>
                                </div>
                            </td>
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
                        <tr id="key-row-\${item.id}" data-key-id="\${item.id}">
                            <td class="checkbox-cell"><input type="checkbox" class="row-checkbox" data-id="\${item.id}" onchange="updateSelection()"></td>
                            <td>
                                <div class="key-cell">
                                    <span class="status-dot \${statusDot}"></span>
                                    <span class="key-badge" title="\${item.key}">\${item.key}</span>
                                    <button class="copy-btn" onclick="copyKey('\${copyValue}', this)" title="复制">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                    </button>
                                </div>
                            </td>
                            <td style="color: var(--text-secondary);">\${item.startDate} ~ \${item.endDate}</td>
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
            document.getElementById('tableContent').innerHTML = tableHTML;
            // Add fade-in animation
            document.getElementById('tableContent').classList.add('fade-in');
        }  
  
        document.addEventListener('DOMContentLoaded', async () => {
            initTheme();
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

        // Copy Selected Keys - 复制选中的 Keys (需要密码获取完整 key)
        async function copySelectedKeys() {
            if (selectedKeys.size === 0) {
                showToast('未选择', '请先选择要复制的 Key', 'info');
                return;
            }
            
            const password = prompt('请输入导出密码以获取完整 Key：');
            if (!password) return;
            
            try {
                // 通过导出 API 获取完整的 key
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    showToast('获取失败', result.error || '密码错误', 'error');
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
                    if (cells.length >= 8) {
                        const remaining = Math.max(0, d.totalAllowance - d.orgTotalTokensUsed);
                        const ratio = d.usedRatio || 0;
                        const pClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';
                        
                        // 直接更新数字，带淡入淡出效果
                        // cells[0]=checkbox, cells[1]=API Key (不更新这两个)
                        
                        // 有效期
                        cells[2].style.transition = 'opacity 0.2s';
                        cells[2].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[2].textContent = d.startDate + ' ~ ' + d.endDate;
                            cells[2].style.opacity = '1';
                        }, 200);
                        
                        // 总额度
                        cells[3].style.transition = 'opacity 0.2s';
                        cells[3].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[3].textContent = formatNumber(d.totalAllowance);
                            cells[3].style.opacity = '1';
                        }, 200);
                        
                        // 已使用
                        cells[4].style.transition = 'opacity 0.2s';
                        cells[4].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[4].textContent = formatNumber(d.orgTotalTokensUsed);
                            cells[4].style.opacity = '1';
                        }, 200);
                        
                        // 剩余
                        cells[5].style.transition = 'opacity 0.2s, color 0.3s';
                        cells[5].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[5].textContent = formatNumber(remaining);
                            cells[5].style.color = remaining > 0 ? 'var(--success)' : 'var(--danger)';
                            cells[5].style.opacity = '1';
                        }, 200);
                        
                        // 使用率 + 进度条
                        cells[6].style.transition = 'opacity 0.2s';
                        cells[6].style.opacity = '0.4';
                        setTimeout(() => {
                            cells[6].innerHTML = '<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span>' + formatPercentage(ratio) + '</span></div><div class="progress-track"><div class="progress-fill ' + pClass + '" style="width:' + Math.min(ratio*100,100) + '%;transition:width 0.3s"></div></div>';
                            cells[6].style.opacity = '1';
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
            
            if (!confirm(\`确定要删除选中的 \${selectedKeys.size} 个 Key 吗？\`)) return;

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

        function showMessage(message, isError = false) {
            const msgDiv = document.getElementById('modalMessage');
            msgDiv.innerHTML = \`<div style="padding: 12px; border-radius: 8px; margin-bottom: 16px; background: \${isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)'}; color: \${isError ? '#f87171' : '#34d399'}; border: 1px solid \${isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'};">\${message}</div>\`;
            setTimeout(() => clearMessage(), 5000);
        }

        function clearMessage() {
            document.getElementById('modalMessage').innerHTML = '';
        }

        async function exportKeys() {
            const password = prompt('请输入导出密码：');
            if (!password) return;

            const exportBtn = document.getElementById('exportKeysBtn');
            exportBtn.disabled = true;
            const originalHTML = exportBtn.innerHTML;
            exportBtn.innerHTML = '<span class="spinner"></span> 导出中...';

            try {
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
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
                    alert(\`成功导出 \${result.keys.length} 个Key\`);
                } else {
                    alert('导出失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
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

            if (!confirm(\`危险操作！\\n\\n确定要删除所有 \${totalKeys} 个 Key 吗？\\n此操作不可恢复！\`)) return;
            const secondConfirm = prompt('请输入 "确认删除" 以继续：');
            if (secondConfirm !== '确认删除') {
                showToast('已取消', '操作已取消', 'info');
                return;
            }

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
            const zeroBalanceKeys = currentApiData.data.filter(item => {
                if (item.error) return false;
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (zeroBalanceKeys.length === 0) {
                showToast('太棒了！', '没有找到余额为 0 的 Key', 'success');
                return;
            }
            if (!confirm(\`清理确认\\n\\n发现 \${zeroBalanceKeys.length} 个余额为 0 的 Key\\n确定要删除吗？\`)) return;

            const deleteBtn = document.getElementById('deleteZeroBtn');
            deleteBtn.disabled = true;
            const originalHTML = deleteBtn.innerHTML;
            deleteBtn.innerHTML = '<span class="spinner"></span> 清理中...';

            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: zeroBalanceKeys.map(k => k.id) })
                });
                const result = await response.json();
                if (response.ok) {
                    showToast('清理成功', '已清理 ' + (result.deleted || zeroBalanceKeys.length) + ' 个无效 Key', 'success');
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
            }
        }

        async function deleteKeyFromTable(id) {
            if (!confirm(\`确定要删除这个 Key 吗？\`)) return;
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
            const modal = document.getElementById('manageModal');
            if (event.target === modal) closeManageModal();
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
async function fetchApiKeyData(id: string, key: string, retryCount = 0): Promise<ApiKeyResult> {
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
        return fetchApiKeyData(id, key, retryCount + 1);
      }
      return { id, key: maskedKey, fullKey: key, error: `HTTP ${response.status}` };
    }

    const apiData: ApiResponse = await response.json();
    const { usage } = apiData;

    if (!usage?.standard) {
      return { id, key: maskedKey, fullKey: key, error: 'Invalid API response' };
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
    };
  } catch (error) {
    return { id, key: maskedKey, fullKey: key, error: 'Failed to fetch' };
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
    ({ id, key }) => fetchApiKeyData(id, key),
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
        console.log(originalKeyPair.key);
      }
    });

    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }
}


// ==================== Auto-Refresh Logic (NEW) ====================

/**
 * Periodically fetches data and updates the server state cache.
 */
async function autoRefreshData() {
  if (serverState.isCurrentlyUpdating()) return;

  const timestamp = format(getBeijingTime(), "HH:mm:ss");
  console.log(`[${timestamp}] Starting data refresh...`);
  serverState.startUpdate();

  try {
    const data = await getAggregatedData();
    serverState.updateCache(data);
    console.log(`[${timestamp}] Data updated successfully.`);
  } catch (error) {
    serverState.setError(error instanceof Error ? error.message : 'Refresh failed');
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
  const cachedData = serverState.getData();

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
  const existingKeys = new Set((await getAllKeys()).map(k => k.key));

  for (const item of items) {
    if (!item || typeof item !== 'object' || !('key' in item)) continue;

    const { key } = item as { key: string };
    if (!key || existingKeys.has(key)) {
      if (key) skipped++;
      continue;
    }

    const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await addKey(id, key);
    existingKeys.add(key);
    added++;
  }

  if (added > 0) autoRefreshData();

  return createJsonResponse({ success: true, added, skipped });
}

async function handleSingleKeyAdd(body: unknown): Promise<Response> {
  if (!body || typeof body !== 'object' || !('key' in body)) {
    return createErrorResponse("key is required", 400);
  }

  const { key } = body as { key: string };
  if (!key) return createErrorResponse("key cannot be empty", 400);
  if (await apiKeyExists(key)) return createErrorResponse("API key already exists", 409);

  const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  await addKey(id, key);
  autoRefreshData();

  return createJsonResponse({ success: true });
}

async function handleDeleteKey(pathname: string): Promise<Response> {
  const id = pathname.split("/api/keys/")[1];
  if (!id) return createErrorResponse("Key ID is required", 400);

  await deleteKey(id);
  autoRefreshData();

  return createJsonResponse({ success: true });
}

async function handleBatchDeleteKeys(req: Request): Promise<Response> {
  try {
    const { ids } = await req.json() as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return createErrorResponse("ids array is required", 400);
    }

    await Promise.all(ids.map(id => deleteKey(id).catch(() => { })));
    autoRefreshData();

    return createJsonResponse({ success: true, deleted: ids.length });
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : 'Invalid JSON', 400);
  }
}

/**
 * Handles POST /api/keys/export - exports all API keys with password verification.
 */
async function handleExportKeys(req: Request): Promise<Response> {
  try {
    const { password } = await req.json() as { password: string };

    // Verify password
    if (password !== CONFIG.EXPORT_PASSWORD) {
      return createErrorResponse("密码错误", 401);
    }

    // Get all keys (unmasked)
    const keys = await getAllKeys();

    return createJsonResponse({
      success: true,
      keys
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error exporting keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
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

    // Get the key from database
    const result = await kv.get<string>(["api_keys", id]);

    if (!result.value) {
      return createErrorResponse("Key not found", 404);
    }

    const key = result.value;

    // Fetch fresh data for this key
    const keyData = await fetchApiKeyData(id, key);

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
