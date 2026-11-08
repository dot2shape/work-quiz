/**
 * 선착순 판정기.
 *
 * 제출마다 서버 도착 순번(seq)을 부여하고 검증을 동시에 진행하되,
 * 앞 순번의 결과가 모두 나오기 전에는 뒤 순번을 승자로 확정하지 않는다.
 */
import type { Verdict } from "./dictionary";

export interface Submission {
  seq: number;
  playerId: string;
  word: string;
  verdict: Verdict | null;
}

export type SubmissionHandler = (sub: Submission) => Promise<void>;

export class Arbiter {
  private queue: Submission[] = [];
  private seq = 0;
  private closed = false;
  private draining = false;

  constructor(
    private readonly onWinner: SubmissionHandler,
    private readonly onResult: SubmissionHandler | null = null,
  ) {}

  submit(playerId: string, word: string, check: Promise<Verdict>): Submission {
    this.seq += 1;
    const sub: Submission = { seq: this.seq, playerId, word, verdict: null };
    this.queue.push(sub);
    void this.run(sub, check);
    return sub;
  }

  private async run(sub: Submission, check: Promise<Verdict>): Promise<void> {
    try {
      sub.verdict = await check;
    } catch (err) {
      // 검증 코드 자체의 예외도 "판정 불가"로 다룬다
      console.error("검증 중 예외", sub.seq, sub.word, err);
      sub.verdict = { valid: false, reason: "판정 중 오류가 발생했습니다", error: true };
    }
    if (this.closed) return;
    if (this.onResult && !sub.verdict.valid) await this.onResult(sub);
    await this.drain();
  }

  /** 큐 머리부터 확정 가능한 제출을 처리한다. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.closed) {
        const head = this.queue[0];
        if (head.verdict === null) return; // 앞 순번 미해결 → 보류
        this.queue.shift();
        if (head.verdict.valid) {
          this.close();
          await this.onWinner(head);
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }
}
