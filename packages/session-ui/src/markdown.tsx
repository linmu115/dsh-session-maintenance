import type { ReactNode } from "react";

function safeUrl(value: string): string | undefined {
  if (value.startsWith("#") || value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function inline(text: string): readonly ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/gu;
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) result.push(text.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("`")) result.push(<code key={`${index}-code`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) result.push(<strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("~~")) result.push(<del key={`${index}-del`}>{token.slice(2, -2)}</del>);
    else {
      const split = token.indexOf("](");
      const label = split < 0 ? token : token.slice(1, split);
      const target = split < 0 ? "" : token.slice(split + 2, -1);
      const href = safeUrl(target);
      result.push(href === undefined
        ? <span key={`${index}-link`}>{label}</span>
        : <a key={`${index}-link`} href={href} rel="noreferrer" target="_blank">{label}</a>);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

function tableCells(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

export function MarkdownView(props: { readonly children: string }) {
  const lines = props.children.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.trim().length === 0) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) { body.push(lines[index]!); index += 1; }
      index += index < lines.length ? 1 : 0;
      blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      const content = inline(heading[2]!);
      const level = heading[1]!.length;
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Heading key={`heading-${index}`}>{content}</Heading>);
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length) {
      const separators = tableCells(lines[index + 1]!);
      if (separators.length > 0 && separators.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
        const headers = tableCells(line);
        index += 2;
        const rows: string[][] = [];
        while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim().length > 0) {
          rows.push([...tableCells(lines[index]!)]); index += 1;
        }
        blocks.push(<table key={`table-${index}`}><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_header, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody></table>);
        continue;
      }
    }
    if (/^[-*]\s+/u.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index]!)) {
        const raw = lines[index]!.replace(/^[-*]\s+/u, "");
        const task = /^\[([ xX])\]\s+(.+)$/u.exec(raw);
        items.push(<li key={index} className={task === null ? undefined : "task-list-item"}>{task === null
          ? inline(raw)
          : <><input type="checkbox" disabled checked={task[1]!.toLowerCase() === "x"} />{inline(task[2]!)}</>}</li>);
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }
    if (/^\d+\.\s+/u.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\d+\.\s+/u.test(lines[index]!)) {
        items.push(<li key={index}>{inline(lines[index]!.replace(/^\d+\.\s+/u, ""))}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("> ")) { quote.push(lines[index]!.slice(2)); index += 1; }
      blocks.push(<blockquote key={`quote-${index}`}>{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim().length > 0 && !/^(#{1,6})\s|^```|^[-*]\s+|^\d+\.\s+|^>\s/u.test(lines[index]!)) {
      paragraph.push(lines[index]!); index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className="dsm-markdown">{blocks}</div>;
}
