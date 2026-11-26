import { classifyExhibit, type HostPageCopy } from "./exhibit-paint.js";

function titleFromBlock(heading: string, body: string, n: number): string {
  const headingTitle = heading.split(/[:：]/).pop()?.trim() || heading;
  if (headingTitle && !/^(封面|目录|附录)$/.test(headingTitle) && headingTitle.length >= 3) {
    return headingTitle.slice(0, 36);
  }
  const brand = body.match(/品牌名[「『]([^」』]+)/);
  const named = body.match(/[「『]([^」』]{2,28})[」』]/);
  const sub = body.match(/副标题[「『:：]\s*([^」』\n]+)/);
  const brandName = (brand?.[1] || named?.[1] || "").replace(/\s*Chengguang.*$/i, "").trim();
  const subName = (sub?.[1] || "").replace(/[」』]/g, "").trim();
  const joined = [brandName, subName].filter(Boolean).join(" ");
  if (joined) return joined.slice(0, 36);
  return (headingTitle || `第${n}页`).slice(0, 36);
}

function scriptBodyLines(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\n+/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(输出格式|【|—{2,}|硬性要求)/.test(line)) continue;
    if (/^版式[:：]/.test(line)) continue;
    line = line.replace(/^结论[:：]\s*/, "").replace(/^[-•●]\s*/, "");
    if (line.length < 2) continue;
    out.push(line.slice(0, 120));
    if (out.length >= 24) break;
  }
  return out;
}

/** 【第N页 标题】… blocks — a finished script, not a one-line topic. */
export function parsePagedScript(brief: string): HostPageCopy[] {
  const re = /【第\s*(\d+)\s*页\s*([^】]*)】/g;
  const hits: { n: number; heading: string; headEnd: number; start: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(brief))) {
    hits.push({
      n: Number(match[1]),
      heading: match[2]!.trim(),
      start: match.index,
      headEnd: match.index + match[0].length,
    });
  }
  if (hits.length < 3) return [];
  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.start : brief.length;
    const body = brief.slice(hit.headEnd, end).trim();
    const conclusion = body.match(/结论[:：]\s*(.+)/);
    const pageType =
      hit.n === 1 || /封面/.test(hit.heading)
        ? "cover"
        : /目录/.test(hit.heading)
          ? "toc"
          : i === hits.length - 1
            ? "close"
            : "content";
    const page: HostPageCopy = {
      id: `page-${String(hit.n).padStart(2, "0")}`,
      pageType,
      title: titleFromBlock(hit.heading, body, hit.n),
      kicker: conclusion?.[1]?.trim().slice(0, 72) || String(hit.n).padStart(2, "0"),
      lines: scriptBodyLines(body),
      body,
    };
    page.exhibit = classifyExhibit(page, i, hits.length);
    return page;
  });
}

/** Brief first, then attachment text — a pasted 月报 script is still a script. */
