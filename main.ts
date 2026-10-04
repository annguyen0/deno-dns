import dnsPacket from "npm:dns-packet@^5.6.1";
import { decodeBase64Url } from "jsr:@std/encoding/base64url";

// Khởi tạo Deno KV Database ở tầng Edge
const kv = await Deno.openKv();

// Khởi tạo cấu hình mặc định nếu Deno KV trống
async function initConfig() {
  const upstreams = await kv.get(["config", "upstreams"]);
  if (!upstreams.value) {
    await kv.set(["config", "upstreams"], [
      "https://1.1.1.1/dns-query",
      "https://dns.google/dns-query",
    ]);
  }

  const blocklists = await kv.get(["config", "blocklists"]);
  if (!blocklists.value) {
    await kv.set(["config", "blocklists"], [
      "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    ]);
  }
}
await initConfig();

// Ghi nhận log và cập nhật thống kê vào Deno KV
async function recordStat(domain: string, blocked: boolean, clientIp: string) {
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const typeKey = blocked ? "blocked" : "allowed";

  // Tang bien đếm
  await kv.atomic()
    .mutate({ type: "sum", key: ["stats", "total"], value: 1n })
    .mutate({ type: "sum", key: ["stats", typeKey], value: 1n })
    .mutate({ type: "sum", key: ["stats", dateKey, typeKey], value: 1n })
    .commit();

  // Lưu 50 nhật ký gần nhất
  const logEntry = {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString(),
    domain,
    blocked,
    clientIp,
  };
  await kv.set(["logs", Date.now()], logEntry);
}

// Đồng bộ danh sách chặn từ các nguồn URL về Deno KV
async function syncBlocklists() {
  const res = await kv.get<string[]>(["config", "blocklists"]);
  const urls = res.value || [];
  let totalDomains = 0;

  for (const url of urls) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const domain = parts[1].toLowerCase();
          if (domain !== "localhost") {
            await kv.set(["blocked_domains", domain], true);
            totalDomains++;
          }
        }
      }
    } catch (e) {
      console.error(`Lỗi khi tải blocklist từ ${url}:`, e);
    }
  }
  await kv.set(["config", "total_blocked_count"], totalDomains);
  return totalDomains;
}

// Xử lý truy vấn DoH (RFC 8484)
async function handleDNSQuery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let rawQuery: Uint8Array | null = null;

  if (req.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (dnsParam) rawQuery = decodeBase64Url(dnsParam);
  } else if (req.method === "POST" && req.headers.get("content-type") === "application/dns-message") {
    rawQuery = new Uint8Array(await req.arrayBuffer());
  }

  if (!rawQuery) {
    return new Response("Bad Request: DNS packet missing", { status: 400 });
  }

  const query = dnsPacket.decode(rawQuery);
  const question = query.questions?.[0];
  if (!question) return new Response("Invalid Question", { status: 400 });

  const domain = question.name.toLowerCase().replace(/\.$/, "");
  const clientIp = req.headers.get("x-forwarded-for") || "Edge Network";

  // 1. Kiểm tra domain trong Blocklist
  const isBlocked = await kv.get(["blocked_domains", domain]);
  if (isBlocked.value) {
    await recordStat(domain, true, clientIp);
    const blockedPacket = dnsPacket.encode({
      type: "response",
      id: query.id,
      flags: dnsPacket.AUTHORITATIVE_ANSWER,
      questions: query.questions,
      answers: [{
        type: question.type as "A" | "AAAA",
        name: question.name,
        ttl: 300,
        data: "0.0.0.0",
      }],
    });

    return new Response(blockedPacket, {
      status: 200,
      headers: { "content-type": "application/dns-message", "cache-control": "public, max-age=300" },
    });
  }

  // 2. Chuyển tiếp tới Upstream DoH
  await recordStat(domain, false, clientIp);
  const upstreams = (await kv.get<string[]>(["config", "upstreams"])).value || ["https://1.1.1.1/dns-query"];
  const selectedUpstream = upstreams[0];

  try {
    const upstreamRes = await fetch(selectedUpstream, {
      method: "POST",
      headers: { "content-type": "application/dns-message", "accept": "application/dns-message" },
      body: rawQuery,
    });

    const responseBuf = await upstreamRes.arrayBuffer();
    return new Response(responseBuf, {
      status: 200,
      headers: { "content-type": "application/dns-message", "cache-control": "public, max-age=300" },
    });
  } catch (err) {
    return new Response(`Upstream Error: ${err}`, { status: 502 });
  }
}

// ---------------------------------------------------------
// REST API & WEB DASHBOARD ROUTER
// ---------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Endpoint DNS over HTTPS (DoH)
  if (url.pathname === "/dns-query") {
    return handleDNSQuery(req);
  }

  // API Lấy Thống kê & Logs
  if (url.pathname === "/api/stats") {
    const total = (await kv.get<bigint>(["stats", "total"])).value || 0n;
    const blocked = (await kv.get<bigint>(["stats", "blocked"])).value || 0n;
    const allowed = (await kv.get<bigint>(["stats", "allowed"])).value || 0n;
    const domainCount = (await kv.get<number>(["config", "total_blocked_count"])).value || 0;

    // Lấy 20 log mới nhất
    const logs = [];
    for await (const entry of kv.list({ prefix: ["logs"] }, { limit: 20, reverse: true })) {
      logs.push(entry.value);
    }

    return Response.json({
      total: Number(total),
      blocked: Number(blocked),
      allowed: Number(allowed),
      domainCount,
      logs,
    });
  }

  // API Cấu hình (Upstreams & Blocklists)
  if (url.pathname === "/api/config") {
    if (req.method === "GET") {
      const upstreams = (await kv.get(["config", "upstreams"])).value || [];
      const blocklists = (await kv.get(["config", "blocklists"])).value || [];
      return Response.json({ upstreams, blocklists });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (body.upstreams) await kv.set(["config", "upstreams"], body.upstreams);
      if (body.blocklists) await kv.set(["config", "blocklists"], body.blocklists);
      return Response.json({ success: true });
    }
  }

  // API Đồng bộ Blocklists
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const count = await syncBlocklists();
    return Response.json({ success: true, count });
  }

  // Giao diện Web Dashboard (HTML Single Page App)
  return new Response(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Serverless DNS Dashboard - Deno Deploy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 24px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 20px 0; }
    .card { background: #1e293b; padding: 18px; border-radius: 12px; border: 1px solid #334155; }
    .card h3 { margin: 0; font-size: 13px; color: #94a3b8; text-transform: uppercase; }
    .card p { margin: 8px 0 0; font-size: 26px; font-weight: bold; }
    .blocked { color: #f43f5e; } .allowed { color: #10b981; } .total { color: #38bdf8; }
    .section { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 24px; border: 1px solid #334155; }
    .section h2 { margin-top: 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 10px; }
    input, button { background: #0f172a; border: 1px solid #475569; color: #fff; padding: 10px; border-radius: 6px; }
    button { background: #0284c7; border: none; cursor: pointer; font-weight: bold; }
    button:hover { background: #0369a1; }
    .list-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #334155; font-size: 14px; }
    .tag { padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .tag-blocked { background: #881337; color: #fecdd3; }
    .tag-allowed { background: #064e3b; color: #a7f3d0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Deno Deploy Serverless DNS Dashboard</h1>
    <p style="color: #94a3b8;">DoH Endpoint URL: <code>${url.origin}/dns-query</code></p>

    <div class="grid">
      <div class="card"><h3>Tổng Request</h3><p class="total" id="stTotal">0</p></div>
      <div class="card"><h3>Đã Chặn</h3><p class="blocked" id="stBlocked">0</p></div>
      <div class="card"><h3>Cho Phép</h3><p class="allowed" id="stAllowed">0</p></div>
      <div class="card"><h3>Domain Trong Blocklist</h3><p id="stDomains">0</p></div>
    </div>

    <div class="section">
      <h2>🌐 Cấu Hình Upstream DNS (DoH)</h2>
      <div id="upstreamList"></div>
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <input type="text" id="newUpstream" placeholder="https://1.1.1.1/dns-query" style="flex:1;">
        <button onclick="addUpstream()">Thêm Upstream</button>
      </div>
    </div>

    <div class="section">
      <h2>🛡️ Quản Lý Nguồn Blocklist (URLs)</h2>
      <div id="blocklistList"></div>
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <input type="text" id="newBlocklist" placeholder="https://domain.com/hosts.txt" style="flex:1;">
        <button onclick="addBlocklist()">Thêm Nguồn Chặn</button>
      </div>
      <button onclick="syncBlocklists()" style="margin-top:15px; background: #16a34a; width: 100%;">🔄 Đồng bộ danh sách tên miền chặn ngay</button>
    </div>

    <div class="section">
      <h2>📋 Nhật Ký Truy Vấn Real-time</h2>
      <table>
        <thead>
          <tr><th>Thời gian</th><th>Tên miền</th><th>Trạng thái</th><th>IP Client</th></tr>
        </thead>
        <tbody id="logsTable"></tbody>
      </table>
    </div>
  </div>

  <script>
    let currentConfig = { upstreams: [], blocklists: [] };

    async function loadData() {
      // Lấy stats
      const resStats = await fetch('/api/stats');
      const stats = await resStats.json();
      document.getElementById('stTotal').innerText = stats.total;
      document.getElementById('stBlocked').innerText = stats.blocked;
      document.getElementById('stAllowed').innerText = stats.allowed;
      document.getElementById('stDomains').innerText = stats.domainCount.toLocaleString();

      // Render Logs
      const tbody = document.getElementById('logsTable');
      tbody.innerHTML = stats.logs.map(l => \`
        <tr>
          <td>\${l.time}</td>
          <td><b>\${l.domain}</b></td>
          <td><span class="tag \${l.blocked ? 'tag-blocked' : 'tag-allowed'}">\${l.blocked ? 'BLOCKED' : 'ALLOWED'}</span></td>
          <td>\${l.clientIp}</td>
        </tr>
      \`).join('');

      // Lấy Config
      const resConfig = await fetch('/api/config');
      currentConfig = await resConfig.json();
      renderConfig();
    }

    function renderConfig() {
      document.getElementById('upstreamList').innerHTML = currentConfig.upstreams.map((u, i) => \`
        <div class="list-item"><span>\${u}</span><button onclick="removeUpstream(\${i})" style="background:#e11d48; padding:4px 8px;">Xóa</button></div>
      \`).join('');

      document.getElementById('blocklistList').innerHTML = currentConfig.blocklists.map((b, i) => \`
        <div class="list-item"><span>\${b}</span><button onclick="removeBlocklist(\${i})" style="background:#e11d48; padding:4px 8px;">Xóa</button></div>
      \`).join('');
    }

    async function saveConfig() {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentConfig)
      });
      renderConfig();
    }

    async function addUpstream() {
      const val = document.getElementById('newUpstream').value.trim();
      if(val) { currentConfig.upstreams.push(val); await saveConfig(); document.getElementById('newUpstream').value = ''; }
    }
    async function removeUpstream(i) { currentConfig.upstreams.splice(i, 1); await saveConfig(); }

    async function addBlocklist() {
      const val = document.getElementById('newBlocklist').value.trim();
      if(val) { currentConfig.blocklists.push(val); await saveConfig(); document.getElementById('newBlocklist').value = ''; }
    }
    async function removeBlocklist(i) { currentConfig.blocklists.splice(i, 1); await saveConfig(); }

    async function syncBlocklists() {
      alert("Đang đồng bộ danh sách tên miền chặn...");
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      alert("Đã đồng bộ thành công " + data.count + " tên miền vào Deno KV!");
      loadData();
    }

    loadData();
    setInterval(loadData, 3000);
  </script>
</body>
</html>
  `, { headers: { "content-type": "text/html; charset=utf-8" } });
});
