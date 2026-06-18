// ============================================================
// カットルーム — app.js (clean rewrite)
// ============================================================
const { FFmpeg }    = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

let ffmpeg      = null;
let ffmpegReady = false;

// ── データモデル ─────────────────────────────────────────────
function mkState() {
  return {
    trimStart: 0, trimEnd: 0,
    speed: 1,
    speedSegments: [],   // {start,end,speed}
    brightness: 0, contrast: 1, saturation: 1,
    volume: 1, rotation: 0,
    textOverlays:  [],   // {text,start,end,size(% of h),color,x(%),y(%)}
    imageOverlays: [],   // {name,dataUrl,file,start,end,x(%),y(%),widthPct(%),aspect}
  };
}

let clips           = [];
let activeClipIdx   = -1;
let state           = mkState();
let videoDuration   = 0;

let activeTool      = null;
let selectedMarker  = null;   // {type:'text'|'speed'|'image', index}
let pendingRange    = null;   // {start,end} — タイムラインドラッグ選択
let isDragHandle    = null;   // 'left'|'right'
let dragClipIdx     = null;

// ── DOM ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const videoEl      = $('previewVideo');
const videoFrame   = $('videoFrame');
const emptyState   = $('emptyState');
const dropZone     = $('dropZone');
const fileInput    = $('fileInput');
const uploadBtn    = $('uploadBtn');
const addClipInput = $('addClipInput');
const imageInput   = $('imageInput');
const exportBtn    = $('exportBtn');
const newFileBtn   = $('newFileBtn');
const fullscreenBtn= $('fullscreenBtn');
const progressEl   = $('progressOverlay');
const progressLbl  = $('progressLabel');
const exportInfo   = $('exportInfo');
const clipStrip    = $('clipStrip');
const toolOptions  = $('toolOptions');
const timelineTrack= $('timelineTrack');
const thumbStrip   = $('thumbStrip');
const trimRegion   = $('trimRegion');
const handleLeft   = $('handleLeft');
const handleRight  = $('handleRight');
const rangeSelect  = $('rangeSelect');
const playhead     = $('playhead');
const ruler        = $('ruler');
const playBtn      = $('playBtn');
const curTimeEl    = $('curTime');
const totalTimeEl  = $('totalTime');
const stepBack     = $('stepBack');
const stepFwd      = $('stepFwd');
const toolButtons  = document.querySelectorAll('.tool-btn');

// ── ファイル読み込み ─────────────────────────────────────────
// uploadBtn と dropZone のクリックイベントを完全に分離
// uploadBtn は直接 fileInput.click() を呼ぶ
// dropZone は uploadBtn/fileInput 以外の部分がクリックされたとき fileInput.click()
uploadBtn.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', e => {
  // uploadBtn(またはその子)がクリック元なら dropZone 側は何もしない
  if (uploadBtn.contains(e.target) || e.target === uploadBtn) return;
  fileInput.click();
});

['dragover','dragenter'].forEach(ev =>
  dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave','drop'].forEach(ev =>
  dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('over'); }));
dropZone.addEventListener('drop', e => {
  const fs = [...e.dataTransfer.files].filter(f => f.type.startsWith('video/'));
  if (fs.length) addClips(fs, true);
});
fileInput.addEventListener('change', e => {
  const fs = [...e.target.files];
  fileInput.value = ''; // 先にリセット（同じファイルを再選択できるように）
  if (fs.length) addClips(fs, true);
});
addClipInput.addEventListener('change', e => {
  const fs = [...e.target.files];
  addClipInput.value = '';
  if (fs.length) addClips(fs, false);
});

newFileBtn.addEventListener('click', resetProject);

function resetProject() {
  clips = []; activeClipIdx = -1;
  state = mkState(); videoDuration = 0;
  selectedMarker = null; pendingRange = null;
  videoEl.removeAttribute('src');
  videoFrame.hidden = true;
  emptyState.hidden = false;
  // stage を初期画面モード（スクロール可能）に戻す
  const stageEl = document.getElementById('stage');
  stageEl.classList.add('welcome-mode');
  exportBtn.disabled = true;
  toolButtons.forEach(b => (b.disabled = true));
  activeTool = null;
  toolOptions.innerHTML = '';
  toolButtons.forEach(b => b.classList.remove('active'));
  clipStrip.innerHTML = '';
  exportInfo.innerHTML = '';
  curTimeEl.textContent = '00:00.0';
  totalTimeEl.textContent = '00:00.0';
  ruler.innerHTML = '';
  thumbStrip.innerHTML = '';
  // 既存オーバーレイ要素の削除
  Object.keys(overlayEls).forEach(k => {
    overlayEls[k].remove();
    delete overlayEls[k];
  });
}

async function addClips(files, isFirst) {
  if (isFirst) {
    clips = []; activeClipIdx = -1;
  }

  // まず全ファイルのメタデータを取得してから表示する（0秒クリップを防ぐ）
  const newClips = [];
  for (const file of files) {
    const clip = {
      id: crypto.randomUUID?.() ?? String(Math.random()),
      file, url: URL.createObjectURL(file),
      duration: 0, thumbnails: [],
      state: mkState()
    };
    await loadClipMeta(clip);
    // 有効なクリップ（duration > 0）のみ追加
    if (clip.duration > 0 && isFinite(clip.duration)) {
      newClips.push(clip);
    } else {
      URL.revokeObjectURL(clip.url);
    }
  }

  if (!newClips.length) return; // 有効なクリップがなければ何もしない

  clips.push(...newClips);

  // UIを表示状態に切り替え（初回 or 追加）
  if (emptyState.hidden === false) {
    emptyState.hidden = true;
    videoFrame.hidden = false;
    exportBtn.disabled = false;
    toolButtons.forEach(b => (b.disabled = false));
    // stage を動画モードに切り替え（overflow:hidden）
    const stageEl = document.getElementById('stage');
    stageEl.classList.remove('welcome-mode');
  }

  renderClipStrip();
  if (activeClipIdx === -1 && clips.length) selectClip(0);
  else renderClipStrip();
}

function loadClipMeta(clip) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;

    const finish = async () => {
      if (done) return;
      done = true;
      clip.duration = v.duration;
      if (clip.duration > 0 && isFinite(clip.duration)) {
        clip.state.trimStart = 0;
        clip.state.trimEnd   = clip.duration;
        await genThumbs(clip, v);
      }
      resolve();
    };

    v.addEventListener('loadedmetadata', finish, { once: true });
    v.addEventListener('error', () => {
      if (!done) { done = true; resolve(); }
    }, { once: true });

    // 10秒タイムアウト
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 10000);
    v.src = clip.url; // src は last（イベント登録後）
  });
}

async function genThumbs(clip, v) {
  const N = 6, cvs = document.createElement('canvas');
  cvs.width = 160; cvs.height = 90;
  const ctx = cvs.getContext('2d');
  for (let i = 0; i < N; i++) {
    await new Promise(res => {
      const fn = () => {
        try { ctx.drawImage(v, 0, 0, 160, 90); } catch(e) {}
        clip.thumbnails.push(cvs.toDataURL('image/jpeg', 0.5));
        v.removeEventListener('seeked', fn); res();
      };
      v.addEventListener('seeked', fn);
      v.currentTime = (clip.duration / N) * i;
    });
  }
}

// ── クリップ選択 ─────────────────────────────────────────────
function selectClip(idx) {
  if (idx < 0 || idx >= clips.length) return;
  activeClipIdx = idx;
  const clip = clips[idx];
  state = clip.state;
  videoDuration = clip.duration;
  selectedMarker = null; pendingRange = null;

  videoEl.src = clip.url;
  videoEl.playbackRate = state.speed;
  videoEl.volume = Math.min(state.volume, 1);
  videoEl.style.transform = `rotate(${state.rotation}deg)`;
  applyFilterCSS();

  videoEl.addEventListener('loadedmetadata', () => {
    videoDuration = clip.duration;
    totalTimeEl.textContent = fmt(videoDuration);
    buildRuler();
    updateTrimRegion();
    renderThumbStrip(clip);
    renderClipStrip();
    if (activeTool) renderToolOptions(activeTool);
  }, { once: true });
}

function applyFilterCSS() {
  videoEl.style.filter =
    `brightness(${1+state.brightness}) contrast(${state.contrast}) saturate(${state.saturation})`;
}

// ── クリップストリップ ────────────────────────────────────────
function renderClipStrip() {
  clipStrip.innerHTML = '';
  clips.forEach((clip, i) => {
    const item = document.createElement('div');
    item.className = 'clip-item' + (i === activeClipIdx ? ' active' : '');
    item.draggable = true;
    item.dataset.idx = i;

    const img = document.createElement('img');
    img.src = clip.thumbnails[0] || '';
    item.appendChild(img);

    const num = document.createElement('div');
    num.className = 'clip-num'; num.textContent = i+1;
    item.appendChild(num);

    const del = document.createElement('button');
    del.className = 'clip-del'; del.textContent = '✕';
    del.addEventListener('click', e => { e.stopPropagation(); removeClip(i); });
    item.appendChild(del);

    const lbl = document.createElement('div');
    lbl.className = 'clip-label';
    lbl.textContent = fmt(clip.state.trimEnd - clip.state.trimStart);
    item.appendChild(lbl);

    item.addEventListener('click', () => selectClip(i));
    item.addEventListener('dragstart', () => { dragClipIdx = i; item.style.opacity = '.5'; });
    item.addEventListener('dragend',   () => { item.style.opacity='1'; dragClipIdx=null; });
    item.addEventListener('dragover',  e => { e.preventDefault(); item.style.borderColor='var(--ok)'; });
    item.addEventListener('dragleave', () => item.style.borderColor='');
    item.addEventListener('drop', e => {
      e.preventDefault(); item.style.borderColor='';
      if (dragClipIdx !== null && dragClipIdx !== i) reorderClips(dragClipIdx, i);
    });
    clipStrip.appendChild(item);
  });

  const add = document.createElement('button');
  add.className = 'clip-add';
  add.innerHTML = '<span class="ic">＋</span>追加';
  add.addEventListener('click', () => addClipInput.click());
  clipStrip.appendChild(add);
}

function renderThumbStrip(clip) {
  thumbStrip.innerHTML = '';
  clip.thumbnails.forEach(src => {
    const img = document.createElement('img'); img.src = src;
    thumbStrip.appendChild(img);
  });
}

function reorderClips(from, to) {
  const [m] = clips.splice(from, 1);
  clips.splice(to, 0, m);
  if      (activeClipIdx === from) activeClipIdx = to;
  else if (activeClipIdx > from && activeClipIdx <= to) activeClipIdx--;
  else if (activeClipIdx < from && activeClipIdx >= to) activeClipIdx++;
  renderClipStrip(); updateExportInfo();
}

function removeClip(idx) {
  clips.splice(idx, 1);
  if (!clips.length) { resetProject(); return; }
  if (activeClipIdx >= clips.length) activeClipIdx = clips.length-1;
  if (activeClipIdx === idx) selectClip(Math.min(idx, clips.length-1));
  else { if (idx < activeClipIdx) activeClipIdx--; renderClipStrip(); updateExportInfo(); }
}

// ── 再生 ────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
  if (videoEl.paused) {
    if (videoEl.currentTime < state.trimStart || videoEl.currentTime >= state.trimEnd)
      videoEl.currentTime = state.trimStart;
    videoEl.playbackRate = speedAt(videoEl.currentTime);
    videoEl.play();
  } else {
    videoEl.pause();
  }
});
videoEl.addEventListener('play',  () => { playBtn.textContent = '❙❙'; });
videoEl.addEventListener('pause', () => { playBtn.textContent = '▶'; });
videoEl.addEventListener('timeupdate', () => {
  curTimeEl.textContent = fmt(videoEl.currentTime);
  updatePlayhead();
  if (videoEl.currentTime >= state.trimEnd) {
    videoEl.pause(); videoEl.currentTime = state.trimStart;
  }
  const r = speedAt(videoEl.currentTime);
  if (Math.abs(videoEl.playbackRate - r) > .001) videoEl.playbackRate = r;
  refreshOverlays();
});

stepBack.addEventListener('click', () => {
  videoEl.pause();
  videoEl.currentTime = Math.max(0, videoEl.currentTime - .1);
});
stepFwd.addEventListener('click', () => {
  videoEl.pause();
  videoEl.currentTime = Math.min(videoDuration, videoEl.currentTime + .1);
});

fullscreenBtn?.addEventListener('click', () => {
  document.fullscreenElement ? document.exitFullscreen() : videoFrame.requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  requestAnimationFrame(() => repositionOverlays());
});

// ── タイムライン ─────────────────────────────────────────────
function buildRuler() {
  ruler.innerHTML = '';
  const step = videoDuration > 60 ? 10 : videoDuration > 20 ? 5 : 2;
  for (let t = 0; t <= videoDuration; t += step) {
    const sp = document.createElement('span');
    sp.style.left = (t/videoDuration*100) + '%';
    sp.textContent = fmt(t);
    ruler.appendChild(sp);
  }
}

function updateTrimRegion() {
  const s = (state.trimStart/videoDuration)*100;
  const e = (state.trimEnd  /videoDuration)*100;
  trimRegion.style.left  = s + '%';
  trimRegion.style.width = (e-s) + '%';
  renderMarkers(); updateExportInfo(); renderClipStrip();
}

function updatePlayhead() {
  playhead.style.left = (videoEl.currentTime/videoDuration*100) + '%';
}

// トリムハンドルのドラッグ
handleLeft .addEventListener('mousedown', e => { isDragHandle='left';  e.stopPropagation(); });
handleRight.addEventListener('mousedown', e => { isDragHandle='right'; e.stopPropagation(); });

document.addEventListener('mousemove', e => {
  if (!isDragHandle || !videoDuration) return;
  const rect = timelineTrack.getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width)) * videoDuration;
  if (isDragHandle==='left') {
    state.trimStart = Math.max(0, Math.min(t, state.trimEnd-.2));
  } else {
    state.trimEnd   = Math.min(videoDuration, Math.max(t, state.trimStart+.2));
  }
  updateTrimRegion();
  videoEl.currentTime = isDragHandle==='left' ? state.trimStart : state.trimEnd;
});
document.addEventListener('mouseup', () => { isDragHandle = null; });

// タイムラインのドラッグ範囲選択（字幕の時間指定）
let selStart = 0, selStartX = 0, selActive = false;
const SEL_THRESH = 5;

timelineTrack.addEventListener('mousedown', e => {
  if (e.target.closest('.trim-handle') || e.target.closest('.marker')) return;
  if (!videoDuration) return;
  selActive = true;
  selStartX = e.clientX;
  const rect = timelineTrack.getBoundingClientRect();
  selStart = Math.max(0, Math.min(1,(e.clientX-rect.left)/rect.width)) * videoDuration;
});

document.addEventListener('mousemove', e => {
  if (!selActive || !videoDuration) return;
  if (Math.abs(e.clientX-selStartX) < SEL_THRESH) { rangeSelect.hidden=true; return; }
  const rect = timelineTrack.getBoundingClientRect();
  const cur  = Math.max(0, Math.min(1,(e.clientX-rect.left)/rect.width)) * videoDuration;
  const lo = Math.min(selStart,cur), hi = Math.max(selStart,cur);
  rangeSelect.style.left  = (lo/videoDuration*100) + '%';
  rangeSelect.style.width = ((hi-lo)/videoDuration*100) + '%';
  rangeSelect.hidden = false;
});

document.addEventListener('mouseup', e => {
  if (!selActive) return;
  selActive = false;
  rangeSelect.hidden = true;
  if (!videoDuration) return;
  const moved = Math.abs(e.clientX - selStartX);
  const rect  = timelineTrack.getBoundingClientRect();
  if (moved < SEL_THRESH) {
    // クリック → シーク
    const t = Math.max(0, Math.min(1,(e.clientX-rect.left)/rect.width)) * videoDuration;
    videoEl.currentTime = t;
    return;
  }
  const cur = Math.max(0, Math.min(1,(e.clientX-rect.left)/rect.width)) * videoDuration;
  const lo  = Math.max(0,             Math.min(selStart,cur));
  const hi  = Math.min(videoDuration, Math.max(selStart,cur));
  if (hi-lo < .05) return;
  pendingRange = {start:lo, end:hi};
  // テキストツールを自動で開く
  activeTool = 'text';
  selectedMarker = null;
  toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool==='text'));
  renderToolOptions('text');
  renderMarkers();
});

// ── マーカー ─────────────────────────────────────────────────
function renderMarkers() {
  timelineTrack.querySelectorAll('.marker').forEach(m => m.remove());
  if (!videoDuration) return;

  state.textOverlays.forEach((o,i) => {
    const m = makeMarker(
      o.start, o.end, `🔤 ${o.text}`, 'marker-text',
      selectedMarker?.type==='text' && selectedMarker.index===i,
      () => {
        selectedMarker = {type:'text',index:i};
        activeTool = 'text';
        toolButtons.forEach(b=>b.classList.toggle('active',b.dataset.tool==='text'));
        renderToolOptions('text'); renderMarkers();
      }
    );
    timelineTrack.appendChild(m);
  });

  state.speedSegments.forEach((s,i) => {
    const m = makeMarker(
      s.start, s.end, `⏩ ${s.speed.toFixed(2)}x`, 'marker-speed',
      selectedMarker?.type==='speed' && selectedMarker.index===i,
      () => {
        selectedMarker = {type:'speed',index:i};
        activeTool = 'speed';
        toolButtons.forEach(b=>b.classList.toggle('active',b.dataset.tool==='speed'));
        renderToolOptions('speed'); renderMarkers();
      }
    );
    timelineTrack.appendChild(m);
  });

  state.imageOverlays.forEach((o,i) => {
    const m = makeMarker(
      o.start, o.end, `👤 ${o.name}`, 'marker-speed',
      selectedMarker?.type==='image' && selectedMarker.index===i,
      () => {
        selectedMarker = {type:'image',index:i};
        activeTool = 'image';
        toolButtons.forEach(b=>b.classList.toggle('active',b.dataset.tool==='image'));
        renderToolOptions('image'); renderMarkers();
      }
    );
    m.style.top = '40px';
    timelineTrack.appendChild(m);
  });
}

function makeMarker(start, end, label, cls, active, onClick) {
  const lo = (start/videoDuration)*100;
  const wi = Math.max(((end-start)/videoDuration)*100, .4);
  const m = document.createElement('div');
  m.className = `marker ${cls}${active?' sel':''}`;
  m.style.left = lo+'%'; m.style.width = wi+'%';
  m.textContent = label;
  m.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return m;
}

// ── ツール切り替え ────────────────────────────────────────────
toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const tool = btn.dataset.tool;
    if (activeTool === tool) {
      activeTool = null; selectedMarker = null;
      toolButtons.forEach(b=>b.classList.remove('active'));
      toolOptions.innerHTML = '';
      renderMarkers(); return;
    }
    activeTool = tool; selectedMarker = null;
    toolButtons.forEach(b=>b.classList.toggle('active',b===btn));
    renderToolOptions(tool); renderMarkers();
  });
});

function renderToolOptions(tool) {
  const fn = {trim:trimUI, text:textUI, image:imageUI,
              speed:speedUI, adjust:adjustUI, volume:volumeUI, rotate:rotateUI}[tool];
  toolOptions.innerHTML = fn ? fn() : '';
  const bind = {trim:bindTrim, text:bindText, image:bindImage,
                speed:bindSpeed, adjust:bindAdjust, volume:bindVolume, rotate:bindRotate}[tool];
  if (bind) bind();
}

// ── ツール: トリミング ─────────────────────────────────────────
function trimUI() { return `
  <h3>トリミング（このクリップ）</h3>
  <div class="row">
    <div class="field"><label>開始</label>
      <div class="with-btn">
        <input type="text" id="tS" value="${fmt(state.trimStart)}">
        <button class="mini-btn" id="tSnow">現在位置</button>
      </div></div>
    <div class="field"><label>終了</label>
      <div class="with-btn">
        <input type="text" id="tE" value="${fmt(state.trimEnd)}">
        <button class="mini-btn" id="tEnow">現在位置</button>
      </div></div>
  </div>
  <p class="hint">ハンドルをドラッグして調整もできます。秒数は小数で入力可 (例: 5.3)。</p>
`; }
function bindTrim() {
  $('tSnow').addEventListener('click',()=>{ $('tS').value=fmt(videoEl.currentTime); });
  $('tEnow').addEventListener('click',()=>{ $('tE').value=fmt(videoEl.currentTime); });
  $('tS').addEventListener('change',()=>{
    const t=parseFmt($('tS').value); if(t!==null&&t<state.trimEnd){state.trimStart=t;updateTrimRegion();}
  });
  $('tE').addEventListener('change',()=>{
    const t=parseFmt($('tE').value); if(t!==null&&t>state.trimStart){state.trimEnd=Math.min(t,videoDuration);updateTrimRegion();}
  });
}

// ── ツール: テキスト ─────────────────────────────────────────
const COLORS = [
  {l:'白',v:'white'},{l:'黒',v:'black'},{l:'黄',v:'yellow'},{l:'赤',v:'red'},
  {l:'橙',v:'orange'},{l:'緑',v:'lime'},{l:'青',v:'blue'},{l:'シアン',v:'cyan'},
  {l:'ピンク',v:'pink'},{l:'紫',v:'purple'},{l:'灰',v:'gray'},
];

function textUI() {
  const ed = selText();
  const list = state.textOverlays.map((o,i)=>`
    <div class="chip${selectedMarker?.type==='text'&&selectedMarker.index===i?' active':''}"
         data-seltxt="${i}">
      <span>"${esc(o.text)}" ${fmt(o.start)}–${fmt(o.end)}</span>
      <button class="chip-del" data-deltxt="${i}">✕</button>
    </div>`).join('');

  const banner = ed
    ? `<div class="banner"><span>編集中（動画でドラッグして移動可）</span><button id="cancelTxt">キャンセル</button></div>`
    : pendingRange
    ? `<div class="banner"><span>選択範囲 ${fmt(pendingRange.start)}–${fmt(pendingRange.end)}</span><button id="clearPR">クリア</button></div>`
    : '';

  const v = ed || (pendingRange
    ? {text:'',start:pendingRange.start,end:pendingRange.end,size:6,color:'white',x:10,y:80}
    : {text:'',start:videoEl.currentTime,end:Math.min(videoEl.currentTime+3,videoDuration||10),size:6,color:'white',x:10,y:80}
  );

  return `
  <h3>テキスト（このクリップ）</h3>
  <div class="chip-list">${list||'<p class="hint">まだテキストはありません</p>'}</div>
  ${banner}
  <div class="field"><label>テキスト内容</label>
    <input type="text" id="txText" value="${esc(v.text)}" placeholder="例: こんにちは"></div>
  <div class="row">
    <div class="field"><label>開始</label>
      <div class="with-btn">
        <input type="text" id="txS" value="${fmt(v.start)}">
        <button class="mini-btn" id="txSnow">現在</button>
      </div></div>
    <div class="field"><label>終了</label>
      <div class="with-btn">
        <input type="text" id="txE" value="${fmt(v.end)}">
        <button class="mini-btn" id="txEnow">現在</button>
      </div></div>
  </div>
  <div class="field"><label>色</label>
    <div class="with-btn">
      <input type="text" id="txColor" value="${esc(v.color)}" placeholder="white / #ff0000">
      <input type="color" id="txPicker" value="${toHex(v.color)}">
    </div></div>
  <div class="color-palette">${COLORS.map(c=>`<button class="swatch" data-c="${c.v}" style="background:${c.v}" title="${c.l}"></button>`).join('')}</div>
  <div class="field"><label>横位置 X% <span class="pill" id="xv">${Math.round(v.x)}</span></label>
    <input type="range" id="txX" min="0" max="95" step=".5" value="${v.x}"></div>
  <div class="field"><label>縦位置 Y% <span class="pill" id="yv">${Math.round(v.y)}</span></label>
    <input type="range" id="txY" min="0" max="95" step=".5" value="${v.y}"></div>
  <div class="field"><label>サイズ（動画の高さの%） <span class="pill" id="sv">${v.size.toFixed(1)}</span></label>
    <input type="range" id="txSz" min="1.5" max="20" step=".1" value="${v.size}"></div>
  ${ed
    ? `<div class="btn-row"><button class="btn btn-primary" id="txSave">更新</button><button class="btn btn-danger" id="txDel">削除</button></div>`
    : `<button class="btn btn-primary btn-block" id="txSave">テキストを追加</button>`}
  <p class="hint">動画プレビュー上のテキストをドラッグして位置を変更できます。端（右下）をドラッグするとサイズが変わります。</p>`;
}

function selText() {
  return selectedMarker?.type==='text' ? state.textOverlays[selectedMarker.index] : null;
}

function bindText() {
  const editIdx = selectedMarker?.type==='text' ? selectedMarker.index : null;

  const live = () => {
    if (editIdx !== null) {
      const o = state.textOverlays[editIdx];
      o.x     = parseFloat($('txX')?.value ?? o.x);
      o.y     = parseFloat($('txY')?.value ?? o.y);
      o.size  = parseFloat($('txSz')?.value ?? o.size);
      o.color = $('txColor')?.value || o.color;
    }
    refreshOverlays();
  };

  $('txSnow')?.addEventListener('click',()=>{ $('txS').value=fmt(videoEl.currentTime); });
  $('txEnow')?.addEventListener('click',()=>{ $('txE').value=fmt(videoEl.currentTime); });
  $('txX')?.addEventListener('input', e=>{ $('xv').textContent=Math.round(e.target.value); live(); });
  $('txY')?.addEventListener('input', e=>{ $('yv').textContent=Math.round(e.target.value); live(); });
  $('txSz')?.addEventListener('input',e=>{ $('sv').textContent=parseFloat(e.target.value).toFixed(1); live(); });
  $('txColor')?.addEventListener('change', e=>{ $('txPicker').value=toHex(e.target.value); live(); });
  $('txPicker')?.addEventListener('input', e=>{ $('txColor').value=e.target.value; live(); });
  document.querySelectorAll('.swatch[data-c]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $('txColor').value=btn.dataset.c; $('txPicker').value=toHex(btn.dataset.c); live();
    });
  });

  $('txSave')?.addEventListener('click', () => {
    const text = $('txText').value.trim();
    if (!text) return;
    const start = parseFmt($('txS').value) ?? 0;
    const end   = parseFmt($('txE').value) ?? videoDuration;
    const size  = parseFloat($('txSz').value);
    const color = $('txColor').value || 'white';
    const x     = parseFloat($('txX').value);
    const y     = parseFloat($('txY').value);
    const item  = {
      text,
      start: clamp(start, 0, videoDuration),
      end:   clamp(Math.max(end, start+.1), 0, videoDuration),
      size, color, x, y
    };
    if (editIdx !== null) { state.textOverlays[editIdx]=item; selectedMarker=null; }
    else                    state.textOverlays.push(item);
    pendingRange = null;
    renderToolOptions('text'); renderMarkers(); refreshOverlays();
  });

  $('cancelTxt')?.addEventListener('click', ()=>{ selectedMarker=null; renderToolOptions('text'); renderMarkers(); });
  $('clearPR')?.addEventListener('click',   ()=>{ pendingRange=null;   renderToolOptions('text'); });
  $('txDel')?.addEventListener('click',     ()=>{
    if (editIdx===null) return;
    state.textOverlays.splice(editIdx,1); selectedMarker=null;
    renderToolOptions('text'); renderMarkers(); refreshOverlays();
  });

  document.querySelectorAll('[data-seltxt]').forEach(chip=>{
    chip.addEventListener('click', e=>{
      if (e.target.closest('[data-deltxt]')) return;
      selectedMarker={type:'text',index:parseInt(chip.dataset.seltxt)};
      renderToolOptions('text'); renderMarkers();
    });
  });
  document.querySelectorAll('[data-deltxt]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      const i=parseInt(btn.dataset.deltxt);
      state.textOverlays.splice(i,1);
      if (selectedMarker?.type==='text'&&selectedMarker.index===i) selectedMarker=null;
      renderToolOptions('text'); renderMarkers(); refreshOverlays();
    });
  });
}

// ── ツール: 話者写真 ─────────────────────────────────────────
function imageUI() {
  const ed   = selImage();
  const list = state.imageOverlays.map((o,i)=>`
    <div class="chip${selectedMarker?.type==='image'&&selectedMarker.index===i?' active':''}"
         data-selimg="${i}">
      <span>👤 ${esc(o.name)} ${fmt(o.start)}–${fmt(o.end)}</span>
      <button class="chip-del" data-delimg="${i}">✕</button>
    </div>`).join('');

  const v = ed || {
    name:'', start:videoEl.currentTime,
    end:Math.min(videoEl.currentTime+5,videoDuration||10),
    x:2, y:50, widthPct:22
  };

  const banner = ed
    ? `<div class="banner"><span>編集中（動画でドラッグして移動可）</span><button id="cancelImg">キャンセル</button></div>`
    : '';

  const imgPreview = ed?.dataUrl
    ? `<img src="${ed.dataUrl}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;margin-bottom:8px;" />`
    : '';

  return `
  <h3>話者写真（このクリップ）</h3>
  <div class="chip-list">${list||'<p class="hint">まだ写真はありません</p>'}</div>
  ${banner}
  ${imgPreview}
  <div class="field"><label>名前（識別用）</label>
    <input type="text" id="imgName" value="${esc(v.name)}" placeholder="例: 田中さん"></div>
  <button class="btn btn-ghost btn-block" id="imgUpload" style="margin-bottom:10px;">
    📁 ${ed ? '写真を変更' : '写真を選択（jpg/png）'}
  </button>
  <div class="row">
    <div class="field"><label>開始</label>
      <div class="with-btn">
        <input type="text" id="imgS" value="${fmt(v.start)}">
        <button class="mini-btn" id="imgSnow">現在</button>
      </div></div>
    <div class="field"><label>終了</label>
      <div class="with-btn">
        <input type="text" id="imgE" value="${fmt(v.end)}">
        <button class="mini-btn" id="imgEnow">現在</button>
      </div></div>
  </div>
  <div class="field"><label>横位置 X% <span class="pill" id="ixv">${Math.round(v.x)}</span></label>
    <input type="range" id="imgX" min="0" max="90" step=".5" value="${v.x}"></div>
  <div class="field"><label>縦位置 Y% <span class="pill" id="iyv">${Math.round(v.y)}</span></label>
    <input type="range" id="imgY" min="0" max="90" step=".5" value="${v.y}"></div>
  <div class="field"><label>サイズ（動画の幅の%） <span class="pill" id="iwv">${Math.round(v.widthPct)}</span></label>
    <input type="range" id="imgW" min="5" max="50" step=".5" value="${v.widthPct}"></div>
  ${ed
    ? `<div class="btn-row"><button class="btn btn-primary" id="imgSave">更新</button><button class="btn btn-danger" id="imgDel">削除</button></div>`
    : `<button class="btn btn-primary btn-block" id="imgSave" ${ed?.dataUrl||''?'':'disabled'}>写真を追加</button>`}
  <p class="hint">動画プレビュー上の写真をドラッグして移動、端をドラッグしてサイズを変更できます。</p>`;
}

function selImage() {
  return selectedMarker?.type==='image' ? state.imageOverlays[selectedMarker.index] : null;
}

// 一時的な画像データ (選択したがまだ保存していないもの)
let _pendingImage = null;

function bindImage() {
  const editIdx = selectedMarker?.type==='image' ? selectedMarker.index : null;

  const livePosImg = () => {
    if (editIdx !== null) {
      const o = state.imageOverlays[editIdx];
      o.x        = parseFloat($('imgX')?.value ?? o.x);
      o.y        = parseFloat($('imgY')?.value ?? o.y);
      o.widthPct = parseFloat($('imgW')?.value ?? o.widthPct);
    }
    refreshOverlays();
  };

  $('imgUpload')?.addEventListener('click', () => imageInput.click());
  imageInput.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    const aspect  = await getAspect(dataUrl);
    _pendingImage = { dataUrl, file, aspect };
    imageInput.value = '';
    const saveBtn = $('imgSave');
    if (saveBtn) saveBtn.disabled = false;
    // 小プレビューを更新
    const prev = document.querySelector('#toolOptions img');
    if (prev) { prev.src = dataUrl; }
    else {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.style.cssText='width:60px;height:60px;object-fit:cover;border-radius:6px;margin-bottom:8px;';
      $('imgUpload').insertAdjacentElement('beforebegin', img);
    }
    refreshOverlays();
  };

  $('imgSnow')?.addEventListener('click',()=>{ $('imgS').value=fmt(videoEl.currentTime); });
  $('imgEnow')?.addEventListener('click',()=>{ $('imgE').value=fmt(videoEl.currentTime); });
  $('imgX')?.addEventListener('input', e=>{ $('ixv').textContent=Math.round(e.target.value); livePosImg(); });
  $('imgY')?.addEventListener('input', e=>{ $('iyv').textContent=Math.round(e.target.value); livePosImg(); });
  $('imgW')?.addEventListener('input', e=>{ $('iwv').textContent=Math.round(e.target.value); livePosImg(); });

  $('imgSave')?.addEventListener('click', ()=>{
    const editing = editIdx!==null ? state.imageOverlays[editIdx] : null;
    const img = _pendingImage || (editing ? {dataUrl:editing.dataUrl,file:editing.file,aspect:editing.aspect} : null);
    if (!img) return;
    const name     = $('imgName').value.trim() || '話者';
    const start    = parseFmt($('imgS').value) ?? 0;
    const end      = parseFmt($('imgE').value) ?? videoDuration;
    const x        = parseFloat($('imgX').value);
    const y        = parseFloat($('imgY').value);
    const widthPct = parseFloat($('imgW').value);
    const item = {
      name, dataUrl:img.dataUrl, file:img.file, aspect:img.aspect,
      start:clamp(start,0,videoDuration),
      end:clamp(Math.max(end,start+.1),0,videoDuration),
      x, y, widthPct
    };
    if (editIdx!==null) { state.imageOverlays[editIdx]=item; selectedMarker=null; }
    else                  state.imageOverlays.push(item);
    _pendingImage=null;
    renderToolOptions('image'); renderMarkers(); refreshOverlays();
  });

  $('cancelImg')?.addEventListener('click',()=>{ selectedMarker=null; renderToolOptions('image'); renderMarkers(); });
  $('imgDel')?.addEventListener('click',()=>{
    if (editIdx===null) return;
    state.imageOverlays.splice(editIdx,1); selectedMarker=null;
    renderToolOptions('image'); renderMarkers(); refreshOverlays();
  });
  document.querySelectorAll('[data-selimg]').forEach(chip=>{
    chip.addEventListener('click', e=>{
      if (e.target.closest('[data-delimg]')) return;
      selectedMarker={type:'image',index:parseInt(chip.dataset.selimg)};
      renderToolOptions('image'); renderMarkers();
    });
  });
  document.querySelectorAll('[data-delimg]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      const i=parseInt(btn.dataset.delimg);
      state.imageOverlays.splice(i,1);
      if (selectedMarker?.type==='image'&&selectedMarker.index===i) selectedMarker=null;
      renderToolOptions('image'); renderMarkers(); refreshOverlays();
    });
  });
}

// ── ツール: 速度 ─────────────────────────────────────────────
function speedUI() {
  const ed = selSpeed();
  const list = state.speedSegments.map((s,i)=>`
    <div class="chip${selectedMarker?.type==='speed'&&selectedMarker.index===i?' active':''}"
         data-selseg="${i}">
      <span>⏩ ${fmt(s.start)}–${fmt(s.end)} : ${s.speed.toFixed(2)}x</span>
      <button class="chip-del" data-delseg="${i}">✕</button>
    </div>`).join('');

  const v = ed||{start:videoEl.currentTime,end:Math.min(videoEl.currentTime+2,videoDuration||10),speed:.5};
  const banner = ed
    ? `<div class="banner"><span>区間を編集中</span><button id="cancelSeg">キャンセル</button></div>`:'';

  return `
  <h3>再生速度（このクリップ）</h3>
  <div class="field"><label>基本速度 <span class="pill" id="bsv">${state.speed.toFixed(2)}x</span></label>
    <input type="range" id="baseSpeed" min=".25" max="3" step=".05" value="${state.speed}"></div>
  <h3 style="margin-top:12px">一部だけ速度を変える</h3>
  <div class="chip-list">${list||'<p class="hint">区間指定なし</p>'}</div>
  ${banner}
  <div class="row">
    <div class="field"><label>開始</label>
      <div class="with-btn">
        <input type="text" id="segS" value="${fmt(v.start)}">
        <button class="mini-btn" id="segSnow">現在</button>
      </div></div>
    <div class="field"><label>終了</label>
      <div class="with-btn">
        <input type="text" id="segE" value="${fmt(v.end)}">
        <button class="mini-btn" id="segEnow">現在</button>
      </div></div>
  </div>
  <div class="field"><label>この区間の速度 <span class="pill" id="ssv">${v.speed.toFixed(2)}x</span></label>
    <input type="range" id="segSpeed" min=".1" max="4" step=".05" value="${v.speed}"></div>
  ${ed
    ?`<div class="btn-row"><button class="btn btn-primary" id="segSave">更新</button><button class="btn btn-danger" id="segDel">削除</button></div>`
    :`<button class="btn btn-primary btn-block" id="segSave">速度区間を追加</button>`}
  <p class="hint">タイムラインの紫マーカーをクリックして編集できます。</p>`;
}

function selSpeed() {
  return selectedMarker?.type==='speed' ? state.speedSegments[selectedMarker.index] : null;
}

function bindSpeed() {
  const editIdx = selectedMarker?.type==='speed' ? selectedMarker.index : null;
  $('baseSpeed')?.addEventListener('input',e=>{
    state.speed=parseFloat(e.target.value);
    $('bsv').textContent=state.speed.toFixed(2)+'x';
    if (!state.speedSegments.length) videoEl.playbackRate=state.speed;
    updateExportInfo();
  });
  $('segSpeed')?.addEventListener('input',e=>{ $('ssv').textContent=parseFloat(e.target.value).toFixed(2)+'x'; });
  $('segSnow')?.addEventListener('click',()=>{ $('segS').value=fmt(videoEl.currentTime); });
  $('segEnow')?.addEventListener('click',()=>{ $('segE').value=fmt(videoEl.currentTime); });
  $('segSave')?.addEventListener('click',()=>{
    const start=parseFmt($('segS').value)??0;
    const end  =parseFmt($('segE').value)??videoDuration;
    const speed=parseFloat($('segSpeed').value);
    const item ={start:clamp(start,0,videoDuration),end:clamp(Math.max(end,start+.1),0,videoDuration),speed};
    if (editIdx!==null){state.speedSegments[editIdx]=item;selectedMarker=null;}
    else state.speedSegments.push(item);
    state.speedSegments.sort((a,b)=>a.start-b.start);
    renderToolOptions('speed'); renderMarkers(); updateExportInfo();
  });
  $('cancelSeg')?.addEventListener('click',()=>{selectedMarker=null;renderToolOptions('speed');renderMarkers();});
  $('segDel')?.addEventListener('click',()=>{
    if(editIdx===null)return;
    state.speedSegments.splice(editIdx,1);selectedMarker=null;
    renderToolOptions('speed');renderMarkers();updateExportInfo();
  });
  document.querySelectorAll('[data-selseg]').forEach(chip=>{
    chip.addEventListener('click',e=>{
      if(e.target.closest('[data-delseg]'))return;
      selectedMarker={type:'speed',index:parseInt(chip.dataset.selseg)};
      renderToolOptions('speed');renderMarkers();
    });
  });
  document.querySelectorAll('[data-delseg]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const i=parseInt(btn.dataset.delseg);
      state.speedSegments.splice(i,1);
      if(selectedMarker?.type==='speed'&&selectedMarker.index===i)selectedMarker=null;
      renderToolOptions('speed');renderMarkers();updateExportInfo();
    });
  });
}

// ── ツール: 色調整 ────────────────────────────────────────────
function adjustUI(){return`
  <h3>色調整（このクリップ）</h3>
  <div class="field"><label>明るさ <span class="pill" id="bv">${state.brightness.toFixed(2)}</span></label>
    <input type="range" id="adjB" min="-1" max="1" step=".05" value="${state.brightness}"></div>
  <div class="field"><label>コントラスト <span class="pill" id="cv">${state.contrast.toFixed(2)}</span></label>
    <input type="range" id="adjC" min="0" max="2" step=".05" value="${state.contrast}"></div>
  <div class="field"><label>彩度 <span class="pill" id="sv2">${state.saturation.toFixed(2)}</span></label>
    <input type="range" id="adjS" min="0" max="3" step=".05" value="${state.saturation}"></div>
  <p class="hint">プレビューはCSSで即時反映。書き出し時にFFmpegで映像に適用されます。</p>`;}
function bindAdjust(){
  $('adjB')?.addEventListener('input',e=>{state.brightness=+e.target.value;$('bv').textContent=(+e.target.value).toFixed(2);applyFilterCSS();});
  $('adjC')?.addEventListener('input',e=>{state.contrast  =+e.target.value;$('cv').textContent=(+e.target.value).toFixed(2);applyFilterCSS();});
  $('adjS')?.addEventListener('input',e=>{state.saturation=+e.target.value;$('sv2').textContent=(+e.target.value).toFixed(2);applyFilterCSS();});
}

// ── ツール: 音量 ─────────────────────────────────────────────
function volumeUI(){return`
  <h3>音量（このクリップ）</h3>
  <div class="field"><label>音量 <span class="pill" id="vv">${Math.round(state.volume*100)}%</span></label>
    <input type="range" id="volR" min="0" max="2" step=".05" value="${state.volume}"></div>
  <p class="hint">100%が元の音量。200%まで増幅可。</p>`;}
function bindVolume(){
  $('volR')?.addEventListener('input',e=>{state.volume=+e.target.value;$('vv').textContent=Math.round(+e.target.value*100)+'%';videoEl.volume=Math.min(state.volume,1);});
}

// ── ツール: 回転 ─────────────────────────────────────────────
function rotateUI(){return`
  <h3>回転（このクリップ）</h3>
  <div class="tool-grid">
    ${[0,90,180,270].map(r=>`<button class="tool-btn${state.rotation===r?' active':''}" data-rot="${r}">${r}°</button>`).join('')}
  </div>`;}
function bindRotate(){
  document.querySelectorAll('[data-rot]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      state.rotation=parseInt(btn.dataset.rot);
      videoEl.style.transform=`rotate(${state.rotation}deg)`;
      renderToolOptions('rotate');
    });
  });
}

// ── プレビューオーバーレイ ────────────────────────────────────
// すべてのオーバーレイ要素を videoFrame 内に保持する辞書
const overlayEls = {}; // key: 'text_i' | 'image_i'

function refreshOverlays() {
  if (!videoDuration) return;
  const t = videoEl.currentTime;

  // 既存要素をすべて非表示に
  Object.values(overlayEls).forEach(el => el.hidden = true);

  // 現在時刻にアクティブなもの、または編集中のものを表示
  state.textOverlays.forEach((o, i) => {
    const isEditing = selectedMarker?.type==='text' && selectedMarker.index===i;
    if (t < o.start || t > o.end) {
      if (!isEditing) return;
    }
    showTextOverlay(o, i);
  });

  state.imageOverlays.forEach((o, i) => {
    const isEditing = selectedMarker?.type==='image' && selectedMarker.index===i;
    if (t < o.start || t > o.end) {
      if (!isEditing) return;
    }
    showImageOverlay(o, i);
  });
}

function getVideoRect() {
  // videoEl内の実際の描画領域サイズ (object-fit:contain 相当)
  const vw = videoEl.videoWidth  || videoEl.clientWidth;
  const vh = videoEl.videoHeight || videoEl.clientHeight;
  const ew = videoEl.clientWidth;
  const eh = videoEl.clientHeight;
  const vr = vw/vh, er = ew/eh;
  let dw, dh;
  if (vr > er) { dw=ew; dh=ew/vr; }
  else         { dh=eh; dw=eh*vr; }
  return { w:dw, h:dh, ox:(ew-dw)/2, oy:(eh-dh)/2 };
}

function showTextOverlay(o, i) {
  const key = 'text_'+i;
  let el = overlayEls[key];
  if (!el) {
    el = document.createElement('div');
    el.style.cssText = `
      position:absolute; pointer-events:auto; cursor:grab;
      font-weight:700; font-family:sans-serif;
      text-shadow:0 2px 6px rgba(0,0,0,.7);
      user-select:none; white-space:nowrap;
      display:flex; align-items:center; justify-content:center;
    `;
    // リサイズハンドル
    const rsz = document.createElement('div');
    rsz.className = 'overlay-resize';
    rsz.style.cssText='position:absolute;bottom:-4px;right:-4px;width:14px;height:14px;cursor:se-resize;background:var(--accent);border-radius:3px;opacity:.8;';
    el._rsz = rsz;
    el.appendChild(rsz);
    videoFrame.appendChild(el);
    overlayEls[key] = el;
    makeDraggable(el, ()=>state.textOverlays[i], 'text', i);
    makeResizableText(rsz, ()=>state.textOverlays[i], i);
  }
  const rect = getVideoRect();
  el.hidden = false;
  el.textContent = o.text;
  el.appendChild(el._rsz); // keep resize handle
  el.style.color    = o.color;
  el.style.fontSize = Math.max(8, o.size/100 * rect.h) + 'px';
  el.style.left     = (rect.ox + rect.w * o.x/100) + 'px';
  el.style.top      = (rect.oy + rect.h * o.y/100) + 'px';
}

function showImageOverlay(o, i) {
  const key = 'image_'+i;
  let el = overlayEls[key];
  if (!el) {
    el = document.createElement('img');
    el.style.cssText='position:absolute;pointer-events:auto;cursor:grab;user-select:none;border-radius:6px;box-shadow:0 3px 10px rgba(0,0,0,.5);';
    el.draggable = false;
    const rsz = document.createElement('div');
    rsz.className = 'overlay-resize';
    rsz.style.cssText='position:absolute;bottom:-4px;right:-4px;width:14px;height:14px;cursor:se-resize;background:var(--accent);border-radius:3px;opacity:.8;';
    // imgは自己閉じタグなのでwrapperで包む
    const wrap = document.createElement('div');
    wrap.style.cssText='position:absolute;pointer-events:auto;cursor:grab;user-select:none;';
    wrap._img = el; wrap._rsz = rsz;
    wrap.appendChild(el);
    wrap.appendChild(rsz);
    videoFrame.appendChild(wrap);
    overlayEls[key] = wrap;
    makeDraggable(wrap, ()=>state.imageOverlays[i], 'image', i);
    makeResizableImg(rsz, ()=>state.imageOverlays[i], i);
  }
  const wrap = el; // el is the wrapper div here
  const o2 = state.imageOverlays[i];
  const rect = getVideoRect();
  wrap.hidden = false;
  const imgEl = wrap._img;
  imgEl.src = o2.dataUrl;
  const w = rect.w * o2.widthPct/100;
  const h = w / (o2.aspect||1);
  imgEl.style.width  = w+'px';
  imgEl.style.height = h+'px';
  wrap.style.left  = (rect.ox + rect.w * o2.x/100) + 'px';
  wrap.style.top   = (rect.oy + rect.h * o2.y/100) + 'px';
  wrap.style.width = w+'px'; wrap.style.height=h+'px';
}

function repositionOverlays() {
  // サイズ変更時にすべてのオーバーレイの位置を再計算
  refreshOverlays();
}

const overlayRO = new ResizeObserver(()=>requestAnimationFrame(repositionOverlays));
overlayRO.observe(videoEl);
document.addEventListener('fullscreenchange',()=>requestAnimationFrame(repositionOverlays));

// ── ドラッグで移動 ────────────────────────────────────────────
function makeDraggable(el, getObj, type, idx) {
  let ox=0,oy=0,sx=0,sy=0,dragging=false;
  el.addEventListener('mousedown',e=>{
    if (e.target.classList.contains('overlay-resize')) return;
    e.stopPropagation();
    dragging=true;
    sx=e.clientX; sy=e.clientY;
    ox=parseFloat(el.style.left)||0;
    oy=parseFloat(el.style.top )||0;
    el.style.cursor='grabbing';
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const rect=getVideoRect();
    if(!rect.w)return;
    const nx=ox+(e.clientX-sx);
    const ny=oy+(e.clientY-sy);
    el.style.left=nx+'px';
    el.style.top =ny+'px';
    const o=getObj();
    o.x=clamp((nx-rect.ox)/rect.w*100,0,95);
    o.y=clamp((ny-rect.oy)/rect.h*100,0,95);
    // パネルのスライダーを同期
    if(activeTool===type){
      const xid=type==='text'?'txX':'imgX';
      const yid=type==='text'?'txY':'imgY';
      const xvid=type==='text'?'xv':'ixv';
      const yvid=type==='text'?'yv':'iyv';
      const xEl=$(xid),yEl=$(yid);
      if(xEl){xEl.value=o.x.toFixed(1);$(xvid).textContent=Math.round(o.x);}
      if(yEl){yEl.value=o.y.toFixed(1);$(yvid).textContent=Math.round(o.y);}
    }
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging)return; dragging=false; el.style.cursor='grab';
  });
}

function makeResizableText(handle, getObj, idx) {
  let startY=0,startSize=0,dragging=false;
  handle.addEventListener('mousedown',e=>{
    e.stopPropagation(); dragging=true;
    startY=e.clientY; startSize=getObj().size;
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const rect=getVideoRect();
    const delta=(e.clientY-startY)/rect.h*100;
    const o=getObj();
    o.size=clamp(startSize+delta,1.5,20);
    const sEl=$('txSz'); if(sEl){sEl.value=o.size.toFixed(1);$('sv').textContent=o.size.toFixed(1);}
    refreshOverlays();
  });
  document.addEventListener('mouseup',()=>{ dragging=false; });
}

function makeResizableImg(handle, getObj, idx) {
  let startX=0,startW=0,dragging=false;
  handle.addEventListener('mousedown',e=>{
    e.stopPropagation(); dragging=true;
    startX=e.clientX; startW=getObj().widthPct;
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const rect=getVideoRect();
    const delta=(e.clientX-startX)/rect.w*100;
    const o=getObj();
    o.widthPct=clamp(startW+delta,5,80);
    const wEl=$('imgW'); if(wEl){wEl.value=o.widthPct.toFixed(1);$('iwv').textContent=Math.round(o.widthPct);}
    refreshOverlays();
  });
  document.addEventListener('mouseup',()=>{ dragging=false; });
}

// ── 書き出し情報 ─────────────────────────────────────────────
function updateExportInfo() {
  if(!clips.length){exportInfo.innerHTML='';return;}
  let totalDur=0, totalTxt=0, totalSeg=0, totalImg=0;
  clips.forEach(c=>{
    const dur=c.state.trimEnd-c.state.trimStart;
    totalDur+=dur/(c.state.speed||1);
    totalTxt+=c.state.textOverlays.length;
    totalSeg+=c.state.speedSegments.length;
    totalImg+=c.state.imageOverlays.length;
  });
  exportInfo.innerHTML=`クリップ: <strong>${clips.length}</strong> ／ 合計: <strong>${fmt(totalDur)}</strong><br>テキスト: ${totalTxt}件 ／ 写真: ${totalImg}件 ／ 速度区間: ${totalSeg}件`;
}

// ── FFmpeg 初期化 ─────────────────────────────────────────────
async function initFFmpeg() {
  if (ffmpegReady) return;
  if (location.protocol==='file:') throw new Error(
    'file:// で開かれています。python3 -m http.server 8000 などでサーバーを起動し http://localhost:8000/ から開いてください。');
  progressEl.classList.remove('hidden');
  progressLbl.textContent = '編集エンジンを読み込み中…';
  ffmpeg = new FFmpeg();
  ffmpeg.on('progress',({progress})=>{
    if(progress>=0&&progress<=1)
      progressLbl.textContent=`書き出し中… ${Math.round(progress*100)}%`;
  });
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL('vendor/core/ffmpeg-core.js',  'text/javascript'),
      wasmURL: await toBlobURL('vendor/core/ffmpeg-core.wasm','application/wasm'),
    });
  } catch(err) {
    progressEl.classList.add('hidden');
    throw new Error('FFmpegの読み込みに失敗しました: '+err.message);
  }
  ffmpegReady=true;
  progressEl.classList.add('hidden');
}

// ── 書き出し ─────────────────────────────────────────────────
exportBtn.addEventListener('click', async () => {
  if (!clips.length) return;
  exportBtn.disabled=true;
  exportInfo.querySelectorAll('.dl-link,.export-error').forEach(e=>e.remove());
  try {
    await initFFmpeg();
    progressEl.classList.remove('hidden');
    const processed=[];
    for(let i=0;i<clips.length;i++){
      const clip=clips[i];
      progressLbl.textContent=`クリップ ${i+1}/${clips.length} を処理中…`;
      const ext=(clip.file.name.split('.').pop()||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase()||'mp4';
      const inName=`ci${i}.${ext}`, outName=`co${i}.mp4`;
      await ffmpeg.writeFile(inName, await fetchFile(clip.file));
      // 追加入力（画像オーバーレイ）を書き込む
      for(let j=0;j<clip.state.imageOverlays.length;j++){
        const o=clip.state.imageOverlays[j];
        if(o.file) await ffmpeg.writeFile(`img_${i}_${j}.png`, await fetchFile(o.file));
      }
      const args=buildArgs(clip, inName, outName, i);
      const ret=await ffmpeg.exec(args);
      if(ret!==0) throw new Error(`クリップ ${i+1} のエンコードに失敗 (exit ${ret})`);
      processed.push(outName);
      try{await ffmpeg.deleteFile(inName);}catch(e){}
    }
    let finalOut;
    if(processed.length===1){
      finalOut=processed[0];
    } else {
      progressLbl.textContent='クリップを結合中…';
      finalOut='final.mp4';
      await ffmpeg.writeFile('clist.txt', processed.map(n=>`file '${n}'`).join('\n'));
      const ret=await ffmpeg.exec(['-f','concat','-safe','0','-i','clist.txt','-c','copy',finalOut]);
      if(ret!==0) throw new Error('クリップの結合に失敗しました');
    }
    progressLbl.textContent='ファイルを準備中…';
    const data=await ffmpeg.readFile(finalOut);
    if(!data?.length) throw new Error('書き出しファイルが空です。トリミング範囲などを確認してください。');
    const blob=new Blob([data],{type:'video/mp4'});
    const url=URL.createObjectURL(blob);
    const fname='cutroom_'+Date.now()+'.mp4';
    // 自動ダウンロード
    const a=document.createElement('a');
    a.href=url; a.download=fname;
    a.style.display='none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // 手動リンク
    const link=document.createElement('a');
    link.href=url; link.download=fname; link.className='dl-link';
    link.textContent='✅ 書き出し完了 — ダウンロードが始まらない場合はこちら';
    exportInfo.appendChild(link);
    // 後片付け
    processed.forEach(n=>{if(n!==finalOut)try{ffmpeg.deleteFile(n);}catch(e){}});
    try{ffmpeg.deleteFile('clist.txt');}catch(e){}
    progressEl.classList.add('hidden');
  } catch(err) {
    progressEl.classList.add('hidden');
    const div=document.createElement('div');
    div.className='export-error';
    div.textContent='書き出しエラー: '+err.message;
    exportInfo.appendChild(div);
    console.error(err);
  } finally { exportBtn.disabled=false; }
});

function buildArgs(clip, inName, outName, clipIdx) {
  const s=clip.state;
  const dur=s.trimEnd-s.trimStart;
  const args=['-i',inName];

  // 画像オーバーレイ用の追加入力
  const imgInputIdxMap={};
  let inputIdx=1;
  s.imageOverlays.forEach((o,j)=>{
    if(o.file){ args.push('-i',`img_${clipIdx}_${j}.png`); imgInputIdxMap[j]=inputIdx++; }
  });

  args.push('-ss',s.trimStart.toFixed(3),'-t',dur.toFixed(3));

  // 映像フィルター
  const vf=[];
  if(s.brightness!==0||s.contrast!==1||s.saturation!==1)
    vf.push(`eq=brightness=${s.brightness.toFixed(3)}:contrast=${s.contrast.toFixed(3)}:saturation=${s.saturation.toFixed(3)}`);
  if(s.rotation===90)  vf.push('transpose=1');
  else if(s.rotation===180) vf.push('transpose=1,transpose=1');
  else if(s.rotation===270) vf.push('transpose=2');

  s.textOverlays.forEach(o=>{
    const yExpr=`h*${(o.y/100).toFixed(4)}`;
    const xExpr=`w*${(o.x/100).toFixed(4)}`;
    const esc2=o.text.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:');
    const ts=Math.max(0,o.start-s.trimStart).toFixed(2);
    const te=Math.max(0,o.end  -s.trimStart).toFixed(2);
    const fontsize=`h*${(o.size/100).toFixed(4)}`;
    const color=o.color.startsWith('#') ? o.color.replace('#','0x') : o.color;
    vf.push(`drawtext=text='${esc2}':fontcolor=${color}:fontsize=${fontsize}:x=${xExpr}:y=${yExpr}:enable='between(t,${ts},${te})'`);
  });

  // 速度区間
  const segs=buildSpeedTimeline(s.speedSegments,s.speed,dur);
  const af=[];
  if(s.volume!==1) af.push(`volume=${s.volume.toFixed(2)}`);

  // 画像オーバーレイ があれば filter_complex を使う
  const hasImgs=Object.keys(imgInputIdxMap).length>0;
  const hasSegs=segs.length>0;

  if(!hasImgs && !hasSegs){
    if(s.speed!==1){ vf.push(`setpts=${(1/s.speed).toFixed(4)}*PTS`); af.push(...atempo(s.speed)); }
    if(vf.length) args.push('-vf',vf.join(','));
    if(af.length) args.push('-af',af.join(','));
  } else {
    // filter_complex
    const chains=[];
    const baseVF=vf.length ? vf.join(',')+',' : '';
    chains.push(`[0:v]${baseVF}null[vb]`);
    const baseAF=af.length ? af.join(',')+',' : '';
    chains.push(`[0:a]${baseAF}anull[ab]`);

    // 画像オーバーレイを順番に適用
    let curVLabel='vb';
    s.imageOverlays.forEach((o,j)=>{
      const ii=imgInputIdxMap[j]; if(ii===undefined) return;
      const pw=`iw*${Math.max(.05,o.widthPct/100).toFixed(4)}*main_w/iw`; // scale2ref ではなく main_w 参照
      // 簡略化: scale filter で固定率スケール（main_w参照はoverlay後のフレームに使えないため直接比率で計算）
      const wExpr=`${(o.widthPct/100).toFixed(4)}*main_w`;
      const xExpr=`${(o.x/100).toFixed(4)}*main_w`;
      const yExpr=`${(o.y/100).toFixed(4)}*main_h`;
      const ts=Math.max(0,o.start-s.trimStart).toFixed(2);
      const te=Math.max(0,o.end  -s.trimStart).toFixed(2);
      const nextLabel=`vi${j}`;
      // scale2ref で main_w に対するスケール
      chains.push(`[${ii}:v][${curVLabel}]scale2ref=w=oh*mdar:h=ih*${(o.widthPct/100).toFixed(4)}[si${j}][${curVLabel}_ref]`);
      chains.push(`[${curVLabel}_ref][si${j}]overlay=x=${xExpr}:y=${yExpr}:enable='between(t,${ts},${te})'[${nextLabel}]`);
      curVLabel=nextLabel;
    });

    if(!hasSegs){
      if(s.speed!==1){
        chains.push(`[${curVLabel}]setpts=${(1/s.speed).toFixed(4)}*PTS[vout]`);
        chains.push(`[ab]${atempo(s.speed).join(',')}[aout]`);
        args.push('-filter_complex',chains.join(';'),'-map','[vout]','-map','[aout]');
      } else {
        args.push('-filter_complex',chains.join(';'),'-map',`[${curVLabel}]`,'-map','[ab]');
      }
    } else {
      // 速度区間あり → セグメント分割concat
      const vLabels=[], aLabels=[];
      segs.forEach((seg,idx)=>{
        const a=seg.start.toFixed(3), b=seg.end.toFixed(3), sp=seg.speed;
        chains.push(`[${curVLabel}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,setpts=${(1/sp).toFixed(4)}*PTS[vs${idx}]`);
        chains.push(`[ab]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,${atempo(sp).join(',')}[as${idx}]`);
        vLabels.push(`[vs${idx}]`); aLabels.push(`[as${idx}]`);
      });
      const n=segs.length;
      chains.push(`${vLabels.join('')}${aLabels.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);
      args.push('-filter_complex',chains.join(';'),'-map','[vout]','-map','[aout]');
    }
  }

  args.push('-r','30','-pix_fmt','yuv420p','-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-ar','48000',outName);
  return args;
}

function buildSpeedTimeline(rawSegs,baseSpeed,dur){
  if(!rawSegs?.length||dur<=0) return [];
  const valid=rawSegs
    .map(s=>({start:clamp(s.start,0,dur),end:clamp(s.end,0,dur),speed:clamp(s.speed,.1,8)}))
    .filter(s=>s.end>s.start).sort((a,b)=>a.start-b.start);
  if(!valid.length) return [];
  const merged=[];
  for(const seg of valid){
    if(merged.length&&seg.start<merged[merged.length-1].end)
      merged[merged.length-1].end=Math.min(merged[merged.length-1].end,seg.start);
    if(!merged.length||merged[merged.length-1].end<=merged[merged.length-1].start)
      {if(merged.length)merged.pop(); merged.push({...seg});}
    else merged.push({...seg});
  }
  const full=[]; let cursor=0; const EPS=.001;
  for(const seg of merged){
    if(seg.start-cursor>EPS) full.push({start:cursor,end:seg.start,speed:baseSpeed||1});
    full.push(seg); cursor=seg.end;
  }
  if(dur-cursor>EPS) full.push({start:cursor,end:dur,speed:baseSpeed||1});
  return full;
}

function atempo(speed){
  const f=[]; let r=speed;
  while(r>2.0){f.push('atempo=2.0');r/=2;}
  while(r<0.5){f.push('atempo=0.5');r/=.5;}
  f.push(`atempo=${r.toFixed(3)}`);
  return f;
}

function speedAt(t){
  for(let i=state.speedSegments.length-1;i>=0;i--){
    const s=state.speedSegments[i];
    if(t>=s.start&&t<s.end) return s.speed;
  }
  return state.speed;
}

// ── ユーティリティ ────────────────────────────────────────────
function fmt(sec){
  if(!isFinite(sec)) return '00:00.0';
  const m=Math.floor(sec/60), s=sec%60;
  return `${String(m).padStart(2,'0')}:${s.toFixed(1).padStart(4,'0')}`;
}
function parseFmt(str){
  str=str.trim();
  const p=str.split(':');
  if(p.length===2){ const m=+p[0],s=+p[1]; return (!isNaN(m)&&!isNaN(s))?m*60+s:null; }
  const s=+p[0]; return isNaN(s)?null:s;
}
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toHex(color){
  if(!color) return '#ffffff';
  if(/^#[0-9a-fA-F]{6}$/.test(color.trim())) return color.trim();
  try{
    const c=document.createElement('canvas').getContext('2d');
    c.fillStyle='#000'; c.fillStyle=color;
    if(/^#[0-9a-fA-F]{6}$/.test(c.fillStyle)) return c.fillStyle;
  }catch(e){}
  return '#ffffff';
}
function fileToDataUrl(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result);
    r.onerror=rej; r.readAsDataURL(file);
  });
}
function getAspect(dataUrl){
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>res(img.naturalWidth/(img.naturalHeight||1));
    img.onerror=()=>res(1);
    img.src=dataUrl;
  });
}
