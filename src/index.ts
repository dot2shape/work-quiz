/**
 * Worker 진입점: 헬스체크, WebSocket 을 방 Durable Object 로 전달, 그 외는 정적 자산.
 *
 * 클라이언트는 `/ws` (새 방) 또는 `/ws?code=ABC234` (기존 방) 로 접속한 뒤
 * 첫 메시지로 create_room / join_room 을 보낸다(원본 프로토콜 그대로).
 */
import { type Env, generateCode, normalizeCode } from "./env";

export { RoomObject } from "./room-object";

const CODE_PATTERN = /^[A-Z2-9]{6}$/;

async function pickFreeCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const probe = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch("https://room/probe");
    if (probe.status === 404) return code;
  }
  throw new Error("방 코드를 발급할 수 없습니다");
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const url = new URL(request.url);
  const requested = url.searchParams.get("code");
  let code: string;
  let mode: "create" | "join";
  if (requested) {
    code = normalizeCode(requested);
    if (!CODE_PATTERN.test(code)) return new Response("invalid room code", { status: 400 });
    mode = "join";
  } else {
    code = await pickFreeCode(env);
    mode = "create";
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const target = new URL("https://room/ws");
  target.searchParams.set("code", code);
  target.searchParams.set("mode", mode);
  return stub.fetch(new Request(target, request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return handleWebSocket(request, env);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, dictionary: env.STDICT_API_KEY?.trim() ? "stdict" : "local", runtime: "cloudflare" });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
