"use strict";
const $ = (s) => document.querySelector(s);
const stage = $("#stage");

// ---------- 저장소 ----------
const LS = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
const DEF = {
  eventName: "REACTION GP",
  bgmUrl: "",
  rounds: 3,
  random: false,
  bgm: true,
  waitMin: 1000,
  waitMax: 4000,
  sfxVol: 0.7,
  bgmVol: 0.5,
  topN: 10,
};
// 공개 모드(GitHub Pages): 관리자 화면 없이 기본 설정으로 바로 플레이, 순위는 online.js(Firestore). ?public 으로 로컬에서도 확인 가능
const PUBLIC =
  location.hostname.endsWith("github.io") ||
  new URLSearchParams(location.search).has("public");
let settings = PUBLIC ? { ...DEF } : { ...DEF, ...LS.get("rx.settings", {}) };
let session = PUBLIC
  ? { startedAt: Date.now(), rounds: DEF.rounds, records: [] }
  : LS.get("rx.session", null); // { startedAt, rounds, records: [{name,total,avg,times,ts,random}] }
let archive = LS.get("rx.archive", []); // 지난 대회들
const save = () => {
  LS.set("rx.settings", settings);
  LS.set("rx.session", session);
  LS.set("rx.archive", archive);
};

const ranked = (recs) =>
  [...recs].sort((a, b) => a.total - b.total || a.ts - b.ts);
const FALSE_MS = 1000,
  TIMEOUT_MS = 3000;

// ---------- 온라인 순위 (공개 모드에서 online.js가 연결되면 채워짐) ----------
let online = null,
  onlineCount = 0;
async function onlineRefresh() {
  ({ records: session.records, count: onlineCount } = await online.top());
  if (screen === "attract") toAttract();
}

// ---------- 오디오 (Web Audio 칩튠) ----------
let ac, sfxOut, bgmOut;
function actx() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    sfxOut = ac.createGain();
    bgmOut = ac.createGain();
    sfxOut.connect(ac.destination);
    bgmOut.connect(ac.destination);
  }
  if (ac.state === "suspended") ac.resume();
  sfxOut.gain.value = settings.sfxVol;
  bgmOut.gain.value = settings.bgmVol * 0.4;
  return ac;
}
function tone(
  f,
  dur,
  type = "square",
  vol = 0.3,
  when = 0,
  slide,
  out = sfxOut,
) {
  const a = actx(),
    t = a.currentTime + when,
    o = a.createOscillator(),
    g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}
let noiseBuf;
function noise(dur, vol = 0.3, when = 0, freq = 1500, out = sfxOut) {
  const a = actx(),
    t = a.currentTime + when;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = a.createBufferSource(),
    f = a.createBiquadFilter(),
    g = a.createGain();
  s.buffer = noiseBuf;
  f.type = "bandpass";
  f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t);
  s.stop(t + dur + 0.02);
}
const sfx = {
  beep: () => tone(440, 0.18, "square", 0.25),
  hit() {
    noise(0.1, 0.8, 0, 3000);
    tone(520, 0.12, "square", 0.3, 0, 1400);
    tone(1400, 0.15, "square", 0.2, 0.09);
  },
  fail() {
    tone(150, 0.5, "sawtooth", 0.45, 0, 60);
    noise(0.3, 0.6, 0, 400);
  },
  applause() {
    [523, 659, 784, 1047].forEach((f, i) =>
      tone(f, i === 3 ? 0.6 : 0.15, "square", 0.25, i * 0.13),
    );
    for (let i = 0; i < 90; i++)
      noise(
        0.04 + Math.random() * 0.05,
        0.15 + Math.random() * 0.35,
        0.3 + Math.random() * 2.8,
        1500 + Math.random() * 2500,
      );
  },
  sad() {
    [392, 370, 349, 330].forEach((f, i) =>
      tone(
        f,
        i === 3 ? 1.1 : 0.4,
        "sawtooth",
        0.25,
        i * 0.45,
        i === 3 ? 300 : 0,
      ),
    );
  },
};

// BGM 우선순위: 관리자 YouTube 링크 > 관리자 MP3 파일(IndexedDB) > 칩튠
const ytId = (u) =>
  ((u || "").match(
    /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/,
  ) || [])[1] || null;
// MP3 파일은 localStorage(약 5MB)에 안 들어가서 IndexedDB에 Blob으로 보관
function idb(mode, fn) {
  return new Promise((res, rej) => {
    const o = indexedDB.open("rx", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const tx = o.result.transaction("kv", mode),
        r = fn(tx.objectStore("kv"));
      tx.oncomplete = () => res(r.result);
      tx.onerror = () => rej(tx.error);
    };
  });
}
const mp3 = new Audio();
mp3.loop = true;
let mp3ok = false;
mp3.addEventListener("canplaythrough", () => {
  mp3ok = true;
});
mp3.addEventListener("error", () => {
  mp3ok = false;
});
function setBgmFile(blob) {
  bgmStop();
  mp3ok = false;
  if (mp3.src.startsWith("blob:")) URL.revokeObjectURL(mp3.src);
  if (blob) mp3.src = URL.createObjectURL(blob);
  else {
    mp3.removeAttribute("src");
    mp3.load();
  } // load(): 이전 파일의 늦은 canplaythrough 차단
  $("#bgmFileName").textContent = blob ? `(${blob.name || "MP3"})` : "(없음)";
}
idb("readonly", (s) => s.get("bgm")).then(
  (b) => setBgmFile(b || null),
  () => setBgmFile(null),
);

// YouTube: 공식 IFrame Player API (인터넷 필요). 링크가 있을 때만 로드
let yt = null,
  ytReady = false,
  ytCur = null,
  ytWant = false;
const ytBlocked = location.protocol === "file:"; // YouTube 플레이어는 file:// 페이지에서 재생 거부 → 다음 BGM으로 대체
function ytPrepare() {
  const id = ytBlocked ? null : ytId(settings.bgmUrl);
  if (!id) {
    ytCur = null;
    if (ytReady) yt.stopVideo();
    return;
  }
  if (id === ytCur) return;
  ytCur = id;
  if (ytReady) return yt.cueVideoById(id);
  if (window.YT && YT.Player) return makeYt();
  window.onYouTubeIframeAPIReady = makeYt;
  if (!document.querySelector('script[src*="iframe_api"]'))
    document.head.append(
      Object.assign(document.createElement("script"), {
        src: "https://www.youtube.com/iframe_api",
      }),
    );
}
function makeYt() {
  if (yt) return;
  yt = new YT.Player("yt", {
    videoId: ytCur,
    playerVars: { controls: 0, playsinline: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (ytCur) yt.cueVideoById(ytCur);
        if (ytWant) bgmStart();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && ytWant) {
          yt.seekTo(0);
          yt.playVideo();
        }
      }, // 반복 재생
    },
  });
}

let bgmTimer = null,
  bgmStep = 0; // 게임 사이에도 BGM 재생 위치 유지
function bgmStart() {
  bgmStop();
  if (!settings.bgm) return;
  if (ytCur) {
    ytWant = true;
    if (ytReady) {
      yt.setVolume(Math.round(settings.bgmVol * 100));
      yt.playVideo();
    }
    return;
  }
  if (mp3ok) {
    mp3.volume = settings.bgmVol;
    mp3.play().catch(() => {});
    return;
  }
  const a = actx(),
    spb = 60 / 150 / 4,
    TR = [0, 5, 3, -2],
    ARP = [0, 7, 12, 7, 15, 12, 7, 12];
  const midi = (n) => 440 * 2 ** ((n - 69) / 12);
  let next = a.currentTime + 0.05;
  bgmTimer = setInterval(() => {
    while (next < a.currentTime + 0.25) {
      const s = bgmStep % 16,
        tr = TR[Math.floor(bgmStep / 16) % 4],
        w = next - a.currentTime;
      if (s % 2 === 0)
        tone(
          midi(33 + tr + (s % 4 ? 12 : 0)),
          spb * 1.8,
          "triangle",
          0.5,
          w,
          0,
          bgmOut,
        );
      tone(midi(69 + tr + ARP[s % 8]), spb * 0.9, "square", 0.12, w, 0, bgmOut);
      if (s % 8 === 0) tone(120, 0.12, "sine", 0.7, w, 40, bgmOut);
      if (s % 8 === 4) noise(0.1, 0.35, w, 2500, bgmOut);
      next += spb;
      bgmStep++;
    }
  }, 50);
}
function bgmStop() {
  clearInterval(bgmTimer);
  bgmTimer = null;
  mp3.pause();
  ytWant = false;
  if (ytReady) yt.pauseVideo();
}

// ---------- 렌더링: 레퍼런스 일러스트(assets/bg.webp, 1672x941) 위에 신호등·LED·기어만 덮어 그림 ----------
const W = 1672,
  H = 941,
  cv = $("#cv"),
  c = cv.getContext("2d");
cv.width = W;
cv.height = H;
c.imageSmoothingEnabled = false;
const LIGHTS = [628, 733, 836, 939, 1043],
  LY = 171,
  LR = 42; // 신호등 렌즈 중심 x, y, 크롭 반경
const LBOX = { x: 576, y: 97, w: 520, h: 124 },
  LSCALE = 1.3; // 신호등 묶음 영역(갠트리 바로 아래) → 위쪽 고정으로 확대
const LED = {
  x: 736,
  y: 799,
  w: 198,
  h: 21,
  edges: [757, 784, 810, 830, 843, 858, 884, 909, 934],
}; // 휠 RPM LED 9칸
const mk = (w, h) =>
  Object.assign(document.createElement("canvas"), { width: w, height: h });
const lightsCv = mk(LBOX.w, LBOX.h),
  lg = lightsCv.getContext("2d");
// 원본 픽셀을 그대로 쓰되 색만 바꿔서 꺼진 불·초록불·꺼진 LED를 만든다 → 픽셀 질감 유지
function recolor(src, x, y, w, h, fn) {
  const out = mk(w, h),
    g = out.getContext("2d");
  g.drawImage(src, x, y, w, h, 0, 0, w, h);
  const im = g.getImageData(0, 0, w, h),
    d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const p = fn(d[i], d[i + 1], d[i + 2]);
    if (p) {
      d.set(p.map(Math.round), i);
    }
  } // p: [r,g,b] 또는 [r,g,b,a]
  g.putImageData(im, 0, 0);
  return out;
}
const isRed = (r, g, b) => r > 90 && r > g * 1.6 && r > b * 1.6;
let art = null; // { base, lit[], off[], green[], ledOn, ledOff }
const bgImg = new Image();
bgImg.src = "assets/bg.webp";
bgImg
  .decode()
  .then(() => {
    const base = mk(W, H),
      g = base.getContext("2d");
    g.drawImage(bgImg, 0, 0);
    const lens = (fn) =>
      LIGHTS.map((x) =>
        recolor(
          base,
          x - LR,
          LY - LR,
          LR * 2,
          LR * 2,
          (r, gg, b) => isRed(r, gg, b) && fn(r, gg, b),
        ),
      );
    art = {
      base,
      off: lens((r, gg, b) => [r * 0.2 + 10, gg * 0.4 + 4, b * 0.4 + 6]),
      green: lens((r, gg, b) => [gg * 0.4, r, b * 0.5]), // 빨강 채널 → 초록 채널 (명암 그대로)
      ledOff: recolor(
        base,
        LED.x,
        LED.y,
        LED.w,
        LED.h,
        (r, gg, b) =>
          Math.max(r, gg, b) > 60 && [r * 0.18, gg * 0.18, b * 0.18],
      ),
      // 신호등 묶음: 하늘·구름 픽셀은 투명하게 → 확대해도 배경을 가리지 않음
      lights: recolor(
        base,
        LBOX.x,
        LBOX.y,
        LBOX.w,
        LBOX.h,
        (r, gg, b) =>
          ((b > 150 && b > r + 80) || (gg > 140 && b > 190)) && [0, 0, 0, 0],
      ),
    };
    // 원래 크기 신호등은 하늘색으로 지움 (확대본 틈새로 비치지 않게)
    for (let y = LBOX.y; y < LBOX.y + LBOX.h; y++) {
      const [r, gg, b] = g.getImageData(LBOX.x - 6, y, 1, 1).data;
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(LBOX.x, y, LBOX.w, 1);
    }
  })
  .catch(() => {});

function render(t) {
  const g = game,
    play = screen === "play" && g;
  if (art) {
    c.drawImage(art.base, 0, 0);
    // 5개 출발 신호등: 원본(빨강) / 꺼짐 / 초록
    lg.clearRect(0, 0, LBOX.w, LBOX.h);
    lg.drawImage(art.lights, 0, 0);
    LIGHTS.forEach((x, i) => {
      // 게임 중: 빨간불 → 출발 = 전부 초록. 그 외 화면: 깜빡임 없이 전부 빨강
      const dx = x - LR - LBOX.x,
        dy = LY - LR - LBOX.y;
      if (play && g.green) lg.drawImage(art.green[i], dx, dy);
      else if (play && i >= g.lit) lg.drawImage(art.off[i], dx, dy);
    });
    const lw = Math.round(LBOX.w * LSCALE);
    c.drawImage(
      lightsCv,
      Math.round(LBOX.x + LBOX.w / 2 - lw / 2),
      LBOX.y,
      lw,
      Math.round(LBOX.h * LSCALE),
    );
    // RPM LED: 켜진 칸까지만 원본, 나머지는 꺼짐 (깜빡임 없음)
    const on = play ? Math.round((g.lit * 9) / 5) : 0; // 출발 신호에 반응하지 않음 (신호등만 피드백)
    const cut = on ? LED.edges[on - 1] - LED.x : 0;
    if (cut < LED.w)
      c.drawImage(
        art.ledOff,
        cut,
        0,
        LED.w - cut,
        LED.h,
        LED.x + cut,
        LED.y,
        LED.w - cut,
        LED.h,
      );
  }
  if (play && g.pendingGreen) {
    g.pendingGreen = false;
    g.greenAt = Math.max(g.greenAt, t);
  }
  requestAnimationFrame(render);
}

// ---------- 화면 전환 ----------
let screen = "settings",
  setMode = "setup",
  game = null,
  lastSaved = null;
function show(name) {
  screen = name;
  for (const el of document.querySelectorAll(".screen"))
    el.hidden = el.id !== name;
}
function fx(cls, el = $("#flash")) {
  el.className = "";
  void el.offsetWidth;
  el.className = cls;
}
function shake(big) {
  stage.classList.remove("shake", "shake-big");
  void stage.offsetWidth;
  stage.classList.add(big ? "shake-big" : "shake");
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// ---------- 설정 / 관리자 ----------
const form = $("#form");
// file:// 에선 YouTube가 재생되지 않으므로 링크 칸을 숨김 (값은 보존해 JSON 내보내기에 그대로 포함)
if (ytBlocked)
  form.elements.bgmUrl.hidden =
    form.elements.bgmUrl.previousElementSibling.hidden = true;
function openSettings(mode) {
  if (screen === "play") abortGame();
  setMode = mode;
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  const admin = mode === "admin";
  form.elements.rounds.disabled = admin;
  if (admin) form.elements.rounds.value = session.rounds;
  $("#lockNote").textContent = admin ? "(대회 중 고정)" : "";
  $("#setTitle").textContent = admin ? "ADMIN (F1)" : "RACE SETUP";
  $("#okBtn").textContent = admin ? "저장 후 닫기 ⏎" : "대회 시작 ⏎";
  $("#adminBtns").hidden = !admin;
  $("#setHint").textContent = admin
    ? "ESC 닫기 · F11 전체화면"
    : "ENTER 대회 시작 · F11 전체화면";
  show("settings");
  form.elements.eventName.focus();
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = form.elements,
    n = (k, lo, hi) => Math.min(hi, Math.max(lo, Number(f[k].value) || DEF[k]));
  const waitMin = n("waitMin", 200, 10000),
    waitMax = n("waitMax", 200, 10000),
    bgmUrl = f.bgmUrl.value.trim();
  if (bgmUrl && !ytBlocked && !ytId(bgmUrl)) {
    alert("YouTube 링크를 확인해 주세요. (예: https://youtu.be/영상ID)");
    f.bgmUrl.focus();
    return;
  }
  settings = {
    bgmUrl,
    eventName: f.eventName.value.trim() || DEF.eventName,
    rounds: session ? session.rounds : Math.round(n("rounds", 1, 10)),
    random: f.random.checked,
    bgm: f.bgm.checked,
    waitMin: Math.min(waitMin, waitMax),
    waitMax: Math.max(waitMin, waitMax),
    sfxVol: Number(f.sfxVol.value),
    bgmVol: Number(f.bgmVol.value),
    topN: Number(f.topN.value),
  };
  if (!session)
    session = { startedAt: Date.now(), rounds: settings.rounds, records: [] };
  save();
  actx();
  ytPrepare();
  toAttract();
});
$("#bgmFileBtn").onclick = () => $("#bgmFile").click();
$("#bgmFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("audio/") && !/\.mp3$/i.test(file.name))
    return alert("오디오(MP3) 파일만 선택할 수 있습니다.");
  try {
    await idb("readwrite", (s) => s.put(file, "bgm"));
    setBgmFile(file);
  } catch (err) {
    alert("MP3 저장 실패: " + err.message);
  }
};
$("#bgmFileDel").onclick = async () => {
  try {
    await idb("readwrite", (s) => s.delete("bgm"));
    setBgmFile(null);
  } catch (err) {
    alert("MP3 삭제 실패: " + err.message);
  }
};
$("#newBtn").onclick = () => {
  if (
    !confirm(
      `현재 대회 기록(${session.records.length}건)을 종료하고 새 대회를 시작할까요?\n(기록은 보관함에 남고, JSON 내보내기로 받을 수 있습니다)`,
    )
  )
    return;
  if (session.records.length)
    archive.push({
      ...session,
      endedAt: Date.now(),
      eventName: settings.eventName,
    });
  session = null;
  save();
  openSettings("setup");
};
$("#exportBtn").onclick = () => {
  const blob = new Blob(
    [
      JSON.stringify(
        { exportedAt: new Date().toISOString(), settings, session, archive },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `reaction-gp-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#importBtn").onclick = () => $("#file").click();
$("#file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (
      typeof d !== "object" ||
      !d ||
      (d.session && !Array.isArray(d.session.records))
    )
      throw new Error("형식 오류");
    if (!confirm("불러온 파일로 현재 설정·기록을 덮어쓸까요?")) return;
    settings = { ...DEF, ...(d.settings || {}) };
    session = d.session || null;
    archive = Array.isArray(d.archive) ? d.archive : [];
    save();
    ytPrepare();
    openSettings(session ? "admin" : "setup");
  } catch (err) {
    alert("JSON 불러오기 실패: " + err.message);
  }
};

// ---------- 대기 화면 ----------
function toAttract() {
  bgmStop();
  const top = ranked(session.records).slice(0, settings.topN);
  $("#evName").textContent = settings.eventName;
  $("#evInfo").textContent =
    `${session.rounds} ROUNDS${settings.random ? " · 🎲 RANDOM L/R" : ""} · 참가 ${online ? onlineCount : session.records.length}명${online ? " · 🌐 ONLINE" : ""}`;
  stage.style.setProperty(
    "--row",
    `min(4.2cqh, ${52 / Math.max(5, settings.topN)}cqh)`,
  );
  $("#rank").innerHTML = top.length
    ? top
        .map(
          (r, i) =>
            `<li class="${lastSaved && r.ts === lastSaved.ts && r.name === lastSaved.name ? "me" : ""}"><span class="n">${i + 1}${["ST", "ND", "RD"][i] || "TH"}</span><span>${esc(r.name)}${r.random ? " 🎲" : ""}</span><span class="t">${r.total}ms</span><span class="a">avg ${r.avg}</span></li>`,
        )
        .join("")
    : '<li class="empty">NO RECORDS — BE THE FIRST!</li>';
  show("attract");
}

// ---------- 게임 ----------
const later = (fn, ms) => game.timers.push(setTimeout(fn, ms));
const clearTimers = () => game && game.timers.forEach(clearTimeout);
function msg(html, cls = "") {
  const m = $("#msg");
  m.innerHTML = html;
  m.className = "";
  void m.offsetWidth;
  m.className = cls;
}
function hud() {
  $("#hudL").innerHTML =
    `${esc(settings.eventName)}<br>ROUND ${Math.min(game.i + 1, session.rounds)}/${session.rounds}`;
  const total = game.times.reduce((s, x) => s + x.ms, 0);
  $("#hudR").innerHTML =
    `TOTAL ${total}ms<br>` +
    game.times
      .map(
        (x, i) =>
          `<span class="lap ${x.kind !== "ok" ? "bad" : ""}">R${i + 1} ${x.ms}${x.kind !== "ok" ? "!" : ""}</span>`,
      )
      .join("<br>");
}
function startGame() {
  clearTimers();
  actx();
  game = { i: 0, times: [], timers: [], lit: 0, green: false, phase: "intro" };
  $("#xmark").className = "";
  $("#flash").className = ""; // 다시 표시될 때 이전 ✕ 애니메이션이 재생되지 않도록
  show("play");
  bgmStart();
  nextRound();
  online?.log("game_start");
}
function abortGame() {
  clearTimers();
  game = null;
  bgmStop();
} // 중단: 기록 저장 안 함
function nextRound() {
  if (game.i >= session.rounds) return finish();
  Object.assign(game, { phase: "intro", lit: 5, green: false, dir: null }); // 시작부터 빨간불 5개 점등 (intro 중 클릭은 무시)
  $("#dir").textContent = "";
  hud();
  msg(`ROUND ${game.i + 1}\n<small>준비…</small>`, "pop");
  sfx.beep();
  later(() => {
    game.phase = "wait";
    msg("");
    const { waitMin: a, waitMax: b } = settings;
    later(goGreen, a + Math.random() * (b - a));
  }, 1600);
}
function goGreen() {
  Object.assign(game, {
    phase: "green",
    green: true,
    pendingGreen: true,
    greenAt: performance.now(),
  });
  if (settings.random) {
    game.dir = Math.random() < 0.5 ? "L" : "R";
    $("#dir").textContent = game.dir === "L" ? "◀ 왼쪽 클릭" : "오른쪽 클릭 ▶";
  }
  later(() => record(TIMEOUT_MS, "timeout"), TIMEOUT_MS);
}
function record(ms, kind) {
  clearTimers();
  game.timers = [];
  game.times.push({ ms, kind });
  game.phase = "done";
  $("#dir").textContent = "";
  if (kind === "ok") {
    sfx.hit();
    fx("white");
    shake(false);
    msg(`${ms}<small>ms</small>`, "pop ok");
  } else {
    game.green = false;
    game.lit = 0;
    sfx.fail();
    fx("red");
    shake(true);
    fx("on", $("#xmark"));
    msg(
      `${{ false: "부정 출발!", wrong: "반대 버튼!", timeout: "시간 초과!" }[kind]}\n<small>+${ms}ms</small>`,
      "pop bad",
    );
  }
  hud();
  later(() => {
    game.i++;
    nextRound();
  }, 1700);
}
stage.addEventListener("pointerdown", (e) => {
  if (screen !== "play" || !game || (e.button !== 0 && e.button !== 2)) return;
  const p = game.phase;
  if (p === "red" || p === "wait") return record(FALSE_MS, "false");
  if (p !== "green") return;
  if (!settings.random && e.button !== 0) return; // 일반 모드는 좌클릭만
  if (game.dir && (e.button === 0 ? "L" : "R") !== game.dir)
    return record(FALSE_MS, "wrong");
  record(Math.max(0, Math.round(e.timeStamp - game.greenAt)), "ok");
});
addEventListener("contextmenu", (e) => {
  if (screen !== "settings") e.preventDefault();
});

// ---------- 결과 ----------
const TMI = [
  [160, "파리", "프로 FPS 선수"],
  [200, "고양이", "F1 드라이버"],
  [240, "치타", "e스포츠 프로게이머"],
  [280, "강아지", "일반 게이머"],
  [350, "사람 평균", "주말 카트 레이서"],
  [500, "판다", "퇴근길 운전자"],
  [Infinity, "나무늘보", "로딩 중인 컴퓨터"],
];
const TAUNT = [
  (d) => `1등까지 고작 ${d}ms! 아쉽네요~ 한 번 더??`,
  () => "손가락이 아직 피트인 중이네요 🛞 한 판 더?",
  () => "오늘 컨디션 탓이죠? 한 번 더!!",
  () => "출발은… 하셨네요 😏 한 번 더??",
];
let pending = null;
function finish() {
  bgmStop();
  const total = game.times.reduce((s, x) => s + x.ms, 0),
    avg = Math.round(total / game.times.length);
  pending = {
    name: "",
    total,
    avg,
    times: game.times.map((x) => x.ms),
    ts: Date.now(),
    random: settings.random,
  };
  const all = ranked([...session.records, pending]),
    rank = all.indexOf(pending) + 1;
  $("#resTimes").innerHTML = game.times
    .map(
      (x, i) =>
        `<span class="${x.kind !== "ok" ? "bad" : ""}">R${i + 1} ${x.ms}</span>`,
    )
    .join("");
  $("#resTotal").innerHTML = `<small>TOTAL</small>${total}<small>ms</small>`;
  $("#resAvg").textContent = `${avg}ms`;
  $("#resRank").textContent = `${rank} / ${all.length}`;
  if (online) {
    // 온라인은 상위 20개만 받아오므로 전체 순위는 서버에서 셈
    const me = pending;
    online
      .rank(total)
      .then(([r, n]) => {
        if (pending === me) $("#resRank").textContent = `${r} / ${n}`;
      })
      .catch(() => {});
    online.log("game_finish", { total, avg });
  }
  $("#resTaunt").textContent =
    rank === 1
      ? "🏆 NEW CHAMPION! 당신이 1등입니다!"
      : TAUNT[(Math.random() * TAUNT.length) | 0](total - all[0].total);
  const [, animal, pro] = TMI.find(([lim]) => avg < lim);
  $("#resTmi").textContent = `T.M.I · 반응속도 ${animal}급 / ${pro}와 비슷`;
  rank === 1 ? sfx.applause() : sfx.sad();
  game = null;
  show("result");
  const ni = $("#nameIn");
  ni.value = "";
  ni.focus();
}
function saveResult() {
  pending.name = ($("#nameIn").value.trim() || "PLAYER")
    .toUpperCase()
    .slice(0, 10);
  const rec = pending;
  session.records.push(rec);
  lastSaved = rec;
  pending = null;
  if (!PUBLIC) save();
  toAttract();
  if (online) {
    online
      .add(rec)
      .then(onlineRefresh)
      .catch((err) => alert("온라인 기록 저장 실패: " + err.message));
    online.log("score_save", { total: rec.total });
  }
}

// ---------- 관리자 키 ----------
addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "F1") {
    e.preventDefault();
    if (session && !PUBLIC) openSettings("admin");
    return;
  } // 공개 모드는 방문자가 설정을 못 바꾸게
  if (e.key === "F11") {
    e.preventDefault();
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (screen === "play") {
      abortGame();
      toAttract();
    } else if (screen === "result") {
      pending = null;
      toAttract();
    } else if (screen === "settings" && setMode === "admin") toAttract();
    return;
  }
  // 체크박스·셀렉트에서도 Enter로 시작/저장되도록
  if (
    e.key === "Enter" &&
    screen === "settings" &&
    e.target.tagName !== "BUTTON"
  ) {
    e.preventDefault();
    form.requestSubmit();
  } else if (e.key === "Enter" && screen === "attract") startGame();
  else if (e.key === "Enter" && screen === "result") saveResult();
  else if (e.code === "KeyR" && screen === "play") startGame();
});

// ---------- 자체 점검 ----------
console.assert(
  ranked([
    { total: 900, ts: 2 },
    { total: 500, ts: 3 },
    { total: 500, ts: 1 },
  ])
    .map((r) => r.ts)
    .join() === "1,3,2",
  "ranking order",
);
console.assert(TMI.find(([lim]) => 250 < lim)[1] === "강아지", "tmi lookup");

// ---------- 시작 ----------
ytPrepare();
session ? toAttract() : openSettings("setup");
requestAnimationFrame(render);
if (PUBLIC)
  import("./online.js")
    .then((m) => {
      online = m;
      return onlineRefresh();
    })
    .catch((err) => {
      online = null;
      console.warn("온라인 순위 연결 실패 — 이 브라우저에만 기록됩니다", err);
    });
