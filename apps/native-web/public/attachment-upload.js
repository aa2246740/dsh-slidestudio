import { record } from "./generation-data.js";
import { INVALID_REPLY, parseAttachmentPublic } from "./attachment-public.js";

/** @import { PublicAttachment } from "./attachment-public.js" */

/** No progress for this long means the connection is dead; browsers often fire no error. */
export const UPLOAD_STALL_MS = 30_000;
/** Backstop for the whole upload + parse round trip. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

// Source sentences (i18n keys); the chip translates the failure reason when it paints.
export const NETWORK_FAILURE = "网络连接中断，上传失败，请检查网络后重试";
export const TIMEOUT_FAILURE = "上传超时，请检查网络后重试";
export const INTERRUPTED_FAILURE = "上传中断，请检查网络后重试";
export const UPLOAD_FAILED = "上传未成功，请重试";

/**
 * @typedef {{
 *  apiPath: (path: string) => string, file: File, onXhr: (xhr: XMLHttpRequest) => void,
 *  onProgress: (percent: number) => void, onUploaded: () => void, }} PostFileOptions
 */

/** Decode the upload reply: a parsed public record on 2xx, the server's reason otherwise.
 * @param {XMLHttpRequest} xhr @returns {{ok: true, value: PublicAttachment} | {ok: false, error: Error}} */
function readReply(xhr) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(xhr.responseText);
  } catch {
    return { ok: false, error: new Error(INVALID_REPLY) };
  }
  if (xhr.status >= 200 && xhr.status < 300) {
    try {
      return { ok: true, value: parseAttachmentPublic(data) };
    } catch {
      return { ok: false, error: new Error(INVALID_REPLY) };
    }
  }
  const error = record(data).error;
  return {
    ok: false,
    error: new Error((typeof error === "string" && error.trim()) || UPLOAD_FAILED),
  };
}

/** POST the raw File bytes to /api/attachments/upload (name in the percent-encoded
 *  X-Attachment-Name header); a watchdog aborts after UPLOAD_STALL_MS without progress.
 * @param {PostFileOptions} options
 * @returns {Promise<PublicAttachment>} */
export function postAttachmentFile({ apiPath, file, onXhr, onProgress, onUploaded }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    let stalled = false;
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let stallTimer = 0;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        try {
          xhr.abort();
        } catch {
          // An abort race after the request already settled is harmless.
        }
      }, UPLOAD_STALL_MS);
    };
    /** @param {unknown} reason */
    const fail = (reason) => {
      clearTimeout(stallTimer);
      reject(reason);
    };
    xhr.open("POST", apiPath("/api/attachments/upload"));
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Attachment-Name", encodeURIComponent(file.name));
    if (file.type) xhr.setRequestHeader("X-Attachment-Mime", file.type);
    xhr.upload.onprogress = (event) => {
      armStall();
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.upload.onload = () => {
      armStall();
      onUploaded();
    };
    xhr.onprogress = () => armStall();
    xhr.onload = () => {
      const reply = readReply(xhr);
      if (!reply.ok) {
        fail(reply.error);
        return;
      }
      clearTimeout(stallTimer);
      resolve(reply.value);
    };
    xhr.onerror = () => fail(new Error(NETWORK_FAILURE));
    xhr.ontimeout = () => fail(new Error(TIMEOUT_FAILURE));
    // A user remove is silent (the item is gone); any other abort is a visible failure.
    xhr.onabort = () => fail(new Error(stalled ? NETWORK_FAILURE : INTERRUPTED_FAILURE));
    armStall();
    try {
      xhr.send(file);
    } catch {
      fail(new Error(NETWORK_FAILURE));
    }
  });
}
