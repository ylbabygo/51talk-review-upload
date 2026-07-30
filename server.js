const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DEPLOY_RUN_PORT || process.env.PORT || '5000', 10);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'submissions.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '51talk2024';

// 确保数据目录存在
const dataDir = path.join(ROOT, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 初始化数据文件
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ submissions: [] }, null, 2));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

// 读取数据
function readData() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return { submissions: [] };
  }
}

// 写入数据
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 解析请求体
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 发送JSON响应
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

// 发送HTML响应
function sendHTML(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// 管理后台HTML
const adminHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>51Talk - 数据管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; }
    .header { background: #4F46E5; color: white; padding: 20px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 20px; }
    .header button { background: white; color: #4F46E5; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .stat-card h3 { font-size: 14px; color: #6B7280; margin-bottom: 8px; }
    .stat-card .value { font-size: 28px; font-weight: 700; color: #1F2937; }
    .table-container { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }
    .table-header { padding: 16px 20px; border-bottom: 1px solid #E5E7EB; display: flex; justify-content: space-between; align-items: center; }
    .table-header h2 { font-size: 16px; color: #1F2937; }
    .search-box { padding: 8px 12px; border: 1px solid #E5E7EB; border-radius: 6px; font-size: 14px; width: 200px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 20px; text-align: left; border-bottom: 1px solid #F3F4F6; }
    th { background: #F9FAFB; font-size: 13px; font-weight: 600; color: #6B7280; }
    td { font-size: 14px; color: #1F2937; }
    tr:hover { background: #F9FAFB; }
    .status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.pending { background: #FEF3C7; color: #92400E; }
    .status.approved { background: #D1FAE5; color: #065F46; }
    .status.rejected { background: #FEE2E2; color: #991B1B; }
    .image-preview { width: 60px; height: 60px; object-fit: cover; border-radius: 6px; cursor: pointer; }
    .login-container { max-width: 400px; margin: 100px auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .login-container h2 { margin-bottom: 24px; text-align: center; color: #1F2937; }
    .login-container input { width: 100%; padding: 12px; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .login-container button { width: 100%; padding: 12px; background: #4F46E5; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
    .empty { text-align: center; padding: 40px; color: #6B7280; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center; }
    .modal.active { display: flex; }
    .modal img { max-width: 90%; max-height: 90%; border-radius: 8px; }
    .modal-close { position: absolute; top: 20px; right: 20px; color: white; font-size: 32px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="loginPage" class="login-container">
    <h2>51Talk 数据管理后台</h2>
    <input type="password" id="password" placeholder="请输入密码" />
    <button onclick="login()">登录</button>
  </div>
  
  <div id="adminPage" style="display: none;">
    <div class="header">
      <h1>51Talk 好评截图提交数据</h1>
      <button onclick="logout()">退出登录</button>
    </div>
    
    <div class="container">
      <div class="stats">
        <div class="stat-card">
          <h3>总提交数</h3>
          <div class="value" id="totalCount">0</div>
        </div>
        <div class="stat-card">
          <h3>今日提交</h3>
          <div class="value" id="todayCount">0</div>
        </div>
        <div class="stat-card">
          <h3>待审核</h3>
          <div class="value" id="pendingCount">0</div>
        </div>
      </div>
      
      <div class="table-container">
        <div class="table-header">
          <h2>提交记录</h2>
          <input type="text" class="search-box" placeholder="搜索手机号或订单ID" oninput="searchData(this.value)" />
        </div>
        <table>
          <thead>
            <tr>
              <th>提交时间</th>
              <th>手机号</th>
              <th>订单ID</th>
              <th>截图</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
  
  <div class="modal" id="imageModal" onclick="closeModal()">
    <span class="modal-close">&times;</span>
    <img id="modalImage" src="" alt="截图预览" />
  </div>
  
  <script>
    let allData = [];
    
    function login() {
      const password = document.getElementById('password').value;
      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          sessionStorage.setItem('adminAuth', 'true');
          showAdminPage();
        } else {
          alert('密码错误');
        }
      });
    }
    
    function logout() {
      sessionStorage.removeItem('adminAuth');
      document.getElementById('loginPage').style.display = 'block';
      document.getElementById('adminPage').style.display = 'none';
    }
    
    function showAdminPage() {
      document.getElementById('loginPage').style.display = 'none';
      document.getElementById('adminPage').style.display = 'block';
      loadData();
    }
    
    function loadData() {
      fetch('/api/admin/data', {
        headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('adminAuth') }
      })
      .then(res => res.json())
      .then(data => {
        allData = data.submissions || [];
        renderTable(allData);
        updateStats(allData);
      });
    }
    
    function updateStats(data) {
      document.getElementById('totalCount').textContent = data.length;
      const today = new Date().toDateString();
      const todayCount = data.filter(item => new Date(item.submittedAt).toDateString() === today).length;
      document.getElementById('todayCount').textContent = todayCount;
      document.getElementById('pendingCount').textContent = data.filter(item => item.status === 'pending').length;
    }
    
    function renderTable(data) {
      const tbody = document.getElementById('tableBody');
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(item => \`
        <tr>
          <td>\${new Date(item.submittedAt).toLocaleString('zh-CN')}</td>
          <td>\${item.phone}</td>
          <td>\${item.orderId}</td>
          <td>\${item.imageUrl ? \`<img class="image-preview" src="\${item.imageUrl}" onclick="showImage('\${item.imageUrl}')" />\` : '无'}</td>
          <td><span class="status \${item.status}">\${item.status === 'pending' ? '待审核' : item.status === 'approved' ? '已通过' : '已拒绝'}</span></td>
        </tr>
      \`).join('');
    }
    
    function searchData(keyword) {
      if (!keyword) {
        renderTable(allData);
        return;
      }
      const filtered = allData.filter(item => 
        item.phone.includes(keyword) || item.orderId.includes(keyword)
      );
      renderTable(filtered);
    }
    
    function showImage(url) {
      document.getElementById('modalImage').src = url;
      document.getElementById('imageModal').classList.add('active');
    }
    
    function closeModal() {
      document.getElementById('imageModal').classList.remove('active');
    }
    
    // 自动登录检查
    if (sessionStorage.getItem('adminAuth')) {
      showAdminPage();
    }
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  console.log('Request:', req.method, urlPath);
  
  // API路由
  if (urlPath.startsWith('/api/')) {
    console.log('API route matched:', urlPath);
    // 提交数据
    if (urlPath === '/api/submit' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        console.log('[api] submit body:', JSON.stringify(body));
        const { phone, orderId, imageData } = body;
        
        // 验证
        if (!phone || !orderId) {
          console.log('[api] submit validation failed: missing phone or orderId');
          return sendJSON(res, 400, { success: false, message: '请填写完整信息' });
        }
        
        if (phone.length !== 11 || !phone.startsWith('1')) {
          console.log('[api] submit validation failed: invalid phone', phone);
          return sendJSON(res, 400, { success: false, message: '手机号格式错误' });
        }
        
        if (orderId.length !== 19 || !orderId.startsWith('69')) {
          console.log('[api] submit validation failed: invalid orderId', orderId);
          return sendJSON(res, 400, { success: false, message: '订单ID格式错误' });
        }
        
        const data = readData();
        
        // 检查重复
        const duplicate = data.submissions.find(item => 
          item.phone === phone || item.orderId === orderId
        );
        
        if (duplicate) {
          console.log('[api] submit duplicate:', duplicate.phone === phone ? 'phone' : 'orderId');
          return sendJSON(res, 400, { 
            success: false, 
            message: duplicate.phone === phone ? '该手机号已提交过' : '该订单ID已提交过' 
          });
        }
        
        // 保存数据
        const submission = {
          id: Date.now().toString(),
          phone,
          orderId,
          imageData: imageData || null,
          imageUrl: imageData ? `/data/images/${Date.now()}.jpg` : null,
          status: 'pending',
          submittedAt: new Date().toISOString(),
        };
        
        // 保存图片
        if (imageData && typeof imageData === 'string') {
          const imageDir = path.join(ROOT, 'data', 'images');
          if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, { recursive: true });
          }
          try {
            const base64Data = imageData.includes(',') ? imageData.split(',')[1] : imageData;
            if (base64Data && typeof base64Data === 'string' && base64Data.length > 0) {
              const imageBuffer = Buffer.from(String(base64Data), 'base64');
              const imagePath = submission.imageUrl.replace('/data/images', path.join(ROOT, 'data', 'images'));
              fs.writeFileSync(imagePath, imageBuffer);
            }
          } catch (imgErr) {
            console.error('[api] image save error:', imgErr);
          }
        }
        
        data.submissions.unshift(submission);
        writeData(data);
        
        sendJSON(res, 200, { success: true, message: '提交成功' });
      } catch (err) {
        console.error('[api] submit error:', err);
        console.error('[api] submit error stack:', err.stack);
        console.error('[api] submit error body:', JSON.stringify(body || {}));
        sendJSON(res, 500, { success: false, message: '提交失败：' + err.message });
      }
      return;
    }
    
    // 管理员登录
    if (urlPath === '/api/admin/login' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (body.password === ADMIN_PASSWORD) {
          sendJSON(res, 200, { success: true });
        } else {
          sendJSON(res, 401, { success: false, message: '密码错误' });
        }
      } catch (err) {
        sendJSON(res, 500, { success: false, message: '登录失败' });
      }
      return;
    }
    
    // 获取数据
    if (urlPath === '/api/admin/data' && req.method === 'GET') {
      const data = readData();
      sendJSON(res, 200, data);
      return;
    }
    
    // 管理后台API - 获取提交数据（支持搜索）
    if (urlPath === '/api/submissions' && req.method === 'GET') {
      try {
        const data = readData();
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const search = urlObj.searchParams.get('search') || '';
        
        let submissions = data.submissions;
        
        // 搜索过滤
        if (search) {
          const searchLower = search.toLowerCase();
          submissions = submissions.filter(item => 
            (item.phone && item.phone.includes(search)) ||
            (item.orderId && item.orderId.includes(search)) ||
            (item.comment && item.comment.toLowerCase().includes(searchLower))
          );
        }
        
        sendJSON(res, 200, { 
          success: true, 
          data: submissions, 
          total: submissions.length 
        });
      } catch (err) {
        console.error('获取数据失败:', err);
        sendJSON(res, 500, { success: false, message: '获取数据失败' });
      }
      return;
    }
    
    // 管理后台API - 获取提交数据
    if (urlPath === '/api/admin/submissions' && req.method === 'GET') {
      try {
        const data = readData();
        sendJSON(res, 200, { success: true, data: data.submissions, total: data.submissions.length });
      } catch (err) {
        console.error('获取数据失败:', err);
        sendJSON(res, 500, { success: false, message: '获取数据失败' });
      }
      return;
    }
    
    // 管理后台API - 删除提交数据
    if (urlPath === '/api/admin/delete' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { id } = body;
        
        if (!id) {
          return sendJSON(res, 400, { success: false, message: '缺少ID参数' });
        }
        
        const data = readData();
        const originalLength = data.submissions.length;
        data.submissions = data.submissions.filter(item => item.id !== id);
        
        if (data.submissions.length === originalLength) {
          return sendJSON(res, 404, { success: false, message: '数据不存在' });
        }
        
        writeData(data);
        console.log('[api] delete success:', id);
        sendJSON(res, 200, { success: true, message: '删除成功' });
      } catch (err) {
        console.error('[api] delete error:', err);
        sendJSON(res, 500, { success: false, message: '删除失败' });
      }
      return;
    }
    
    sendJSON(res, 404, { success: false, message: 'API not found' });
    return;
  }
  
  // 管理后台页面
  if (urlPath === '/admin') {
    sendHTML(res, 200, adminHTML);
    return;
  }
  
  // 静态文件
  if (urlPath === '/') urlPath = '/index.html';
  
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);
  
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!ext) {
        fs.readFile(path.join(ROOT, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(data2);
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] root: ${ROOT}`);
  console.log(`[server] admin page: http://localhost:${PORT}/admin`);
});

server.on('error', (err) => {
  console.error(`[server] error: ${err.message}`);
});

process.stdin.resume();
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, keeping alive...');
});
process.on('SIGINT', () => {
  console.log('[server] SIGINT received, keeping alive...');
});
process.on('uncaughtException', (err) => {
  console.error(`[server] uncaughtException: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[server] unhandledRejection: ${reason}`);
});
