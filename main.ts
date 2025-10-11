// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// Initialize Deno KV
const kv = await Deno.openKv();

// KV Storage Interface
interface ApiKeyEntry {
  id: string;
  key: string;
  name?: string;
  createdAt: number;
}

// KV Database Functions
async function saveApiKey(id: string, key: string, name?: string): Promise<void> {
  const entry: ApiKeyEntry = {
    id,
    key,
    name: name || `Key ${id}`,
    createdAt: Date.now(),
  };
  await kv.set(["apikeys", id], entry);
}

async function getApiKey(id: string): Promise<ApiKeyEntry | null> {
  const result = await kv.get<ApiKeyEntry>(["apikeys", id]);
  return result.value;
}

async function getAllApiKeys(): Promise<ApiKeyEntry[]> {
  const entries: ApiKeyEntry[] = [];
  const iter = kv.list<ApiKeyEntry>({ prefix: ["apikeys"] });
  for await (const entry of iter) {
    entries.push(entry.value);
  }
  return entries;
}

async function deleteApiKey(id: string): Promise<void> {
  await kv.delete(["apikeys", id]);
}

async function batchImportKeys(keys: string[]): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].trim();
    if (key.length > 0) {
      try {
        const id = `key-${Date.now()}-${i}`;
        await saveApiKey(id, key);
        success++;
      } catch (error) {
        failed++;
        console.error(`Failed to import key ${i}:`, error);
      }
    }
  }

  return { success, failed };
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
        /* Apple-inspired Design System */
        :root {
            --color-primary: #007AFF;
            --color-secondary: #5856D6;
            --color-success: #34C759;
            --color-warning: #FF9500;
            --color-danger: #FF3B30;
            --color-bg: #F5F5F7;
            --color-surface: #FFFFFF;
            --color-text-primary: #1D1D1F;
            --color-text-secondary: #86868B;
            --color-border: rgba(0, 0, 0, 0.06);
            --color-shadow: rgba(0, 0, 0, 0.08);
            --radius-sm: 8px;
            --radius-md: 12px;
            --radius-lg: 18px;
            --radius-xl: 24px;
            --spacing-xs: 8px;
            --spacing-sm: 12px;
            --spacing-md: 16px;
            --spacing-lg: 24px;
            --spacing-xl: 32px;
            --transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @supports (backdrop-filter: blur(20px)) {
            .glass-effect {
                background: rgba(255, 255, 255, 0.72);
                backdrop-filter: saturate(180%) blur(20px);
            }
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif;
            background: var(--color-bg);
            min-height: 100vh;
            padding: var(--spacing-lg);
            color: var(--color-text-primary);
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: var(--color-surface);
            border-radius: var(--radius-xl);
            box-shadow: 0 8px 30px var(--color-shadow);
            overflow: hidden;
        }

        .header {
            position: relative;
            background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
            color: white;
            padding: var(--spacing-xl) var(--spacing-lg);
            text-align: center;
        }

        .header h1 {
            font-size: 34px;
            font-weight: 700;
            letter-spacing: -0.5px;
            margin-bottom: var(--spacing-xs);
        }

        .header .update-time {
            font-size: 15px;
            opacity: 0.85;
            font-weight: 400;
        }

        .stats-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: var(--spacing-md);
            padding: var(--spacing-xl);
            background: var(--color-bg);
        }

        .stat-card {
            background: var(--color-surface);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            text-align: center;
            border: 1px solid var(--color-border);
            transition: var(--transition);
        }

        .stat-card:hover {
            transform: translateY(-4px) scale(1.02);
            box-shadow: 0 12px 40px var(--color-shadow);
        }

        .stat-card .label {
            font-size: 13px;
            color: var(--color-text-secondary);
            margin-bottom: var(--spacing-sm);
            font-weight: 500;
            letter-spacing: 0.3px;
            text-transform: uppercase;
        }

        .stat-card .value {
            font-size: 32px;
            font-weight: 600;
            background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .table-container {
            padding: 0 var(--spacing-xl) var(--spacing-xl);
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            background: var(--color-surface);
            border-radius: var(--radius-md);
            overflow: hidden;
            border: 1px solid var(--color-border);
        }

        thead {
            background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
            color: white;
        }

        th {
            padding: var(--spacing-md) var(--spacing-md);
            text-align: left;
            font-weight: 600;
            font-size: 13px;
            white-space: nowrap;
            letter-spacing: 0.3px;
            text-transform: uppercase;
        }

        th.number { text-align: right; }

        td {
            padding: var(--spacing-md);
            border-bottom: 1px solid var(--color-border);
            font-size: 15px;
        }

        td.number {
            text-align: right;
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
            font-weight: 500;
            font-variant-numeric: tabular-nums;
        }

        td.error-row { color: var(--color-danger); }

        tbody tr { transition: background-color 0.2s ease; }
        tbody tr:hover { background-color: rgba(0, 122, 255, 0.04); }
        tbody tr:last-child td { border-bottom: none; }

        tfoot {
            background: var(--color-bg);
            font-weight: 600;
        }

        tfoot td {
            padding: var(--spacing-md);
            border-top: 2px solid var(--color-primary);
            border-bottom: none;
        }

        .key-cell {
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            color: var(--color-text-secondary);
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .refresh-btn {
            position: fixed;
            bottom: var(--spacing-xl);
            right: var(--spacing-xl);
            background: var(--color-primary);
            color: white;
            border: none;
            border-radius: 100px;
            padding: 16px 28px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(0, 122, 255, 0.35);
            transition: var(--transition);
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
        }

        .refresh-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 12px 32px rgba(0, 122, 255, 0.45);
        }

        .refresh-btn:active {
            transform: translateY(-1px);
        }

        .loading {
            text-align: center;
            padding: 60px 20px;
            color: var(--color-text-secondary);
            font-size: 15px;
        }

        .error {
            text-align: center;
            padding: 60px 20px;
            color: var(--color-danger);
            font-size: 15px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .spinner {
            display: inline-block;
            width: 18px;
            height: 18px;
            border: 2.5px solid rgba(255, 255, 255, 0.25);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 0.8s linear infinite;
        }

        .manage-btn {
            position: absolute;
            top: var(--spacing-lg);
            right: var(--spacing-lg);
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(10px);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.25);
            border-radius: 100px;
            padding: 10px 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
        }

        .manage-btn:hover {
            background: rgba(255, 255, 255, 0.25);
            transform: scale(1.05);
        }

        .manage-panel {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: var(--spacing-lg);
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .manage-content {
            background: var(--color-surface);
            border-radius: var(--radius-xl);
            max-width: 900px;
            width: 100%;
            max-height: 85vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(40px) scale(0.95);
            }
            to {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        .manage-header {
            background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
            color: white;
            padding: var(--spacing-lg) var(--spacing-xl);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .manage-header h2 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.3px;
        }

        .close-btn {
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(10px);
            border: none;
            color: white;
            font-size: 22px;
            cursor: pointer;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
        }

        .close-btn:hover {
            background: rgba(255, 255, 255, 0.25);
            transform: rotate(90deg);
        }

        .manage-content > div {
            padding: var(--spacing-xl);
            overflow-y: auto;
        }

        .import-section {
            border-bottom: 1px solid var(--color-border);
        }

        .import-section h3, .keys-list-section h3 {
            margin: 0 0 var(--spacing-md) 0;
            font-size: 20px;
            font-weight: 600;
            color: var(--color-text-primary);
            letter-spacing: -0.3px;
        }

        #importKeys {
            width: 100%;
            padding: var(--spacing-md);
            border: 1.5px solid var(--color-border);
            border-radius: var(--radius-md);
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
            font-size: 14px;
            resize: vertical;
            transition: var(--transition);
            line-height: 1.6;
        }

        #importKeys:focus {
            outline: none;
            border-color: var(--color-primary);
            box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.1);
        }

        .import-btn {
            margin-top: var(--spacing-md);
            background: var(--color-primary);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            padding: 12px 24px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
            display: inline-flex;
            align-items: center;
            gap: var(--spacing-xs);
        }

        .import-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0, 122, 255, 0.3);
        }

        .import-btn:active {
            transform: translateY(0);
        }

        .import-result {
            margin-top: var(--spacing-md);
            padding: var(--spacing-md);
            border-radius: var(--radius-sm);
            font-size: 14px;
            font-weight: 500;
        }

        .import-result.success {
            background: rgba(52, 199, 89, 0.1);
            color: var(--color-success);
            border: 1px solid rgba(52, 199, 89, 0.2);
        }

        .import-result.error {
            background: rgba(255, 59, 48, 0.1);
            color: var(--color-danger);
            border: 1px solid rgba(255, 59, 48, 0.2);
        }

        .keys-list {
            max-height: 320px;
            overflow-y: auto;
        }

        .keys-list::-webkit-scrollbar {
            width: 8px;
        }

        .keys-list::-webkit-scrollbar-track {
            background: transparent;
        }

        .keys-list::-webkit-scrollbar-thumb {
            background: var(--color-border);
            border-radius: 100px;
        }

        .keys-list::-webkit-scrollbar-thumb:hover {
            background: var(--color-text-secondary);
        }

        .key-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: var(--spacing-md);
            background: var(--color-bg);
            border-radius: var(--radius-md);
            margin-bottom: var(--spacing-sm);
            transition: var(--transition);
            border: 1px solid transparent;
        }

        .key-item:hover {
            background: rgba(0, 122, 255, 0.04);
            border-color: rgba(0, 122, 255, 0.1);
        }

        .key-info { flex: 1; }

        .key-id {
            font-weight: 600;
            color: var(--color-text-primary);
            font-size: 15px;
            margin-bottom: 4px;
        }

        .key-masked {
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
            color: var(--color-text-secondary);
            font-size: 13px;
        }

        .delete-btn {
            background: var(--color-danger);
            color: white;
            border: none;
            border-radius: var(--radius-sm);
            padding: 8px 16px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
        }

        .delete-btn:hover {
            background: #D32F2F;
            transform: scale(1.05);
        }

        .delete-btn:active {
            transform: scale(0.98);
        }

        /* Responsive Design */
        @media (max-width: 768px) {
            body { padding: var(--spacing-sm); }
            .header { padding: var(--spacing-lg); }
            .header h1 { font-size: 26px; }
            .stats-cards {
                grid-template-columns: 1fr;
                padding: var(--spacing-lg);
            }
            .table-container { padding: 0 var(--spacing-md) var(--spacing-lg); }
            .manage-btn {
                position: static;
                margin-top: var(--spacing-md);
                width: 100%;
            }
            .refresh-btn {
                bottom: var(--spacing-md);
                right: var(--spacing-md);
                padding: 14px 24px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 API 余额监控看板</h1>
            <div class="update-time" id="updateTime">正在加载...</div>
            <button class="manage-btn" onclick="toggleManagePanel()">⚙️ 管理密钥</button>
        </div>

        <!-- Management Panel -->
        <div class="manage-panel" id="managePanel" style="display: none;">
            <div class="manage-header">
                <h2>密钥管理</h2>
                <button class="close-btn" onclick="toggleManagePanel()">✕</button>
            </div>
            <div class="manage-content">
                <div class="import-section">
                    <h3>批量导入</h3>
                    <textarea id="importKeys" placeholder="每行粘贴一个 API Key&#10;fk-xxxxx&#10;fk-yyyyy&#10;fk-zzzzz" rows="8"></textarea>
                    <button class="import-btn" onclick="importKeys()">
                        <span id="importSpinner" style="display: none;" class="spinner"></span>
                        <span id="importText">导入密钥</span>
                    </button>
                    <div id="importResult" class="import-result"></div>
                </div>
                <div class="keys-list-section">
                    <h3>已存储的密钥</h3>
                    <div id="keysList" class="keys-list">
                        <div class="loading">加载中...</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="stats-cards" id="statsCards"></div>

        <div class="table-container">
            <div id="tableContent">
                <div class="loading">正在加载数据...</div>
            </div>
        </div>
    </div>

    <button class="refresh-btn" onclick="loadData()">
        <span class="spinner" style="display: none;" id="spinner"></span>
        <span id="btnText">🔄 刷新数据</span>
    </button>

    <script>
        function formatNumber(num) {
            if (num === undefined || num === null) {
                return '0';
            }
            return new Intl.NumberFormat('en-US').format(num);
        }

        function formatPercentage(ratio) {
            if (ratio === undefined || ratio === null) {
                return '0.00%';
            }
            return (ratio * 100).toFixed(2) + '%';
        }

        function loadData() {
            const spinner = document.getElementById('spinner');
            const btnText = document.getElementById('btnText');
              
            spinner.style.display = 'inline-block';
            btnText.textContent = '加载中...';

            fetch('/api/data?t=' + new Date().getTime())
                .then(response => {
                    if (!response.ok) {
                        throw new Error('无法加载数据: ' + response.statusText);
                    }
                    return response.json();
                })
                .then(data => {
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
                    btnText.textContent = '🔄 刷新数据';
                });
        }

        function displayData(data) {
            document.getElementById('updateTime').textContent = \`最后更新: \${data.update_time} | 共 \${data.total_count} 个API Key\`;
            
            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            const totalRemaining = totalAllowance - totalUsed;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;

            const statsCards = document.getElementById('statsCards');
            statsCards.innerHTML = \`
                <div class="stat-card"><div class="label">总计额度 (Total Allowance)</div><div class="value">\${formatNumber(totalAllowance)}</div></div>
                <div class="stat-card"><div class="label">已使用 (Total Used)</div><div class="value">\${formatNumber(totalUsed)}</div></div>
                <div class="stat-card"><div class="label">剩余额度 (Remaining)</div><div class="value">\${formatNumber(totalRemaining)}</div></div>
                <div class="stat-card"><div class="label">使用百分比 (Usage %)</div><div class="value">\${formatPercentage(overallRatio)}</div></div>
            \`;

            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>API Key</th>
                            <th>开始时间</th>
                            <th>结束时间</th>
                            <th class="number">总计额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余额度</th>
                            <th class="number">使用百分比</th>
                        </tr>
                    </thead>
                    <tbody>\`;

            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td>\${item.id}</td>
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td colspan="6" class="error-row">加载失败: \${item.error}</td>
                        </tr>\`;
                } else {
                    const remaining = item.totalAllowance - item.orgTotalTokensUsed;
                    tableHTML += \`
                        <tr>
                            <td>\${item.id}</td>
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td>\${item.startDate}</td>
                            <td>\${item.endDate}</td>
                            <td class="number">\${formatNumber(item.totalAllowance)}</td>
                            <td class="number">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td class="number">\${formatNumber(remaining)}</td>
                            <td class="number">\${formatPercentage(item.usedRatio)}</td>
                        </tr>\`;
                }
            });

            tableHTML += \`
                    </tbody>
                    <tfoot>
                        <tr>
                            <td colspan="4">总计 (SUM)</td>
                            <td class="number">\${formatNumber(totalAllowance)}</td>
                            <td class="number">\${formatNumber(totalUsed)}</td>
                            <td class="number">\${formatNumber(totalRemaining)}</td>
                            <td class="number">\${formatPercentage(overallRatio)}</td>
                        </tr>
                    </tfoot>
                </table>\`;

            document.getElementById('tableContent').innerHTML = tableHTML;
        }

        // Toggle manage panel
        function toggleManagePanel() {
            const panel = document.getElementById('managePanel');
            if (panel.style.display === 'none') {
                panel.style.display = 'flex';
                loadKeysList();
            } else {
                panel.style.display = 'none';
            }
        }

        // Load keys list
        async function loadKeysList() {
            const keysList = document.getElementById('keysList');
            keysList.innerHTML = '<div class="loading">加载中...</div>';

            try {
                const response = await fetch('/api/keys');
                const keys = await response.json();

                if (keys.length === 0) {
                    keysList.innerHTML = '<div class="loading">暂无密钥，请先导入</div>';
                    return;
                }

                keysList.innerHTML = keys.map(key => \`
                    <div class="key-item">
                        <div class="key-info">
                            <div class="key-id">\${key.name || key.id}</div>
                            <div class="key-masked">\${key.masked}</div>
                        </div>
                        <button class="delete-btn" onclick="deleteKey('\${key.id}')">删除</button>
                    </div>
                \`).join('');
            } catch (error) {
                keysList.innerHTML = '<div class="error">加载失败: ' + error.message + '</div>';
            }
        }

        // Import keys
        async function importKeys() {
            const textarea = document.getElementById('importKeys');
            const spinner = document.getElementById('importSpinner');
            const text = document.getElementById('importText');
            const result = document.getElementById('importResult');

            const keysText = textarea.value.trim();
            if (!keysText) {
                result.className = 'import-result error';
                result.textContent = '请输入至少一个 API Key';
                return;
            }

            const keys = keysText.split('\\n').map(k => k.trim()).filter(k => k.length > 0);

            spinner.style.display = 'inline-block';
            text.textContent = '导入中...';
            result.textContent = '';
            result.className = 'import-result';

            try {
                const response = await fetch('/api/keys/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys })
                });

                const data = await response.json();

                if (response.ok) {
                    result.className = 'import-result success';
                    result.textContent = \`成功导入 \${data.success} 个密钥\${data.failed > 0 ? \`, \${data.failed} 个失败\` : ''}\`;
                    textarea.value = '';
                    loadKeysList();
                } else {
                    result.className = 'import-result error';
                    result.textContent = '导入失败: ' + data.error;
                }
            } catch (error) {
                result.className = 'import-result error';
                result.textContent = '导入失败: ' + error.message;
            } finally {
                spinner.style.display = 'none';
                text.textContent = '导入密钥';
            }
        }

        // Delete key
        async function deleteKey(id) {
            if (!confirm('确定要删除这个密钥吗？')) {
                return;
            }

            try {
                const response = await fetch(\`/api/keys/\${id}\`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    loadKeysList();
                } else {
                    const data = await response.json();
                    alert('删除失败: ' + data.error);
                }
            } catch (error) {
                alert('删除失败: ' + error.message);
            }
        }

        document.addEventListener('DOMContentLoaded', loadData);
    </script>
</body>
</html>
`;

/**
 * Fetches usage data for a single API key.
 */
async function fetchApiKeyData(id: string, key: string) {
  try {
    const response = await fetch('https://app.factory.ai/api/organization/members/chat-usage', {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error fetching data for key ID ${id}: ${response.status} ${errorBody}`);
      return { id, key: `${key.substring(0, 4)}...`, error: `HTTP ${response.status}` };
    }

    const apiData = await response.json();
    if (!apiData.usage || !apiData.usage.standard) {
        return { id, key: `${key.substring(0, 4)}...`, error: 'Invalid API response structure' };
    }
    
    const usageInfo = apiData.usage;
    const standardUsage = usageInfo.standard;

    const formatDate = (timestamp) => {
        if (!timestamp && timestamp !== 0) return 'N/A';
        try {
            return new Date(timestamp).toISOString().split('T')[0];
        } catch (e) {
            return 'Invalid Date';
        }
    }

    const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
    return {
      id,
      key: maskedKey,
      startDate: formatDate(usageInfo.startDate),
      endDate: formatDate(usageInfo.endDate),
      orgTotalTokensUsed: standardUsage.orgTotalTokensUsed,
      totalAllowance: standardUsage.totalAllowance,
      usedRatio: standardUsage.usedRatio,
    };
  } catch (error) {
    console.error(`Failed to process key ID ${id}:`, error);
    return { id, key: `${key.substring(0, 4)}...`, error: 'Failed to fetch' };
  }
}

/**
 * Aggregates data from all API keys stored in KV.
 */
async function getAggregatedData() {
  // Get all API keys from KV storage
  const keyEntries = await getAllApiKeys();

  if (keyEntries.length === 0) {
    throw new Error("No API keys found in storage. Please import keys first.");
  }

  const results = await Promise.all(keyEntries.map(entry => fetchApiKeyData(entry.id, entry.key)));

  const validResults = results.filter(r => !r.error);

  const totals = validResults.reduce((acc, res) => {
    acc.total_orgTotalTokensUsed += res.orgTotalTokensUsed || 0;
    acc.total_totalAllowance += res.totalAllowance || 0;
    return acc;
  }, {
    total_orgTotalTokensUsed: 0,
    total_totalAllowance: 0,
  });

  const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000);

  // 输出剩余额度大于0的key到日志
  const keysWithBalance = validResults.filter(r => {
    const remaining = (r.totalAllowance || 0) - (r.orgTotalTokensUsed || 0);
    return remaining > 0;
  });

  if (keysWithBalance.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("📋 剩余额度大于0的API Keys:");
    console.log("-".repeat(80));
    keysWithBalance.forEach(item => {
      const originalEntry = keyEntries.find(e => e.id === item.id);
      if (originalEntry) {
        console.log(originalEntry.key);
      }
    });
    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }

  return {
    update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: keyEntries.length,
    totals,
    data: results,
  };
}

/**
 * Main HTTP request handler.
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // Home page
  if (url.pathname === "/") {
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  // Get usage data
  if (url.pathname === "/api/data") {
    try {
      const data = await getAggregatedData();
      return new Response(JSON.stringify(data), { headers });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Get all keys (list only IDs and names, not actual keys)
  if (url.pathname === "/api/keys" && req.method === "GET") {
    try {
      const keys = await getAllApiKeys();
      const safeKeys = keys.map(k => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        masked: `${k.key.substring(0, 4)}...${k.key.substring(k.key.length - 4)}`
      }));
      return new Response(JSON.stringify(safeKeys), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Batch import keys
  if (url.pathname === "/api/keys/import" && req.method === "POST") {
    try {
      const body = await req.json();
      const keys = body.keys as string[];

      if (!Array.isArray(keys)) {
        return new Response(JSON.stringify({ error: "Invalid request: 'keys' must be an array" }), {
          status: 400,
          headers,
        });
      }

      const result = await batchImportKeys(keys);
      return new Response(JSON.stringify(result), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Delete a key
  if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
    try {
      const id = url.pathname.split("/").pop();
      if (!id) {
        return new Response(JSON.stringify({ error: "Key ID required" }), {
          status: 400,
          headers,
        });
      }

      await deleteApiKey(id);
      return new Response(JSON.stringify({ success: true }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Add a single key
  if (url.pathname === "/api/keys" && req.method === "POST") {
    try {
      const body = await req.json();
      const { key, name } = body;

      if (!key) {
        return new Response(JSON.stringify({ error: "Key is required" }), {
          status: 400,
          headers,
        });
      }

      const id = `key-${Date.now()}`;
      await saveApiKey(id, key, name);
      return new Response(JSON.stringify({ success: true, id }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

console.log("Server running on http://localhost:8000");
serve(handler);
