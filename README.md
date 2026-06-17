# moviess
// ===========================================
// カットルーム — ブラウザ動画編集ツール
// ===========================================

const { FFmpeg } = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

let ffmpeg = null;
let ffmpegLoaded = false;

// ---------- クリップ管理 ----------
// 各クリップ: { id, file, url, duration, thumbnails: [dataURL], state: {...} }
let clips = [];
let activeClipIndex = -1;
let videoDuration = 0; // 現在表示中クリップの長さ
let videoEl = document.getElementById("previewVideo");

// テキスト色のプリセット（色名はCSS/FFmpeg drawtextの両方で共通利用可能）
const COLOR_PRESETS = [
  { label: "白", value: "white" },
  { label: "黒", value: "black" },
  { label: "黄", value: "yellow" },
  { label: "赤", value: "red" },
  { label: "オレンジ", value: "orange" },
  { label: "緑", value: "lime" },
  { label: "シアン", value: "cyan" },
  { label: "青", value: "blue" },
  { label: "マゼンタ", value: "magenta" },
  { label: "ピンク", value: "pink" },
  { label: "紫", value: "purple" },
  { label: "グレー", value: "gray" },
];

// 色名/16進数文字列を <input type="color"> 用の #rrggbb に変換
function toHexColor(value) {
  if (!value) return "#ffffff";
  value = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return "#" + value.slice(1).split("").map(c => c + c).join("");
  }
  // 色名はCanvasで一旦描画してRGBに変換する
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillStyle = value;
    const computed = ctx.fillStyle; // ブラウザが #rrggbb 形式に正規化して返す
    if (/^#[0-9a-fA-F]{6}$/.test(computed)) return computed;
  } catch (e) {}
  return "#ffffff";
}

function createDefaultState() {
  return {
    trimStart: 0,
    trimEnd: 0,
    speed: 1,        // 既定速度（区間指定がない部分に適用）
    speedSegments: [], // {start, end, speed} クリップ内の一部のみ速度を変える区間
    brightness: 0,   // -1 ~ 1
    contrast: 1,     // 0 ~ 2
    saturation: 1,   // 0 ~ 3
    volume: 1,       // 0 ~ 2
    rotation: 0,     // 0/90/180/270
    // x, y: 動画に対する左上座標(%) / size: 動画の高さに対するフォントサイズ(%)
    textOverlays: [], // {text, start, end, size, color, x, y}
    // 話者の写真などの画像オーバーレイ
    // x, y: 動画に対する左上座標(%) / widthPct: 動画の幅に対する画像幅(%)
    imageOverlays: [] // {name, dataUrl, file, start, end, x, y, widthPct, aspect}
  };
}

// 現在編集中のクリップのstateを指す（互換のためグローバル名 state を維持）
let state = createDefaultState();

let activeTool = null;
let isDraggingHandle = null; // 'left' | 'right' | null
let isPlaying = false;
let draggedClipIndex = null; // クリップ並べ替え用

// タイムライン上で選択中のマーカー（編集対象）
// { type: 'text' | 'speed', index: number } または null
let selectedMarker = null;

// ---------- DOM参照 ----------
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const addClipInput = document.getElementById("addClipInput");
const emptyState = document.getElementById("emptyState");
const videoFrame = document.getElementById("videoFrame");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const toolButtons = document.querySelectorAll(".tool-btn");
const toolOptions = document.getElementById("toolOptions");
const exportBtn = document.getElementById("exportBtn");
const newFileBtn = document.getElementById("newFileBtn");
const progressOverlay = document.getElementById("progressOverlay");
const progressLabel = document.getElementById("progressLabel");
const exportInfo = document.getElementById("exportInfo");
const clipStrip = document.getElementById("clipStrip");

const timelineTrack = document.getElementById("timelineTrack");
const thumbStrip = document.getElementById("thumbStrip");
const trimRegion = document.getElementById("trimRegion");
const handleLeft = document.getElementById("handleLeft");
const handleRight = document.getElementById("handleRight");
const playhead = document.getElementById("playhead");
const ruler = document.getElementById("ruler");
const playBtn = document.getElementById("playBtn");
const curTimeEl = document.getElementById("curTime");
const totalTimeEl = document.getElementById("totalTime");

// ---------- ファイル読み込み ----------
dropZone.addEventListener("click", () => fileInput.click());
newFileBtn.addEventListener("click", resetProject);

["dragover", "dragenter"].forEach(evt =>
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach(evt =>
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  })
);
dropZone.addEventListener("drop", e => {
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("video/"));
  if (files.length) addClips(files, true);
});
fileInput.addEventListener("change", e => {
  const files = [...e.target.files];
  if (files.length) addClips(files, true);
  fileInput.value = "";
});
addClipInput.addEventListener("change", e => {
  const files = [...e.target.files];
  if (files.length) addClips(files, false);
  addClipInput.value = "";
});

function resetProject() {
  clips = [];
  activeClipIndex = -1;
  selectedMarker = null;
  pendingRange = null;
  videoFrame.hidden = true;
  videoEl.removeAttribute("src");
  emptyState.hidden = false;
  exportBtn.disabled = true;
  toolButtons.forEach(b => (b.disabled = true));
  activeTool = null;
  toolOptions.innerHTML = "";
  toolButtons.forEach(b => b.classList.remove("active"));
  clipStrip.innerHTML = "";
  exportInfo.innerHTML = "";
}

// files: FileList/Array, isFirstLoad: 最初の読み込みかどうか
async function addClips(files, isFirstLoad) {
  if (isFirstLoad) {
    clips = [];
    emptyState.hidden = true;
    videoFrame.hidden = false;
    exportBtn.disabled = false;
    toolButtons.forEach(b => (b.disabled = false));
  }

  for (const file of files) {
    const clip = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
      file,
      url: URL.createObjectURL(file),
      duration: 0,
      thumbnails: [],
      state: createDefaultState()
    };
    clips.push(clip);
    await loadClipMetadata(clip);
    renderClipStrip();
  }

  if (activeClipIndex === -1 && clips.length) {
    selectClip(0);
  } else {
    renderClipStrip();
  }
}

function loadClipMetadata(clip) {
  return new Promise(resolve => {
    const tmp = document.createElement("video");
    tmp.src = clip.url;
    tmp.muted = true;
    tmp.addEventListener("loadedmetadata", async () => {
      clip.duration = tmp.duration;
      clip.state.trimStart = 0;
      clip.state.trimEnd = tmp.duration;
      await generateClipThumbnails(clip, tmp);
      resolve();
    }, { once: true });
  });
}

async function generateClipThumbnails(clip, tmpVideo) {
  const count = 6;
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < count; i++) {
    const t = (clip.duration / count) * i;
    await new Promise(res => {
      const onSeek = () => {
        ctx.drawImage(tmpVideo, 0, 0, canvas.width, canvas.height);
        clip.thumbnails.push(canvas.toDataURL("image/jpeg", 0.5));
        tmpVideo.removeEventListener("seeked", onSeek);
        res();
      };
      tmpVideo.addEventListener("seeked", onSeek);
      tmpVideo.currentTime = t;
    });
  }
}

// ---------- クリップ選択 / 切り替え ----------
function selectClip(index) {
  if (index < 0 || index >= clips.length) return;
  activeClipIndex = index;
  const clip = clips[index];
  state = clip.state;
  videoDuration = clip.duration;
  selectedMarker = null;
  pendingRange = null;

  videoEl.src = clip.url;
  videoEl.playbackRate = getSpeedAtTime(0);
  videoEl.volume = Math.min(state.volume, 1);
  videoEl.style.transform = `rotate(${state.rotation}deg)`;
  videoEl.style.filter = `brightness(${1 + state.brightness}) contrast(${state.contrast}) saturate(${state.saturation})`;

  videoEl.addEventListener("loadedmetadata", () => {
    totalTimeEl.textContent = formatTime(videoDuration);
    buildRuler();
    updateTrimRegion();
    renderThumbStrip(clip);
    renderClipStrip();
    if (activeTool) renderToolOptions(activeTool);
  }, { once: true });
}

function renderThumbStrip(clip) {
  thumbStrip.innerHTML = "";
  clip.thumbnails.forEach(src => {
    const img = document.createElement("img");
    img.src = src;
    thumbStrip.appendChild(img);
  });
}

// ---------- クリップストリップUI ----------
function renderClipStrip() {
  clipStrip.innerHTML = "";

  clips.forEach((clip, i) => {
    const item = document.createElement("div");
    item.className = "clip-item" + (i === activeClipIndex ? " active" : "");
    item.draggable = true;
    item.dataset.index = i;

    const img = document.createElement("img");
    img.src = clip.thumbnails[0] || "";
    item.appendChild(img);

    const num = document.createElement("div");
    num.className = "clip-num";
    num.textContent = i + 1;
    item.appendChild(num);

    const removeBtn = document.createElement("button");
    removeBtn.className = "clip-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "このクリップを削除";
    removeBtn.addEventListener("click", e => {
      e.stopPropagation();
      removeClip(i);
    });
    item.appendChild(removeBtn);

    const label = document.createElement("div");
    label.className = "clip-label";
    const dur = clip.state.trimEnd - clip.state.trimStart;
    label.innerHTML = `<span>${formatTime(dur)}</span>`;
    item.appendChild(label);

    item.addEventListener("click", () => selectClip(i));

    // ドラッグ&ドロップで並べ替え
    item.addEventListener("dragstart", () => {
      draggedClipIndex = i;
      item.style.opacity = "0.5";
    });
    item.addEventListener("dragend", () => {
      item.style.opacity = "1";
      draggedClipIndex = null;
      clipStrip.querySelectorAll(".clip-item").forEach(el => el.classList.remove("drag-over-target"));
    });
    item.addEventListener("dragover", e => {
      e.preventDefault();
      if (draggedClipIndex !== null && draggedClipIndex !== i) {
        item.classList.add("drag-over-target");
      }
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over-target"));
    item.addEventListener("drop", e => {
      e.preventDefault();
      item.classList.remove("drag-over-target");
      if (draggedClipIndex === null || draggedClipIndex === i) return;
      reorderClips(draggedClipIndex, i);
    });

    clipStrip.appendChild(item);
  });

  // クリップ追加ボタン
  const addBtn = document.createElement("button");
  addBtn.className = "clip-add";
  addBtn.innerHTML = `<span class="ic">＋</span>クリップを追加`;
  addBtn.addEventListener("click", () => addClipInput.click());
  clipStrip.appendChild(addBtn);
}

function reorderClips(from, to) {
  const [moved] = clips.splice(from, 1);
  clips.splice(to, 0, moved);
  if (activeClipIndex === from) {
    activeClipIndex = to;
  } else if (activeClipIndex > from && activeClipIndex <= to) {
    activeClipIndex--;
  } else if (activeClipIndex < from && activeClipIndex >= to) {
    activeClipIndex++;
  }
  renderClipStrip();
  updateExportInfo();
}

function removeClip(index) {
  clips.splice(index, 1);
  if (!clips.length) {
    resetProject();
    return;
  }
  if (activeClipIndex >= clips.length) activeClipIndex = clips.length - 1;
  if (activeClipIndex === index) {
    selectClip(Math.min(index, clips.length - 1));
  } else {
    if (index < activeClipIndex) activeClipIndex--;
    renderClipStrip();
    updateExportInfo();
  }
}

// ---------- 再生制御 ----------
playBtn.addEventListener("click", () => {
  if (videoEl.paused) {
    if (videoEl.currentTime < state.trimStart || videoEl.currentTime >= state.trimEnd) {
      videoEl.currentTime = state.trimStart;
    }
    videoEl.playbackRate = getSpeedAtTime(videoEl.currentTime);
    videoEl.play();
  } else {
    videoEl.pause();
  }
});

videoEl.addEventListener("play", () => { isPlaying = true; playBtn.textContent = "❙❙"; });
videoEl.addEventListener("pause", () => { isPlaying = false; playBtn.textContent = "▶"; });

videoEl.addEventListener("timeupdate", () => {
  curTimeEl.textContent = formatTime(videoEl.currentTime);
  updatePlayhead();
  // トリム範囲外に出たら停止/ループ
  if (videoEl.currentTime >= state.trimEnd) {
    videoEl.pause();
    videoEl.currentTime = state.trimStart;
  }
  applyTextOverlayPreview();
});

// 0.1秒単位の微調整シーク（字幕や速度区間の位置決めを正確に行うため）
const stepBackBtn = document.getElementById("stepBack");
const stepForwardBtn = document.getElementById("stepForward");

stepBackBtn?.addEventListener("click", () => {
  if (!videoDuration) return;
  videoEl.pause();
  videoEl.currentTime = Math.max(0, videoEl.currentTime - 0.1);
  curTimeEl.textContent = formatTime(videoEl.currentTime);
  updatePlayhead();
  applyTextOverlayPreview();
});
stepForwardBtn?.addEventListener("click", () => {
  if (!videoDuration) return;
  videoEl.pause();
  videoEl.currentTime = Math.min(videoDuration, videoEl.currentTime + 0.1);
  curTimeEl.textContent = formatTime(videoEl.currentTime);
  updatePlayhead();
  applyTextOverlayPreview();
});

function formatTime(sec) {
  if (!isFinite(sec)) return "00:00.0";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

// "M:SS.s" "SS.s" "S" などを秒数(小数)に変換
function parseTimeInput(str) {
  str = str.trim();
  const parts = str.split(":");
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
    return null;
  }
  const s = Number(parts[0]);
  return isNaN(s) ? null : s;
}

// ---------- タイムライン: ルーラー ----------
function buildRuler() {
  ruler.innerHTML = "";
  const step = videoDuration > 60 ? 10 : 5;
  for (let t = 0; t <= videoDuration; t += step) {
    const pct = (t / videoDuration) * 100;
    const span = document.createElement("span");
    span.style.left = pct + "%";
    span.textContent = formatTime(t);
    ruler.appendChild(span);
  }
}

// ---------- タイムライン: トリム範囲 ----------
function updateTrimRegion() {
  const startPct = (state.trimStart / videoDuration) * 100;
  const endPct = (state.trimEnd / videoDuration) * 100;
  trimRegion.style.left = startPct + "%";
  trimRegion.style.width = (endPct - startPct) + "%";
  renderMarkers();
  updateExportInfo();
  renderClipStrip();
}

function updatePlayhead() {
  const pct = (videoEl.currentTime / videoDuration) * 100;
  playhead.style.left = pct + "%";
}

[handleLeft, handleRight].forEach(handle => {
  handle.addEventListener("mousedown", e => {
    isDraggingHandle = handle === handleLeft ? "left" : "right";
    e.stopPropagation();
  });
});

document.addEventListener("mousemove", e => {
  if (!isDraggingHandle || !videoDuration) return;
  const rect = timelineTrack.getBoundingClientRect();
  let pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  const time = pct * videoDuration;

  if (isDraggingHandle === "left") {
    state.trimStart = Math.min(time, state.trimEnd - 0.2);
    state.trimStart = Math.max(0, state.trimStart);
  } else {
    state.trimEnd = Math.max(time, state.trimStart + 0.2);
    state.trimEnd = Math.min(videoDuration, state.trimEnd);
  }
  updateTrimRegion();
  videoEl.currentTime = isDraggingHandle === "left" ? state.trimStart : state.trimEnd;
});

document.addEventListener("mouseup", () => { isDraggingHandle = null; });

// ---------- タイムラインのドラッグ範囲選択（字幕の開始/終了をそのまま指定） ----------
const rangeSelectEl = document.getElementById("rangeSelect");
let isSelectingRange = false;
let rangeSelectStartX = 0;
let rangeSelectStartTime = 0;
// ドラッグで選択した範囲。テキストツールを開くとこの範囲が新規字幕の初期値になる。
let pendingRange = null;
const DRAG_THRESHOLD_PX = 4; // これ未満の移動は「クリック」として扱う

timelineTrack.addEventListener("mousedown", e => {
  // トリムハンドルやマーカーのクリックは個別に処理されるためここでは無視
  if (e.target.closest(".trim-handle") || e.target.closest(".marker")) return;
  if (!videoDuration) return;
  isSelectingRange = true;
  rangeSelectStartX = e.clientX;
  const rect = timelineTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  rangeSelectStartTime = pct * videoDuration;
});

document.addEventListener("mousemove", e => {
  if (!isSelectingRange || !videoDuration) return;
  const rect = timelineTrack.getBoundingClientRect();
  const movedPx = Math.abs(e.clientX - rangeSelectStartX);
  if (movedPx < DRAG_THRESHOLD_PX) {
    rangeSelectEl.hidden = true;
    return;
  }
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const curTime = pct * videoDuration;
  const lo = Math.min(rangeSelectStartTime, curTime);
  const hi = Math.max(rangeSelectStartTime, curTime);
  const loPct = (lo / videoDuration) * 100;
  const hiPct = (hi / videoDuration) * 100;
  rangeSelectEl.style.left = loPct + "%";
  rangeSelectEl.style.width = (hiPct - loPct) + "%";
  rangeSelectEl.hidden = false;
});

document.addEventListener("mouseup", e => {
  if (!isSelectingRange) return;
  isSelectingRange = false;

  const rect = timelineTrack.getBoundingClientRect();
  const movedPx = Math.abs(e.clientX - rangeSelectStartX);
  rangeSelectEl.hidden = true;

  if (movedPx < DRAG_THRESHOLD_PX) {
    // クリックとみなしてシーク
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoEl.currentTime = Math.max(0, Math.min(videoDuration, pct * videoDuration));
    return;
  }

  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const curTime = pct * videoDuration;
  const lo = Math.max(0, Math.min(rangeSelectStartTime, curTime));
  const hi = Math.min(videoDuration, Math.max(rangeSelectStartTime, curTime));
  if (hi - lo < 0.05) return;

  pendingRange = { start: lo, end: hi };

  // テキストツールが開いていれば即座にその範囲を新規字幕の開始/終了に反映
  if (activeTool === "text") {
    selectedMarker = null; // 新規追加モードにする
    renderToolOptions("text");
  } else {
    // テキストツールを自動で開き、選択範囲を初期値にする
    activeTool = "text";
    selectedMarker = null;
    toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === "text"));
    renderToolOptions("text");
  }
  renderMarkers();
});

// ---------- 編集ツールの切り替え ----------
toolButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const tool = btn.dataset.tool;
    if (activeTool === tool) {
      activeTool = null;
      toolButtons.forEach(b => b.classList.remove("active"));
      toolOptions.innerHTML = "";
      if (selectedMarker) {
        selectedMarker = null;
        renderMarkers();
      }
      return;
    }
    activeTool = tool;
    selectedMarker = null;
    toolButtons.forEach(b => b.classList.toggle("active", b === btn));
    renderToolOptions(tool);
    renderMarkers();
  });
});

function renderToolOptions(tool) {
  const html = {
    trim: trimOptionsHTML,
    text: textOptionsHTML,
    speed: speedOptionsHTML,
    adjust: adjustOptionsHTML,
    volume: volumeOptionsHTML,
    rotate: rotateOptionsHTML
  }[tool];
  toolOptions.innerHTML = html();
  bindToolOptionEvents(tool);
}

// --- トリミング ---
function trimOptionsHTML() {
  return `
    <h3>トリミング範囲（このクリップ）</h3>
    <div class="field-row">
      <div class="field">
        <label>開始</label>
        <input type="text" id="trimStartInput" value="${formatTime(state.trimStart)}">
      </div>
      <div class="field">
        <label>終了</label>
        <input type="text" id="trimEndInput" value="${formatTime(state.trimEnd)}">
      </div>
    </div>
    <p class="hint">タイムライン上のハンドルをドラッグして範囲を調整することもできます。書き出し時、このクリップはこの範囲だけが使用され、すべてのクリップが順番に連結されます。</p>
  `;
}

function bindTrimEvents() {
  document.getElementById("trimStartInput")?.addEventListener("change", e => {
    const t = parseTimeInput(e.target.value);
    if (t !== null && t < state.trimEnd) {
      state.trimStart = t;
      updateTrimRegion();
    }
  });
  document.getElementById("trimEndInput")?.addEventListener("change", e => {
    const t = parseTimeInput(e.target.value);
    if (t !== null && t > state.trimStart) {
      state.trimEnd = Math.min(t, videoDuration);
      updateTrimRegion();
    }
  });
}

// --- テキスト挿入 ---
function textOptionsHTML() {
  const editing = selectedMarker && selectedMarker.type === "text" ? state.textOverlays[selectedMarker.index] : null;

  const list = state.textOverlays.map((o, i) => `
    <div class="overlay-chip ${selectedMarker && selectedMarker.type === "text" && selectedMarker.index === i ? "active" : ""}" data-select-text="${i}" style="cursor:pointer;">
      <span>"${escapeHtml(o.text)}" (${formatTime(o.start)}–${formatTime(o.end)})</span>
      <button data-remove-text="${i}">✕</button>
    </div>
  `).join("");

  const banner = editing
    ? `<div class="edit-mode-banner"><span>テキストを編集中（動画上でドラッグして移動・端をドラッグでサイズ変更できます）</span><button id="cancelTextEdit">キャンセル</button></div>`
    : (pendingRange
        ? `<div class="edit-mode-banner"><span>タイムラインで選択した範囲 (${formatTime(pendingRange.start)}–${formatTime(pendingRange.end)}) を使用します</span><button id="clearPendingRange">クリア</button></div>`
        : "");

  const v = editing || (pendingRange
    ? {
        text: "",
        start: pendingRange.start,
        end: pendingRange.end,
        size: 6,
        color: "#ffffff",
        x: 10,
        y: 80
      }
    : {
        text: "",
        start: videoEl.currentTime,
        end: Math.min(videoEl.currentTime + 3, videoDuration),
        size: 6,
        color: "#ffffff",
        x: 10,
        y: 80
      });

  return `
    <h3>テキスト（このクリップ）</h3>
    <div class="text-overlay-list">${list || '<p class="hint">まだテキストはありません</p>'}</div>
    ${banner}
    <div class="field">
      <label>テキスト内容</label>
      <input type="text" id="newTextInput" placeholder="例: こんにちは！" value="${escapeHtml(v.text)}">
    </div>
    <div class="field-row">
      <div class="field">
        <label>開始</label>
        <div class="field-with-btn">
          <input type="text" id="newTextStart" value="${formatTime(v.start)}">
          <button type="button" class="mini-btn" id="setTextStartNow">現在位置</button>
        </div>
      </div>
      <div class="field">
        <label>終了</label>
        <div class="field-with-btn">
          <input type="text" id="newTextEnd" value="${formatTime(v.end)}">
          <button type="button" class="mini-btn" id="setTextEndNow">現在位置</button>
        </div>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>色（色名や#16進数で指定可）</label>
        <div class="field-with-btn">
          <input type="text" id="newTextColor" value="${escapeHtml(v.color)}" placeholder="例: white, yellow, #ff0000">
          <input type="color" id="newTextColorPicker" value="${toHexColor(v.color)}" title="カラーピッカーで選ぶ">
        </div>
      </div>
    </div>
    <div class="color-palette" id="textColorPalette">
      ${COLOR_PRESETS.map(c => `<button type="button" class="color-swatch" data-color="${c.value}" style="background:${c.value};" title="${c.label}"></button>`).join("")}
    </div>
    <div class="field-row">
      <div class="field">
        <label>横位置 X% <span class="value-pill" id="textXVal">${Math.round(v.x)}</span></label>
        <input type="range" id="newTextX" min="0" max="100" step="0.5" value="${v.x}">
      </div>
      <div class="field">
        <label>縦位置 Y% <span class="value-pill" id="textYVal">${Math.round(v.y)}</span></label>
        <input type="range" id="newTextY" min="0" max="100" step="0.5" value="${v.y}">
      </div>
    </div>
    <div class="field">
      <label>文字サイズ（動画の高さに対する%） <span class="value-pill" id="textSizeVal">${v.size.toFixed(1)}</span></label>
      <input type="range" id="newTextSize" min="2" max="20" step="0.2" value="${v.size}">
    </div>
    ${editing
      ? `<div class="btn-row">
           <button class="btn btn-primary" id="addTextBtn">更新する</button>
           <button class="btn btn-danger" id="deleteTextBtn">削除</button>
         </div>`
      : `<button class="btn btn-primary btn-block" id="addTextBtn">テキストを追加</button>`
    }
    <p class="hint">秒は小数(0.1秒単位)で指定できます。「現在位置」ボタンで再生中の位置をそのまま入力できます。位置・サイズは動画プレビュー上のテキストを直接ドラッグ（移動）・端をドラッグ（拡大縮小）しても変更できます。タイムラインの緑色のマーカーをクリックすると、そのテキストを選んで編集・削除できます。</p>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bindTextEvents() {
  const editingIndex = selectedMarker && selectedMarker.type === "text" ? selectedMarker.index : null;

  document.getElementById("newTextSize")?.addEventListener("input", e => {
    document.getElementById("textSizeVal").textContent = e.target.value;
  });

  // X/Y/サイズ スライダー: ドラッグ中も即座にプレビューへ反映（編集中アイテムがあれば直接更新）
  const xRange = document.getElementById("newTextX");
  const yRange = document.getElementById("newTextY");
  const sizeRange = document.getElementById("newTextSize");

  xRange?.addEventListener("input", e => {
    document.getElementById("textXVal").textContent = Math.round(parseFloat(e.target.value));
    if (editingIndex !== null) {
      state.textOverlays[editingIndex].x = parseFloat(e.target.value);
      refreshLivePreview();
    }
  });
  yRange?.addEventListener("input", e => {
    document.getElementById("textYVal").textContent = Math.round(parseFloat(e.target.value));
    if (editingIndex !== null) {
      state.textOverlays[editingIndex].y = parseFloat(e.target.value);
      refreshLivePreview();
    }
  });
  sizeRange?.addEventListener("input", e => {
    document.getElementById("textSizeVal").textContent = parseFloat(e.target.value).toFixed(1);
    if (editingIndex !== null) {
      state.textOverlays[editingIndex].size = parseFloat(e.target.value);
      refreshLivePreview();
    }
  });

  document.getElementById("setTextStartNow")?.addEventListener("click", () => {
    document.getElementById("newTextStart").value = formatTime(videoEl.currentTime);
  });
  document.getElementById("setTextEndNow")?.addEventListener("click", () => {
    document.getElementById("newTextEnd").value = formatTime(videoEl.currentTime);
  });

  // 色: テキスト入力⇄カラーピッカー⇄パレットの同期
  const colorInput = document.getElementById("newTextColor");
  const colorPicker = document.getElementById("newTextColorPicker");
  const applyColorLive = (val) => {
    if (editingIndex !== null) {
      state.textOverlays[editingIndex].color = val;
      refreshLivePreview();
    }
  };
  colorInput?.addEventListener("change", () => {
    colorPicker.value = toHexColor(colorInput.value);
    applyColorLive(colorInput.value);
  });
  colorPicker?.addEventListener("input", () => {
    colorInput.value = colorPicker.value;
    applyColorLive(colorPicker.value);
  });
  document.querySelectorAll("#textColorPalette [data-color]").forEach(btn => {
    btn.addEventListener("click", () => {
      colorInput.value = btn.dataset.color;
      colorPicker.value = toHexColor(btn.dataset.color);
      applyColorLive(btn.dataset.color);
    });
  });

  document.getElementById("addTextBtn")?.addEventListener("click", () => {
    const text = document.getElementById("newTextInput").value.trim();
    if (!text) return;
    const start = parseTimeInput(document.getElementById("newTextStart").value) ?? 0;
    const end = parseTimeInput(document.getElementById("newTextEnd").value) ?? videoDuration;
    const size = parseFloat(document.getElementById("newTextSize").value);
    const color = document.getElementById("newTextColor").value || "#ffffff";
    const x = parseFloat(document.getElementById("newTextX").value);
    const y = parseFloat(document.getElementById("newTextY").value);
    const item = {
      text,
      start: Math.max(0, Math.min(start, videoDuration)),
      end: Math.max(end, start + 0.1, 0.1),
      size, color, x, y
    };
    item.end = Math.min(item.end, videoDuration);

    if (editingIndex !== null) {
      state.textOverlays[editingIndex] = item;
      selectedMarker = null;
    } else {
      state.textOverlays.push(item);
    }
    pendingRange = null;
    renderToolOptions("text");
    renderMarkers();
    refreshLivePreview();
  });

  document.getElementById("clearPendingRange")?.addEventListener("click", () => {
    pendingRange = null;
    renderToolOptions("text");
  });

  document.getElementById("deleteTextBtn")?.addEventListener("click", () => {
    if (editingIndex === null) return;
    state.textOverlays.splice(editingIndex, 1);
    selectedMarker = null;
    renderToolOptions("text");
    renderMarkers();
  });

  document.getElementById("cancelTextEdit")?.addEventListener("click", () => {
    selectedMarker = null;
    renderToolOptions("text");
    renderMarkers();
  });

  document.querySelectorAll("[data-select-text]").forEach(chip => {
    chip.addEventListener("click", e => {
      if (e.target.closest("[data-remove-text]")) return;
      const idx = parseInt(chip.dataset.selectText);
      selectedMarker = { type: "text", index: idx };
      renderToolOptions("text");
      renderMarkers();
    });
  });

  document.querySelectorAll("[data-remove-text]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.removeText);
      state.textOverlays.splice(idx, 1);
      if (selectedMarker && selectedMarker.type === "text" && selectedMarker.index === idx) {
        selectedMarker = null;
      }
      renderToolOptions("text");
      renderMarkers();
    });
  });
}

// --- 速度 ---
function speedOptionsHTML() {
  const editing = selectedMarker && selectedMarker.type === "speed" ? state.speedSegments[selectedMarker.index] : null;

  const list = state.speedSegments.map((seg, i) => `
    <div class="overlay-chip ${selectedMarker && selectedMarker.type === "speed" && selectedMarker.index === i ? "active" : ""}" data-select-speed="${i}" style="cursor:pointer;">
      <span>${formatTime(seg.start)}–${formatTime(seg.end)} : ${seg.speed.toFixed(2)}x</span>
      <button data-remove-speed="${i}">✕</button>
    </div>
  `).join("");

  const banner = editing
    ? `<div class="edit-mode-banner"><span>速度区間を編集中（タイムラインの紫マーカーから選択）</span><button id="cancelSpeedEdit">キャンセル</button></div>`
    : "";

  const v = editing || {
    start: videoEl.currentTime,
    end: Math.min(videoEl.currentTime + 2, videoDuration),
    speed: 0.5
  };

  return `
    <h3>再生速度（このクリップ）</h3>
    <div class="field">
      <label>基本速度（区間指定がない部分） <span class="value-pill" id="speedVal">${state.speed.toFixed(2)}x</span></label>
      <input type="range" id="speedRange" min="0.25" max="3" step="0.05" value="${state.speed}">
    </div>
    <p class="hint">0.25x（超スロー）〜 3x（早送り）。プレビューにも反映されます。</p>

    <h3>一部だけ速度を変える</h3>
    <div class="text-overlay-list">${list || '<p class="hint">区間指定はまだありません</p>'}</div>
    ${banner}
    <div class="field-row">
      <div class="field">
        <label>開始</label>
        <div class="field-with-btn">
          <input type="text" id="newSpeedStart" value="${formatTime(v.start)}">
          <button type="button" class="mini-btn" id="setSpeedStartNow">現在位置</button>
        </div>
      </div>
      <div class="field">
        <label>終了</label>
        <div class="field-with-btn">
          <input type="text" id="newSpeedEnd" value="${formatTime(v.end)}">
          <button type="button" class="mini-btn" id="setSpeedEndNow">現在位置</button>
        </div>
      </div>
    </div>
    <div class="field">
      <label>この区間の速度 <span class="value-pill" id="segSpeedVal">${v.speed.toFixed(2)}x</span></label>
      <input type="range" id="newSpeedRange" min="0.1" max="4" step="0.05" value="${v.speed}">
    </div>
    ${editing
      ? `<div class="btn-row">
           <button class="btn btn-primary" id="addSpeedBtn">更新する</button>
           <button class="btn btn-danger" id="deleteSpeedBtn">削除</button>
         </div>`
      : `<button class="btn btn-primary btn-block" id="addSpeedBtn">速度区間を追加</button>`
    }
    <p class="hint">例: 全体を1.0xのまま、指定した区間だけ0.3xにしてスローモーションにできます。タイムラインの紫色のマーカーをクリックすると編集・削除できます。区間が重なる場合、後から追加したものが優先されます。</p>
  `;
}

function bindSpeedEvents() {
  const range = document.getElementById("speedRange");
  range?.addEventListener("input", e => {
    state.speed = parseFloat(e.target.value);
    document.getElementById("speedVal").textContent = state.speed.toFixed(2) + "x";
    if (!state.speedSegments.length) {
      videoEl.playbackRate = state.speed;
    }
    updateExportInfo();
  });

  const segRange = document.getElementById("newSpeedRange");
  segRange?.addEventListener("input", e => {
    document.getElementById("segSpeedVal").textContent = parseFloat(e.target.value).toFixed(2) + "x";
  });

  const editingIndex = selectedMarker && selectedMarker.type === "speed" ? selectedMarker.index : null;

  document.getElementById("setSpeedStartNow")?.addEventListener("click", () => {
    document.getElementById("newSpeedStart").value = formatTime(videoEl.currentTime);
  });
  document.getElementById("setSpeedEndNow")?.addEventListener("click", () => {
    document.getElementById("newSpeedEnd").value = formatTime(videoEl.currentTime);
  });

  document.getElementById("addSpeedBtn")?.addEventListener("click", () => {
    const start = parseTimeInput(document.getElementById("newSpeedStart").value) ?? 0;
    const end = parseTimeInput(document.getElementById("newSpeedEnd").value) ?? videoDuration;
    const speed = parseFloat(document.getElementById("newSpeedRange").value);
    const seg = {
      start: Math.max(0, Math.min(start, videoDuration)),
      end: Math.min(Math.max(end, start + 0.1, 0.1), videoDuration),
      speed
    };
    if (editingIndex !== null) {
      state.speedSegments[editingIndex] = seg;
      selectedMarker = null;
    } else {
      state.speedSegments.push(seg);
    }
    state.speedSegments.sort((a, b) => a.start - b.start);
    renderToolOptions("speed");
    renderMarkers();
    updateExportInfo();
  });

  document.getElementById("deleteSpeedBtn")?.addEventListener("click", () => {
    if (editingIndex === null) return;
    state.speedSegments.splice(editingIndex, 1);
    selectedMarker = null;
    renderToolOptions("speed");
    renderMarkers();
    updateExportInfo();
  });

  document.getElementById("cancelSpeedEdit")?.addEventListener("click", () => {
    selectedMarker = null;
    renderToolOptions("speed");
    renderMarkers();
  });

  document.querySelectorAll("[data-select-speed]").forEach(chip => {
    chip.addEventListener("click", e => {
      if (e.target.closest("[data-remove-speed]")) return;
      const idx = parseInt(chip.dataset.selectSpeed);
      selectedMarker = { type: "speed", index: idx };
      renderToolOptions("speed");
      renderMarkers();
    });
  });

  document.querySelectorAll("[data-remove-speed]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.removeSpeed);
      state.speedSegments.splice(idx, 1);
      if (selectedMarker && selectedMarker.type === "speed" && selectedMarker.index === idx) {
        selectedMarker = null;
      }
      renderToolOptions("speed");
      renderMarkers();
      updateExportInfo();
    });
  });
}

// --- 色調整 ---
function adjustOptionsHTML() {
  return `
    <h3>色調整（このクリップ）</h3>
    <div class="field">
      <label>明るさ <span class="value-pill" id="brightVal">${state.brightness.toFixed(2)}</span></label>
      <input type="range" id="brightRange" min="-1" max="1" step="0.05" value="${state.brightness}">
    </div>
    <div class="field">
      <label>コントラスト <span class="value-pill" id="contrastVal">${state.contrast.toFixed(2)}</span></label>
      <input type="range" id="contrastRange" min="0" max="2" step="0.05" value="${state.contrast}">
    </div>
    <div class="field">
      <label>彩度 <span class="value-pill" id="satVal">${state.saturation.toFixed(2)}</span></label>
      <input type="range" id="satRange" min="0" max="3" step="0.05" value="${state.saturation}">
    </div>
    <p class="hint">プレビューはCSSフィルターで簡易表示しています。書き出し時にはFFmpegで実際の映像に適用されます。</p>
  `;
}

function bindAdjustEvents() {
  const updatePreviewFilter = () => {
    const b = 1 + state.brightness; // CSS brightness 1=普通
    videoEl.style.filter =
      `brightness(${b}) contrast(${state.contrast}) saturate(${state.saturation})`;
  };
  document.getElementById("brightRange")?.addEventListener("input", e => {
    state.brightness = parseFloat(e.target.value);
    document.getElementById("brightVal").textContent = state.brightness.toFixed(2);
    updatePreviewFilter();
  });
  document.getElementById("contrastRange")?.addEventListener("input", e => {
    state.contrast = parseFloat(e.target.value);
    document.getElementById("contrastVal").textContent = state.contrast.toFixed(2);
    updatePreviewFilter();
  });
  document.getElementById("satRange")?.addEventListener("input", e => {
    state.saturation = parseFloat(e.target.value);
    document.getElementById("satVal").textContent = state.saturation.toFixed(2);
    updatePreviewFilter();
  });
}

// --- 音量 ---
function volumeOptionsHTML() {
  return `
    <h3>音量（このクリップ）</h3>
    <div class="field">
      <label>音量 <span class="value-pill" id="volVal">${Math.round(state.volume * 100)}%</span></label>
      <input type="range" id="volRange" min="0" max="2" step="0.05" value="${state.volume}">
    </div>
    <p class="hint">0%でミュート、100%が元の音量、200%まで増幅できます。</p>
  `;
}

function bindVolumeEvents() {
  document.getElementById("volRange")?.addEventListener("input", e => {
    state.volume = parseFloat(e.target.value);
    document.getElementById("volVal").textContent = Math.round(state.volume * 100) + "%";
    videoEl.volume = Math.min(state.volume, 1);
  });
}

// --- 回転 ---
function rotateOptionsHTML() {
  return `
    <h3>回転（このクリップ）</h3>
    <div class="tool-grid">
      <button class="tool-btn ${state.rotation === 0 ? "active" : ""}" data-rotate="0">0°</button>
      <button class="tool-btn ${state.rotation === 90 ? "active" : ""}" data-rotate="90">90°</button>
      <button class="tool-btn ${state.rotation === 180 ? "active" : ""}" data-rotate="180">180°</button>
      <button class="tool-btn ${state.rotation === 270 ? "active" : ""}" data-rotate="270">270°</button>
    </div>
  `;
}

function bindRotateEvents() {
  document.querySelectorAll("[data-rotate]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.rotation = parseInt(btn.dataset.rotate);
      videoEl.style.transform = `rotate(${state.rotation}deg)`;
      renderToolOptions("rotate");
      updateExportInfo();
    });
  });
}

function bindToolOptionEvents(tool) {
  ({
    trim: bindTrimEvents,
    text: bindTextEvents,
    speed: bindSpeedEvents,
    adjust: bindAdjustEvents,
    volume: bindVolumeEvents,
    rotate: bindRotateEvents
  })[tool]?.();
}

// ---------- マーカー（テキスト区間・速度区間） ----------
function renderMarkers() {
  // 既存マーカー削除
  timelineTrack.querySelectorAll(".marker").forEach(m => m.remove());

  state.textOverlays.forEach((o, i) => {
    const startPct = (o.start / videoDuration) * 100;
    const widthPct = Math.max(((o.end - o.start) / videoDuration) * 100, 0.5);
    const marker = document.createElement("div");
    marker.className = "marker marker-text";
    if (selectedMarker && selectedMarker.type === "text" && selectedMarker.index === i) {
      marker.classList.add("marker-selected");
    }
    marker.style.left = startPct + "%";
    marker.style.width = widthPct + "%";
    marker.textContent = "🔤 " + o.text;
    marker.title = `クリックして編集: "${o.text}" (${formatTime(o.start)}–${formatTime(o.end)})`;
    marker.addEventListener("click", e => {
      e.stopPropagation();
      selectedMarker = { type: "text", index: i };
      if (activeTool !== "text") {
        activeTool = "text";
        toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === "text"));
      }
      renderToolOptions("text");
      renderMarkers();
    });
    timelineTrack.appendChild(marker);
  });

  state.speedSegments.forEach((seg, i) => {
    const startPct = (seg.start / videoDuration) * 100;
    const widthPct = Math.max(((seg.end - seg.start) / videoDuration) * 100, 0.5);
    const marker = document.createElement("div");
    marker.className = "marker marker-speed";
    if (selectedMarker && selectedMarker.type === "speed" && selectedMarker.index === i) {
      marker.classList.add("marker-selected");
    }
    marker.style.left = startPct + "%";
    marker.style.width = widthPct + "%";
    marker.textContent = `⏩ ${seg.speed.toFixed(2)}x`;
    marker.title = `クリックして編集: ${seg.speed.toFixed(2)}x (${formatTime(seg.start)}–${formatTime(seg.end)})`;
    marker.addEventListener("click", e => {
      e.stopPropagation();
      selectedMarker = { type: "speed", index: i };
      if (activeTool !== "speed") {
        activeTool = "speed";
        toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === "speed"));
      }
      renderToolOptions("speed");
      renderMarkers();
    });
    timelineTrack.appendChild(marker);
  });
}

// 現在のプレビュー再生時刻に応じた速度を返す（区間指定があれば優先、なければ基本速度）
function getSpeedAtTime(t) {
  for (let i = state.speedSegments.length - 1; i >= 0; i--) {
    const seg = state.speedSegments[i];
    if (t >= seg.start && t < seg.end) return seg.speed;
  }
  return state.speed;
}

// ---------- テキストのプレビュー表示（実際の動画サイズ・位置に追従） ----------
let previewTextEl = null;

function updatePreviewOverlayGeometry() {
  if (!previewTextEl || !videoEl.videoWidth) return;
  const vRect = videoEl.getBoundingClientRect();
  const fRect = videoFrame.getBoundingClientRect();
  if (!vRect.width || !fRect.width) return;

  // videoFrame内での動画の表示位置・サイズ（フルスクリーン時も追従）
  const left = vRect.left - fRect.left;
  const top = vRect.top - fRect.top;
  previewTextEl.style.left = left + "px";
  previewTextEl.style.top = top + "px";
  previewTextEl.style.width = vRect.width + "px";
  previewTextEl.style.height = vRect.height + "px";

  // フォントサイズは動画の実サイズに対する比率でスケーリング
  previewTextEl.dataset.scale = vRect.width / videoEl.videoWidth;
}

function applyTextOverlayPreview() {
  // 速度区間に応じてプレビューの再生速度を更新
  const expectedRate = getSpeedAtTime(videoEl.currentTime);
  if (Math.abs(videoEl.playbackRate - expectedRate) > 0.001) {
    videoEl.playbackRate = expectedRate;
  }

  const active = state.textOverlays.find(o => videoEl.currentTime >= o.start && videoEl.currentTime <= o.end);
  if (!previewTextEl) {
    previewTextEl = document.createElement("div");
    previewTextEl.style.position = "absolute";
    previewTextEl.style.display = "flex";
    previewTextEl.style.justifyContent = "center";
    previewTextEl.style.fontWeight = "700";
    previewTextEl.style.textShadow = "0 2px 6px rgba(0,0,0,0.6)";
    previewTextEl.style.pointerEvents = "none";
    previewTextEl.style.fontFamily = "sans-serif";

    const textInner = document.createElement("span");
    textInner.style.padding = "0 4%";
    textInner.style.textAlign = "center";
    previewTextEl.appendChild(textInner);
    previewTextEl._inner = textInner;

    videoFrame.appendChild(previewTextEl);
  }

  updatePreviewOverlayGeometry();
  const scale = parseFloat(previewTextEl.dataset.scale || "1");

  if (active) {
    const inner = previewTextEl._inner;
    inner.textContent = active.text;
    inner.style.color = active.color;
    inner.style.fontSize = Math.max(8, active.size * scale) + "px";

    if (active.pos === "top") {
      previewTextEl.style.alignItems = "flex-start";
      previewTextEl.style.paddingTop = "4%";
    } else if (active.pos === "center") {
      previewTextEl.style.alignItems = "center";
      previewTextEl.style.paddingTop = "0";
    } else {
      previewTextEl.style.alignItems = "flex-end";
      previewTextEl.style.paddingBottom = "4%";
    }
    previewTextEl.style.display = "flex";
  } else {
    previewTextEl.style.display = "none";
  }
}

// 動画サイズ変更時（拡大表示・ウィンドウリサイズ・全画面切替）にオーバーレイ位置を再計算
const overlayResizeObserver = new ResizeObserver(() => {
  updatePreviewOverlayGeometry();
});
overlayResizeObserver.observe(videoEl);
overlayResizeObserver.observe(videoFrame);
document.addEventListener("fullscreenchange", () => {
  requestAnimationFrame(updatePreviewOverlayGeometry);
});

// ---------- 全画面表示切替 ----------
fullscreenBtn?.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoFrame.requestFullscreen?.();
  }
});

// ---------- 書き出し情報表示 ----------
// クリップの出力後の長さ（速度区間を考慮）を計算
function computeOutputDuration(c) {
  const s = c.state;
  const dur = s.trimEnd - s.trimStart;
  if (!s.speedSegments.length) {
    return dur / (s.speed || 1);
  }
  // セグメントでカバーされている時間と、それぞれの出力時間を計算
  let coveredInput = 0;
  let coveredOutput = 0;
  for (const seg of s.speedSegments) {
    const a = Math.max(0, Math.min(seg.start, dur));
    const b = Math.max(0, Math.min(seg.end, dur));
    if (b <= a) continue;
    coveredInput += (b - a);
    coveredOutput += (b - a) / (seg.speed || 1);
  }
  const remainingInput = Math.max(0, dur - coveredInput);
  const remainingOutput = remainingInput / (s.speed || 1);
  return coveredOutput + remainingOutput;
}

function updateExportInfo() {
  if (!clips.length) {
    exportInfo.innerHTML = "";
    return;
  }
  let totalDuration = 0;
  let totalTextCount = 0;
  let totalSpeedSegs = 0;
  clips.forEach(c => {
    totalDuration += computeOutputDuration(c);
    totalTextCount += c.state.textOverlays.length;
    totalSpeedSegs += c.state.speedSegments.length;
  });
  exportInfo.innerHTML = `
    クリップ数: <strong>${clips.length}</strong><br>
    合計出力時間: <strong>${formatTime(totalDuration)}</strong><br>
    テキスト: ${totalTextCount}件 ／ 速度区間: ${totalSpeedSegs}件
  `;
}

// ---------- FFmpeg 初期化 ----------
async function initFFmpeg() {
  if (ffmpegLoaded) return;
  progressOverlay.classList.remove("hidden");
  progressLabel.textContent = "編集エンジンを読み込み中…";

  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    // デバッグ用: 進捗ラベルにffmpegの最終行を反映（エラー時の手がかりになる）
    if (message) progressLabel.dataset.lastLog = message;
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (progress >= 0 && progress <= 1) {
      progressLabel.textContent = `書き出し中… ${Math.round(progress * 100)}%`;
    }
  });

  const baseURL = "vendor/core";
  try {
    if (location.protocol === "file:") {
      throw new Error(
        "このページが file:// で開かれています。動画の書き出し処理（FFmpeg）はブラウザの制限により file:// から実行できません。" +
        "プロジェクトのフォルダで `python3 -m http.server 8000` などローカルサーバーを起動し、http://localhost:8000/ からアクセスしてください。"
      );
    }
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
  } catch (err) {
    progressOverlay.classList.add("hidden");
    throw new Error("編集エンジン(FFmpeg)の読み込みに失敗しました。" + err.message);
  }
  ffmpegLoaded = true;
  progressOverlay.classList.add("hidden");
}

// ---------- 書き出し処理 ----------
exportBtn.addEventListener("click", async () => {
  if (!clips.length) return;
  exportBtn.disabled = true;

  // 前回の結果表示をクリア
  exportInfo.querySelectorAll(".download-link, .export-error").forEach(el => el.remove());

  try {
    await initFFmpeg();
    progressOverlay.classList.remove("hidden");

    // 各クリップを個別に処理して中間ファイルを生成
    const processedNames = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      progressLabel.textContent = `クリップ ${i + 1}/${clips.length} を処理中…`;

      const ext = (clip.file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
      const inputName = `clip_in_${i}.${ext}`;
      const outputName = `clip_out_${i}.mp4`;

      await ffmpeg.writeFile(inputName, await fetchFile(clip.file));

      const args = buildClipFFmpegArgs(clip, inputName, outputName);
      const ret = await ffmpeg.exec(args);
      if (ret !== 0) {
        throw new Error(`クリップ ${i + 1} の処理に失敗しました（FFmpeg終了コード: ${ret}）。`);
      }

      processedNames.push(outputName);
      try { await ffmpeg.deleteFile(inputName); } catch (e) {}
    }

    let finalOutputName;

    if (processedNames.length === 1) {
      // クリップが1つだけならそのまま最終出力として使用
      finalOutputName = processedNames[0];
    } else {
      // concatリストを作成して結合
      progressLabel.textContent = "クリップを結合中…";
      finalOutputName = "final_output.mp4";
      const listContent = processedNames.map(n => `file '${n}'`).join("\n");
      await ffmpeg.writeFile("concat_list.txt", listContent);

      const ret = await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", "concat_list.txt",
        "-c", "copy",
        finalOutputName
      ]);
      if (ret !== 0) {
        throw new Error(`クリップの結合に失敗しました（FFmpeg終了コード: ${ret}）。`);
      }
    }

    progressLabel.textContent = "ファイルを準備中…";
    const data = await ffmpeg.readFile(finalOutputName);
    if (!data || !data.length) {
      throw new Error("書き出しファイルが空でした。動画の長さやトリミング範囲を確認してください。");
    }
    const blob = new Blob([data], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);

    progressOverlay.classList.add("hidden");

    // ダウンロードを実行（DOMに追加してclickすることでブラウザの保存ダイアログを確実に発火させる）
    const filename = "edited_video_" + new Date().toISOString().replace(/[:.]/g, "-") + ".mp4";
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 手動でも再ダウンロードできるようにリンクを表示
    const manualLink = document.createElement("a");
    manualLink.href = url;
    manualLink.download = filename;
    manualLink.textContent = "✅ 書き出し完了 — 自動でダウンロードが始まらない場合はここをクリック";
    manualLink.className = "download-link";
    exportInfo.appendChild(manualLink);

    // 後片付け（最終出力ファイルは手動リンクのため削除しない）
    for (const n of processedNames) {
      if (n === finalOutputName) continue;
      try { await ffmpeg.deleteFile(n); } catch (e) {}
    }
    if (processedNames.length > 1) {
      try { await ffmpeg.deleteFile("concat_list.txt"); } catch (e) {}
    }
  } catch (err) {
    progressOverlay.classList.add("hidden");
    const errEl = document.createElement("div");
    errEl.className = "export-error hint";
    errEl.style.color = "#ff6b6b";
    errEl.textContent = "書き出しエラー: " + err.message;
    exportInfo.appendChild(errEl);
    console.error(err);
  } finally {
    exportBtn.disabled = false;
  }
});

// 単一クリップに対するFFmpeg引数を構築（トリム・フィルター・テキスト・部分速度変更等）
function buildClipFFmpegArgs(clip, inputName, outputName) {
  const s = clip.state;
  const args = ["-i", inputName];

  // トリミング（このクリップの使用範囲のみを切り出す）
  const duration = s.trimEnd - s.trimStart;
  args.push("-ss", s.trimStart.toFixed(3));
  args.push("-t", duration.toFixed(3));

  // ---- 基本映像フィルター（drawtext含む。speed変更前の「実時間」基準で適用） ----
  const baseVideoFilters = [];

  // 色調整 (eq filter)
  if (s.brightness !== 0 || s.contrast !== 1 || s.saturation !== 1) {
    baseVideoFilters.push(
      `eq=brightness=${s.brightness.toFixed(3)}:contrast=${s.contrast.toFixed(3)}:saturation=${s.saturation.toFixed(3)}`
    );
  }

  // 回転
  if (s.rotation === 90) baseVideoFilters.push("transpose=1");
  else if (s.rotation === 180) baseVideoFilters.push("transpose=1,transpose=1");
  else if (s.rotation === 270) baseVideoFilters.push("transpose=2");

  // テキストオーバーレイ (drawtext) — トリム後の時刻（0始まり）を基準に有効区間を指定
  s.textOverlays.forEach(o => {
    const yExpr = { top: "h*0.08", center: "(h-text_h)/2", bottom: "h-h*0.08-text_h" }[o.pos] || "h-h*0.08-text_h";
    const escapedText = o.text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
    const start = Math.max(0, o.start - s.trimStart);
    const end = Math.max(start + 0.01, o.end - s.trimStart);
    baseVideoFilters.push(
      `drawtext=text='${escapedText}':fontcolor=${o.color.replace("#", "0x")}:fontsize=${o.size}:x=(w-text_w)/2:y=${yExpr}:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`
    );
  });

  // ---- 音声フィルター（速度変更前） ----
  const baseAudioFilters = [];
  if (s.volume !== 1) {
    baseAudioFilters.push(`volume=${s.volume.toFixed(2)}`);
  }

  // 速度区間を正規化（重複解消・ギャップを基本速度で充填し、0〜durationを完全カバーするリストに変換）
  const segments = buildFullSpeedTimeline(s.speedSegments, s.speed, duration);

  let filterComplex = null;
  let mapV = null;
  let mapA = null;

  if (!segments.length) {
    // ---- 単純ケース: 区間指定なし、全体を基本速度で処理 ----
    const vf = [...baseVideoFilters];
    const af = [...baseAudioFilters];
    if (s.speed !== 1) {
      vf.push(`setpts=${(1 / s.speed).toFixed(4)}*PTS`);
      af.push(...buildAtempoChain(s.speed));
    }
    if (vf.length) args.push("-vf", vf.join(","));
    if (af.length) args.push("-af", af.join(","));
  } else {
    // ---- 部分速度変更ケース: filter_complexでセグメント毎に分割し、concatで再結合 ----
    const chains = [];

    // ベースとなる映像/音声チェーン
    const vBaseLabel = "vbase";
    const aBaseLabel = "abase";
    chains.push(`[0:v]${(baseVideoFilters.length ? baseVideoFilters.join(",") + "," : "")}null[${vBaseLabel}]`);
    chains.push(`[0:a]${(baseAudioFilters.length ? baseAudioFilters.join(",") + "," : "")}anull[${aBaseLabel}]`);

    const vLabels = [];
    const aLabels = [];

    segments.forEach((seg, idx) => {
      const vLabel = `v${idx}`;
      const aLabel = `a${idx}`;
      const a = seg.start.toFixed(3);
      const b = seg.end.toFixed(3);
      const speed = seg.speed;

      // 映像: トリム→PTSリセット→速度変更
      chains.push(
        `[${vBaseLabel}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,setpts=${(1 / speed).toFixed(4)}*PTS[${vLabel}]`
      );

      // 音声: トリム→PTSリセット→atempoチェーン
      const atempo = buildAtempoChain(speed).join(",");
      chains.push(
        `[${aBaseLabel}]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,${atempo}[${aLabel}]`
      );

      vLabels.push(`[${vLabel}]`);
      aLabels.push(`[${aLabel}]`);
    });

    // concatで全セグメントを結合
    const n = segments.length;
    const concatInputs = vLabels.map((v, i) => v + aLabels[i]).join("");
    chains.push(`${concatInputs}concat=n=${n}:v=1:a=1[outv][outa]`);

    filterComplex = chains.join(";");
    mapV = "[outv]";
    mapA = "[outa]";

    args.push("-filter_complex", filterComplex);
    args.push("-map", mapV, "-map", mapA);
  }

  // 出力フォーマットを統一（concatでの結合を安定させるため）
  args.push("-r", "30");
  args.push("-pix_fmt", "yuv420p");
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
  args.push("-c:a", "aac", "-ar", "48000");
  args.push(outputName);

  return args;
}

// 速度区間をクリップのトリム後タイムライン(0〜duration)に正規化し、
// 重複を解消した上で、指定のない部分を基本速度(baseSpeed)で充填した
// 「0〜durationを完全カバーする区間リスト」を返す。
// 戻り値が空配列の場合は「区間指定なし＝単純ケース」を意味する。
function buildFullSpeedTimeline(rawSegments, baseSpeed, duration) {
  if (!rawSegments || !rawSegments.length || duration <= 0) return [];

  // 有効な区間のみ抽出し、0〜durationにクランプ
  const valid = rawSegments
    .map(seg => ({
      start: Math.max(0, Math.min(seg.start, duration)),
      end: Math.max(0, Math.min(seg.end, duration)),
      speed: Math.max(0.1, Math.min(seg.speed || 1, 8))
    }))
    .filter(seg => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);

  if (!valid.length) return [];

  // 重複区間の解消: 開始位置が早いものを優先し、重複部分は前の区間を切り詰める
  const merged = [];
  for (const seg of valid) {
    if (merged.length && seg.start < merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.min(merged[merged.length - 1].end, seg.start);
      if (merged[merged.length - 1].end <= merged[merged.length - 1].start) {
        merged.pop();
      }
    }
    merged.push({ ...seg });
  }

  if (!merged.length) return [];

  // ギャップを基本速度で充填し、0〜durationを完全カバーするリストを構築
  const full = [];
  let cursor = 0;
  const EPS = 0.001;
  for (const seg of merged) {
    if (seg.start - cursor > EPS) {
      full.push({ start: cursor, end: seg.start, speed: baseSpeed || 1 });
    }
    full.push(seg);
    cursor = seg.end;
  }
  if (duration - cursor > EPS) {
    full.push({ start: cursor, end: duration, speed: baseSpeed || 1 });
  }

  return full;
}

// atempoは0.5〜2.0の範囲のみ対応のため連結
function buildAtempoChain(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) { filters.push("atempo=2.0"); remaining /= 2.0; }
  while (remaining < 0.5) { filters.push("atempo=0.5"); remaining /= 0.5; }
  filters.push(`atempo=${remaining.toFixed(3)}`);
  return filters;
}
