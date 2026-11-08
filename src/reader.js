import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "node:buffer";
import { extractPageJpeg } from "./pdf.js";

// ---- 読み取り結果の形 ----------------------------------------------------------
// API の制限（「空でもよい」型は16項目まで）に引っかからないよう、すべて文字列で受け取る。
// 読めない項目は空文字 ""。数値は保存するときに数値へ直す（index.js の normalize）。
const field = (_type, description) => ({ type: "string", ...(description ? { description } : {}) });
const VEHICLE_PROPS = {
  sheet_format: field("string", "用紙の種類 例: USS, 車両詳細, TC-web, H@Live"),
  control_no: field("string", "赤ペン等で手書きされた管理番号 例: Z26-1103-01"),
  auction_house: field("string", "会場名 例: USS東京, TAA横浜, CAA中部"),
  auction_date: field("string", "開催日 YYYY-MM-DD"),
  auction_round: field("string", "開催回"),
  lot_no: field("string", "出品番号"),
  maker: field("string"),
  car_name: field("string"),
  grade: field("string"),
  model_code: field("string", "型式 例: DBA-ZRR80W"),
  chassis_no: field("string", "車台番号 例: ZVW50-1234567。一部が伏せ字（*）なら見えている通りに書く"),
  year: field("integer", "年式を西暦4桁で。R5→2023, H30→2018"),
  first_reg_month: field("integer", "初度登録の月 1-12"),
  displacement_cc: field("integer"),
  fuel: field("string"),
  shift: field("string", "FA, CA, AT, MT, F5 など表記のまま"),
  mileage_km: field("integer", "走行距離をkmで。'45千km'なら45000"),
  inspection: field("string", "車検 例: R07.05"),
  color: field("string"),
  color_code: field("string"),
  score: field("string", "評価点 例: 4.5, R, RA"),
  score_exterior: field("string"),
  score_interior: field("string"),
  equipment: field("string", "装備をスペース区切りで 例: AC PS PW SR AW"),
  start_price_man: field("number", "スタート金額（万円）"),
  bid_price_man: field("number", "落札金額・成約金額（万円）"),
  planned_price_man: field("number", "手書きされた予定車両価格（万円）例: 手書きの「179」→179"),
  result: field("string", "印字されている結果 例: 落札, 成約, 商談落札"),
  member_name: field("string", "印字されている会員名"),
  handwritten_note: field("string", "手書きの書き込みをすべて文字起こし"),
  inspector_note: field("string", "検査員記入欄・注意事項"),
  needs_review: { type: "boolean", description: "読み取りに自信がない項目があれば true" },
  review_reason: field("string"),
};
export const VEHICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vehicles"],
  properties: {
    vehicles: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: VEHICLE_PROPS, required: Object.keys(VEHICLE_PROPS) },
    },
  },
};

const PROMPT = `これは日本の中古車オークションの出品票（オークションシート）または落札票の1ページです。
このページに載っているすべての車両を1台ずつ抽出し、JSON で返してください。

- 1ページに複数台載っている場合は、すべて別の車両として出力します。車両が無いページは vehicles を空配列にします。
- 金額はすべて「万円」単位の数値にします（例: 125,000円 → 12.5、1250千円 → 125）。
- 年式は西暦の整数に換算します（R05/令和5年 → 2023、H30 → 2018）。
- 用紙の余白には社内の手書きがあります。
  - 「Z26-1103-01」のような管理番号（たいてい赤字）→ control_no
  - 単独で大きく書かれた2〜3桁の数字（例: 179）は予定車両価格（万円）→ planned_price_man
  - それ以外の手書き（名前・メモ・丸印など）は handwritten_note に「手書き「〇〇」」の形でそのまま書き起こします。
- 落札金額は「成約」「落札」などの欄に印字された金額です。スタート金額と取り違えないでください。
- 読めない・存在しない項目は空文字 "" にします。推測で埋めないでください。
- 数値の項目（金額・年式・走行距離・排気量・月）は、数字だけを書きます（例: "157.1"、"5002"）。単位やカンマは付けません。
- 読み取りに自信がない項目がある車両は needs_review を true にし、review_reason に理由を書きます。`;

// ---- Claude ---------------------------------------------------------------
async function readWithClaude(env, pageBytes) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が設定されていません");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: env.CLAUDE_EFFORT || "high",
      format: { type: "json_schema", schema: VEHICLE_SCHEMA },
    },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pageBytes).toString("base64") } },
        { type: "text", text: PROMPT },
      ],
    }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude が読み取りを断りました");
  if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).vehicles || [];
}

// ---- Workers AI（Cloudflare） ----------------------------------------------------
function parseLooseJson(out) {
  if (out && typeof out === "object") return out;
  const s = String(out ?? "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Workers AI の応答が JSON ではありません");
  return JSON.parse(s.slice(start, end + 1));
}

async function readWithWorkersAI(env, pageBytes) {
  if (!env.AI) throw new Error("Workers AI（AI バインディング）が設定されていません");
  const jpeg = await extractPageJpeg(pageBytes);
  if (!jpeg) throw new Error("このPDFのページから画像（JPEG）を取り出せません");
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
  const messages = [
    { role: "system", content: "あなたは日本の中古車オークションシートを正確に読み取るアシスタントです。必ず JSON だけを返します。" },
    {
      role: "user",
      content: [
        { type: "text", text: PROMPT + "\n\n出力形式: " + JSON.stringify({ vehicles: [Object.fromEntries(Object.keys(VEHICLE_PROPS).map((k) => [k, k === "needs_review" ? false : ""]))] }) },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + Buffer.from(jpeg).toString("base64") } },
      ],
    },
  ];
  let out;
  try {
    out = await env.AI.run(model, { messages, max_tokens: 4096, temperature: 0, response_format: { type: "json_schema", json_schema: VEHICLE_SCHEMA } });
  } catch {
    // JSON 指定に対応していないモデル向け
    out = await env.AI.run(model, { messages, max_tokens: 4096, temperature: 0 });
  }
  const data = parseLooseJson(out?.response ?? out);
  return Array.isArray(data.vehicles) ? data.vehicles : [];
}

// ---- 切り替え ---------------------------------------------------------------
// READER = "claude"（既定） / "workers-ai" / "hybrid"（Workers AI で読み、怪しければ Claude で読み直す）
const looksDoubtful = (vs) =>
  vs.length === 0 || vs.some((v) => v.needs_review || !v.car_name || (!v.start_price_man && !v.bid_price_man));

export async function readPage(env, pageBytes) {
  const mode = (env.READER || "claude").toLowerCase();
  if (mode === "dummy") return { reader: "dummy", vehicles: [{ car_name: "テスト車両", grade: "dummy", start_price_man: 10, needs_review: true, review_reason: "テスト用の読み取り" }] };
  if (mode === "workers-ai") return { reader: "workers-ai", vehicles: await readWithWorkersAI(env, pageBytes) };
  if (mode === "hybrid") {
    try {
      const vehicles = await readWithWorkersAI(env, pageBytes);
      if (!looksDoubtful(vehicles)) return { reader: "workers-ai", vehicles };
    } catch (e) {
      console.warn("Workers AI failed, falling back to Claude:", e.message);
    }
    return { reader: "claude", vehicles: await readWithClaude(env, pageBytes) };
  }
  return { reader: "claude", vehicles: await readWithClaude(env, pageBytes) };
}
