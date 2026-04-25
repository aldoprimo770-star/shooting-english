/**
 * words.json を読み、file:// でも使える words-embed.js を生成する。
 * 用法: node scripts/sync-words-embed.cjs
 * （words.json を更新したらこのスクリプトを再実行する）
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const input = path.join(root, "words.json");
const output = path.join(root, "words-embed.js");

const raw = fs.readFileSync(input, "utf8");
const data = JSON.parse(raw);
if (!Array.isArray(data) || !data.length) {
  throw new Error("words.json is empty or not an array");
}

const blob = `/* 自動生成: node scripts/sync-words-embed.cjs — 元データは words.json */
window.__ENG_SHOOTING_WORDS__ = ${JSON.stringify(data)};
`;
fs.writeFileSync(output, blob, "utf8");
console.log(`Wrote ${output} (${data.length} words)`);
