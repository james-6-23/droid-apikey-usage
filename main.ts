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
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>  
    <style>
        :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --secondary: #8b5cf6;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --bg-dark: #0f172a;
            --bg-card: rgba(255, 255, 255, 0.95);
            --text-primary: #1e293b;
            --text-secondary: #64748b;
            --border: rgba(148, 163, 184, 0.2);
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
            --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; 
            background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%);
            min-height: 100vh; 
            padding: 24px;
            background-attachment: fixed;
        }
        .container { 
            max-width: 1600px; 
            margin: 0 auto; 
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border-radius: 24px; 
            box-shadow: var(--shadow-lg);
            overflow: hidden;
            border: 1px solid var(--border);
        }
        .header { 
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%); 
            color: white; 
            padding: 32px 40px; 
            position: relative;
        }
        .header-content { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header-left h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
        .header-left .update-time { font-size: 13px; opacity: 0.85; font-weight: 500; }
        .header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
        .header-btn { 
            background: rgba(255, 255, 255, 0.15); 
            color: white; 
            border: 1px solid rgba(255, 255, 255, 0.3); 
            border-radius: 10px; 
            padding: 10px 18px; 
            font-size: 13px; 
            font-weight: 600;
            cursor: pointer; 
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
            backdrop-filter: blur(10px);
        }
        .header-btn:hover { background: rgba(255, 255, 255, 0.25); transform: translateY(-1px); }
        .header-btn:active { transform: translateY(0); }
        .header-btn.danger { background: rgba(239, 68, 68, 0.3); border-color: rgba(239, 68, 68, 0.5); }
        .header-btn.danger:hover { background: rgba(239, 68, 68, 0.4); }
        .header-btn.success { background: rgba(16, 185, 129, 0.3); border-color: rgba(16, 185, 129, 0.5); }
        .header-btn.success:hover { background: rgba(16, 185, 129, 0.4); }
        .stats-cards { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); 
            gap: 20px; 
            padding: 28px 40px; 
            background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
        }
        .stat-card { 
            background: white; 
            border-radius: 16px; 
            padding: 24px; 
            text-align: center; 
            box-shadow: var(--shadow);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            border: 1px solid var(--border);
            position: relative;
            overflow: hidden;
        }
        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .stat-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-lg); }
        .stat-card:hover::before { opacity: 1; }
        .stat-card .icon { font-size: 32px; margin-bottom: 12px; }
        .stat-card .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-card .value { font-size: 28px; font-weight: 700; background: linear-gradient(135deg, var(--primary), var(--secondary)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .table-container { padding: 0 40px 40px 40px; overflow-x: auto; }
        .table-wrapper { 
            background: white; 
            border-radius: 16px; 
            overflow: hidden; 
            box-shadow: var(--shadow);
            border: 1px solid var(--border);
        }
        table { width: 100%; border-collapse: collapse; }
        thead { background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%); color: white; }
        th { padding: 16px 20px; text-align: left; font-weight: 600; font-size: 13px; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.5px; }
        th.number { text-align: right; }
        td { padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 14px; color: var(--text-primary); }
        td.number { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
        td.error-row { color: var(--danger); font-weight: 500; }
        tbody tr { transition: all 0.15s ease; }
        tbody tr:hover { background: linear-gradient(90deg, rgba(99, 102, 241, 0.04), rgba(139, 92, 246, 0.04)); }
        tbody tr:last-child td { border-bottom: none; }
        .key-cell { 
            font-family: 'SF Mono', 'Fira Code', monospace; 
            color: var(--text-secondary); 
            max-width: 180px; 
            overflow: hidden; 
            text-overflow: ellipsis; 
            white-space: nowrap;
            font-size: 13px;
            background: #f8fafc;
            padding: 6px 10px;
            border-radius: 6px;
            display: inline-block;
        }
        .loading { 
            text-align: center; 
            padding: 60px 40px; 
            color: var(--text-secondary);
        }
        .loading-spinner {
            width: 48px;
            height: 48px;
            border: 4px solid var(--border);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 16px;
        }
        .error { text-align: center; padding: 60px 40px; color: var(--danger); }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: white; animation: spin 0.8s linear infinite; }
        
        /* Floating refresh button */
        .fab-refresh {
            position: fixed;
            bottom: 32px;
            right: 32px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: white;
            border: none;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
        }
        .fab-refresh:hover { transform: translateY(-4px) scale(1.05); box-shadow: 0 12px 32px rgba(99, 102, 241, 0.5); }
        .fab-refresh:active { transform: translateY(-2px) scale(1.02); }
        .fab-refresh .spinner { width: 24px; height: 24px; border-width: 3px; }

        /* Modal styles */
        .modal { 
            display: none; 
            position: fixed; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            background: rgba(15, 23, 42, 0.7); 
            backdrop-filter: blur(4px);
            z-index: 1000; 
            align-items: center; 
            justify-content: center;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .modal.show { display: flex; }
        .modal-content { 
            background: white; 
            border-radius: 20px; 
            width: 90%; 
            max-width: 600px; 
            max-height: 85vh; 
            overflow: auto; 
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            animation: slideUp 0.3s ease;
        }
        .modal-header { 
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%); 
            color: white; 
            padding: 24px 32px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .modal-header h2 { font-size: 20px; font-weight: 700; }
        .close-btn { 
            background: rgba(255,255,255,0.2); 
            border: none; 
            color: white; 
            width: 36px;
            height: 36px;
            border-radius: 50%;
            font-size: 20px; 
            cursor: pointer; 
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .close-btn:hover { background: rgba(255,255,255,0.3); transform: rotate(90deg); }
        .modal-body { padding: 32px; }
        .form-group { margin-bottom: 24px; }
        .form-group label { display: block; margin-bottom: 10px; font-weight: 600; color: var(--text-primary); font-size: 14px; }
        .form-group input, .form-group textarea { 
            width: 100%; 
            padding: 14px 16px; 
            border: 2px solid var(--border); 
            border-radius: 12px; 
            font-size: 14px; 
            font-family: inherit;
            transition: all 0.2s ease;
            background: #f8fafc;
        }
        .form-group input:focus, .form-group textarea:focus { 
            outline: none; 
            border-color: var(--primary); 
            background: white;
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
        }
        .form-group textarea { min-height: 180px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.6; resize: vertical; }
        .btn { 
            padding: 12px 24px; 
            border: none; 
            border-radius: 10px; 
            font-size: 14px; 
            cursor: pointer; 
            transition: all 0.2s ease; 
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .btn-primary { background: linear-gradient(135deg, var(--primary), var(--secondary)); color: white; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 16px rgba(99, 102, 241, 0.3); }
        .btn-secondary { background: #e2e8f0; color: var(--text-primary); }
        .btn-secondary:hover { background: #cbd5e1; }
        .btn-danger { background: var(--danger); color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-sm { padding: 8px 14px; font-size: 12px; border-radius: 8px; }
        .btn-group { display: flex; gap: 12px; margin-top: 24px; }
        .success-msg { 
            background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(16, 185, 129, 0.05)); 
            color: #065f46; 
            padding: 14px 18px; 
            border-radius: 12px; 
            margin-bottom: 20px; 
            border: 1px solid rgba(16, 185, 129, 0.2);
            font-weight: 500;
        }
        .error-msg { 
            background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(239, 68, 68, 0.05)); 
            color: #991b1b; 
            padding: 14px 18px; 
            border-radius: 12px; 
            margin-bottom: 20px; 
            border: 1px solid rgba(239, 68, 68, 0.2);
            font-weight: 500;
        }
        
        /* Progress bar for usage */
        .progress-bar {
            width: 100%;
            height: 6px;
            background: #e2e8f0;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 8px;
        }
        .progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease;
        }
        .progress-low { background: linear-gradient(90deg, #10b981, #34d399); }
        .progress-medium { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
        .progress-high { background: linear-gradient(90deg, #ef4444, #f87171); }
        
        /* Responsive */
        @media (max-width: 768px) {
            body { padding: 12px; }
            .header { padding: 20px; }
            .header-content { flex-direction: column; align-items: flex-start; }
            .header-left h1 { font-size: 22px; }
            .header-actions { width: 100%; justify-content: flex-start; }
            .stats-cards { padding: 20px; gap: 12px; grid-template-columns: repeat(2, 1fr); }
            .stat-card { padding: 16px; }
            .stat-card .value { font-size: 22px; }
            .table-container { padding: 0 16px 24px; }
            th, td { padding: 12px 10px; font-size: 12px; }
            .fab-refresh { width: 52px; height: 52px; bottom: 20px; right: 20px; }
        }
    </style>  
</head>  
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <div class="header-left">
                    <h1>🚀 API 余额监控看板</h1>
                    <div class="update-time" id="updateTime">正在加载...</div>
                </div>
                <div class="header-actions">
                    <button class="header-btn" onclick="openManageModal()">
                        <span>➕</span> 导入 Key
                    </button>
                    <button class="header-btn success" onclick="exportKeys()" id="exportKeysBtn">
                        <span>📥</span> 导出
                    </button>
                    <button class="header-btn danger" onclick="deleteZeroBalanceKeys()" id="deleteZeroBtn">
                        <span>🧹</span> 清理无效
                    </button>
                    <button class="header-btn danger" onclick="deleteAllKeys()" id="deleteAllBtn">
                        <span>🗑️</span> 全部删除
                    </button>
                </div>
            </div>
        </div>

        <div class="stats-cards" id="statsCards"></div>

        <div class="table-container">
            <div class="table-wrapper">
                <div id="tableContent">
                    <div class="loading">
                        <div class="loading-spinner"></div>
                        <div>正在加载数据...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <button class="fab-refresh" onclick="loadData()" title="刷新数据">
        <span id="refreshIcon">🔄</span>
        <span class="spinner" style="display: none;" id="spinner"></span>
    </button>

    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>📦 批量导入 API Key</h2>
                <button class="close-btn" onclick="closeManageModal()">✕</button>
            </div>
            <div class="modal-body">
                <div id="modalMessage"></div>

                <form onsubmit="batchImportKeys(event)">
                    <div class="form-group">
                        <label>请输入 API Keys（每行一个）</label>
                        <textarea id="batchKeysInput" placeholder="支持以下格式：&#10;&#10;fk-xxxxxxxxxxxxx&#10;fk-yyyyyyyyyyyyy&#10;fk-zzzzzzzzzzzzz&#10;&#10;或带自定义ID：&#10;my-key-1:fk-xxxxxxxxxxxxx"></textarea>
                    </div>
                    <div class="btn-group">
                        <button type="submit" class="btn btn-primary">🚀 开始导入</button>
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('batchKeysInput').value='';">清空内容</button>
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
                        document.getElementById('tableContent').innerHTML = \`<div class="loading"><div class="loading-spinner"></div><div>服务器正在初始化数据，请稍候... (尝试 \${retryCount + 1}/5)</div></div>\`;
                        setTimeout(() => loadData(retryCount + 1), 2000);
                        return null;
                    }
                    if (!response.ok) {  
                        throw new Error('无法加载数据: ' + response.statusText);  
                    }  
                    return response.json();  
                })  
                .then(data => {
                    if (data === null) return;
                    if (data.error) {  
                        throw new Error(data.error);  
                    }  
                    displayData(data);  
                })  
                .catch(error => {  
                    document.getElementById('tableContent').innerHTML = \`<div class="error">❌ 加载失败: \${error.message}</div>\`;  
                    document.getElementById('updateTime').textContent = "加载失败";  
                })  
                .finally(() => {  
                    spinner.style.display = 'none';  
                    refreshIcon.style.display = 'inline';  
                });  
        }  
  
  
        function displayData(data) {
            currentApiData = data;

            document.getElementById('updateTime').textContent = \`⏱️ 最后更新: \${data.update_time} · 共 \${data.total_count} 个 API Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;
            const progressClass = overallRatio < 0.5 ? 'progress-low' : overallRatio < 0.8 ? 'progress-medium' : 'progress-high';

            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card">
                    <div class="icon">💰</div>
                    <div class="label">总计额度</div>
                    <div class="value">\${formatNumber(totalAllowance)}</div>
                </div>  
                <div class="stat-card">
                    <div class="icon">📊</div>
                    <div class="label">已使用</div>
                    <div class="value">\${formatNumber(totalUsed)}</div>
                </div>  
                <div class="stat-card">
                    <div class="icon">✨</div>
                    <div class="label">剩余额度</div>
                    <div class="value">\${formatNumber(totalRemaining)}</div>
                </div>  
                <div class="stat-card">
                    <div class="icon">📈</div>
                    <div class="label">使用率</div>
                    <div class="value">\${formatPercentage(overallRatio)}</div>
                    <div class="progress-bar"><div class="progress-fill \${progressClass}" style="width: \${Math.min(overallRatio * 100, 100)}%"></div></div>
                </div>  
            \`;  
  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>API Key</th>
                            <th>开始日期</th>
                            <th>结束日期</th>
                            <th class="number">总额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余</th>
                            <th class="number">使用率</th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;

            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td><span class="key-cell" title="\${item.key}">\${item.key}</span></td>
                            <td colspan="5" class="error-row">⚠️ \${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary btn-sm" onclick="refreshSingleKey('\${item.id}')">🔄</button>
                                <button class="btn btn-danger btn-sm" onclick="deleteKeyFromTable('\${item.id}')" style="margin-left: 6px;">🗑️</button>
                            </td>
                        </tr>\`;
                } else {
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    const ratio = item.usedRatio || 0;
                    const progressClass = ratio < 0.5 ? 'progress-low' : ratio < 0.8 ? 'progress-medium' : 'progress-high';
                    tableHTML += \`
                        <tr id="key-row-\${item.id}">
                            <td><span class="key-cell" title="\${item.key}">\${item.key}</span></td>
                            <td>\${item.startDate}</td>
                            <td>\${item.endDate}</td>
                            <td class="number">\${formatNumber(item.totalAllowance)}</td>
                            <td class="number">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td class="number" style="color: \${remaining > 0 ? '#10b981' : '#ef4444'}; font-weight: 700;">\${formatNumber(remaining)}</td>
                            <td class="number">
                                <div>\${formatPercentage(ratio)}</div>
                                <div class="progress-bar" style="width: 80px;"><div class="progress-fill \${progressClass}" style="width: \${Math.min(ratio * 100, 100)}%"></div></div>
                            </td>
                            <td style="text-align: center; white-space: nowrap;">
                                <button class="btn btn-primary btn-sm" onclick="refreshSingleKey('\${item.id}')" title="刷新">🔄</button>
                                <button class="btn btn-danger btn-sm" onclick="deleteKeyFromTable('\${item.id}')" style="margin-left: 6px;" title="删除">🗑️</button>
                            </td>
                        </tr>\`;
                }
            });

            tableHTML += \`
                    </tbody>
                </table>\`; 
  
  
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
            msgDiv.innerHTML = \`<div class="\${isError ? 'error-msg' : 'success-msg'}">\${message}</div>\`;
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

            const confirmMsg = \`🚨 危险操作！\\n\\n确定要删除所有 \${totalKeys} 个 Key 吗？\\n此操作不可恢复！\`;
            if (!confirm(confirmMsg)) return;

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

            const confirmMsg = \`🧹 清理确认\\n\\n发现 \${zeroBalanceKeys.length} 个余额为 0 的 Key\\n确定要删除吗？\`;

            if (!confirm(confirmMsg)) return;

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
                    const msg = \`🎉 成功导入 \${result.added} 个 Key\${result.skipped > 0 ? \`，跳过 \${result.skipped} 个重复\` : ''}\`;
                    showMessage(msg);
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

                if (response.ok) {
                    loadData();
                } else {
                    alert('❌ 删除失败: ' + (result.error || '未知错误'));
                }
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
                    cell.innerHTML = '<span style="color: #6c757d;">⏳ 刷新中...</span>';
                }
            });

            try {
                const response = await fetch(\`/api/keys/\${id}/refresh\`, {
                    method: 'POST'
                });

                const result = await response.json();

                if (response.ok && result.data) {
                    const item = result.data;
                    
                    if (item.error) {
                        cells[1].innerHTML = '<span class="error-row">加载失败: ' + item.error + '</span>';
                        cells[2].colSpan = 5;
                        for (let i = 3; i < cells.length - 1; i++) cells[i].style.display = 'none';
                    } else {
                        const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                        [cells[1].innerHTML, cells[2].innerHTML, cells[3].innerHTML, 
                         cells[4].innerHTML, cells[5].innerHTML, cells[6].innerHTML] = 
                        [item.startDate, item.endDate, formatNumber(item.totalAllowance),
                         formatNumber(item.orgTotalTokensUsed), formatNumber(remaining), formatPercentage(item.usedRatio)];
                        
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