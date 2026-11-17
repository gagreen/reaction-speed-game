// 공개 모드(GitHub Pages) 전용: Firestore 온라인 순위 + GA4.
// game.js가 공개 모드일 때만 import() 하므로 행사장용 빌드(dist/)에는 들어가지 않습니다.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getCountFromServer,
  addDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAnalytics,
  isSupported,
  logEvent,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";

// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹) → SDK 설정 값. 공개돼도 되는 값이며, 접근 제어는 Firestore 규칙(README)이 합니다.
const FIREBASE = {
  apiKey: "AIzaSyBWHbOs2mCMVIGQp1qZWLxdMuECS2M1Vu8",
  authDomain: "reaction-speed-game-35759.firebaseapp.com",
  projectId: "reaction-speed-game-35759",
  storageBucket: "reaction-speed-game-35759.firebasestorage.app",
  messagingSenderId: "728959836795",
  appId: "1:728959836795:web:ebbab2a1f00c339babf8de",
  measurementId: "G-RQPCQSG1J9",
};

const app = initializeApp(FIREBASE);
const col = collection(getFirestore(app), "scores");
const analytics = (await isSupported()) ? getAnalytics(app) : null;
const count = async (q) => (await getCountFromServer(q)).data().count;

// 순위표용 상위 20개(순위표 최대 표시 개수)와 전체 참가 수
export async function top() {
  const [snap, total] = await Promise.all([
    getDocs(query(col, orderBy("total"), limit(20))),
    count(col),
  ]);
  return { records: snap.docs.map((d) => d.data()), count: total };
}

// 아직 저장 전인 기록의 전체 순위 → [등수, 전체 수]. 동점이면 먼저 기록한 사람이 위
export async function rank(total) {
  const [ahead, all] = await Promise.all([
    count(query(col, where("total", "<=", total))),
    count(col),
  ]);
  return [ahead + 1, all + 1];
}

export const add = (rec) => addDoc(col, rec);
export const log = (name, params) => analytics && logEvent(analytics, name, params);
