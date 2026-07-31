// ─── camera.js · 相机 / 上传 / 预览 / 提交 ───────
// 依赖：state.js；运行时调用 feedback.js 的 uploadImage
// ─── Preview + Notes Flow ───
let pendingFile = null;

// ─── 应用内相机（getUserMedia） ───
let cameraStream = null;
let cameraFacing = 'environment';
let cameraBusy = false;

function openCamera() {
  track('camera_opened', {source: 'creation'});
  // 尝试使用应用内相机
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    startInAppCamera();
  } else {
    // 不支持 getUserMedia，回退到系统相机
    document.getElementById('cameraInput').click();
  }
}

async function startInAppCamera() {
  const overlay = document.getElementById('cameraOverlay');
  const shootView = document.getElementById('cameraShootView');
  const previewView = document.getElementById('cameraPreviewView');
  const errorView = document.getElementById('cameraErrorView');
  const video = document.getElementById('cameraVideo');

  // 重置视图
  shootView.style.display = '';
  previewView.style.display = 'none';
  errorView.style.display = 'none';

  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';

  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = cameraStream;
  } catch (err) {
    console.warn('Camera access failed:', err);
    // 显示错误视图，提供回退
    shootView.style.display = 'none';
    errorView.style.display = '';
  }
}

function capturePhoto() {
  if (cameraBusy || !cameraStream) return;
  cameraBusy = true;

  // 拍照反馈时序 · 快门瞬间：微震动 + 闪白过渡
  if (navigator.vibrate) navigator.vibrate(30);
  flashCameraShutter();

  const video = document.getElementById('cameraVideo');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    if (!blob) {
      cameraBusy = false;
      return;
    }
    const url = URL.createObjectURL(blob);
    document.getElementById('cameraPreviewImg').src = url;
    // 切换到预览视图
    document.getElementById('cameraShootView').style.display = 'none';
    document.getElementById('cameraPreviewView').style.display = '';
    // 保存 blob 供确认使用
    pendingCameraBlob = blob;
    // 拍照反馈时序 · 预览：轻提示 + 画质即时检测
    showToast('拍到了！看看怎么样 📷');
    detectImageQuality(url, document.getElementById('cameraQuality'));
    cameraBusy = false;
  }, 'image/jpeg', 0.92);
}

// 快门闪白过渡（150ms 白色闪过，模拟快门闭合）
function flashCameraShutter() {
  const flash = document.getElementById('cameraFlash');
  if (!flash) return;
  flash.classList.remove('active');
  void flash.offsetWidth; // 强制重绘，确保动画重新触发
  flash.classList.add('active');
}

// 画质即时检测：采样亮度，提示光线是否合适
function detectImageQuality(url, el) {
  if (!el) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    const size = 32;
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    const avg = sum / (size * size);
    let text = '', cls = '';
    if (avg < 60) { text = '🌙 有点暗，试试调亮？'; cls = 'warn'; }
    else if (avg > 225) { text = '☀️ 光线偏强，避开直射试试'; cls = 'warn'; }
    else { text = '✨ 光线不错，画得很清楚'; cls = 'good'; }
    el.textContent = text;
    el.className = 'camera-quality ' + cls;
  };
  img.onerror = () => { el.textContent = ''; };
  img.src = url;
}

let pendingCameraBlob = null;

function retakePhoto() {
  // 回到拍摄模式
  document.getElementById('cameraShootView').style.display = '';
  document.getElementById('cameraPreviewView').style.display = 'none';
  pendingCameraBlob = null;
}

function confirmPhoto() {
  if (!pendingCameraBlob) return;
  // 将 blob 转为 File 对象
  const file = new File([pendingCameraBlob], 'camera_photo.jpg', { type: 'image/jpeg' });
  closeCamera();
  showPreview(file);
}

function closeCamera() {
  const overlay = document.getElementById('cameraOverlay');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  pendingCameraBlob = null;
  cameraBusy = false;
}

function switchCamera() {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  // 重新启动相机
  startInAppCamera();
}

function fallbackToUpload() {
  closeCamera();
  document.getElementById('uploadInput').click();
}

function openUpload() {
  document.getElementById('uploadInput').click();
}

// 已提交图片指纹集（name+size+lastModified），防止重复上传
const uploadedFileFingerprints = new Set();

function fileFingerprint(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function handleFileSelect(e) {
  if (!e.target.files.length) return;
  const file = e.target.files[0];
  const fp = fileFingerprint(file);
  if (uploadedFileFingerprints.has(fp)) {
    showToast('这张图已经上传过了 📸');
    e.target.value = '';
    return;
  }
  showPreview(file);
}

// 相册上传才检查重复（相机每次拍的都是新照片，不拦截）
document.getElementById('uploadInput').addEventListener('change', handleFileSelect);
// 相机拍照直接放行
document.getElementById('cameraInput').addEventListener('change', e => {
  if (e.target.files.length) showPreview(e.target.files[0]);
});

function resetPreviewUI() {
  const actions = document.querySelector('.preview-confirm-actions');
  if (actions) actions.style.display = 'flex';
  const tag = document.querySelector('.preview-confirm-tag');
  if (tag) tag.textContent = '✓ 拍到了';
  const hint = document.querySelector('.preview-confirm-hint');
  if (hint) hint.textContent = '确认提交后，小绘会仔细看看这幅画';
  const quality = document.getElementById('previewQuality');
  if (quality) { quality.textContent = ''; quality.className = 'preview-quality'; }
}

function showPreview(file) {
  resetPreviewUI();
  pendingFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('previewImg').src = e.target.result;
    document.getElementById('previewSection').classList.remove('hidden');
    document.getElementById('previewSection').scrollIntoView({ behavior: 'smooth' });
    // 拍照反馈时序 · 预览展示：画质即时检测
    detectImageQuality(e.target.result, document.getElementById('previewQuality'));
  };
  reader.readAsDataURL(file);
}

function cancelPreview() {
  pendingFile = null;
  document.getElementById('previewSection').classList.add('hidden');
  document.getElementById('cameraInput').value = '';
  document.getElementById('uploadInput').value = '';
}

function submitDrawing() {
  if (!pendingFile) return;

  // 快速检测：图片是不是手绘画作
  showDrawingCheck();

  const formData = new FormData();
  formData.append('image', pendingFile);

  fetch('/api/check-drawing', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.is_drawing === false) {
        // 不是画 → 弹窗提醒，不继续
        hideDrawingCheck();
        showNotDrawingPopup();
        return;
      }
      // 是画 → 正常提交流程
      hideDrawingCheck();
      proceedSubmit();
    })
    .catch(() => {
      // 检测失败也放行
      hideDrawingCheck();
      proceedSubmit();
    });
}

function proceedSubmit() {
  // 记录已提交指纹，下次选同一张图会提示已上传
  const fp = fileFingerprint(pendingFile);
  uploadedFileFingerprints.add(fp);

  // 预览区不隐藏也不跳全屏——照片保持在原位
  document.querySelector('.preview-confirm-actions').style.display = 'none';
  document.querySelector('.preview-confirm-tag').textContent = '🔍 分析中';
  document.querySelector('.preview-confirm-hint').textContent = 'AI 正在看你的画...';

  // 为保存/分享功能保留图片数据（保持隐藏）
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('submittedPhotoImg').src = e.target.result;
  };
  reader.readAsDataURL(pendingFile);

  uploadImage(pendingFile);
}

// ─── 画作检测 UI ───
function showDrawingCheck() {
  document.querySelector('.preview-confirm-actions').style.display = 'none';
  document.querySelector('.preview-confirm-tag').textContent = '🔎 检测中';
  document.querySelector('.preview-confirm-hint').textContent = '小绘正在看这张是不是画作...';
}

function hideDrawingCheck() {
  document.querySelector('.preview-confirm-tag').textContent = '✓ 拍到了';
  document.querySelector('.preview-confirm-hint').textContent = '确认提交后，小绘会仔细看看这幅画';
}

function showNotDrawingPopup() {
  // 清空 pending 状态，允许重选
  pendingFile = null;
  document.getElementById('cameraInput').value = '';
  document.getElementById('uploadInput').value = '';

  const overlay = document.getElementById('confirmOverlay');
  const dialog = overlay.querySelector('.confirm-dialog');
  dialog.innerHTML = `
    <div class="confirm-icon">🤔</div>
    <div class="confirm-title">这个不太像画作哦</div>
    <div class="confirm-desc">看起来不是手绘的画作，是不是选错照片了？<br><br>
      小绘只能分析手绘的作品。<br>
      试试再画一张然后拍下来吧 🎨</div>
    <div class="confirm-actions">
      <button class="btn btn-md btn-primary" onclick="closeConfirm()">知道了</button>
    </div>
  `;
  overlay.classList.add('visible');
}

// ─── 客户端图片压缩 ───
function compressImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
          } else {
            resolve(file); // 压缩失败则用原图
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}


