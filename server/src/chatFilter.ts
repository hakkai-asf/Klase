const RAW = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "pussy",
  "cunt",
  "nigger",
  "nigga",
  "faggot",
  "retard",
];

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/0/g, "o")
    .replace(/\$/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

const patterns = RAW.map((w) => {
  const chars = w.split("").join("+[^a-z]*");
  return new RegExp(chars, "i");
});

export function filterProfanity(text: string): string {
  const compact = normalize(text);
  for (const word of RAW) {
    if (compact.includes(word)) {
      return "***";
    }
  }
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, "***");
  }
  return out;
}
