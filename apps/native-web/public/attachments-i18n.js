/** English for the attachment / material UI (chips, attach modal, vision notice, style
 * reminder). Chinese source text is the key; public/i18n.js merges this slice into EN.
 * src/attachment-i18n.test.mjs proves every material-scope table sentence has an entry. */
export const ATTACHMENTS_I18N = {
  // ---- separators used when the copy joins lists ----
  "、": ", ",
  "；": "; ",
  "。": ".",

  // ---- chip status / actions ----
  已识别: "Recognized",
  "已识别 · 图片包 · {n} 张图片": "Recognized · image pack · {n} images",
  " · 内嵌图片 {n} 张": " · {n} embedded images",
  "已从 {mark} 转换": "Converted from {mark}",
  "已发送，待清理": "Sent, awaiting cleanup",
  排队中: "Queued",
  "上传中 {n}%": "Uploading {n}%",
  解析中: "Parsing",
  "不支持 · {reason}": "Not supported · {reason}",
  "失败 · {reason}": "Failed · {reason}",
  该文件类型暂不支持: "This file type is not supported yet",
  "上传未成功，请重试": "Upload failed. Please retry.",
  "网络连接中断，上传失败，请检查网络后重试":
    "The connection dropped and the upload failed. Check your network and retry.",
  "上传超时，请检查网络后重试": "The upload timed out. Check your network and retry.",
  "上传中断，请检查网络后重试": "The upload was interrupted. Check your network and retry.",
  "资料上传回复无效，请重试或移除该资料": "The upload reply was invalid. Retry or remove this material.",
  没有可重试的文件: "There is no file to retry",
  "文件超过 50MB 上限，请压缩或拆分后再上传":
    "The file exceeds the 50 MB limit. Compress or split it, then upload again.",
  "图片等文件不能超过 20MB；PPT 和 PDF 不能超过 50MB":
    "Images and other files can't exceed 20 MB; PPT and PDF files can't exceed 50 MB",
  "已存在相同文件：{name}": "The same file is already attached: {name}",
  查看识别详情: "Show recognition details",
  重新上传该文件: "Upload this file again",
  "重新上传 {name}": "Upload {name} again",
  "移除附件 {name}": "Remove attachment {name}",
  "{name} 上传进度": "{name} upload progress",
  暂无识别结果: "No recognition result yet",
  当前模型无法识别图片内容: "The current model can't read image content",
  "文档已发送 · 内嵌图片还剩 {n} 张待发送": "Document sent · {n} embedded images left to send",
  "Agent 已收到附件，但有附件清理失败；可用 × 重试清理。":
    "The Agent received the attachments, but some cleanup failed. Use × to retry the cleanup.",

  // ---- editor composer attach button (index.html #composer-plus) ----
  "添加参考附件：图片 PNG / JPG / WebP / GIF / AVIF / SVG（SVG 转换为图片）及图片 ZIP 包、PPTX / POTX、THMX、XLSX、CSV / TSV、PDF、DOCX 或 TXT / MD / JSON；PPTX、POTX、PDF 单个不超过 50MB，其他不超过 20MB":
    "Add reference attachments: PNG / JPG / WebP / GIF / AVIF / SVG images (SVG is converted to an image) and image ZIP packs, PPTX / POTX, THMX, XLSX, CSV / TSV, PDF, DOCX or TXT / MD / JSON; PPTX, POTX and PDF up to 50 MB each, other files up to 20 MB",
  "添加参考附件：支持图片、图片 ZIP 包、PPTX、Excel、CSV / TSV、PDF、Word 与文本文件；PPTX、POTX、PDF 单个不超过 50MB，其他不超过 20MB":
    "Add reference attachments: images, image ZIP packs, PPTX, Excel, CSV / TSV, PDF, Word and text files; PPTX, POTX and PDF up to 50 MB each, other files up to 20 MB",

  // ---- send gate ----
  "资料仍在上传或解析，请稍候": "Materials are still uploading or parsing. Please wait.",
  "资料“{name}”不能使用，请移除或重试后再发送": "Material “{name}” can't be used. Remove or retry it before sending.",
  "PDF 页面图片还在生成，完成后即可发送": "PDF page images are still being generated; you can send once they are ready",
  "请填写文稿要求，或添加至少一个已识别的参考资料":
    "Describe the deck, or add at least one recognized reference material",

  // ---- quotas ----
  "每次最多发送 {max} 张图片": "Send at most {max} images at a time",
  "除图片外，每次最多发送 {max} 个附件": "Besides images, send at most {max} attachments at a time",

  // ---- image metadata line ----
  横向: "landscape",
  纵向: "portrait",
  方形: "square",
  "疑似 Logo": "likely a logo",
  疑似截图: "likely a screenshot",
  "拍摄时间 {at}": "taken {at}",
  "{hex}（{pct}%）": "{hex} ({pct}%)",
  "强调色 {colors}": "accent colors {colors}",
  "图片线索：{parts}（像素统计，不代表已看图）": "Image clues: {parts} (pixel statistics, not a visual reading)",

  // ---- PDF page images ----
  "页面图片已生成 {n} 页，看图模型可按页查看":
    "Page images ready for {n} pages; vision models can view them page by page",
  "页面图片生成中，文字已可使用": "Generating page images; the text is already usable",
  "页面图片没有生成，看图模型无法查看页面": "Page images were not generated; vision models can't view the pages",

  // ---- embedded pictures ----
  " 等 {n} 张": " and more, {n} in total",
  "内含 {total} 张图片，已作为图片资料，可放进页面（{shown}{rest}）":
    "Contains {total} images, kept as image materials that can go on slides ({shown}{rest})",
  "文档已发送，不会重复发送；内含 {total} 张图片，已发送 {sent} 张，还剩 {left} 张可放进页面（{shown}{rest}）":
    "The document was sent and won't be sent again; of its {total} images, {sent} were sent and {left} remain for slides ({shown}{rest})",
  "另有 {omitted} 张内嵌图片没有随本次发送：每次最多 {max} 张图片，名额已满":
    "{omitted} more embedded images were not sent this time: at most {max} images per message, and the quota is full",
  "；剩下的会随后续消息继续发送": "; the rest will go with later messages",

  // ---- material scope: labels ----
  "读文字 · 自由风格下可作配色来源": "Reads text · palette source in Freestyle",
  "读文字 · 风格只作线索": "Reads text · style is a hint only",
  "读数据 · 可做原生图表": "Reads data · native charts",
  读文字: "Reads text",
  读取模板线索: "Reads template hints",
  "风格 · 版式 · 内容按需读取": "Style · layouts · content on demand",
  "主题 · 只提供配色和字体": "Theme · colors and fonts only",
  "可放进页面 · 可作配色来源": "Can go on slides · palette source",
  "可让 AI 按它更新图表": "Ask AI to update charts from it",
  "可让 AI 整套换成这个模板": "Ask AI to switch the whole deck to this template",
  "可让 AI 用它换图": "Ask AI to swap images with it",

  // ---- material scope: details ----
  "读取可识别的文字；在「自由风格」下可采用它的配色（来自矢量图形和页面图片），字体、版式和装饰只作参考。支持看图的模型可按页查看页面图片。选了首页风格包时，配色以风格包为准。文档里的图片会提取成可用的图片资料（每份最多保留 40 张），随消息一起发送，占用每条消息 20 张图片的名额。若需保留原模板外观，请上传 .pptx。":
    "Reads recognizable text. In Freestyle its palette (from vector graphics and page images) can be used; fonts, layouts and decoration are references only. Vision models can view the page images page by page. When a style pack is selected on the home page, the pack's palette wins. Images in the document are extracted as usable image materials (up to 40 per file), sent with the message and counted toward its 20-image quota. To keep the original template look, upload a .pptx.",
  "读取 Word 中的文字；颜色、字体等只作风格线索，不作为设计来源。文档里的图片会提取成可用的图片资料（每份最多保留 40 张），随消息一起发送，占用每条消息 20 张图片的名额。若需保留原模板外观，请上传 .pptx。":
    "Reads the text in Word. Colors, fonts and similar are style hints only, not a design source. Images in the document are extracted as usable image materials (up to 40 per file), sent with the message and counted toward its 20-image quota. To keep the original template look, upload a .pptx.",
  "只提取可识别的文字；颜色、字体等只作风格线索，不作为设计来源。若需保留原模板外观，请上传 .pptx。":
    "Extracts recognizable text only. Colors, fonts and similar are style hints only, not a design source. To keep the original template look, upload a .pptx.",
  "读取表格数据，可据此制作原生图表；不提供配色、字体或版式来源。":
    "Reads table data that can drive native charts; it provides no palette, font or layout source.",
  "只提取文字内容，不提供配色、字体或版式等设计来源。":
    "Extracts text content only; it provides no palette, font, layout or other design source.",
  "识别模板主题色、字体、版式、Logo 候选和页面文字摘要；当前还不提供按需读取的完整页面、表格和图表资料。":
    "Recognizes the template's theme colors, fonts, layouts, logo candidates and slide text summary; full slides, tables and chart data are not yet readable on demand.",
  "配色、字体、Logo、版式线索、装饰和照片可按需采用；页面文字、表格和图表数据仅在要求使用时按需读取，不会自动导入整页。":
    "Palette, fonts, logo, layout hints, decoration and photos can be adopted as needed; slide text, tables and chart data are read only on request and whole slides are never imported automatically.",
  "只提取主题配色和字体，不含版式、页面和 Logo。": "Extracts theme colors and fonts only; no layouts, slides or logo.",
  "附件提供图片文件；由 AI 决定放进哪一页，也可采用它的配色作为设计来源（选了首页风格包时以风格包为准）。读取版式和气质需要支持看图的模型，文本模型只能看到颜色、尺寸和朝向。":
    "Provides the image file; AI decides which slide it goes on and may use its palette as a design source (a style pack selected on the home page wins). Reading its layout and mood needs a vision model; text models only see colors, size and orientation.",
  "附件提供图片文件；由 AI 决定放进哪一页，也可采用它的配色作为设计来源（选了首页风格包时以风格包为准）。能否读取版式和气质取决于当前模型是否支持看图。":
    "Provides the image file; AI decides which slide it goes on and may use its palette as a design source (a style pack selected on the home page wins). Whether its layout and mood can be read depends on whether the current model supports vision.",

  // ---- attach modal copy ----
  "支持图片 PNG / JPG / WebP / GIF / AVIF / SVG（SVG 转换为图片）及图片 ZIP 包（内含 JPG / PNG / WebP / GIF）、PPT PPTX / POTX 模板、Office 主题 THMX、Excel XLSX、CSV / TSV、PDF、Word DOCX 与 TXT / MD / JSON。":
    "Supports images PNG / JPG / WebP / GIF / AVIF / SVG (SVG is converted to an image) and image ZIP packs (JPG / PNG / WebP / GIF inside), PowerPoint PPTX / POTX templates, Office THMX themes, Excel XLSX, CSV / TSV, PDF, Word DOCX and TXT / MD / JSON. ",
  "PPTX、POTX 和 PDF 单个不超过 50MB，其他文件单个不超过 20MB；每次最多发送 20 张图片和 6 个其他附件。":
    "PPTX, POTX and PDF files up to 50 MB each, other files up to 20 MB each; send at most 20 images and 6 other attachments at a time. ",
  "旧版 .doc / .xls / .ppt 和 WPS 文件需要先另存为新格式再上传":
    "Save legacy .doc / .xls / .ppt and WPS files in a current format before uploading",
  "旧版 .ppt / .doc / .xls 和 WPS 格式会自动转换，效果可能与原文件不同":
    "Legacy .ppt / .doc / .xls and WPS files are converted automatically and may look different from the original",
  "iPhone 的 HEIC 照片请先导出为 JPG": "Export iPhone HEIC photos as JPG first",
  "PDF 和 Word 提取文字；PDF 在「自由风格」下可作配色来源，Word 的风格只作线索。表格读取数据，可制作原生图表。PPTX 提供风格、版式和按需读取的内容；图片可放进页面，也可作配色来源。":
    "PDF and Word provide text; in Freestyle a PDF can be a palette source, while Word style is a hint only. Tables provide data for native charts. PPTX provides style, layouts and on-demand content; images can go on slides and serve as a palette source.",
  "还有 {n} 个文件正在上传，关闭后会在后台继续上传，确定关闭吗？":
    "{n} files are still uploading. They will keep uploading in the background after you close. Close anyway?",
  继续上传: "Keep uploading",
  确认关闭: "Close anyway",
  样例资料列表无效: "The sample material list is invalid",
  "样例资料已在列表中，未重复添加": "The samples are already in the list and were not added again",

  // ---- vision notice ----
  "当前模型无法识别图片内容。图片仍可放进幻灯片（尺寸、主色、Logo 摆放等信息可用），但 Agent 看不到画面；如需识别，请换用支持看图的模型。":
    "The current model can't read image content. Images can still go on slides (size, main colors and logo placement are available), but the Agent can't see them; to have them read, switch to a vision-capable model.",
  换看图模型: "Switch to a vision model",

  // ---- style-source reminder ----
  "已选择风格『{name}』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。":
    "Style “{name}” is selected, so its palette, fonts and decoration win; attachments supply the logo, photos, content and data, and their layouts are references only. To follow the attachments' style, switch back to Freestyle.",
  "要求里提到了风格，但附件里没有可作风格来源的文件（PPTX、图片或 PDF）；Word、表格和文本只提供文字或数据，不提供设计风格。可不补充，直接发送。":
    "The request mentions style, but no attachment can serve as a style source (PPTX, image or PDF); Word, tables and text provide only text or data, not design style. You can send as is.",
};
