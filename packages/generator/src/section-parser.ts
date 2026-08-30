/** Splits a `===NAME===` sectioned document into a map of section name to body. */
export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const pattern = /^===([A-Z]+)===[ \t]*$/gm;

  const marks: { name: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    marks.push({
      name: match[1]!,
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const next = marks[i + 1];
    sections[mark.name] = text.slice(mark.end, next ? next.start : text.length).trim();
  }

  return sections;
}
