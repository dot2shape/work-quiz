/** 게임 규칙 설정. Workers 환경변수([vars])에서 읽고 나머지는 기본값을 쓴다. */

export interface Settings {
  targetScore: number;
  roundSeconds: number;
  countdownSeconds: number;
  roundEndSeconds: number;
  cooldownSeconds: number;
  maxPlayers: number;
  minPlayers: number;
  emptyRoomTtlSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  targetScore: 5,
  roundSeconds: 20,
  countdownSeconds: 3,
  roundEndSeconds: 3,
  cooldownSeconds: 1.0,
  maxPlayers: 8,
  minPlayers: 2,
  emptyRoomTtlSeconds: 600,
};

export interface SettingsEnv {
  TARGET_SCORE?: string;
  ROUND_SECONDS?: string;
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadSettings(env: SettingsEnv, overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    targetScore: intOr(env.TARGET_SCORE, DEFAULT_SETTINGS.targetScore),
    roundSeconds: intOr(env.ROUND_SECONDS, DEFAULT_SETTINGS.roundSeconds),
    ...overrides,
  };
}
