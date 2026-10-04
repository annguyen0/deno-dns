import dnsPacket from "dns-packet";
import { decodeBase64Url } from "@std/encoding/base64url";

// Khởi tạo Deno KV Database ở tầng Edge
const kv = await Deno.openKv();

// Cấu hình ban đầu nếu KV trống
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

// Ghi nhận thống kê
async function recordStat(domain: string, blocked: boolean, clientIp: string) {
  const typeKey = blocked ? "blocked" : "allowed";
  await kv.atomic()
    .mutate({ type: "sum", key: ["stats", "total"], value: 1n })
    .mutate({ type: "sum", key: ["stats", typeKey], value: 1n })
    .commit();

  await kv.set(["logs", Date.now()], {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString("vi-VN"),
    domain,
    blocked,
    clientIp,
  });
}

// Đồng bộ Blocklist từ các Nguồn URL về Deno KV
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
        if (parts.length >= 2 && parts[1] !== "localhost") {
          await kv.set(["blocked_domains", parts[1].toLowerCase()], true);
          totalDomains++;
        }
      }
    } catch (e) {
      console.error("Lỗi đồng bộ blocklist:", e);
    }
  }
  await kv.set(["config", "total_blocked_count"], totalDomains);
  return totalDomains;
}

// Xử lý DNS over HTTPS (DoH RFC 8484)
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
    return new Response("Bad Request: Thiếu gói tin DNS", { status: 400 });
  }

  try {
    const query = dnsPacket.decode(rawQuery);
    const question = query.questions?.[0];
    if (!question) return new Response("Invalid Question", { status: 400 });

    const domain = question.name.toLowerCase().replace(/\.$/, "");
    const clientIp = req.headers.get("x-forwarded-for") || "Edge";

    // 1. Kiểm tra Blocklist trong Deno KV
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

    const upstreamRes = await fetch(upstreams[0], {
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
    return new Response(`DNS Processing Error: ${err}`, { status: 500 });
  }
}

// HTTP Server chính xử lý cả DoH API lẫn Web Dashboard UI
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Endpoint DNS DoH
  if (url.pathname === "/dns-query") {
    return handleDNSQuery(req);
  }

  // REST API Stats
  if (url.pathname === "/api/stats") {
    const total = (await kv.get<bigint>(["stats", "total"])).value || 0n;
    const blocked = (await kv.get<bigint>(["stats", "blocked"])).value || 0n;
    const allowed = (await kv.get<bigint>(["stats", "allowed"])).value || 0n;
    const domainCount = (await kv.get<number>(["config", "total_blocked_count"])).value || 0;

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

  // REST API Config
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

  // REST API Sync Blocklist
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const count = await syncBlocklists();
    return Response.json({ success: true, count });
  }

  // Giao diện Web Dashboard Single Page
  return new Response(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Serverless DNS Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: #38bdf8; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0; }
    .card { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    .card h3 { margin: 0; font-size: 12px; color: #94a3b8; }
    .card p { margin: 6px 0 0; font-size: 22px; font-weight: bold; }
    .section { background: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #334155; }
    input, button { background: #0f172a; border: 1px solid #475569; color: #fff; padding: 8px 12px; border-radius: 6px; }
    button { background: #0284c7; cursor: pointer; border: none; font-weight: bold; }
    .list-item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Serverless DNS Dashboard</h1>
    <p>DoH URL Endpoint: <code>${url.origin}/dns-query</code></p>

    <div class="grid">
      <div class="card"><h3>TỔNG REQUEST</h3><p id="stTotal">0</p></div>
      <div class="card"><h3>ĐÃ CHẶN</h3><p style="color:#f43f5e;" id="stBlocked">0</p></div>
      <div class="card"><h3>CHO PHÉP</h3><p style="color:#10b981;" id="stAllowed">0</p></div>
      <div class="card"><h3>DOMAIN TRONG BLOCKLIST</h3><p id="stDomains">0</p></div>
    </div>

    <div class="section">
      <h3>🌐 Upstream DNS Servers</h3>
      <div id="upstreamList"></div>
      <div style="margin-top:10px; display:flex; gap:8px;">
        <input type="text" id="newUpstream" placeholder="https://1.1.1.1/dns-query" style="flex:1;">
        <button onclick="addUpstream()">Thêm Upstream</button>
      </div>
    </div>

    <div class="section">
      <h3>🛡️ Nguồn Blocklist (URLs)</h3>
      <div id="blocklistList"></div>
      <div style="margin-top:10px; display:flex; gap:8px;">
        <input type="text" id="newBlocklist" placeholder="https://domain.com/hosts.txt" style="flex:1;">
        <button onclick="addBlocklist()">Thêm Nguồn Chặn</button>
      </div>
      <button onclick="syncBlocklists()" style="margin-top:12px; background:#16a34a; width:100%;">🔄 Đồng bộ danh sách chặn vào Deno KV</button>
    </div>

    <div class="section">
      <h3>📋 Nhật Ký Truy Vấn Mới Nhất</h3>
      <table>
        <thead><tr><th>Thời gian</th><th>Domain</th><th>Trạng thái</th><th>IP Client</th></tr></thead>
        <tbody id="logsTable"></tbody>
      </table>
    </div>
  </div>

  <script>
    let currentConfig = { upstreams: [], blocklists: [] };

    async function loadData() {
      const resStats = await fetch('/api/stats');
      const stats = await resStats.json();
      document.getElementById('stTotal').innerText = stats.total;
      document.getElementById('stBlocked').innerText = stats.blocked;
      document.getElementById('stAllowed').innerText = stats.allowed;
      document.getElementById('stDomains').innerText = stats.domainCount.toLocaleString();

      const tbody = document.getElementById('logsTable');
      tbody.innerHTML = stats.logs.map(l => \`
        <tr>
          <td>\${l.time}</td>
          <td><b>\${l.domain}</b></td>
          <td><span style="color:\${l.blocked ? '#f43f5e' : '#10b981'}">\${l.blocked ? 'BLOCKED' : 'ALLOWED'}</span></td>
          <td>\${l.clientIp}</td>
        </tr>
      \`).join('');

      const resConfig = await fetch('/api/config');
      currentConfig = await resConfig.json();
      renderConfig();
    }

    function renderConfig() {
      document.getElementById('upstreamList').innerHTML = currentConfig.upstreams.map((u, i) => \`
        <div class="list-item"><span>\${u}</span><button onclick="removeUpstream(\${i})" style="background:#e11d48">Xóa</button></div>
      \`).join('');

      document.getElementById('blocklistList').innerHTML = currentConfig.blocklists.map((b, i) => \`
        <div class="list-item"><span>\${b}</span><button onclick="removeBlocklist(\${i})" style="background:#e11d48">Xóa</button></div>
      \`).join('');
    }

    async function saveConfig() {
      await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentConfig) });
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
      alert("Đang tải dữ liệu từ các nguồn...");
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      alert("Đã đồng bộ thành công " + data.count + " domain vào Deno KV!");
      loadData();
    }

    loadData();
    setInterval(loadData, 3000);
  </script>
</body>
</html>
  `, { headers: { "content-type": "text/html; charset=utf-8" } });
});