import { classifyBriefKind, hasExplicitUserDesign } from "@open-slidestudio/presentation-run";
/**
 * Extra director lines after the user brief. Host does not pick a design system.
 * Negations are not a request for that genre. Host will not paint leftover pages.
 */
function requestedPageCount(brief) {
    const labeled = brief.match(/页数\s*[:：]?\s*(\d+)/);
    const around = brief.match(/(\d+)\s*页\s*左右/);
    const about = brief.match(/约\s*(\d+)\s*页/);
    const exact = brief.match(/(\d+)\s*页/);
    return labeled?.[1] ?? around?.[1] ?? about?.[1] ?? exact?.[1];
}
function pagePlanLine(brief) {
    const n = requestedPageCount(brief);
    if (n)
        return `Plan about ${n} pages.`;
    return "Plan every page the brief and adopted design sources actually need. Do not stop at a default page count. A selected catalog style never implies page count.";
}
export function pagesHintForBrief(brief) {
    const kind = classifyBriefKind(brief);
    if (kind === "cover-only") {
        return "This brief is a single cover. Plan and write exactly one page, then complete the required current-revision render/review/compose gates and export. Do not expand it into a report.";
    }
    if (kind === "product-intro") {
        return `This brief is a product introduction / 立项, not a KPI monthly report. ${pagePlanLine(brief)} Structure: problem → product → who → how → proof → ask. Do not clone operating-report chrome. Do not write 澄光生活. Do not adopt work/* (经营月报 layouts) or academic/* packs. Consulting, finance, and promotion from the catalog are allowed. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused. Host does not pick a preset.`;
    }
    if (kind === "board-h1") {
        return `This brief is a board half-year operating review, not a 20-page retail monthly and not a product-pitch deck. ${pagePlanLine(brief)} Exec narrative, a few hard numbers, then asks. Charts need labeled axes and a name on every series. Do not write 澄光生活 or 青岚费控. Do not adopt work/* (澄光 / 工作汇报) or academic/* packs. Consulting, finance, and promotion from the catalog are allowed. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused. Host does not pick a preset.`;
    }
    if (kind === "retail-monthly") {
        return `This brief is a full operating report. ${pagePlanLine(brief)} Write every planned page. When inspect_capabilities.vision.mode is none, do not call review_page; the strict local editor still requires a current deterministic render_page layout pass for every page before compose_deck. Then export_deck.`;
    }
    if (kind === "performance-review") {
        return `This brief is a personal performance review / 述职, not an academic defense and not a company operating report. ${pagePlanLine(brief)} Structure: role and goals → goal evidence → representative work and personal contribution → capability reflection → gaps → next plan and support ask. Separate personal contribution from team outcomes; every claim needs concrete evidence, and illustrative data must be labeled. Use work or consulting packs; do not adopt academic courseware or promotion campaign chrome. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused.`;
    }
    if (kind === "work-report") {
        return `This brief is a team/project work report / 工作汇报, not a retail monthly and not a personal performance review. ${pagePlanLine(brief)} Structure: objective and scope → status → delivery evidence → issue and risk → resource or decision needed → next action with owner and date. Make status scannable, distinguish facts from plans, and do not invent KPI values. Use work or consulting packs; do not adopt academic courseware or promotion campaign chrome. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused.`;
    }
    if (kind === "project-proposal") {
        return `This brief is a project proposal / 立项方案, not a product brochure and not a progress report. ${pagePlanLine(brief)} Structure: problem → target and constraints → options and recommendation → investment and return logic → milestone → risk and mitigation → decision. Show trade-offs and the exact ask; do not turn the deck into a slogan-only sales pitch. Use consulting, finance, or work packs; do not adopt academic courseware. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused.`;
    }
    if (kind === "academic") {
        return "This brief is 开题/答辩/论文, not a 经营月报 and not a product pitch. commit_design must adopt an academic/* pack from the catalog before write_page; empty adopt / agent-self-directed-plan is refused. Do not adopt work/* monthly chrome. Host does not pick a preset.";
    }
    if (kind === "teach-pythagoras") {
        return "This brief is 勾股定理 (Pythagorean theorem) for elementary students. Explain with triangles and area, not a courseware/academic template and not a pointless bar chart. Host did not pick academic/paper-white-courseware.";
    }
    if (kind === "teaching") {
        return `This brief is teaching courseware / 教学课件, not an academic defense and not an office report. ${pagePlanLine(brief)} Structure: learning objective → prior knowledge or hook → concept → worked example → guided practice → independent practice → recap and check. One page should have one teaching job; prompts and answers must not accidentally reveal at the same time. Use academic, consulting, or promotion packs suited to the audience; do not adopt finance ledger or work-report chrome. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused.`;
    }
    if (kind === "training") {
        return `This brief is an office training deck / 培训课件, not a company report and not an academic defense. ${pagePlanLine(brief)} Structure: objective → procedure → worked example → practice → feedback or common errors → checklist → transfer to the job. Make each procedure actionable and show what good looks like; do not fill pages with policy prose. Use academic, consulting, or promotion packs; do not adopt finance ledger or monthly-report chrome. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused.`;
    }
    if (kind === "learn-share") {
        return `This brief is an internal knowledge-share / 学习分享 / 分享会, not a 经营月报 and not a product 立项. ${pagePlanLine(brief)} Structure: purpose → takeaway → concept → steps → example → checklist → apply at work → closer. Do not write 澄光生活 or 青岚费控. Do not adopt work/* (澄光 monthly), academic/* (课件/答辩), or finance/* ledger packs. Consulting and promotion from the catalog are allowed. commit_design must adopt a matching pack before write_page; empty adopt / agent-self-directed-plan is refused. Host does not pick a preset.`;
    }
    return "Plan every page the brief actually needs. A one-page cover is only correct when the brief is a single cover.";
}
export function directorBrief(brief, explicit) {
    return [
        brief,
        "",
        "You are the DSH SlideStudio director. Host did not choose a category or design preset.",
        "Call inspect_capabilities first; its returned snapshot is the only authority for vision, research, image, render, and export availability. Never infer a provider or hidden tool from this prompt. Then call list_references. Its requiredReferenceChunks and missingReferenceChunks come before the optional catalog: read every missing required chunk before commit_design or write_todo. If commit_design selects a new scenario/design in adoptedSourceIds, read every chunk of that selected source before retrying the commit.",
        "Optional media follow the capability snapshot and the actual page plan. Use web_search only when inspect_capabilities.research.configured (model-native search). There is no HTTP research port. Use search_image or generate_image only when its matching capability is configured and a planned page truly needs that media; if unavailable, choose a valid non-photo composition instead of inventing media. If the user asks for searched or generated media while its capability is unconfigured — including endpoints written into the brief text, which cannot be called because there is no HTTP tool in this session — tell them the provider endpoint is connected under 设置 → 工具 (image URL, API key, model). When a photo-led page is planned, decide the image frame bounds first, call generate_image with that width and height, then write_page using the same bounds. Do not generate 16:9 and later cover-crop into a different slot. Do not reuse another page's full-bleed source.",
        "write_page uses elementType, bounds [x,y,w,h], and content.text. Charts are OpenKimi PPTD: data.cols + data.rows and series[].type/encode. Nested chart.rows + encode is accepted; host infers cols. Host will not silently drop a chart.",
        "Slide text uses only fonts that Office and WPS already ship: 微软雅黑, 黑体, 宋体, 楷体, 仿宋 for Chinese, and Arial, Times New Roman, Georgia, Verdana, Tahoma, Courier New for Latin. Name them separately as content.fontFamily {latin, ea}. A face outside that list is rewritten to the closest one; the write_page result says so in fontNotes. Do not ask for MiSans, 思源宋体, or any web font.",
        "Keep pages readable: title plus evidence on a high-contrast field. Do not leave a dark empty page.",
        "For a multi-page deck, the last page is a 结束页 with a title, one-line recap, and concrete next action. A host-opened 1_cover.page seed must not remain as slide 1. Host will not paint leftover pages. Do not strip text to pass layout; repair the named bounds or content issue. If compose_deck reports an empty closer or leftover host seed, rewrite the named page before composing again.",
        "For every current page revision, wait for render_page to finish. If vision.mode is main-model, inspect the attached PNG, copy the exact full DELIVERY_TOKEN into review_page for the same page/revision, and use issues=[] for pass or concrete visible defects for revise. If vision.mode is none, do not call review_page. In either mode, satisfy the deterministic render layout gate and run review_pages; if it fails, repair the named pages rather than repeating review_pages. Do not stamp layoutStatus=pass yourself.",
        "After all page and structural gates pass, call compose_deck to seal the deck. On compose rejection, follow payload.next and its exact chunk/page lists before retrying.",
        "A chart or architecture exhibit promised by write_todo must be present as editable elements in the same write_page; an empty slot is refused.",
        "Editing must reuse the same page id. Do not create a duplicate page file. Splitting a section into more pages is fine: update write_todo with the new pageIds before writing them; a page not in the todo is refused. For an editor-selected existing page, call read_page immediately before editing and use its pageSha256 as expectedPageSha256; a stale hash is a conflict, so re-read and reapply the requested change. When the active server-verified review scope is elements, use edit_elements with exactly the selected elementIds and one complete canonical native element per target; do not copy or send the rest of the page and do not call write_page. Explicit whole-page and deck edits still use write_page with the complete elements[] array. Keep all style, bounds, fill, line, alignment, and layoutRole fields inside their owning element. layoutStatus=pass is overflow-only, not a rewrite seal. The same pageId may be rewritten until review_pages records a current structural pass for that revision. After structural pass, rewrite only if review_pages names the page failing or review_page says revise.",
        pagesHintForBrief(brief),
        "Deliver to the user, in their language and in product terms: what the deck argues, how many pages it has, the visual style it follows, where the facts came from, and anything still unresolved. The deck is reviewed, edited, and exported inside this product — the right-hand panel edits the selected object, comments ask this Agent for another pass, and the export menu produces PPTX/PDF/PNG — so a gate that blocks the seal is not a dead end: name the page and what is missing, and say plainly that the deck can still be edited and exported. Keep the message free of file-system paths, session ids, tool names, commands, and local addresses.",
        explicit
            ? `The user explicitly asked for design system ${explicit}. Read the required design-source chunks for that catalog id — numbered extra guides are English .md files, not a folder design.md. Do not expect a preview JPEG on the tool result. Adopt visual language from that pack; do not treat the pack as a page-count cap.`
            : hasExplicitUserDesign(brief)
                ? "The user supplied explicit visual overrides in the brief. Preserve those color, type, ratio, and layout constraints while adopting the closest compatible catalog pack; do not call this an unspecified style."
                : "No explicit style. Choose from the full catalog.",
    ].join("\n");
}
//# sourceMappingURL=director-brief.js.map