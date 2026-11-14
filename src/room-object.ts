/**
 * 방 하나를 담당하는 Durable Object.
 *
 * - 방 코드 → `idFromName(code)` 로 항상 같은 인스턴스에 도달한다.
 * - 방이 실제로 만들어졌는지는 storage 의 `created` 플래그로 구분한다(코드만 아는 임의 접속 차단).
 * - 플레이어·점수는 메모리에만 두고(원본 FastAPI 판과 동일), 소켓이 하나라도 살아 있으면 객체가 유지된다.
 * - 전원 퇴장: 로비면 즉시 삭제, 게임 중이면 TTL 뒤 알람으로 삭제한다.
 */
import { CachedDictionary, type Dictionary, FallbackDictionary, LocalDictionary, StdictClient } from "./dictionary";
import type { Env } from "./env";
import { type Message, type Player, Room, RoomError } from "./room";
import { loadSettings } from "./settings";
import seedWords from "../data/seed_words.txt";

const CREATED_KEY = "created";

interface Attachment {
  player: Player | null;
  mode: "create" | "join";
}

export function buildDictionary(env: Env): Dictionary {
  const local = LocalDictionary.fromText(seedWords);
  if (env.STDICT_API_KEY?.trim()) {
    // stdict 조회 실패 시 거절하지 않고 로컬 사전으로 폴백한다(#9). 폴백 판정은 KV 에 캐시되지 않는다.
    const stdict = new CachedDictionary(new StdictClient(env.STDICT_API_KEY.trim()), env.DICT_CACHE);
    return new FallbackDictionary(stdict, local);
  }
  return local;
}

export class RoomObject implements DurableObject {
  private room: Room | null = null;
  private readonly sockets = new Map<string, WebSocket>(); // playerId → socket
  private readonly attachments = new Map<WebSocket, Attachment>();
  private readonly dictionary: Dictionary;
  private code = "";

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.dictionary = buildDictionary(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.code = url.searchParams.get("code") ?? this.code;

    if (url.pathname === "/probe") {
      const created = await this.ctx.storage.get<boolean>(CREATED_KEY);
      return new Response(created ? "exists" : "free", { status: created ? 200 : 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const mode = url.searchParams.get("mode") === "create" ? "create" : "join";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.attachments.set(server, { player: null, mode });
    server.addEventListener("message", (ev) => void this.onMessage(server, ev));
    server.addEventListener("close", () => void this.onClose(server));
    server.addEventListener("error", () => void this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── 알람: 전원 퇴장 후 TTL 경과 ──────────────────────────────

  async alarm(): Promise<void> {
    if (this.room && !this.room.isEmpty()) return; // 그 사이 누군가 돌아왔다
    await this.destroy();
  }

  private async destroy(): Promise<void> {
    this.room?.close();
    this.room = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ── 소켓 → Room 콜백 ─────────────────────────────────────────

  private readonly broadcast = async (msg: Message): Promise<void> => {
    const text = JSON.stringify(msg);
    for (const [pid, ws] of [...this.sockets]) this.safeSend(pid, ws, text);
  };

  private readonly send = async (playerId: string, msg: Message): Promise<void> => {
    const ws = this.sockets.get(playerId);
    if (ws) this.safeSend(playerId, ws, JSON.stringify(msg));
  };

  private safeSend(playerId: string, ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      this.sockets.delete(playerId); // 끊어진 소켓은 조용히 제거한다
    }
  }

  private reply(ws: WebSocket, msg: Message): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 이미 닫힌 소켓 */
    }
  }

  // ── 메시지 라우팅 ─────────────────────────────────────────────

  private async onMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    const att = this.attachments.get(ws);
    if (!att) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;
    try {
      if (type === "create_room" || type === "join_room") {
        if (att.player) throw new RoomError("이미 방에 들어와 있습니다");
        await this.enter(ws, att, msg);
      } else if (!att.player || !this.room) {
        throw new RoomError("먼저 방에 입장해 주세요");
      } else if (type === "start_game") {
        await this.room.start(att.player.id);
      } else if (type === "submit_word") {
        await this.room.submit(att.player.id, String(msg.word ?? ""));
      } else if (type === "restart_game") {
        await this.room.restart(att.player.id);
      } else if (type === "set_mode") {
        const length = Number.parseInt(String(msg.word_length ?? ""), 10);
        if (!Number.isFinite(length)) throw new RoomError("지원하지 않는 모드입니다");
        await this.room.setMode(att.player.id, length);
      } else if (type === "set_allow_duplicates") {
        if (typeof msg.allow_duplicates !== "boolean") throw new RoomError("지원하지 않는 설정입니다");
        await this.room.setAllowDuplicates(att.player.id, msg.allow_duplicates);
      } else if (type === "ping") {
        this.reply(ws, { type: "pong" });
      } else {
        throw new RoomError("알 수 없는 요청입니다");
      }
    } catch (err) {
      if (err instanceof RoomError) {
        this.reply(ws, { type: "error", message: err.message });
      } else {
        console.error("웹소켓 처리 오류", err);
        this.reply(ws, { type: "error", message: "서버 오류가 발생했습니다" });
      }
    }
  }

  private async enter(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    const created = await this.ctx.storage.get<boolean>(CREATED_KEY);
    if (msg.type === "create_room") {
      if (att.mode !== "create" || created) throw new RoomError("방을 만들 수 없습니다. 새로 고침 후 다시 시도해 주세요");
      await this.ctx.storage.put(CREATED_KEY, true);
    } else if (!created) {
      throw new RoomError("존재하지 않는 방 코드입니다");
    }
    if (!this.room) {
      this.room = new Room(this.code, this.dictionary, loadSettings(this.env), this.broadcast, this.send);
    }
    await this.ctx.storage.deleteAlarm(); // 돌아온 사람이 있으면 삭제 예약 취소

    const token = typeof msg.token === "string" ? msg.token : null;
    const player = this.room.addPlayer(String(msg.nickname ?? ""), token);
    att.player = player;
    this.sockets.get(player.id)?.close(1000, "다른 탭에서 다시 접속했습니다");
    this.sockets.set(player.id, ws);
    this.reply(ws, {
      type: "joined",
      code: this.room.code,
      player_id: player.id,
      token: player.token,
      is_host: this.room.hostId === player.id,
    });
    await this.broadcast(this.room.state());
  }

  private async onClose(ws: WebSocket): Promise<void> {
    const att = this.attachments.get(ws);
    this.attachments.delete(ws);
    if (!att?.player || !this.room) return;
    const player = att.player;
    if (this.sockets.get(player.id) === ws) this.sockets.delete(player.id);
    else return; // 같은 자리에 새 소켓이 이미 붙어 있다(재접속)
    this.room.disconnect(player.id);
    if (this.room.isEmpty()) {
      if (this.room.phase === "lobby") {
        await this.destroy(); // 로비에서 전원 퇴장하면 바로 정리
      } else {
        const ttl = loadSettings(this.env).emptyRoomTtlSeconds;
        await this.ctx.storage.setAlarm(Date.now() + ttl * 1000);
      }
      return;
    }
    await this.broadcast(this.room.state());
  }
}
