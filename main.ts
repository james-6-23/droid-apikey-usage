// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// HTML content is embedded as a template string
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 32px; margin-bottom: 10px; }
        .header .update-time { font-size: 14px; opacity: 0.9; }
        .stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
        .stat-card .label { font-size: 13px; color: #6c757d; margin-bottom: 8px; font-weight: 500; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #667eea; }
        .table-container { padding: 0 30px 30px 30px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th { padding: 15px; text-align: left; font-weight: 600; font-size: 14px; white-space: nowrap; }
        th.number { text-align: right; }
        td { padding: 12px 15px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        td.number { text-align: right; font-family: 'Courier New', monospace; font-weight: 500; }
        td.error-row { color: #dc3545; }
        tbody tr:hover { background-color: #f8f9fa; }
        tbody tr:last-child td { border-bottom: none; }
        tfoot { background: #f8f9fa; font-weight: bold; }
        tfoot td { padding: 15px; border-top: 2px solid #667eea; border-bottom: none; }
        .key-cell { font-family: 'Courier New', monospace; font-size: 12px; color: #495057; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .refresh-btn { position: fixed; bottom: 30px; right: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .refresh-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
        .refresh-btn:active { transform: translateY(0); }
        .loading { text-align: center; padding: 40px; color: #6c757d; }
        .error { text-align: center; padding: 40px; color: #dc3545; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 API 余额监控看板</h1>
            <div class="update-time" id="updateTime">正在加载...</div>
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

// 👇 Paste your new, unpublished API Key list here.
//   Please paste each API Key between the backticks (```), one key per line.
//   No need to add commas or double quotes manually.
//
// Example:
// const rawKeysMultiLine = `
// your_actual_key_string_1
// your_actual_key_string_2
// your_actual_key_string_3
// `;
const rawKeysMultiLine = `
fk-tIN5jj1zEcHgbiT7pF6h-Va-GY55rjI_fNbyfMBt6wmCXxawFkHhL4EHbPp4RfQo
`;

// Parse multi-line string into an array
const rawKeys = rawKeysMultiLine.split('\n')
                             .map(key => key.trim())
                             .filter(key => key.length > 0);

const formattedKeyPairs = rawKeys.map((key, index) => {
  const id = `key-${index + 1}`; // Auto-generate ID, e.g., key-1, key-2...
  return `${id}:${key}`;
});

const finalOutput = formattedKeyPairs.join(',');

/**
 * Aggregates data from all configured API keys.
 */
async function getAggregatedData() {
  let apiKeysSource = finalOutput;
  if (!apiKeysSource) {
      apiKeysSource = Deno.env.get("API_KEYS");
  }

  if (!apiKeysSource) {
    throw new Error("API_KEYS (from `rawKeysMultiLine` or environment variable) not set. Please provide keys in the format 'ID1:KEY1,ID2:KEY2'.");
  }

  const keyPairs = apiKeysSource.split(',').map(kv => {
    const parts = kv.split(':');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      console.error(`Invalid API_KEY entry: ${kv}. Each entry must be in the format 'ID:KEY'.`);
      return null;
    }
    return { id: parts[0].trim(), key: parts[1].trim() };
  }).filter(Boolean) as { id: string; key: string }[];

  if (keyPairs.length === 0) {
      throw new Error("No valid API keys found after parsing.");
  }
  
  const results = await Promise.all(keyPairs.map(({ id, key }) => fetchApiKeyData(id, key)));

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
      const originalKeyPair = keyPairs.find(kp => kp.id === item.id);
      if (originalKeyPair) {
        console.log(originalKeyPair.key);
      }
    });
    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }

  return {
    update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: keyPairs.length,
    totals,
    data: results,
  };
}

/**
 * Main HTTP request handler.
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  if (url.pathname === "/api/data") {
    try {
      const data = await getAggregatedData();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

console.log("Server running on http://localhost:8000");
serve(handler);
