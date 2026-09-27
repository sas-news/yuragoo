// Built-in お題プリセット: the host can pull a ready-made scenario when
// nobody wants to write one. One line each, every prompt open enough
// that six different answers all make sense — mirroring the AI
// generator's quality bar (no obvious correct answer, no role overlap).
export const SCENARIO_PRESETS: readonly string[] = [
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

// A preset different from `current` when possible, so the button always
// changes the field instead of re-dealing the same card.
export const pickScenarioPreset = (current: string, random: () => number = Math.random): string => {
  const pool = SCENARIO_PRESETS.filter((p) => p.trim() !== current.trim());
  const list = pool.length > 0 ? pool : SCENARIO_PRESETS;
  return list[Math.floor(random() * list.length)] ?? "";
};
