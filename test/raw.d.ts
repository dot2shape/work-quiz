// vitest(Vite)의 `?raw` import: 파일 내용을 문자열로 읽는다(마이그레이션·fixture).
declare module "*?raw" {
  const text: string;
  export default text;
}
