require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────
const CREATOK_API_KEY = process.env.CREATOK_API_KEY || '';
const CREATOK_BASE = 'https://www.creatok.ai';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_APP_TOKEN = process.env.FEISHU_BITABLE_APP_TOKEN || '';
const FEISHU_TABLE_ID = process.env.FEISHU_BITABLE_TABLE_ID || '';
const PORT = process.env.PORT || 3456;

// ── In-memory job store ─────────────────────────────────
const jobs = new Map();

// ── Default scene prompts ───────────────────────────────
const SCENE_BACKGROUNDS = {
  '窗边晨光': '美式现代起居室，清晨柔和暖光从百叶窗缝隙洒入，画面右侧隐约可见浅色亚麻沙发局部，左侧角落放置一只琥珀色玻璃花瓶+干枝，中远景为浅灰墙面+原木色边柜，地面铺米色编织地毯，整体色调偏暖奶油色，景深自然而浅，焦点始终在手和产品上。',
  '大理石台面': '美式开放式厨房中岛，白色大理石台面纹理细腻，产品与手部位于台面前方，背景远处可见浅木色橱柜面板+复古黄铜拉手，台面角落摆放一支细颈陶瓶+单枝尤加利叶柔化画面，右侧窗光漫入，整体干净温暖但非商业棚感。',
  '壁炉角落': '美式客厅壁炉旁的胡桃木边桌上，背景隐约可见奶油色护墙板线条+壁炉石材纹理，桌面散落极简的金属烛台+一本翻开的亚麻色书籍，光线来自侧方窗户，暖调柔光，氛围感强但不抢眼。'
};

// ASCII-safe short names for filenames (avoids encoding issues with CJK chars)
const SCENE_SAFE_NAMES = {
  '窗边晨光': 'window-light',
  '大理石台面': 'marble-counter',
  '壁炉角落': 'fireplace-nook'
};

const PROMPT_TEMPLATE = `竖屏 9:16，电商产品摄影，超近距离特写，iPhone 风格生活照。画面主体为一双优雅美式现代女性手部自然握持一盏插电式小夜灯，无任何人脸、身体或其他人物部位。

产品还原（严格锁定参考图）：
小夜灯与参考图完全一致——造型、结构、材质、颜色、比例、尺寸、表面纹理、透明度、气泡分布、金属件色泽、自带黑色美规电源插头，所有产品细节 100% 保留，不做任何修改、替换或美化。产品处于完全未点亮状态，不发光，仅依靠材质自身反射环境光。

手部与动作（可变化）：
手部换一个自然放松的握持姿态（如单手托底、指尖轻握侧面、双手捧握等），动作轻柔优雅，手指线条舒展自然；佩戴极简轻奢金属戒指 / 细手链，欧美款美甲（裸色 / 奶白 / 法式）。

背景（必须与参考图不同）：
{sceneBg}

画质：超写实，细节锐利清晰，真实材质还原（亚克力通透折射、金属拉丝哑光纹理、皮肤质感），无透视畸变，无过度锐化 / HDR 感，色彩真实自然，手机直出感。`;

const NEGATIVE_PROMPT = `人脸、身体、其他人物、透视畸变、产品变形 / 结构修改 / 颜色变化 / 材质改变、气泡流动 / 漂浮、小夜灯点亮发光 / LED 亮起、额外电线 / USB 线 / 充电器 / 充电座 / 底座、产品自带插头被修改或移除、金属环变亮面抛光、亚克力变磨砂 / 雾面、过度装饰、硬光 / 影棚光 / 闪光灯、纯白背景 / 灰色背景、CG 感 / 3D 渲染 / 卡通、模糊 / 低分辨率、产品比例失调、手部畸形 / 手指异常、光影杂乱、抢镜背景元素、文字 / 水印 / logo、电线 / 电源线 / 任何线缆`;

// ── Helpers ─────────────────────────────────────────────
function creatokHeaders() {
  return {
    'Authorization': `Bearer ${CREATOK_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ── CreatOK API ─────────────────────────────────────────
async function uploadReferenceImage(filePath) {
  const fileName = path.basename(filePath);
  const fileBytes = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const fileType = mimeMap[ext];
  if (!fileType) throw new Error(`Unsupported image type: ${ext}`);

  // 1. Get presigned URL
  const initResp = await fetch(`${CREATOK_BASE}/api/open/skills/upload/image/presigned`, {
    method: 'POST',
    headers: creatokHeaders(),
    body: JSON.stringify({ fileName, fileType, fileSize: fileBytes.byteLength, prefix: 'open-skills/reference-images' })
  });
  const initJson = await initResp.json();
  if (initJson.code !== 0) throw new Error(`CreatOK upload init failed: ${JSON.stringify(initJson)}`);

  // 2. PUT to presigned URL
  const putResp = await fetch(initJson.data.presignedUploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': fileType },
    body: fileBytes
  });
  if (!putResp.ok) throw new Error(`Reference image upload failed: HTTP ${putResp.status}`);

  return initJson.data.objectKey;
}

async function submitImageTask(prompt, referenceKey, aspectRatio = '9:16') {
  const body = {
    prompt,
    model: 'gpt-image-2-official',
    resolution: '2K',
    n: 1,
    aspect_ratio: aspectRatio
  };
  if (referenceKey) body.imageObjectKeys = [referenceKey];

  const resp = await fetch(`${CREATOK_BASE}/api/open/skills/image-generation`, {
    method: 'POST',
    headers: creatokHeaders(),
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error(`CreatOK task submission failed: ${JSON.stringify(json)}`);
  return json.data.task_id;
}

async function pollCreatokTask(taskId, timeoutSec = 600) {
  const startedAt = Date.now();
  while (true) {
    if ((Date.now() - startedAt) / 1000 > timeoutSec) {
      throw new Error(`Timeout waiting for task ${taskId}`);
    }
    const resp = await fetch(
      `${CREATOK_BASE}/api/open/skills/tasks/status?task_id=${encodeURIComponent(taskId)}&task_type=image_generation`,
      { headers: creatokHeaders() }
    );
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`Status check failed: ${JSON.stringify(json)}`);

    const status = json.data.status;
    if (status === 'succeeded') return json.data.result.images[0].url;
    if (status === 'failed') throw new Error(`Task ${taskId} failed: ${JSON.stringify(json.data.error)}`);

    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Feishu API ──────────────────────────────────────────
async function getFeishuToken() {
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error(`Feishu token error: ${json.code} ${json.msg}`);
  return json.tenant_access_token;
}

async function uploadToFeishuBitable(imagePath, sku, token) {
  const fileName = path.basename(imagePath);
  const fileBytes = await fs.promises.readFile(imagePath);

  // Upload media via multipart
  const formData = new FormData();
  formData.append('file_name', fileName);
  formData.append('parent_type', 'bitable_image');
  formData.append('parent_node', FEISHU_APP_TOKEN);
  formData.append('size', String(fileBytes.length));
  formData.append('file', new Blob([fileBytes], { type: 'image/png' }), fileName);

  const uploadResp = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });
  const uploadJson = await uploadResp.json();
  if (uploadJson.code !== 0) throw new Error(`Feishu upload error: ${uploadJson.code} ${uploadJson.msg}`);
  const fileToken = uploadJson.data.file_token;

  // Create record with Chinese field names via char codes
  const fields = {
    'SKU': sku,
    '图片': [{ file_token: fileToken, name: fileName }],
    '状态': '未完成'  // 未完成
  };
  const createResp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ fields })
    }
  );
  const createJson = await createResp.json();
  if (createJson.code !== 0) throw new Error(`Feishu record error: ${createJson.code} ${createJson.msg}`);
  return { recordId: createJson.data.record.record_id, fileToken };
}

// ── Single image pipeline ───────────────────────────────
async function processOneImage(job, taskEntry, outputDir) {
  try {
    taskEntry.status = 'submitted';
    taskEntry.creatokTaskId = await submitImageTask(taskEntry.prompt, job.refKey);

    taskEntry.status = 'running';
    const imageUrl = await pollCreatokTask(taskEntry.creatokTaskId);
    taskEntry.imageUrl = imageUrl;

    taskEntry.status = 'downloading';
    const ext = path.extname(job.referenceImage) || '.png';
    const safeScene = SCENE_SAFE_NAMES[taskEntry.sceneName] || 'scene';
    const idx = taskEntry.id.split('-').pop();
    const outName = `tkbgc-${safeScene}-${idx}-${timestamp()}${ext}`;
    const outPath = path.join(outputDir, outName);
    const imgResp = await fetch(imageUrl);
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    await fs.promises.writeFile(outPath, imgBuf);
    taskEntry.localPath = outPath;

    taskEntry.status = 'uploading_feishu';
    const token = await getFeishuToken();
    const sku = `tkbgc-${taskEntry.sceneName}-${taskEntry.id}`;
    const feishuResult = await uploadToFeishuBitable(outPath, sku, token);
    taskEntry.feishuRecordId = feishuResult.recordId;
    taskEntry.feishuFileToken = feishuResult.fileToken;

    taskEntry.status = 'done';
    job.completedCount++;
    return true;
  } catch (err) {
    taskEntry.status = 'failed';
    taskEntry.error = err.message;
    job.failedCount++;
    return false;
  }
}

// ── Express app ─────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file upload
const uploadDir = path.join(__dirname, 'uploads');
const outputDefault = path.join(__dirname, 'outputs');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDefault, { recursive: true });
const multer = require('multer');
const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

// Helper: run PowerShell script via Base64-encoded command (avoids escaping issues)
// Only works on Windows; returns null on other platforms
function runPowerShellDialog(script) {
  if (process.platform !== 'win32') return null;
  const utf16le = Buffer.from(script, 'utf16le');
  const base64 = utf16le.toString('base64');
  return require('child_process').execSync(
    `powershell -STA -NoProfile -EncodedCommand ${base64}`,
    { encoding: 'utf8', timeout: 60000, windowsHide: true }
  ).trim();
}

// POST /api/upload-ref — accept file upload, save with original name, return full path
app.post('/api/upload-ref', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const origName = req.file.originalname || 'ref.png';
    const destPath = path.join(uploadDir, origName);
    fs.renameSync(req.file.path, destPath);
    res.json({ path: destPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pick-file — native file open dialog via PowerShell (Base64-encoded, no escaping issues)
app.post('/api/pick-file', (req, res) => {
  if (process.platform !== 'win32') return res.status(400).json({ error: 'Native file dialog only works on Windows. Use the "上传" button instead.' });
  try {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Filter = 'Images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All Files (*.*)|*.*'",
      "$d.Title = '选择参考图'",
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName } else { Write-Output '' }"
    ].join('\n');
    const result = runPowerShellDialog(script);
    if (!result) return res.json({ cancelled: true });
    res.json({ path: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pick-folder — native folder browser dialog via PowerShell (Base64-encoded)
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') return res.status(400).json({ error: 'Native folder dialog only works on Windows. Please type the path manually.' });
  try {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择图片输出目录'",
      "$d.RootFolder = 'MyComputer'",
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { Write-Output '' }"
    ].join('\n');
    const result = runPowerShellDialog(script);
    if (!result) return res.json({ cancelled: true });
    res.json({ path: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/preview-ref?path=... — proxy local reference image for browser preview
app.get('/api/preview-ref', async (req, res) => {
  try {
    const imagePath = req.query.path;
    if (!imagePath) return res.status(400).json({ error: 'path required' });
    const resolved = path.resolve(imagePath);
    // Security: only allow paths under user's home and Pictures
    const home = require('os').homedir();
    if (!resolved.startsWith(home)) return res.status(403).json({ error: 'path outside home' });
    const buf = await fs.promises.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.set('Content-Type', mimeMap[ext] || 'image/png');
    res.set('Cache-Control', 'max-age=30');
    res.send(buf);
  } catch (err) {
    res.status(404).json({ error: 'Image not found: ' + err.message });
  }
});

// GET /api/serve-local?path=... — serve any local image for clickable links
app.get('/api/serve-local', async (req, res) => {
  try {
    const imagePath = req.query.path;
    if (!imagePath) return res.status(400).json({ error: 'path required' });
    const resolved = path.resolve(imagePath);
    const home = require('os').homedir();
    if (!resolved.startsWith(home)) return res.status(403).json({ error: 'path outside home' });
    const buf = await fs.promises.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.set('Content-Type', mimeMap[ext] || 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(resolved))}"`);
    res.send(buf);
  } catch (err) {
    res.status(404).json({ error: 'File not found: ' + err.message });
  }
});

// POST /api/generate - Start generation jobs
app.post('/api/generate', async (req, res) => {
  try {
    const { scenes, referenceImage, outputDir: userOutputDir } = req.body;
    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: 'scenes array is required' });
    }

    const outputDir = userOutputDir || path.join(__dirname, 'outputs');
    const jobId = `job-${Date.now()}`;
    const tasks = [];

    for (const scene of scenes) {
      const count = Math.max(1, Math.min(10, parseInt(scene.count) || 1));
      for (let i = 0; i < count; i++) {
        tasks.push({
          id: `${scene.name}-${i + 1}`,
          sceneName: scene.name,
          prompt: scene.prompt || '',
          promptIndex: i,
          status: 'pending',
          creatokTaskId: null,
          imageUrl: null,
          localPath: null,
          feishuRecordId: null,
          feishuFileToken: null,
          error: null
        });
      }
    }

    const job = {
      id: jobId,
      status: 'running',
      referenceImage: referenceImage || '',
      outputDir,
      totalCount: tasks.length,
      completedCount: 0,
      failedCount: 0,
      tasks,
      createdAt: new Date().toISOString()
    };
    jobs.set(jobId, job);

    // Process all tasks in parallel (fire and forget)
    res.json({ jobId, totalTasks: tasks.length, tasks: tasks.map(t => ({ id: t.id, sceneName: t.sceneName })) });

    // Upload reference image once, then launch all tasks concurrently
    (async () => {
      try {
        const refKey = await uploadReferenceImage(job.referenceImage);
        job.refKey = refKey;
        const promises = tasks.map(task => processOneImage(job, task, outputDir));
        await Promise.allSettled(promises);
      } catch (err) {
        // If ref upload fails, mark all tasks as failed
        tasks.forEach(t => { t.status = 'failed'; t.error = 'Reference upload: ' + err.message; });
        job.failedCount = tasks.length;
      }
      job.status = job.failedCount === job.totalCount ? 'failed' :
                   job.completedCount === job.totalCount ? 'done' : 'partial';
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:jobId - Get job status
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id,
    status: job.status,
    totalCount: job.totalCount,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
    createdAt: job.createdAt,
    tasks: job.tasks.map(t => ({
      id: t.id,
      sceneName: t.sceneName,
      status: t.status,
      imageUrl: t.imageUrl,
      localPath: t.localPath,
      feishuRecordId: t.feishuRecordId,
      error: t.error
    }))
  });
});

// GET /api/jobs - List all jobs
app.get('/api/jobs', (req, res) => {
  const list = [];
  for (const job of jobs.values()) {
    list.push({
      id: job.id,
      status: job.status,
      totalCount: job.totalCount,
      completedCount: job.completedCount,
      failedCount: job.failedCount,
      createdAt: job.createdAt
    });
  }
  res.json(list);
});

// GET /api/defaults - Return default scene configs
app.get('/api/defaults', (req, res) => {
  res.json({
    referenceImage: '',
    outputDir: outputDefault,
    promptTemplate: PROMPT_TEMPLATE,
    negativePrompt: NEGATIVE_PROMPT,
    scenes: Object.entries(SCENE_BACKGROUNDS).map(([name, bg]) => ({
      name,
      background: bg,
      fullPrompt: PROMPT_TEMPLATE.replace('{sceneBg}', bg),
      defaultCount: 1
    }))
  });
});

app.listen(PORT, () => {
  console.log(`TKBGC Material Generator running at http://localhost:${PORT}`);
});
