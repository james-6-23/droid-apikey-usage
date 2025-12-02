// main.ts - Optimized by Apple Senior Engineer
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";
import { setCookie, getCookies } from "https://deno.land/std@0.182.0/http/cookie.ts";

// Initialize Deno KV
const kv = await Deno.openKv();

// Get admin password from environment variable
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD");

console.log(`🔒 Password Protection: ${ADMIN_PASSWORD ? 'ENABLED' : 'DISABLED'}`);

// Session Management
interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

async function createSession(): Promise<string> {
  const sessionId = crypto.randomUUID();
  const session: Session = {
    id: sessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days
  };
  await kv.set(["sessions", sessionId], session);
  return sessionId;
}

async function validateSession(sessionId: string): Promise<boolean> {
  const result = await kv.get<Session>(["sessions", sessionId]);
  if (!result.value) return false;

  const session = result.value;
  if (Date.now() > session.expiresAt) {
    await kv.delete(["sessions", sessionId]);
    return false;
  }

  return true;
}

async function isAuthenticated(req: Request): Promise<boolean> {
  // If no password is set, allow access
  if (!ADMIN_PASSWORD) return true;

  const cookies = getCookies(req.headers);
  const sessionId = cookies.session;

  if (!sessionId) return false;

  return await validateSession(sessionId);
}

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

async function batchImportKeys(keys: string[]): Promise<{ success: number; failed: number; duplicates: number }> {
  let success = 0;
  let failed = 0;
  let duplicates = 0;

  const existingKeys = await getAllApiKeys();
  const existingKeySet = new Set(existingKeys.map(k => k.key));

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].trim();
    if (key.length > 0) {
      try {
        if (existingKeySet.has(key)) {
          duplicates++;
          console.log(`Skipped duplicate key: ${key.substring(0, 10)}...`);
          continue;
        }
        
        const id = `key-${Date.now()}-${i}`;
        await saveApiKey(id, key);
        existingKeySet.add(key);
        success++;
      } catch (error) {
        failed++;
        console.error(`Failed to import key ${i}:`, error);
      }
    }
  }

  return { success, failed, duplicates };
}

async function batchDeleteKeys(ids: string[]): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await deleteApiKey(id);
      success++;
    } catch (error) {
      failed++;
      console.error(`Failed to delete key ${id}:`, error);
    }
  }

  return { success, failed };
}

// Login Page HTML
const LOGIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - API 余额监控</title>
    <style>
        :root {
            --system-blue: #007AFF;
            --system-gray: #8E8E93;
            --glass-material: rgba(255, 255, 255, 0.25);
            --glass-border: rgba(255, 255, 255, 0.2);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.12);
            --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.2);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
            background: url('https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?q=80&w=2874&auto=format&fit=crop') center/cover no-repeat fixed;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(30px);
            -webkit-backdrop-filter: blur(30px);
        }

        .login-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            width: 100%;
            max-width: 320px;
            padding: 40px 20px;
            animation: fadeIn 0.8s cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }

        .avatar-container {
            width: 96px;
            height: 96px;
            background: rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 16px;
            box-shadow: var(--shadow-md);
            border: 1px solid rgba(255, 255, 255, 0.5);
        }

        .avatar {
            font-size: 48px;
        }

        .user-name {
            font-size: 24px;
            font-weight: 600;
            color: white;
            margin-bottom: 24px;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            letter-spacing: -0.5px;
        }

        .input-group {
            position: relative;
            width: 100%;
        }

        input[type="password"] {
            width: 100%;
            padding: 12px 16px;
            padding-right: 40px;
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            font-size: 14px;
            color: white;
            backdrop-filter: blur(10px);
            transition: all 0.2s ease;
            text-align: center;
            font-family: "SF Pro Text", sans-serif;
        }

        input[type="password"]::placeholder {
            color: rgba(255, 255, 255, 0.6);
        }

        input[type="password"]:focus {
            outline: none;
            background: rgba(255, 255, 255, 0.3);
            border-color: rgba(255, 255, 255, 0.5);
            box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.1);
        }

        .enter-btn {
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: none;
            background: rgba(255, 255, 255, 0.3);
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0;
            transition: all 0.2s ease;
        }

        input[type="password"]:not(:placeholder-shown) + .enter-btn {
            opacity: 1;
        }

        .enter-btn:hover {
            background: rgba(255, 255, 255, 0.5);
        }

        .error-message {
            margin-top: 16px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 13px;
            background: rgba(255, 59, 48, 0.4);
            padding: 8px 16px;
            border-radius: 8px;
            opacity: 0;
            transform: translateY(10px);
            transition: all 0.3s ease;
        }

        .error-message.show {
            opacity: 1;
            transform: translateY(0);
        }

        .blur-bg {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: -1;
            background: rgba(0, 0, 0, 0.2);
        }
    </style>
</head>
<body>
    <div class="blur-bg"></div>
    <div class="login-container">
        <div class="avatar-container">
            <div class="avatar"></div>
        </div>
        <div class="user-name">Administrator</div>

        <form onsubmit="handleLogin(event)" style="width: 100%;">
            <div class="input-group">
                <input
                    type="password"
                    id="password"
                    placeholder="Enter Password"
                    autocomplete="current-password"
                    required
                >
                <button type="submit" class="enter-btn">➜</button>
            </div>
        </form>

        <div class="error-message" id="errorMessage">
            Incorrect password
        </div>
    </div>

    <script>
        async function handleLogin(event) {
            event.preventDefault();
            const passwordInput = document.getElementById('password');
            const errorMessage = document.getElementById('errorMessage');
            const password = passwordInput.value;

            const container = document.querySelector('.login-container');

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password }),
                });

                if (response.ok) {
                    passwordInput.style.borderColor = '#34C759';
                    window.location.href = '/';
                } else {
                    container.animate([
                        { transform: 'translateX(0)' },
                        { transform: 'translateX(-10px)' },
                        { transform: 'translateX(10px)' },
                        { transform: 'translateX(0)' }
                    ], { duration: 300, easing: 'ease-in-out' });
                    
                    errorMessage.classList.add('show');
                    passwordInput.value = '';
                    passwordInput.focus();
                    setTimeout(() => errorMessage.classList.remove('show'), 3000);
                }
            } catch (error) {
                alert('Login failed: ' + error.message);
            }
        }
    </script>
</body>
</html>
`;

// Main Application HTML
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Droid Dashboard</title>
    <style>
        :root {
            --system-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
            --mono-font: "SF Mono", "Menlo", "Monaco", "Courier New", monospace;
            --primary: #007AFF;
            --success: #34C759;
            --warning: #FF9500;
            --danger: #FF3B30;
            --bg: #F2F2F7;
            --surface: rgba(255, 255, 255, 0.72);
            --surface-hover: rgba(255, 255, 255, 0.9);
            --text-primary: #1D1D1F;
            --text-secondary: #86868B;
            --border: rgba(0, 0, 0, 0.05);
            --glass: blur(25px) saturate(180%);
            --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
            --shadow-md: 0 4px 12px rgba(0,0,0,0.06);
        }

        * { box-sizing: border-box; outline: none; -webkit-tap-highlight-color: transparent; }
        body {
            margin: 0;
            font-family: var(--system-font);
            background: var(--bg);
            color: var(--text-primary);
            padding: 20px;
            min-height: 100vh;
        }

        .header {
            position: sticky;
            top: 20px;
            z-index: 100;
            background: var(--surface);
            backdrop-filter: var(--glass);
            -webkit-backdrop-filter: var(--glass);
            border-radius: 20px;
            padding: 16px 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: var(--shadow-md);
            margin-bottom: 32px;
            border: 1px solid rgba(255,255,255,0.4);
        }

        .logo { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; display: flex; align-items: center; gap: 10px; }
        .update-badge { font-size: 12px; font-weight: 500; color: var(--text-secondary); background: rgba(0,0,0,0.05); padding: 4px 10px; border-radius: 20px; }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }

        .card {
            background: #FFFFFF;
            border-radius: 20px;
            padding: 24px;
            box-shadow: var(--shadow-sm);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
        
        .card-label { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .card-value { font-size: 32px; font-weight: 700; letter-spacing: -0.5px; color: var(--text-primary); }
        
        .progress-bar { height: 6px; background: #F2F2F7; border-radius: 3px; margin-top: 12px; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--primary); border-radius: 3px; transition: width 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }

        .table-card {
            background: var(--surface);
            backdrop-filter: var(--glass);
            -webkit-backdrop-filter: var(--glass);
            border-radius: 24px;
            box-shadow: var(--shadow-md);
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.4);
        }

        .toolbar {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        table { width: 100%; border-collapse: collapse; }
        th {
            text-align: left;
            padding: 16px 24px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            background: rgba(0,0,0,0.02);
            border-bottom: 1px solid var(--border);
        }
        td {
            padding: 16px 24px;
            font-size: 14px;
            border-bottom: 1px solid var(--border);
            vertical-align: middle;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(0,0,0,0.01); }

        .mono { font-family: var(--mono-font); letter-spacing: -0.5px; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 500; background: rgba(0,0,0,0.05); }
        
        .btn {
            border: none;
            background: var(--primary);
            color: white;
            padding: 10px 20px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn:hover { filter: brightness(1.1); transform: scale(1.02); }
        .btn:active { transform: scale(0.98); }
        .btn-secondary { background: rgba(0,0,0,0.05); color: var(--text-primary); }
        .btn-secondary:hover { background: rgba(0,0,0,0.1); }
        .btn-danger { background: var(--danger); color: white; }
        .btn-icon { width: 32px; height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }

        .float-fab {
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: var(--primary);
            color: white;
            border-radius: 50%;
            width: 56px;
            height: 56px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            box-shadow: 0 8px 24px rgba(0,122,255,0.3);
            border: none;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            z-index: 900;
        }
        .float-fab:hover { transform: scale(1.1); }
        
        .modal-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.3);
            backdrop-filter: blur(10px);
            z-index: 1000;
            display: none;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s;
        }
        .modal-overlay.show { display: flex; opacity: 1; }
        
        .modal {
            background: #fff;
            width: 90%;
            max-width: 600px;
            border-radius: 24px;
            padding: 32px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            transform: scale(0.9);
            transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .modal-overlay.show .modal { transform: scale(1); }

        /* Toast */
        .toast {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(-100px);
            background: rgba(255,255,255,0.9);
            backdrop-filter: blur(10px);
            padding: 12px 24px;
            border-radius: 50px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            font-weight: 500;
            z-index: 2000;
            transition: transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .toast.show { transform: translateX(-50%) translateY(0); }
        
        /* Custom scrollbar */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 4px; }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo">🚀 Droid Dashboard</div>
        <div class="update-badge" id="updateTime">Loading...</div>
    </div>

    <div class="stats-grid" id="statsCards"></div>

    <div class="table-card">
        <div class="toolbar">
            <div style="font-weight: 600; font-size: 16px;">API Keys</div>
            <div style="display: flex; gap: 10px;">
                <select id="pageSizeSelect" class="btn btn-secondary" style="padding: 8px 12px; -webkit-appearance: none;" onchange="changePageSize(this.value)">
                    <option value="10">10 Rows</option>
                    <option value="30">30 Rows</option>
                    <option value="100">100 Rows</option>
                    <option value="all">Show All</option>
                </select>
                <button class="btn btn-secondary" onclick="toggleManagePanel()">Manage</button>
                <button class="btn btn-secondary" onclick="clearZeroBalanceKeys()">Clean</button>
            </div>
        </div>
        <div id="tableContent" style="overflow-x: auto;">
            <div class="loading">Loading Data...</div>
        </div>
    </div>

    <button class="float-fab" onclick="loadData()">↻</button>

    <!-- Modal -->
    <div class="modal-overlay" id="managePanel">
        <div class="modal">
            <div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
                <h2 style="margin: 0;">Import Keys</h2>
                <button class="btn btn-secondary btn-icon" onclick="toggleManagePanel()">✕</button>
            </div>
            <textarea id="importKeys" class="mono" placeholder="Paste API keys here (one per line)" style="width: 100%; height: 150px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; resize: none; background: #F5F5F7; font-size: 14px;"></textarea>
            <div style="display: flex; justify-content: flex-end; margin-top: 20px; gap: 10px;">
                <button class="btn btn-secondary" onclick="toggleManagePanel()">Cancel</button>
                <button class="btn" onclick="importKeys()">Import Keys</button>
            </div>
            <div id="importResult" style="margin-top: 16px; font-size: 14px; text-align: center;"></div>
        </div>
    </div>

    <script>
        const PAGE_SIZE_KEY = 'droid_page_size';
        let currentPage = 1;
        let itemsPerPage = parseInt(localStorage.getItem(PAGE_SIZE_KEY)) || 10;
        let allData = null;
        let selectedKeys = new Set();

        function showToast(msg, type = 'success') {
            const t = document.createElement('div');
            t.className = 'toast show';
            t.innerHTML = (type === 'error' ? '❌ ' : '✅ ') + msg;
            document.body.appendChild(t);
            setTimeout(() => {
                t.classList.remove('show');
                setTimeout(() => t.remove(), 500);
            }, 3000);
        }

        async function loadData() {
            document.querySelector('.float-fab').style.transform = 'rotate(360deg)';
            try {
                const res = await fetch('/api/data?t=' + Date.now());
                const data = await res.json();
                if(data.error) throw new Error(data.error);
                displayData(data);
                showToast('Data refreshed');
            } catch(e) {
                showToast(e.message, 'error');
            } finally {
                setTimeout(() => document.querySelector('.float-fab').style.transform = 'none', 500);
            }
        }

        function formatNumber(n) { return new Intl.NumberFormat('en-US').format(n || 0); }
        function formatPercent(n) { return ((n || 0) * 100).toFixed(2) + '%'; }

        function displayData(data) {
            allData = data;
            document.getElementById('updateTime').innerText = 'Updated: ' + data.update_time;
            
            const totals = data.totals;
            const ratio = totals.total_totalAllowance ? (totals.total_totalAllowance - totals.total_tokensRemaining) / totals.total_totalAllowance : 0;
            
            document.getElementById('statsCards').innerHTML = \`
                <div class="card">
                    <div class="card-label">Total Allowance</div>
                    <div class="card-value">\${formatNumber(totals.total_totalAllowance)}</div>
                </div>
                <div class="card">
                    <div class="card-label">Used</div>
                    <div class="card-value">\${formatNumber(totals.total_orgTotalTokensUsed)}</div>
                </div>
                <div class="card">
                    <div class="card-label">Remaining</div>
                    <div class="card-value" style="color: var(--success);">\${formatNumber(totals.total_tokensRemaining)}</div>
                </div>
                <div class="card">
                    <div class="card-label">Usage</div>
                    <div class="card-value">\${formatPercent(ratio)}</div>
                    <div class="progress-bar"><div class="progress-fill" style="width: \${Math.min(ratio * 100, 100)}%"></div></div>
                </div>
            \`;
            renderTable();
        }

        function renderTable() {
            if(!allData) return;
            const data = allData.data;
            const total = data.length;
            const start = itemsPerPage === 'all' ? 0 : (currentPage - 1) * itemsPerPage;
            const end = itemsPerPage === 'all' ? total : start + itemsPerPage;
            const pageData = data.slice(start, end);

            let html = '<table><thead><tr><th>ID</th><th>Key</th><th>Start</th><th>End</th><th style="text-align: right">Limit</th><th style="text-align: right">Used</th><th style="text-align: right">Left</th><th style="text-align: right">Action</th></tr></thead><tbody>';
            
            // Total Row
            const t = allData.totals;
            html += \`<tr style="background: rgba(0,122,255,0.05); font-weight: 700;">
                <td>TOTAL</td><td></td><td></td><td></td>
                <td style="text-align: right">\${formatNumber(t.total_totalAllowance)}</td>
                <td style="text-align: right">\${formatNumber(t.total_orgTotalTokensUsed)}</td>
                <td style="text-align: right">\${formatNumber(t.total_tokensRemaining)}</td>
                <td></td>
            </tr>\`;

            pageData.forEach(row => {
                if(row.error) {
                    html += \`<tr><td class="mono">\${row.id}</td><td colspan="6" style="color: var(--danger)">\${row.error}</td><td><button class="btn btn-secondary btn-icon" onclick="deleteKey('\${row.id}')">🗑</button></td></tr>\`;
                } else {
                    html += \`<tr>
                        <td class="mono" style="color: var(--text-secondary)">\${row.id}</td>
                        <td class="mono">\${row.key}</td>
                        <td class="mono" style="font-size: 12px">\${row.startDate}</td>
                        <td class="mono" style="font-size: 12px">\${row.endDate}</td>
                        <td class="mono" style="text-align: right">\${formatNumber(row.totalAllowance)}</td>
                        <td class="mono" style="text-align: right">\${formatNumber(row.orgTotalTokensUsed)}</td>
                        <td class="mono" style="text-align: right; color: var(--success)">\${formatNumber(row.totalAllowance - row.orgTotalTokensUsed)}</td>
                        <td style="text-align: right">
                            <button class="btn btn-secondary btn-icon" style="width: 28px; height: 28px;" onclick="copyKey('\${row.key}')">📋</button>
                            <button class="btn btn-secondary btn-icon" style="width: 28px; height: 28px; color: var(--danger)" onclick="deleteKey('\${row.id}')">✕</button>
                        </td>
                    </tr>\`;
                }
            });
            html += '</tbody></table>';
            
            // Pagination
            if(itemsPerPage !== 'all' && Math.ceil(total / itemsPerPage) > 1) {
                 html += \`<div style="padding: 20px; display: flex; justify-content: center; gap: 10px;">
                    <button class="btn btn-secondary" onclick="changePage(-1)" \${currentPage === 1 ? 'disabled' : ''}>Prev</button>
                    <span style="display: flex; align-items: center; color: var(--text-secondary);">Page \${currentPage}</span>
                    <button class="btn btn-secondary" onclick="changePage(1)" \${currentPage * itemsPerPage >= total ? 'disabled' : ''}>Next</button>
                 </div>\`;
            }

            document.getElementById('tableContent').innerHTML = html;
        }

        function changePageSize(val) {
            itemsPerPage = val === 'all' ? 'all' : parseInt(val);
            localStorage.setItem(PAGE_SIZE_KEY, itemsPerPage);
            currentPage = 1;
            renderTable();
        }
        function changePage(delta) { currentPage += delta; renderTable(); }
        
        async function copyKey(txt) {
            await navigator.clipboard.writeText(txt);
            showToast('Copied to clipboard');
        }

        async function deleteKey(id) {
            if(!confirm('Delete this key?')) return;
            await fetch('/api/keys/' + id, { method: 'DELETE' });
            loadData();
        }

        async function clearZeroBalanceKeys() {
            if(!confirm('Clear all keys with <= 0 balance?')) return;
            // Logic to find zero balance keys needs data
            if(!allData) return;
            const toDelete = allData.data.filter(d => !d.error && (d.totalAllowance - d.orgTotalTokensUsed) <= 0);
            for(const k of toDelete) {
                await fetch('/api/keys/' + k.id, { method: 'DELETE' });
            }
            loadData();
            showToast(\`Cleared \${toDelete.length} keys\`);
        }

        function toggleManagePanel() {
            const el = document.getElementById('managePanel');
            el.classList.toggle('show');
        }

        async function importKeys() {
            const val = document.getElementById('importKeys').value;
            const keys = val.split('\n').map(k => k.trim()).filter(k => k);
            if(!keys.length) return;
            
            const res = await fetch('/api/keys/import', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ keys })
            });
            const d = await res.json();
            showToast(\`Imported: \${d.success}\`);
            document.getElementById('importKeys').value = '';
            toggleManagePanel();
            loadData();
        }

        loadData();
    </script>
</body>
</html>
`;

// Continue with API functions...
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

    const formatDate = (timestamp: number) => {
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

async function getAggregatedData() {
  const keyEntries = await getAllApiKeys();

  if (keyEntries.length === 0) {
    throw new Error("No API keys found in storage. Please import keys first.");
  }

  const results = await Promise.all(keyEntries.map(entry => fetchApiKeyData(entry.id, entry.key)));
  const validResults = results.filter(r => !r.error);

  const totals = validResults.reduce((acc, res) => {
    acc.total_orgTotalTokensUsed += res.orgTotalTokensUsed || 0;
    acc.total_totalAllowance += res.totalAllowance || 0;
    // 计算总 token 数量的时候，负数不计入内
    acc.total_tokensRemaining += Math.max(res.totalAllowance - res.orgTotalTokensUsed, 0);
    return acc;
  }, {
    total_orgTotalTokensUsed: 0,
    total_totalAllowance: 0,
    total_tokensRemaining: 0,
  });

  const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000);

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

// Main HTTP request handler
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

  // Login endpoint
  if (url.pathname === "/api/login" && req.method === "POST") {
    try {
      const body = await req.json();
      const { password } = body;

      if (password === ADMIN_PASSWORD) {
        const sessionId = await createSession();
        const response = new Response(JSON.stringify({ success: true }), { headers });

        setCookie(response.headers, {
          name: "session",
          value: sessionId,
          maxAge: 7 * 24 * 60 * 60, // 7 days
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        });

        return response;
      } else {
        return new Response(JSON.stringify({ error: "Invalid password" }), {
          status: 401,
          headers,
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Show login page if password is set and not authenticated
  if (ADMIN_PASSWORD && url.pathname === "/") {
    const authenticated = await isAuthenticated(req);
    if (!authenticated) {
      return new Response(LOGIN_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
  }

  // Home page
  if (url.pathname === "/") {
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  // Protected routes - require authentication
  const authenticated = await isAuthenticated(req);
  if (ADMIN_PASSWORD && !authenticated) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers,
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

  // Get all keys
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

  // Get full API key by ID
  if (url.pathname.match(`^/api/keys/[^/]+/full$`) && req.method === "GET") {
    try {
      const parts = url.pathname.split("/");
      const id = parts[3];
      if (!id) {
        return new Response(JSON.stringify({ error: "Key ID required" }), {
          status: 400,
          headers,
        });
      }

      const keyEntry = await getApiKey(id);
      if (!keyEntry) {
        return new Response(JSON.stringify({ error: "Key not found" }), {
          status: 404,
          headers,
        });
      }

      return new Response(JSON.stringify({ id: keyEntry.id, key: keyEntry.key }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers,
      });
    }
  }

  // Batch delete keys
  if (url.pathname === "/api/keys/batch-delete" && req.method === "POST") {
    try {
      const body = await req.json();
      const ids = body.ids as string[];

      if (!Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ error: "Invalid request: 'ids' must be a non-empty array" }), {
          status: 400,
          headers,
        });
      }

      const result = await batchDeleteKeys(ids);
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
      if (!id || id === "batch-delete") {
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

console.log("🚀 Server running on http://localhost:8000");
console.log(`🔐 Password Protection: ${ADMIN_PASSWORD ? 'ENABLED ✅' : 'DISABLED ⚠️'}`);
serve(handler);