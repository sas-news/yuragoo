// Built-in お題プリセット: the host can pull a ready-made scenario when
// nobody wants to write one. One line each, every prompt open enough
// that six different answers all make sense — mirroring the AI
// generator's quality bar (no obvious correct answer, no role overlap).
// The editor renders the whole list in a picker dialog (Task 46).
//
// Presets write the SHARED scenario field, so they follow the room
// language — never the viewer's UI locale.
import type { RoomLanguage } from "@yuragoo/protocol";

const PRESETS_JA: readonly string[] = [
  "宇宙ステーションの食堂で、さいごのプリンをひとつだけ分けなければならない",
  "無人島に流れ着いた一行。あしたの朝、まず何をするか",
  "魔王が折れて和平交渉が始まった。勇者サイドの条件をひとつ出す",
  "学校の屋上で見つかった、宛名のない手紙の差出人を当てる",
  "時間が3分だけ止まる世界で、キミだけ動ける。何をする",
  "動物園の人気者たちが新入りの動物を歓迎会で驚かせたい",
  "消えた名物パンのレシピを、パン職人たちが記憶だけで再現する",
  "深夜のコンビニに、未来からの買い物メモが届いた",
  "海辺のカフェで開く、沈没船の財宝の山分け会議",
  "月面基地の酸素が残りわずか。誰の救命ポッドを先に充填するか",
] as const;

const PRESETS_EN: readonly string[] = [
  "In the space station cafeteria, the crew must split the very last pudding",
  "Shipwrecked on a desert island — what does the group do first tomorrow morning?",
  "The demon lord has surrendered and peace talks begin. Name one condition for the heroes' side",
  "A letter with no addressee turned up on the school roof — figure out who sent it",
  "Time stops for everyone but you for three minutes. What do you do?",
  "The zoo's popular animals want to surprise the newcomer at the welcome party",
  "The famous bakery's signature bread recipe is lost — the bakers must recreate it from memory",
  "A shopping memo from the future arrives at a late-night convenience store",
  "A seaside cafe hosts a meeting to split a sunken ship's treasure",
  "The moon base is almost out of oxygen — whose rescue pod gets refilled first?",
] as const;

export const scenarioPresets = (lang: RoomLanguage): readonly string[] =>
  lang === "en" ? PRESETS_EN : PRESETS_JA;
