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
  startDate: string;
  endDate: string;
  orgTotalTokensUsed: number;
  totalAllowance: number;
  usedRatio: number;
}

interface ApiErrorData {
  id: string;
  key: string;
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
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #8b5cf6;
            --primary-glow: rgba(139, 92, 246, 0.5);
            --secondary: #06b6d4;
            --secondary-glow: rgba(6, 182, 212, 0.5);
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --bg-dark: #0f172a;
            --bg-card: rgba(30, 41, 59, 0.7);
            --bg-card-hover: rgba(51, 65, 85, 0.8);
            --text-primary: #f1f5f9;
            --text-secondary: #94a3b8;
            --border: rgba(148, 163, 184, 0.1);
            --glass-border: 1px solid rgba(255, 255, 255, 0.05);
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.2);
            --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body { 
            font-family: 'Outfit', sans-serif; 
            background-color: var(--bg-dark);
            background-image: 
                radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(6, 182, 212, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
                radial-gradient(at 0% 100%, rgba(6, 182, 212, 0.15) 0px, transparent 50%);
            background-attachment: fixed;
            color: var(--text-primary);
            min-height: 100vh; 
            padding: 24px;
            overflow-x: hidden;
        }

        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.5); }
        ::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.2); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.4); }

        .container { 
            max-width: 1600px; 
            margin: 0 auto; 
            animation: fadeIn 0.6s ease-out;
        }

        /* Header */
        .header { 
            background: var(--bg-card);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: var(--glass-border);
            border-radius: 24px; 
            padding: 24px 32px; 
            margin-bottom: 24px;
            box-shadow: var(--shadow);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
            position: relative;
            overflow: hidden;
        }

        .header::before {
            content: '';
            position: absolute;
            top: 0; left: 0; width: 100%; height: 2px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
        }

        .header-left h1 { 
            font-size: 28px; 
            font-weight: 700; 
            background: linear-gradient(135deg, #fff 0%, #cbd5e1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .header-left .update-time { 
            font-size: 13px; 
            color: var(--text-secondary); 
            font-weight: 400; 
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .header-actions { display: flex; gap: 12px; flex-wrap: wrap; }

        .btn { 
            background: rgba(255, 255, 255, 0.05); 
            color: var(--text-primary); 
            border: 1px solid rgba(255, 255, 255, 0.1); 
            border-radius: 12px; 
            padding: 10px 20px; 
            font-size: 14px; 
            font-weight: 500;
            cursor: pointer; 
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-family: inherit;
        }

        .btn:hover { 
            background: rgba(255, 255, 255, 0.1); 
            transform: translateY(-2px); 
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .btn:active { transform: translateY(0); }

        .btn-primary { 
            background: linear-gradient(135deg, var(--primary), #7c3aed); 
            border: none;
            box-shadow: 0 4px 12px var(--primary-glow);
        }
        .btn-primary:hover { 
            background: linear-gradient(135deg, #7c3aed, var(--primary)); 
            box-shadow: 0 6px 16px var(--primary-glow);
        }

        .btn-success { 
            background: rgba(16, 185, 129, 0.1); 
            color: #34d399; 
            border-color: rgba(16, 185, 129, 0.2); 
        }
        .btn-success:hover { 
            background: rgba(16, 185, 129, 0.2); 
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);
        }

        .btn-danger { 
            background: rgba(239, 68, 68, 0.1); 
            color: #f87171; 
            border-color: rgba(239, 68, 68, 0.2); 
        }
        .btn-danger:hover { 
            background: rgba(239, 68, 68, 0.2); 
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
        }

        /* Stats Cards */
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); 
            gap: 24px; 
            margin-bottom: 24px;
        }

        .stat-card { 
            background: var(--bg-card);
            backdrop-filter: blur(12px);
            border: var(--glass-border);
            border-radius: 20px; 
            padding: 24px; 
            position: relative;
            overflow: hidden;
            transition: all 0.3s ease;
            box-shadow: var(--shadow);
        }

        .stat-card:hover { 
            transform: translateY(-4px); 
            background: var(--bg-card-hover);
            box-shadow: var(--shadow-lg);
            border-color: rgba(255, 255, 255, 0.1);
        }

        .stat-card::after {
            content: '';
            position: absolute;
            top: 0; right: 0; bottom: 0; left: 0;
            background: radial-gradient(circle at top right, rgba(255,255,255,0.03), transparent 60%);
            pointer-events: none;
        }

        .stat-icon { 
            width: 48px; height: 48px;
            border-radius: 12px;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px;
            margin-bottom: 16px;
            background: rgba(255, 255, 255, 0.05);
        }

        .stat-label { 
            font-size: 13px; 
            color: var(--text-secondary); 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            font-weight: 600;
            margin-bottom: 8px;
        }

        .stat-value { 
            font-size: 32px; 
            font-weight: 700; 
            color: white;
            letter-spacing: -0.5px;
        }

        .stat-value.gradient {
            background: linear-gradient(135deg, var(--secondary), var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        /* Table */
        .table-container { 
            background: var(--bg-card);
            backdrop-filter: blur(16px);
            border: var(--glass-border);
            border-radius: 24px; 
            padding: 24px;
            box-shadow: var(--shadow);
            overflow: hidden;
        }

        .table-wrapper { overflow-x: auto; }

        table { width: 100%; border-collapse: separate; border-spacing: 0; }

        th { 
            text-align: left; 
            padding: 16px 20px; 
            color: var(--text-secondary); 
            font-size: 12px; 
            font-weight: 600; 
            text-transform: uppercase; 
            letter-spacing: 1px;
            border-bottom: 1px solid var(--border);
        }

        td { 
            padding: 20px; 
            color: var(--text-primary); 
            font-size: 14px; 
            border-bottom: 1px solid var(--border);
            transition: background 0.2s;
        }

        tbody tr:hover td { background: rgba(255, 255, 255, 0.02); }
        tbody tr:last-child td { border-bottom: none; }

        .key-badge { 
            font-family: 'SF Mono', 'Fira Code', monospace; 
            background: rgba(0, 0, 0, 0.3); 
            padding: 6px 12px; 
            border-radius: 8px; 
            font-size: 12px; 
            color: #cbd5e1;
            border: 1px solid rgba(255, 255, 255, 0.05);
            display: inline-block;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            vertical-align: middle;
        }

        .status-dot {
            display: inline-block;
            width: 8px; height: 8px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .status-dot.active { background: var(--success); box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); }
        .status-dot.warning { background: var(--warning); box-shadow: 0 0 8px rgba(245, 158, 11, 0.4); }
        .status-dot.danger { background: var(--danger); box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }

        /* Progress Bar */
        .progress-track {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            overflow: hidden;
            margin-top: 8px;
        }
        .progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .progress-low { background: linear-gradient(90deg, #10b981, #34d399); }
        .progress-medium { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
        .progress-high { background: linear-gradient(90deg, #ef4444, #f87171); }

        /* Floating Action Button */
        .fab {
            position: fixed;
            bottom: 32px;
            right: 32px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: white;
            border: none;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(139, 92, 246, 0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 100;
        }
        .fab:hover { transform: translateY(-4px) rotate(180deg); box-shadow: 0 12px 32px rgba(139, 92, 246, 0.6); }
        .fab:active { transform: translateY(-2px); }

        /* Modal */
        .modal { 
            display: none; 
            position: fixed; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            background: rgba(0, 0, 0, 0.8); 
            backdrop-filter: blur(8px);
            z-index: 1000; 
            align-items: center; 
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .modal.show { display: flex; opacity: 1; }
        
        .modal-content { 
            background: #1e293b; 
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px; 
            width: 90%; 
            max-width: 600px; 
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            transform: scale(0.95);
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .modal.show .modal-content { transform: scale(1); }

        .modal-header { 
            padding: 24px 32px; 
            border-bottom: 1px solid var(--border);
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .modal-header h2 { font-size: 20px; font-weight: 600; color: white; }

        .close-btn { 
            background: transparent; 
            border: none; 
            color: var(--text-secondary); 
            font-size: 24px; 
            cursor: pointer; 
            transition: color 0.2s;
        }
        .close-btn:hover { color: white; }

        .modal-body { padding: 32px; }

        .form-group label { display: block; margin-bottom: 10px; color: var(--text-primary); font-size: 14px; font-weight: 500; }
        .form-group textarea { 
            width: 100%; 
            padding: 16px; 
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid var(--border); 
            border-radius: 12px; 
            color: white;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 13px;
            min-height: 200px;
            resize: vertical;
            transition: border-color 0.2s;
        }
        .form-group textarea:focus { outline: none; border-color: var(--primary); }

        /* Loading & Animations */
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .spinner { 
            width: 20px; height: 20px; 
            border: 2px solid rgba(255,255,255,0.3); 
            border-top-color: white; 
            border-radius: 50%; 
            animation: spin 0.8s linear infinite; 
        }

        .loading-container { text-align: center; padding: 60px; color: var(--text-secondary); }
        .loading-spinner-lg {
            width: 48px; height: 48px;
            border: 4px solid rgba(139, 92, 246, 0.1);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }

        /* Responsive */
        @media (max-width: 768px) {
            body { padding: 16px; }
            .header { padding: 20px; flex-direction: column; align-items: stretch; }
            .header-actions { justify-content: stretch; }
            .header-actions .btn { flex: 1; justify-content: center; }
            .stats-grid { grid-template-columns: 1fr; }
            .table-container { padding: 0; border-radius: 16px; }
            th, td { padding: 16px; }
            .fab { bottom: 20px; right: 20px; }
        }
    </style>  
</head>  
<body>
    <div class="container">
        <div class="header">
            <div class="header-left">
                <h1>
                    <span>⚡</span> API 监控看板
                </h1>
                <div class="update-time" id="updateTime">
                    <span class="spinner" style="width: 14px; height: 14px; border-width: 1px;"></span> 正在连接...
                </div>
            </div>
            <div class="header-actions">
                <button class="btn btn-primary" onclick="openManageModal()">
                    <span>＋</span> 导入 Key
                </button>
                <button class="btn btn-success" onclick="exportKeys()" id="exportKeysBtn">
                    <span>📥</span> 导出
                </button>
                <button class="btn btn-danger" onclick="deleteZeroBalanceKeys()" id="deleteZeroBtn">
                    <span>🧹</span> 清理无效
                </button>
                <button class="btn btn-danger" onclick="deleteAllKeys()" id="deleteAllBtn">
                    <span>🗑️</span> 全部删除
                </button>
            </div>
        </div>

        <div class="stats-grid" id="statsCards">
            <!-- Stats will be injected here -->
        </div>

        <div class="table-container">
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

    <button class="fab" onclick="loadData()" title="刷新数据">
        <span id="refreshIcon">↻</span>
        <span class="spinner" style="display: none;" id="spinner"></span>
    </button>

    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>📦 批量导入 API Key</h2>
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
                        <button type="submit" class="btn btn-primary" style="flex: 1; justify-content: center;">🚀 开始导入</button>
                        <button type="button" class="btn" style="background: rgba(255,255,255,0.1);" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>  
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;
        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';  
  
        function loadData(retryCount = 0) {  
            const spinner = document.getElementById('spinner');  
            const refreshIcon = document.getElementById('refreshIcon');  
            spinner.style.display = 'inline-block';  
            refreshIcon.style.display = 'none';  
  
            fetch('/api/data?t=' + new Date().getTime())  
                .then(response => {  
                    if (response.status === 503 && retryCount < 5) {
                        console.log(\`Server initializing, retrying in 2 seconds... (attempt \${retryCount + 1}/5)\`);
                        document.getElementById('tableContent').innerHTML = \`<div class="loading-container"><div class="loading-spinner-lg"></div><div>服务器正在初始化数据... (尝试 \${retryCount + 1}/5)</div></div>\`;
                        setTimeout(() => loadData(retryCount + 1), 2000);
                        return null;
                    }
                    if (!response.ok) throw new Error('无法加载数据: ' + response.statusText);  
                    return response.json();  
                })  
                .then(data => {
                    if (data === null) return;
                    if (data.error) throw new Error(data.error);  
                    displayData(data);  
                })  
                .catch(error => {  
                    document.getElementById('tableContent').innerHTML = \`<div class="loading-container" style="color: var(--danger)">❌ 加载失败: \${error.message}</div>\`;  
                    document.getElementById('updateTime').textContent = "加载失败";  
                })  
                .finally(() => {  
                    spinner.style.display = 'none';  
                    refreshIcon.style.display = 'inline';  
                });  
        }  
  
        function displayData(data) {
            currentApiData = data;
            document.getElementById('updateTime').innerHTML = \`🕒 最后更新: \${data.update_time} <span style="margin: 0 8px; opacity: 0.3">|</span> 共 \${data.total_count} 个 Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;
            const progressClass = overallRatio < 0.5 ? 'progress-low' : overallRatio < 0.8 ? 'progress-medium' : 'progress-high';

            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card">
                    <div class="stat-icon" style="color: #8b5cf6; background: rgba(139, 92, 246, 0.1);">💰</div>
                    <div class="stat-label">总计额度</div>
                    <div class="stat-value">\${formatNumber(totalAllowance)}</div>
                </div>  
                <div class="stat-card">
                    <div class="stat-icon" style="color: #06b6d4; background: rgba(6, 182, 212, 0.1);">📊</div>
                    <div class="stat-label">已使用</div>
                    <div class="stat-value">\${formatNumber(totalUsed)}</div>
                </div>  
                <div class="stat-card">
                    <div class="stat-icon" style="color: #10b981; background: rgba(16, 185, 129, 0.1);">✨</div>
                    <div class="stat-label">剩余额度</div>
                    <div class="stat-value gradient">\${formatNumber(totalRemaining)}</div>
                </div>  
                <div class="stat-card">
                    <div class="stat-icon" style="color: #f59e0b; background: rgba(245, 158, 11, 0.1);">📈</div>
                    <div class="stat-label">使用率</div>
                    <div class="stat-value">\${formatPercentage(overallRatio)}</div>
                    <div class="progress-track"><div class="progress-fill \${progressClass}" style="width: \${Math.min(overallRatio * 100, 100)}%"></div></div>
                </div>  
            \`;  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
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

            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td><span class="key-badge" title="\${item.key}">\${item.key}</span></td>
                            <td colspan="5" style="color: var(--danger); font-weight: 500;">⚠️ \${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="refreshSingleKey('\${item.id}')">↻</button>
                                <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px; margin-left: 6px;" onclick="deleteKeyFromTable('\${item.id}')">🗑️</button>
                            </td>
                        </tr>\`;
                } else {
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    const ratio = item.usedRatio || 0;
                    const progressClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';
                    const statusDot = remaining > 0 ? 'active' : 'danger';
                    
                    tableHTML += \`
                        <tr id="key-row-\${item.id}">
                            <td>
                                <div style="display: flex; align-items: center;">
                                    <span class="status-dot \${statusDot}"></span>
                                    <span class="key-badge" title="\${item.key}">\${item.key}</span>
                                </div>
                            </td>
                            <td style="font-size: 13px; color: var(--text-secondary);">\${item.startDate} <br> \${item.endDate}</td>
                            <td style="text-align: right; font-family: 'SF Mono', monospace;">\${formatNumber(item.totalAllowance)}</td>
                            <td style="text-align: right; font-family: 'SF Mono', monospace;">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td style="text-align: right; font-family: 'SF Mono', monospace; color: \${remaining > 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: 700;">\${formatNumber(remaining)}</td>
                            <td>
                                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px;">
                                    <span>\${formatPercentage(ratio)}</span>
                                </div>
                                <div class="progress-track"><div class="progress-fill \${progressClass}" style="width: \${Math.min(ratio * 100, 100)}%"></div></div>
                            </td>
                            <td style="text-align: center; white-space: nowrap;">
                                <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="refreshSingleKey('\${item.id}')" title="刷新">↻</button>
                                <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px; margin-left: 6px;" onclick="deleteKeyFromTable('\${item.id}')" title="删除">🗑️</button>
                            </td>
                        </tr>\`;
                }
            });

            tableHTML += \`</tbody></table>\`; 
            document.getElementById('tableContent').innerHTML = tableHTML;  
        }  
  
        document.addEventListener('DOMContentLoaded', loadData);

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
            const password = prompt('🔐 请输入导出密码：');
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
                    alert('❌ 导出失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('❌ 网络错误: ' + error.message);
            } finally {
                exportBtn.disabled = false;
                exportBtn.innerHTML = originalHTML;
            }
        }

        async function deleteAllKeys() {
            if (!currentApiData) return alert('⚠️ 请先加载数据');
            const totalKeys = currentApiData.total_count;
            if (totalKeys === 0) return alert('📭 没有可删除的 Key');

            if (!confirm(\`🚨 危险操作！\\n\\n确定要删除所有 \${totalKeys} 个 Key 吗？\\n此操作不可恢复！\`)) return;
            const secondConfirm = prompt('⚠️ 请输入 "确认删除" 以继续：');
            if (secondConfirm !== '确认删除') return alert('✅ 操作已取消');

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
                    alert(\`✅ 成功删除 \${result.deleted || totalKeys} 个 Key\`);
                    loadData();
                } else {
                    alert('❌ 删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('❌ 网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = originalHTML;
            }
        }

        async function deleteZeroBalanceKeys() {
            if (!currentApiData) return alert('⚠️ 请先加载数据');
            const zeroBalanceKeys = currentApiData.data.filter(item => {
                if (item.error) return false;
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (zeroBalanceKeys.length === 0) return alert('🎉 太棒了！没有找到余额为 0 的 Key');
            if (!confirm(\`🧹 清理确认\\n\\n发现 \${zeroBalanceKeys.length} 个余额为 0 的 Key\\n确定要删除吗？\`)) return;

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
                    alert(\`✅ 成功清理 \${result.deleted || zeroBalanceKeys.length} 个无效 Key\`);
                    loadData();
                } else {
                    alert('❌ 清理失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('❌ 网络错误: ' + error.message);
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
                    showMessage(\`🎉 成功导入 \${result.added} 个 Key\${result.skipped > 0 ? \`，跳过 \${result.skipped} 个重复\` : ''}\`);
                    document.getElementById('batchKeysInput').value = '';
                    closeManageModal();
                    loadData();
                } else {
                    showMessage(result.error || '批量导入失败', true);
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, true);
            }
        }

        async function deleteKeyFromTable(id) {
            if (!confirm(\`🗑️ 确定要删除这个 Key 吗？\`)) return;
            try {
                const response = await fetch(\`/api/keys/\${id}\`, { method: 'DELETE' });
                const result = await response.json();
                if (response.ok) loadData();
                else alert('❌ 删除失败: ' + (result.error || '未知错误'));
            } catch (error) {
                alert('❌ 网络错误: ' + error.message);
            }
        }

        async function refreshSingleKey(id) {
            const row = document.getElementById(\`key-row-\${id}\`);
            if (!row) return alert('找不到对应的行');

            const cells = row.querySelectorAll('td');
            const originalContent = [];
            cells.forEach((cell, index) => {
                originalContent[index] = cell.innerHTML;
                if (index > 0 && index < cells.length - 1) {
                    cell.innerHTML = '<span style="color: var(--text-secondary);">⏳ 刷新中...</span>';
                }
            });

            try {
                const response = await fetch(\`/api/keys/\${id}/refresh\`, { method: 'POST' });
                const result = await response.json();

                if (response.ok && result.data) {
                    const item = result.data;
                    if (item.error) {
                        cells[1].innerHTML = '<span style="color: var(--danger);">加载失败: ' + item.error + '</span>';
                        cells[2].colSpan = 5;
                        for (let i = 3; i < cells.length - 1; i++) cells[i].style.display = 'none';
                    } else {
                        const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                        const ratio = item.usedRatio || 0;
                        const progressClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';
                        const statusDot = remaining > 0 ? 'active' : 'danger';
                        
                        // Update cells
                        cells[0].innerHTML = \`<div style="display: flex; align-items: center;"><span class="status-dot \${statusDot}"></span><span class="key-badge" title="\${item.key}">\${item.key}</span></div>\`;
                        cells[1].innerHTML = \`\${item.startDate} <br> \${item.endDate}\`;
                        cells[2].innerHTML = formatNumber(item.totalAllowance);
                        cells[3].innerHTML = formatNumber(item.orgTotalTokensUsed);
                        cells[4].innerHTML = formatNumber(remaining);
                        cells[4].style.color = remaining > 0 ? 'var(--success)' : 'var(--danger)';
                        cells[5].innerHTML = \`
                            <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px;">
                                <span>\${formatPercentage(ratio)}</span>
                            </div>
                            <div class="progress-track"><div class="progress-fill \${progressClass}" style="width: \${Math.min(ratio * 100, 100)}%"></div></div>\`;
                        
                        for (let i = 1; i < cells.length - 1; i++) {
                            cells[i].style.display = '';
                            cells[i].colSpan = 1;
                        }
                    }
                    loadData();
                } else {
                    alert('刷新失败: ' + (result.error || '未知错误'));
                    cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
                cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
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
      return { id, key: maskedKey, error: `HTTP ${response.status}` };
    }

    const apiData: ApiResponse = await response.json();
    const { usage } = apiData;
    
    if (!usage?.standard) {
      return { id, key: maskedKey, error: 'Invalid API response' };
    }

    const { standard } = usage;
    return {
      id,
      key: maskedKey,
      startDate: formatDate(usage.startDate),
      endDate: formatDate(usage.endDate),
      orgTotalTokensUsed: standard.orgTotalTokensUsed || 0,
      totalAllowance: standard.totalAllowance || 0,
      usedRatio: standard.usedRatio || 0,
    };
  } catch (error) {
    return { id, key: maskedKey, error: 'Failed to fetch' };
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

    await Promise.all(ids.map(id => deleteKey(id).catch(() => {})));
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
