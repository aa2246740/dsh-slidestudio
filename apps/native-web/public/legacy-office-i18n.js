/**
 * English copy for legacy Office/WPS intake and the optional converter: the
 * fixed refusal sentences a material record can carry, the converter state
 * reasons `/api/health` reports, and the conversion chip mark. Keys are the
 * exact Chinese strings the server sends; i18n.js merges this slice into EN.
 */
export const LEGACY_OFFICE_I18N = {
  "文件已加密（设有打开密码），无法读取；请取消密码后再上传":
    "The file is encrypted (it has an open password) and cannot be read. Remove the password and upload it again.",
  "这是 WPS 加密文档，只能在 WPS 中打开；请在 WPS 中取消文档加密，再另存为 .docx / .xlsx / .pptx 后上传":
    "This is an encrypted WPS document that only opens in WPS. Remove the encryption in WPS, save it as .docx / .xlsx / .pptx and upload that.",
  "文件包含宏，出于安全考虑不予接收；请另存为不含宏的 .pptx / .docx / .xlsx 后再上传":
    "The file contains macros and is refused for safety. Save it as a macro-free .pptx / .docx / .xlsx and upload again.",
  "文件已损坏或内容不完整，无法转换；请在 Office 或 WPS 中打开后另存为新格式再上传":
    "The file is damaged or incomplete and cannot be converted. Open it in Office or WPS, save it in a current format and upload again.",
  "转换后的文件超过 50 MB，无法使用；请精简后另存为新格式再上传":
    "The converted file is larger than 50 MB and cannot be used. Reduce it, save it in a current format and upload again.",
  "旧格式文件转换时间过长，已停止；请在 Office 或 WPS 中另存为 .pptx / .docx / .xlsx 后再上传":
    "Converting the legacy file took too long and was stopped. Save it as .pptx / .docx / .xlsx in Office or WPS and upload again.",
  "旧格式文件转换占用内存过大，已停止；请拆分文件，或另存为新格式后再上传":
    "Converting the legacy file used too much memory and was stopped. Split the file, or save it in a current format and upload again.",
  "当前转换任务较多，请稍后重试；也可以先另存为新格式再上传":
    "Many conversions are running. Try again later, or save the file in a current format first.",
  "旧格式文件转换失败；请在 Office 或 WPS 中另存为新格式后再上传":
    "Converting the legacy file failed. Save it in a current format in Office or WPS and upload again.",
  "这是 WPS 文字文件（.wps），暂不支持；请在 WPS 中“另存为” .docx 后再上传":
    "This is a WPS Writer file (.wps), which is not supported yet. Use “Save as” .docx in WPS and upload again.",
  "这是 WPS 表格文件（.et），暂不支持；请在 WPS 中“另存为” .xlsx 后再上传":
    "This is a WPS Spreadsheets file (.et), which is not supported yet. Use “Save as” .xlsx in WPS and upload again.",
  "这是 WPS 演示文件（.dps），暂不支持；请在 WPS 中“另存为” .pptx 后再上传":
    "This is a WPS Presentation file (.dps), which is not supported yet. Use “Save as” .pptx in WPS and upload again.",
  旧版格式转换正在启动: "Legacy format conversion is starting",
  "未找到 LibreOffice（soffice），旧版 .ppt、.doc、.xls 的转换不可用":
    "LibreOffice (soffice) was not found, so legacy .ppt, .doc and .xls files cannot be converted",
  "LibreOffice 预热转换失败，旧版格式转换不可用":
    "The LibreOffice warm-up conversion failed, so legacy format conversion is unavailable",
  "旧版格式转换已关闭（SLIDESTUDIO_LEGACY_CONVERT=off）":
    "Legacy format conversion is turned off (SLIDESTUDIO_LEGACY_CONVERT=off)",
  "当前系统没有可用的网络隔离（bwrap 或 unshare），为安全起见已停用旧版格式转换":
    "No network isolation (bwrap or unshare) is available on this system, so legacy format conversion is disabled for safety",
  "SLIDESTUDIO_SOFFICE_PATH 指定的 soffice 不存在或不可执行，旧版格式转换不可用（不会回退到自动查找）":
    "The soffice set in SLIDESTUDIO_SOFFICE_PATH does not exist or is not executable, so legacy format conversion is unavailable (no automatic search is tried)",
  "（由 {from} 转换）": "(converted from {from})",
  "（由 WPS {from} 转换）": "(converted from WPS {from})",
};
