// wrangler [[rules]] type="Text" 로 import 되는 텍스트 파일
declare module "*.txt" {
  const text: string;
  export default text;
}
