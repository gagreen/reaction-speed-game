// 실행 파일 진입점: build.py가 만든 단일 HTML을 내장해 localhost로 띄우고 브라우저를 엽니다.
// http://localhost 로 열어야 YouTube 플레이어가 재생됩니다 (file:// 에서는 거부).
import page from './dist/reaction-gp.html' with { type: 'text' };

const PORT = 8123; // 기록(localStorage)이 주소별로 저장되므로 고정
const url = `http://127.0.0.1:${PORT}`; // localhost는 IPv6(::1)로 먼저 갈 수 있어 바인딩한 주소를 그대로 사용
try {
  Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  console.log(`Reaction GP 실행 중: ${url}\n이 창을 닫으면 게임 서버가 종료됩니다.`);
} catch (e) {
  console.log(`포트 ${PORT}가 이미 사용 중입니다. 이미 실행 중인 게임을 엽니다. (${e.code || e.message})`);
}
const open = { darwin: ['open', url], win32: ['cmd', '/c', 'start', '', url] }[process.platform] || ['xdg-open', url];
try { Bun.spawn(open, { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { console.log(`브라우저에서 ${url} 을 여세요.`); }
